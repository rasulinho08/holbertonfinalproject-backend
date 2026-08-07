import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { optionalAuth, optionalUserId, requireAuth, userId } from '../../middleware/auth.js';
import { buildMeta, created, noContent, ok, page } from '../../lib/envelope.js';
import { pagination, queryNumber, queryString } from '../../lib/pagination.js';
import * as service from './service.js';
import type { ListScope } from './service.js';

export const listsRouter: Router = Router();

const createSchema = z.object({
  title: z.string().trim().min(3, 'Title must be at least 3 characters').max(120, 'Title is too long'),
  description: z.string().trim().max(400, 'Description is too long').default(''),
});

const updateSchema = z.object({
  title: z.string().trim().min(3).max(120).optional(),
  description: z.string().trim().max(400).optional(),
});

const followSchema = z.object({ follow: z.boolean().default(true) });

const addBookSchema = z.object({
  bookId: z.string().uuid('bookId must be a valid id'),
  note: z.string().trim().max(200, 'Note is too long').optional(),
});

const SCOPES: ListScope[] = ['all', 'mine', 'following'];

listsRouter.get(
  '/',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const raw = queryString(req.query.scope) ?? 'all';
    const scope = (SCOPES as string[]).includes(raw) ? (raw as ListScope) : 'all';

    const result = await service.listLists(
      scope,
      queryString(req.query.q),
      optionalUserId(req),
      skip,
      take,
    );
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

listsRouter.post(
  '/',
  requireAuth,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    created(res, await service.createList(userId(req), req.body.title, req.body.description));
  }),
);

listsRouter.get(
  '/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    // Resolves by id or slug, so /lists/azerbaycan-klassikleri is shareable.
    ok(res, await service.getList(req.params.id!, optionalUserId(req)));
  }),
);

listsRouter.patch(
  '/:id',
  requireAuth,
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    ok(res, await service.updateList(userId(req), req.params.id!, req.body));
  }),
);

listsRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    await service.deleteList(userId(req), req.params.id!);
    noContent(res);
  }),
);

listsRouter.post(
  '/:id/follow',
  requireAuth,
  validate(followSchema),
  asyncHandler(async (req, res) => {
    ok(res, await service.setListFollow(userId(req), req.params.id!, req.body.follow));
  }),
);

listsRouter.post(
  '/:id/books',
  requireAuth,
  validate(addBookSchema),
  asyncHandler(async (req, res) => {
    ok(res, await service.addBook(userId(req), req.params.id!, req.body.bookId, req.body.note));
  }),
);

listsRouter.delete(
  '/:id/books/:bookId',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.removeBook(userId(req), req.params.id!, req.params.bookId!));
  }),
);

/** Mounted under /books — the lists a given book appears on. */
export const bookListsRouter: Router = Router();

bookListsRouter.get(
  '/:bookId/lists',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const limit = Math.min(50, queryNumber(req.query.limit) ?? 10);
    const items = await service.listsForBook(req.params.bookId!, optionalUserId(req), limit);
    page(res, items, buildMeta(items.length, 1, limit));
  }),
);
