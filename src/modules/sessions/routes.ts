import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, userId } from '../../middleware/auth.js';
import { buildMeta, created, noContent, ok, page } from '../../lib/envelope.js';
import { pagination, queryNumber } from '../../lib/pagination.js';
import * as service from './service.js';

export const sessionsRouter: Router = Router();

const logSchema = z.object({
  bookId: z.string().uuid('bookId must be a valid id'),
  startPage: z.coerce.number().int().min(0, 'startPage cannot be negative'),
  endPage: z.coerce.number().int().min(0, 'endPage cannot be negative'),
  // Zero is allowed: a session logged after the fact has no stopwatch value,
  // and those rows are simply excluded from the speed estimate.
  durationSeconds: z.coerce.number().int().min(0).max(86_400, 'That session is longer than a day'),
  note: z.string().trim().max(280, 'Note is too long').optional(),
});

sessionsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.listSessions(userId(req), skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

sessionsRouter.get(
  '/stats',
  requireAuth,
  asyncHandler(async (req, res) => {
    const days = Math.min(365, Math.max(1, queryNumber(req.query.days) ?? 30));
    ok(res, await service.readingStats(userId(req), days));
  }),
);

sessionsRouter.post(
  '/',
  requireAuth,
  validate(logSchema),
  asyncHandler(async (req, res) => {
    created(res, await service.logSession(userId(req), req.body));
  }),
);

sessionsRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    await service.deleteSession(userId(req), req.params.id!);
    noContent(res);
  }),
);

/** Mounted under /books — sessions for one book. */
export const bookSessionsRouter: Router = Router();

bookSessionsRouter.get(
  '/:bookId/reading-sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.listSessions(userId(req), skip, take, req.params.bookId!);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);
