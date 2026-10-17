import {
  BadRequestException,
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
  safeEqualHex,
  sessionRedisKey,
  signAccessToken,
  signRefreshToken,
  type JwtRefreshPayload,
  type JwtTokensConfig,
  type JwtUserRole,
} from '@packages/helpers';
import { UserService } from '../user/user.service';
import { getJwtTokensConfig } from '@packages/configs/jwt-sign.config';
import { randomUUID } from 'node:crypto';
import { checkUuidValid } from '@packages/helpers';
import type { FacebookProfile, GoogleProfile } from '@packages/strategy';
import { RmqProducer } from '../rabbitmq/rmq.producer';

/** How long a forgot-password reset token stays valid — matches the copy in the reset email. */
const RESET_PASSWORD_TOKEN_TTL_SECONDS = 300;
const resetPasswordRedisKey = (jti: string) => `reset-password:${jti}`;

/** How long an email-verification link stays valid. */
const VERIFY_EMAIL_TOKEN_TTL_SECONDS = 86400;
const verifyEmailRedisKey = (jti: string) => `verify-email:${jti}`;

/** Redis round-trip budget for session/token reads: one short retry, then fail. */
const REDIS_READ_TIMEOUT_MS = 2_000;
const REDIS_READ_RETRIES = 1;

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

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
  private dummyHash?: Promise<string>;
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly rmqProducer: RmqProducer,
    private readonly configService: ConfigService,
  ) {
    this.jwtTokensConfig = getJwtTokensConfig(configService);
  }

  /**
   * Single generic error for unknown user and wrong password (no account enumeration). A dummy
   * bcrypt compare runs for unknown users so response time doesn't leak existence either.
   */
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

  async loginService(loginDto: LoginDto): Promise<LoginResponseDto> {
    const [found] = await this.userService.getUserByField({
      field: 'email',
      value: normalizeEmail(loginDto.email),
    });
    const user = await this.verifyCredentials(found, loginDto.password);

    return this.issueLoginResponse(user);
  }

  // TODO: login with userCode + password ...
  async loginByUserCodeService(dto: LoginByUserCodeDto): Promise<LoginResponseDto> {
    const rows = await this.userService.getUserByField({
      field: 'userCode',
      value: dto.userCode,
    });

    const found = rows.find((u) => u.role === dto.role);
    const user = await this.verifyCredentials(
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

  // Reset token = a random jti stored in third-service's Redis (userId, 5 min TTL); the email
  // itself is sent by third-service too. Both hops go over this service's own RabbitMQ producer.
  async forgotPasswordService(
    forgotPasswordDto: ForgotPasswordDto,
  ): Promise<ForgotPasswordResponseDto> {
    const [user] = await this.userService.getUserByField({
      field: 'email',
      value: normalizeEmail(forgotPasswordDto.email),
    });
    // Same response, same timing, whether or not the email exists: the mail is sent in the
    // background so a registered address does not answer more slowly than an unknown one.
    if (user) {
      this.sendForgotPasswordMail(user).catch((error: unknown) =>
        this.logger.warn(`Failed to send reset mail to user ${user.id}`, error),
      );
    }

    return { ok: true };
  }

  private async sendForgotPasswordMail(user: { id: string; email: string; firstName: string }) {
    const jti = randomUUID();
    await this.rmqProducer.send('redis.set', {
      key: resetPasswordRedisKey(jti),
      value: user.id,
      ttlSeconds: RESET_PASSWORD_TOKEN_TTL_SECONDS,
    });

    await this.rmqProducer.send('email.sendForgotPasswordMail', {
      to: user.email,
      resetToken: jti,
      displayName: user.firstName,
    });
  }

  async resetPasswordService(
    resetPasswordDto: ResetPasswordDto,
  ): Promise<ResetPasswordResponseDto> {
    const key = resetPasswordRedisKey(resetPasswordDto.jti);
    const userId = await this.redisGet(key);
    if (!userId) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_RESET_PASSWORD_TOKEN);
    }

    await this.updateUserPasswordService({ userId, password: resetPasswordDto.password });
    // Replying to the reset mail proves the user controls the mailbox.
    await this.userService.setEmailVerifiedService({ id: userId, emailVerified: true });

    // Best-effort cleanup: the password is already changed, so a delete failure here (token
    // stays until its TTL expires) must not fail the response.
    this.rmqProducer
      .emit('redis.del', { keys: [key] })
      .catch((error: unknown) => this.logger.warn(`Failed to delete reset token ${key}`, error));

    return { ok: true };
  }

  async verifyEmailService(dto: VerifyEmailDto): Promise<VerifyEmailResponseDto> {
    const key = verifyEmailRedisKey(dto.jti);
    const token = parseVerifyEmailToken(await this.redisGet(key));
    if (!token) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_VERIFY_EMAIL_TOKEN);
    }

    // The token is for the address it was issued to. If the account's email changed since, the
    // link no longer proves anything about the current address.
    const [user] = await this.userService.getUserByField({ field: 'id', value: token.userId });
    if (!user || user.email !== token.email) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_VERIFY_EMAIL_TOKEN);
    }

    await this.userService.setEmailVerifiedService({ id: token.userId, emailVerified: true });

    // Best-effort cleanup, same as reset-password: the email is already verified.
    this.rmqProducer
      .emit('redis.del', { keys: [key] })
      .catch((error: unknown) => this.logger.warn(`Failed to delete verify token ${key}`, error));

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
   * Rotates the refresh token of an existing session. The presented token must hash to the value
   * stored for `{userId, sid}`. A mismatch on an existing session means an old (already rotated)
   * token was replayed: the session is revoked. Refresh always fails closed: without the stored
   * hash there is nothing to verify the token against.
   */
  async refreshTokens(dto: RefreshTokenBodyDto): Promise<LoginResponseDto> {
    let verified: unknown;
    try {
      verified = await this.jwtService.verifyAsync(dto.refreshToken, {
        secret: this.jwtTokensConfig.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException(ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH_TOKEN);
    }

    const payload = parseRefreshTokenPayload(verified);
    const storedHash = await this.redisGet(refreshHashRedisKey(payload.sub, payload.sid));
    if (!storedHash) {
      throw new UnauthorizedException(ERROR_MESSAGES.INVALID_OR_EXPIRED_REFRESH_TOKEN);
    }
    if (!safeEqualHex(storedHash, hashRefreshToken(dto.refreshToken))) {
      this.logger.warn(`Refresh token reuse for user ${payload.sub}, revoking session`);
      await this.revokeSession(payload.sub, payload.sid);
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
    return this.issueTokens(user, payload.sid);
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
