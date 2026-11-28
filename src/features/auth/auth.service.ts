import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ERROR_MESSAGES, SUCCESS_MESSAGES } from 'src/data/constants';
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
import { checkUuidValid, sendAccountExistsMail } from '@packages/helpers';
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

/** Placeholder addresses (no real mailbox) never get reset or verification mail. */
const PLACEHOLDER_EMAIL_SUFFIX = '@no-email.local';
/** Verification mails re-sent per address per hour. */
const VERIFY_EMAIL_RESEND_MAX_PER_WINDOW = 3;
/** Hashed address for counter keys: the Redis key never holds the email in plain text. */
const addressHash = (email: string) => createHash('sha256').update(email).digest('hex');
const resetPasswordEmailAttemptsRedisKey = (email: string) =>
  `reset-password-email-attempts:${addressHash(email)}`;
const resetPasswordEmailWindowRedisKey = (email: string) =>
  `reset-password-email-window:${addressHash(email)}`;
const verifyEmailResendRedisKey = (email: string) =>
  `verify-email-resend-rate:${addressHash(email)}`;

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
   * Counts this sign-in attempt before its password is checked, then refuses it when a counter is
   * already past its limit. INCR is atomic on Redis, so parallel attempts each take their own slot:
   * a burst of guesses cannot all pass a check that the others have not incremented yet. Every
   * attempt counts (successes too), so the account-wide counter works as a rate limit per window.
   * Runs before the account lookup, so a locked identifier gets the same answer whether or not the
   * account exists. Fails closed (503) when Redis cannot be reached.
   */
  private async reserveLoginAttempt(identifier: string): Promise<void> {
    const checks = [
      { key: loginFailureRedisKey(identifier), max: this.loginMaxAttempts },
      { key: loginFailureRedisKey(accountOf(identifier)), max: this.loginAccountMaxAttempts },
    ];
    for (const { key, max } of checks) {
      const count = await this.incrLoginCounter(key);
      if (count > max) {
        const remainingSeconds = await this.getLoginLockRemainingSeconds(key);
        const minutes = Math.max(1, Math.ceil(remainingSeconds / 60));
        throw new HttpException(
          `${ERROR_MESSAGES.TOO_MANY_LOGIN_ATTEMPTS_WAIT}: ${minutes}`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  /** One atomic counter step in the login window. No retry: a retried INCR would count one attempt twice. */
  private async incrLoginCounter(key: string): Promise<number> {
    try {
      const reply = await this.rmqProducer.send<
        { count: number } | undefined,
        { key: string; windowSeconds: number }
      >(
        'redis.incr',
        { key, windowSeconds: this.loginAttemptWindowSeconds },
        REDIS_READ_TIMEOUT_MS,
        0,
      );
      // An empty or non-numeric reply is unknown, not zero: fail closed rather than let it through.
      const count = Number(reply?.count);
      if (!Number.isFinite(count)) throw new Error('invalid redis.incr reply');
      return count;
    } catch (error) {
      this.logger.warn('Login lockout counter unavailable', error);
      throw new ServiceUnavailableException(ERROR_MESSAGES.SESSION_CHECK_UNAVAILABLE);
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

  /** A successful sign-in clears the counter. Best effort: a missed delete only leaves the window. */
  private clearLoginFailures(identifier: string): void {
    this.rmqProducer
      .emit('redis.del', { keys: [loginFailureRedisKey(identifier)] })
      .catch((error: unknown) => this.logger.warn('Failed to clear login failures', error));
  }

  /** `verifyCredentials` plus the success bookkeeping: a successful sign-in clears the IP counter. */
  private async verifyCredentialsWithLockout(
    identifier: string,
    user: User | undefined,
    password: string,
    unknownMessage: string,
  ): Promise<User> {
    const verified = await this.verifyCredentials(user, password, unknownMessage);
    this.clearLoginFailures(identifier);
    return verified;
  }

  /**
   * Every failure gets the same answer (INVALID_CREDENTIALS), whether the account is unknown, has no
   * password (OAuth-only) or the password is wrong, so the response does not reveal which emails or
   * user codes exist. Each branch still runs one bcrypt compare (a dummy hash when there is no
   * password to check), so the response time does not reveal it either.
   */
  private async verifyCredentials(
    user: User | undefined,
    password: string,
    unknownMessage: string,
  ): Promise<User> {
    const hash = user?.password ?? (await (this.dummyHash ??= hashData('dummy-password')));
    const matches = await compareData(password, hash);
    if (!user) {
      throw new UnauthorizedException(unknownMessage);
    }
    if (!user.password || !matches) {
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
    try {
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
    } catch (error) {
      // Raw transport errors (which can carry the broker URL) never reach the client.
      this.logger.warn('Failed to store the session', error);
      throw new ServiceUnavailableException(ERROR_MESSAGES.SESSION_CHECK_UNAVAILABLE);
    }

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        userCode: user.userCode,
        username: user.username,
        mustChangePassword: user.mustChangePassword,
      },
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
    try {
      // Marker before the delete, so an in-flight refresh of this session that writes after it is caught.
      await this.rmqProducer.send('redis.set', {
        key: revokedSessionRedisKey(userId, sid),
        value: String(Date.now()),
        ttlSeconds: SESSION_REVOKED_MARKER_TTL_SECONDS,
      });
      await this.rmqProducer.send('redis.del', {
        keys: [sessionRedisKey(userId, sid), refreshHashRedisKey(userId, sid)],
      });
    } catch (error) {
      this.logger.warn('Failed to revoke session', error);
      throw new ServiceUnavailableException(ERROR_MESSAGES.SESSION_CHECK_UNAVAILABLE);
    }
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
  private async findOrCreateOAuthUser(
    profile: {
      email: string;
      firstName: string;
      lastName: string;
    },
    { emailProven = true }: { emailProven?: boolean } = {},
  ): Promise<User> {
    const email = normalizeEmail(profile.email);
    const [existing] = await this.userService.getUserByField({ field: 'email', value: email });
    if (existing) {
      // A provider that does not prove the email must never hand over an existing account.
      if (existing.role !== 'STUDENT' || !emailProven) {
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
      { emailVerified: emailProven },
    );
    const [created] = await this.userService.getUserByField({ field: 'email', value: email });
    if (!created) throw new BadRequestException(ERROR_MESSAGES.FAILED_TO_CREATE_USER);
    return created;
  }

  /** Public registration always creates a STUDENT. TUTOR/ADMIN accounts are created by an admin. */
  async registerService(registerDto: RegisterDto): Promise<RegisterResponseDto> {
    const { password, firstName, lastName } = registerDto;
    const email = normalizeEmail(registerDto.email);
    const username = registerDto.username?.trim() || undefined;

    // The username check runs first and answers the same whatever the email is: a taken username is
    // refused for a new address and for a registered one alike, so the response never reveals the email.
    if (username && (await this.usernameIsTaken(username))) {
      throw new BadRequestException(ERROR_MESSAGES.AUTH_USERNAME_TAKEN);
    }

    // A registered email gets the same answer as a new sign-up (F-09): no 400, no id of the existing
    // account, no mail.
    if (await this.emailIsRegistered(email)) {
      return this.registerDecoy({ email, username, password, firstName, lastName });
    }

    try {
      await this.userService.createUserService({
        email,
        username,
        password,
        firstName,
        lastName,
        role: 'STUDENT',
      });
    } catch (error: unknown) {
      // A concurrent sign-up for the same email can win between the checks above and the insert.
      if (this.isDuplicateSignUp(error) && (await this.emailIsRegistered(email))) {
        return this.registerDecoy({ email, username, password, firstName, lastName });
      }
      throw error;
    }

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

  private async usernameIsTaken(username: string): Promise<boolean> {
    const rows = await this.userService.getUserByField({ field: 'username', value: username });
    return Array.isArray(rows) && rows.length > 0;
  }

  /** The insert lost a race on a unique constraint (the user service's pre-check or the DB). */
  private isDuplicateSignUp(error: unknown): boolean {
    return (
      error instanceof ConflictException ||
      (error instanceof BadRequestException &&
        error.message === ERROR_MESSAGES.ACCOUNT_ALREADY_EXISTS)
    );
  }

  private async emailIsRegistered(email: string): Promise<boolean> {
    const rows = await this.userService.getUserByField({ field: 'email', value: email });
    return Array.isArray(rows) && rows.length > 0;
  }

  /**
   * Answer for a sign-up whose email is already registered (F-09). Same status and shape as a real
   * sign-up, but nothing is written and no verify mail is sent. The bcrypt hash keeps the response
   * time close to a real sign-up. The id is random, so it never points at the existing account.
   */
  private async registerDecoy(input: {
    email: string;
    username?: string;
    password: string;
    firstName: string;
    lastName: string;
  }): Promise<RegisterResponseDto> {
    await hashData(input.password);
    // Notify the owner (best-effort, awaited so the timing stays close to a real sign-up).
    await sendAccountExistsMail(this.rmqProducer, {
      email: input.email,
      displayName: input.firstName,
    });
    return {
      user: {
        id: randomUUID(),
        email: input.email,
        // Same generator as a real sign-up, so the decoy does not reveal the address (F-09).
        username:
          input.username ??
          (await this.userService.generateUsername(input.firstName, input.lastName)),
        firstName: input.firstName,
        lastName: input.lastName,
      },
    };
  }

  async loginService(loginDto: LoginDto, clientIp?: string): Promise<LoginResponseDto> {
    const email = normalizeEmail(loginDto.email);
    const identifier = lockoutIdentifier(`email:${email}`, clientIp);
    await this.reserveLoginAttempt(identifier);

    const [found] = await this.userService.getUserByField({
      field: 'email',
      value: email,
    });
    const user = await this.verifyCredentialsWithLockout(
      identifier,
      found,
      loginDto.password,
      ERROR_MESSAGES.EMAIL_NOT_REGISTERED,
    );

    return this.issueLoginResponse(user);
  }

  // TODO: login with userCode + password ...
  async loginByUserCodeService(
    dto: LoginByUserCodeDto,
    clientIp?: string,
  ): Promise<LoginResponseDto> {
    const identifier = lockoutIdentifier(`userCode:${dto.userCode}`, clientIp);
    await this.reserveLoginAttempt(identifier);

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
    // Facebook does not say whether the email is verified, so it is not trusted to link accounts.
    return this.issueLoginResponse(
      await this.findOrCreateOAuthUser(profile, { emailProven: false }),
    );
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
    // Counted for every address, known or not: over quota is the same 429 either way.
    await this.assertAddressSlot(
      forgotPasswordRateRedisKey(email),
      FORGOT_PASSWORD_MAX_REQUESTS_PER_WINDOW,
    );
    // Same response and timing whether or not the email exists: the mail goes out in the background.
    // A deactivated account or a placeholder address gets no code (no mailbox to deliver it to).
    if (user && user.isActive !== false && !user.email.endsWith(PLACEHOLDER_EMAIL_SUFFIX)) {
      this.sendPasswordResetOtp(user).catch((error: unknown) =>
        this.logger.warn(`Failed to send reset code to user ${user.id}`, error),
      );
    }

    return { ok: true };
  }

  /** Counts one request in a window keyed by address (atomic INCR). Over the limit: 429. */
  private async assertAddressSlot(key: string, max: number): Promise<void> {
    const count = await this.countResetAttempt(key, RESET_PASSWORD_WINDOW_SECONDS);
    if (count > max) {
      throw new HttpException(ERROR_MESSAGES.AUTH_TOO_MANY_REQUESTS, HttpStatus.TOO_MANY_REQUESTS);
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
    const email = normalizeEmail(resetPasswordDto.email);
    // Every guess is counted against the address first, known or not, so a registered and an unknown
    // address get the same limit answers (no 429 for one of them only).
    await this.assertResetGuessAllowed(email);

    const [user] = await this.userService.getUserByField({ field: 'email', value: email });
    // Unknown email, deactivated account and wrong code give the same answer, so the endpoint does
    // not reveal accounts, and a deactivated account cannot reset its way back in.
    if (!user || user.isActive === false) {
      // Same Redis round-trip as a real account, so the response time does not reveal the account.
      await this.redisGet(
        resetPasswordOtpRedisKey(randomUUID()),
        ERROR_MESSAGES.SECURITY_CHECK_UNAVAILABLE,
      );
      throw new BadRequestException(ERROR_MESSAGES.INVALID_RESET_OTP);
    }

    const key = resetPasswordOtpRedisKey(user.id);
    const raw = await this.redisGet(key, ERROR_MESSAGES.SECURITY_CHECK_UNAVAILABLE);
    const record = parseResetOtpRecord(raw);
    if (!record || !raw) {
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
    const consumed = await this.redisGetAndDelete(key, ERROR_MESSAGES.SECURITY_CHECK_UNAVAILABLE);
    if (consumed !== raw) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_RESET_OTP);
    }

    try {
      await this.updateUserPasswordService({
        userId: user.id,
        password: resetPasswordDto.password,
      });
    } catch (error) {
      // The code was used up but the password was not changed by an infrastructure failure: put the
      // code back so the user can retry. A rejected request (a 4xx) keeps the code used.
      if (this.isInfrastructureFailure(error)) {
        await this.restoreConsumedValue(key, raw, RESET_PASSWORD_OTP_TTL_SECONDS);
      }
      throw error;
    }
    const userId = user.id;
    // Entering the code from the reset email proves the user controls the mailbox.
    await this.userService.setEmailVerifiedService({ id: userId, emailVerified: true });
    // Best effort: a missed delete only leaves the counter to expire on its own.
    this.rmqProducer
      .emit('redis.del', { keys: [resetPasswordOtpWindowRedisKey(userId)] })
      .catch((error: unknown) => this.logger.warn('Failed to clear reset attempts', error));

    return { ok: true };
  }

  /** Counts a reset guess against the address (5 per code lifetime, 10 per hour), known or not. */
  private async assertResetGuessAllowed(email: string): Promise<void> {
    const burst = await this.countResetAttempt(
      resetPasswordEmailAttemptsRedisKey(email),
      RESET_PASSWORD_OTP_TTL_SECONDS,
    );
    if (burst > RESET_PASSWORD_OTP_MAX_ATTEMPTS) {
      throw new HttpException(
        ERROR_MESSAGES.RESET_OTP_TOO_MANY_ATTEMPTS,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const hourly = await this.countResetAttempt(
      resetPasswordEmailWindowRedisKey(email),
      RESET_PASSWORD_WINDOW_SECONDS,
    );
    if (hourly > RESET_PASSWORD_OTP_MAX_ATTEMPTS_PER_WINDOW) {
      throw new HttpException(ERROR_MESSAGES.RESET_OTP_WINDOW_LOCKED, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** A failure the user did not cause (Redis, RabbitMQ, database), as opposed to a rejected request. */
  private isInfrastructureFailure(error: unknown): boolean {
    return !(error instanceof HttpException) || error instanceof ServiceUnavailableException;
  }

  /** Best effort: puts a single-use value back after a failed attempt, so the user can retry it. */
  private async restoreConsumedValue(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      await this.rmqProducer.send('redis.set', { key, value, ttlSeconds });
    } catch (error) {
      this.logger.warn('Failed to restore a single-use value after a failed attempt', error);
    }
  }

  async verifyEmailService(dto: VerifyEmailDto): Promise<VerifyEmailResponseDto> {
    // Single use: GETDEL consumes the token in the same step that reads it, so a replayed link
    // finds nothing (the earlier fire-and-forget delete left a window for reuse).
    const raw = await this.redisGetAndDelete(
      verifyEmailRedisKey(dto.jti),
      ERROR_MESSAGES.SECURITY_CHECK_UNAVAILABLE,
    );
    const token = parseVerifyEmailToken(raw);
    if (!token || !raw) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_VERIFY_EMAIL_TOKEN);
    }

    try {
      // The token is for the address it was issued to. If the account's email changed since, the
      // link no longer proves anything about the current address.
      const [user] = await this.userService.getUserByField({ field: 'id', value: token.userId });
      if (!user || user.email !== token.email || user.isActive === false) {
        throw new BadRequestException(ERROR_MESSAGES.INVALID_VERIFY_EMAIL_TOKEN);
      }
      await this.userService.setEmailVerifiedService({ id: token.userId, emailVerified: true });
    } catch (error) {
      if (this.isInfrastructureFailure(error)) {
        await this.restoreConsumedValue(
          verifyEmailRedisKey(dto.jti),
          raw,
          VERIFY_EMAIL_TOKEN_TTL_SECONDS,
        );
      }
      throw error;
    }

    return { ok: true };
  }

  /**
   * Sends the sign-up verification mail again. Same answer for every address; only an unverified,
   * active account with a real mailbox gets the mail. Counted per address, like the reset code.
   */
  async resendVerifyEmailService(dto: ForgotPasswordDto): Promise<ForgotPasswordResponseDto> {
    const email = normalizeEmail(dto.email);
    const [user] = await this.userService.getUserByField({ field: 'email', value: email });
    const count = await this.countResetAttempt(
      verifyEmailResendRedisKey(email),
      RESET_PASSWORD_WINDOW_SECONDS,
    );
    if (count > VERIFY_EMAIL_RESEND_MAX_PER_WINDOW) {
      throw new HttpException(ERROR_MESSAGES.AUTH_TOO_MANY_REQUESTS, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (
      user &&
      user.isActive !== false &&
      !user.emailVerified &&
      !user.email.endsWith(PLACEHOLDER_EMAIL_SUFFIX)
    ) {
      await this.sendVerifyEmail(user);
    }
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
  private async redisGet(
    key: string,
    unavailable: string = ERROR_MESSAGES.SESSION_CHECK_UNAVAILABLE,
  ): Promise<string | null> {
    try {
      return await this.rmqProducer.send<string | null, { key: string }>(
        'redis.get',
        { key },
        REDIS_READ_TIMEOUT_MS,
        REDIS_READ_RETRIES,
      );
    } catch (error) {
      this.logger.warn(`Redis read failed for ${key}`, error);
      throw new ServiceUnavailableException(unavailable);
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
      throw new ServiceUnavailableException(ERROR_MESSAGES.SECURITY_CHECK_UNAVAILABLE);
    }
  }

  /**
   * Single-use read (GETDEL) for reset codes. No retry: a retried call after a lost reply would
   * find the key already gone. The value is not logged, since it carries the code's hash.
   */
  private async redisGetAndDelete(
    key: string,
    unavailable: string = ERROR_MESSAGES.SESSION_CHECK_UNAVAILABLE,
  ): Promise<string | null> {
    try {
      return await this.rmqProducer.send<string | null, { key: string }>(
        'redis.getdel',
        { key },
        REDIS_READ_TIMEOUT_MS,
        0,
      );
    } catch (error) {
      this.logger.warn('Redis read-and-delete failed', error);
      throw new ServiceUnavailableException(unavailable);
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
    // The hash is consumed now. If the infrastructure fails before the new pair is stored, put the old
    // hash back: the client still holds the old token, so a transient Redis/RabbitMQ error must not
    // sign it out. A closed session or a revoke still rejects on the next attempt.
    let revoked = false;
    try {
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
        revoked = true;
        await this.revokeSession(payload.sub, payload.sid);
        throw new UnauthorizedException(ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH_TOKEN);
      }
      return issued;
    } catch (error) {
      if (!revoked && !(error instanceof UnauthorizedException)) {
        await this.restoreRefreshHash(payload.sub, payload.sid, storedHash);
      }
      throw error;
    }
  }

  /** Best effort: puts a consumed refresh hash back after a failed rotation. Never masks the error. */
  private async restoreRefreshHash(userId: string, sid: string, storedHash: string): Promise<void> {
    try {
      await this.rmqProducer.send('redis.set', {
        key: refreshHashRedisKey(userId, sid),
        value: storedHash,
        ttlSeconds: this.jwtTokensConfig.refreshExpiresIn,
      });
    } catch (error) {
      this.logger.warn('Failed to restore refresh hash after a failed rotation', error);
    }
  }

  /** `auth.logout`: ends one session (this device). Other devices keep their sessions. */
  async logoutService({ userId, sid }: { userId: string; sid: string }) {
    if (!checkUuidValid({ data: userId }) || !checkUuidValid({ data: sid })) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_SESSION);
    }
    await this.revokeSession(userId, sid);
    return { message: SUCCESS_MESSAGES.LOGOUT_SUCCESS };
  }
}
