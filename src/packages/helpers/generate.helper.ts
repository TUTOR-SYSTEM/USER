import { randomBytes, randomInt } from 'node:crypto';

/** Cryptographically secure random code (userCode / student code). */
export function generateCode(length = 6): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';

  for (let i = 0; i < length; i++) {
    result += chars[randomInt(chars.length)];
  }

  return result;
}

/**
 * Cryptographically secure random password for accounts created without a user-chosen one.
 * The plaintext is never returned or logged — it is hashed and stored; the account is reached
 * through the password-reset flow.
 */
export function generateRandomPassword(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export const checkUuidValid = ({ data }: { data: string }): boolean => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  return uuidRegex.test(data);
};
