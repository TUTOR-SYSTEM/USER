import { BadRequestException, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ERROR_MESSAGES } from 'src/data/constants';
import { hashData } from '@packages/helpers';
import { AuthService } from 'src/features/auth/auth.service';
import type { UserService } from 'src/features/user/user.service';
import type { RmqProducer } from 'src/features/rabbitmq/rmq.producer';

// user.service pulls in the Drizzle repository, which imports `@packages/database/schema`. The
// jest moduleNameMapper cannot resolve that alias, so stub the class (auth tests mock it anyway).
jest.mock('src/features/user/user.service', () => ({ UserService: class UserService {} }));

const USER_ID = '6f1c2b4e-9d3a-4c7e-8b21-0a1b2c3d4e5f';
const ACCESS_SECRET = 'test-access-secret';
const REFRESH_SECRET = 'test-refresh-secret';
const REFRESH_TTL = 3600;

const env: Record<string, string> = {
  JWT_ACCESS_SECRET: ACCESS_SECRET,
  JWT_REFRESH_SECRET: REFRESH_SECRET,
  JWT_ACCESS_EXPIRES_SECONDS: '900',
  JWT_REFRESH_EXPIRES_SECONDS: String(REFRESH_TTL),
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
    password: overrides.password ?? '',
    ...overrides,
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let jwtService: JwtService;
  let userService: {
    getUserByField: jest.Mock;
    createUserService: jest.Mock;
    updateUserPasswordService: jest.Mock;
  };
  let rmq: { send: jest.Mock; emit: jest.Mock };
  let correctPasswordHash: string;

  beforeAll(async () => {
    correctPasswordHash = await hashData('correct-password');
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jwtService = new JwtService({});
    userService = {
      getUserByField: jest.fn().mockResolvedValue([]),
      createUserService: jest.fn().mockResolvedValue({ message: 'ok', data: {} }),
      updateUserPasswordService: jest.fn(),
    };
    rmq = {
      send: jest.fn().mockResolvedValue(undefined),
      emit: jest.fn().mockResolvedValue(undefined),
    };
    const config = { get: (key: string) => env[key] } as unknown as ConfigService;
    service = new AuthService(
      userService as unknown as UserService,
      jwtService,
      rmq as unknown as RmqProducer,
      config,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('loginService', () => {
    it('returns signed access/refresh tokens and stores the refresh token as the session', async () => {
      userService.getUserByField.mockResolvedValue([buildUser({ password: correctPasswordHash })]);

      const result = await service.loginService({
        email: 'student@example.test',
        password: 'correct-password',
      } as never);

      expect(result.user).toEqual({
        id: USER_ID,
        email: 'student@example.test',
        userCode: 'ABC123',
        username: 'student1',
      });
      const access = jwtService.verify(result.accessToken, { secret: ACCESS_SECRET });
      expect(access).toMatchObject({ sub: USER_ID, role: 'STUDENT', typ: 'access' });
      const refresh = jwtService.verify(result.refreshToken, { secret: REFRESH_SECRET });
      expect(refresh).toMatchObject({ sub: USER_ID, typ: 'refresh' });

      expect(rmq.send).toHaveBeenCalledWith('redis.set', {
        key: `session:${USER_ID}`,
        value: result.refreshToken,
        ttlSeconds: REFRESH_TTL,
      });
    });

    it('rejects a wrong password with the generic invalid-credentials error and issues no tokens', async () => {
      userService.getUserByField.mockResolvedValue([buildUser({ password: correctPasswordHash })]);

      await expect(
        service.loginService({ email: 'student@example.test', password: 'wrong' } as never),
      ).rejects.toMatchObject({
        constructor: BadRequestException,
        message: ERROR_MESSAGES.INVALID_CREDENTIALS,
      });
      expect(rmq.send).not.toHaveBeenCalled();
    });

    it('rejects an unknown email with the same error as a wrong password (no account enumeration)', async () => {
      userService.getUserByField.mockResolvedValue([]);

      await expect(
        service.loginService({ email: 'nobody@example.test', password: 'whatever' } as never),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.INVALID_CREDENTIALS });
    });

    it('rejects a deactivated account even with the correct password', async () => {
      userService.getUserByField.mockResolvedValue([
        buildUser({ password: correctPasswordHash, isActive: false }),
      ]);

      await expect(
        service.loginService({
          email: 'student@example.test',
          password: 'correct-password',
        } as never),
      ).rejects.toMatchObject({
        constructor: UnauthorizedException,
        message: ERROR_MESSAGES.ACCOUNT_DEACTIVATED,
      });
      expect(rmq.send).not.toHaveBeenCalled();
    });

    it('still logs in when storing the session in Redis fails (fire-and-forget)', async () => {
      userService.getUserByField.mockResolvedValue([buildUser({ password: correctPasswordHash })]);
      rmq.send.mockRejectedValue(new Error('redis down'));

      const result = await service.loginService({
        email: 'student@example.test',
        password: 'correct-password',
      } as never);

      expect(result.accessToken).toEqual(expect.any(String));
    });
  });

  describe('loginByUserCodeService', () => {
    it('logs in the row whose role matches the requested role', async () => {
      userService.getUserByField.mockResolvedValue([
        buildUser({ role: 'PARENT', password: await hashData('other') }),
        buildUser({ role: 'STUDENT', password: correctPasswordHash }),
      ]);

      const result = await service.loginByUserCodeService({
        userCode: 'ABC123',
        role: 'STUDENT',
        password: 'correct-password',
      } as never);

      expect(result.user.id).toBe(USER_ID);
      expect(userService.getUserByField).toHaveBeenCalledWith({
        field: 'userCode',
        value: 'ABC123',
      });
    });

    it('rejects when no account with that code has the requested role', async () => {
      userService.getUserByField.mockResolvedValue([
        buildUser({ role: 'PARENT', password: correctPasswordHash }),
      ]);

      await expect(
        service.loginByUserCodeService({
          userCode: 'ABC123',
          role: 'TUTOR',
          password: 'correct-password',
        } as never),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.INVALID_CREDENTIALS });
    });

    it('rejects an unknown user code', async () => {
      userService.getUserByField.mockResolvedValue([]);

      await expect(
        service.loginByUserCodeService({
          userCode: 'ZZZZZZ',
          role: 'STUDENT',
          password: 'x',
        } as never),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.INVALID_CREDENTIALS });
    });
  });

  describe('refreshTokens', () => {
    function signRefresh(
      overrides: Record<string, unknown> = {},
      secret = REFRESH_SECRET,
      options = {},
    ) {
      return jwtService.sign(
        { sub: USER_ID, email: 'student@example.test', typ: 'refresh', ...overrides },
        { secret, expiresIn: 600, ...options },
      );
    }

    it('rotates the pair when the presented refresh token is the active session', async () => {
      const token = signRefresh();
      rmq.send.mockImplementation(async (pattern: string) => {
        if (pattern === 'redis.get') return token;
        return undefined;
      });
      userService.getUserByField.mockResolvedValue([buildUser()]);

      const result = await service.refreshTokens({ refreshToken: token } as never);

      expect(result.refreshToken).not.toBe('');
      expect(rmq.send).toHaveBeenCalledWith('redis.get', { key: `session:${USER_ID}` });
      expect(rmq.send).toHaveBeenCalledWith(
        'redis.set',
        expect.objectContaining({ key: `session:${USER_ID}`, value: result.refreshToken }),
      );
    });

    it('rejects a refresh token that has been rotated away or logged out', async () => {
      const token = signRefresh();
      rmq.send.mockImplementation(async (pattern: string) =>
        pattern === 'redis.get' ? null : undefined,
      );

      await expect(service.refreshTokens({ refreshToken: token } as never)).rejects.toMatchObject({
        constructor: UnauthorizedException,
        message: ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH_TOKEN,
      });
      expect(userService.getUserByField).not.toHaveBeenCalled();
    });

    it('rejects a stored session that holds a different refresh token', async () => {
      const token = signRefresh();
      rmq.send.mockImplementation(async (pattern: string) =>
        pattern === 'redis.get'
          ? signRefresh({ sub: USER_ID }, REFRESH_SECRET, { jwtid: 'other' })
          : undefined,
      );

      await expect(service.refreshTokens({ refreshToken: token } as never)).rejects.toMatchObject({
        message: ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH_TOKEN,
      });
    });

    it('rejects an expired refresh token', async () => {
      const expired = jwtService.sign(
        { sub: USER_ID, email: 'student@example.test', typ: 'refresh' },
        { secret: REFRESH_SECRET, expiresIn: -10 },
      );

      await expect(service.refreshTokens({ refreshToken: expired } as never)).rejects.toMatchObject(
        {
          constructor: UnauthorizedException,
          message: ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH_TOKEN,
        },
      );
      expect(rmq.send).not.toHaveBeenCalled();
    });

    it('rejects a token signed with the wrong secret', async () => {
      const forged = signRefresh({}, 'attacker-secret');

      await expect(service.refreshTokens({ refreshToken: forged } as never)).rejects.toMatchObject({
        message: ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH_TOKEN,
      });
    });

    it('rejects an access token presented as a refresh token', async () => {
      const access = jwtService.sign(
        { sub: USER_ID, email: 'student@example.test', role: 'ADMIN', typ: 'access' },
        { secret: ACCESS_SECRET, expiresIn: 600 },
      );

      await expect(service.refreshTokens({ refreshToken: access } as never)).rejects.toMatchObject({
        message: ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH_TOKEN,
      });
    });

    it('rejects a token signed with the refresh secret whose typ is not "refresh"', async () => {
      const wrongTyp = jwtService.sign(
        { sub: USER_ID, email: 'student@example.test', typ: 'access' },
        { secret: REFRESH_SECRET, expiresIn: 600 },
      );

      await expect(
        service.refreshTokens({ refreshToken: wrongTyp } as never),
      ).rejects.toMatchObject({
        message: ERROR_MESSAGES.INVALID_TOKEN_TYPE,
      });
    });

    it('rejects when the user has been deleted since the token was issued', async () => {
      const token = signRefresh();
      rmq.send.mockImplementation(async (pattern: string) =>
        pattern === 'redis.get' ? token : undefined,
      );
      userService.getUserByField.mockResolvedValue([]);

      await expect(service.refreshTokens({ refreshToken: token } as never)).rejects.toMatchObject({
        message: ERROR_MESSAGES.USER_NO_LONGER_EXISTS,
      });
    });

    it('fails open when the session lookup itself errors (documents current behaviour)', async () => {
      // Intentional per the code comment: a Redis/RMQ outage must not block auth. This test pins
      // that choice so a change is deliberate. See the report for the security trade-off.
      const token = signRefresh();
      rmq.send.mockImplementation(async (pattern: string) => {
        if (pattern === 'redis.get') throw new Error('rmq timeout');
        return undefined;
      });
      userService.getUserByField.mockResolvedValue([buildUser()]);

      const result = await service.refreshTokens({ refreshToken: token } as never);

      expect(result.accessToken).toEqual(expect.any(String));
    });
  });

  describe('refresh payload shape and password/logout branches', () => {
    const signRefreshPayload = (payload: Record<string, unknown> | string) =>
      jwtService.sign(payload as Record<string, unknown>, { secret: REFRESH_SECRET });

    it('rejects a refresh token whose verified payload is not an object', async () => {
      const token = signRefreshPayload('plain-string-payload');
      rmq.send.mockImplementation(async (pattern: string) =>
        pattern === 'redis.get' ? token : undefined,
      );

      await expect(service.refreshTokens({ refreshToken: token } as never)).rejects.toMatchObject({
        constructor: UnauthorizedException,
        message: ERROR_MESSAGES.INVALID_TOKEN_PAYLOAD,
      });
    });

    it.each([
      ['non-string sub', { sub: 42 }],
      ['non-string email', { email: 7 }],
    ])('rejects a refresh token with a %s', async (_label, overrides) => {
      const token = signRefreshPayload({
        sub: USER_ID,
        email: 'student@example.test',
        typ: 'refresh',
        ...overrides,
      });
      rmq.send.mockImplementation(async (pattern: string) =>
        pattern === 'redis.get' ? token : undefined,
      );

      await expect(service.refreshTokens({ refreshToken: token } as never)).rejects.toMatchObject({
        constructor: UnauthorizedException,
        message: ERROR_MESSAGES.INVALID_TOKEN_PAYLOAD,
      });
    });

    it('fails with FAILED_TO_UPDATE_PASSWORD when the user service returns no row', async () => {
      userService.getUserByField.mockResolvedValue([buildUser()]);
      userService.updateUserPasswordService.mockResolvedValue(undefined);

      await expect(
        service.updateUserPasswordService({ userId: USER_ID, password: 'New-pass-1' }),
      ).rejects.toMatchObject({
        constructor: BadRequestException,
        message: ERROR_MESSAGES.FAILED_TO_UPDATE_PASSWORD,
      });
    });

    it('still logs out when the best-effort Redis delete fails, and only warns', async () => {
      rmq.emit.mockRejectedValue(new Error('redis down'));
      const warn = jest.spyOn(Logger.prototype, 'warn');

      expect(service.logoutService({ id: USER_ID })).toEqual({ ok: true });

      await new Promise((resolve) => setImmediate(resolve));
      expect(warn).toHaveBeenCalledWith(
        `Failed to delete session for user ${USER_ID}`,
        expect.any(Error),
      );
    });
  });

  describe('remaining auth branches', () => {
    it('googleLoginService fails with FAILED_TO_CREATE_USER when the new account cannot be re-read', async () => {
      userService.getUserByField.mockResolvedValue([]);

      await expect(
        service.googleLoginService({
          email: 'new@example.test',
          firstName: 'New',
          lastName: 'User',
        } as never),
      ).rejects.toMatchObject({
        constructor: BadRequestException,
        message: ERROR_MESSAGES.FAILED_TO_CREATE_USER,
      });
      expect(userService.createUserService).toHaveBeenCalledTimes(1);
    });

    it('registerService drops a whitespace-only username so it is stored as unset', async () => {
      userService.getUserByField
        .mockResolvedValueOnce([]) // email is free
        .mockResolvedValueOnce([]) // blank username lookup
        .mockResolvedValueOnce([buildUser()]); // re-read after create

      await service.registerService({
        email: 'tutor@example.test',
        username: '   ',
        password: 'Abcdef1!',
        firstName: 'Ann',
        lastName: 'Le',
      } as never);

      expect(userService.createUserService).toHaveBeenCalledWith(
        expect.objectContaining({ username: undefined, role: 'TUTOR' }),
      );
    });
  });

  describe('logoutService', () => {
    it('deletes the session key for a valid user id', () => {
      const result = service.logoutService({ id: USER_ID });

      expect(result).toEqual({ ok: true });
      expect(rmq.emit).toHaveBeenCalledWith('redis.del', { keys: [`session:${USER_ID}`] });
    });

    it.each([
      ['missing id', {}],
      ['empty id', { id: '' }],
      ['non-uuid id', { id: 'not-a-uuid' }],
    ])('rejects %s without touching Redis', (_label, user) => {
      expect(() => service.logoutService(user as Record<string, string>)).toThrow(
        ERROR_MESSAGES.INVALID_USER_ID,
      );
      expect(rmq.emit).not.toHaveBeenCalled();
    });
  });

  describe('registerService', () => {
    const dto = {
      email: 'tutor@example.test',
      username: '  tutor1  ',
      password: 'Sup3r-secret',
      firstName: 'Bao',
      lastName: 'Tran',
    };

    it('creates a TUTOR with a trimmed username and returns the public fields', async () => {
      userService.getUserByField
        .mockResolvedValueOnce([]) // email free
        .mockResolvedValueOnce([]) // username free
        .mockResolvedValueOnce([
          buildUser({ id: USER_ID, email: dto.email, username: 'tutor1', role: 'TUTOR' }),
        ]);

      const result = await service.registerService(dto as never);

      expect(userService.createUserService).toHaveBeenCalledWith(
        expect.objectContaining({ email: dto.email, username: 'tutor1', role: 'TUTOR' }),
      );
      expect(result.user).toEqual({
        id: USER_ID,
        email: dto.email,
        username: 'tutor1',
        firstName: 'Ann',
        lastName: 'Le',
      });
    });

    it('rejects an email that is already registered', async () => {
      userService.getUserByField.mockResolvedValueOnce([buildUser()]);

      await expect(service.registerService(dto as never)).rejects.toMatchObject({
        message: ERROR_MESSAGES.EMAIL_EXISTS,
      });
      expect(userService.createUserService).not.toHaveBeenCalled();
    });

    it('rejects a username that is already taken', async () => {
      userService.getUserByField.mockResolvedValueOnce([]).mockResolvedValueOnce([buildUser()]);

      await expect(service.registerService(dto as never)).rejects.toMatchObject({
        message: ERROR_MESSAGES.USERNAME_EXISTS,
      });
      expect(userService.createUserService).not.toHaveBeenCalled();
    });

    it('fails when the created row cannot be read back', async () => {
      userService.getUserByField.mockResolvedValue([]);

      await expect(service.registerService(dto as never)).rejects.toMatchObject({
        message: ERROR_MESSAGES.FAILED_TO_CREATE_USER,
      });
    });
  });

  describe('OAuth login (google / facebook)', () => {
    const profile = { email: 'oauth@example.test', firstName: 'Cam', lastName: 'Vo' };

    it('signs in an existing user without creating a new account', async () => {
      userService.getUserByField.mockResolvedValue([buildUser({ email: profile.email })]);

      const result = await service.googleLoginService(profile as never);

      expect(userService.createUserService).not.toHaveBeenCalled();
      expect(result.user.id).toBe(USER_ID);
    });

    it('auto-registers an unknown email as STUDENT with a random password, then signs in', async () => {
      userService.getUserByField
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([buildUser({ email: profile.email })]);

      const result = await service.facebookLoginService(profile as never);

      expect(userService.createUserService).toHaveBeenCalledWith(
        expect.objectContaining({ email: profile.email, role: 'STUDENT', firstName: 'Cam' }),
      );
      const createdPassword = userService.createUserService.mock.calls[0][0].password as string;
      expect(createdPassword).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.user.email).toBe(profile.email);
    });
  });

  describe('forgot / reset password', () => {
    it('returns ok for an unknown email and sends nothing', async () => {
      userService.getUserByField.mockResolvedValue([]);

      await expect(
        service.forgotPasswordService({ email: 'nobody@example.test' } as never),
      ).resolves.toEqual({
        ok: true,
      });
      expect(rmq.send).not.toHaveBeenCalled();
    });

    it('stores a 5-minute reset token in Redis and asks the mailer to send it', async () => {
      userService.getUserByField.mockResolvedValue([buildUser()]);

      await service.forgotPasswordService({ email: 'student@example.test' } as never);

      expect(rmq.send).toHaveBeenCalledWith(
        'redis.set',
        expect.objectContaining({ value: USER_ID, ttlSeconds: 300 }),
      );
      const jti = rmq.send.mock.calls[0][1].key.replace('reset-password:', '');
      expect(rmq.send).toHaveBeenCalledWith('email.sendForgotPasswordMail', {
        to: 'student@example.test',
        resetToken: jti,
        displayName: 'Ann',
      });
    });

    it('resets the password when the reset token resolves to a user', async () => {
      rmq.send.mockResolvedValue(USER_ID);
      userService.getUserByField.mockResolvedValue([buildUser()]);
      userService.updateUserPasswordService.mockResolvedValue({ id: USER_ID });

      await expect(
        service.resetPasswordService({ jti: 'token-1', password: 'New-pass-1' } as never),
      ).resolves.toEqual({ ok: true });

      expect(userService.updateUserPasswordService).toHaveBeenCalledWith({
        id: USER_ID,
        password: 'New-pass-1',
      });
      expect(rmq.emit).toHaveBeenCalledWith('redis.del', { keys: ['reset-password:token-1'] });
    });

    it('rejects an unknown or expired reset token without changing the password', async () => {
      rmq.send.mockResolvedValue(null);

      await expect(
        service.resetPasswordService({ jti: 'expired', password: 'New-pass-1' } as never),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.INVALID_RESET_PASSWORD_TOKEN });
      expect(userService.updateUserPasswordService).not.toHaveBeenCalled();
    });

    it('rejects when the token points at a user that no longer exists', async () => {
      rmq.send.mockResolvedValue(USER_ID);
      userService.getUserByField.mockResolvedValue([]);

      await expect(
        service.resetPasswordService({ jti: 'token-2', password: 'New-pass-1' } as never),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.USER_NOT_FOUND });
      expect(userService.updateUserPasswordService).not.toHaveBeenCalled();
    });
  });
});
