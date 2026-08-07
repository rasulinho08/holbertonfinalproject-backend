import { prisma } from '../../lib/prisma.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { localDateColumn, localDateKey, recentDateKeys } from '../../lib/dates.js';
import { evaluateBadges } from '../gamification/badges.js';

/**
 * Reading sessions — one row per sitting.
 *
 * The important part is not the CRUD; it is that logging a session is also a
 * progress update. The backend owns that consequence rather than making the
 * client fire a second request, because the two writes have to agree: a
 * session that says "I reached page 134" and a shelf entry still on 96 is a
 * reader whose progress bar silently disagrees with their own history.
 */

export interface SerializedSession {
  id: string;
  userId: string;
  bookId: string;
  book?: { id: string; title: string; authorName: string; coverUrl: string | null; pageCount: number };
  startPage: number;
  endPage: number;
  durationSeconds: number;
  note: string | null;
  startedAt: string;
  endedAt: string;
}

const sessionInclude = {
  book: { include: { author: { select: { name: true } } } },
} as const;

type SessionRow = {
  id: string;
  userId: string;
  bookId: string;
  startPage: number;
  endPage: number;
  durationSeconds: number;
  note: string | null;
  startedAt: Date;
  endedAt: Date;
  book?: { id: string; title: string; coverUrl: string | null; pageCount: number; author: { name: string } };
};

function serialize(row: SessionRow): SerializedSession {
  return {
    id: row.id,
    userId: row.userId,
    bookId: row.bookId,
    ...(row.book && {
      book: {
        id: row.book.id,
        title: row.book.title,
        authorName: row.book.author.name,
        coverUrl: row.book.coverUrl,
        pageCount: row.book.pageCount,
      },
    }),
    startPage: row.startPage,
    endPage: row.endPage,
    durationSeconds: row.durationSeconds,
    note: row.note,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
  };
}

export async function listSessions(
  userId: string,
  skip: number,
  take: number,
  bookId?: string,
): Promise<{ items: SerializedSession[]; total: number }> {
  const where = { userId, ...(bookId && { bookId }) };
  const [rows, total] = await Promise.all([
    prisma.readingSession.findMany({
      where,
      include: sessionInclude,
      orderBy: { startedAt: 'desc' },
      skip,
      take,
    }),
    prisma.readingSession.count({ where }),
  ]);
  return { items: rows.map(serialize), total };
}

/* ---------------------------------- write --------------------------------- */

export interface LogSessionInput {
  bookId: string;
  startPage: number;
  endPage: number;
  durationSeconds: number;
  note?: string | undefined;
}

export async function logSession(
  userId: string,
  input: LogSessionInput,
): Promise<SerializedSession> {
  const book = await prisma.book.findFirst({
    where: { id: input.bookId, deletedAt: null },
    select: { id: true, pageCount: true },
  });
  if (!book) throw notFound('Book');

  if (input.endPage < input.startPage) {
    throw badRequest('End page must be at or after the start page', { endPage: 'invalid' });
  }
  if (input.endPage > book.pageCount) {
    throw badRequest('End page is beyond the end of the book', { endPage: 'out_of_range' });
  }

  const endedAt = new Date();
  // Derived server-side. A client-supplied startedAt would let anyone backdate
  // a session and forge streak history.
  const startedAt = new Date(endedAt.getTime() - input.durationSeconds * 1000);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const timeZone = user?.timezone;

  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.readingSession.create({
      data: {
        userId,
        bookId: book.id,
        startPage: Math.max(0, input.startPage),
        endPage: input.endPage,
        durationSeconds: Math.max(0, Math.round(input.durationSeconds)),
        note: input.note?.slice(0, 280) ?? null,
        startedAt,
        endedAt,
        sessionDate: localDateColumn(startedAt, timeZone),
      },
      include: sessionInclude,
    });

    // The four side effects from ENDPOINTS.md §18.
    const entry = await tx.shelfEntry.findUnique({
      where: { userId_bookId: { userId, bookId: book.id } },
    });

    if (entry && input.endPage > entry.progressPage) {
      const finished = input.endPage >= book.pageCount;
      const shelves = await tx.shelf.findMany({
        where: { userId, isDefault: true },
        select: { id: true, status: true },
      });
      const shelfFor = (status: string) => shelves.find((s) => s.status === status)?.id;

      await tx.shelfEntry.update({
        where: { id: entry.id },
        data: {
          progressPage: input.endPage,
          status: finished ? 'read' : entry.status === 'want_to_read' ? 'reading' : entry.status,
          // Only leave a custom shelf when the status genuinely changes.
          ...(finished && entry.status !== 'read' && { shelfId: shelfFor('read') ?? entry.shelfId }),
          ...(!finished &&
            entry.status === 'want_to_read' && {
              shelfId: shelfFor('reading') ?? entry.shelfId,
            }),
          startedAt: entry.startedAt ?? startedAt,
          ...(finished && { finishedAt: entry.finishedAt ?? endedAt }),
        },
      });
    }

    return created;
  });

  // Badges are re-evaluated outside the transaction: awarding one is not worth
  // rolling back a session over.
  void evaluateBadges(userId).catch(() => undefined);

  return serialize(session);
}

export async function deleteSession(userId: string, id: string): Promise<void> {
  const result = await prisma.readingSession.deleteMany({ where: { id, userId } });
  if (result.count === 0) throw notFound('Session');
}

/* ---------------------------------- stats --------------------------------- */

export interface ReadingStats {
  sessionCount: number;
  totalMinutes: number;
  totalPages: number;
  pagesPerHour: number;
  dailyMinutes: number[];
  longestSessionMinutes: number;
}

export async function readingStats(userId: string, days: number): Promise<ReadingStats> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const timeZone = user?.timezone;

  const since = new Date(Date.now() - days * 86_400_000);
  const sessions = await prisma.readingSession.findMany({
    where: { userId, startedAt: { gte: since } },
    select: { startedAt: true, startPage: true, endPage: true, durationSeconds: true },
  });

  const totalSeconds = sessions.reduce((sum, s) => sum + s.durationSeconds, 0);
  const totalPages = sessions.reduce((sum, s) => sum + Math.max(0, s.endPage - s.startPage), 0);

  // Only timed sessions may feed the speed estimate. Including the zero-duration
  // rows that a plain progress update writes would drag the average towards
  // zero and make the number meaningless.
  const timed = sessions.filter((s) => s.durationSeconds > 0);
  const timedSeconds = timed.reduce((sum, s) => sum + s.durationSeconds, 0);
  const timedPages = timed.reduce((sum, s) => sum + Math.max(0, s.endPage - s.startPage), 0);

  const minutesByDay = new Map<string, number>();
  for (const s of sessions) {
    const key = localDateKey(s.startedAt, timeZone);
    minutesByDay.set(key, (minutesByDay.get(key) ?? 0) + s.durationSeconds / 60);
  }

  return {
    sessionCount: sessions.length,
    totalMinutes: Math.round(totalSeconds / 60),
    totalPages,
    pagesPerHour: timedSeconds > 0 ? Math.round((timedPages / timedSeconds) * 3600) : 0,
    // Always seven entries, including zeros — the chart's x-axis is fixed.
    dailyMinutes: recentDateKeys(7, timeZone).map((key) =>
      Math.round(minutesByDay.get(key) ?? 0),
    ),
    longestSessionMinutes:
      sessions.length === 0
        ? 0
        : Math.round(Math.max(...sessions.map((s) => s.durationSeconds)) / 60),
  };
}
