import { BadRequestException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ERROR_MESSAGES } from 'src/data/constants';
import { hashData } from '@packages/helpers';
import { AuthService } from 'src/features/auth/auth.service';
import type { UserService } from 'src/features/user/user.service';
import type { RmqProducer } from 'src/features/rabbitmq/rmq.producer';
import { clearSessionCache } from 'src/packages/helpers/session-check.helper';

// user.service pulls in the Drizzle repository (alias not resolvable under jest): stub the class.
jest.mock('src/features/user/user.service', () => ({ UserService: class UserService {} }));

const USER_ID = '6f1c2b4e-9d3a-4c7e-8b21-0a1b2c3d4e5f';
const RESET_JTI = '0b7a6c1e-2f3d-4e5a-9b8c-7d6e5f4a3b2c';
const EMAIL = 'student@example.test';
const env: Record<string, string> = {
  JWT_ACCESS_SECRET: 'test-access-secret',
  JWT_REFRESH_SECRET: 'test-refresh-secret',
  JWT_ACCESS_EXPIRES_SECONDS: '900',
  JWT_REFRESH_EXPIRES_SECONDS: '3600',
};

const user = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  email: EMAIL,
  username: 'student1',
  userCode: 'ABC123',
  firstName: 'Ann',
  lastName: 'Le',
  role: 'STUDENT',
  isActive: true,
  emailVerified: true,
  password: '',
  ...overrides,
});

/** In-memory third-service stand-in: string keys, GETDEL and INCR semantics as Redis has them. */
function fakeRmq() {
  const store = new Map<string, string>();
  const send = jest.fn(async (pattern: string, payload: Record<string, unknown>) => {
    switch (pattern) {
      case 'redis.set':
        store.set(payload.key as string, payload.value as string);
        return { ok: true };
      case 'redis.get':
        return store.get(payload.key as string) ?? null;
      case 'redis.getdel': {
        const value = store.get(payload.key as string) ?? null;
        store.delete(payload.key as string);
        return value;
      }
      case 'redis.incr': {
        const count = Number(store.get(payload.key as string) ?? 0) + 1;
        store.set(payload.key as string, String(count));
        return { count };
      }
      default:
        throw new Error(`unexpected ${pattern}`);
    }
  });
  const emit = jest.fn(async (pattern: string, payload: { keys: string[] }) => {
    if (pattern === 'redis.del') payload.keys.forEach((k) => store.delete(k));
  });
  return { store, send, emit };
}

const statusOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => (error instanceof HttpException ? error.getStatus() : error),
  );

describe('AuthService atomic reset and per-account lockout', () => {
  let rmq: ReturnType<typeof fakeRmq>;
  let userService: Record<string, jest.Mock>;
  let correctHash: string;

  beforeAll(async () => {
    correctHash = await hashData('correct-password');
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    clearSessionCache();
    rmq = fakeRmq();
    userService = {
      getUserByField: jest.fn().mockResolvedValue([user({ password: correctHash })]),
      updateUserPasswordService: jest.fn().mockResolvedValue({}),
      setEmailVerifiedService: jest.fn().mockResolvedValue({ id: USER_ID, emailVerified: true }),
    };
  });

  const build = (overrides: Record<string, string> = {}) => {
    const config = {
      get: (key: string) => ({ ...env, ...overrides })[key],
    } as unknown as ConfigService;
    return new AuthService(
      userService as unknown as UserService,
      new JwtService({}),
      rmq as unknown as RmqProducer,
      config,
    );
  };

  describe('reset password (single use)', () => {
    it('reads and deletes the token with one redis.getdel and never with a separate get/del', async () => {
      await rmq.send('redis.set', { key: `reset-password:${RESET_JTI}`, value: USER_ID });
      const service = build();

      await expect(
        service.resetPasswordService({ jti: RESET_JTI, password: 'Abcdef1!' } as never),
      ).resolves.toEqual({ ok: true });

      expect(rmq.send).toHaveBeenCalledWith(
        'redis.getdel',
        { key: `reset-password:${RESET_JTI}` },
        expect.any(Number),
        0,
      );
      expect(rmq.send).not.toHaveBeenCalledWith(
        'redis.get',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      expect(rmq.emit).not.toHaveBeenCalledWith('redis.del', expect.anything());
      expect(rmq.store.has(`reset-password:${RESET_JTI}`)).toBe(false);
    });

    it('lets exactly one of two concurrent resets with the same token succeed', async () => {
      await rmq.send('redis.set', { key: `reset-password:${RESET_JTI}`, value: USER_ID });
      const service = build();
      const attempt = () =>
        service.resetPasswordService({ jti: RESET_JTI, password: 'Abcdef1!' } as never);

      const results = await Promise.allSettled([attempt(), attempt()]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(BadRequestException);
      expect(rejected.reason.message).toBe(ERROR_MESSAGES.INVALID_RESET_PASSWORD_TOKEN);
      expect(userService.updateUserPasswordService).toHaveBeenCalledTimes(1);
    });
  });

  describe('per-account lockout', () => {
    const wrongPassword = (service: AuthService) =>
      statusOf(service.loginService({ email: EMAIL, password: 'wrong-password' }));

    it('rejects with 401 until the limit, then 429 even for the correct password', async () => {
      const service = build();

      for (let i = 0; i < 5; i++) {
        expect(await wrongPassword(service)).toBe(HttpStatus.UNAUTHORIZED);
      }
      const locked = await statusOf(
        service.loginService({ email: EMAIL, password: 'correct-password' }),
      );

      expect(locked).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(rmq.send).toHaveBeenCalledWith(
        'redis.incr',
        expect.objectContaining({ windowSeconds: 900 }),
      );
    });

    it('answers a locked identifier the same way whether or not the account exists', async () => {
      const service = build();
      userService.getUserByField.mockResolvedValue([]);

      for (let i = 0; i < 5; i++) {
        await wrongPassword(service);
      }

      await expect(wrongPassword(service)).resolves.toBe(HttpStatus.TOO_MANY_REQUESTS);
    });

    it('returns the lockout message key, not an account-specific one', async () => {
      const service = build({ LOGIN_MAX_ATTEMPTS: '1' });
      await wrongPassword(service);

      await expect(
        service.loginService({ email: EMAIL, password: 'correct-password' }),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.TOO_MANY_LOGIN_ATTEMPTS });
    });

    it('clears the counter after a successful sign-in', async () => {
      const service = build();
      await wrongPassword(service);
      await wrongPassword(service);

      await service.loginService({ email: EMAIL, password: 'correct-password' });

      expect(rmq.emit).toHaveBeenCalledWith('redis.del', {
        keys: [expect.stringMatching(/^login-fail:[0-9a-f]{64}$/)],
      });
      expect([...rmq.store.keys()].some((k) => k.startsWith('login-fail:'))).toBe(false);
    });

    it('never stores the email in plain text in the counter key', async () => {
      const service = build();
      await wrongPassword(service);

      const keys = [...rmq.store.keys()];
      expect(keys.every((k) => !k.includes(EMAIL))).toBe(true);
    });

    it('reads LOGIN_MAX_ATTEMPTS from config', async () => {
      const service = build({ LOGIN_MAX_ATTEMPTS: '2' });
      await wrongPassword(service);
      await wrongPassword(service);

      await expect(wrongPassword(service)).resolves.toBe(HttpStatus.TOO_MANY_REQUESTS);
    });

    it('falls back to the default when LOGIN_MAX_ATTEMPTS is not a positive integer', async () => {
      const service = build({ LOGIN_MAX_ATTEMPTS: 'banana' });
      for (let i = 0; i < 4; i++) {
        await wrongPassword(service);
      }

      expect(await wrongPassword(service)).toBe(HttpStatus.UNAUTHORIZED);
      expect(await wrongPassword(service)).toBe(HttpStatus.TOO_MANY_REQUESTS);
    });

    it('fails open when the counter cannot be read, instead of blocking every sign-in', async () => {
      const service = build();
      const real = rmq.send.getMockImplementation()!;
      rmq.send.mockImplementation((pattern: string, payload: Record<string, unknown>) =>
        pattern === 'redis.get' ? Promise.reject(new Error('timeout')) : real(pattern, payload),
      );

      const out = await service.loginService({ email: EMAIL, password: 'correct-password' });
      expect(out.accessToken).toBeTruthy();
    });

    it('applies the same lockout to the userCode sign-in', async () => {
      const service = build({ LOGIN_MAX_ATTEMPTS: '1' });
      userService.getUserByField.mockResolvedValue([user({ password: correctHash })]);
      const dto = { userCode: 'ABC123', password: 'wrong-password', role: 'STUDENT' };

      await expect(service.loginByUserCodeService(dto as never)).rejects.toBeInstanceOf(
        HttpException,
      );
      await expect(
        service.loginByUserCodeService({ ...dto, password: 'correct-password' } as never),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.TOO_MANY_LOGIN_ATTEMPTS });
    });
  });
});
