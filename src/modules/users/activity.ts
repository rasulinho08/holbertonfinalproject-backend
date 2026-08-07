import { prisma } from '../../lib/prisma.js';
import { serializeUserSummary, userSummarySelect } from './service.js';

/**
 * Activity feed.
 *
 * There is no `activity` table. The feed is assembled from the events that
 * already exist — a book finished, a book started, a quote posted, a review
 * written, a badge earned — because a separate table would be a second copy of
 * the same facts that has to be kept in sync, and would go stale the moment a
 * review is deleted.
 *
 * The cost is that each kind is queried separately and merged in memory. That
 * is bounded: each query takes `skip + take` rows, so a page of 20 reads at
 * most 100 rows regardless of how much history exists.
 */

export type ActivityKind =
  | 'finished_book'
  | 'started_book'
  | 'posted_quote'
  | 'posted_review'
  | 'earned_badge';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  user: { id: string; username: string; name: string; avatarUrl: string | null };
  book?: { id: string; title: string; authorName: string; coverUrl: string | null };
  quoteId?: string;
  reviewId?: string;
  badgeName?: string;
  createdAt: string;
}

export async function activityFor(
  userIds: string[],
  skip: number,
  take: number,
): Promise<{ items: ActivityItem[]; total: number }> {
  if (userIds.length === 0) return { items: [], total: 0 };

  const window = skip + take;

  const [finished, started, quotes, reviews, badges] = await Promise.all([
    prisma.shelfEntry.findMany({
      where: { userId: { in: userIds }, status: 'read', finishedAt: { not: null } },
      include: {
        user: { select: userSummarySelect },
        book: { include: { author: { select: { name: true } } } },
      },
      orderBy: { finishedAt: 'desc' },
      take: window,
    }),
    prisma.shelfEntry.findMany({
      where: { userId: { in: userIds }, status: 'reading', startedAt: { not: null } },
      include: {
        user: { select: userSummarySelect },
        book: { include: { author: { select: { name: true } } } },
      },
      orderBy: { startedAt: 'desc' },
      take: window,
    }),
    prisma.quote.findMany({
      where: { userId: { in: userIds }, deletedAt: null },
      include: {
        user: { select: userSummarySelect },
        book: { include: { author: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: window,
    }),
    prisma.review.findMany({
      where: { userId: { in: userIds }, deletedAt: null },
      include: {
        user: { select: userSummarySelect },
        book: { include: { author: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: window,
    }),
    prisma.userBadge.findMany({
      where: { userId: { in: userIds } },
      include: { user: { select: userSummarySelect }, badge: true },
      orderBy: { earnedAt: 'desc' },
      take: window,
    }),
  ]);

  const bookRef = (book: { id: string; title: string; coverUrl: string | null; author: { name: string } }) => ({
    id: book.id,
    title: book.title,
    authorName: book.author.name,
    coverUrl: book.coverUrl,
  });

  const items: ActivityItem[] = [
    ...finished.map((e) => ({
      id: `fin_${e.id}`,
      kind: 'finished_book' as const,
      user: serializeUserSummary(e.user),
      book: bookRef(e.book),
      createdAt: (e.finishedAt ?? e.addedAt).toISOString(),
    })),
    ...started.map((e) => ({
      id: `sta_${e.id}`,
      kind: 'started_book' as const,
      user: serializeUserSummary(e.user),
      book: bookRef(e.book),
      createdAt: (e.startedAt ?? e.addedAt).toISOString(),
    })),
    ...quotes.map((q) => ({
      id: `quo_${q.id}`,
      kind: 'posted_quote' as const,
      user: serializeUserSummary(q.user),
      book: bookRef(q.book),
      quoteId: q.id,
      createdAt: q.createdAt.toISOString(),
    })),
    ...reviews.map((r) => ({
      id: `rev_${r.id}`,
      kind: 'posted_review' as const,
      user: serializeUserSummary(r.user),
      book: bookRef(r.book),
      reviewId: r.id,
      createdAt: r.createdAt.toISOString(),
    })),
    ...badges.map((b) => ({
      id: `bad_${b.userId}_${b.badgeId}`,
      kind: 'earned_badge' as const,
      user: serializeUserSummary(b.user),
      badgeName: b.badge.nameAz,
      createdAt: b.earnedAt.toISOString(),
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    items: items.slice(skip, skip + take),
    // The true total would need five COUNTs for a number the client only uses
    // to decide whether to fetch another page, so the merged length is the
    // honest answer for this window.
    total: items.length,
  };
}

/** The feed of everyone the reader follows, plus their own activity. */
export async function friendsFeed(
  userId: string,
  skip: number,
  take: number,
): Promise<{ items: ActivityItem[]; total: number }> {
  const follows = await prisma.follow.findMany({
    where: { followerId: userId },
    select: { followeeId: true },
  });

  // Own activity is included: an empty feed for someone who follows nobody
  // reads as a broken screen, and their own shelf history is real content.
  const ids = [...new Set([userId, ...follows.map((f) => f.followeeId)])];
  return activityFor(ids, skip, take);
}
