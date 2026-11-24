import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Gateway signs the caller identity it forwards on RPC (`actorId`/`actorRole`/`actorSid`) with a
 * secret only gateway and user share (`RPC_ACTOR_SECRET`). A publisher on `user_queue` that does not
 * hold the secret cannot forge an ADMIN actor. The signature is bound to a timestamp, so a captured
 * envelope stops working after `RPC_ACTOR_MAX_AGE_MS`. A replay inside that window is refused by
 * the replay interceptor (`features/rabbitmq/rpc-actor-replay.interceptor.ts`). That is why the
 * window can be 5 minutes wide: it absorbs clock skew between hosts (#7).
 *
 * Keep this file identical in `gateway/src/features/rabbitmq/` (the RMQ module is a copy).
 */
export const RPC_ACTOR_MAX_AGE_MS = 300_000;

export type RpcActorSignatureInput = {
  actorId: string;
  actorRole: string;
  actorSid: string;
  actorSigTs: number;
};

/** Hex HMAC-SHA256 over the actor fields and the signing time. */
export function computeRpcActorSignature(input: RpcActorSignatureInput, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${input.actorId}|${input.actorRole}|${input.actorSid}|${input.actorSigTs}`)
    .digest('hex');
}

/**
 * True only when the signature matches and the timestamp is fresh. Fails closed: a missing secret,
 * a missing field or a stale timestamp all return false.
 */
export function verifyRpcActorSignature(
  input: Partial<RpcActorSignatureInput> & { actorSig?: string },
  secret: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!secret || !input.actorSig || typeof input.actorSigTs !== 'number') return false;
  if (Math.abs(now - input.actorSigTs) > RPC_ACTOR_MAX_AGE_MS) return false;
  const expected = computeRpcActorSignature(
    {
      actorId: input.actorId ?? '',
      actorRole: input.actorRole ?? '',
      actorSid: input.actorSid ?? '',
      actorSigTs: input.actorSigTs,
    },
    secret,
  );
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(input.actorSig, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Signature for the client IP the gateway forwards on login (lockout key). Separate from the actor
 * signature because a login has no actor, but signed with the same secret and freshness window.
 */
export function computeClientIpSignature(clientIp: string, sigTs: number, secret: string): string {
  return createHmac('sha256', secret).update(`ip|${clientIp}|${sigTs}`).digest('hex');
}

/** The IP only counts when its signature verifies and it is fresh; otherwise `undefined`. */
export function verifyClientIpSignature(
  input: { clientIp?: unknown; clientIpSig?: unknown; clientIpSigTs?: unknown },
  secret: string | undefined,
  now: number = Date.now(),
): string | undefined {
  const { clientIp, clientIpSig, clientIpSigTs } = input;
  if (typeof clientIp !== 'string' || typeof clientIpSig !== 'string') return undefined;
  if (typeof clientIpSigTs !== 'number' || !secret) return undefined;
  if (Math.abs(now - clientIpSigTs) > RPC_ACTOR_MAX_AGE_MS) return undefined;
  const expected = computeClientIpSignature(clientIp, clientIpSigTs, secret);
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(clientIpSig, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right) ? clientIp : undefined;
}

/** Providers whose sign-in profile the gateway forwards (`auth.googleLogin` / `auth.facebookLogin`). */
export type OAuthProvider = 'google' | 'facebook';

/**
 * Signature over the OAuth profile the gateway forwards after the provider's callback. Without it,
 * anyone able to publish on `user_queue` could ask for tokens for any student email. Bound to the
 * provider, so a Google signature is not accepted for the Facebook pattern.
 */
export function computeOAuthProfileSignature(
  input: { provider: OAuthProvider; providerId: string; email: string },
  sigTs: number,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(`oauth|${input.provider}|${input.providerId}|${input.email}|${sigTs}`)
    .digest('hex');
}

/** True only for a fresh, matching signature. Fails closed on a missing secret or field. */
export function verifyOAuthProfileSignature(
  provider: OAuthProvider,
  input: {
    providerId?: unknown;
    email?: unknown;
    oauthProfileSig?: unknown;
    oauthProfileSigTs?: unknown;
  },
  secret: string | undefined,
  now: number = Date.now(),
): boolean {
  const { providerId, email, oauthProfileSig, oauthProfileSigTs } = input;
  if (!secret || typeof providerId !== 'string' || typeof email !== 'string') return false;
  if (typeof oauthProfileSig !== 'string' || typeof oauthProfileSigTs !== 'number') return false;
  if (Math.abs(now - oauthProfileSigTs) > RPC_ACTOR_MAX_AGE_MS) return false;
  const expected = computeOAuthProfileSignature(
    { provider, providerId, email },
    oauthProfileSigTs,
    secret,
  );
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(oauthProfileSig, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
