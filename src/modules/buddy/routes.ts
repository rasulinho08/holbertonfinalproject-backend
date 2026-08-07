import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, userId } from '../../middleware/auth.js';
import { buildMeta, created, noContent, ok, page } from '../../lib/envelope.js';
import { pagination } from '../../lib/pagination.js';
import * as service from './service.js';

export const buddyRouter: Router = Router();

const createSchema = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(80, 'Name is too long'),
  bookId: z.string().uuid('bookId must be a valid id'),
  targetDate: z.string().datetime().nullable().optional(),
});

const progressSchema = z.object({
  page: z.coerce.number().int().min(0),
});

const messageSchema = z.object({
  body: z.string().trim().min(1, 'Message cannot be empty').max(2000, 'Message is too long'),
  chapter: z.coerce.number().int().positive().nullable().optional(),
});

buddyRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.listBuddyReads(userId(req), skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

buddyRouter.post(
  '/',
  requireAuth,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    created(res, await service.createBuddyRead(userId(req), req.body));
  }),
);

buddyRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.getBuddyRead(req.params.id!));
  }),
);

buddyRouter.post(
  '/:id/join',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.joinBuddyRead(userId(req), req.params.id!));
  }),
);

buddyRouter.delete(
  '/:id/members/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    await service.leaveBuddyRead(userId(req), req.params.id!);
    noContent(res);
  }),
);

buddyRouter.patch(
  '/:id/progress',
  requireAuth,
  validate(progressSchema),
  asyncHandler(async (req, res) => {
    ok(res, await service.updateBuddyProgress(userId(req), req.params.id!, req.body.page));
  }),
);

buddyRouter.get(
  '/:id/messages',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.listMessages(userId(req), req.params.id!, skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

buddyRouter.post(
  '/:id/messages',
  requireAuth,
  validate(messageSchema),
  asyncHandler(async (req, res) => {
    created(
      res,
      await service.postMessage(
        userId(req),
        req.params.id!,
        req.body.body,
        req.body.chapter ?? null,
      ),
    );
  }),
);
