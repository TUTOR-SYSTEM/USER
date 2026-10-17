import type { ZodType } from 'zod';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';

/** Caller identity the gateway forwards with every RPC call that acts on behalf of a user. */
export interface RpcActorPayload {
  actorId?: string;
  actorRole?: string;
}

/**
 * Splits the caller identity off an RPC payload so it never reaches the data written to the DB.
 * A missing `actorId`/`actorRole` becomes an empty identity, which the service rejects (403).
 */
export function splitRpcActor<T extends RpcActorPayload>(payload: T) {
  const rest: Partial<T> = { ...payload };
  delete rest.actorId;
  delete rest.actorRole;
  const actor = { id: payload.actorId ?? '', role: payload.actorRole ?? '' };
  return { actor, rest: rest as Omit<T, keyof RpcActorPayload> };
}

/**
 * Validates an RPC payload with the same Zod schema the HTTP route uses. Throws a 422 that the
 * RPC exception filter forwards to the caller, the same as the HTTP pipe does.
 */
export function parseRpcPayload<T>(schema: ZodType<T>, value: unknown): T {
  return new ZodValidationPipe<T>(schema).transform(value);
}
