import { z } from 'zod';
import { ERROR_MESSAGES } from 'src/data/constants';
import {
  loginPasswordSchema,
  newPasswordSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './password.schema';

export const AUTH_MESSAGES = {
  EMAIL_REQUIRED: ERROR_MESSAGES.AUTH_EMAIL_REQUIRED,
  EMAIL_INVALID: ERROR_MESSAGES.AUTH_EMAIL_INVALID,
  USERNAME_REQUIRED: ERROR_MESSAGES.AUTH_USERNAME_REQUIRED,
  USERNAME_MAX: ERROR_MESSAGES.AUTH_USERNAME_MAX,
  PASSWORD_REQUIRED: ERROR_MESSAGES.AUTH_PASSWORD_REQUIRED,
  PASSWORD_MIN: ERROR_MESSAGES.AUTH_PASSWORD_MIN,
  PASSWORD_MAX: ERROR_MESSAGES.AUTH_PASSWORD_MAX,
  PASSWORD_LOWERCASE: ERROR_MESSAGES.AUTH_PASSWORD_LOWERCASE,
  PASSWORD_UPPERCASE: ERROR_MESSAGES.AUTH_PASSWORD_UPPERCASE,
  PASSWORD_DIGIT: ERROR_MESSAGES.AUTH_PASSWORD_DIGIT,
  PASSWORD_SPECIAL: ERROR_MESSAGES.AUTH_PASSWORD_SPECIAL,
  FIRST_NAME_REQUIRED: ERROR_MESSAGES.AUTH_FIRST_NAME_REQUIRED,
  FIRST_NAME_MAX: ERROR_MESSAGES.AUTH_FIRST_NAME_MAX,
  LAST_NAME_REQUIRED: ERROR_MESSAGES.AUTH_LAST_NAME_REQUIRED,
  LAST_NAME_MAX: ERROR_MESSAGES.AUTH_LAST_NAME_MAX,
  REFRESH_TOKEN_REQUIRED: ERROR_MESSAGES.AUTH_REFRESH_TOKEN_REQUIRED,
  RESET_TOKEN_REQUIRED: ERROR_MESSAGES.AUTH_RESET_TOKEN_REQUIRED,
  RESET_TOKEN_INVALID: ERROR_MESSAGES.AUTH_RESET_TOKEN_INVALID,
  VERIFY_EMAIL_TOKEN_REQUIRED: ERROR_MESSAGES.AUTH_VERIFY_EMAIL_TOKEN_REQUIRED,
  VERIFY_EMAIL_TOKEN_INVALID: ERROR_MESSAGES.AUTH_VERIFY_EMAIL_TOKEN_INVALID,
  CONFIRM_PASSWORD_REQUIRED: ERROR_MESSAGES.AUTH_CONFIRM_PASSWORD_REQUIRED,
  CONFIRM_PASSWORD_MIN: ERROR_MESSAGES.AUTH_CONFIRM_PASSWORD_MIN,
  CONFIRM_PASSWORD_MAX: ERROR_MESSAGES.AUTH_CONFIRM_PASSWORD_MAX,
  CONFIRM_PASSWORD_MISMATCH: ERROR_MESSAGES.AUTH_CONFIRM_PASSWORD_MISMATCH,
} as const;

export const emailFieldSchema = z
  .string({ message: AUTH_MESSAGES.EMAIL_REQUIRED })
  .min(1, { message: AUTH_MESSAGES.EMAIL_REQUIRED })
  .email({ message: AUTH_MESSAGES.EMAIL_INVALID });

export const registerSchema = z.object({
  email: emailFieldSchema,
  username: z
    .string({ message: AUTH_MESSAGES.USERNAME_REQUIRED })
    .max(50, { message: AUTH_MESSAGES.USERNAME_MAX })
    .optional(),
  password: newPasswordSchema,
  firstName: z
    .string({ message: AUTH_MESSAGES.FIRST_NAME_REQUIRED })
    .min(1, { message: AUTH_MESSAGES.FIRST_NAME_REQUIRED })
    .max(25, { message: AUTH_MESSAGES.FIRST_NAME_MAX }),
  lastName: z
    .string({ message: AUTH_MESSAGES.LAST_NAME_REQUIRED })
    .min(1, { message: AUTH_MESSAGES.LAST_NAME_REQUIRED })
    .max(25, { message: AUTH_MESSAGES.LAST_NAME_MAX }),
});

export const loginSchema = z.object({
  email: emailFieldSchema,
  password: loginPasswordSchema,
});

export const loginByUserCodeSchema = z.object({
  userCode: z
    .string({ message: ERROR_MESSAGES.AUTH_USER_CODE_REQUIRED })
    .min(6, { message: ERROR_MESSAGES.AUTH_USER_CODE_LENGTH })
    .max(6, { message: ERROR_MESSAGES.AUTH_USER_CODE_LENGTH }),
  password: loginPasswordSchema,
  role: z.enum(['PARENT', 'STUDENT']),
});

export const refreshTokenBodySchema = z.object({
  refreshToken: z
    .string({ message: AUTH_MESSAGES.REFRESH_TOKEN_REQUIRED })
    .min(1, { message: AUTH_MESSAGES.REFRESH_TOKEN_REQUIRED }),
});

export const forgotPasswordSchema = z.object({
  email: emailFieldSchema,
});

const resetPasswordBodySchema = z
  .object({
    jti: z
      .string({ message: AUTH_MESSAGES.RESET_TOKEN_REQUIRED })
      .uuid({ message: AUTH_MESSAGES.RESET_TOKEN_INVALID }),
    password: newPasswordSchema,
    confirmPassword: z
      .string({ message: AUTH_MESSAGES.CONFIRM_PASSWORD_REQUIRED })
      .min(PASSWORD_MIN_LENGTH, { message: AUTH_MESSAGES.CONFIRM_PASSWORD_MIN })
      .max(PASSWORD_MAX_LENGTH, { message: AUTH_MESSAGES.CONFIRM_PASSWORD_MAX }),
  })
  .superRefine((data, ctx) => {
    if (data.password !== data.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: AUTH_MESSAGES.CONFIRM_PASSWORD_MISMATCH,
        path: ['confirmPassword'],
      });
    }
  });

/** Accept either `password` or `newPassword` (same meaning). */
export const resetPasswordSchema = z.preprocess((val) => {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const o = val as Record<string, unknown>;
    if (o.newPassword != null && o.password == null) {
      return { ...o, password: o.newPassword };
    }
  }
  return val;
}, resetPasswordBodySchema);

export const verifyEmailSchema = z.object({
  jti: z
    .string({ message: AUTH_MESSAGES.VERIFY_EMAIL_TOKEN_REQUIRED })
    .uuid({ message: AUTH_MESSAGES.VERIFY_EMAIL_TOKEN_INVALID }),
});
