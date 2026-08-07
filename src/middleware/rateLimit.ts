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

/** Sign-in, registration and password reset — the credential-stuffing surface. */
export const authLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  // Explicitly per-IP: an attacker enumerating passwords is not authenticated,
  // so there is no user to key on.
  keyGenerator: (req) => req.ip ?? 'unknown',
});

/** OCR calls a paid third party, so it gets its own much tighter budget. */
export const ocrLimiter = rateLimit({ ...shared, windowMs: 60 * 60 * 1000, limit: 30 });

export const writeLimiter = rateLimit({ ...shared, windowMs: 60 * 1000, limit: 120 });

export const readLimiter = rateLimit({ ...shared, windowMs: 60 * 1000, limit: 600 });
