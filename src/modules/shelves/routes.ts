import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, userId } from '../../middleware/auth.js';
import { buildMeta, ok, page } from '../../lib/envelope.js';
import { pagination } from '../../lib/pagination.js';
import * as service from './service.js';
import { SHELF_STATUSES } from './service.js';

export const shelvesRouter: Router = Router();

const shelfNameSchema = z.object({
  name: z.string().trim().min(1, 'Shelf name is required').max(60, 'Shelf name is too long'),
});

const setShelfSchema = z.object({
  status: z.enum(SHELF_STATUSES as [string, ...string[]], {
    errorMap: () => ({ message: 'status must be reading, read, want_to_read or dnf' }),
  }),
  shelfId: z.string().uuid().optional(),
  progressPage: z.coerce.number().int().min(0).optional(),
});

const progressSchema = z.object({
  page: z.coerce.number().int().min(0, 'page cannot be negative'),
});

shelvesRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.listShelves(userId(req)));
  }),
);

shelvesRouter.post(
  '/',
  requireAuth,
  validate(shelfNameSchema),
  asyncHandler(async (req, res) => {
    // The full list, not the new shelf — the client replaces its cache with it.
    ok(res, await service.createShelf(userId(req), req.body.name), 201);
  }),
);

shelvesRouter.patch(
  '/:id',
  requireAuth,
  validate(shelfNameSchema),
  asyncHandler(async (req, res) => {
    ok(res, await service.renameShelf(userId(req), req.params.id!, req.body.name));
  }),
);

shelvesRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.deleteShelf(userId(req), req.params.id!));
  }),
);

shelvesRouter.get(
  '/:id/books',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.shelfBooks(userId(req), req.params.id!, skip, take);
    page(res, result.entries, buildMeta(result.total, pageNumber, limit));
  }),
);

/* ------------------- book-scoped shelf and progress routes ----------------- */
/* Mounted under /books, so they live in their own router.                     */

export const bookShelfRouter: Router = Router();

bookShelfRouter.put(
  '/:bookId/shelf',
  requireAuth,
  validate(setShelfSchema),
  asyncHandler(async (req, res) => {
    ok(
      res,
      await service.setBookShelf(userId(req), req.params.bookId!, {
        status: service.assertShelfStatus(req.body.status),
        shelfId: req.body.shelfId,
        progressPage: req.body.progressPage,
      }),
    );
  }),
);

bookShelfRouter.delete(
  '/:bookId/shelf',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.removeBookShelf(userId(req), req.params.bookId!));
  }),
);

bookShelfRouter.patch(
  '/:bookId/progress',
  requireAuth,
  validate(progressSchema),
  asyncHandler(async (req, res) => {
    ok(res, await service.updateProgress(userId(req), req.params.bookId!, req.body.page));
  }),
);
