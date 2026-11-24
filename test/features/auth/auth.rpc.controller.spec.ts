import { AuthRpcController } from 'src/features/auth/auth.rpc.controller';
import { AuthService } from 'src/features/auth/auth.service';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { computeOAuthProfileSignature } from 'src/packages/helpers/rpc-actor-signature.helper';
import { ZodValidationPipe } from 'src/packages/pipes/zod-validation.pipe';

// auth.service -> user.service -> user.repository imports `@packages/database/schema`, which the
// jest moduleNameMapper cannot resolve. The controller only needs the class token here.
jest.mock('src/features/user/user.service', () => ({ UserService: class UserService {} }));

const SECRET = 'test-rpc-actor-secret';
const PASSWORD = 'Passw0rd!x';

const signedProfile = (
  provider: 'google' | 'facebook',
  overrides: Record<string, unknown> = {},
  sigTs = Date.now(),
) => {
  const profile = {
    ...(provider === 'google' ? { googleId: 'g-1' } : { facebookId: 'f-1' }),
    email: 'ann@example.com',
    firstName: 'Ann',
    lastName: 'Lee',
    ...overrides,
  } as Record<string, unknown>;
  const providerId = (provider === 'google' ? profile.googleId : profile.facebookId) as string;
  return {
    ...profile,
    oauthProfileSigTs: sigTs,
    oauthProfileSig: computeOAuthProfileSignature(
      { provider, providerId, email: 'ann@example.com' },
      sigTs,
      SECRET,
    ),
  };
};

describe('AuthRpcController', () => {
  const previousSecret = process.env.RPC_ACTOR_SECRET;
  beforeAll(() => {
    process.env.RPC_ACTOR_SECRET = SECRET;
  });
  afterAll(() => {
    process.env.RPC_ACTOR_SECRET = previousSecret;
  });

  let controller: AuthRpcController;
  let service: Record<string, jest.Mock>;

  beforeEach(() => {
    service = {
      registerService: jest.fn(),
      loginService: jest.fn(),
      loginByUserCodeService: jest.fn(),
      refreshTokens: jest.fn(),
      forgotPasswordService: jest.fn(),
      resetPasswordService: jest.fn(),
      googleLoginService: jest.fn(),
      facebookLoginService: jest.fn(),
      verifyEmailService: jest.fn(),
    };
    controller = new AuthRpcController(service as unknown as AuthService);
  });

  const payloads: Record<string, unknown> = {
    registerService: { email: 'a@b.test', password: PASSWORD, firstName: 'A', lastName: 'B' },
    loginService: { email: 'a@b.test', password: 'x' },
    loginByUserCodeService: { userCode: 'ABC123', password: 'x', role: 'STUDENT' },
    refreshTokens: { refreshToken: 'token' },
    forgotPasswordService: { email: 'a@b.test' },
    resetPasswordService: {
      email: 'a@b.test',
      otp: '123456',
      password: PASSWORD,
      confirmPassword: PASSWORD,
    },
  };

  it.each([
    ['auth.register', 'register', 'registerService'],
    ['auth.login', 'login', 'loginService'],
    ['auth.loginByUserCode', 'loginByUserCode', 'loginByUserCodeService'],
    ['auth.refresh', 'refresh', 'refreshTokens'],
    ['auth.forgotPassword', 'forgotPassword', 'forgotPasswordService'],
    ['auth.resetPassword', 'resetPassword', 'resetPasswordService'],
  ])(
    '%s is bound to the handler and delegates the validated payload to %s',
    async (pattern, method, svc) => {
      const handler = (controller as unknown as Record<string, (p: unknown) => Promise<unknown>>)[
        method
      ];
      const payload = payloads[svc];
      const sentinel = { from: svc };
      service[svc].mockResolvedValueOnce(sentinel);

      const result = await handler.call(controller, payload);

      expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([pattern]);
      // Login patterns also forward `clientIp` (lockout key), so compare the first argument only.
      expect(service[svc].mock.calls[0][0]).toEqual(payload);
      expect(result).toBe(sentinel);
    },
  );

  it.each([
    [
      'register',
      'registerService',
      { email: 'a@b.test', password: 'weak', firstName: 'A', lastName: 'B' },
    ],
    ['login', 'loginService', { email: 'not-an-email', password: 'x' }],
    ['login', 'loginService', { email: 123, password: 'x' }],
    [
      'loginByUserCode',
      'loginByUserCodeService',
      { userCode: 'ABC123', password: 'x', role: 'ADMIN' },
    ],
    ['refresh', 'refreshTokens', {}],
    ['forgotPassword', 'forgotPasswordService', { email: 'nope' }],
    [
      'resetPassword',
      'resetPasswordService',
      { email: 'a@b.test', otp: 'abcdef', password: PASSWORD, confirmPassword: PASSWORD },
    ],
  ])(
    '%s refuses an invalid payload with 422 and never reaches %s',
    async (method, svc, payload) => {
      const handler = (controller as unknown as Record<string, (p: unknown) => unknown>)[method];
      await expect(Promise.resolve().then(() => handler.call(controller, payload))).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(service[svc]).not.toHaveBeenCalled();
    },
  );

  describe('OAuth login profile', () => {
    it('accepts a gateway-signed Google profile and strips the signature fields', async () => {
      service.googleLoginService.mockResolvedValueOnce({ ok: true });
      await controller.googleLogin(signedProfile('google') as never);
      expect(service.googleLoginService).toHaveBeenCalledWith({
        googleId: 'g-1',
        email: 'ann@example.com',
        firstName: 'Ann',
        lastName: 'Lee',
      });
    });

    it('accepts a gateway-signed Facebook profile', async () => {
      service.facebookLoginService.mockResolvedValueOnce({ ok: true });
      await controller.facebookLogin(signedProfile('facebook') as never);
      expect(service.facebookLoginService).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['unsigned', { googleId: 'g-1', email: 'ann@example.com', firstName: 'A', lastName: 'B' }],
      ['signed for a different email', { ...signedProfile('google'), email: 'victim@example.com' }],
      ['signed for a different provider id', { ...signedProfile('google'), googleId: 'g-2' }],
      ['stale', signedProfile('google', {}, Date.now() - 10 * 60_000)],
      ['signed for the other provider', signedProfile('facebook', { googleId: 'g-1' })],
    ])('refuses a Google profile that is %s with 403', async (_label, payload) => {
      await expect(
        Promise.resolve().then(() => controller.googleLogin(payload as never)),
      ).rejects.toThrow(ForbiddenException);
      expect(service.googleLoginService).not.toHaveBeenCalled();
    });

    it('refuses a Facebook profile signed as a Google one', async () => {
      const wrong = { ...signedProfile('google'), googleId: undefined, facebookId: 'g-1' };
      await expect(
        Promise.resolve().then(() => controller.facebookLogin(wrong as never)),
      ).rejects.toThrow(ForbiddenException);
      expect(service.facebookLoginService).not.toHaveBeenCalled();
    });

    it('refuses a signed profile whose fields are malformed with 422', async () => {
      const bad = signedProfile('google', { firstName: '' });
      await expect(
        Promise.resolve().then(() => controller.googleLogin(bad as never)),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  it('delegates auth.verifyEmail to the service', async () => {
    service.verifyEmailService.mockResolvedValueOnce({ ok: true });
    await controller.verifyEmail({ jti: '6f1c2b4e-9d3a-4c7e-8b21-0a1b2c3d4e5f' });
    expect(service.verifyEmailService).toHaveBeenCalledTimes(1);
  });

  it('validates the auth.verifyEmail payload as a uuid jti before the handler runs', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, AuthRpcController, 'verifyEmail') as
      Record<string, { pipes: Array<{ transform: (v: unknown) => unknown }> }> | undefined;
    const pipe = Object.values(args ?? {})[0]?.pipes[0];
    expect(pipe).toBeInstanceOf(ZodValidationPipe);

    expect(pipe?.transform({ jti: '6f1c2b4e-9d3a-4c7e-8b21-0a1b2c3d4e5f' })).toEqual({
      jti: '6f1c2b4e-9d3a-4c7e-8b21-0a1b2c3d4e5f',
    });
    expect(() => pipe?.transform({ jti: 'not-a-uuid' })).toThrow(UnprocessableEntityException);
    expect(() => pipe?.transform({})).toThrow(UnprocessableEntityException);
  });

  it('propagates service errors to the RPC caller instead of swallowing them', async () => {
    service.loginService.mockRejectedValue(new Error('INVALID_CREDENTIALS'));

    await expect(controller.login(payloads.loginService as never)).rejects.toThrow(
      'INVALID_CREDENTIALS',
    );
  });
});
