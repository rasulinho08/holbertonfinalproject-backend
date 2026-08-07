import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, userId } from '../../middleware/auth.js';
import { buildMeta, created, ok, page } from '../../lib/envelope.js';
import { pagination } from '../../lib/pagination.js';
import { verifyPayment } from '../../integrations/payments.js';
import * as service from './service.js';

const addItemSchema = z.object({
  bookId: z.string().uuid('bookId must be a valid id'),
  quantity: z.coerce.number().int().min(1).max(20, 'At most 20 copies').default(1),
});

const quantitySchema = z.object({
  quantity: z.coerce.number().int().min(0).max(20),
});

const checkoutSchema = z.object({
  paymentMethod: z.enum(['card', 'cod', 'pos_on_delivery', 'wallet']),
  deliveryMethod: z.enum(['courier', 'pickup', 'post']),
  address: z.object({
    fullName: z.string().trim().min(2, 'Name is required').max(80),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9\s-]{7,20}$/, 'Enter a valid phone number'),
    city: z.string().trim().min(2, 'City is required').max(60),
    line: z.string().trim().max(200).default(''),
    note: z.string().trim().max(200).optional(),
  }),
  giftCardCode: z.string().trim().max(40).optional(),
});

/* ---------------------------------- cart ---------------------------------- */

export const cartRouter: Router = Router();

cartRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.getCart(userId(req)));
  }),
);

cartRouter.post(
  '/items',
  requireAuth,
  validate(addItemSchema),
  asyncHandler(async (req, res) => {
    ok(res, await service.addToCart(userId(req), req.body.bookId, req.body.quantity));
  }),
);

cartRouter.patch(
  '/items/:bookId',
  requireAuth,
  validate(quantitySchema),
  asyncHandler(async (req, res) => {
    ok(res, await service.updateCartItem(userId(req), req.params.bookId!, req.body.quantity));
  }),
);

cartRouter.delete(
  '/items/:bookId',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.removeCartItem(userId(req), req.params.bookId!));
  }),
);

cartRouter.delete(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.clearCart(userId(req)));
  }),
);

/* --------------------------------- orders --------------------------------- */

export const ordersRouter: Router = Router();

ordersRouter.post(
  '/',
  requireAuth,
  validate(checkoutSchema),
  asyncHandler(async (req, res) => {
    // The header, not the body: a retried request must carry the same key, and
    // a client that regenerates the body could regenerate the key with it.
    const key = req.headers['idempotency-key'];
    created(
      res,
      await service.checkout(userId(req), {
        ...req.body,
        idempotencyKey: typeof key === 'string' ? key.slice(0, 100) : undefined,
      }),
    );
  }),
);

ordersRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await service.listOrders(userId(req), skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

ordersRouter.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.getOrder(userId(req), req.params.id!));
  }),
);

ordersRouter.post(
  '/:id/cancel',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.cancelOrder(userId(req), req.params.id!));
  }),
);

ordersRouter.get(
  '/:id/receipt',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.orderReceipt(userId(req), req.params.id!));
  }),
);

/* -------------------------- payments, wallet, gifts ------------------------ */

export const paymentsRouter: Router = Router();

paymentsRouter.post(
  '/initiate',
  requireAuth,
  asyncHandler(async (_req, res) => {
    // Checkout captures the card itself; this exists so a client can start a
    // redirect flow for providers that need one.
    ok(res, { reference: `init_${Date.now().toString(36)}`, redirectUrl: null });
  }),
);

paymentsRouter.post(
  '/:reference/verify',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await verifyPayment(req.params.reference!));
  }),
);

export const walletRouter: Router = Router();

walletRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.getWallet(userId(req)));
  }),
);

export const giftCardsRouter: Router = Router();

giftCardsRouter.post(
  '/redeem',
  requireAuth,
  validate(z.object({ code: z.string().trim().min(3, 'Enter a gift card code').max(40) })),
  asyncHandler(async (req, res) => {
    ok(res, await service.redeemGiftCard(userId(req), req.body.code));
  }),
);
