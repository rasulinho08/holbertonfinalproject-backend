import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { publisherId, requireRole, userId } from '../../middleware/auth.js';
import { buildMeta, created, noContent, ok, page } from '../../lib/envelope.js';
import { pagination, queryString } from '../../lib/pagination.js';
import * as service from './service.js';
import type { OrderStatus } from '@prisma/client';

export const publisherRouter: Router = Router();

const bookSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  authorName: z.string().trim().min(2, 'Author is required').max(120),
  isbn: z.string().trim().max(20).optional(),
  language: z.enum(['az', 'en', 'tr', 'ru']).default('az'),
  genres: z.array(z.string()).min(1, 'Pick at least one genre').max(3),
  description: z.string().trim().max(4000).default(''),
  coverUrl: z.string().url().nullable().optional(),
  pageCount: z.coerce.number().int().min(1, 'Page count must be positive').max(5000),
  publishedYear: z.coerce.number().int().min(800).max(2100),
  price: z.coerce.number().min(0, 'Price cannot be negative').max(10_000),
  stock: z.coerce.number().int().min(0).max(100_000),
});

const bookPatchSchema = bookSchema.partial();

const statusSchema = z.object({
  status: z.enum([
    'pending',
    'confirmed',
    'preparing',
    'shipped',
    'out_for_delivery',
    'delivered',
    'cancelled',
  ]),
  note: z.string().trim().max(200).optional(),
});

/** Every route requires the publisher role; the id comes from the token. */
publisherRouter.use(...requireRole('publisher'));

publisherRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    ok(res, await service.publisherStats(publisherId(req)));
  }),
);

publisherRouter.get(
  '/books',
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.publisherBooks(publisherId(req), skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

publisherRouter.post(
  '/books',
  validate(bookSchema),
  asyncHandler(async (req, res) => {
    created(res, await service.createPublisherBook(publisherId(req), req.body));
  }),
);

publisherRouter.patch(
  '/books/:id',
  validate(bookPatchSchema),
  asyncHandler(async (req, res) => {
    ok(res, await service.updatePublisherBook(publisherId(req), req.params.id!, req.body));
  }),
);

publisherRouter.delete(
  '/books/:id',
  asyncHandler(async (req, res) => {
    await service.deletePublisherBook(publisherId(req), req.params.id!);
    noContent(res);
  }),
);

publisherRouter.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const status = queryString(req.query.status) as OrderStatus | undefined;
    const result = await service.publisherOrders(publisherId(req), status, skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

publisherRouter.patch(
  '/orders/:id/status',
  validate(statusSchema),
  asyncHandler(async (req, res) => {
    await service.updateOrderStatus(
      publisherId(req),
      req.params.id!,
      req.body.status,
      userId(req),
      req.body.note,
    );
    ok(res, { success: true });
  }),
);
