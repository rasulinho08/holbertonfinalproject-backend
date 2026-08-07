import type { RequestHandler } from 'express';
import type { ZodSchema } from 'zod';
import { ApiError } from '../lib/errors.js';

/**
 * Body validation.
 *
 * On failure this produces `422 VALIDATION_ERROR` with a `fields` map keyed by
 * request-body field name — the app renders those directly under the matching
 * input, so the key has to be the field name the client sent and not a Zod
 * path like `body.email`.
 *
 * The parsed value replaces `req.body`, so handlers receive coerced, stripped,
 * typed data rather than whatever arrived on the wire.
 */
export function validate<T>(schema: ZodSchema<T>): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const fields: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path.join('.') || '_';
        // First issue per field wins; a field with three problems should not
        // overwrite its own message twice before the user sees it.
        fields[key] ??= issue.message;
      }
      const first = result.error.issues[0];
      next(new ApiError('VALIDATION_ERROR', first?.message ?? 'Validation failed', fields));
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Query validation, for endpoints whose query is more than a couple of optional
 * filters. The parsed result lands on `res.locals.query` because Express 5 makes
 * `req.query` a getter — assigning to it throws.
 */
export function validateQuery<T>(schema: ZodSchema<T>): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.query ?? {});
    if (!result.success) {
      const fields: Record<string, string> = {};
      for (const issue of result.error.issues) {
        fields[issue.path.join('.') || '_'] ??= issue.message;
      }
      next(new ApiError('VALIDATION_ERROR', 'Invalid query parameters', fields));
      return;
    }
    res.locals.query = result.data;
    next();
  };
}

/** Reads what `validateQuery` stored. */
export function parsedQuery<T>(res: { locals: Record<string, unknown> }): T {
  return res.locals.query as T;
}
