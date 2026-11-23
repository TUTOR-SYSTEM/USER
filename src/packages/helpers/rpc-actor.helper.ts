import type { ZodType } from 'zod';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { verifyClientIpSignature, verifyRpcActorSignature } from './rpc-actor-signature.helper';

/**
 * Caller identity the gateway forwards with every RPC call that acts on behalf of a user, plus the
 * signature that proves gateway sent it (see `rpc-actor-signature.helper.ts`).
 */
export interface RpcActorPayload {
  actorId?: string;
  actorRole?: string;
  /** Login session of the caller (only needed where the session itself is acted on). */
  actorSid?: string;
  actorSig?: string;
  actorSigTs?: number;
}

const ACTOR_FIELDS = ['actorId', 'actorRole', 'actorSid', 'actorSig', 'actorSigTs'] as const;

/**
 * Splits the caller identity off an RPC payload so it never reaches the data written to the DB.
 * The identity counts only when the gateway signature verifies. An unsigned, forged or stale
 * envelope becomes an empty identity, which the service rejects (403).
 */
export function splitRpcActor<T extends RpcActorPayload>(payload: T) {
  const rest: Partial<T> = { ...payload };
  for (const field of ACTOR_FIELDS) delete rest[field];
  const verified = verifyRpcActorSignature(
    {
      actorId: payload.actorId,
      actorRole: payload.actorRole,
      actorSid: payload.actorSid,
      actorSig: payload.actorSig,
      actorSigTs: payload.actorSigTs,
    },
    process.env.RPC_ACTOR_SECRET,
  );
  const actor = verified
    ? { id: payload.actorId ?? '', role: payload.actorRole ?? '', sid: payload.actorSid ?? '' }
    : { id: '', role: '', sid: '' };
  return { actor, rest: rest as Omit<T, keyof RpcActorPayload> };
}

/**
 * Validates an RPC payload with the same Zod schema the HTTP route uses. Throws a 422 that the
 * RPC exception filter forwards to the caller, the same as the HTTP pipe does.
 */
export function parseRpcPayload<T>(schema: ZodType<T>, value: unknown): T {
  return new ZodValidationPipe<T>(schema).transform(value);
}

/**
 * Splits the gateway-forwarded client IP off a login payload. The IP is returned only when its
 * signature verifies; otherwise it is `undefined` and the lockout falls back to the shared bucket.
 */
export function splitClientIp<
  T extends { clientIp?: unknown; clientIpSig?: unknown; clientIpSigTs?: unknown },
>(payload: T) {
  const clientIp = verifyClientIpSignature(payload, process.env.RPC_ACTOR_SECRET);
  const rest: Record<string, unknown> = { ...payload };
  delete rest.clientIp;
  delete rest.clientIpSig;
  delete rest.clientIpSigTs;
  return { clientIp, rest: rest as Omit<T, 'clientIp' | 'clientIpSig' | 'clientIpSigTs'> };
}
