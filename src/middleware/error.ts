import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../lib/errors.js';
import { isUniqueViolation, isNotFoundError, isForeignKeyViolation } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

/**
 * Wraps an async handler so a rejected promise reaches the error middleware.
 *
 * Express 4 does not await handlers: an async function that throws produces an
 * unhandled rejection and a request that hangs until the client times out.
 * Every route is registered through this.
 */
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * True when a query failed because an id was not a valid uuid.
 *
 * Prisma surfaces this two ways depending on whether the query went through the
 * query builder (`P2023`) or `$queryRaw` (Postgres `22P02`, wrapped in an
 * unknown-request error whose message carries the code).
 */
function isMalformedId(err: unknown): boolean {
  const error = err as { code?: string; message?: string };
  if (error?.code === 'P2023') return true;
  const message = error?.message ?? '';
  return (
    message.includes('22P02') ||
    message.includes('invalid input syntax for type uuid') ||
    message.includes('Inconsistent column data')
  );
}

/** 404 for anything that fell through the router. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route for ${req.method} ${req.path}`,
    },
  });
};

/**
 * Translates every thrown value into the error envelope.
 *
 * The important rule is the last one: an unrecognised error becomes a generic
 * 500 with no detail. CONVENTIONS.md §3 — "a 500 must not contain a stack trace
 * or SQL text" — and Prisma's messages happily include table and column names.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.fields && { fields: err.fields }) },
    });
    return;
  }

  if (err instanceof ZodError) {
    // Body validation normally runs through `validate()`, which formats issues
    // itself. This catches schemas parsed inside a service.
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '_';
      fields[key] ??= issue.message;
    }
    res.status(422).json({
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', fields },
    });
    return;
  }

  // `express.json()` throws a SyntaxError on a body it cannot parse — a
  // truncated upload, a client that forgot to stringify. That is the client's
  // mistake, so it deserves a 4xx; without this it fell through to the generic
  // handler and reported 500, which points the blame at the wrong side.
  if (err instanceof SyntaxError && 'body' in (err as unknown as Record<string, unknown>)) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON' },
    });
    return;
  }

  if (isUniqueViolation(err)) {
    res.status(409).json({
      error: { code: 'CONFLICT', message: 'That record already exists' },
    });
    return;
  }

  if (isNotFoundError(err)) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
    return;
  }

  if (isForeignKeyViolation(err)) {
    res.status(422).json({
      error: { code: 'VALIDATION_ERROR', message: 'Referenced record does not exist' },
    });
    return;
  }

  // A path parameter that is not a uuid reaches Postgres as one and is rejected
  // there — Prisma reports P2023, a raw query reports SQLSTATE 22P02. Either
  // way the honest answer is "no such resource", not a 500 carrying a database
  // error message. Any client with a stale or hand-typed id hits this.
  if (isMalformedId(err)) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
    return;
  }

  // Genuinely unexpected. Log everything, return nothing.
  logger.error(
    { err, requestId: res.getHeader('X-Request-Id'), path: req.path, method: req.method },
    'Unhandled error',
  );

  res.status(500).json({
    error: {
      code: 'SERVER_ERROR',
      message: env.isProduction
        ? 'Something went wrong'
        : `Something went wrong: ${(err as Error)?.message ?? 'unknown'}`,
    },
  });
};
