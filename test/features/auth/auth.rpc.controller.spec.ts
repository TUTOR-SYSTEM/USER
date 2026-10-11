import { AuthRpcController } from 'src/features/auth/auth.rpc.controller';
import { AuthService } from 'src/features/auth/auth.service';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';

// auth.service -> user.service -> user.repository imports `@packages/database/schema`, which the
// jest moduleNameMapper cannot resolve. The controller only needs the class token here.
jest.mock('src/features/user/user.service', () => ({ UserService: class UserService {} }));

describe('AuthRpcController', () => {
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
    };
    controller = new AuthRpcController(service as unknown as AuthService);
  });

  it.each([
    ['auth.register', 'register', 'registerService'],
    ['auth.login', 'login', 'loginService'],
    ['auth.loginByUserCode', 'loginByUserCode', 'loginByUserCodeService'],
    ['auth.refresh', 'refresh', 'refreshTokens'],
    ['auth.forgotPassword', 'forgotPassword', 'forgotPasswordService'],
    ['auth.resetPassword', 'resetPassword', 'resetPasswordService'],
    ['auth.googleLogin', 'googleLogin', 'googleLoginService'],
    ['auth.facebookLogin', 'facebookLogin', 'facebookLoginService'],
  ])('%s is bound to the handler and delegates to %s unchanged', async (pattern, method, svc) => {
    const handler = (controller as unknown as Record<string, (p: unknown) => Promise<unknown>>)[
      method
    ];
    const payload = { probe: true };
    const sentinel = { from: svc };
    service[svc].mockResolvedValueOnce(sentinel);

    const result = await handler.call(controller, payload);

    expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([pattern]);
    expect(service[svc]).toHaveBeenCalledWith(payload);
    expect(result).toBe(sentinel);
  });

  it('propagates service errors to the RPC caller instead of swallowing them', async () => {
    service.loginService.mockRejectedValue(new Error('INVALID_CREDENTIALS'));

    await expect(controller.login({} as never)).rejects.toThrow('INVALID_CREDENTIALS');
  });
});
