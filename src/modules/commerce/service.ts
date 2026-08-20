import type { DeliveryMethod, OrderStatus, PaymentMethod, Prisma } from '@prisma/client';
import { prisma, money, isUniqueViolation } from '../../lib/prisma.js';
import { ApiError, badRequest, conflict, forbidden, notFound, outOfStock } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { bookInclude, serializeBook, type SerializedBook } from '../books/service.js';
import { notify } from '../notifications/service.js';
import { chargeCard } from '../../integrations/payments.js';

/**
 * Cart, checkout and orders.
 *
 * The rule that shapes everything here is CONVENTIONS.md §15.5: a cart holding
 * books from N publishers becomes N orders at checkout, each with its own
 * delivery fee and status timeline. Publishers ship independently, so a single
 * order spanning three of them could never have one truthful status.
 */

/** Flat fee per publisher shipment. Free above the threshold. */
const DELIVERY_FEES: Record<DeliveryMethod, number> = {
  courier: 3.5,
  post: 2.5,
  pickup: 0,
};
const FREE_DELIVERY_OVER = 40;

export interface CartItemView {
  bookId: string;
  book: SerializedBook;
  quantity: number;
}

export interface CartGroup {
  publisherId: string;
  publisherName: string;
  items: CartItemView[];
  subtotal: number;
  deliveryFee: number;
}

export interface CartSummary {
  groups: CartGroup[];
  itemCount: number;
  subtotal: number;
  deliveryTotal: number;
  discount: number;
  total: number;
}

export async function getCart(
  userId: string,
  deliveryMethod: DeliveryMethod = 'courier',
): Promise<CartSummary> {
  const items = await prisma.cartItem.findMany({
    where: { userId },
    include: { book: { include: bookInclude } },
    orderBy: { addedAt: 'desc' },
  });

  // Grouped by publisher because that is the shape checkout produces, and
  // showing it in the cart means the split is not a surprise at payment.
  const groups = new Map<string, CartGroup>();

  for (const item of items) {
    if (item.book.deletedAt) continue;
    const key = item.book.publisherId;
    if (!groups.has(key)) {
      groups.set(key, {
        publisherId: key,
        publisherName: item.book.publisher.name,
        items: [],
        subtotal: 0,
        deliveryFee: 0,
      });
    }
    const group = groups.get(key)!;
    group.items.push({
      bookId: item.bookId,
      book: serializeBook(item.book),
      quantity: item.quantity,
    });
    group.subtotal += money(item.book.price) * item.quantity;
  }

  let subtotal = 0;
  let deliveryTotal = 0;

  for (const group of groups.values()) {
    group.subtotal = Math.round(group.subtotal * 100) / 100;
    group.deliveryFee =
      group.subtotal >= FREE_DELIVERY_OVER ? 0 : DELIVERY_FEES[deliveryMethod];
    subtotal += group.subtotal;
    deliveryTotal += group.deliveryFee;
  }

  return {
    groups: [...groups.values()],
    itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
    subtotal: round(subtotal),
    deliveryTotal: round(deliveryTotal),
    discount: 0,
    total: round(subtotal + deliveryTotal),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

export async function addToCart(
  userId: string,
  bookId: string,
  quantity: number,
): Promise<CartSummary> {
  const book = await prisma.book.findFirst({
    where: { id: bookId, deletedAt: null },
    select: { id: true, stock: true },
  });
  if (!book) throw notFound('Book');

  const existing = await prisma.cartItem.findUnique({
    where: { userId_bookId: { userId, bookId } },
  });
  const wanted = (existing?.quantity ?? 0) + quantity;

  // Checked here as well as at checkout: telling someone at payment that a book
  // they added an hour ago is gone is a worse experience than telling them now.
  if (wanted > book.stock) {
    throw outOfStock(`Only ${book.stock} left in stock`);
  }

  await prisma.cartItem.upsert({
    where: { userId_bookId: { userId, bookId } },
    create: { userId, bookId, quantity },
    update: { quantity: wanted },
  });

  return getCart(userId);
}

export async function updateCartItem(
  userId: string,
  bookId: string,
  quantity: number,
): Promise<CartSummary> {
  if (quantity <= 0) {
    await prisma.cartItem.deleteMany({ where: { userId, bookId } });
    return getCart(userId);
  }

  const book = await prisma.book.findFirst({
    where: { id: bookId, deletedAt: null },
    select: { stock: true },
  });
  if (!book) throw notFound('Book');
  if (quantity > book.stock) throw outOfStock(`Only ${book.stock} left in stock`);

  await prisma.cartItem.update({
    where: { userId_bookId: { userId, bookId } },
    data: { quantity },
  });
  return getCart(userId);
}

export async function removeCartItem(userId: string, bookId: string): Promise<CartSummary> {
  await prisma.cartItem.deleteMany({ where: { userId, bookId } });
  return getCart(userId);
}

export async function clearCart(userId: string): Promise<CartSummary> {
  await prisma.cartItem.deleteMany({ where: { userId } });
  return getCart(userId);
}

/* -------------------------------- checkout -------------------------------- */

export interface CheckoutInput {
  paymentMethod: PaymentMethod;
  deliveryMethod: DeliveryMethod;
  address: { fullName: string; phone: string; city: string; line?: string; note?: string };
  giftCardCode?: string | undefined;
  idempotencyKey?: string | undefined;
}

export interface SerializedOrder {
  id: string;
  code: string;
  userId: string;
  publisherId: string;
  publisherName: string;
  items: {
    bookId: string | null;
    title: string;
    authorName: string;
    coverUrl: string | null;
    publisherId: string;
    publisherName: string;
    price: number;
    quantity: number;
  }[];
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number;
  status: string;
  paymentMethod: string;
  deliveryMethod: string;
  address: { fullName: string; phone: string; city: string; line: string; note?: string };
  estimatedDelivery: string;
  timeline: { status: string; at: string; note?: string }[];
  createdAt: string;
}

/** Six digits, prefixed. Short enough to read out to support over the phone. */
function orderCode(): string {
  return `KD-${Math.floor(100000 + Math.random() * 900000)}`;
}

/**
 * Turns the cart into one order per publisher.
 *
 * The whole thing is one transaction. A partial checkout — stock decremented,
 * order row missing — is the worst possible outcome, because the books are gone
 * from inventory and nobody is getting them.
 */
export async function checkout(
  userId: string,
  input: CheckoutInput,
): Promise<SerializedOrder[]> {
  if (input.idempotencyKey) {
    // A retried checkout returns the original orders rather than charging twice.
    const existing = await prisma.order.findFirst({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, createdAt: true },
    });
    if (existing) {
      const orders = await prisma.order.findMany({
        where: { userId, createdAt: { gte: new Date(existing.createdAt.getTime() - 5000) } },
        include: orderInclude,
        orderBy: { createdAt: 'desc' },
      });
      return orders.map(serializeOrder);
    }
  }

  const cart = await getCart(userId, input.deliveryMethod);
  if (cart.groups.length === 0) throw badRequest('Your cart is empty');

  const giftCard = input.giftCardCode ? await resolveGiftCard(input.giftCardCode) : null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { walletBalance: true, email: true },
  });
  if (!user) throw notFound('User');

  if (input.paymentMethod === 'wallet' && money(user.walletBalance) < cart.total) {
    throw new ApiError('PAYMENT_FAILED', 'Your wallet balance is not enough for this order');
  }

  // The discount lands on the first order, not spread across them — splitting a
  // gift card across shipments makes every total unreconcilable with the card.
  let remainingDiscount = giftCard ? money(giftCard.amount) : 0;

  const created = await prisma.$transaction(async (tx) => {
    const orders: string[] = [];

    for (const group of cart.groups) {
      // Re-checked inside the transaction: the stock read in getCart is stale
      // by the time we get here if another checkout ran in between.
      for (const item of group.items) {
        const book = await tx.book.findUnique({
          where: { id: item.bookId },
          select: { stock: true, title: true },
        });
        if (!book || book.stock < item.quantity) {
          throw outOfStock(`"${item.book.title}" is no longer available in that quantity`);
        }
      }

      const discount = Math.min(remainingDiscount, group.subtotal);
      remainingDiscount -= discount;
      const total = round(group.subtotal + group.deliveryFee - discount);

      const order = await tx.order.create({
        data: {
          code: orderCode(),
          userId,
          publisherId: group.publisherId,
          subtotal: group.subtotal,
          deliveryFee: group.deliveryFee,
          discount,
          total,
          paymentMethod: input.paymentMethod,
          deliveryMethod: input.deliveryMethod,
          addressFullName: input.address.fullName,
          addressPhone: input.address.phone,
          addressCity: input.address.city,
          addressLine: input.address.line ?? '',
          addressNote: input.address.note ?? null,
          giftCardId: giftCard?.id ?? null,
          estimatedDelivery: new Date(Date.now() + 3 * 86_400_000),
          // Only the first order carries the key; the unique index would reject
          // the rest of the batch otherwise.
          idempotencyKey: orders.length === 0 ? (input.idempotencyKey ?? null) : null,
          items: {
            createMany: {
              data: group.items.map((item) => ({
                bookId: item.bookId,
                // Denormalised: an order must still render after a book is
                // delisted.
                title: item.book.title,
                authorName: item.book.authorName,
                coverUrl: item.book.coverUrl,
                unitPrice: item.book.price,
                quantity: item.quantity,
              })),
            },
          },
          events: { create: { status: 'pending', note: 'Sifariş yaradıldı' } },
        },
      });

      for (const item of group.items) {
        await tx.book.update({
          where: { id: item.bookId },
          data: { stock: { decrement: item.quantity } },
        });
      }

      orders.push(order.id);
    }

    if (giftCard) {
      await tx.giftCard.update({
        where: { id: giftCard.id },
        data: { usedById: userId, usedAt: new Date() },
      });
    }

    if (input.paymentMethod === 'wallet') {
      await tx.user.update({
        where: { id: userId },
        data: { walletBalance: { decrement: cart.total } },
      });
      // The balance is never written without a matching transaction row.
      await tx.walletTransaction.create({
        data: { userId, amount: -cart.total, reason: 'order_payment' },
      });
    }

    await tx.cartItem.deleteMany({ where: { userId } });

    return orders;
  });

  // Card capture happens after the order exists, so a declined card leaves a
  // pending order to retry rather than a charge with nothing attached to it.
  if (input.paymentMethod === 'card') {
    for (const orderId of created) {
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      if (!order) continue;
      try {
        const result = await chargeCard(order.code, money(order.total));
        await prisma.payment.create({
          data: {
            orderId,
            reference: result.reference,
            amount: order.total,
            status: result.paid ? 'paid' : 'failed',
            rawResponse: result.raw as Prisma.InputJsonValue,
          },
        });
        if (result.paid) await advanceStatus(orderId, 'confirmed', null, 'Ödəniş təsdiqləndi');
      } catch (err) {
        logger.warn({ err, orderId }, 'card capture failed');
      }
    }
  } else {
    for (const orderId of created) {
      await advanceStatus(orderId, 'confirmed', null, 'Sifariş təsdiqləndi');
    }
  }

  const orders = await prisma.order.findMany({
    where: { id: { in: created } },
    include: orderInclude,
    orderBy: { createdAt: 'desc' },
  });
  return orders.map(serializeOrder);
}

async function resolveGiftCard(code: string) {
  const card = await prisma.giftCard.findUnique({ where: { code: code.trim().toUpperCase() } });
  if (!card) throw badRequest('That gift card code is not valid', { giftCardCode: 'invalid' });
  if (card.usedAt) throw conflict('That gift card has already been used');
  if (card.expiresAt && card.expiresAt < new Date()) {
    throw conflict('That gift card has expired');
  }
  return card;
}

/* --------------------------------- orders --------------------------------- */

const orderInclude = {
  items: true,
  events: { orderBy: { createdAt: 'asc' } },
  publisher: { select: { id: true, name: true } },
} as const;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

function serializeOrder(order: OrderRow): SerializedOrder {
  return {
    id: order.id,
    code: order.code,
    userId: order.userId,
    publisherId: order.publisherId,
    publisherName: order.publisher.name,
    items: order.items.map((item) => ({
      bookId: item.bookId,
      title: item.title,
      authorName: item.authorName,
      coverUrl: item.coverUrl,
      publisherId: order.publisherId,
      publisherName: order.publisher.name,
      price: money(item.unitPrice),
      quantity: item.quantity,
    })),
    subtotal: money(order.subtotal),
    deliveryFee: money(order.deliveryFee),
    discount: money(order.discount),
    total: money(order.total),
    status: order.status,
    paymentMethod: order.paymentMethod,
    deliveryMethod: order.deliveryMethod,
    address: {
      fullName: order.addressFullName,
      phone: order.addressPhone,
      city: order.addressCity,
      line: order.addressLine,
      ...(order.addressNote && { note: order.addressNote }),
    },
    estimatedDelivery: (order.estimatedDelivery ?? order.createdAt).toISOString(),
    timeline: order.events.map((event) => ({
      status: event.status,
      at: event.createdAt.toISOString(),
      ...(event.note && { note: event.note }),
    })),
    createdAt: order.createdAt.toISOString(),
  };
}

export async function listOrders(
  userId: string,
  skip: number,
  take: number,
): Promise<{ items: SerializedOrder[]; total: number }> {
  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where: { userId },
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.order.count({ where: { userId } }),
  ]);
  return { items: rows.map(serializeOrder), total };
}

export async function getOrder(userId: string, id: string): Promise<SerializedOrder> {
  const order = await prisma.order.findFirst({ where: { id, userId }, include: orderInclude });
  // Scoped to the caller, and 404 rather than 403 for someone else's order —
  // a 403 confirms the order exists.
  if (!order) throw notFound('Order');
  return serializeOrder(order);
}

/** Statuses a customer may still cancel from. */
const CANCELLABLE: OrderStatus[] = ['pending', 'confirmed', 'preparing'];

export async function cancelOrder(userId: string, id: string): Promise<SerializedOrder> {
  const order = await prisma.order.findFirst({ where: { id, userId }, include: { items: true } });
  if (!order) throw notFound('Order');

  if (!CANCELLABLE.includes(order.status)) {
    throw conflict(`An order that is already ${order.status} cannot be cancelled`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id }, data: { status: 'cancelled' } });
    await tx.orderEvent.create({
      data: { orderId: id, status: 'cancelled', note: 'Müştəri tərəfindən ləğv edildi', actorId: userId },
    });

    // Stock goes back, or a cancelled order permanently removes inventory.
    for (const item of order.items) {
      if (item.bookId) {
        await tx.book.update({
          where: { id: item.bookId },
          data: { stock: { increment: item.quantity } },
        });
      }
    }

    if (order.paymentMethod === 'wallet') {
      await tx.user.update({
        where: { id: userId },
        data: { walletBalance: { increment: order.total } },
      });
      await tx.walletTransaction.create({
        data: { userId, amount: order.total, reason: 'refund', orderId: id },
      });
    }
  });

  return getOrder(userId, id);
}

/** Appends a status event. Used by checkout and by the publisher panel. */
export async function advanceStatus(
  orderId: string,
  status: OrderStatus,
  actorId: string | null,
  note?: string,
): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { userId: true, code: true, status: true },
  });
  if (!order) throw notFound('Order');

  await prisma.$transaction([
    prisma.order.update({ where: { id: orderId }, data: { status } }),
    prisma.orderEvent.create({ data: { orderId, status, note: note ?? null, actorId } }),
  ]);

  if (status === 'shipped') {
    await notify(order.userId, 'order_shipped', { code: order.code }, `/orders/${orderId}`);
  }
}

/**
 * The e-receipt.
 *
 * Field names follow ENDPOINTS.md §10 exactly — `lines`, with `unitPrice` and
 * `total` per line. An earlier version returned `items`/`price`/`lineTotal`,
 * which typechecked on both sides (neither knows the other's types at compile
 * time) and crashed the order screen at runtime the moment the receipt loaded:
 * `receipt.lines.map` on undefined takes the whole screen down, which is what
 * a blank page usually is.
 */
export async function orderReceipt(userId: string, id: string) {
  const order = await getOrder(userId, id);
  return {
    orderId: order.id,
    code: order.code,
    issuedAt: new Date().toISOString(),
    // No PDF is generated yet; the client treats null as "no download".
    url: null,
    lines: order.items.map((i) => ({
      title: i.title,
      quantity: i.quantity,
      unitPrice: i.price,
      total: round(i.price * i.quantity),
    })),
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    discount: order.discount,
    total: order.total,
  };
}

/* --------------------------------- wallet --------------------------------- */

export async function getWallet(userId: string) {
  const [user, transactions] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { walletBalance: true } }),
    prisma.walletTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  return {
    balance: money(user?.walletBalance),
    transactions: transactions.map((t) => ({
      id: t.id,
      amount: money(t.amount),
      reason: t.reason,
      orderId: t.orderId,
      createdAt: t.createdAt.toISOString(),
    })),
  };
}

export async function redeemGiftCard(userId: string, code: string) {
  const card = await resolveGiftCard(code);

  try {
    await prisma.$transaction([
      prisma.giftCard.update({
        where: { id: card.id },
        data: { usedById: userId, usedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { walletBalance: { increment: card.amount } },
      }),
      prisma.walletTransaction.create({
        data: { userId, amount: card.amount, reason: 'gift_card' },
      }),
    ]);
  } catch (error) {
    // Two devices redeeming the same code race here; the loser sees a conflict
    // rather than a double credit.
    if (isUniqueViolation(error)) throw conflict('That gift card has already been used');
    throw error;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { walletBalance: true },
  });
  return { amount: money(card.amount), balance: money(user?.walletBalance) };
}

export { forbidden };
