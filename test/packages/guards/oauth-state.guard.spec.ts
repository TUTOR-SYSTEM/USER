import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import {
  FacebookOAuthCallbackGuard,
  FacebookOAuthStartGuard,
  GoogleOAuthCallbackGuard,
  GoogleOAuthStartGuard,
} from 'src/packages/guards/oauth-state.guard';

describe('OAuth state guards', () => {
  const makeContext = (req: Record<string, unknown>, res: Record<string, jest.Mock>) =>
    ({
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    }) as unknown as ExecutionContext;

  const makeRes = () => ({ cookie: jest.fn(), clearCookie: jest.fn() });

  // The Passport `super.canActivate` lives on the shared AuthGuard mixin prototype.
  const passportCanActivate = () =>
    Object.getPrototypeOf(Object.getPrototypeOf(GoogleOAuthCallbackGuard.prototype));

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('start guard', () => {
    it('stores a random state in an HttpOnly cookie scoped to /auth and passes it to Passport', () => {
      const res = makeRes();
      const guard = new GoogleOAuthStartGuard();

      const options = guard.getAuthenticateOptions(makeContext({}, res) as ExecutionContext);

      const state = (options as { state: string }).state;
      expect(state).toMatch(/^[0-9a-f]{64}$/);
      expect(res.cookie).toHaveBeenCalledWith(
        'oauth_state_google',
        state,
        expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/auth' }),
      );
    });

    it('issues a different state on every start', () => {
      const guard = new FacebookOAuthStartGuard();
      const first = guard.getAuthenticateOptions(makeContext({}, makeRes()) as ExecutionContext);
      const second = guard.getAuthenticateOptions(makeContext({}, makeRes()) as ExecutionContext);

      expect((first as { state: string }).state).not.toBe((second as { state: string }).state);
    });
  });

  describe('callback guard', () => {
    it('rejects a callback without the state cookie and clears the cookie', async () => {
      const res = makeRes();
      const req = { headers: {}, query: { state: 'abc' } };
      const guard = new GoogleOAuthCallbackGuard();

      await expect(guard.canActivate(makeContext(req, res) as ExecutionContext)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(res.clearCookie).toHaveBeenCalledWith('oauth_state_google', { path: '/auth' });
    });

    it('rejects a callback whose state does not match the cookie', async () => {
      const req = {
        headers: { cookie: 'oauth_state_facebook=expected-value' },
        query: { state: 'forged-value' },
      };
      const guard = new FacebookOAuthCallbackGuard();

      await expect(
        guard.canActivate(makeContext(req, makeRes()) as ExecutionContext),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a callback without a state query parameter', async () => {
      const req = { headers: { cookie: 'oauth_state_google=expected-value' }, query: {} };
      const guard = new GoogleOAuthCallbackGuard();

      await expect(
        guard.canActivate(makeContext(req, makeRes()) as ExecutionContext),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('ignores a cookie that belongs to another provider', async () => {
      const req = {
        headers: { cookie: 'oauth_state_facebook=shared-value' },
        query: { state: 'shared-value' },
      };
      const guard = new GoogleOAuthCallbackGuard();

      await expect(
        guard.canActivate(makeContext(req, makeRes()) as ExecutionContext),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('hands off to Passport when the state matches the cookie', async () => {
      const passport = jest
        .spyOn(passportCanActivate() as { canActivate: () => unknown }, 'canActivate')
        .mockResolvedValue(true);
      const req = {
        headers: { cookie: 'theme=dark; oauth_state_google=match-value; other=1' },
        query: { state: 'match-value' },
      };
      const guard = new GoogleOAuthCallbackGuard();

      await expect(
        guard.canActivate(makeContext(req, makeRes()) as ExecutionContext),
      ).resolves.toBe(true);
      expect(passport).toHaveBeenCalledTimes(1);
    });
  });
});
