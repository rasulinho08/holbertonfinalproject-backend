import type { OrderStatus } from '@prisma/client';
import { prisma, money } from '../../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { bookInclude, isGenreSlug, serializeBook, type SerializedBook } from '../books/service.js';
import { advanceStatus } from '../commerce/service.js';
import { notify } from '../notifications/service.js';

/**
 * Publisher panel.
 *
 * Every query here is scoped to the caller's publisher. That scoping is the
 * authorisation: a publisher must not be able to read another's revenue or
 * edit their catalogue, and doing it in the `where` clause rather than as a
 * check after loading means there is no path that forgets.
 */

export interface PublisherStats {
  revenue: number;
  unitsSold: number;
  pendingOrders: number;
  activeBooks: number;
  salesTrend: { month: string; revenue: number }[];
  topBooks: { book: SerializedBook; units: number; revenue: number }[];
  revenueByGenre: { genre: string; revenue: number }[];
}

export async function publisherStats(publisherId: string): Promise<PublisherStats> {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setDate(1);
  sixMonthsAgo.setHours(0, 0, 0, 0);

  const [orders, pendingOrders, activeBooks] = await Promise.all([
    prisma.order.findMany({
      // Cancelled orders are excluded: counting them as revenue would make the
      // dashboard disagree with what was actually collected.
      where: { publisherId, status: { not: 'cancelled' } },
      include: { items: { include: { book: { select: { genres: true } } } } },
    }),
    prisma.order.count({
      where: { publisherId, status: { in: ['pending', 'confirmed', 'preparing'] } },
    }),
    prisma.book.count({ where: { publisherId, deletedAt: null } }),
  ]);

  let revenue = 0;
  let unitsSold = 0;
  const byMonth = new Map<string, number>();
  const byBook = new Map<string, { units: number; revenue: number }>();
  const byGenre = new Map<string, number>();

  for (const order of orders) {
    const total = money(order.total);
    revenue += total;

    const monthKey = order.createdAt.toISOString().slice(0, 7);
    if (order.createdAt >= sixMonthsAgo) {
      byMonth.set(monthKey, (byMonth.get(monthKey) ?? 0) + total);
    }

    for (const item of order.items) {
      unitsSold += item.quantity;
      const lineRevenue = money(item.unitPrice) * item.quantity;

      if (item.bookId) {
        const current = byBook.get(item.bookId) ?? { units: 0, revenue: 0 };
        byBook.set(item.bookId, {
          units: current.units + item.quantity,
          revenue: current.revenue + lineRevenue,
        });
      }
      for (const genre of item.book?.genres ?? []) {
        byGenre.set(genre, (byGenre.get(genre) ?? 0) + lineRevenue);
      }
    }
  }

  // Six months of buckets including empty ones, so the chart has a stable
  // x-axis rather than collapsing when a month had no sales.
  const salesTrend = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(sixMonthsAgo);
    d.setMonth(d.getMonth() + i);
    const key = d.toISOString().slice(0, 7);
    return { month: key, revenue: Math.round((byMonth.get(key) ?? 0) * 100) / 100 };
  });

  const topIds = [...byBook.entries()]
    .sort((a, b) => b[1].units - a[1].units)
    .slice(0, 5)
    .map(([id]) => id);

  const topRows = topIds.length
    ? await prisma.book.findMany({ where: { id: { in: topIds } }, include: bookInclude })
    : [];
  const bookById = new Map(topRows.map((b) => [b.id, b]));

  return {
    revenue: Math.round(revenue * 100) / 100,
    unitsSold,
    pendingOrders,
    activeBooks,
    salesTrend,
    topBooks: topIds
      .map((id) => {
        const book = bookById.get(id);
        const stats = byBook.get(id)!;
        return book
          ? {
              book: serializeBook(book),
              units: stats.units,
              revenue: Math.round(stats.revenue * 100) / 100,
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
    revenueByGenre: [...byGenre.entries()]
      .map(([genre, value]) => ({ genre, revenue: Math.round(value * 100) / 100 }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 6),
  };
}

/* --------------------------------- books ---------------------------------- */

export async function publisherBooks(
  publisherId: string,
  skip: number,
  take: number,
): Promise<{ items: SerializedBook[]; total: number }> {
  const where = { publisherId, deletedAt: null };
  const [rows, total] = await Promise.all([
    prisma.book.findMany({ where, include: bookInclude, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.book.count({ where }),
  ]);
  return { items: rows.map((b) => serializeBook(b)), total };
}

export interface BookDraft {
  title: string;
  authorName: string;
  isbn?: string;
  language: string;
  genres: string[];
  description: string;
  coverUrl?: string | null;
  pageCount: number;
  publishedYear: number;
  price: number;
  stock: number;
}

export async function createPublisherBook(
  publisherId: string,
  draft: BookDraft,
): Promise<SerializedBook> {
  const genres = draft.genres.filter(isGenreSlug);
  if (genres.length === 0) throw badRequest('Pick at least one genre', { genres: 'required' });

  if (draft.isbn) {
    const clash = await prisma.book.count({ where: { isbn: draft.isbn } });
    if (clash > 0) throw conflict('A book with that ISBN already exists');
  }

  // Authors are matched by name and created on demand. A publisher adding a
  // book should not first have to find an author id they have no way of knowing.
  const name = draft.authorName.trim();
  const author =
    (await prisma.author.findFirst({ where: { name } })) ??
    (await prisma.author.create({
      data: {
        name,
        slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now().toString(36)}`.slice(0, 90),
      },
    }));

  const book = await prisma.book.create({
    data: {
      title: draft.title.trim(),
      authorId: author.id,
      publisherId,
      isbn: draft.isbn?.trim() || null,
      language: (['az', 'en', 'tr', 'ru'].includes(draft.language) ? draft.language : 'az') as 'az',
      genres,
      description: draft.description.trim(),
      coverUrl: draft.coverUrl ?? null,
      pageCount: draft.pageCount,
      publishedYear: draft.publishedYear,
      price: draft.price,
      stock: draft.stock,
    },
    include: bookInclude,
  });

  // Readers following this author asked to hear about exactly this.
  const followers = await prisma.authorFollow.findMany({
    where: { authorId: author.id },
    select: { userId: true },
  });
  for (const follower of followers) {
    await notify(follower.userId, 'new_book', { name: author.name }, `/book/${book.id}`);
  }

  return serializeBook(book);
}

async function ownedBook(publisherId: string, bookId: string) {
  const book = await prisma.book.findFirst({ where: { id: bookId, deletedAt: null } });
  if (!book) throw notFound('Book');
  if (book.publisherId !== publisherId) throw forbidden('That book belongs to another publisher');
  return book;
}

export async function updatePublisherBook(
  publisherId: string,
  bookId: string,
  patch: Partial<BookDraft>,
): Promise<SerializedBook> {
  await ownedBook(publisherId, bookId);

  const updated = await prisma.book.update({
    where: { id: bookId },
    data: {
      ...(patch.title !== undefined && { title: patch.title.trim() }),
      ...(patch.description !== undefined && { description: patch.description.trim() }),
      ...(patch.coverUrl !== undefined && { coverUrl: patch.coverUrl }),
      ...(patch.pageCount !== undefined && { pageCount: patch.pageCount }),
      ...(patch.publishedYear !== undefined && { publishedYear: patch.publishedYear }),
      ...(patch.price !== undefined && { price: patch.price }),
      ...(patch.stock !== undefined && { stock: patch.stock }),
      ...(patch.genres !== undefined && { genres: patch.genres.filter(isGenreSlug) }),
    },
    include: bookInclude,
  });

  return serializeBook(updated);
}

export async function deletePublisherBook(publisherId: string, bookId: string): Promise<void> {
  await ownedBook(publisherId, bookId);
  // Soft delete: order history references this row, and a hard delete would
  // leave past orders pointing at nothing.
  await prisma.book.update({ where: { id: bookId }, data: { deletedAt: new Date() } });
}

/* --------------------------------- orders --------------------------------- */

export async function publisherOrders(
  publisherId: string,
  status: OrderStatus | undefined,
  skip: number,
  take: number,
) {
  const where = { publisherId, ...(status && { status }) };
  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        items: true,
        events: { orderBy: { createdAt: 'asc' } },
        publisher: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.order.count({ where }),
  ]);

  return {
    items: rows.map((order) => ({
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
      timeline: order.events.map((e) => ({
        status: e.status,
        at: e.createdAt.toISOString(),
        ...(e.note && { note: e.note }),
      })),
      createdAt: order.createdAt.toISOString(),
    })),
    total,
  };
}

/**
 * Allowed status transitions.
 *
 * A publisher must not be able to move an order backwards or skip to
 * delivered — the timeline is what the customer is shown, and it has to be
 * a plausible history rather than whatever was clicked last.
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['shipped', 'cancelled'],
  shipped: ['out_for_delivery', 'delivered'],
  out_for_delivery: ['delivered'],
  delivered: [],
  cancelled: [],
};

export async function updateOrderStatus(
  publisherId: string,
  orderId: string,
  status: OrderStatus,
  actorId: string,
  note?: string,
): Promise<void> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, publisherId },
    select: { status: true },
  });
  if (!order) throw notFound('Order');

  if (!TRANSITIONS[order.status].includes(status)) {
    throw conflict(`An order that is ${order.status} cannot move to ${status}`);
  }

  await advanceStatus(orderId, status, actorId, note);
}
