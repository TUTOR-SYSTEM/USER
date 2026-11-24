import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { from, Observable, switchMap } from 'rxjs';
import { ERROR_MESSAGES } from 'src/data/constants';
import { RPC_ACTOR_MAX_AGE_MS } from '@packages/helpers/rpc-actor-signature.helper';
import { RmqProducer } from './rmq.producer';

/** Timeout for the replay counter; a slow Redis fails the call closed rather than letting it through. */
const REPLAY_COUNTER_TIMEOUT_MS = 2_000;

/**
 * Rejects a gateway-signed envelope that arrives a second time. Each signature is counted in Redis
 * for the length of the freshness window (`redis.incr`), so the first copy passes and any replay
 * gets 403. The gateway signs every send attempt separately, so its own retries are never replays.
 *
 * Only RPC calls carrying `actorSig` or `oauthProfileSig` are checked. Other RPCs and HTTP requests pass through.
 */
@Injectable()
export class RpcActorReplayInterceptor implements NestInterceptor {
  constructor(private readonly rmqProducer: RmqProducer) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'rpc') return next.handle();
    const data = context
      .switchToRpc()
      .getData<{ actorSig?: unknown; oauthProfileSig?: unknown } | undefined>();
    // An OAuth profile signature is single-use too: a captured copy must not mint a second login.
    const signature =
      typeof data?.actorSig === 'string'
        ? data.actorSig
        : typeof data?.oauthProfileSig === 'string'
          ? data.oauthProfileSig
          : undefined;
    if (signature === undefined) return next.handle();
    return from(this.claimSignature(signature)).pipe(switchMap(() => next.handle()));
  }

  private async claimSignature(actorSig: string): Promise<void> {
    // No retry: a retried INCR would count the same delivery twice.
    const { count } = await this.rmqProducer.send<
      { count: number },
      { key: string; windowSeconds: number }
    >(
      'redis.incr',
      {
        key: `rpc-actor-replay:${actorSig}`,
        windowSeconds: Math.ceil(RPC_ACTOR_MAX_AGE_MS / 1000),
      },
      REPLAY_COUNTER_TIMEOUT_MS,
      0,
    );
    if (count > 1) {
      throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
    }
  }
}
