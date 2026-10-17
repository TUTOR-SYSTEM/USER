import { HttpStatus, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ERROR_MESSAGES } from 'src/data/constants';
import { hashData } from '@packages/helpers';
import { AuthService } from 'src/features/auth/auth.service';
import type { UserService } from 'src/features/user/user.service';
import type { RmqProducer } from 'src/features/rabbitmq/rmq.producer';

// user.service pulls in the Drizzle repository, which the jest moduleNameMapper cannot resolve.
jest.mock('src/features/user/user.service', () => ({ UserService: class UserService {} }));

const USER_ID = '6f1c2b4e-9d3a-4c7e-8b21-0a1b2c3d4e5f';
const env: Record<string, string> = {
  JWT_ACCESS_SECRET: 'test-access-secret',
  JWT_REFRESH_SECRET: 'test-refresh-secret',
  JWT_ACCESS_EXPIRES_SECONDS: '900',
  JWT_REFRESH_EXPIRES_SECONDS: '3600',
};

function buildUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: 'student@example.test',
    username: 'student1',
    userCode: 'ABC123',
    firstName: 'Ann',
    lastName: 'Le',
    role: 'STUDENT',
    isActive: true,
    password: '',
    ...overrides,
  };
}

/** Resolves with the thrown error so the test can assert the class, status and message together. */
async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('AuthService invalid credentials (HTTP status 401)', () => {
  let service: AuthService;
  let userService: { getUserByField: jest.Mock };
  let rmq: { send: jest.Mock; emit: jest.Mock };
  let correctPasswordHash: string;

  beforeAll(async () => {
    correctPasswordHash = await hashData('correct-password');
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    userService = { getUserByField: jest.fn().mockResolvedValue([]) };
    rmq = {
      send: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn().mockResolvedValue(undefined),
    };
    const config = { get: (key: string) => env[key] } as unknown as ConfigService;
    service = new AuthService(
      userService as unknown as UserService,
      new JwtService({}),
      rmq as unknown as RmqProducer,
      config,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // AC1: unknown email -> 401 with its own message
  it('AC1: unknown email rejects with UnauthorizedException (401) and EMAIL_NOT_FOUND', async () => {
    userService.getUserByField.mockResolvedValue([]);

    const error = await captureError(
      service.loginService({ email: 'nobody@example.test', password: 'whatever' } as never),
    );

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect((error as UnauthorizedException).message).toBe(ERROR_MESSAGES.EMAIL_NOT_FOUND);
    expect(rmq.send).not.toHaveBeenCalled();
  });

  // AC2: wrong password -> 401 with its own message (distinct from an unknown email)
  it('AC2: wrong password rejects with UnauthorizedException (401) and INVALID_PASSWORD', async () => {
    userService.getUserByField.mockResolvedValue([buildUser({ password: correctPasswordHash })]);

    const error = await captureError(
      service.loginService({ email: 'student@example.test', password: 'wrong' } as never),
    );

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect((error as UnauthorizedException).message).toBe(ERROR_MESSAGES.INVALID_PASSWORD);
    expect(rmq.send).not.toHaveBeenCalled();
  });

  // AC3: the success path is unchanged and the deactivated-account branch stays Unauthorized
  it('AC3: correct password still returns access and refresh tokens', async () => {
    userService.getUserByField.mockResolvedValue([buildUser({ password: correctPasswordHash })]);

    const result = await service.loginService({
      email: 'student@example.test',
      password: 'correct-password',
    } as never);

    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
    expect(result.user.id).toBe(USER_ID);
  });

  it('AC3: deactivated account with the correct password stays UnauthorizedException with ACCOUNT_DEACTIVATED', async () => {
    userService.getUserByField.mockResolvedValue([
      buildUser({ password: correctPasswordHash, isActive: false }),
    ]);

    const error = await captureError(
      service.loginService({
        email: 'student@example.test',
        password: 'correct-password',
      } as never),
    );

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect((error as UnauthorizedException).message).toBe(ERROR_MESSAGES.ACCOUNT_DEACTIVATED);
  });
});
