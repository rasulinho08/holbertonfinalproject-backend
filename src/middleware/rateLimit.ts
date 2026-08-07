import rateLimit, { type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../config/env.js';

/**
 * Rate limits from backend-guide/CONVENTIONS.md §12.
 *
 * Keyed per user when authenticated and per IP otherwise: keying purely on IP
 * would let one user behind a shared NAT — a university network, say — exhaust
 * the budget for everyone on it.
 *
 * The store is in-memory, which means limits are per process. That is fine for
 * one instance; behind a load balancer, swap in the Redis store. The rest of
 * the code does not care which.
 */

function keyFor(req: Request): string {
  return req.auth?.sub ?? req.ip ?? 'unknown';
}

const shared: Partial<Options> = {
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyFor,
  // Limits exist to slow down abuse, not to make the test suite flaky.
  skip: () => env.isTest,
  handler: (_req, res, _next, options) => {
    res.setHeader('Retry-After', Math.ceil(options.windowMs / 1000));
    res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
    });
  },
};

/**
 * Sign-in, registration and password reset — the credential-stuffing surface.
 *
 * CONVENTIONS.md §12 sets this at 10 per 15 minutes, which is right in
 * production and actively unhelpful in development: a smoke run signs in as
 * three different accounts several times over, and a developer restarting the
 * app hits the wall within minutes. There is no credential-stuffing surface on
 * localhost, so the window is loosened outside production rather than turned
 * off entirely — the limiter still runs, so a bug in it surfaces during
 * development rather than in production.
 */
export const authLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  limit: env.isProduction ? 10 : 500,
  // Explicitly per-IP: an attacker enumerating passwords is not authenticated,
  // so there is no user to key on.
  keyGenerator: (req) => req.ip ?? 'unknown',
});

/** OCR calls a paid third party, so it keeps its tight budget everywhere. */
export const ocrLimiter = rateLimit({ ...shared, windowMs: 60 * 60 * 1000, limit: 30 });

/**
 * General read and write budgets.
 *
 * The production figures are CONVENTIONS.md §12: 120 writes and 600 reads per
 * minute per user. No human approaches either — but the integration suite makes
 * roughly 156 requests in a few seconds, and a developer running it twice in a
 * row was getting throttled, which surfaces as a wall of unrelated failures
 * rather than as a rate-limit message.
 *
 * Loosened outside production for the same reason as `authLimiter`: the
 * middleware still runs, so a bug in it still shows up in development, but the
 * ceiling is not one a test run can reach.
 */
export const writeLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: env.isProduction ? 120 : 5000,
});

export const readLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: env.isProduction ? 600 : 10_000,
});
