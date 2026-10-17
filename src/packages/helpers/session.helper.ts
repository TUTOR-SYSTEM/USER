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
