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

  it('falls back to JWT_SECRET, then to the refresh secret reusing the access secret', () => {
    const cfg = getJwtTokensConfig(configOf({ JWT_SECRET: 'legacy' }));
    expect(cfg.accessSecret).toBe('legacy');
    expect(cfg.refreshSecret).toBe('legacy');
  });

  it('uses the documented TTL defaults when the env vars are unset or empty', () => {
    const cfg = getJwtTokensConfig(
      configOf({ JWT_ACCESS_SECRET: 'a', JWT_ACCESS_EXPIRES_SECONDS: '' }),
    );
    expect(cfg.accessExpiresIn).toBe(DEFAULT_JWT_ACCESS_EXPIRES_SECONDS);
    expect(cfg.refreshExpiresIn).toBe(DEFAULT_JWT_REFRESH_EXPIRES_SECONDS);
  });

  it.each(['0', '-5', 'abc'])('ignores a non-positive or non-numeric TTL (%s)', (raw) => {
    const cfg = getJwtTokensConfig(
      configOf({ JWT_ACCESS_SECRET: 'a', JWT_ACCESS_EXPIRES_SECONDS: raw }),
    );
    expect(cfg.accessExpiresIn).toBe(DEFAULT_JWT_ACCESS_EXPIRES_SECONDS);
  });

  it('falls back to a built-in dev secret when none is configured (documents current behaviour)', () => {
    // Note for reviewers: an unset secret silently signs with a public constant. Pinned here so
    // the fallback is a deliberate change if it is ever removed.
    expect(getJwtTokensConfig(configOf({})).accessSecret).toBe('dev-insecure-jwt-secret');
  });
});

describe('getJwtModuleOptionsFromConfig', () => {
  it('maps the access secret and TTL into the Nest JwtModule options shape', () => {
    expect(
      getJwtModuleOptionsFromConfig(
        configOf({ JWT_ACCESS_SECRET: 'a', JWT_ACCESS_EXPIRES_SECONDS: '90' }),
      ),
    ).toEqual({ secret: 'a', signOptions: { expiresIn: 90 } });
  });

  it('uses the defaults when no config is present', () => {
    expect(getJwtModuleOptionsFromConfig(configOf({}))).toEqual({
      secret: 'dev-insecure-jwt-secret',
      signOptions: { expiresIn: DEFAULT_JWT_ACCESS_EXPIRES_SECONDS },
    });
  });
});
