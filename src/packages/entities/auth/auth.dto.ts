import type { z } from 'zod';
import {
  forgotPasswordSchema,
  loginSchema,
  loginByUserCodeSchema,
  refreshTokenBodySchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './auth.schema';

export type RegisterDto = z.infer<typeof registerSchema>;
export type LoginDto = z.infer<typeof loginSchema>;
export type LoginByUserCodeDto = z.infer<typeof loginByUserCodeSchema>;
export type RefreshTokenBodyDto = z.infer<typeof refreshTokenBodySchema>;
export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;
export type VerifyEmailDto = z.infer<typeof verifyEmailSchema>;
export type LoginResponseDto = {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    userCode: string | null;
    username: string;
  };
};

export type RegisterResponseDto = {
  user: {
    id: string;
    email: string;
    username: string;
    firstName: string;
    lastName: string;
  };
};

export type ForgotPasswordResponseDto = {
  ok: true;
};

export type ResetPasswordResponseDto = {
  ok: true;
};

export type VerifyEmailResponseDto = {
  ok: true;
};
