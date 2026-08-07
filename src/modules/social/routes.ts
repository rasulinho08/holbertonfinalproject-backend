import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { optionalAuth, optionalUserId, requireAuth, userId } from '../../middleware/auth.js';
import { buildMeta, created, noContent, ok, page } from '../../lib/envelope.js';
import { pagination, querySort, queryString } from '../../lib/pagination.js';
import * as service from './service.js';

const reviewSchema = z.object({
  bookId: z.string().uuid('bookId must be a valid id'),
  rating: z.coerce.number().int().min(1, 'Rating must be 1–10').max(10, 'Rating must be 1–10'),
  body: z.string().trim().max(5000, 'Review is too long').default(''),
  isSpoiler: z.boolean().default(false),
  photos: z.array(z.string().url()).max(4, 'At most 4 photos').default([]),
});

const reviewUpdateSchema = z.object({
  rating: z.coerce.number().int().min(1).max(10).optional(),
  body: z.string().trim().max(5000).optional(),
  isSpoiler: z.boolean().optional(),
  photos: z.array(z.string().url()).max(4).optional(),
});

const quoteSchema = z.object({
  bookId: z.string().uuid('bookId must be a valid id'),
  text: z.string().trim().min(5, 'Quote is too short').max(1000, 'Quote is too long'),
  page: z.coerce.number().int().positive().nullable().optional(),
  background: z.string().trim().max(30).default('paper'),
  sourceImageUrl: z.string().url().optional(),
});

const commentSchema = z.object({
  body: z.string().trim().min(1, 'Comment cannot be empty').max(1000, 'Comment is too long'),
});

/* -------------------------------- reviews --------------------------------- */

export const reviewsRouter: Router = Router();

reviewsRouter.post(
  '/',
  requireAuth,
  validate(reviewSchema),
  asyncHandler(async (req, res) => {
    created(res, await service.createReview(userId(req), req.body));
  }),
);

reviewsRouter.get(
  '/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.getReview(req.params.id!, optionalUserId(req)));
  }),
);

reviewsRouter.patch(
  '/:id',
  requireAuth,
  validate(reviewUpdateSchema),
  asyncHandler(async (req, res) => {
    ok(res, await service.updateReview(userId(req), req.params.id!, req.body));
  }),
);

reviewsRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    await service.deleteReview(userId(req), req.params.id!);
    noContent(res);
  }),
);

reviewsRouter.post(
  '/:id/like',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.setLike(userId(req), 'review', req.params.id!, true));
  }),
);

reviewsRouter.delete(
  '/:id/like',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.setLike(userId(req), 'review', req.params.id!, false));
  }),
);

reviewsRouter.get(
  '/:id/comments',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.listComments('review', req.params.id!, skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

reviewsRouter.post(
  '/:id/comments',
  requireAuth,
  validate(commentSchema),
  asyncHandler(async (req, res) => {
    created(res, await service.addComment(userId(req), 'review', req.params.id!, req.body.body));
  }),
);

/* --------------------------------- quotes --------------------------------- */

export const quotesRouter: Router = Router();

quotesRouter.get(
  '/',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.listQuotes(
      {
        bookId: queryString(req.query.bookId),
        userId: queryString(req.query.userId),
        sort: querySort(req.query.sort, ['newest', 'popular'] as const, 'newest'),
      },
      optionalUserId(req),
      skip,
      take,
    );
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

quotesRouter.post(
  '/',
  requireAuth,
  validate(quoteSchema),
  asyncHandler(async (req, res) => {
    created(res, await service.createQuote(userId(req), req.body));
  }),
);

quotesRouter.get(
  '/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.getQuote(req.params.id!, optionalUserId(req)));
  }),
);

quotesRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    await service.deleteQuote(userId(req), req.params.id!);
    noContent(res);
  }),
);

quotesRouter.post(
  '/:id/like',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.setLike(userId(req), 'quote', req.params.id!, true));
  }),
);

quotesRouter.delete(
  '/:id/like',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.setLike(userId(req), 'quote', req.params.id!, false));
  }),
);

quotesRouter.get(
  '/:id/comments',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.listComments('quote', req.params.id!, skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

quotesRouter.post(
  '/:id/comments',
  requireAuth,
  validate(commentSchema),
  asyncHandler(async (req, res) => {
    created(res, await service.addComment(userId(req), 'quote', req.params.id!, req.body.body));
  }),
);

/* ------------------ book-scoped review and quote listings ----------------- */

export const bookSocialRouter: Router = Router();

bookSocialRouter.get(
  '/:bookId/reviews',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.bookReviews(req.params.bookId!, optionalUserId(req), skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

bookSocialRouter.get(
  '/:bookId/quotes',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.listQuotes(
      { bookId: req.params.bookId!, sort: 'popular' },
      optionalUserId(req),
      skip,
      take,
    );
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);
