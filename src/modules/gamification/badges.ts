import { prisma } from '../../lib/prisma.js';
import { getStreak } from '../../lib/streak.js';
import { notify } from '../notifications/service.js';

/**
 * Badges.
 *
 * Progress is computed on read; only the moment a badge is earned is stored.
 * A `progress` column would need updating from a dozen places — every review,
 * quote, shelf change, session and follow — and would be wrong the moment any
 * of them was missed.
 *
 * Each badge slug maps to a function returning the reader's current count
 * against that badge's target. Adding a badge is a row plus an entry here.
 */

type ProgressFn = (ctx: BadgeContext) => number;

interface BadgeContext {
  booksRead: number;
  quotesCount: number;
  reviewsCount: number;
  shelvedCount: number;
  distinctGenres: number;
  followingCount: number;
  currentStreak: number;
  longestStreak: number;
  bestWeekPages: number;
  goalCompleted: boolean;
}

const PROGRESS: Record<string, ProgressFn> = {
  first_10: (c) => c.booksRead,
  quote_master: (c) => c.quotesCount,
  genre_explorer: (c) => c.distinctGenres,
  book_collector: (c) => c.shelvedCount,
  reading_marathon: (c) => c.bestWeekPages,
  bookworm: (c) => c.longestStreak,
  critic: (c) => c.reviewsCount,
  // No "read after midnight" signal is recorded, so this one tracks late
  // sessions once that lands. Reporting 0 is honest; inventing a number is not.
  night_owl: () => 0,
  social_reader: (c) => c.followingCount,
  goal_crusher: (c) => (c.goalCompleted ? 1 : 0),
};

async function buildContext(userId: string): Promise<BadgeContext> {
  const year = new Date().getFullYear();

  const [entries, quotesCount, reviewsCount, followingCount, streak, sessions, goal] =
    await Promise.all([
      prisma.shelfEntry.findMany({
        where: { userId },
        select: { status: true, finishedAt: true, book: { select: { genres: true } } },
      }),
      prisma.quote.count({ where: { userId, deletedAt: null } }),
      prisma.review.count({ where: { userId, deletedAt: null } }),
      prisma.follow.count({ where: { followerId: userId } }),
      getStreak(userId),
      prisma.readingSession.findMany({
        where: { userId },
        select: { startedAt: true, startPage: true, endPage: true },
      }),
      prisma.readingGoal.findUnique({ where: { userId_year: { userId, year } } }),
    ]);

  const read = entries.filter((e) => e.status === 'read');
  const genres = new Set(read.flatMap((e) => e.book.genres));

  // Best rolling 7-day page total, for the marathon badge.
  const byDay = new Map<string, number>();
  for (const s of sessions) {
    const key = s.startedAt.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + Math.max(0, s.endPage - s.startPage));
  }
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let bestWeekPages = 0;
  for (let i = 0; i < days.length; i++) {
    const start = new Date(`${days[i]![0]}T00:00:00Z`).getTime();
    let sum = 0;
    for (let j = i; j < days.length; j++) {
      if (new Date(`${days[j]![0]}T00:00:00Z`).getTime() - start >= 7 * 86_400_000) break;
      sum += days[j]![1];
    }
    bestWeekPages = Math.max(bestWeekPages, sum);
  }

  const completedThisYear = read.filter(
    (e) => e.finishedAt && e.finishedAt.getFullYear() === year,
  ).length;

  return {
    booksRead: read.length,
    quotesCount,
    reviewsCount,
    shelvedCount: entries.length,
    distinctGenres: genres.size,
    followingCount,
    currentStreak: streak.current,
    longestStreak: streak.longest,
    bestWeekPages,
    goalCompleted: !!goal && completedThisYear >= goal.target,
  };
}

export interface SerializedBadge {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  earned: boolean;
  earnedAt: string | null;
  progress: number;
  target: number;
}

export async function badgesForUser(
  userId: string,
  locale: 'az' | 'en' = 'az',
): Promise<SerializedBadge[]> {
  const [badges, earned, context] = await Promise.all([
    prisma.badge.findMany(),
    prisma.userBadge.findMany({ where: { userId } }),
    buildContext(userId),
  ]);

  const earnedMap = new Map(earned.map((e) => [e.badgeId, e.earnedAt]));

  return badges.map((badge) => {
    const progress = Math.min(badge.target, PROGRESS[badge.slug]?.(context) ?? 0);
    const earnedAt = earnedMap.get(badge.id);
    return {
      id: badge.id,
      slug: badge.slug,
      name: locale === 'en' ? badge.nameEn : badge.nameAz,
      description: locale === 'en' ? badge.descriptionEn : badge.descriptionAz,
      icon: badge.icon,
      earned: !!earnedAt || progress >= badge.target,
      earnedAt: earnedAt?.toISOString() ?? null,
      progress,
      target: badge.target,
    };
  });
}

/**
 * Awards any badge whose target has been reached.
 *
 * Called after actions that can move a counter. Cheap enough to run eagerly and
 * idempotent — `skipDuplicates` means re-running awards nothing twice, so it
 * never sends a second "badge earned" notification.
 */
export async function evaluateBadges(userId: string): Promise<string[]> {
  const [badges, already, context] = await Promise.all([
    prisma.badge.findMany(),
    prisma.userBadge.findMany({ where: { userId }, select: { badgeId: true } }),
    buildContext(userId),
  ]);

  const has = new Set(already.map((b) => b.badgeId));
  const newlyEarned = badges.filter(
    (b) => !has.has(b.id) && (PROGRESS[b.slug]?.(context) ?? 0) >= b.target,
  );

  if (newlyEarned.length === 0) return [];

  await prisma.userBadge.createMany({
    data: newlyEarned.map((b) => ({ userId, badgeId: b.id })),
    skipDuplicates: true,
  });

  for (const badge of newlyEarned) {
    await notify(userId, 'badge_earned', { name: badge.nameAz }, '/badges');
  }

  return newlyEarned.map((b) => b.slug);
}
