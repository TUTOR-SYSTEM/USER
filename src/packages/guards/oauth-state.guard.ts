import {
  ExecutionContext,
  Injectable,
  Type,
  UnauthorizedException,
  type CanActivate,
} from '@nestjs/common';
import { AuthGuard, type IAuthModuleOptions } from '@nestjs/passport';
import type { Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ERROR_MESSAGES } from 'src/data/constants';

/** Long enough to finish the provider's consent screen, short enough to limit replay. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** Only sent to the auth routes (`/auth/<provider>` and its callback). */
const COOKIE_PATH = '/auth';

const stateCookieName = (provider: string) => `oauth_state_${provider}`;

/** Same rule as gateway's refresh cookie: `secure` in production or when set explicitly. */
const isSecureCookie = (): boolean =>
  process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function sameValue(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Starts the OAuth redirect with a random `state` (anti-CSRF). The same value is stored in a
 * short-lived HttpOnly cookie, so the callback can prove it was started by this browser.
 */
function createOAuthStartGuard(provider: string): Type<CanActivate> {
  const Base = AuthGuard(provider);
  class OAuthStartGuard extends Base {
    getAuthenticateOptions(context: ExecutionContext): IAuthModuleOptions {
      const res = context.switchToHttp().getResponse<Response>();
      const state = randomBytes(32).toString('hex');
      res.cookie(stateCookieName(provider), state, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isSecureCookie(),
        path: COOKIE_PATH,
        maxAge: OAUTH_STATE_TTL_MS,
      });
      return { state };
    }
  }
  return OAuthStartGuard;
}

/**
 * Rejects the provider callback unless its `state` matches the cookie set when the flow started.
 * This runs before Passport exchanges the authorization code, so a forged callback never reaches
 * token issuance. The cookie is single-use and cleared either way.
 */
function createOAuthCallbackGuard(provider: string): Type<CanActivate> {
  const Base = AuthGuard(provider);
  class OAuthCallbackGuard extends Base {
    async canActivate(context: ExecutionContext): Promise<boolean> {
      const req = context.switchToHttp().getRequest<Request>();
      const res = context.switchToHttp().getResponse<Response>();
      const name = stateCookieName(provider);
      const expected = readCookie(req, name);
      res.clearCookie(name, { path: COOKIE_PATH });

      const provided = typeof req.query.state === 'string' ? req.query.state : undefined;
      if (!expected || !provided || !sameValue(expected, provided)) {
        throw new UnauthorizedException(ERROR_MESSAGES.OAUTH_STATE_INVALID);
      }
      return (await super.canActivate(context)) as boolean;
    }
  }
  return OAuthCallbackGuard;
}

@Injectable()
export class GoogleOAuthStartGuard extends createOAuthStartGuard('google') {}

@Injectable()
export class GoogleOAuthCallbackGuard extends createOAuthCallbackGuard('google') {}

@Injectable()
export class FacebookOAuthStartGuard extends createOAuthStartGuard('facebook') {}

@Injectable()
export class FacebookOAuthCallbackGuard extends createOAuthCallbackGuard('facebook') {}
