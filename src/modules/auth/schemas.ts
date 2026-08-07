import { z } from 'zod';

/**
 * Auth request bodies.
 *
 * Messages are English and user-facing: the app renders `fields[key]` straight
 * under the matching input, so "Password must be at least 8 characters" is what
 * the reader sees.
 */

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,20}$/, 'Use 3–20 lowercase letters, numbers or underscores');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long');

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(80, 'Name is too long'),
  username: usernameSchema,
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: passwordSchema,
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
  // Six digits, but the field is only consulted when the account has 2FA on.
  twoFactorCode: z.string().trim().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const oauthSchema = z.object({
  /** Provider-issued identity token; verified against the provider. */
  idToken: z.string().min(1, 'idToken is required'),
  /** Used only when the provider does not return a name — Apple, after first sign-in. */
  name: z.string().trim().max(80).optional(),
});
export type OAuthInput = z.infer<typeof oauthSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'token is required'),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: passwordSchema,
});

export const twoFactorVerifySchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const twoFactorDisableSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});
