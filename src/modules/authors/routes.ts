import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { optionalAuth, optionalUserId, requireAuth, userId } from '../../middleware/auth.js';
import { buildMeta, ok, page } from '../../lib/envelope.js';
import { pagination } from '../../lib/pagination.js';
import * as service from './service.js';

export const authorsRouter: Router = Router();

authorsRouter.get(
  '/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.getAuthor(req.params.id!, optionalUserId(req)));
  }),
);

authorsRouter.get(
  '/:id/books',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.authorBooks(req.params.id!, skip, take, optionalUserId(req));
    page(res, result.books, buildMeta(result.total, pageNumber, limit));
  }),
);

authorsRouter.post(
  '/:id/follow',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.setAuthorFollow(userId(req), req.params.id!, true));
  }),
);

authorsRouter.delete(
  '/:id/follow',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.setAuthorFollow(userId(req), req.params.id!, false));
  }),
);
