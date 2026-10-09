import crypto from 'node:crypto';

/**
 * Environment for the integration suite.
 *
 * Every run gets its own throwaway database, created and dropped by
 * `global-setup.ts`. Nothing pre-existing is ever reset or truncated, so the
 * suite cannot damage a development or production database even if it is
 * pointed at the wrong server.
 *
 * TEST_DATABASE_URL is only a way in: a connection to any database on the
 * server (by default the `postgres` maintenance database) through which the
 * suite issues CREATE DATABASE / DROP DATABASE for its own database. The role
 * needs the CREATEDB privilege.
 */

const DEFAULT_ADMIN_URL = 'postgresql://kitabdostu:kitabdostu@localhost:5432/postgres';

export const TEST_ADMIN_URL = process.env.TEST_DATABASE_URL ?? DEFAULT_ADMIN_URL;

// vitest.config.ts and global-setup.ts are loaded as separate module instances
// in the same process; the environment is what they reliably share.
process.env.KD_TEST_DB_NAME ??= `kitabdostu_test_${crypto.randomBytes(4).toString('hex')}`;

/** The disposable database this run creates, uses and drops. */
export const TEST_DB_NAME = process.env.KD_TEST_DB_NAME;

if (!/^kitabdostu_test_[a-z0-9]+$/.test(TEST_DB_NAME)) {
  throw new Error(`Unexpected test database name: ${TEST_DB_NAME}`);
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  parsed.searchParams.set('schema', 'public');
  return parsed.toString();
}

export const TEST_DATABASE_URL = withDatabase(TEST_ADMIN_URL, TEST_DB_NAME);

/** Every seeded account signs in with this in tests. */
export const TEST_SEED_PASSWORD = 'test-password-123';

export const testEnv: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DATABASE_URL,
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
  CORS_ORIGINS: 'http://localhost:8081',
  SEED_PASSWORD: TEST_SEED_PASSWORD,
};
