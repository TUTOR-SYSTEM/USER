import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Login sessions are per device: every login mints a `sid` (uuid v4) that is carried in both the
 * access and the refresh JWT. Redis keys (owned by third-service, reached over `redis.*` RPC):
 *
 *  - `session:{userId}:{sid}`  = "1"            — the session is alive; deleting it logs the device out
 *  - `refresh:{userId}:{sid}`  = sha256(refresh) — the only refresh token that may rotate this session
 *
 * Both TTLs equal the refresh TTL and are extended on every refresh.
 */
export const sessionRedisKey = (userId: string, sid: string): string => `session:${userId}:${sid}`;
export const refreshHashRedisKey = (userId: string, sid: string): string =>
  `refresh:${userId}:${sid}`;

/** Prefixes for revoking every session of one user (`redis.delByPrefix`). Trailing colon included. */
export const sessionPrefixOf = (userId: string): string => `session:${userId}:`;
export const refreshPrefixOf = (userId: string): string => `refresh:${userId}:`;

/**
 * Revocation markers hold the time (ms) a session, or every session of a user, was last revoked.
 * A refresh that started before a marker must not write its session back to life. The marker is
 * written before the keys are deleted, and the refresh checks it after it writes. So whichever order
 * the two run in, the deletion wins. The TTL outlives any refresh token.
 */
export const SESSION_REVOKED_MARKER_TTL_SECONDS = 60 * 60 * 24 * 30;
export const revokedAllRedisKey = (userId: string): string => `revoked-all:${userId}`;
export const revokedSessionRedisKey = (userId: string, sid: string): string =>
  `revoked-session:${userId}:${sid}`;

/** Stored form of a refresh token: the raw token is never written to Redis. */
export const hashRefreshToken = (refreshToken: string): string =>
  createHash('sha256').update(refreshToken).digest('hex');

/** Constant-time equality for two hex digests of equal length (false for any length mismatch). */
export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
