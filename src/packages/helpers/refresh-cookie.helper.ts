import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { getJwtTokensConfig } from '../configs/jwt-sign.config';

/** Refresh token lives only in this httpOnly cookie; JS (and localStorage) never sees it. */
export const REFRESH_COOKIE_NAME = 'refresh_token';
/** Scoped to the auth routes that read or clear it (`/auth/refresh`, `/auth/logout`). */
export const REFRESH_COOKIE_PATH = '/auth';

/** `secure` cookies in production, or whenever `COOKIE_SECURE=true` is set explicitly. */
export function isSecureCookie(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
}

function baseCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isSecureCookie(),
    path: REFRESH_COOKIE_PATH,
  };
}

export function setRefreshCookie(
  res: Response,
  refreshToken: string,
  configService: ConfigService,
) {
  const { refreshExpiresIn } = getJwtTokensConfig(configService);
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    ...baseCookieOptions(),
    maxAge: refreshExpiresIn * 1000,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, baseCookieOptions());
}

/** Reads one cookie from the raw `Cookie` header; returns undefined when absent or empty. */
export function readRefreshCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name !== REFRESH_COOKIE_NAME) continue;
    const raw = part.slice(index + 1).trim();
    try {
      const value = decodeURIComponent(raw);
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
