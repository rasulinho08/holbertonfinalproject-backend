import type { ReportReason, ReportStatus, TargetType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
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

export async function adminStats() {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);

  const [openReports, removedContent, activeUsers, newUsersThisWeek] = await Promise.all([
    prisma.report.count({ where: { status: 'open' } }),
    prisma.adminAction.count({ where: { action: 'report_removed' } }),
    // "Active" means they did something, not that an account exists — a count
    // of registrations would only ever go up and tell a moderator nothing.
    prisma.readingSession
      .findMany({
        where: { startedAt: { gte: monthAgo } },
        select: { userId: true },
        distinct: ['userId'],
      })
      .then((rows) => rows.length),
    prisma.user.count({ where: { createdAt: { gte: weekAgo }, deletedAt: null } }),
  ]);

  return { openReports, removedContent, activeUsers, newUsersThisWeek };
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
