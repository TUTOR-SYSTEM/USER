import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { RmqContext } from '@nestjs/microservices';
import { from, Observable, switchMap } from 'rxjs';
import { ERROR_MESSAGES } from 'src/data/constants';
import { splitRpcActor, type RpcActorPayload } from '@packages/helpers/rpc-actor.helper';
import { PrismaService } from '../../database/database.module';

/**
 * The only RPCs a must-change-password account may call: they are the way out of the temporary
 * password (`user.changePassword`) and the session end (`auth.logout`).
 */
export const MUST_CHANGE_PASSWORD_EXEMPT_PATTERNS: readonly string[] = [
  'auth.logout',
  'user.changePassword',
];

/**
 * Refuses acting RPCs from a verified actor whose account still has `mustChangePassword`. The HTTP
 * side is enforced by `JwtAuthGuard`; this covers the calls that reach the service over RMQ. Runs
 * after the replay guard. An unsigned or empty actor passes through here and is refused by the handler.
 */
@Injectable()
export class RpcMustChangePasswordInterceptor implements NestInterceptor {
  constructor(private readonly db: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'rpc') return next.handle();
    const rpc = context.switchToRpc();
    const pattern = rpc.getContext<RmqContext>().getPattern();
    if (MUST_CHANGE_PASSWORD_EXEMPT_PATTERNS.includes(pattern)) return next.handle();
    const data: RpcActorPayload = rpc.getData() ?? {};
    const { actor } = splitRpcActor(data);
    if (!actor.id) return next.handle();
    return from(this.assertNotMustChangePassword(actor.id)).pipe(switchMap(() => next.handle()));
  }

  private async assertNotMustChangePassword(userId: string): Promise<void> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { mustChangePassword: true },
    });
    if (user?.mustChangePassword === true) {
      throw new ForbiddenException(ERROR_MESSAGES.MUST_CHANGE_PASSWORD);
    }
  }
}
