import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { optionalAuth, requireRole, userId } from '../../middleware/auth.js';
import { buildMeta, created, noContent, ok, page } from '../../lib/envelope.js';
import { pagination } from '../../lib/pagination.js';
import * as service from './service.js';
import { publicationCreateSchema, publicationUpdateSchema } from './schemas.js';

/* --------------------------------- public --------------------------------- */

/**
 * Read endpoints are available to everyone — signed out browsers, guests, any
 * role. The list shows an excerpt; the full body is only in the detail.
 *
 * `optionalAuth` is used rather than `requireAuth` so the catalog stays
 * browsable without an account, matching how books, quotes and lists work.
 */

export const postsRouter: Router = Router();

postsRouter.get(
  '/',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.listPublications(skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

postsRouter.get(
  '/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.getPublication(req.params.id!));
  }),
);

/* --------------------------------- admin ---------------------------------- */

/**
 * Writes are mounted separately so requireRole('admin') only guards them.
 *
 * The route file registers both routers at `/posts`. Express evaluates
 * handlers in order, so a request like `POST /posts` falls through the
 * `optionalAuth` guarded GETs above and hits `adminPostsRouter` below.
 */

export const adminPostsRouter: Router = Router();

adminPostsRouter.use(...requireRole('admin'));

adminPostsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.listPublications(skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

adminPostsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    ok(res, await service.getPublication(req.params.id!));
  }),
);

adminPostsRouter.post(
  '/',
  validate(publicationCreateSchema),
  asyncHandler(async (req, res) => {
    created(
      res,
      await service.createPublication(userId(req), req.body),
    );
  }),
);

adminPostsRouter.put(
  '/:id',
  validate(publicationUpdateSchema),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await service.updatePublication(userId(req), req.params.id!, req.body),
    );
  }),
);

adminPostsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await service.deletePublication(userId(req), req.params.id!);
    noContent(res);
  }),
);
