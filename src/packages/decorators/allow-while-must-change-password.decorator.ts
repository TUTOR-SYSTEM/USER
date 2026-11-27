import { SetMetadata } from '@nestjs/common';

export const ALLOW_WHILE_MUST_CHANGE_PASSWORD_KEY = 'allowWhileMustChangePassword';

/**
 * Keeps a route reachable while the account still has `mustChangePassword` set. Only the routes that
 * let the user leave the temporary password (changePassword) carry it; every other route is refused.
 */
export const AllowWhileMustChangePassword = () =>
  SetMetadata(ALLOW_WHILE_MUST_CHANGE_PASSWORD_KEY, true);
