import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
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

  @MessagePattern('auth.login')
  login(@Payload() loginDto: LoginDto): Promise<LoginResponseDto> {
    return this.authService.loginService(loginDto);
  }

  @MessagePattern('auth.loginByUserCode')
  loginByUserCode(@Payload() dto: LoginByUserCodeDto): Promise<LoginResponseDto> {
    return this.authService.loginByUserCodeService(dto);
  }

  @MessagePattern('auth.refresh')
  refresh(@Payload() body: RefreshTokenBodyDto): Promise<LoginResponseDto> {
    return this.authService.refreshTokens(body);
  }

  @MessagePattern('auth.forgotPassword')
  forgotPassword(@Payload() dto: ForgotPasswordDto): Promise<ForgotPasswordResponseDto> {
    return this.authService.forgotPasswordService(dto);
  }

  @MessagePattern('auth.resetPassword')
  resetPassword(@Payload() dto: ResetPasswordDto): Promise<ResetPasswordResponseDto> {
    return this.authService.resetPasswordService(dto);
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
