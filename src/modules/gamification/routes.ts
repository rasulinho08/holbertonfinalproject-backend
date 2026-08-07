import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { optionalAuth, requireAuth, userId } from '../../middleware/auth.js';
import { buildMeta, noContent, ok, page } from '../../lib/envelope.js';
import { pagination, querySort } from '../../lib/pagination.js';
import { getStreak } from '../../lib/streak.js';
import { localDateColumn, startOfLocalDay, todayKey } from '../../lib/dates.js';
import { serializeUserSummary, userSummarySelect, findUserByUsername } from '../users/service.js';
import { badgesForUser, evaluateBadges } from './badges.js';
import * as notifications from '../notifications/service.js';

/* --------------------------------- badges --------------------------------- */

export const badgesRouter: Router = Router();

badgesRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const locale = req.headers['accept-language']?.startsWith('en') ? 'en' : 'az';
    ok(res, await badgesForUser(userId(req), locale));
  }),
);

/* ------------------------------ leaderboard ------------------------------- */

export const leaderboardRouter: Router = Router();

const PERIODS = ['weekly', 'monthly', 'all_time'] as const;
const METRICS = ['books', 'pages'] as const;

leaderboardRouter.get(
  '/',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const period = querySort(req.query.period, PERIODS, 'weekly');
    const metric = querySort(req.query.metric, METRICS, 'books');
    const limit = 50;

    const since =
      period === 'all_time'
        ? new Date(0)
        : new Date(Date.now() - (period === 'weekly' ? 7 : 30) * 86_400_000);

    // Books finished and pages read come from different tables, so the two
    // metrics are two queries rather than one with a CASE.
    const [finished, sessions, users] = await Promise.all([
      prisma.shelfEntry.findMany({
        where: { status: 'read', finishedAt: { gte: since } },
        select: { userId: true, book: { select: { pageCount: true } } },
      }),
      prisma.readingSession.findMany({
        where: { startedAt: { gte: since } },
        select: { userId: true, startPage: true, endPage: true },
      }),
      prisma.user.findMany({
        where: { deletedAt: null },
        select: userSummarySelect,
      }),
    ]);

    const books = new Map<string, number>();
    const pages = new Map<string, number>();

    for (const entry of finished) {
      books.set(entry.userId, (books.get(entry.userId) ?? 0) + 1);
      pages.set(entry.userId, (pages.get(entry.userId) ?? 0) + entry.book.pageCount);
    }
    for (const s of sessions) {
      const read = Math.max(0, s.endPage - s.startPage);
      pages.set(s.userId, (pages.get(s.userId) ?? 0) + read);
    }

    const viewer = req.auth?.sub ?? null;
    const rows = users
      .map((user) => ({
        user: serializeUserSummary(user),
        books: books.get(user.id) ?? 0,
        pages: pages.get(user.id) ?? 0,
        isMe: user.id === viewer,
      }))
      // Everyone at zero would fill the board with accounts that have never
      // read anything, pushing real readers off the first page.
      .filter((row) => row.books > 0 || row.pages > 0)
      .sort((a, b) => (metric === 'books' ? b.books - a.books : b.pages - a.pages))
      .slice(0, limit)
      .map((row, index) => ({ rank: index + 1, ...row }));

    ok(res, rows);
  }),
);

/* --------------------------------- streak --------------------------------- */

export const streakRouter: Router = Router();

streakRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = userId(req);
    const user = await prisma.user.findUnique({ where: { id }, select: { timezone: true } });
    ok(res, await getStreak(id, user?.timezone));
  }),
);

streakRouter.post(
  '/check-in',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = userId(req);
    const user = await prisma.user.findUnique({ where: { id }, select: { timezone: true } });
    const timeZone = user?.timezone;

    // Check-in without a book: records that the reader read today so the streak
    // survives, without inventing pages they did not read. Guarded so tapping
    // twice does not create two rows.
    const today = todayKey(timeZone);
    const existing = await prisma.readingSession.count({
      where: { userId: id, startedAt: { gte: startOfLocalDay(today, timeZone) } },
    });

    if (existing === 0) {
      const anyBook = await prisma.shelfEntry.findFirst({
        where: { userId: id, status: 'reading' },
        select: { bookId: true, progressPage: true },
      });
      if (anyBook) {
        const now = new Date();
        await prisma.readingSession.create({
          data: {
            userId: id,
            bookId: anyBook.bookId,
            startPage: anyBook.progressPage,
            endPage: anyBook.progressPage,
            durationSeconds: 0,
            startedAt: now,
            endedAt: now,
            sessionDate: localDateColumn(now, timeZone),
          },
        });
      }
    }

    void evaluateBadges(id).catch(() => undefined);
    ok(res, await getStreak(id, timeZone));
  }),
);

/* ------------------------------ notifications ----------------------------- */

export const notificationsRouter: Router = Router();

notificationsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await notifications.listNotifications(userId(req), skip, take);
    res.json({
      data: result.items,
      meta: { ...buildMeta(result.total, pageNumber, limit), unread: result.unread },
    });
  }),
);

notificationsRouter.post(
  '/read-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    ok(res, await notifications.markAllRead(userId(req)));
  }),
);

notificationsRouter.patch(
  '/:id/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    await notifications.markRead(userId(req), req.params.id!);
    noContent(res);
  }),
);

notificationsRouter.post(
  '/device-token',
  requireAuth,
  validate(
    z.object({
      token: z.string().trim().min(10, 'token is required').max(300),
      platform: z.enum(['ios', 'android', 'web']).default('android'),
    }),
  ),
  asyncHandler(async (req, res) => {
    await notifications.registerDeviceToken(userId(req), req.body.token, req.body.platform);
    ok(res, { registered: true });
  }),
);

/** Mounted under /users — another reader's badge wall. */
export const userBadgesRouter: Router = Router();

userBadgesRouter.get(
  '/:username/badges',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const locale = req.headers['accept-language']?.startsWith('en') ? 'en' : 'az';
    const user = await findUserByUsername(req.params.username!);
    ok(res, await badgesForUser(user.id, locale));
  }),
);

export { page };
