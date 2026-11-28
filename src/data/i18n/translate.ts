import { DEFAULT_LANGUAGE, type SupportedLanguage } from '@packages/guards/language.guard';

/** A single translatable message: one string per supported language. */
export type Translation = Record<SupportedLanguage, string>;

/** A dictionary keyed by a stable message code (e.g. `CLASS_NOT_FOUND`). */
export type TranslationDict = Record<string, Translation>;

/**
 * Resolve a raw message (as thrown by services / set on `@ApiResponse`) into the
 * requested language.
 *
 * - Exact code match → the localized string.
 * - Composed `"CODE: extra"` (e.g. `` `${ERROR_MESSAGES.EMAIL_EXISTS}: ${email}` ``)
 *   → localizes the `CODE` part and re-appends the dynamic suffix.
 * - Anything else (plain strings, Zod validation output) → returned untouched.
 */
export function translateMessage(
  dict: TranslationDict,
  raw: string | undefined,
  lang: SupportedLanguage,
): string {
  if (!raw) return raw ?? '';

  const exact = dict[raw];
  if (exact) return exact[lang] ?? exact[DEFAULT_LANGUAGE] ?? raw;

  const sep = raw.indexOf(': ');
  if (sep > 0) {
    const code = raw.slice(0, sep);
    const suffix = raw.slice(sep + 2);
    const entry = dict[code];
    if (entry) {
      const text = entry[lang] ?? entry[DEFAULT_LANGUAGE] ?? code;
      // `{}` marks where the suffix goes (e.g. minutes left, so the unit is translated too).
      return text.includes('{}') ? text.replace('{}', () => suffix) : `${text}: ${suffix}`;
    }
  }

  return raw;
}

/** Build a `{ CODE: 'CODE' }` map from a translation dict, preserving literal key types. */
export type CodeMap<T> = { [K in keyof T]: K };
export function toCodeMap<T extends TranslationDict>(dict: T): CodeMap<T> {
  return Object.fromEntries(Object.keys(dict).map((key) => [key, key])) as CodeMap<T>;
}
