import type { TargetType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { serializeUserSummary, userSummarySelect, type UserSummary } from '../users/service.js';
import { evaluateBadges } from '../gamification/badges.js';
import { notify } from '../notifications/service.js';

/**
 * Reviews, quotes, likes and comments.
 *
 * The rule that shapes this file is CONVENTIONS.md §15.1: book aggregates are
 * maintained by the backend in the same transaction as the write. `rating_sum`
 * and `rating_count` are incremented rather than recomputed, so posting a
 * review is O(1) instead of a scan over every review for that book — and
 * `ratingAverage` cannot drift, because it is never stored.
 */

/* -------------------------------- reviews --------------------------------- */

export interface SerializedReview {
  id: string;
  bookId: string;
  user: UserSummary;
  rating: number;
  body: string;
  isSpoiler: boolean;
  photos: string[];
  likesCount: number;
  commentsCount: number;
  isLiked: boolean;
  createdAt: string;
}

const reviewInclude = { user: { select: userSummarySelect } } as const;

type ReviewRow = {
  id: string;
  bookId: string;
  rating: number;
  body: string;
  isSpoiler: boolean;
  photos: string[];
  likesCount: number;
  commentsCount: number;
  createdAt: Date;
  user: { id: string; username: string; name: string; avatarUrl: string | null };
};

function serializeReview(row: ReviewRow, isLiked: boolean): SerializedReview {
  return {
    id: row.id,
    bookId: row.bookId,
    user: serializeUserSummary(row.user),
    rating: row.rating,
    body: row.body,
    isSpoiler: row.isSpoiler,
    photos: row.photos,
    likesCount: row.likesCount,
    commentsCount: row.commentsCount,
    isLiked,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Resolves `isLiked` for a page of rows in one query rather than per row. */
async function likedSet(
  viewerId: string | null,
  targetType: TargetType,
  ids: string[],
): Promise<Set<string>> {
  if (!viewerId || ids.length === 0) return new Set();
  const likes = await prisma.like.findMany({
    where: { userId: viewerId, targetType, targetId: { in: ids } },
    select: { targetId: true },
  });
  return new Set(likes.map((l) => l.targetId));
}

export async function bookReviews(
  bookId: string,
  viewerId: string | null,
  skip: number,
  take: number,
): Promise<{ items: SerializedReview[]; total: number }> {
  const where = { bookId, deletedAt: null };
  const [rows, total] = await Promise.all([
    prisma.review.findMany({
      where,
      include: reviewInclude,
      orderBy: [{ likesCount: 'desc' }, { createdAt: 'desc' }],
      skip,
      take,
    }),
    prisma.review.count({ where }),
  ]);

  const liked = await likedSet(viewerId, 'review', rows.map((r) => r.id));
  return { items: rows.map((r) => serializeReview(r, liked.has(r.id))), total };
}

export async function getReview(id: string, viewerId: string | null): Promise<SerializedReview> {
  const review = await prisma.review.findFirst({
    where: { id, deletedAt: null },
    include: reviewInclude,
  });
  if (!review) throw notFound('Review');
  const liked = await likedSet(viewerId, 'review', [review.id]);
  return serializeReview(review, liked.has(review.id));
}

export interface ReviewInput {
  bookId: string;
  rating: number;
  body: string;
  isSpoiler?: boolean;
  photos?: string[];
}

export async function createReview(
  userId: string,
  input: ReviewInput,
): Promise<SerializedReview> {
  const book = await prisma.book.findFirst({
    where: { id: input.bookId, deletedAt: null },
    select: { id: true },
  });
  if (!book) throw notFound('Book');

  const existing = await prisma.review.findUnique({
    where: { userId_bookId: { userId, bookId: input.bookId } },
  });
  // One review per user per book. A soft-deleted one is revived rather than
  // blocking the reader forever behind a row they cannot see.
  if (existing && !existing.deletedAt) {
    throw conflict('You have already reviewed this book');
  }

  const review = await prisma.$transaction(async (tx) => {
    const row = existing
      ? await tx.review.update({
          where: { id: existing.id },
          data: {
            rating: input.rating,
            body: input.body,
            isSpoiler: input.isSpoiler ?? false,
            photos: input.photos ?? [],
            deletedAt: null,
            createdAt: new Date(),
          },
          include: reviewInclude,
        })
      : await tx.review.create({
          data: {
            userId,
            bookId: input.bookId,
            rating: input.rating,
            body: input.body,
            isSpoiler: input.isSpoiler ?? false,
            photos: input.photos ?? [],
          },
          include: reviewInclude,
        });

    // Same transaction as the write, per CONVENTIONS.md §15.1.
    await tx.book.update({
      where: { id: input.bookId },
      data: {
        ratingSum: { increment: input.rating },
        ratingCount: { increment: 1 },
        reviewsCount: { increment: 1 },
      },
    });

    return row;
  });

  void evaluateBadges(userId).catch(() => undefined);
  return serializeReview(review, false);
}

export async function updateReview(
  userId: string,
  id: string,
  input: { rating?: number; body?: string; isSpoiler?: boolean; photos?: string[] },
): Promise<SerializedReview> {
  const review = await prisma.review.findFirst({ where: { id, deletedAt: null } });
  if (!review) throw notFound('Review');
  if (review.userId !== userId) throw forbidden('This is not your review');

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.review.update({
      where: { id },
      data: {
        ...(input.rating !== undefined && { rating: input.rating }),
        ...(input.body !== undefined && { body: input.body }),
        ...(input.isSpoiler !== undefined && { isSpoiler: input.isSpoiler }),
        ...(input.photos !== undefined && { photos: input.photos }),
      },
      include: reviewInclude,
    });

    // Only the delta moves; the count is unchanged because this is still one
    // review. Recomputing the sum would be a scan for no benefit.
    if (input.rating !== undefined && input.rating !== review.rating) {
      await tx.book.update({
        where: { id: review.bookId },
        data: { ratingSum: { increment: input.rating - review.rating } },
      });
    }

    return row;
  });

  const liked = await likedSet(userId, 'review', [id]);
  return serializeReview(updated, liked.has(id));
}

export async function deleteReview(userId: string, id: string, asModerator = false): Promise<void> {
  const review = await prisma.review.findFirst({ where: { id, deletedAt: null } });
  if (!review) throw notFound('Review');
  if (!asModerator && review.userId !== userId) throw forbidden('This is not your review');

  await prisma.$transaction([
    // Soft delete: moderation needs the original text after removal.
    prisma.review.update({ where: { id }, data: { deletedAt: new Date() } }),
    prisma.book.update({
      where: { id: review.bookId },
      data: {
        ratingSum: { decrement: review.rating },
        ratingCount: { decrement: 1 },
        reviewsCount: { decrement: 1 },
      },
    }),
  ]);
}

/* --------------------------------- quotes --------------------------------- */

export interface SerializedQuote {
  id: string;
  bookId: string;
  book: { id: string; title: string; authorName: string; coverUrl: string | null };
  user: UserSummary;
  text: string;
  page: number | null;
  background: string;
  likesCount: number;
  commentsCount: number;
  isLiked: boolean;
  createdAt: string;
}

const quoteInclude = {
  user: { select: userSummarySelect },
  book: { include: { author: { select: { name: true } } } },
} as const;

type QuoteRow = {
  id: string;
  bookId: string;
  text: string;
  page: number | null;
  background: string;
  likesCount: number;
  commentsCount: number;
  createdAt: Date;
  user: { id: string; username: string; name: string; avatarUrl: string | null };
  book: { id: string; title: string; coverUrl: string | null; author: { name: string } };
};

function serializeQuote(row: QuoteRow, isLiked: boolean): SerializedQuote {
  return {
    id: row.id,
    bookId: row.bookId,
    book: {
      id: row.book.id,
      title: row.book.title,
      authorName: row.book.author.name,
      coverUrl: row.book.coverUrl,
    },
    user: serializeUserSummary(row.user),
    text: row.text,
    page: row.page,
    background: row.background,
    likesCount: row.likesCount,
    commentsCount: row.commentsCount,
    isLiked,
    createdAt: row.createdAt.toISOString(),
  };
}

export type QuoteSort = 'newest' | 'popular';

export async function listQuotes(
  options: { bookId?: string; userId?: string; sort: QuoteSort },
  viewerId: string | null,
  skip: number,
  take: number,
): Promise<{ items: SerializedQuote[]; total: number }> {
  const where = {
    deletedAt: null,
    ...(options.bookId && { bookId: options.bookId }),
    ...(options.userId && { userId: options.userId }),
  };

  const [rows, total] = await Promise.all([
    prisma.quote.findMany({
      where,
      include: quoteInclude,
      orderBy:
        options.sort === 'popular'
          ? [{ likesCount: 'desc' }, { createdAt: 'desc' }]
          : [{ createdAt: 'desc' }],
      skip,
      take,
    }),
    prisma.quote.count({ where }),
  ]);

  const liked = await likedSet(viewerId, 'quote', rows.map((r) => r.id));
  return { items: rows.map((r) => serializeQuote(r, liked.has(r.id))), total };
}

export async function getQuote(id: string, viewerId: string | null): Promise<SerializedQuote> {
  const quote = await prisma.quote.findFirst({
    where: { id, deletedAt: null },
    include: quoteInclude,
  });
  if (!quote) throw notFound('Quote');
  const liked = await likedSet(viewerId, 'quote', [quote.id]);
  return serializeQuote(quote, liked.has(quote.id));
}

export async function createQuote(
  userId: string,
  input: { bookId: string; text: string; page?: number | null; background?: string; sourceImageUrl?: string },
): Promise<SerializedQuote> {
  const book = await prisma.book.findFirst({
    where: { id: input.bookId, deletedAt: null },
    select: { id: true, pageCount: true },
  });
  if (!book) throw notFound('Book');

  const quote = await prisma.$transaction(async (tx) => {
    const row = await tx.quote.create({
      data: {
        userId,
        bookId: input.bookId,
        text: input.text.trim(),
        // A page beyond the book is dropped rather than rejected: the number is
        // decoration on a quote card, not worth failing the post over.
        page: input.page && input.page > 0 && input.page <= book.pageCount ? input.page : null,
        background: input.background ?? 'paper',
        sourceImageUrl: input.sourceImageUrl ?? null,
      },
      include: quoteInclude,
    });
    await tx.book.update({
      where: { id: input.bookId },
      data: { quotesCount: { increment: 1 } },
    });
    return row;
  });

  void evaluateBadges(userId).catch(() => undefined);
  return serializeQuote(quote, false);
}

export async function deleteQuote(userId: string, id: string, asModerator = false): Promise<void> {
  const quote = await prisma.quote.findFirst({ where: { id, deletedAt: null } });
  if (!quote) throw notFound('Quote');
  if (!asModerator && quote.userId !== userId) throw forbidden('This is not your quote');

  await prisma.$transaction([
    prisma.quote.update({ where: { id }, data: { deletedAt: new Date() } }),
    prisma.book.update({
      where: { id: quote.bookId },
      data: { quotesCount: { decrement: 1 } },
    }),
  ]);
}

/* ---------------------------------- likes --------------------------------- */

/**
 * Like or unlike.
 *
 * `likes_count` is kept in step by a database trigger, not here — a like also
 * disappears via ON DELETE CASCADE when an account is removed, and no service
 * call runs then.
 */
export async function setLike(
  userId: string,
  targetType: TargetType,
  targetId: string,
  liked: boolean,
): Promise<{ liked: boolean; likesCount: number }> {
  const owner = await targetOwner(targetType, targetId);

  if (liked) {
    // Idempotent — the client toggles optimistically and may retry.
    const existing = await prisma.like.count({ where: { userId, targetType, targetId } });
    if (existing === 0) {
      await prisma.like.create({ data: { userId, targetType, targetId } });
      if (targetType === 'quote') {
        const me = await prisma.user.findUnique({
          where: { id: userId },
          select: { name: true },
        });
        await notify(
          owner.userId,
          'quote_like',
          { name: me?.name ?? '' },
          `/quote/${targetId}`,
          userId,
        );
      }
    }
  } else {
    await prisma.like.deleteMany({ where: { userId, targetType, targetId } });
  }

  return { liked, likesCount: await currentLikeCount(targetType, targetId) };
}

async function targetOwner(targetType: TargetType, targetId: string): Promise<{ userId: string }> {
  const row =
    targetType === 'review'
      ? await prisma.review.findFirst({ where: { id: targetId, deletedAt: null }, select: { userId: true } })
      : await prisma.quote.findFirst({ where: { id: targetId, deletedAt: null }, select: { userId: true } });
  if (!row) throw notFound(targetType === 'review' ? 'Review' : 'Quote');
  return row;
}

async function currentLikeCount(targetType: TargetType, targetId: string): Promise<number> {
  const row =
    targetType === 'review'
      ? await prisma.review.findUnique({ where: { id: targetId }, select: { likesCount: true } })
      : await prisma.quote.findUnique({ where: { id: targetId }, select: { likesCount: true } });
  return row?.likesCount ?? 0;
}

/* -------------------------------- comments -------------------------------- */

export interface SerializedComment {
  id: string;
  targetType: string;
  targetId: string;
  user: UserSummary;
  body: string;
  createdAt: string;
}

export async function listComments(
  targetType: TargetType,
  targetId: string,
  skip: number,
  take: number,
): Promise<{ items: SerializedComment[]; total: number }> {
  const where = { targetType, targetId, deletedAt: null };
  const [rows, total] = await Promise.all([
    prisma.comment.findMany({
      where,
      include: { user: { select: userSummarySelect } },
      orderBy: { createdAt: 'asc' },
      skip,
      take,
    }),
    prisma.comment.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      targetType: row.targetType,
      targetId: row.targetId,
      user: serializeUserSummary(row.user),
      body: row.body,
      createdAt: row.createdAt.toISOString(),
    })),
    total,
  };
}

export async function addComment(
  userId: string,
  targetType: TargetType,
  targetId: string,
  body: string,
): Promise<SerializedComment> {
  const owner = await targetOwner(targetType, targetId);

  const comment = await prisma.comment.create({
    data: { userId, targetType, targetId, body: body.trim() },
    include: { user: { select: userSummarySelect } },
  });

  if (targetType === 'review') {
    await notify(
      owner.userId,
      'review_comment',
      { name: comment.user.name },
      `/review/${targetId}`,
      userId,
    );
  }

  return {
    id: comment.id,
    targetType: comment.targetType,
    targetId: comment.targetId,
    user: serializeUserSummary(comment.user),
    body: comment.body,
    createdAt: comment.createdAt.toISOString(),
  };
}
