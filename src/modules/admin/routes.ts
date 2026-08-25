import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, userId } from '../../middleware/auth.js';
import { buildMeta, created, noContent, ok, page } from '../../lib/envelope.js';
import { pagination, queryString } from '../../lib/pagination.js';
import { deleteQuote, deleteReview } from '../social/service.js';
import { adminPostsRouter } from '../posts/routes.js';
import * as service from './service.js';
import type { ReportStatus } from '@prisma/client';

/* -------------------------------- reports --------------------------------- */
/* Filing a report is open to any signed-in reader; the queue is admin-only.   */

export const reportsRouter: Router = Router();

const reportSchema = z.object({
  targetType: z.enum(['review', 'quote']),
  targetId: z.string().uuid('targetId must be a valid id'),
  reason: z.enum(['spam', 'offensive', 'spoiler', 'copyright', 'other']),
  note: z.string().trim().max(500).optional(),
});

reportsRouter.post(
  '/',
  requireAuth,
  validate(reportSchema),
  asyncHandler(async (req, res) => {
    created(
      res,
      await service.createReport(
        userId(req),
        req.body.targetType,
        req.body.targetId,
        req.body.reason,
        req.body.note ?? null,
      ),
    );
  }),
);

/* --------------------------------- admin ---------------------------------- */

export const adminRouter: Router = Router();

adminRouter.use(...requireRole('admin'));

const resolveSchema = z.object({
  action: z.enum(['kept', 'removed']),
  note: z.string().trim().max(500).optional(),
});

adminRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    ok(res, await service.adminStats());
  }),
);

adminRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.adminUsers(queryString(req.query.q), skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

adminRouter.get(
  '/reports',
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const raw = queryString(req.query.status);
    const status = (['open', 'kept', 'removed'] as string[]).includes(raw ?? '')
      ? (raw as ReportStatus)
      : undefined;
    const result = await service.listReports(status, skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

adminRouter.patch(
  '/reports/:id',
  validate(resolveSchema),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await service.resolveReport(userId(req), req.params.id!, req.body.action, req.body.note),
    );
  }),
);

adminRouter.get(
  '/reviews',
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.adminReviews(skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

adminRouter.delete(
  '/reviews/:id',
  asyncHandler(async (req, res) => {
    // `asModerator` skips the ownership check but still soft-deletes, so the
    // text survives for the audit trail.
    await deleteReview(userId(req), req.params.id!, true);
    await service.recordAdminAction(userId(req), 'review_removed', 'review', req.params.id!);
    noContent(res);
  }),
);

adminRouter.get(
  '/quotes',
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.adminQuotes(skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

adminRouter.delete(
  '/quotes/:id',
  asyncHandler(async (req, res) => {
    await deleteQuote(userId(req), req.params.id!, true);
    await service.recordAdminAction(userId(req), 'quote_removed', 'quote', req.params.id!);
    noContent(res);
  }),
);

adminRouter.use('/posts', adminPostsRouter);
