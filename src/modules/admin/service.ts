import type { ReportReason, ReportStatus, TargetType } from '@prisma/client';
import { prisma, money } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { serializeUserSummary, userSummarySelect, type UserSummary } from '../users/service.js';
import { deleteQuote, deleteReview } from '../social/service.js';

/**
 * Moderation.
 *
 * A report stores a **snapshot** of the reported content. Without it, a
 * moderator opening the queue after the author edited or deleted the offending
 * text sees nothing and has no basis to act — which is how a report queue turns
 * into a list of unresolvable tickets.
 */

export interface SerializedReport {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  note: string | null;
  reportedBy: UserSummary;
  status: string;
  createdAt: string;
  snapshot: { text: string; authorName: string; bookTitle: string | null };
}

export async function createReport(
  reporterId: string,
  targetType: TargetType,
  targetId: string,
  reason: ReportReason,
  note: string | null,
): Promise<SerializedReport> {
  // The snapshot is taken now, at report time, not read later at review time.
  const snapshot = await captureSnapshot(targetType, targetId);

  const report = await prisma.report.create({
    data: {
      targetType,
      targetId,
      reason,
      note,
      reporterId,
      snapshotText: snapshot.text,
      snapshotAuthorName: snapshot.authorName,
      snapshotBookTitle: snapshot.bookTitle,
    },
    include: { reporter: { select: userSummarySelect } },
  });

  return serialize(report);
}

async function captureSnapshot(targetType: TargetType, targetId: string) {
  if (targetType === 'review') {
    const review = await prisma.review.findUnique({
      where: { id: targetId },
      include: { user: { select: { name: true } }, book: { select: { title: true } } },
    });
    if (!review) throw notFound('Review');
    return {
      text: review.body.slice(0, 2000),
      authorName: review.user.name,
      bookTitle: review.book.title,
    };
  }

  const quote = await prisma.quote.findUnique({
    where: { id: targetId },
    include: { user: { select: { name: true } }, book: { select: { title: true } } },
  });
  if (!quote) throw notFound('Quote');
  return {
    text: quote.text.slice(0, 2000),
    authorName: quote.user.name,
    bookTitle: quote.book.title,
  };
}

type ReportRow = {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  note: string | null;
  status: string;
  createdAt: Date;
  snapshotText: string;
  snapshotAuthorName: string;
  snapshotBookTitle: string | null;
  reporter: { id: string; username: string; name: string; avatarUrl: string | null };
};

function serialize(row: ReportRow): SerializedReport {
  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    reason: row.reason,
    note: row.note,
    reportedBy: serializeUserSummary(row.reporter),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    snapshot: {
      text: row.snapshotText,
      authorName: row.snapshotAuthorName,
      bookTitle: row.snapshotBookTitle,
    },
  };
}

export async function listReports(
  status: ReportStatus | undefined,
  skip: number,
  take: number,
): Promise<{ items: SerializedReport[]; total: number }> {
  const where = status ? { status } : {};
  const [rows, total] = await Promise.all([
    prisma.report.findMany({
      where,
      include: { reporter: { select: userSummarySelect } },
      // Open first, then oldest — a queue worked newest-first leaves the
      // original reports unanswered forever.
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      skip,
      take,
    }),
    prisma.report.count({ where }),
  ]);
  return { items: rows.map(serialize), total };
}

/**
 * Resolves a report.
 *
 * `removed` also deletes the content; `kept` closes the report and leaves it.
 * Both are recorded in `admin_actions` — moderation decisions need an audit
 * trail, including the ones that took no action.
 */
export async function resolveReport(
  adminId: string,
  reportId: string,
  action: 'kept' | 'removed',
  note?: string,
): Promise<SerializedReport> {
  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) throw notFound('Report');

  if (action === 'removed') {
    if (report.targetType === 'review') {
      await deleteReview(adminId, report.targetId, true).catch(() => undefined);
    } else {
      await deleteQuote(adminId, report.targetId, true).catch(() => undefined);
    }
  }

  const [updated] = await prisma.$transaction([
    prisma.report.update({
      where: { id: reportId },
      data: { status: action, resolvedById: adminId, resolvedAt: new Date() },
      include: { reporter: { select: userSummarySelect } },
    }),
    prisma.adminAction.create({
      data: {
        adminId,
        action: `report_${action}`,
        targetType: report.targetType,
        targetId: report.targetId,
        note: note ?? null,
      },
    }),
  ]);

  return serialize(updated);
}

export interface AdminStats {
  users: {
    total: number;
    newThisWeek: number;
    newThisMonth: number;
    activeToday: number;
    activeThisWeek: number;
    activeThisMonth: number;
    readers: number;
    publishers: number;
    admins: number;
  };
  content: {
    books: number;
    authors: number;
    reviews: number;
    quotes: number;
    lists: number;
    sessions: number;
    pagesRead: number;
  };
  commerce: {
    orders: number;
    revenue: number;
    pending: number;
    delivered: number;
    cancelled: number;
    averageOrder: number;
  };
  moderation: {
    openReports: number;
    resolvedReports: number;
    removedContent: number;
  };
  /** Signups per week, oldest first — 12 buckets. */
  signupTrend: { label: string; value: number }[];
  /** Reading sessions per day, oldest first — 14 buckets. */
  activityTrend: { label: string; value: number }[];
  topBooks: { id: string; title: string; authorName: string; coverUrl: string | null; readers: number }[];
  topReaders: { user: UserSummary; booksRead: number; pagesRead: number }[];
  genreSpread: { genre: string; count: number }[];
}

/**
 * The moderation dashboard's numbers.
 *
 * "Active" deliberately means *did something* — logged a reading session —
 * rather than *has an account*. A registration count only ever rises and tells
 * a moderator nothing about whether the app is being used.
 *
 * Everything is computed on read. At this scale that is a handful of indexed
 * counts; if the dashboard ever becomes slow the fix is a materialised view on
 * a schedule, not a set of counters scattered across every write path.
 */
export async function adminStats(): Promise<AdminStats> {
  const now = Date.now();
  const dayAgo = new Date(now - 86_400_000);
  const weekAgo = new Date(now - 7 * 86_400_000);
  const monthAgo = new Date(now - 30 * 86_400_000);

  const distinctActive = (since: Date) =>
    prisma.readingSession
      .findMany({ where: { startedAt: { gte: since } }, select: { userId: true }, distinct: ['userId'] })
      .then((rows) => rows.length);

  const [
    total, newThisWeek, newThisMonth,
    activeToday, activeThisWeek, activeThisMonth,
    readers, publishers, admins,
    books, authors, reviews, quotes, lists, sessions,
    openReports, resolvedReports, removedContent,
    orders, signups, activity, topBookRows, topReaderRows, genreRows, pageSum,
  ] = await Promise.all([
    prisma.user.count({ where: { deletedAt: null } }),
    prisma.user.count({ where: { deletedAt: null, createdAt: { gte: weekAgo } } }),
    prisma.user.count({ where: { deletedAt: null, createdAt: { gte: monthAgo } } }),
    distinctActive(dayAgo),
    distinctActive(weekAgo),
    distinctActive(monthAgo),
    prisma.user.count({ where: { deletedAt: null, role: 'user' } }),
    prisma.user.count({ where: { deletedAt: null, role: 'publisher' } }),
    prisma.user.count({ where: { deletedAt: null, role: 'admin' } }),
    prisma.book.count({ where: { deletedAt: null } }),
    prisma.author.count(),
    prisma.review.count({ where: { deletedAt: null } }),
    prisma.quote.count({ where: { deletedAt: null } }),
    prisma.bookList.count({ where: { deletedAt: null } }),
    prisma.readingSession.count(),
    prisma.report.count({ where: { status: 'open' } }),
    prisma.report.count({ where: { status: { in: ['kept', 'removed'] } } }),
    prisma.adminAction.count({ where: { action: { in: ['report_removed', 'review_removed', 'quote_removed'] } } }),
    prisma.order.findMany({ select: { status: true, total: true } }),

    // Signups per ISO week, and sessions per day. Grouped in SQL rather than by
    // loading every row — this is the one part that would not stay cheap.
    prisma.$queryRaw<{ bucket: Date; count: bigint }[]>`
      SELECT date_trunc('week', created_at) AS bucket, count(*) AS count
      FROM users
      WHERE deleted_at IS NULL AND created_at >= now() - interval '12 weeks'
      GROUP BY bucket ORDER BY bucket
    `,
    prisma.$queryRaw<{ bucket: Date; count: bigint }[]>`
      SELECT date_trunc('day', started_at) AS bucket, count(*) AS count
      FROM reading_sessions
      WHERE started_at >= now() - interval '14 days'
      GROUP BY bucket ORDER BY bucket
    `,
    prisma.$queryRaw<{ id: string; title: string; author_name: string; cover_url: string | null; readers: bigint }[]>`
      SELECT b.id, b.title, a.name AS author_name, b.cover_url, count(DISTINCT se.user_id) AS readers
      FROM shelf_entries se
      JOIN books b ON b.id = se.book_id
      JOIN authors a ON a.id = b.author_id
      WHERE se.status IN ('reading', 'read')
      GROUP BY b.id, b.title, a.name, b.cover_url
      ORDER BY readers DESC, b.rating_count DESC
      LIMIT 5
    `,
    prisma.$queryRaw<{ id: string; username: string; name: string; avatar_url: string | null; books_read: bigint; pages_read: bigint }[]>`
      SELECT u.id, u.username, u.name, u.avatar_url,
             count(*) AS books_read,
             coalesce(sum(b.page_count), 0) AS pages_read
      FROM shelf_entries se
      JOIN users u ON u.id = se.user_id
      JOIN books b ON b.id = se.book_id
      WHERE se.status = 'read' AND u.deleted_at IS NULL
      GROUP BY u.id, u.username, u.name, u.avatar_url
      ORDER BY books_read DESC
      LIMIT 5
    `,
    prisma.$queryRaw<{ genre: string; count: bigint }[]>`
      SELECT genre, count(*) AS count
      FROM books, unnest(genres) AS genre
      WHERE deleted_at IS NULL
      GROUP BY genre ORDER BY count DESC LIMIT 8
    `,
    prisma.$queryRaw<{ total: bigint | null }[]>`
      SELECT coalesce(sum(end_page - start_page), 0) AS total FROM reading_sessions
    `,
  ]);

  // Cancelled orders are excluded from revenue: counting them would make the
  // dashboard disagree with what was actually collected.
  const live = orders.filter((o) => o.status !== 'cancelled');
  const revenue = live.reduce((sum, o) => sum + money(o.total), 0);

  return {
    users: {
      total, newThisWeek, newThisMonth,
      activeToday, activeThisWeek, activeThisMonth,
      readers, publishers, admins,
    },
    content: {
      books, authors, reviews, quotes, lists, sessions,
      pagesRead: Number(pageSum[0]?.total ?? 0),
    },
    commerce: {
      orders: orders.length,
      revenue: Math.round(revenue * 100) / 100,
      pending: orders.filter((o) => ['pending', 'confirmed', 'preparing'].includes(o.status)).length,
      delivered: orders.filter((o) => o.status === 'delivered').length,
      cancelled: orders.filter((o) => o.status === 'cancelled').length,
      averageOrder: live.length > 0 ? Math.round((revenue / live.length) * 100) / 100 : 0,
    },
    moderation: { openReports, resolvedReports, removedContent },
    // Both series are padded to a fixed length including empty buckets, so the
    // chart's x-axis is stable rather than collapsing on a quiet week.
    signupTrend: padBuckets(signups, 12, 'week'),
    activityTrend: padBuckets(activity, 14, 'day'),
    topBooks: topBookRows.map((r) => ({
      id: r.id,
      title: r.title,
      authorName: r.author_name,
      coverUrl: r.cover_url,
      readers: Number(r.readers),
    })),
    topReaders: topReaderRows.map((r) => ({
      user: { id: r.id, username: r.username, name: r.name, avatarUrl: r.avatar_url },
      booksRead: Number(r.books_read),
      pagesRead: Number(r.pages_read),
    })),
    genreSpread: genreRows.map((r) => ({ genre: r.genre, count: Number(r.count) })),
  };
}

/**
 * Fills gaps in a grouped time series.
 *
 * Postgres returns no row for a bucket with no rows, so a quiet week simply
 * disappears and the chart silently compresses — making a gap look like
 * continuous activity. Every bucket is emitted, zero included.
 */
function padBuckets(
  rows: { bucket: Date; count: bigint }[],
  count: number,
  unit: 'day' | 'week',
): { label: string; value: number }[] {
  const step = unit === 'day' ? 86_400_000 : 7 * 86_400_000;
  const byKey = new Map(rows.map((r) => [r.bucket.toISOString().slice(0, 10), Number(r.count)]));

  const anchor = new Date();
  anchor.setUTCHours(0, 0, 0, 0);
  if (unit === 'week') {
    // date_trunc('week') anchors on Monday; match it so keys line up.
    const day = anchor.getUTCDay();
    anchor.setUTCDate(anchor.getUTCDate() - ((day + 6) % 7));
  }

  return Array.from({ length: count }, (_, i) => {
    const at = new Date(anchor.getTime() - (count - 1 - i) * step);
    const key = at.toISOString().slice(0, 10);
    // Day of month only. `MM-DD` needs ~34px and twelve bars share ~360px on a
    // phone, so the longer form is truncated to "08…" and stops being a label
    // at all. The series is chronological and left-to-right, so the month is
    // clear from context.
    return { label: key.slice(8), value: byKey.get(key) ?? 0 };
  });
}

/* ------------------------------ user directory ----------------------------- */

export interface AdminUserRow {
  id: string;
  username: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: string;
  createdAt: string;
  booksRead: number;
  reviewsCount: number;
  quotesCount: number;
  lastActiveAt: string | null;
  deleted: boolean;
}

/**
 * The user directory.
 *
 * Includes soft-deleted accounts, marked as such: moderation needs to see that
 * an account existed and was removed, not have it vanish from the list.
 */
export async function adminUsers(
  search: string | undefined,
  skip: number,
  take: number,
): Promise<{ items: AdminUserRow[]; total: number }> {
  const where = search
    ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { username: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
        ],
      }
    : {};

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        id: true, username: true, name: true, email: true, avatarUrl: true,
        role: true, createdAt: true, deletedAt: true,
        _count: { select: { reviews: true, quotes: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  // Counts that need a filter Prisma's `_count` cannot express, fetched for the
  // page's users only rather than per row.
  const ids = rows.map((r) => r.id);
  const [readCounts, lastSessions] = await Promise.all([
    ids.length
      ? prisma.shelfEntry.groupBy({
          by: ['userId'],
          where: { userId: { in: ids }, status: 'read' },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    ids.length
      ? prisma.readingSession.groupBy({
          by: ['userId'],
          where: { userId: { in: ids } },
          _max: { startedAt: true },
        })
      : Promise.resolve([]),
  ]);

  const readBy = new Map(readCounts.map((r) => [r.userId, r._count._all]));
  const lastBy = new Map(lastSessions.map((r) => [r.userId, r._max.startedAt]));

  return {
    items: rows.map((row) => ({
      id: row.id,
      username: row.username,
      name: row.name,
      email: row.email,
      avatarUrl: row.avatarUrl,
      role: row.role,
      createdAt: row.createdAt.toISOString(),
      booksRead: readBy.get(row.id) ?? 0,
      reviewsCount: row._count.reviews,
      quotesCount: row._count.quotes,
      lastActiveAt: lastBy.get(row.id)?.toISOString() ?? null,
      deleted: !!row.deletedAt,
    })),
    total,
  };
}

/** Every review, including soft-deleted ones — moderation needs to see both. */
export async function adminReviews(skip: number, take: number) {
  const [rows, total] = await Promise.all([
    prisma.review.findMany({
      include: {
        user: { select: userSummarySelect },
        book: { select: { title: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.review.count(),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      bookId: r.bookId,
      bookTitle: r.book.title,
      user: serializeUserSummary(r.user),
      rating: r.rating,
      body: r.body,
      isSpoiler: r.isSpoiler,
      likesCount: r.likesCount,
      commentsCount: r.commentsCount,
      isLiked: false,
      deleted: !!r.deletedAt,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
  };
}

export async function adminQuotes(skip: number, take: number) {
  const [rows, total] = await Promise.all([
    prisma.quote.findMany({
      include: {
        user: { select: userSummarySelect },
        book: { select: { id: true, title: true, coverUrl: true, author: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.quote.count(),
  ]);

  return {
    items: rows.map((q) => ({
      id: q.id,
      bookId: q.bookId,
      book: {
        id: q.book.id,
        title: q.book.title,
        authorName: q.book.author.name,
        coverUrl: q.book.coverUrl,
      },
      user: serializeUserSummary(q.user),
      text: q.text,
      page: q.page,
      background: q.background,
      likesCount: q.likesCount,
      commentsCount: q.commentsCount,
      isLiked: false,
      deleted: !!q.deletedAt,
      createdAt: q.createdAt.toISOString(),
    })),
    total,
  };
}

export async function recordAdminAction(
  adminId: string,
  action: string,
  targetType: string,
  targetId: string,
): Promise<void> {
  await prisma.adminAction.create({ data: { adminId, action, targetType, targetId } });
}
