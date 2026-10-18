import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FacebookOAuthCallbackGuard,
  FacebookOAuthStartGuard,
  GoogleOAuthCallbackGuard,
  GoogleOAuthStartGuard,
} from '@packages/guards/oauth-state.guard';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiResponse as SwaggerResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { StatusCodes } from 'http-status-codes';
import type { Request, Response } from 'express';
import {
  forgotPasswordSchema,
  loginSchema,
  loginByUserCodeSchema,
  refreshTokenBodySchema,
  type RegisterDto,
  RegisterResponseDto,
  registerSchema,
  type ForgotPasswordDto,
  type ForgotPasswordResponseDto,
  type LoginByUserCodeDto,
  type LoginDto,
  type LoginResponseDto,
  type RefreshTokenBodyDto,
  resetPasswordSchema,
  type ResetPasswordDto,
  ResetPasswordResponseDto,
} from '@packages/entities/auth';
import { ApiResponse, Public } from '@packages/decorators';
import { ZodValidationPipe } from '@packages/pipes';
import type { FacebookProfile, GoogleProfile } from '@packages/strategy';
import { AuthService } from './auth.service';

type RequestWithGoogleProfile = Request & { user: GoogleProfile };
type RequestWithFacebookProfile = Request & { user: FacebookProfile };

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  // TODO : register user ...
  @Public()
  @ApiBearerAuth('access-token')
  @Post('register')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: 'Register a new user',
    description: 'Create a new user account with email and password',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email', 'password', 'firstName', 'lastName'],
      properties: {
        email: { type: 'string', format: 'email', example: 'user@example.com' },
        username: { type: 'string', example: 'johndoe' },
        password: { type: 'string', minLength: 8, maxLength: 100, example: 'Password123!' },
        firstName: { type: 'string', minLength: 1, maxLength: 25, example: 'John' },
        lastName: { type: 'string', minLength: 1, maxLength: 25, example: 'Doe' },
      },
    },
  })
  @SwaggerResponse({ status: 200, description: 'Registration successful' })
  @ApiResponse({ statusCode: StatusCodes.OK, message: 'Login successful' })
  async register(
    @Body(new ZodValidationPipe<RegisterDto>(registerSchema))
    registerDto: RegisterDto,
  ): Promise<RegisterResponseDto> {
    return this.authService.registerService(registerDto);
  }

  //TODO : login user ...
  @Public()
  @Post('login')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: 'Login with email',
    description: 'Authenticate using email and password',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email', 'password'],
      properties: {
        email: { type: 'string', format: 'email', example: 'dang04223@gmail.com' },
        password: { type: 'string', minLength: 8, maxLength: 100, example: 'Admin@123456' },
      },
    },
  })
  @SwaggerResponse({
    status: 200,
    description: 'Login successful',
    schema: {
      type: 'object',
      properties: {
        accessToken: { type: 'string' },
        refreshToken: { type: 'string' },
        user: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
            userCode: { type: 'string', nullable: true },
            username: { type: 'string' },
          },
        },
      },
    },
  })
  @SwaggerResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ statusCode: StatusCodes.OK, message: 'Login successful' })
  async login(
    @Body(new ZodValidationPipe<LoginDto>(loginSchema))
    loginDto: LoginDto,
  ): Promise<LoginResponseDto> {
    return this.authService.loginService(loginDto);
  }

  // TODO : login with usercode ...
  @Public()
  @Post('login/user-code')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: 'Login with user code',
    description: 'Authenticate using user code and role',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['userCode', 'password', 'role'],
      properties: {
        userCode: { type: 'string', maxLength: 6, example: 'ABC123' },
        password: { type: 'string', maxLength: 100, example: 'Password123!' },
        role: { type: 'string', enum: ['PARENT', 'STUDENT'], example: 'STUDENT' },
      },
    },
  })
  @SwaggerResponse({
    status: 200,
    description: 'Login successful',
    schema: {
      type: 'object',
      properties: {
        accessToken: { type: 'string' },
        refreshToken: { type: 'string' },
        user: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
            userCode: { type: 'string', nullable: true },
            username: { type: 'string' },
          },
        },
      },
    },
  })
  @SwaggerResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ statusCode: StatusCodes.OK, message: 'Login successful' })
  async loginByUserCode(
    @Body(new ZodValidationPipe<LoginByUserCodeDto>(loginByUserCodeSchema))
    dto: LoginByUserCodeDto,
  ): Promise<LoginResponseDto> {
    return this.authService.loginByUserCodeService(dto);
  }

  // TODO : refresh token ...
  @Public()
  @Post('refresh')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: 'Refresh tokens',
    description: 'Get new access and refresh tokens using a valid refresh token',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['refreshToken'],
      properties: {
        refreshToken: { type: 'string', description: 'Refresh token issued during login' },
      },
    },
  })
  @SwaggerResponse({ status: 200, description: 'Token refreshed successfully' })
  @SwaggerResponse({ status: 401, description: 'Invalid or expired refresh token' })
  @ApiResponse({ statusCode: StatusCodes.OK, message: 'Token refreshed' })
  refresh(
    @Body(new ZodValidationPipe<RefreshTokenBodyDto>(refreshTokenBodySchema))
    body: RefreshTokenBodyDto,
  ): unknown {
    return this.authService.refreshTokens(body);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({ summary: 'Forgot password', description: 'Request a password reset email' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email'],
      properties: {
        email: { type: 'string', format: 'email', example: 'user@example.com' },
      },
    },
  })
  @SwaggerResponse({ status: 200, description: 'Reset link sent (or logged to console in dev)' })
  @ApiResponse({ statusCode: StatusCodes.OK, message: 'Forgot password successful' })
  forgotPassword(
    @Body(new ZodValidationPipe<ForgotPasswordDto>(forgotPasswordSchema))
    forgotPasswordDto: ForgotPasswordDto,
  ): Promise<ForgotPasswordResponseDto> {
    return this.authService.forgotPasswordService(forgotPasswordDto);
  }

  @Public()
  @ApiBearerAuth('access-token')
  @Post('/reset-password')
  @HttpCode(StatusCodes.OK)
  @ApiOperation({
    summary: 'Reset password',
    description: 'Reset password using the token from the reset email',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['jti', 'password', 'confirmPassword'],
      properties: {
        jti: {
          type: 'string',
          format: 'uuid',
          description: 'Reset token (JWT ID) from the reset email',
        },
        password: { type: 'string', minLength: 8, maxLength: 100, example: 'NewPass123!' },
        newPassword: {
          type: 'string',
          minLength: 8,
          maxLength: 100,
          description: 'Alias for password',
        },
        confirmPassword: { type: 'string', minLength: 8, maxLength: 100, example: 'NewPass123!' },
      },
    },
  })
  @SwaggerResponse({ status: 200, description: 'Password reset successful' })
  @SwaggerResponse({ status: 422, description: 'Validation failed or token invalid' })
  @ApiResponse({ statusCode: StatusCodes.OK, message: 'Reset password successful' })
  resetPassword(
    @Body(new ZodValidationPipe<ResetPasswordDto>(resetPasswordSchema))
    resetPasswordDto: ResetPasswordDto,
  ): Promise<ResetPasswordResponseDto> {
    return this.authService.resetPasswordService(resetPasswordDto);
  }

  @Public()
  @Get('google')
  @UseGuards(GoogleOAuthStartGuard)
  @ApiOperation({
    summary: 'Google OAuth login',
    description: 'Redirect to Google consent screen for authentication',
  })
  @SwaggerResponse({ status: 302, description: 'Redirects to Google' })
  googleAuth(): void {
    // Guard redirects to Google's consent screen; no body to return.
  }

  @Public()
  @Get('google/callback')
  @UseGuards(GoogleOAuthCallbackGuard)
  @ApiOperation({
    summary: 'Google OAuth callback',
    description: 'Handle Google OAuth callback and return JWT tokens',
  })
  @SwaggerResponse({
    status: 302,
    description: 'Redirects to frontend with tokens in query params',
  })
  async googleAuthCallback(
    @Req() req: RequestWithGoogleProfile,
    @Res() res: Response,
  ): Promise<void> {
    const { accessToken, refreshToken } = await this.authService.googleLoginService(req.user);

    const redirectBase =
      this.configService.get<string>('GOOGLE_OAUTH_REDIRECT_URL') ??
      'http://localhost:3000/oauth/callback';
    const redirectUrl = new URL(redirectBase);
    redirectUrl.searchParams.set('accessToken', accessToken);
    redirectUrl.searchParams.set('refreshToken', refreshToken);

    res.redirect(redirectUrl.toString());
  }

  // GET /auth/facebook
  @Public()
  @Get('facebook')
  @UseGuards(FacebookOAuthStartGuard)
  @ApiOperation({
    summary: 'Facebook OAuth login',
    description: 'Redirect to Facebook consent screen for authentication',
  })
  @SwaggerResponse({ status: 302, description: 'Redirects to Facebook' })
  facebookAuth(): void {
    // Guard redirects to Facebook's consent screen; no body to return.
  }

  // GET /auth/facebook/callback
  @Public()
  @Get('facebook/callback')
  @UseGuards(FacebookOAuthCallbackGuard)
  @ApiOperation({
    summary: 'Facebook OAuth callback',
    description: 'Handle Facebook OAuth callback and return JWT tokens',
  })
  @SwaggerResponse({
    status: 302,
    description: 'Redirects to frontend with tokens in query params',
  })
  async facebookAuthCallback(
    @Req() req: RequestWithFacebookProfile,
    @Res() res: Response,
  ): Promise<void> {
    const { accessToken, refreshToken } = await this.authService.facebookLoginService(req.user);

    const redirectBase =
      this.configService.get<string>('GOOGLE_OAUTH_REDIRECT_URL') ??
      'http://localhost:3000/oauth/callback';
    const redirectUrl = new URL(redirectBase);
    redirectUrl.searchParams.set('accessToken', accessToken);
    redirectUrl.searchParams.set('refreshToken', refreshToken);

    res.redirect(redirectUrl.toString());
  }
}
