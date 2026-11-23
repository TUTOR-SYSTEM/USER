import { Controller, ForbiddenException } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ERROR_MESSAGES } from 'src/data/constants';
import { RpcActorPayload, splitClientIp, splitRpcActor } from '@packages/helpers';

/** Gateway-forwarded client IP and its signature (login only). */
type ClientIpPayload = {
  clientIp?: string;
  clientIpSig?: string;
  clientIpSigTs?: number;
};
import { verifyEmailSchema } from '@packages/entities/auth';
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
import { ZodValidationPipe } from '@packages/pipes';
import type { FacebookProfile, GoogleProfile } from '@packages/strategy';
import { AuthService } from './auth.service';

/**
 * Message-pattern mirror of `AuthController` — reached only by the gateway's `RmqProducer`
 * over `user_queue` (`auth.*` patterns). Delegates to the same, unmodified `AuthService` the
 * HTTP controller uses; no business logic lives here.
 */
@Controller()
export class AuthRpcController {
  constructor(private readonly authService: AuthService) {}

  @MessagePattern('auth.register')
  register(@Payload() registerDto: RegisterDto): Promise<RegisterResponseDto> {
    return this.authService.registerService(registerDto);
  }

  /**
   * The gateway's client IP keys the per-IP lockout counter. It is used only when the gateway
   * signature on it verifies (`splitClientIp`); otherwise the shared bucket applies.
   */
  @MessagePattern('auth.login')
  login(@Payload() payload: LoginDto & ClientIpPayload): Promise<LoginResponseDto> {
    const { clientIp, rest } = splitClientIp(payload);
    return this.authService.loginService(rest, clientIp);
  }

  @MessagePattern('auth.loginByUserCode')
  loginByUserCode(
    @Payload() payload: LoginByUserCodeDto & ClientIpPayload,
  ): Promise<LoginResponseDto> {
    const { clientIp, rest } = splitClientIp(payload);
    return this.authService.loginByUserCodeService(rest, clientIp);
  }

  @MessagePattern('auth.refresh')
  refresh(@Payload() body: RefreshTokenBodyDto): Promise<LoginResponseDto> {
    return this.authService.refreshTokens(body);
  }

  /** Ends one login session (the device identified by `sid`). Called by the gateway's `POST /auth/logout`. */
  @MessagePattern('auth.logout')
  logout(
    @Payload() payload: { userId: string; sid: string } & RpcActorPayload,
  ): Promise<{ message: string }> {
    const { actor, rest } = splitRpcActor(payload);
    // Only the account's own session can be ended through the RPC: the actor must be that account.
    if (actor.id === '' || actor.id !== rest.userId) {
      throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
    }
    return this.authService.logoutService({ userId: rest.userId, sid: rest.sid });
  }

  @MessagePattern('auth.forgotPassword')
  forgotPassword(@Payload() dto: ForgotPasswordDto): Promise<ForgotPasswordResponseDto> {
    return this.authService.forgotPasswordService(dto);
  }

  @MessagePattern('auth.resetPassword')
  resetPassword(@Payload() dto: ResetPasswordDto): Promise<ResetPasswordResponseDto> {
    return this.authService.resetPasswordService(dto);
  }

  @MessagePattern('auth.verifyEmail')
  verifyEmail(
    @Payload(new ZodValidationPipe<VerifyEmailDto>(verifyEmailSchema)) dto: VerifyEmailDto,
  ): Promise<VerifyEmailResponseDto> {
    return this.authService.verifyEmailService(dto);
  }

  @MessagePattern('auth.googleLogin')
  googleLogin(@Payload() profile: GoogleProfile): Promise<LoginResponseDto> {
    return this.authService.googleLoginService(profile);
  }

  @MessagePattern('auth.facebookLogin')
  facebookLogin(@Payload() profile: FacebookProfile): Promise<LoginResponseDto> {
    return this.authService.facebookLoginService(profile);
  }
}
