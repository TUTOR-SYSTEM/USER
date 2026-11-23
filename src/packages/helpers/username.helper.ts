import { randomBytes } from 'node:crypto';

/** `users.username` is VarChar(50); keep room for a numeric or random suffix. */
const USERNAME_BASE_MAX = 40;
const SEQUENTIAL_ATTEMPTS = 10;
const RANDOM_ATTEMPTS = 5;

/**
 * Lower-case ASCII base for a username from a person's name. The Vietnamese d-stroke is not
 * decomposed by NFD, so it is mapped first; the remaining diacritics (Unicode marks) are stripped.
 * Anything outside a-z0-9 is dropped, and spaces become `separator` ('' or '_'). Never returns ''.
 */
export function usernameBase(firstName: string, lastName: string, separator: '' | '_' = ''): string {
  const base = `${lastName}${firstName}`
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, separator === '_' ? '_' : '')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, USERNAME_BASE_MAX);
  return base || 'user';
}

/**
 * First free username: the base, then base1..base9 (`joiner` goes between, e.g. '_'), then a few
 * random-suffixed candidates, so a common name never runs out of candidates after ten people.
 * Returns null only if every try is taken.
 */
export async function pickFreeUsername(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
  joiner: '' | '_' = '',
): Promise<string | null> {
  for (let i = 0; i < SEQUENTIAL_ATTEMPTS; i++) {
    const candidate = i === 0 ? base : `${base}${joiner}${i}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  for (let i = 0; i < RANDOM_ATTEMPTS; i++) {
    const candidate = `${base}${joiner}${randomBytes(3).toString('hex')}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  return null;
}
