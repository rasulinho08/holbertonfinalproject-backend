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

/**
 * Account types open to self-registration.
 *
 * `admin` is deliberately absent. It is granted from the moderation dashboard,
 * never claimed — a role field that accepted it would make the register
 * endpoint a privilege-escalation hole for anyone who can send a POST.
 */
export const ACCOUNT_TYPES = ['reader', 'author', 'publisher'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is too short').max(80, 'Name is too long'),
    username: usernameSchema,
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
    password: passwordSchema,
    accountType: z.enum(ACCOUNT_TYPES).default('reader'),
    /** Writers: the name that goes on the books. Defaults to `name`. */
    penName: z.string().trim().min(2, 'Pen name is too short').max(80).optional(),
    /** Writers: seeds the public author page, so it is not blank on day one. */
    bio: z.string().trim().max(600, 'Bio is too long').optional(),
    /** Publishers: the imprint this account acts for. */
    publisherName: z
      .string()
      .trim()
      .min(2, 'Publisher name is too short')
      .max(80, 'Publisher name is too long')
      .optional(),
    publisherCity: z.string().trim().max(60).optional(),
  })
  // Enforced here rather than in the service so the message lands on the field
  // the app is already rendering errors under.
  .refine((v) => v.accountType !== 'publisher' || !!v.publisherName, {
    message: 'Publisher name is required',
    path: ['publisherName'],
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
