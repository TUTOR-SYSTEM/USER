import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { RmqContext } from '@nestjs/microservices';
import { Observable } from 'rxjs';
import { ERROR_MESSAGES } from 'src/data/constants';
import { verifyRpcBindSignature } from '@packages/helpers/rpc-actor-signature.helper';

/**
 * A gateway-signed actor must arrive with the pattern and payload it was signed for. The actor
 * signature alone does not cover them, so a captured envelope could be re-sent with another `id` or
 * on another pattern. Runs before the replay interceptor: a tampered copy is refused without
 * burning the signature of the genuine one.
 *
 * Only RPC calls carrying `actorSig` are checked.
 */
@Injectable()
export class RpcActorBindingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'rpc') return next.handle();
    const data = context.switchToRpc().getData<{ actorSig?: unknown } | undefined>();
    if (typeof data?.actorSig !== 'string') return next.handle();
    const pattern = context.switchToRpc().getContext<RmqContext>().getPattern();
    if (!verifyRpcBindSignature(pattern, data, process.env.RPC_ACTOR_SECRET)) {
      throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
    }
    return next.handle();
  }
}
