import { ExecutionContext } from '@nestjs/common';
import { DEFAULT_LANGUAGE } from 'src/packages/guards/language.guard';
import { currentUserFactory } from 'src/packages/decorators/user.decorator';
import { languageFactory } from 'src/packages/decorators/language.decorator';
import {
  API_RESPONSE_KEY,
  ApiResponse,
} from 'src/packages/decorators/api-success-response.decorator';
import { IS_PUBLIC_KEY, Public } from 'src/packages/decorators/public.decorator';
import { THROTTLE_KEY, Throttle } from 'src/packages/decorators/throttle.decorator';

/** Minimal ExecutionContext exposing only the HTTP request the factories read. */
const httpCtx = (request: Record<string, unknown>) =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

const USER = { id: 'u-1', email: 'a@b.c', typ: 'access', role: 'TUTOR' } as const;

describe('currentUserFactory (@CurrentUser)', () => {
  it('returns the whole JWT payload when no key is requested', () => {
    expect(currentUserFactory(undefined, httpCtx({ user: USER }))).toBe(USER);
  });

  it('returns a single claim when a key is requested', () => {
    expect(currentUserFactory('role', httpCtx({ user: USER }))).toBe('TUTOR');
    expect(currentUserFactory('id', httpCtx({ user: USER }))).toBe('u-1');
  });

  it('returns undefined when the request carries no user (guard did not run)', () => {
    expect(currentUserFactory(undefined, httpCtx({}))).toBeUndefined();
    expect(currentUserFactory('id', httpCtx({}))).toBeUndefined();
  });
});

describe('languageFactory (@Language)', () => {
  it('returns the language set by LanguageGuard', () => {
    expect(languageFactory(undefined, httpCtx({ language: 'vi' }))).toBe('vi');
  });

  it('falls back to the default language when the guard did not run', () => {
    expect(languageFactory(undefined, httpCtx({}))).toBe(DEFAULT_LANGUAGE);
  });
});

describe('metadata decorators', () => {
  class Controller {
    @ApiResponse({ message: 'ok' } as never)
    withApiResponse() {}

    @Public()
    publicRoute() {}

    @Throttle(5, 60)
    throttled() {}
  }

  it('ApiResponse stores its options under API_RESPONSE_KEY', () => {
    expect(Reflect.getMetadata(API_RESPONSE_KEY, Controller.prototype.withApiResponse)).toEqual({
      message: 'ok',
    });
  });

  it('Public marks the handler with IS_PUBLIC_KEY = true', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, Controller.prototype.publicRoute)).toBe(true);
  });

  it('Throttle stores the limit and ttl under THROTTLE_KEY', () => {
    expect(Reflect.getMetadata(THROTTLE_KEY, Controller.prototype.throttled)).toEqual({
      limit: 5,
      ttl: 60,
    });
  });
});
