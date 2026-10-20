import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_JWT_ACCESS_EXPIRES_SECONDS,
  DEFAULT_JWT_REFRESH_EXPIRES_SECONDS,
} from 'src/packages/helpers';
import {
  getJwtModuleOptionsFromConfig,
  getJwtTokensConfig,
} from 'src/packages/configs/jwt-sign.config';

function configOf(values: Record<string, string | undefined>) {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('getJwtTokensConfig', () => {
  it('uses the explicit access and refresh secrets and TTLs', () => {
    expect(
      getJwtTokensConfig(
        configOf({
          JWT_ACCESS_SECRET: 'a',
          JWT_REFRESH_SECRET: 'r',
          JWT_ACCESS_EXPIRES_SECONDS: '60',
          JWT_REFRESH_EXPIRES_SECONDS: '120',
        }),
      ),
    ).toEqual({
      accessSecret: 'a',
      accessExpiresIn: 60,
      refreshSecret: 'r',
      refreshExpiresIn: 120,
    });
  });

  it('refuses to start without both secrets: no fallback to a guessable default', () => {
    expect(() => getJwtTokensConfig(configOf({}))).toThrow(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set',
    );
    expect(() => getJwtTokensConfig(configOf({ JWT_ACCESS_SECRET: 'a' }))).toThrow();
    expect(() => getJwtTokensConfig(configOf({ JWT_SECRET: 'legacy' }))).toThrow();
    expect(() =>
      getJwtTokensConfig(configOf({ JWT_ACCESS_SECRET: 'a', JWT_REFRESH_SECRET: '  ' })),
    ).toThrow();
  });

  it('uses the documented TTL defaults when the env vars are unset or empty', () => {
    const cfg = getJwtTokensConfig(
      configOf({ JWT_ACCESS_SECRET: 'a', JWT_REFRESH_SECRET: 'r', JWT_ACCESS_EXPIRES_SECONDS: '' }),
    );
    expect(cfg.accessExpiresIn).toBe(DEFAULT_JWT_ACCESS_EXPIRES_SECONDS);
    expect(cfg.refreshExpiresIn).toBe(DEFAULT_JWT_REFRESH_EXPIRES_SECONDS);
  });

  it.each(['0', '-5', 'abc'])('ignores a non-positive or non-numeric TTL (%s)', (raw) => {
    const cfg = getJwtTokensConfig(
      configOf({
        JWT_ACCESS_SECRET: 'a',
        JWT_REFRESH_SECRET: 'r',
        JWT_ACCESS_EXPIRES_SECONDS: raw,
      }),
    );
    expect(cfg.accessExpiresIn).toBe(DEFAULT_JWT_ACCESS_EXPIRES_SECONDS);
  });
});

describe('getJwtModuleOptionsFromConfig', () => {
  it('maps the access secret and TTL into the Nest JwtModule options shape', () => {
    expect(
      getJwtModuleOptionsFromConfig(
        configOf({
          JWT_ACCESS_SECRET: 'a',
          JWT_REFRESH_SECRET: 'r',
          JWT_ACCESS_EXPIRES_SECONDS: '90',
        }),
      ),
    ).toEqual({ secret: 'a', signOptions: { expiresIn: 90 } });
  });

  it('throws when no secret is configured', () => {
    expect(() => getJwtModuleOptionsFromConfig(configOf({}))).toThrow();
  });
});
