import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ERROR_MESSAGES } from 'src/data/constants';
import { refreshPrefixOf, sessionPrefixOf, sessionRedisKey } from './session.helper';

/** Minimal slice of `RmqProducer` this check needs (keeps packages free of feature imports). */
export interface SessionStoreClient {
  send<TResponse, TRequest>(
    pattern: string,
    message: TRequest,
    timeoutMs?: number,
    maxRetries?: number,
  ): Promise<TResponse>;
}

/** A positive answer is reused for this long, so one request burst does not hit Redis per call. */
export const SESSION_CACHE_TTL_MS = 5_000;

const SESSION_CHECK_TIMEOUT_MS = 2_000;
const SESSION_CHECK_RETRIES = 1;

const alive = new Map<string, number>();
const logger = new Logger('SessionCheck');

/** Test hook: drops every cached positive answer. */
export function clearSessionCache(): void {
  alive.clear();
}

/**
 * Whether `session:{userId}:{sid}` still exists. Fail-closed by default: a Redis/RMQ error (after
 * one short retry) throws 503. `failOpen` (env `SESSION_CHECK_FAIL_OPEN=true`) lets the request
 * through instead, which trades revocation for availability.
 */
export async function isSessionActive(
  client: SessionStoreClient,
  userId: string,
  sid: string,
  { failOpen = false }: { failOpen?: boolean } = {},
): Promise<boolean> {
  const cacheKey = `${userId}:${sid}`;
  const expiresAt = alive.get(cacheKey);
  if (expiresAt !== undefined && expiresAt > Date.now()) return true;

  let exists: boolean;
  try {
    exists = await client.send<boolean, { key: string }>(
      'redis.exists',
      { key: sessionRedisKey(userId, sid) },
      SESSION_CHECK_TIMEOUT_MS,
      SESSION_CHECK_RETRIES,
    );
  } catch (error) {
    if (failOpen) {
      logger.warn(`Session check failed for ${cacheKey}, failing open`, error as Error);
      return true;
    }
    logger.warn(`Session check failed for ${cacheKey}, failing closed`, error as Error);
    throw new ServiceUnavailableException(ERROR_MESSAGES.SESSION_CHECK_UNAVAILABLE);
  }

  if (exists) {
    alive.set(cacheKey, Date.now() + SESSION_CACHE_TTL_MS);
  } else {
    alive.delete(cacheKey);
  }
  return exists;
}

/**
 * Revokes every login session of a user on every device (`session:{id}:*` and `refresh:{id}:*`).
 * Used by password change/reset, deactivation, deletion and role changes. Awaited and not swallowed:
 * a failed revoke must surface to the caller instead of leaving old access alive.
 */
export async function revokeAllUserSessions(client: SessionStoreClient, userId: string) {
  await client.send('redis.delByPrefix', { prefix: sessionPrefixOf(userId) });
  await client.send('redis.delByPrefix', { prefix: refreshPrefixOf(userId) });
}
