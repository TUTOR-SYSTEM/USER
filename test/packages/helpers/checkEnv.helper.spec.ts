import { ConfigService } from '@nestjs/config';
import { validateRequiredEnvs } from 'src/packages/helpers/checkEnv.helper';

describe('validateRequiredEnvs', () => {
  const configWith = (values: Record<string, string | undefined>) =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;

  it('returns true when every required key has a non-blank value', () => {
    expect(validateRequiredEnvs(configWith({ A: '1', B: 'x' }), ['A', 'B'])).toBe(true);
  });

  it('returns true for an empty requirement list', () => {
    expect(validateRequiredEnvs(configWith({}), [])).toBe(true);
  });

  it.each<[string, string | undefined]>([
    ['missing', undefined],
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('throws listing the key when it is %s', (_label, value) => {
    expect(() => validateRequiredEnvs(configWith({ A: value }), ['A'])).toThrow(
      'Missing required environment variables:\n- A',
    );
  });

  it('lists every missing key, in order, and ignores the present ones', () => {
    expect(() =>
      validateRequiredEnvs(configWith({ B: 'ok', C: '' }), ['A', 'B', 'C', 'D']),
    ).toThrow('Missing required environment variables:\n- A\n- C\n- D');
  });

  it('does not trim the value it returns to the caller (only checks blankness)', () => {
    expect(validateRequiredEnvs(configWith({ A: ' value ' }), ['A'])).toBe(true);
  });
});
