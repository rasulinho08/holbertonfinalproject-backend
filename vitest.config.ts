import { defineConfig } from 'vitest/config';
import { testEnv } from './tests/test-env.js';

/**
 * Integration tests: real Express app (via Supertest) against a real
 * PostgreSQL database, reset and seeded by `tests/global-setup.ts`.
 *
 * Files run one at a time because they share that database.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
    env: testEnv,
  },
});
