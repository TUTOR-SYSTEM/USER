import { z } from 'zod';
import { ERROR_MESSAGES } from 'src/data/constants';

/** The one password policy for every write: create, register, change, reset, admin create/update. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 100;

/**
 * Complexity rules shared by every password write. Runs only when the length is already valid so
 * a too-short password gets one error, not a stack of complexity errors.
 */
export function refinePasswordComplexity(password: string, ctx: z.RefinementCtx, path: string[]) {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) return;
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (!/[a-z]/.test(password)) issue(ERROR_MESSAGES.AUTH_PASSWORD_LOWERCASE);
  if (!/[A-Z]/.test(password)) issue(ERROR_MESSAGES.AUTH_PASSWORD_UPPERCASE);
  if (!/\d/.test(password)) issue(ERROR_MESSAGES.AUTH_PASSWORD_DIGIT);
  if (!/[^A-Za-z0-9]/.test(password)) issue(ERROR_MESSAGES.AUTH_PASSWORD_SPECIAL);
}

/** Password being set (create/register/change/reset). */
export const newPasswordSchema = z
  .string({ message: ERROR_MESSAGES.AUTH_PASSWORD_REQUIRED })
  .min(PASSWORD_MIN_LENGTH, { message: ERROR_MESSAGES.AUTH_PASSWORD_MIN })
  .max(PASSWORD_MAX_LENGTH, { message: ERROR_MESSAGES.AUTH_PASSWORD_MAX })
  .superRefine((password, ctx) => refinePasswordComplexity(password, ctx, []));

/**
 * Password presented at login. No minimum so accounts created before the policy (e.g. 6-character
 * passwords) can still sign in; the cap keeps bcrypt input bounded.
 */
export const loginPasswordSchema = z
  .string({ message: ERROR_MESSAGES.AUTH_PASSWORD_REQUIRED })
  .min(1, { message: ERROR_MESSAGES.AUTH_PASSWORD_REQUIRED })
  .max(PASSWORD_MAX_LENGTH, { message: ERROR_MESSAGES.AUTH_PASSWORD_MAX });
