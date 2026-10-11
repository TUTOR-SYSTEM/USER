import { ExecutionContext } from '@nestjs/common';
import {
  DEFAULT_LANGUAGE,
  LanguageGuard,
  SUPPORTED_LANGUAGES,
} from 'src/packages/guards/language.guard';

describe('LanguageGuard', () => {
  const guard = new LanguageGuard();

  const run = (headers: Record<string, string | undefined>) => {
    const request: Record<string, unknown> = { headers };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    const result = guard.canActivate(ctx);
    return { result, language: request.language };
  };

  it('exposes vi as default and supports vi/en only', () => {
    expect(DEFAULT_LANGUAGE).toBe('vi');
    expect([...SUPPORTED_LANGUAGES]).toEqual(['vi', 'en']);
  });

  it('always lets the request through', () => {
    expect(run({}).result).toBe(true);
  });

  it.each<[string, string | undefined]>([
    ['no header', undefined],
    ['empty header', ''],
    ['unsupported single tag', 'fr'],
    ['unsupported tags only', 'fr-FR,de;q=0.8'],
    ['only q=0 wildcard-like entry', '*;q=0.5'],
  ])('falls back to vi for %s', (_label, header) => {
    expect(run({ 'accept-language': header }).language).toBe('vi');
  });

  it.each<[string, string]>([
    ['en', 'en'],
    ['en-US', 'en'],
    ['EN-gb', 'en'],
    ['vi-VN', 'vi'],
    ['vi', 'vi'],
  ])('resolves %s to %s', (header, expected) => {
    expect(run({ 'accept-language': header }).language).toBe(expected);
  });

  it('picks the highest-weighted supported tag, not the first one listed', () => {
    expect(run({ 'accept-language': 'vi;q=0.5,en;q=0.9' }).language).toBe('en');
    expect(run({ 'accept-language': 'en;q=0.1,vi;q=0.9' }).language).toBe('vi');
  });

  it('skips unsupported higher-weighted tags and takes the next supported one', () => {
    expect(run({ 'accept-language': 'fr;q=1.0,en;q=0.7' }).language).toBe('en');
  });

  it('treats a missing q as weight 1 (ranked above explicit lower weights)', () => {
    expect(run({ 'accept-language': 'en-US,vi;q=0.8' }).language).toBe('en');
  });

  it('treats an unparsable q value as weight 0', () => {
    expect(run({ 'accept-language': 'en;q=abc,vi;q=0.1' }).language).toBe('vi');
  });

  it('ignores whitespace around entries', () => {
    expect(run({ 'accept-language': '  fr ,  en ; q=0.4 ' }).language).toBe('en');
  });
});
