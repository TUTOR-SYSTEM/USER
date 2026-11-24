import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ERROR_MESSAGES } from 'src/data/constants';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@packages/entities/user';
import type {
  ForgotPasswordDto,
  ForgotPasswordResponseDto,
  LoginByUserCodeDto,
  LoginDto,
  LoginResponseDto,
  RefreshTokenBodyDto,
  RegisterDto,
  RegisterResponseDto,
  ResetPasswordDto,
  ResetPasswordResponseDto,
  VerifyEmailDto,
  VerifyEmailResponseDto,
} from '@packages/entities/auth';
import {
  compareData,
  hashData,
  hashRefreshToken,
  refreshHashRedisKey,
  revokedAllRedisKey,
  revokedSessionRedisKey,
  safeEqualHex,
  SESSION_REVOKED_MARKER_TTL_SECONDS,
  sessionRedisKey,
  signAccessToken,
  signRefreshToken,
  type JwtRefreshPayload,
  type JwtTokensConfig,
  type JwtUserRole,
} from '@packages/helpers';
import { UserService } from '../user/user.service';
import { getJwtTokensConfig } from '@packages/configs/jwt-sign.config';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { checkUuidValid } from '@packages/helpers';
import type { FacebookProfile, GoogleProfile } from '@packages/strategy';
import { RmqProducer } from '../rabbitmq/rmq.producer';

/** How long a password-reset code stays valid — matches the copy in the reset email. */
const RESET_PASSWORD_OTP_TTL_SECONDS = 300;
/** Wrong guesses allowed per issued code before it is burned and the user must request a new one. */
const RESET_PASSWORD_OTP_MAX_ATTEMPTS = 5;
const resetPasswordOtpRedisKey = (userId: string) => `reset-password-otp:${userId}`;
const resetPasswordOtpAttemptsRedisKey = (userId: string, codeId: string) =>
  `reset-password-otp-attempts:${userId}:${codeId}`;
/**
 * Guesses allowed per account per hour across ALL codes. The per-code limit alone can be reset by
 * requesting a new code, so this one is what actually bounds brute force of the 6-digit code.
 */
const RESET_PASSWORD_OTP_MAX_ATTEMPTS_PER_WINDOW = 10;
const RESET_PASSWORD_WINDOW_SECONDS = 3600;
const resetPasswordOtpWindowRedisKey = (userId: string) => `reset-password-otp-window:${userId}`;
/** Reset codes sent per address per hour. Counted for unknown addresses too, so it reveals nothing. */
const FORGOT_PASSWORD_MAX_REQUESTS_PER_WINDOW = 3;
const forgotPasswordRateRedisKey = (email: string) =>
  `forgot-password-rate:${createHash('sha256').update(email).digest('hex')}`;

/** How long an email-verification link stays valid. */
const VERIFY_EMAIL_TOKEN_TTL_SECONDS = 86400;
const verifyEmailRedisKey = (jti: string) => `verify-email:${jti}`;

/** Failed sign-ins allowed per account inside one window before the account is locked. */
const LOGIN_MAX_ATTEMPTS_DEFAULT = 5;
/**
 * Failed sign-ins per account across all IPs in one window. Higher than the per-(IP, account) limit,
 * so a single IP is still locked fast while distributed guessing hits a ceiling (#4).
 */
const LOGIN_ACCOUNT_MAX_ATTEMPTS_DEFAULT = 20;
/** The account part of a lockout identifier (`account|ip:<ip>` → `account`). */
const accountOf = (identifier: string): string => identifier.split('|ip:')[0];
/** Length of the failure window, counted from the first failed attempt (the lock lifts after it). */
const LOGIN_ATTEMPT_WINDOW_SECONDS_DEFAULT = 900;
/**
 * Lockout is counted per (client IP, account). One IP cannot lock an account for every other IP,
 * so an attacker who floods one account from their own address locks only themselves out. A missing
 * IP (no gateway forwarding) falls into one shared bucket, which stays strict rather than open.
 */
const lockoutIdentifier = (account: string, clientIp?: string): string =>
  `${account}|ip:${clientIp?.trim() || 'unknown'}`;

/** Hashed identifier: the Redis key never holds the email, user code or IP in plain text. */
const loginFailureRedisKey = (identifier: string) =>
  `login-fail:${createHash('sha256').update(identifier).digest('hex')}`;

/** Redis round-trip budget for session/token reads: one short retry, then fail. */
const REDIS_READ_TIMEOUT_MS = 2_000;
const REDIS_READ_RETRIES = 1;

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const positiveIntOr = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** Stored behind a reset code. Only the salted hash is kept; `codeId` scopes the attempt counter. */
type ResetPasswordOtpRecord = { codeId: string; salt: string; hash: string };

function hashResetOtp(salt: string, otp: string): string {
  return createHash('sha256').update(`${salt}:${otp}`).digest('hex');
}

function parseResetOtpRecord(raw: string | null): ResetPasswordOtpRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ResetPasswordOtpRecord>;
    if (
      typeof value.codeId === 'string' &&
      typeof value.salt === 'string' &&
      typeof value.hash === 'string'
    ) {
      return { codeId: value.codeId, salt: value.salt, hash: value.hash };
    }
  } catch {
    // Corrupted record: treated as an expired code.
  }
  return null;
}

/** Payload stored behind a verify-email token: the email is bound so a later change invalidates it. */
type VerifyEmailToken = { userId: string; email: string };

function parseVerifyEmailToken(raw: string | null): VerifyEmailToken | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<VerifyEmailToken>;
    if (typeof value.userId === 'string' && typeof value.email === 'string') {
      return { userId: value.userId, email: value.email };
    }
  } catch {
    // Not in the current format (or corrupted): treated as invalid below.
  }
  return null;
}

function parseRefreshTokenPayload(value: unknown): JwtRefreshPayload {
  if (typeof value !== 'object' || value === null) {
    throw new UnauthorizedException(ERROR_MESSAGES.INVALID_TOKEN_PAYLOAD);
  }
  const record = value as Record<string, unknown>;
  if (record.typ !== 'refresh') {
    throw new UnauthorizedException(ERROR_MESSAGES.INVALID_TOKEN_TYPE);
  }
  if (typeof record.sub !== 'string' || typeof record.email !== 'string') {
    throw new UnauthorizedException(ERROR_MESSAGES.INVALID_TOKEN_PAYLOAD);
  }
  // Tokens minted before sessions existed carry no `sid`: they cannot be revoked, so they are refused.
  if (typeof record.sid !== 'string' || !checkUuidValid({ data: record.sid })) {
    throw new UnauthorizedException(ERROR_MESSAGES.INVALID_SESSION);
  }
  return {
    sub: record.sub,
    email: record.email,
    typ: 'refresh',
    sid: record.sid,
    jti: typeof record.jti === 'string' ? record.jti : '',
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwtTokensConfig: JwtTokensConfig;
  private readonly loginMaxAttempts: number;
  private readonly loginAccountMaxAttempts: number;
  private readonly loginAttemptWindowSeconds: number;
  private dummyHash?: Promise<string>;
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly rmqProducer: RmqProducer,
    private readonly configService: ConfigService,
  ) {
    this.jwtTokensConfig = getJwtTokensConfig(configService);
    this.loginMaxAttempts = positiveIntOr(
      configService.get<string>('LOGIN_MAX_ATTEMPTS'),
      LOGIN_MAX_ATTEMPTS_DEFAULT,
    );
    this.loginAccountMaxAttempts = positiveIntOr(
      configService.get<string>('LOGIN_ACCOUNT_MAX_ATTEMPTS'),
      LOGIN_ACCOUNT_MAX_ATTEMPTS_DEFAULT,
    );
    this.loginAttemptWindowSeconds = positiveIntOr(
      configService.get<string>('LOGIN_ATTEMPT_WINDOW_SECONDS'),
      LOGIN_ATTEMPT_WINDOW_SECONDS_DEFAULT,
    );
  }

  /**
   * Per-account lockout (M-USER-3): a password guessed through many IPs still hits one counter.
   * Runs before the account lookup, so a locked identifier gets the same answer whether or not an
   * account exists. Fails open when Redis cannot be read: a login cannot finish without Redis
   * anyway, since the session is stored there.
   */
  private async assertLoginNotLocked(identifier: string): Promise<void> {
    // Two counters: (IP, account) with the normal limit, and the account alone with a higher one.
    // The account-wide counter stops one account being guessed from many IPs (#4).
    const checks = [
      { key: loginFailureRedisKey(identifier), max: this.loginMaxAttempts },
      {
        key: loginFailureRedisKey(accountOf(identifier)),
        max: this.loginAccountMaxAttempts,
      },
    ];
    for (const { key, max } of checks) {
      let failures: string | null;
      try {
        failures = await this.rmqProducer.send<string | null, { key: string }>(
          'redis.get',
          { key },
          REDIS_READ_TIMEOUT_MS,
          REDIS_READ_RETRIES,
        );
      } catch (error) {
        this.logger.warn('Login lockout check unavailable', error);
        return;
      }
      if (Number(failures ?? 0) >= max) {
        const remainingSeconds = await this.getLoginLockRemainingSeconds(key);
        const minutes = Math.max(1, Math.ceil(remainingSeconds / 60));
        throw new HttpException(
          `${ERROR_MESSAGES.TOO_MANY_LOGIN_ATTEMPTS}: ${minutes} phút`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  /**
   * How long the caller still has to wait before the lock lifts, in seconds. Best effort: Redis
   * `TTL` returns `-1` (no expiry) / `-2` (key already gone), and an unreachable Redis must not
   * turn the 429 into a 500, so fall back to the full window.
   */
  private async getLoginLockRemainingSeconds(key: string): Promise<number> {
    try {
      const ttl = await this.rmqProducer.send<number, { key: string }>(
        'redis.ttl',
        { key },
        REDIS_READ_TIMEOUT_MS,
        REDIS_READ_RETRIES,
      );
      if (Number.isFinite(ttl) && ttl > 0) {
        return ttl;
      }
    } catch (error) {
      this.logger.warn('Login lockout TTL unavailable', error);
    }
    return this.loginAttemptWindowSeconds;
  }

  /** Counts one failed sign-in in the window that starts at the first failure (atomic on Redis). */
  private async recordLoginFailure(identifier: string): Promise<void> {
    try {
      // No retry: a retried INCR after a lost reply would count the same failed sign-in twice.
      for (const key of [
        loginFailureRedisKey(identifier),
        loginFailureRedisKey(accountOf(identifier)),
      ]) {
        await this.rmqProducer.send(
          'redis.incr',
          { key, windowSeconds: this.loginAttemptWindowSeconds },
          REDIS_READ_TIMEOUT_MS,
          0,
        );
      }
    } catch (error) {
      this.logger.warn('Failed to record a failed sign-in', error);
    }
  }

  /** A successful sign-in clears the counter. Best effort: a missed delete only leaves the window. */
  private clearLoginFailures(identifier: string): void {
    this.rmqProducer
      .emit('redis.del', { keys: [loginFailureRedisKey(identifier)] })
      .catch((error: unknown) => this.logger.warn('Failed to clear login failures', error));
  }

  /** `verifyCredentials` plus the lockout bookkeeping: failures are counted, success clears them. */
  private async verifyCredentialsWithLockout(
    identifier: string,
    user: User | undefined,
    password: string,
    notFoundCode?: string,
  ): Promise<User> {
    let verified: User;
    try {
      verified = await this.verifyCredentials(user, password, notFoundCode);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        await this.recordLoginFailure(identifier);
      }
      throw error;
    }
    this.clearLoginFailures(identifier);
    return verified;
  }

  /**
   * Each failure has its own code so the client can tell the user what to fix. An unknown
   * account still runs a bcrypt compare against a dummy hash, so the response time does not
   * reveal whether the account exists.
   */
  private async verifyCredentials(
    user: User | undefined,
    password: string,
    notFoundCode: string = ERROR_MESSAGES.EMAIL_NOT_FOUND,
  ): Promise<User> {
    if (!user) {
      await compareData(password, await (this.dummyHash ??= hashData('dummy-password')));
      throw new UnauthorizedException(notFoundCode);
    }
    if (!user.password) throw new UnauthorizedException(ERROR_MESSAGES.ACCOUNT_NO_PASSWORD);
    if (!(await compareData(password, user.password))) {
      throw new UnauthorizedException(ERROR_MESSAGES.INVALID_PASSWORD);
    }
    return user;
  }

  /**
   * Signs an access/refresh pair bound to `sid` and stores the session in Redis. Both keys are
   * awaited: a token must never be handed out for a session that did not get recorded.
   */
  private async issueTokens(user: User, sid: string): Promise<LoginResponseDto> {
    const payload = { sub: user.id, email: user.email, role: user.role as JwtUserRole };
    const [accessToken, refreshToken] = await Promise.all([
      signAccessToken(this.jwtService, { ...payload, sid }, this.jwtTokensConfig),
      signRefreshToken(
        this.jwtService,
        { sub: user.id, email: user.email, sid },
        this.jwtTokensConfig,
      ),
    ]);

    const ttlSeconds = this.jwtTokensConfig.refreshExpiresIn;
    await this.rmqProducer.send('redis.set', {
      key: sessionRedisKey(user.id, sid),
      value: '1',
      ttlSeconds,
    });
    await this.rmqProducer.send('redis.set', {
      key: refreshHashRedisKey(user.id, sid),
      value: hashRefreshToken(refreshToken),
      ttlSeconds,
    });

    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, userCode: user.userCode, username: user.username },
    };
  }

  /** A fresh login always opens a new session; other devices stay signed in. */
  private async issueLoginResponse(user: User): Promise<LoginResponseDto> {
    if (user.isActive === false) {
      throw new UnauthorizedException(ERROR_MESSAGES.ACCOUNT_DEACTIVATED);
    }
    return this.issueTokens(user, randomUUID());
  }

  /** Deletes one session (both keys). Awaited: a logout must not be reported before it lands. */
  private async revokeSession(userId: string, sid: string): Promise<void> {
    // Marker before the delete, so an in-flight refresh of this session that writes after it is caught.
    await this.rmqProducer.send('redis.set', {
      key: revokedSessionRedisKey(userId, sid),
      value: String(Date.now()),
      ttlSeconds: SESSION_REVOKED_MARKER_TTL_SECONDS,
    });
    await this.rmqProducer.emit('redis.del', {
      keys: [sessionRedisKey(userId, sid), refreshHashRedisKey(userId, sid)],
    });
  }

  /**
   * Sends the sign-up verification mail. Best-effort: the account is already created, so a
   * Redis/RabbitMQ/mail failure is only logged and never fails registration.
   */
  private async sendVerifyEmail(user: {
    id: string;
    email: string;
    firstName: string;
  }): Promise<void> {
    try {
      const jti = randomUUID();
      await this.rmqProducer.send('redis.set', {
        key: verifyEmailRedisKey(jti),
        value: JSON.stringify({ userId: user.id, email: user.email } satisfies VerifyEmailToken),
        ttlSeconds: VERIFY_EMAIL_TOKEN_TTL_SECONDS,
      });
      await this.rmqProducer.send('email.sendVerifyEmail', {
        to: user.email,
        verifyToken: jti,
        displayName: user.firstName,
      });
    } catch (error: unknown) {
      this.logger.warn(`Failed to send verification email to user ${user.id}`, error);
    }
  }

  /**
   * Finds the user by email or auto-registers them as STUDENT (Google/Facebook sign-in). An
   * existing account is only reused when it is a STUDENT: social sign-in must never hand over an
   * ADMIN/TUTOR/PARENT account that happens to share the provider's email. The refusal uses the
   * generic credentials error so it does not reveal that the account exists or its role.
   *
   * Pre-hijack guard: an existing STUDENT whose email was never verified may have been registered
   * by someone else with that email. The provider has now proven ownership of the email, so the
   * stored password is replaced with a random one (the squatter's credentials stop working and
   * their live sessions are revoked) before the account is handed over.
   */
  private async findOrCreateOAuthUser(profile: {
    email: string;
    firstName: string;
    lastName: string;
  }): Promise<User> {
    const email = normalizeEmail(profile.email);
    const [existing] = await this.userService.getUserByField({ field: 'email', value: email });
    if (existing) {
      if (existing.role !== 'STUDENT') {
        throw new UnauthorizedException(ERROR_MESSAGES.INVALID_CREDENTIALS);
      }
      if (existing.emailVerified) return existing;

      await this.userService.updateUserPasswordService({
        id: existing.id,
        password: randomUUID(),
      });
      await this.userService.setEmailVerifiedService({ id: existing.id, emailVerified: true });
      return { ...existing, emailVerified: true };
    }

    await this.userService.createUserService(
      {
        email,
        password: randomUUID(),
        firstName: profile.firstName,
        lastName: profile.lastName,
        role: 'STUDENT',
      },
      { emailVerified: true },
    );
    const [created] = await this.userService.getUserByField({ field: 'email', value: email });
    if (!created) throw new BadRequestException(ERROR_MESSAGES.FAILED_TO_CREATE_USER);
    return created;
  }

  /** Public registration always creates a STUDENT. TUTOR/ADMIN accounts are created by an admin. */
  async registerService(registerDto: RegisterDto): Promise<RegisterResponseDto> {
    const { username, password, firstName, lastName } = registerDto;
    const email = normalizeEmail(registerDto.email);

    const checkUserWithEmail = await this.userService.getUserByField({
      field: 'email',
      value: email,
    });
    if (Array.isArray(checkUserWithEmail) && checkUserWithEmail.length > 0) {
      throw new BadRequestException(ERROR_MESSAGES.ACCOUNT_ALREADY_EXISTS);
    }

    const checkUserWithUsername =
      username &&
      (await this.userService.getUserByField({
        field: 'username',
        value: username?.trim(),
      }));
    if (Array.isArray(checkUserWithUsername) && checkUserWithUsername.length > 0) {
      throw new BadRequestException(ERROR_MESSAGES.ACCOUNT_ALREADY_EXISTS);
    }

    await this.userService.createUserService({
      email,
      username: username?.trim() || undefined,
      password,
      firstName,
      lastName,
      role: 'STUDENT',
    });

    const createdRows = await this.userService.getUserByField({ field: 'email', value: email });
    const createdUser = createdRows[0];
    if (!createdUser) {
      throw new BadRequestException(ERROR_MESSAGES.FAILED_TO_CREATE_USER);
    }

    await this.sendVerifyEmail(createdUser);

    return {
      user: {
        id: createdUser.id,
        email: createdUser.email,
        username: createdUser.username,
        firstName: createdUser.firstName,
        lastName: createdUser.lastName,
      },
    };
  }

  async loginService(loginDto: LoginDto, clientIp?: string): Promise<LoginResponseDto> {
    const email = normalizeEmail(loginDto.email);
    const identifier = lockoutIdentifier(`email:${email}`, clientIp);
    await this.assertLoginNotLocked(identifier);

    const [found] = await this.userService.getUserByField({
      field: 'email',
      value: email,
    });
    const user = await this.verifyCredentialsWithLockout(identifier, found, loginDto.password);

    return this.issueLoginResponse(user);
  }

  // TODO: login with userCode + password ...
  async loginByUserCodeService(
    dto: LoginByUserCodeDto,
    clientIp?: string,
  ): Promise<LoginResponseDto> {
    const identifier = lockoutIdentifier(`userCode:${dto.userCode}`, clientIp);
    await this.assertLoginNotLocked(identifier);

    const rows = await this.userService.getUserByField({
      field: 'userCode',
      value: dto.userCode,
    });

    const found = rows.find((u) => u.role === dto.role);
    const user = await this.verifyCredentialsWithLockout(
      identifier,
      found,
      dto.password,
      ERROR_MESSAGES.USER_CODE_NOT_FOUND,
    );

    return this.issueLoginResponse(user);
  }

  // TODO: login with google account ...
  async facebookLoginService(profile: FacebookProfile): Promise<LoginResponseDto> {
    return this.issueLoginResponse(await this.findOrCreateOAuthUser(profile));
  }

  async googleLoginService(profile: GoogleProfile): Promise<LoginResponseDto> {
    return this.issueLoginResponse(await this.findOrCreateOAuthUser(profile));
  }

  // Reset flow = a 6-digit one-time code. Only a salted hash is stored in third-service's Redis
  // (userId key, 5 min TTL); the plain code exists only in the email third-service sends.
  async forgotPasswordService(
    forgotPasswordDto: ForgotPasswordDto,
  ): Promise<ForgotPasswordResponseDto> {
    const email = normalizeEmail(forgotPasswordDto.email);
    const [user] = await this.userService.getUserByField({ field: 'email', value: email });
    // Counted for every address (known or not) so the quota itself reveals nothing, and over-quota
    // requests get the same answer as accepted ones.
    const withinQuota = await this.takeForgotPasswordSlot(email);
    // Same response, same timing, whether or not the email exists: the mail is sent in the
    // background so a registered address does not answer more slowly than an unknown one.
    if (user && withinQuota) {
      this.sendPasswordResetOtp(user).catch((error: unknown) =>
        this.logger.warn(`Failed to send reset code to user ${user.id}`, error),
      );
    }

    return { ok: true };
  }

  /** Counts one reset-code request for this address. Fails closed: no count, no mail. */
  private async takeForgotPasswordSlot(email: string): Promise<boolean> {
    try {
      const { count } = await this.rmqProducer.send<
        { count: number },
        { key: string; windowSeconds: number }
      >(
        'redis.incr',
        { key: forgotPasswordRateRedisKey(email), windowSeconds: RESET_PASSWORD_WINDOW_SECONDS },
        REDIS_READ_TIMEOUT_MS,
        0,
      );
      if (count > FORGOT_PASSWORD_MAX_REQUESTS_PER_WINDOW) {
        this.logger.warn('Password reset requests over quota for one address');
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn('Reset request counter unavailable', error);
      return false;
    }
  }

  /**
   * Issues a new code, replacing any previous one (so only the latest email works). The stored
   * record carries its own `codeId`, so the attempt counter of an old code never affects a new one.
   */
  private async sendPasswordResetOtp(user: { id: string; email: string; firstName: string }) {
    const otp = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    const record: ResetPasswordOtpRecord = {
      codeId: randomUUID(),
      salt,
      hash: hashResetOtp(salt, otp),
    };

    await this.rmqProducer.send('redis.set', {
      key: resetPasswordOtpRedisKey(user.id),
      value: JSON.stringify(record),
      ttlSeconds: RESET_PASSWORD_OTP_TTL_SECONDS,
    });

    await this.rmqProducer.send('email.sendPasswordResetOtp', {
      to: user.email,
      otp,
      displayName: user.firstName,
    });
  }

  async resetPasswordService(
    resetPasswordDto: ResetPasswordDto,
  ): Promise<ResetPasswordResponseDto> {
    const [user] = await this.userService.getUserByField({
      field: 'email',
      value: normalizeEmail(resetPasswordDto.email),
    });
    // Unknown email, deactivated account and wrong code give the same answer, so the endpoint does
    // not reveal accounts, and a deactivated account cannot reset its way back in.
    if (!user || user.isActive === false) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_RESET_OTP);
    }

    const key = resetPasswordOtpRedisKey(user.id);
    const raw = await this.redisGet(key);
    const record = parseResetOtpRecord(raw);
    if (!record) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_RESET_OTP);
    }

    // Account-wide cap first: requesting a fresh code resets the per-code counter below, but not this.
    const windowAttempts = await this.countResetAttempt(
      resetPasswordOtpWindowRedisKey(user.id),
      RESET_PASSWORD_WINDOW_SECONDS,
    );
    if (windowAttempts > RESET_PASSWORD_OTP_MAX_ATTEMPTS_PER_WINDOW) {
      throw new HttpException(
        ERROR_MESSAGES.RESET_OTP_TOO_MANY_ATTEMPTS,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // Count every guess against this code before comparing, so brute force stops after the limit.
    const attempts = await this.recordResetOtpAttempt(user.id, record.codeId);
    if (attempts > RESET_PASSWORD_OTP_MAX_ATTEMPTS) {
      throw new HttpException(
        ERROR_MESSAGES.RESET_OTP_TOO_MANY_ATTEMPTS,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!safeEqualHex(record.hash, hashResetOtp(record.salt, resetPasswordDto.otp))) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_RESET_OTP);
    }

    // Single use: GETDEL returns the stored record only to the one request that removes it. If a
    // newer code replaced it in between, that new code is the one that was just burned.
    const consumed = await this.redisGetAndDelete(key);
    if (consumed !== raw) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_RESET_OTP);
    }

    await this.updateUserPasswordService({ userId: user.id, password: resetPasswordDto.password });
    const userId = user.id;
    // Entering the code from the reset email proves the user controls the mailbox.
    await this.userService.setEmailVerifiedService({ id: userId, emailVerified: true });
    // Best effort: a missed delete only leaves the counter to expire on its own.
    this.rmqProducer
      .emit('redis.del', { keys: [resetPasswordOtpWindowRedisKey(userId)] })
      .catch((error: unknown) => this.logger.warn('Failed to clear reset attempts', error));

    return { ok: true };
  }

  async verifyEmailService(dto: VerifyEmailDto): Promise<VerifyEmailResponseDto> {
    // Single use: GETDEL consumes the token in the same step that reads it, so a replayed link
    // finds nothing (the earlier fire-and-forget delete left a window for reuse).
    const token = parseVerifyEmailToken(await this.redisGetAndDelete(verifyEmailRedisKey(dto.jti)));
    if (!token) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_VERIFY_EMAIL_TOKEN);
    }

    // The token is for the address it was issued to. If the account's email changed since, the
    // link no longer proves anything about the current address.
    const [user] = await this.userService.getUserByField({ field: 'id', value: token.userId });
    if (!user || user.email !== token.email || user.isActive === false) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_VERIFY_EMAIL_TOKEN);
    }

    await this.userService.setEmailVerifiedService({ id: token.userId, emailVerified: true });

    return { ok: true };
  }

  async updateUserPasswordService({ userId, password }: { userId: string; password: string }) {
    const user = await this.userService.getUserByField({
      field: 'id',
      value: userId,
    });

    if (!Array.isArray(user) || user.length === 0) {
      throw new BadRequestException(ERROR_MESSAGES.USER_NOT_FOUND);
    }

    const updatedUser = await this.userService.updateUserPasswordService({
      id: userId,
      password,
    });
    if (!updatedUser) {
      throw new BadRequestException(ERROR_MESSAGES.FAILED_TO_UPDATE_PASSWORD);
    }
    return updatedUser;
  }

  /**
   * Reads a value the refresh/reset/verify flows depend on. Unlike the best-effort cleanups, a
   * Redis/RMQ failure here is final: 503 instead of guessing.
   */
  private async redisGet(key: string): Promise<string | null> {
    try {
      return await this.rmqProducer.send<string | null, { key: string }>(
        'redis.get',
        { key },
        REDIS_READ_TIMEOUT_MS,
        REDIS_READ_RETRIES,
      );
    } catch (error) {
      this.logger.warn(`Redis read failed for ${key}`, error);
      throw new ServiceUnavailableException(ERROR_MESSAGES.SESSION_CHECK_UNAVAILABLE);
    }
  }

  /**
   * Counts one guess against the current reset code (atomic INCR, window = code TTL). Fails closed:
   * if the counter cannot be updated the guess is refused, since a guess that is not counted could
   * be brute-forced.
   */
  private recordResetOtpAttempt(userId: string, codeId: string): Promise<number> {
    return this.countResetAttempt(
      resetPasswordOtpAttemptsRedisKey(userId, codeId),
      RESET_PASSWORD_OTP_TTL_SECONDS,
    );
  }

  private async countResetAttempt(key: string, windowSeconds: number): Promise<number> {
    try {
      const { count } = await this.rmqProducer.send<
        { count: number },
        { key: string; windowSeconds: number }
      >('redis.incr', { key, windowSeconds }, REDIS_READ_TIMEOUT_MS, 0);
      return count;
    } catch (error) {
      this.logger.warn('Reset code attempt counter unavailable', error);
      throw new ServiceUnavailableException(ERROR_MESSAGES.SESSION_CHECK_UNAVAILABLE);
    }
  }

  /**
   * Single-use read (GETDEL) for reset codes. No retry: a retried call after a lost reply would
   * find the key already gone. The value is not logged, since it carries the code's hash.
   */
  private async redisGetAndDelete(key: string): Promise<string | null> {
    try {
      return await this.rmqProducer.send<string | null, { key: string }>(
        'redis.getdel',
        { key },
        REDIS_READ_TIMEOUT_MS,
        0,
      );
    } catch (error) {
      this.logger.warn('Redis read-and-delete failed', error);
      throw new ServiceUnavailableException(ERROR_MESSAGES.SESSION_CHECK_UNAVAILABLE);
    }
  }

  /**
   * Rotates the refresh token of an existing session. The presented token must hash to the value
   * stored for `{userId, sid}`. A mismatch on an existing session means an old (already rotated)
   * token was replayed: the session is revoked. Refresh always fails closed: without the stored
   * hash there is nothing to verify the token against.
   */
  async refreshTokens(dto: RefreshTokenBodyDto): Promise<LoginResponseDto> {
    // Taken first: any revoke marker at or after this moment means the revoke happened mid-refresh.
    const startedAt = Date.now();
    let verified: unknown;
    try {
      verified = await this.jwtService.verifyAsync(dto.refreshToken, {
        secret: this.jwtTokensConfig.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException(ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH_TOKEN);
    }

    const payload = parseRefreshTokenPayload(verified);
    // Consume the stored hash in one step (GETDEL). Of two concurrent refreshes that present the same
    // token, only one can take the hash, so a replayed token cannot mint a second pair.
    const storedHash = await this.redisGetAndDelete(refreshHashRedisKey(payload.sub, payload.sid));
    if (!storedHash) {
      throw new UnauthorizedException(ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH_TOKEN);
    }
    if (!safeEqualHex(storedHash, hashRefreshToken(dto.refreshToken))) {
      this.logger.warn(`Refresh token reuse for user ${payload.sub}, revoking session`);
      await this.revokeSession(payload.sub, payload.sid);
      throw new UnauthorizedException(ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH_TOKEN);
    }
    // A logout, password change or deactivation that landed while this refresh was in flight must
    // win: re-check the session before minting a new one, so it is not written back to life.
    const sessionStillOpen = await this.redisGet(sessionRedisKey(payload.sub, payload.sid));
    if (!sessionStillOpen) {
      throw new UnauthorizedException(ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH_TOKEN);
    }

    const rows = await this.userService.getUserByField({
      field: 'id',
      value: payload.sub,
    });

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new UnauthorizedException(ERROR_MESSAGES.USER_NO_LONGER_EXISTS);
    }

    const user = rows[0];
    if (user.isActive === false) {
      throw new UnauthorizedException(ERROR_MESSAGES.ACCOUNT_DEACTIVATED);
    }
    // Same session id, new refresh token: the stored hash is replaced, so the old one is dead.
    const issued = await this.issueTokens(user, payload.sid);

    // A revoke (logout, password change, deactivation) that ran while this refresh was in flight wins.
    // It wrote its marker after `startedAt`, so the session written above must not survive.
    const [allRevokedAt, sessionRevokedAt] = await Promise.all([
      this.redisGet(revokedAllRedisKey(payload.sub)),
      this.redisGet(revokedSessionRedisKey(payload.sub, payload.sid)),
    ]);
    if (Number(allRevokedAt ?? 0) >= startedAt || Number(sessionRevokedAt ?? 0) >= startedAt) {
      await this.revokeSession(payload.sub, payload.sid);
      throw new UnauthorizedException(ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH_TOKEN);
    }
    return issued;
  }

  /** `auth.logout`: ends one session (this device). Other devices keep their sessions. */
  async logoutService({ userId, sid }: { userId: string; sid: string }) {
    if (!checkUuidValid({ data: userId }) || !checkUuidValid({ data: sid })) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_SESSION);
    }
    await this.revokeSession(userId, sid);
    return { message: 'Logged out' };
  }
}
