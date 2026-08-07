import { prisma, isUniqueViolation } from '../../lib/prisma.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { bookInclude, serializeBook, type SerializedBook } from '../books/service.js';
import { serializeUserSummary, userSummarySelect, type UserSummary } from '../users/service.js';

/**
 * Curated book lists.
 *
 * Distinct from a shelf: a shelf is private reading state, a list is an
 * editorial artefact other readers follow. Hence a separate tree rather than a
 * flag on `shelves`.
 */

export interface SerializedList {
  id: string;
  slug: string;
  title: string;
  description: string;
  owner: UserSummary;
  isOfficial: boolean;
  bookCount: number;
  followersCount: number;
  isFollowing: boolean;
  coverUrls: string[];
  createdAt: string;
}

export interface SerializedListDetail extends SerializedList {
  items: { bookId: string; book: SerializedBook; note: string | null; position: number }[];
}

/**
 * ASCII-folds a title into a URL-safe slug.
 *
 * Azerbaijani letters are folded explicitly — `encodeURIComponent` would give a
 * technically valid but unreadable `/lists/az%C9%99rbaycan-klassikl%C9%99ri`.
 */
export function slugify(title: string): string {
  const folded = title
    .toLowerCase()
    .replace(/ə/g, 'e')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ç/g, 'c')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

  return folded.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'list';
}

async function uniqueSlug(base: string): Promise<string> {
  if ((await prisma.bookList.count({ where: { slug: base } })) === 0) return base;
  for (let i = 2; i < 200; i++) {
    const candidate = `${base}-${i}`;
    if ((await prisma.bookList.count({ where: { slug: candidate } })) === 0) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

type ListRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  isOfficial: boolean;
  followersCount: number;
  createdAt: Date;
  owner: { id: string; username: string; name: string; avatarUrl: string | null };
  items: { book: { coverUrl: string | null } }[];
  _count: { items: number };
};

const listInclude = {
  owner: { select: userSummarySelect },
  // Four covers for the fanned thumbnail stack, taken with the list so browsing
  // stays one query.
  items: { take: 4, orderBy: { position: 'asc' }, select: { book: { select: { coverUrl: true } } } },
  _count: { select: { items: true } },
} as const;

function serialize(row: ListRow, isFollowing: boolean): SerializedList {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    owner: serializeUserSummary(row.owner),
    isOfficial: row.isOfficial,
    bookCount: row._count.items,
    followersCount: row.followersCount,
    isFollowing,
    coverUrls: row.items.map((i) => i.book.coverUrl).filter((u): u is string => !!u),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Adds `isFollowing` to a page of lists in one query rather than per row. */
async function withFollowState(rows: ListRow[], viewerId: string | null) {
  if (!viewerId || rows.length === 0) return rows.map((r) => serialize(r, false));
  const follows = await prisma.bookListFollow.findMany({
    where: { userId: viewerId, listId: { in: rows.map((r) => r.id) } },
    select: { listId: true },
  });
  const following = new Set(follows.map((f) => f.listId));
  return rows.map((r) => serialize(r, following.has(r.id)));
}

export type ListScope = 'all' | 'mine' | 'following';

export async function listLists(
  scope: ListScope,
  search: string | undefined,
  viewerId: string | null,
  skip: number,
  take: number,
): Promise<{ items: SerializedList[]; total: number }> {
  const where: Record<string, unknown> = { deletedAt: null };

  if (scope === 'mine') {
    if (!viewerId) return { items: [], total: 0 };
    where.ownerId = viewerId;
  }
  if (scope === 'following') {
    if (!viewerId) return { items: [], total: 0 };
    where.followers = { some: { userId: viewerId } };
  }
  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.bookList.findMany({
      where,
      include: listInclude,
      // Editorial lists first, then by reach — the Explore rail wants the
      // curated ones at the front.
      orderBy: [{ isOfficial: 'desc' }, { followersCount: 'desc' }, { createdAt: 'desc' }],
      skip,
      take,
    }),
    prisma.bookList.count({ where }),
  ]);

  return { items: await withFollowState(rows as ListRow[], viewerId), total };
}

export async function getList(
  idOrSlug: string,
  viewerId: string | null,
): Promise<SerializedListDetail> {
  const list = await prisma.bookList.findFirst({
    where: { deletedAt: null, OR: [{ slug: idOrSlug }, ...(isUuid(idOrSlug) ? [{ id: idOrSlug }] : [])] },
    include: {
      ...listInclude,
      items: { orderBy: { position: 'asc' }, include: { book: { include: bookInclude } } },
    },
  });
  if (!list) throw notFound('List');

  const [isFollowing, shelfEntries] = await Promise.all([
    viewerId
      ? prisma.bookListFollow
          .count({ where: { listId: list.id, userId: viewerId } })
          .then((n) => n > 0)
      : Promise.resolve(false),
    viewerId
      ? prisma.shelfEntry.findMany({
          where: { userId: viewerId, bookId: { in: list.items.map((i) => i.bookId) } },
          select: { bookId: true, status: true, progressPage: true },
        })
      : Promise.resolve([]),
  ]);
  const byBook = new Map(shelfEntries.map((e) => [e.bookId, e]));

  const base = serialize(
    {
      ...list,
      items: list.items.slice(0, 4).map((i) => ({ book: { coverUrl: i.book.coverUrl } })),
      _count: { items: list.items.length },
    } as ListRow,
    isFollowing,
  );

  return {
    ...base,
    items: list.items.map((item) => ({
      bookId: item.bookId,
      book: serializeBook(item.book, byBook.get(item.bookId) ?? null),
      note: item.note,
      position: item.position,
    })),
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function listsForBook(
  bookId: string,
  viewerId: string | null,
  take: number,
): Promise<SerializedList[]> {
  const rows = await prisma.bookList.findMany({
    where: { deletedAt: null, items: { some: { bookId } } },
    include: listInclude,
    orderBy: [{ isOfficial: 'desc' }, { followersCount: 'desc' }],
    take,
  });
  return withFollowState(rows as ListRow[], viewerId);
}

/* ---------------------------------- write --------------------------------- */

export async function createList(
  ownerId: string,
  title: string,
  description: string,
): Promise<SerializedList> {
  const list = await prisma.bookList.create({
    data: {
      ownerId,
      title: title.trim(),
      description: description.trim(),
      slug: await uniqueSlug(slugify(title)),
      // Never taken from the request body: the verified badge in the UI keys
      // on this, so a reader could otherwise mark their own list editorial.
      isOfficial: false,
    },
    include: listInclude,
  });
  return serialize(list as ListRow, false);
}

async function ownedList(userId: string, listId: string) {
  const list = await prisma.bookList.findFirst({ where: { id: listId, deletedAt: null } });
  if (!list) throw notFound('List');
  if (list.ownerId !== userId) throw forbidden('This is not your list');
  return list;
}

export async function updateList(
  userId: string,
  listId: string,
  input: { title?: string; description?: string },
): Promise<SerializedList> {
  await ownedList(userId, listId);
  const updated = await prisma.bookList.update({
    where: { id: listId },
    data: {
      ...(input.title !== undefined && { title: input.title.trim() }),
      ...(input.description !== undefined && { description: input.description.trim() }),
    },
    include: listInclude,
  });
  return serialize(updated as ListRow, false);
}

export async function deleteList(userId: string, listId: string): Promise<void> {
  await ownedList(userId, listId);
  await prisma.bookList.update({ where: { id: listId }, data: { deletedAt: new Date() } });
}

export async function setListFollow(
  userId: string,
  listId: string,
  follow: boolean,
): Promise<{ following: boolean; followersCount: number }> {
  const list = await prisma.bookList.findFirst({
    where: { id: listId, deletedAt: null },
    select: { id: true },
  });
  if (!list) throw notFound('List');

  if (follow) {
    // The counter cache is maintained by a trigger, so a duplicate insert must
    // be avoided rather than swallowed — upsert does not fire the trigger twice.
    await prisma.bookListFollow.upsert({
      where: { listId_userId: { listId, userId } },
      create: { listId, userId },
      update: {},
    });
  } else {
    await prisma.bookListFollow.deleteMany({ where: { listId, userId } });
  }

  const updated = await prisma.bookList.findUnique({
    where: { id: listId },
    select: { followersCount: true },
  });
  return { following: follow, followersCount: updated?.followersCount ?? 0 };
}

export async function addBook(
  userId: string,
  listId: string,
  bookId: string,
  note?: string,
): Promise<SerializedList> {
  await ownedList(userId, listId);

  const book = await prisma.book.findFirst({
    where: { id: bookId, deletedAt: null },
    select: { id: true },
  });
  if (!book) throw notFound('Book');

  const count = await prisma.bookListItem.count({ where: { listId } });

  try {
    await prisma.bookListItem.create({
      data: { listId, bookId, note: note?.slice(0, 200) ?? null, position: count },
    });
  } catch (error) {
    // The composite primary key is what turns a duplicate into a 409 rather
    // than a silent second row; the client shows "already on this list".
    if (isUniqueViolation(error)) throw conflict('That book is already on this list');
    throw error;
  }

  const updated = await prisma.bookList.findUnique({ where: { id: listId }, include: listInclude });
  return serialize(updated as ListRow, false);
}

export async function removeBook(
  userId: string,
  listId: string,
  bookId: string,
): Promise<SerializedList> {
  await ownedList(userId, listId);

  await prisma.$transaction(async (tx) => {
    await tx.bookListItem.deleteMany({ where: { listId, bookId } });

    // Positions are re-packed so they stay contiguous from 0. The client renders
    // by position, and a gap shows up as a jump in the numbering.
    const remaining = await tx.bookListItem.findMany({
      where: { listId },
      orderBy: { position: 'asc' },
      select: { bookId: true },
    });
    for (const [index, item] of remaining.entries()) {
      await tx.bookListItem.update({
        where: { listId_bookId: { listId, bookId: item.bookId } },
        data: { position: index },
      });
    }
  });

  const updated = await prisma.bookList.findUnique({ where: { id: listId }, include: listInclude });
  return serialize(updated as ListRow, false);
}
