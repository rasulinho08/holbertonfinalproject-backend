import type { Prisma, ShelfStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { localDateColumn } from '../../lib/dates.js';
import { bookInclude, serializeBook, type SerializedBook } from '../books/service.js';
import { notify } from '../notifications/service.js';

/**
 * Shelves and reading progress — the core loop.
 *
 * A book lives on exactly one status shelf at a time, enforced by
 * `UNIQUE (user_id, book_id)` on `shelf_entries`. "Moving" a book is therefore
 * an update of that row, not a delete and an insert, which is what makes
 * `PUT /books/:id/shelf` genuinely idempotent — the offline queue replays it.
 */

export const SHELF_STATUSES: ShelfStatus[] = ['reading', 'read', 'want_to_read', 'dnf'];

/** Default shelves come back in reading order; the app renders them as tabs. */
const STATUS_ORDER: Record<ShelfStatus, number> = {
  reading: 0,
  read: 1,
  want_to_read: 2,
  dnf: 3,
};

export interface SerializedShelf {
  id: string;
  userId: string;
  status: string | null;
  name: string;
  isDefault: boolean;
  booksCount: number;
  coverUrls: string[];
}

export async function listShelves(userId: string): Promise<SerializedShelf[]> {
  const shelves = await prisma.shelf.findMany({
    where: { userId },
    include: {
      _count: { select: { entries: true } },
      // Three covers for the thumbnail stack. Taken with the shelf rather than
      // in a second pass, so the list is one query however many shelves exist.
      entries: {
        take: 3,
        orderBy: { addedAt: 'desc' },
        select: { book: { select: { coverUrl: true } } },
      },
    },
  });

  return shelves
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      if (a.status && b.status) return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      return a.name.localeCompare(b.name);
    })
    .map((shelf) => ({
      id: shelf.id,
      userId: shelf.userId,
      status: shelf.status,
      name: shelf.name,
      isDefault: shelf.isDefault,
      booksCount: shelf._count.entries,
      coverUrls: shelf.entries
        .map((e) => e.book.coverUrl)
        .filter((url): url is string => !!url),
    }));
}

export async function createShelf(userId: string, name: string): Promise<SerializedShelf[]> {
  const trimmed = name.trim();

  const clash = await prisma.shelf.count({ where: { userId, name: trimmed } });
  if (clash > 0) throw conflict('You already have a shelf with that name');

  await prisma.shelf.create({
    data: { userId, name: trimmed, isDefault: false, status: null, position: 99 },
  });

  // The whole list, not just the new shelf: the client replaces its cache with
  // the response rather than merging into it.
  return listShelves(userId);
}

export async function renameShelf(
  userId: string,
  shelfId: string,
  name: string,
): Promise<SerializedShelf[]> {
  const shelf = await prisma.shelf.findFirst({ where: { id: shelfId, userId } });
  if (!shelf) throw notFound('Shelf');
  // The four defaults are addressed by status throughout the app; renaming one
  // would break the mapping between a status and its shelf.
  if (shelf.isDefault) throw forbidden('Default shelves cannot be renamed');

  await prisma.shelf.update({ where: { id: shelfId }, data: { name: name.trim() } });
  return listShelves(userId);
}

export async function deleteShelf(userId: string, shelfId: string): Promise<SerializedShelf[]> {
  const shelf = await prisma.shelf.findFirst({ where: { id: shelfId, userId } });
  if (!shelf) throw notFound('Shelf');
  if (shelf.isDefault) throw forbidden('Default shelves cannot be deleted');

  // Deleting a custom shelf removes the grouping, not the books. Each entry
  // moves back to the default shelf for the status it already has.
  const entries = await prisma.shelfEntry.findMany({ where: { shelfId } });
  const defaults = await defaultShelvesByStatus(userId);

  await prisma.$transaction([
    ...entries.map((entry) =>
      prisma.shelfEntry.update({
        where: { id: entry.id },
        data: { shelfId: defaults[entry.status]!.id },
      }),
    ),
    prisma.shelf.delete({ where: { id: shelfId } }),
  ]);

  return listShelves(userId);
}

export async function defaultShelvesByStatus(userId: string): Promise<Record<ShelfStatus, { id: string }>> {
  const shelves = await prisma.shelf.findMany({
    where: { userId, isDefault: true },
    select: { id: true, status: true },
  });
  const map = {} as Record<ShelfStatus, { id: string }>;
  for (const shelf of shelves) {
    if (shelf.status) map[shelf.status] = { id: shelf.id };
  }
  // An account created before the defaults existed, or a partially-failed
  // registration, would otherwise fail with an unreadable error later.
  for (const status of SHELF_STATUSES) {
    if (!map[status]) {
      const created = await prisma.shelf.create({
        data: { userId, status, name: status, isDefault: true, position: STATUS_ORDER[status] },
        select: { id: true },
      });
      map[status] = created;
    }
  }
  return map;
}

/* --------------------------------- entries -------------------------------- */

export interface SerializedShelfEntry {
  id: string;
  shelfId: string;
  bookId: string;
  book: SerializedBook;
  status: string;
  progressPage: number;
  startedAt: string | null;
  finishedAt: string | null;
  addedAt: string;
}

export async function shelfBooks(
  userId: string,
  shelfId: string,
  skip: number,
  take: number,
): Promise<{ entries: SerializedShelfEntry[]; total: number }> {
  const shelf = await prisma.shelf.findFirst({ where: { id: shelfId, userId } });
  if (!shelf) throw notFound('Shelf');

  const [rows, total] = await Promise.all([
    prisma.shelfEntry.findMany({
      where: { shelfId },
      include: { book: { include: bookInclude } },
      orderBy: { addedAt: 'desc' },
      skip,
      take,
    }),
    prisma.shelfEntry.count({ where: { shelfId } }),
  ]);

  return {
    entries: rows.map((entry) => ({
      id: entry.id,
      shelfId: entry.shelfId,
      bookId: entry.bookId,
      book: serializeBook(entry.book, entry),
      status: entry.status,
      progressPage: entry.progressPage,
      startedAt: entry.startedAt?.toISOString() ?? null,
      finishedAt: entry.finishedAt?.toISOString() ?? null,
      addedAt: entry.addedAt.toISOString(),
    })),
    total,
  };
}

/* ------------------------------ set / update ------------------------------ */

export interface SetShelfInput {
  status: ShelfStatus;
  shelfId?: string | undefined;
  progressPage?: number | undefined;
}

/**
 * Adds a book to a shelf, or moves it.
 *
 * Idempotent: calling twice with the same body leaves the same state, which the
 * app's offline queue depends on when it replays a write after reconnecting.
 */
export async function setBookShelf(
  userId: string,
  bookId: string,
  input: SetShelfInput,
): Promise<SerializedBook> {
  const book = await prisma.book.findFirst({
    where: { id: bookId, deletedAt: null },
    include: bookInclude,
  });
  if (!book) throw notFound('Book');

  const defaults = await defaultShelvesByStatus(userId);
  let shelfId = defaults[input.status]!.id;

  if (input.shelfId) {
    const custom = await prisma.shelf.findFirst({ where: { id: input.shelfId, userId } });
    if (!custom) throw notFound('Shelf');
    shelfId = custom.id;
  }

  // Progress is a property of the status, not something the caller can
  // contradict: a finished book is at its last page, an unstarted one at zero.
  const progressPage =
    input.status === 'read'
      ? book.pageCount
      : input.status === 'want_to_read'
        ? 0
        : Math.max(0, Math.min(book.pageCount, input.progressPage ?? 0));

  const existing = await prisma.shelfEntry.findUnique({
    where: { userId_bookId: { userId, bookId } },
  });

  const now = new Date();
  const startedAt =
    input.status === 'want_to_read'
      ? null
      : (existing?.startedAt ?? now);
  const finishedAt = input.status === 'read' ? (existing?.finishedAt ?? now) : null;

  await prisma.shelfEntry.upsert({
    where: { userId_bookId: { userId, bookId } },
    create: {
      userId,
      bookId,
      shelfId,
      status: input.status,
      progressPage,
      startedAt,
      finishedAt,
    },
    update: { shelfId, status: input.status, progressPage, startedAt, finishedAt },
  });

  if (input.status === 'read') await checkGoalReached(userId);

  const entry = await prisma.shelfEntry.findUnique({
    where: { userId_bookId: { userId, bookId } },
    select: { status: true, progressPage: true },
  });
  return serializeBook(book, entry);
}

export async function removeBookShelf(userId: string, bookId: string): Promise<SerializedBook> {
  const book = await prisma.book.findFirst({
    where: { id: bookId, deletedAt: null },
    include: bookInclude,
  });
  if (!book) throw notFound('Book');

  // deleteMany, not delete: removing a book that is not shelved is a no-op
  // rather than a 404, so a repeated tap does not surface an error.
  await prisma.shelfEntry.deleteMany({ where: { userId, bookId } });
  return serializeBook(book, null);
}

/**
 * Updates the page number.
 *
 * Reaching the last page finishes the book, and any forward movement from
 * `want_to_read` starts it — CONVENTIONS.md §15.3. Progress also counts as
 * reading activity for the streak, which is why it writes a session row.
 */
export async function updateProgress(
  userId: string,
  bookId: string,
  rawPage: number,
): Promise<SerializedBook> {
  const entry = await prisma.shelfEntry.findUnique({
    where: { userId_bookId: { userId, bookId } },
    include: { book: { include: bookInclude } },
  });
  if (!entry) throw notFound('This book is not on any of your shelves');

  const book = entry.book;
  const page = Math.max(0, Math.min(book.pageCount, Math.floor(rawPage)));
  const defaults = await defaultShelvesByStatus(userId);

  let status: ShelfStatus = entry.status;
  let shelfId = entry.shelfId;
  let finishedAt = entry.finishedAt;
  let startedAt = entry.startedAt;

  if (page >= book.pageCount) {
    status = 'read';
    finishedAt = entry.finishedAt ?? new Date();
    // Only move the entry off a custom shelf when the status actually changes;
    // a reader who filed this on "Klassiklər" should keep it there.
    if (entry.status !== 'read') shelfId = defaults.read.id;
  } else if (page > 0 && entry.status !== 'reading') {
    status = 'reading';
    finishedAt = null;
    startedAt = entry.startedAt ?? new Date();
    if (entry.status === 'want_to_read') shelfId = defaults.reading.id;
  }

  const pagesAdvanced = page - entry.progressPage;

  await prisma.$transaction(async (tx) => {
    await tx.shelfEntry.update({
      where: { id: entry.id },
      data: { progressPage: page, status, shelfId, finishedAt, startedAt },
    });

    // Progress counts as reading activity for the streak. A session with no
    // duration records "they read today" without pretending to know for how
    // long — the timer screen is what produces timed sessions.
    if (pagesAdvanced > 0) {
      const now = new Date();
      await tx.readingSession.create({
        data: {
          userId,
          bookId,
          startPage: entry.progressPage,
          endPage: page,
          durationSeconds: 0,
          startedAt: now,
          endedAt: now,
          sessionDate: localDateColumn(now),
        },
      });
    }
  });

  if (status === 'read') await checkGoalReached(userId);

  return serializeBook(book, { status, progressPage: page });
}

/**
 * Fires `goal_reached` the first time the yearly target is met.
 *
 * Guarded on the notification not already existing this year, or every book
 * finished after the target would send another one.
 */
export async function checkGoalReached(userId: string): Promise<void> {
  const year = new Date().getFullYear();
  const goal = await prisma.readingGoal.findUnique({
    where: { userId_year: { userId, year } },
  });
  if (!goal) return;

  const completed = await prisma.shelfEntry.count({
    where: {
      userId,
      status: 'read',
      finishedAt: { gte: new Date(`${year}-01-01T00:00:00.000Z`) },
    },
  });
  if (completed < goal.target) return;

  const already = await prisma.notification.count({
    where: {
      userId,
      type: 'goal_reached',
      createdAt: { gte: new Date(`${year}-01-01T00:00:00.000Z`) },
    },
  });
  if (already > 0) return;

  await notify(userId, 'goal_reached', { count: String(goal.target) }, '/profile');
}

export type { Prisma };

/** Used by `badRequest` callers that validate a status string from the wire. */
export function assertShelfStatus(value: string): ShelfStatus {
  if (!SHELF_STATUSES.includes(value as ShelfStatus)) {
    throw badRequest('status must be one of reading, read, want_to_read, dnf', {
      status: 'invalid',
    });
  }
  return value as ShelfStatus;
}
