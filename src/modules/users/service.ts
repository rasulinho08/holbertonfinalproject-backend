import type { User } from '@prisma/client';
import { prisma, money } from '../../lib/prisma.js';
import { getStreak, weeklyPages } from '../../lib/streak.js';
import { notFound } from '../../lib/errors.js';

/**
 * User read models.
 *
 * `serializeUser` produces the `User` shape in the frontend's
 * `src/types/index.ts`. Several of its fields are aggregates over other tables,
 * and they are computed here rather than denormalised onto `users`: the profile
 * is read far less often than shelves and reviews are written, so a counter
 * cache would be five more things to keep in sync for no measurable gain.
 */

export interface UserSummary {
  id: string;
  username: string;
  name: string;
  avatarUrl: string | null;
}

export function serializeUserSummary(user: {
  id: string;
  username: string;
  name: string;
  avatarUrl: string | null;
}): UserSummary {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    avatarUrl: user.avatarUrl,
  };
}

/** The columns every summary needs — reused in `select` clauses across modules. */
export const userSummarySelect = {
  id: true,
  username: true,
  name: true,
  avatarUrl: true,
} as const;

export interface UserStats {
  booksRead: number;
  pagesRead: number;
  reviewsCount: number;
  quotesCount: number;
  streakDays: number;
  longestStreak: number;
  readToday: boolean;
  genreDistribution: { genre: string; count: number }[];
  weeklyPages: number[];
}

export async function computeStats(user: User): Promise<UserStats> {
  const [readEntries, reviewsCount, quotesCount, streak, pages] = await Promise.all([
    prisma.shelfEntry.findMany({
      where: { userId: user.id, status: 'read' },
      select: { book: { select: { pageCount: true, genres: true } } },
    }),
    prisma.review.count({ where: { userId: user.id, deletedAt: null } }),
    prisma.quote.count({ where: { userId: user.id, deletedAt: null } }),
    getStreak(user.id, user.timezone),
    weeklyPages(user.id, 7, user.timezone),
  ]);

  // Pages read is counted from finished books rather than from sessions: a
  // reader who finished forty books before the app existed has no sessions for
  // them, and showing 0 would read as data loss.
  const pagesRead = readEntries.reduce((sum, e) => sum + e.book.pageCount, 0);

  const genreCounts = new Map<string, number>();
  for (const entry of readEntries) {
    for (const genre of entry.book.genres) {
      genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1);
    }
  }

  return {
    booksRead: readEntries.length,
    pagesRead,
    reviewsCount,
    quotesCount,
    streakDays: streak.current,
    longestStreak: streak.longest,
    readToday: streak.readToday,
    genreDistribution: [...genreCounts.entries()]
      .map(([genre, count]) => ({ genre, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    weeklyPages: pages,
  };
}

export interface SerializedUser {
  id: string;
  username: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  bio: string | null;
  role: string;
  createdAt: string;
  followersCount: number;
  followingCount: number;
  isFollowing?: boolean;
  stats: UserStats;
  goal: { year: number; target: number; completed: number };
  favoriteGenres: string[];
  favoriteAuthorIds: string[];
  walletBalance: number;
  twoFactorEnabled: boolean;
  publisherId?: string;
}

/**
 * Full profile.
 *
 * `viewerId` decides two things: whether `email` is included (only on your own
 * profile — it is not public), and whether `isFollowing` is present at all. The
 * frontend uses the absence of `isFollowing` to hide the follow button on your
 * own profile, so it must be omitted rather than sent as `false`.
 */
export async function serializeUser(user: User, viewerId?: string | null): Promise<SerializedUser> {
  const isSelf = viewerId === user.id;
  const year = new Date().getFullYear();

  const [followersCount, followingCount, isFollowing, goal, completed, favoriteAuthors] =
    await Promise.all([
      prisma.follow.count({ where: { followeeId: user.id } }),
      prisma.follow.count({ where: { followerId: user.id } }),
      viewerId && !isSelf
        ? prisma.follow
            .count({ where: { followerId: viewerId, followeeId: user.id } })
            .then((n) => n > 0)
        : Promise.resolve(undefined),
      prisma.readingGoal.findUnique({ where: { userId_year: { userId: user.id, year } } }),
      prisma.shelfEntry.count({
        where: {
          userId: user.id,
          status: 'read',
          finishedAt: { gte: new Date(`${year}-01-01T00:00:00.000Z`) },
        },
      }),
      prisma.userFavoriteAuthor.findMany({
        where: { userId: user.id },
        select: { authorId: true },
      }),
    ]);

  const stats = await computeStats(user);

  return {
    id: user.id,
    username: user.username,
    name: user.name,
    // Another reader's email is not public data; the field stays on the shape
    // so the client's type holds, but carries nothing.
    email: isSelf ? user.email : '',
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    followersCount,
    followingCount,
    ...(isFollowing !== undefined && { isFollowing }),
    stats,
    goal: { year, target: goal?.target ?? 24, completed },
    favoriteGenres: user.favoriteGenres,
    favoriteAuthorIds: favoriteAuthors.map((f) => f.authorId),
    walletBalance: isSelf ? money(user.walletBalance) : 0,
    twoFactorEnabled: user.twoFactorEnabled,
    ...(user.publisherId && { publisherId: user.publisherId }),
  };
}

export async function findUserByUsername(username: string): Promise<User> {
  const user = await prisma.user.findFirst({
    where: { username, deletedAt: null },
  });
  if (!user) throw notFound('User');
  return user;
}

export async function findUserById(id: string): Promise<User> {
  const user = await prisma.user.findFirst({ where: { id, deletedAt: null } });
  if (!user) throw notFound('User');
  return user;
}
