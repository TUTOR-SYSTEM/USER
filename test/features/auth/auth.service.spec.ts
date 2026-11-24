import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ERROR_MESSAGES } from 'src/data/constants';
import { createHash } from 'node:crypto';
import { hashData, hashRefreshToken } from '@packages/helpers';
import { AuthService } from 'src/features/auth/auth.service';
import type { UserService } from 'src/features/user/user.service';
import type { RmqProducer } from 'src/features/rabbitmq/rmq.producer';
import { clearSessionCache } from 'src/packages/helpers/session-check.helper';

// user.service pulls in the Drizzle repository (alias not resolvable under jest): stub the class.
jest.mock('src/features/user/user.service', () => ({ UserService: class UserService {} }));

const USER_ID = '6f1c2b4e-9d3a-4c7e-8b21-0a1b2c3d4e5f';
const env: Record<string, string> = {
  JWT_ACCESS_SECRET: 'test-access-secret',
  JWT_REFRESH_SECRET: 'test-refresh-secret',
  JWT_ACCESS_EXPIRES_SECONDS: '900',
  JWT_REFRESH_EXPIRES_SECONDS: '3600',
};

const user = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  email: 'student@example.test',
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

/** In-memory stand-in for third-service's `redis.*` RPC (set/get/exists/delByPrefix/del). */
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
      case 'redis.exists':
        return store.has(payload.key as string);
      case 'redis.incr': {
        const count = Number(store.get(payload.key as string) ?? 0) + 1;
        store.set(payload.key as string, String(count));
        return { count };
      }
      case 'email.sendPasswordResetOtp':
      case 'email.sendVerifyEmail':
        return { ok: true };
      case 'redis.delByPrefix': {
        let deleted = 0;
        for (const k of [...store.keys()]) {
          if (k.startsWith(payload.prefix as string)) {
            store.delete(k);
            deleted++;
          }
        }
        return { deleted };
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

describe('AuthService', () => {
  let service: AuthService;
  let jwt: JwtService;
  let rmq: ReturnType<typeof fakeRmq>;
  let userService: Record<string, jest.Mock>;
  let correctHash: string;

  beforeAll(async () => {
    correctHash = await hashData('correct-password');
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    clearSessionCache();
    jwt = new JwtService({});
    rmq = fakeRmq();
    userService = {
      getUserByField: jest.fn().mockResolvedValue([]),
      createUserService: jest.fn().mockResolvedValue({ message: 'ok', data: {} }),
      updateUserPasswordService: jest.fn().mockResolvedValue({}),
      setEmailVerifiedService: jest.fn().mockResolvedValue({ id: USER_ID, emailVerified: true }),
    };
    const config = { get: (key: string) => env[key] } as unknown as ConfigService;
    service = new AuthService(
      userService as unknown as UserService,
      jwt,
      rmq as unknown as RmqProducer,
      config,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const sessionKeys = () => [...rmq.store.keys()].filter((k) => k.startsWith('session:'));

  describe('login', () => {
    it('returns access and refresh tokens that both carry a sid, and records the session', async () => {
      userService.getUserByField.mockResolvedValue([user({ password: correctHash })]);

      const out = await service.loginService({
        email: 'Student@Example.test',
        password: 'correct-password',
      });

      const access = jwt.decode(out.accessToken) as Record<string, string>;
      const refresh = jwt.decode(out.refreshToken) as Record<string, string>;
      expect(access.sid).toMatch(/^[0-9a-f-]{36}$/);
      expect(refresh.sid).toBe(access.sid);
      expect(userService.getUserByField).toHaveBeenCalledWith({
        field: 'email',
        value: 'student@example.test',
      });
      expect(rmq.store.get(`session:${USER_ID}:${access.sid}`)).toBe('1');
      expect(rmq.store.get(`refresh:${USER_ID}:${access.sid}`)).toBe(
        hashRefreshToken(out.refreshToken),
      );
      expect(out).not.toHaveProperty('refreshToken', undefined);
    });

    it('opens a new session per login and leaves the other devices signed in', async () => {
      userService.getUserByField.mockResolvedValue([user({ password: correctHash })]);
      await service.loginService({ email: 'a@b.test', password: 'correct-password' });
      await service.loginService({ email: 'a@b.test', password: 'correct-password' });
      expect(sessionKeys()).toHaveLength(2);
    });

    it('refuses the login when the session cannot be stored (awaited, not fire-and-forget)', async () => {
      userService.getUserByField.mockResolvedValue([user({ password: correctHash })]);
      rmq.send.mockImplementation(async (pattern: string) => {
        if (pattern === 'redis.get') return null;
        throw new Error('redis down');
      });
      await expect(
        service.loginService({ email: 'a@b.test', password: 'correct-password' }),
      ).rejects.toThrow('redis down');
    });

    it('reports an unknown email as EMAIL_NOT_FOUND', async () => {
      await expect(
        service.loginService({ email: 'x@y.test', password: 'whatever1' }),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.EMAIL_NOT_FOUND });
    });

    it('reports a wrong password as INVALID_PASSWORD', async () => {
      userService.getUserByField.mockResolvedValue([user({ password: correctHash })]);
      await expect(
        service.loginService({ email: 'x@y.test', password: 'wrong' }),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.INVALID_PASSWORD });
    });

    it('reports an OAuth-only account (no password) as ACCOUNT_NO_PASSWORD', async () => {
      userService.getUserByField.mockResolvedValue([user({ password: null })]);
      await expect(
        service.loginService({ email: 'x@y.test', password: 'whatever1' }),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.ACCOUNT_NO_PASSWORD });
    });

    it('reports an unknown user code as USER_CODE_NOT_FOUND', async () => {
      userService.getUserByField.mockResolvedValue([]);
      await expect(
        service.loginByUserCodeService({
          userCode: '123456',
          password: 'x',
          role: 'STUDENT',
        } as never),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.USER_CODE_NOT_FOUND });
    });

    it('still signs in a legacy account whose password is shorter than the new minimum', async () => {
      userService.getUserByField.mockResolvedValue([user({ password: await hashData('abc123') })]);
      await expect(
        service.loginService({ email: 'a@b.test', password: 'abc123' }),
      ).resolves.toHaveProperty('accessToken');
    });
  });

  describe('refresh', () => {
    async function login() {
      userService.getUserByField.mockResolvedValue([user({ password: correctHash })]);
      return service.loginService({ email: 'a@b.test', password: 'correct-password' });
    }

    it('rotates: the presented token is replaced by a new pair on the same session', async () => {
      const first = await login();
      userService.getUserByField.mockResolvedValue([user()]);

      const second = await service.refreshTokens({ refreshToken: first.refreshToken });

      expect(second.refreshToken).not.toBe(first.refreshToken);
      const sid = (jwt.decode(first.refreshToken) as Record<string, string>).sid;
      expect((jwt.decode(second.refreshToken) as Record<string, string>).sid).toBe(sid);
      expect(rmq.store.get(`refresh:${USER_ID}:${sid}`)).toBe(
        hashRefreshToken(second.refreshToken),
      );
    });

    it('treats a replayed (already rotated) token as reuse and revokes that session', async () => {
      const first = await login();
      userService.getUserByField.mockResolvedValue([user()]);
      await service.refreshTokens({ refreshToken: first.refreshToken });

      await expect(
        service.refreshTokens({ refreshToken: first.refreshToken }),
      ).rejects.toMatchObject({
        message: ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH_TOKEN,
      });
      expect(sessionKeys()).toHaveLength(0);
    });

    it('refuses a token after logout', async () => {
      const out = await login();
      const sid = (jwt.decode(out.refreshToken) as Record<string, string>).sid;
      await service.logoutService({ userId: USER_ID, sid });
      userService.getUserByField.mockResolvedValue([user()]);
      await expect(
        service.refreshTokens({ refreshToken: out.refreshToken }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('refuses a legacy refresh token that has no sid', async () => {
      const legacy = await jwt.signAsync(
        { sub: USER_ID, email: 'a@b.test', typ: 'refresh' },
        { secret: env.JWT_REFRESH_SECRET, expiresIn: 60 },
      );
      await expect(service.refreshTokens({ refreshToken: legacy })).rejects.toMatchObject({
        message: ERROR_MESSAGES.INVALID_SESSION,
      });
    });

    it('fails closed (503) when the stored hash cannot be read', async () => {
      const out = await login();
      rmq.send.mockRejectedValueOnce(new Error('timeout'));
      await expect(
        service.refreshTokens({ refreshToken: out.refreshToken }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('lets only one of two concurrent refreshes with the same token succeed', async () => {
      const first = await login();
      userService.getUserByField.mockResolvedValue([user()]);

      const results = await Promise.allSettled([
        service.refreshTokens({ refreshToken: first.refreshToken }),
        service.refreshTokens({ refreshToken: first.refreshToken }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('a revoke that lands while a refresh is in flight wins: the new session is not kept', async () => {
      const first = await login();
      userService.getUserByField.mockResolvedValue([user()]);
      const original = rmq.send.getMockImplementation()!;
      let fired = false;
      rmq.send.mockImplementation(async (pattern: string, payload: Record<string, unknown>) => {
        const result = await original(pattern, payload);
        // Right after the refresh writes its hash, a logout-all lands: marker first, then the deletes.
        if (
          !fired &&
          pattern === 'redis.set' &&
          String(payload.key).startsWith(`refresh:${USER_ID}:`)
        ) {
          fired = true;
          await original('redis.set', {
            key: `revoked-all:${USER_ID}`,
            value: String(Date.now() + 1),
            ttlSeconds: 60,
          });
          for (const key of [...rmq.store.keys()]) {
            if (key.startsWith(`session:${USER_ID}:`) || key.startsWith(`refresh:${USER_ID}:`)) {
              rmq.store.delete(key);
            }
          }
        }
        return result;
      });

      await expect(
        service.refreshTokens({ refreshToken: first.refreshToken }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(sessionKeys()).toHaveLength(0);
    });

    it('refuses a refresh for a deactivated account', async () => {
      const out = await login();
      userService.getUserByField.mockResolvedValue([user({ isActive: false })]);
      await expect(service.refreshTokens({ refreshToken: out.refreshToken })).rejects.toMatchObject(
        {
          message: ERROR_MESSAGES.ACCOUNT_DEACTIVATED,
        },
      );
    });
  });

  describe('logout', () => {
    it('ends only the named session', async () => {
      userService.getUserByField.mockResolvedValue([user({ password: correctHash })]);
      const a = await service.loginService({ email: 'a@b.test', password: 'correct-password' });
      const b = await service.loginService({ email: 'a@b.test', password: 'correct-password' });
      const sidA = (jwt.decode(a.accessToken) as Record<string, string>).sid;

      await expect(service.logoutService({ userId: USER_ID, sid: sidA })).resolves.toEqual({
        message: 'Logged out',
      });
      expect(rmq.emit).toHaveBeenCalledWith('redis.del', {
        keys: [`session:${USER_ID}:${sidA}`, `refresh:${USER_ID}:${sidA}`],
      });
      expect(sessionKeys()).toHaveLength(1);
      expect(b.accessToken).toBeTruthy();
    });

    it('rejects a malformed user id or sid without touching Redis', async () => {
      await expect(service.logoutService({ userId: 'x', sid: 'y' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(rmq.emit).not.toHaveBeenCalled();
    });
  });

  describe('register', () => {
    it('lowercases the email and answers a duplicate with the generic error (no echo of the email)', async () => {
      userService.getUserByField.mockResolvedValueOnce([user()]);
      await expect(
        service.registerService({
          email: 'Student@Example.test',
          password: 'Abcdef1!',
          firstName: 'Ann',
          lastName: 'Le',
        } as never),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.ACCOUNT_ALREADY_EXISTS });
      expect(userService.createUserService).not.toHaveBeenCalled();
    });

    it('stores the verify token bound to the user id and email', async () => {
      userService.getUserByField
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([user({ emailVerified: false })]);
      await service.registerService({
        email: 'a@b.test',
        password: 'Abcdef1!',
        firstName: 'Ann',
        lastName: 'Le',
      } as never);
      const set = rmq.send.mock.calls.find(([p]) => p === 'redis.set');
      expect(JSON.parse((set![1] as { value: string }).value)).toEqual({
        userId: USER_ID,
        email: 'student@example.test',
      });
    });
  });

  describe('verifyEmail', () => {
    it('verifies when the token email still matches the account email', async () => {
      rmq.store.set(
        'verify-email:t1',
        JSON.stringify({ userId: USER_ID, email: 'student@example.test' }),
      );
      userService.getUserByField.mockResolvedValue([user()]);
      await expect(service.verifyEmailService({ jti: 't1' } as never)).resolves.toEqual({
        ok: true,
      });
      expect(userService.setEmailVerifiedService).toHaveBeenCalledWith({
        id: USER_ID,
        emailVerified: true,
      });
    });

    it('a verify link works once: a second use is rejected', async () => {
      rmq.store.set(
        'verify-email:t3',
        JSON.stringify({ userId: USER_ID, email: 'student@example.test' }),
      );
      userService.getUserByField.mockResolvedValue([user()]);
      await service.verifyEmailService({ jti: 't3' } as never);

      await expect(service.verifyEmailService({ jti: 't3' } as never)).rejects.toMatchObject({
        message: ERROR_MESSAGES.INVALID_VERIFY_EMAIL_TOKEN,
      });
    });

    it('rejects a token issued for an address the account no longer has', async () => {
      rmq.store.set('verify-email:t2', JSON.stringify({ userId: USER_ID, email: 'old@b.test' }));
      userService.getUserByField.mockResolvedValue([user()]);
      await expect(service.verifyEmailService({ jti: 't2' } as never)).rejects.toMatchObject({
        message: ERROR_MESSAGES.INVALID_VERIFY_EMAIL_TOKEN,
      });
      expect(userService.setEmailVerifiedService).not.toHaveBeenCalled();
    });
  });

  describe('forgot password', () => {
    it('answers the same way for a known and an unknown email', async () => {
      await expect(service.forgotPasswordService({ email: 'nobody@b.test' })).resolves.toEqual({
        ok: true,
      });
      userService.getUserByField.mockResolvedValue([user()]);
      await expect(
        service.forgotPasswordService({ email: 'student@example.test' }),
      ).resolves.toEqual({
        ok: true,
      });
    });
  });

  describe('forgot password quota', () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const mailsSent = () =>
      rmq.send.mock.calls.filter(([pattern]) => pattern === 'email.sendPasswordResetOtp').length;

    it('sends at most 3 reset codes per address per window, and answers the same each time', async () => {
      userService.getUserByField.mockResolvedValue([user()]);
      for (let i = 0; i < 5; i++) {
        await expect(
          service.forgotPasswordService({ email: 'Student@Example.test' }),
        ).resolves.toEqual({ ok: true });
        await flush();
      }
      expect(mailsSent()).toBe(3);
    });

    it('counts unknown addresses too, so the quota reveals nothing', async () => {
      for (let i = 0; i < 4; i++) {
        await service.forgotPasswordService({ email: 'nobody@b.test' });
      }
      expect(mailsSent()).toBe(0);
      const key = [...rmq.store.keys()].find((k) => k.startsWith('forgot-password-rate:'));
      expect(rmq.store.get(key as string)).toBe('4');
    });

    it('sends nothing when the counter is unavailable (fails closed)', async () => {
      userService.getUserByField.mockResolvedValue([user()]);
      const original = rmq.send.getMockImplementation()!;
      rmq.send.mockImplementation(async (pattern, payload) => {
        if (pattern === 'redis.incr') throw new Error('redis down');
        return original(pattern, payload);
      });
      await expect(
        service.forgotPasswordService({ email: 'student@example.test' }),
      ).resolves.toEqual({ ok: true });
      await flush();
      expect(mailsSent()).toBe(0);
    });
  });

  describe('reset password attempt cap', () => {
    const OTP = '111111';
    const putCode = (codeId: string) => {
      const salt = 'salt-' + codeId;
      rmq.store.set(
        `reset-password-otp:${USER_ID}`,
        JSON.stringify({
          codeId,
          salt,
          hash: createHash('sha256').update(`${salt}:${OTP}`).digest('hex'),
        }),
      );
    };
    const reset = (otp: string) =>
      service.resetPasswordService({
        email: 'student@example.test',
        otp,
        password: 'New-pass-1!',
        confirmPassword: 'New-pass-1!',
      });

    beforeEach(() => userService.getUserByField.mockResolvedValue([user()]));

    it('stops guessing after 10 tries in a window even when a fresh code is requested each time', async () => {
      for (let i = 0; i < 10; i++) {
        putCode(`code-${i}`); // what forgotPassword does: a new code with its own fresh counter
        await expect(reset('000000')).rejects.toThrow(BadRequestException);
      }
      putCode('code-final');
      await expect(reset(OTP)).rejects.toMatchObject({ status: 429 });
      expect(userService.updateUserPasswordService).not.toHaveBeenCalled();
    });

    it('accepts the right code within the cap and clears the window counter', async () => {
      putCode('code-ok');
      await expect(reset(OTP)).resolves.toEqual({ ok: true });
      expect(userService.updateUserPasswordService).toHaveBeenCalledTimes(1);
      expect(rmq.emit).toHaveBeenCalledWith('redis.del', {
        keys: [`reset-password-otp-window:${USER_ID}`],
      });
    });
  });

  describe('OAuth sign-in', () => {
    it('refuses to hand over an ADMIN/TUTOR/PARENT account with the generic credentials error', async () => {
      userService.getUserByField.mockResolvedValue([user({ role: 'TUTOR', emailVerified: false })]);
      await expect(
        service.googleLoginService({
          email: 'tutor@b.test',
          firstName: 'T',
          lastName: 'U',
        } as never),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.INVALID_CREDENTIALS });
      expect(userService.updateUserPasswordService).not.toHaveBeenCalled();
    });

    it('replaces the squatter password of an unverified STUDENT before issuing tokens', async () => {
      userService.getUserByField
        .mockResolvedValueOnce([user({ emailVerified: false })])
        .mockResolvedValueOnce([user({ emailVerified: false })]);
      await service.googleLoginService({
        email: 'student@example.test',
        firstName: 'A',
        lastName: 'B',
      } as never);
      expect(userService.updateUserPasswordService).toHaveBeenCalledWith(
        expect.objectContaining({ id: USER_ID }),
      );
      expect(userService.setEmailVerifiedService).toHaveBeenCalledWith({
        id: USER_ID,
        emailVerified: true,
      });
    });
  });
});
