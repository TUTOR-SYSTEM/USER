import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
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
} from '@packages/entities/auth';
import {
  compareData,
  signAccessToken,
  signRefreshToken,
  type JwtRefreshPayload,
  type JwtTokensConfig,
} from '@packages/helpers';
import { UserService } from '../user/user.service';
import { getJwtTokensConfig } from '@packages/configs/jwt-sign.config';
import { randomUUID } from 'node:crypto';
import { checkUuidValid, type JwtUserRole } from '@packages/helpers';
import type { FacebookProfile, GoogleProfile } from '@packages/strategy';
import { RmqProducer } from '../rabbitmq/rmq.producer';

/** How long a forgot-password reset token stays valid — matches the copy in the reset email. */
const RESET_PASSWORD_TOKEN_TTL_SECONDS = 300;
const resetPasswordRedisKey = (jti: string) => `reset-password:${jti}`;
const loginSessionRedisKey = (userId: string) => `session:${userId}`;

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
  return { sub: record.sub, email: record.email, typ: 'refresh' };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwtTokensConfig: JwtTokensConfig;
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly rmqProducer: RmqProducer,
    configService: ConfigService,
  ) {
    this.jwtTokensConfig = getJwtTokensConfig(configService);
  }

  /**
   * Fire-and-forget: persists the login session in third-service's Redis via the existing
   * generic `redis.set` topic — key is `session:{userId}`, value is the raw refreshToken.
   * TTL matches the refresh token's own lifetime. Not awaited by callers — a RabbitMQ/Redis hiccup
   * here must never fail the login response itself.
   */
  private emitLoginSessionCreated(userId: string, refreshToken: string): void {
    this.rmqProducer
      .send('redis.set', {
        key: loginSessionRedisKey(userId),
        value: refreshToken,
        ttlSeconds: this.jwtTokensConfig.refreshExpiresIn,
      })
      .catch((error: unknown) =>
        this.logger.warn(`Failed to create login session for user ${userId}`, error),
      );
  }

  /** Signs the access/refresh pair, records the session and builds the login response. */
  private async issueLoginResponse(user: User): Promise<LoginResponseDto> {
    if (user.isActive === false) {
      throw new UnauthorizedException(ERROR_MESSAGES.ACCOUNT_DEACTIVATED);
    }
    const payload = { sub: user.id, email: user.email, role: user.role as JwtUserRole };
    const [accessToken, refreshToken] = await Promise.all([
      signAccessToken(this.jwtService, payload, this.jwtTokensConfig),
      signRefreshToken(this.jwtService, { sub: user.id, email: user.email }, this.jwtTokensConfig),
    ]);

    this.emitLoginSessionCreated(user.id, refreshToken);

    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, userCode: user.userCode, username: user.username },
    };
  }

  /** Finds the user by email or auto-registers them as STUDENT (Google/Facebook sign-in). */
  private async findOrCreateOAuthUser(profile: {
    email: string;
    firstName: string;
    lastName: string;
  }): Promise<User> {
    const [existing] = await this.userService.getUserByField({
      field: 'email',
      value: profile.email,
    });
    if (existing) return existing;

    await this.userService.createUserService({
      email: profile.email,
      password: randomUUID(),
      firstName: profile.firstName,
      lastName: profile.lastName,
      role: 'STUDENT',
    });
    const [created] = await this.userService.getUserByField({
      field: 'email',
      value: profile.email,
    });
    if (!created) throw new BadRequestException(ERROR_MESSAGES.FAILED_TO_CREATE_USER);
    return created;
  }

  // TODO: register tutor ...
  async registerService(registerDto: RegisterDto): Promise<RegisterResponseDto> {
    const { email, username, password, firstName, lastName } = registerDto;

    const checkUserWithEmail = await this.userService.getUserByField({
      field: 'email',
      value: email,
    });
    if (Array.isArray(checkUserWithEmail) && checkUserWithEmail.length > 0) {
      throw new BadRequestException(ERROR_MESSAGES.EMAIL_EXISTS);
    }

    const checkUserWithUsername =
      username &&
      (await this.userService.getUserByField({
        field: 'username',
        value: username?.trim(),
      }));
    if (Array.isArray(checkUserWithUsername) && checkUserWithUsername.length > 0) {
      throw new BadRequestException(ERROR_MESSAGES.USERNAME_EXISTS);
    }

    await this.userService.createUserService({
      email,
      username: username?.trim() || undefined,
      password,
      firstName,
      lastName,
      role: 'TUTOR',
    });

    const createdRows = await this.userService.getUserByField({ field: 'email', value: email });
    const createdUser = createdRows[0];
    if (!createdUser) {
      throw new BadRequestException(ERROR_MESSAGES.FAILED_TO_CREATE_USER);
    }

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

  // TODO:  login by email + password ...
  async loginService(loginDto: LoginDto): Promise<LoginResponseDto> {
    const [user] = await this.userService.getUserByField({
      field: 'email',
      value: loginDto.email,
    });

    if (!user) {
      throw new BadRequestException(ERROR_MESSAGES.USER_NOT_FOUND);
    }

    const isPasswordOk = await compareData(loginDto.password, user.password);
    if (!isPasswordOk) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_PASSWORD);
    }

    return this.issueLoginResponse(user);
  }

  // TODO: login with userCode + password ...
  async loginByUserCodeService(dto: LoginByUserCodeDto): Promise<LoginResponseDto> {
    const rows = await this.userService.getUserByField({
      field: 'userCode',
      value: dto.userCode,
    });

    const user = rows.find((u) => u.role === dto.role);
    if (!user) {
      throw new BadRequestException(ERROR_MESSAGES.USER_NOT_FOUND);
    }
    const isPasswordOk = await compareData(dto.password, user.password);
    if (!isPasswordOk) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_PASSWORD);
    }

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
      value: forgotPasswordDto.email,
    });
    if (!user) {
      throw new BadRequestException(ERROR_MESSAGES.USER_NOT_FOUND);
    }

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

    return { ok: true };
  }

  async resetPasswordService(
    resetPasswordDto: ResetPasswordDto,
  ): Promise<ResetPasswordResponseDto> {
    const key = resetPasswordRedisKey(resetPasswordDto.jti);
    const userId = await this.rmqProducer.send<string | null, { key: string }>('redis.get', {
      key,
    });
    if (!userId) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_RESET_PASSWORD_TOKEN);
    }

    await this.updateUserPasswordService({ userId, password: resetPasswordDto.password });

    // Best-effort cleanup: the password is already changed, so a delete failure here (token
    // stays until its TTL expires) must not fail the response.
    this.rmqProducer
      .emit('redis.del', { keys: [key] })
      .catch((error: unknown) => this.logger.warn(`Failed to delete reset token ${key}`, error));

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

    const rows = await this.userService.getUserByField({
      field: 'id',
      value: payload.sub,
    });

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new UnauthorizedException(ERROR_MESSAGES.USER_NO_LONGER_EXISTS);
    }

    const user = rows[0];
    return this.issueLoginResponse(user);
  }

  // Logout: delete the session from Redis so the gateway rejects subsequent requests with 401
  logoutService(user: Record<string, string>) {
    if (!user.id || !checkUuidValid({ data: user.id })) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_USER_ID);
    }

    // Best-effort: if Redis delete fails, the session will expire via TTL anyway.
    this.rmqProducer
      .emit('redis.del', { keys: [loginSessionRedisKey(user.id)] })
      .catch((error: unknown) =>
        this.logger.warn(`Failed to delete session for user ${user.id}`, error),
      );

    return { ok: true };
  }
}
