import { AuthRpcController } from 'src/features/auth/auth.rpc.controller';
import { AuthService } from 'src/features/auth/auth.service';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { UnprocessableEntityException } from '@nestjs/common';
import { ZodValidationPipe } from 'src/packages/pipes/zod-validation.pipe';

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
      verifyEmailService: jest.fn(),
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
    ['auth.verifyEmail', 'verifyEmail', 'verifyEmailService'],
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

    await expect(controller.login({} as never)).rejects.toThrow('INVALID_CREDENTIALS');
  });
});
