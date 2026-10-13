/**
 * Redis key of a user's live login session (value = the refresh token issued at login). The
 * gateway guard treats a missing key as "logged out"; deleting it revokes the session.
 */
export const loginSessionRedisKey = (userId: string): string => `session:${userId}`;
