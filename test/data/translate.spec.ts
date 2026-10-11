import { DEFAULT_LANGUAGE } from 'src/packages/guards/language.guard';
import { translateMessage, toCodeMap, type TranslationDict } from 'src/data/i18n/translate';

const dict: TranslationDict = {
  CLASS_NOT_FOUND: { vi: 'Không tìm thấy lớp', en: 'Class not found' },
  EMAIL_EXISTS: { vi: 'Email đã tồn tại', en: 'Email already exists' },
  VI_ONLY: { vi: 'Chỉ tiếng Việt', en: '' },
};

describe('translateMessage', () => {
  it('returns the localized string for an exact code match', () => {
    expect(translateMessage(dict, 'CLASS_NOT_FOUND', 'en')).toBe('Class not found');
    expect(translateMessage(dict, 'CLASS_NOT_FOUND', 'vi')).toBe('Không tìm thấy lớp');
  });

  it('localizes the code of a "CODE: suffix" message and keeps the suffix verbatim', () => {
    expect(translateMessage(dict, 'EMAIL_EXISTS: a@b.c', 'en')).toBe('Email already exists: a@b.c');
  });

  it('keeps the suffix when it itself contains ": "', () => {
    expect(translateMessage(dict, 'EMAIL_EXISTS: x: y', 'vi')).toBe('Email đã tồn tại: x: y');
  });

  it('returns plain strings untouched (e.g. Zod validation output)', () => {
    expect(translateMessage(dict, 'Invalid email', 'en')).toBe('Invalid email');
  });

  it('returns unknown composed codes untouched', () => {
    expect(translateMessage(dict, 'UNKNOWN_CODE: 123', 'en')).toBe('UNKNOWN_CODE: 123');
  });

  it('returns an empty translation as-is: `??` only falls back on null/undefined, not ""', () => {
    expect(translateMessage(dict, 'VI_ONLY', 'en')).toBe('');
    expect(translateMessage(dict, 'VI_ONLY', 'vi')).toBe('Chỉ tiếng Việt');
    expect(DEFAULT_LANGUAGE).toBe('vi');
  });

  it('returns an empty string for an undefined or empty raw message', () => {
    expect(translateMessage(dict, undefined, 'en')).toBe('');
    expect(translateMessage(dict, '', 'vi')).toBe('');
  });

  it('does not treat a leading ": " (separator at index 0) as a composed code', () => {
    expect(translateMessage(dict, ': orphan', 'en')).toBe(': orphan');
  });
});

describe('toCodeMap', () => {
  it('maps every key to itself', () => {
    expect(toCodeMap(dict)).toEqual({
      CLASS_NOT_FOUND: 'CLASS_NOT_FOUND',
      EMAIL_EXISTS: 'EMAIL_EXISTS',
      VI_ONLY: 'VI_ONLY',
    });
  });

  it('returns an empty map for an empty dictionary', () => {
    expect(toCodeMap({})).toEqual({});
  });
});

describe('translateMessage language fallbacks', () => {
  // Missing (undefined) language keys fall back; empty strings are real values and are kept.
  const partial = {
    VI_ONLY_EXACT: { vi: 'Chỉ tiếng Việt' },
    NO_LANG: {},
    PREFIXED_VI_ONLY: { vi: 'Thiếu' },
    PREFIX_NO_LANG: {},
  } as unknown as TranslationDict;

  it('falls back to the default language when the requested translation key is absent', () => {
    expect(translateMessage(partial, 'VI_ONLY_EXACT', 'en')).toBe('Chỉ tiếng Việt');
  });

  it('returns the raw code when neither the requested nor default translation exists', () => {
    expect(translateMessage(partial, 'NO_LANG', 'en')).toBe('NO_LANG');
  });

  it('falls back to the default language for the code part of a composed message', () => {
    expect(translateMessage(partial, 'PREFIXED_VI_ONLY: id-9', 'en')).toBe('Thiếu: id-9');
  });

  it('keeps the bare code when a composed message has no translation in either language', () => {
    expect(translateMessage(partial, 'PREFIX_NO_LANG: id-9', 'en')).toBe('PREFIX_NO_LANG: id-9');
  });

  it('returns the raw text when the prefix before ": " is not a known code', () => {
    expect(translateMessage(partial, ': orphan', 'vi')).toBe(': orphan');
  });
});
