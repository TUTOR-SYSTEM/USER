import { randomInt } from 'node:crypto';

/** Cryptographically secure random code (userCode / student code). */
export function generateCode(length = 6): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';

  for (let i = 0; i < length; i++) {
    result += chars[randomInt(chars.length)];
  }

  return result;
}

const PASSWORD_LOWER = 'abcdefghijkmnopqrstuvwxyz'; // no 'l'
const PASSWORD_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 'I', 'O'
const PASSWORD_DIGITS = '23456789'; // no '0', '1'
const PASSWORD_SPECIAL = '!@#$%^&*';

/**
 * Cryptographically secure random password (default 10 chars) for accounts created without a
 * user-chosen one. Always satisfies the password policy (`password.schema.ts`): at least one
 * lowercase, uppercase, digit and special character, within the 8–20 managed-password limit.
 * Look-alike characters are left out so it can be read out of an email.
 */
export function generateRandomPassword(length = 10): string {
  const pick = (set: string) => set[randomInt(set.length)];
  const all = PASSWORD_LOWER + PASSWORD_UPPER + PASSWORD_DIGITS + PASSWORD_SPECIAL;
  const chars = [
    pick(PASSWORD_LOWER),
    pick(PASSWORD_UPPER),
    pick(PASSWORD_DIGITS),
    pick(PASSWORD_SPECIAL),
  ];
  while (chars.length < length) chars.push(pick(all));
  // Fisher–Yates with a CSPRNG so the guaranteed characters are not always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export const checkUuidValid = ({ data }: { data: string }): boolean => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  return uuidRegex.test(data);
};
