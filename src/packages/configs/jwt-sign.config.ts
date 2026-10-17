import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_JWT_ACCESS_EXPIRES_SECONDS,
  DEFAULT_JWT_REFRESH_EXPIRES_SECONDS,
  type JwtTokensConfig,
} from '../helpers';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Reads the signing secrets and fails fast when they are missing. There is deliberately no
 * fallback secret: a guessable default would let anyone mint tokens for any user.
 */
export function getJwtTokensConfig(configService: ConfigService): JwtTokensConfig {
  const accessSecret =
    configService.get<string>('JWT_ACCESS_SECRET')?.trim() ||
    configService.get<string>('JWT_SECRET')?.trim();
  const refreshSecret = configService.get<string>('JWT_REFRESH_SECRET')?.trim();
  if (!accessSecret || !refreshSecret) {
    throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set');
  }

  const accessExpiresIn = parsePositiveInt(
    configService.get<string>('JWT_ACCESS_EXPIRES_SECONDS'),
    DEFAULT_JWT_ACCESS_EXPIRES_SECONDS,
  );
  const refreshExpiresIn = parsePositiveInt(
    configService.get<string>('JWT_REFRESH_EXPIRES_SECONDS'),
    DEFAULT_JWT_REFRESH_EXPIRES_SECONDS,
  );

  return {
    accessSecret,
    accessExpiresIn,
    refreshSecret,
    refreshExpiresIn,
  };
}

/** Default Nest `JwtModule` — used as defaults; access/refresh still pass explicit options when signing. */
export function getJwtModuleOptionsFromConfig(configService: ConfigService) {
  const { accessSecret, accessExpiresIn } = getJwtTokensConfig(configService);
  return {
    secret: accessSecret,
    signOptions: { expiresIn: accessExpiresIn },
  };
}
