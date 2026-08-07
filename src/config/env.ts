import 'dotenv/config';
import { z } from 'zod';

/**
 * Typed environment.
 *
 * Parsed once, at boot, and the process exits if anything required is missing.
 * A misconfigured server should fail immediately with a readable message rather
 * than at 3am on the one request that happens to need `JWT_REFRESH_SECRET`.
 *
 * `dotenv/config` is imported first, and this module is imported before
 * anything else that reads config. The Prisma CLI loads `.env` on its own, so
 * migrations worked while the server did not — which is a confusing way to
 * discover the file was never being read.
 */

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — see .env.example'),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  CORS_ORIGINS: z.string().default('http://localhost:8081'),

  DEFAULT_TIMEZONE: z.string().default('Asia/Baku'),
  DEFAULT_LOCALE: z.enum(['az', 'en']).default('az'),

  // Integrations. All optional: each one falls back to a stub when its key is
  // absent, so a fresh clone runs without a single third-party account.
  PAYRIFF_MERCHANT_ID: z.string().optional(),
  PAYRIFF_SECRET_KEY: z.string().optional(),
  PAYRIFF_BASE_URL: z.string().default('https://api.payriff.com/api/v2'),

  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  APPLE_OAUTH_CLIENT_ID: z.string().optional(),
  FACEBOOK_OAUTH_APP_ID: z.string().optional(),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().optional(),

  SMS_PROVIDER_KEY: z.string().optional(),
  SMS_SENDER: z.string().default('KitabDostu'),

  EXPO_PUSH_ACCESS_TOKEN: z.string().optional(),

  OCR_PROVIDER: z.string().default('stub'),
  OCR_PROVIDER_KEY: z.string().optional(),

  GOOGLE_BOOKS_API_KEY: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('KitabDostu <noreply@kitabdostu.az>'),
  APP_RESET_URL: z.string().default('http://localhost:8081/reset-password'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  console.error(`\nInvalid environment:\n${lines.join('\n')}\n\nCopy .env.example to .env.\n`);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};

/**
 * In production, the placeholder secrets from `.env.example` are a real
 * vulnerability rather than a nuisance, so refuse to start with them.
 */
if (env.isProduction) {
  const placeholders = [env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET].filter((s) =>
    s.includes('dev-only') || s.includes('change-me'),
  );
  if (placeholders.length > 0) {
    console.error('\nRefusing to start: JWT secrets are still the .env.example placeholders.\n');
    process.exit(1);
  }
}

export type Env = typeof env;
