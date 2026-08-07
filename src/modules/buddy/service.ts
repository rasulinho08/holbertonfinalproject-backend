import { prisma } from '../../lib/prisma.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { serializeUserSummary, userSummarySelect, type UserSummary } from '../users/service.js';
import { notify } from '../notifications/service.js';

/**
 * Buddy reads — a group reading the same book together.
 *
 * Progress is per member and lives on the membership row, not on the reader's
 * shelf entry: someone can be at page 40 in the group's copy while their own
 * shelf says they finished it last year on a re-read.
 */

export interface SerializedBuddyRead {
  id: string;
  name: string;
  bookId: string;
  book: { id: string; title: string; authorName: string; coverUrl: string | null; pageCount: number };
  ownerId: string;
  members: { user: UserSummary; progressPage: number }[];
  targetDate: string | null;
  messagesCount: number;
  createdAt: string;
}

const buddyInclude = {
  book: { include: { author: { select: { name: true } } } },
  members: { include: { user: { select: userSummarySelect } }, orderBy: { joinedAt: 'asc' } },
  _count: { select: { messages: true } },
} as const;

type BuddyRow = {
  id: string;
  name: string;
  bookId: string;
  ownerId: string;
  targetDate: Date | null;
  createdAt: Date;
  book: { id: string; title: string; coverUrl: string | null; pageCount: number; author: { name: string } };
  members: { progressPage: number; user: { id: string; username: string; name: string; avatarUrl: string | null } }[];
  _count: { messages: number };
};

function serialize(row: BuddyRow): SerializedBuddyRead {
  return {
    id: row.id,
    name: row.name,
    bookId: row.bookId,
    book: {
      id: row.book.id,
      title: row.book.title,
      authorName: row.book.author.name,
      coverUrl: row.book.coverUrl,
      pageCount: row.book.pageCount,
    },
    ownerId: row.ownerId,
    members: row.members.map((m) => ({
      user: serializeUserSummary(m.user),
      progressPage: m.progressPage,
    })),
    targetDate: row.targetDate?.toISOString() ?? null,
    messagesCount: row._count.messages,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listBuddyReads(
  userId: string,
  skip: number,
  take: number,
): Promise<{ items: SerializedBuddyRead[]; total: number }> {
  const [rows, total] = await Promise.all([
    prisma.buddyRead.findMany({
      include: buddyInclude,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.buddyRead.count(),
  ]);

  // The reader's own groups first, then discoverable ones — the screen shows
  // both, and "mine" is what they came for.
  const items = (rows as BuddyRow[])
    .map(serialize)
    .sort((a, b) => {
      const mineA = a.members.some((m) => m.user.id === userId) ? 0 : 1;
      const mineB = b.members.some((m) => m.user.id === userId) ? 0 : 1;
      return mineA - mineB;
    });

  return { items, total };
}

export async function getBuddyRead(id: string): Promise<SerializedBuddyRead> {
  const row = await prisma.buddyRead.findUnique({ where: { id }, include: buddyInclude });
  if (!row) throw notFound('Buddy read');
  return serialize(row as BuddyRow);
}

export async function createBuddyRead(
  ownerId: string,
  input: { name: string; bookId: string; targetDate?: string | null },
): Promise<SerializedBuddyRead> {
  const book = await prisma.book.findFirst({
    where: { id: input.bookId, deletedAt: null },
    select: { id: true },
  });
  if (!book) throw notFound('Book');

  const created = await prisma.buddyRead.create({
    data: {
      name: input.name.trim(),
      bookId: input.bookId,
      ownerId,
      targetDate: input.targetDate ? new Date(input.targetDate) : null,
      // The creator is the first member; a group with no members would not
      // render and could not be joined meaningfully.
      members: { create: { userId: ownerId, progressPage: 0 } },
    },
    include: buddyInclude,
  });

  return serialize(created as BuddyRow);
}

export async function joinBuddyRead(userId: string, id: string): Promise<SerializedBuddyRead> {
  const group = await prisma.buddyRead.findUnique({
    where: { id },
    select: { id: true, ownerId: true, name: true },
  });
  if (!group) throw notFound('Buddy read');

  await prisma.buddyReadMember.upsert({
    where: { buddyReadId_userId: { buddyReadId: id, userId } },
    create: { buddyReadId: id, userId, progressPage: 0 },
    update: {},
  });

  const me = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  await notify(group.ownerId, 'buddy_invite', { name: me?.name ?? '' }, `/buddy-reads/${id}`, userId);

  return getBuddyRead(id);
}

/**
 * Leaves a group.
 *
 * If the owner leaves, ownership transfers to the longest-standing remaining
 * member; if nobody is left, the group is deleted. An ownerless group can
 * never be renamed or closed again.
 */
export async function leaveBuddyRead(userId: string, id: string): Promise<void> {
  const group = await prisma.buddyRead.findUnique({
    where: { id },
    include: { members: { orderBy: { joinedAt: 'asc' } } },
  });
  if (!group) throw notFound('Buddy read');

  await prisma.buddyReadMember.deleteMany({ where: { buddyReadId: id, userId } });

  if (group.ownerId !== userId) return;

  const remaining = group.members.filter((m) => m.userId !== userId);
  if (remaining.length === 0) {
    await prisma.buddyRead.delete({ where: { id } });
    return;
  }
  await prisma.buddyRead.update({
    where: { id },
    data: { ownerId: remaining[0]!.userId },
  });
}

export async function updateBuddyProgress(
  userId: string,
  id: string,
  page: number,
): Promise<SerializedBuddyRead> {
  const membership = await prisma.buddyReadMember.findUnique({
    where: { buddyReadId_userId: { buddyReadId: id, userId } },
    include: { buddyRead: { include: { book: { select: { pageCount: true } } } } },
  });
  if (!membership) throw forbidden('You are not a member of this buddy read');

  await prisma.buddyReadMember.update({
    where: { buddyReadId_userId: { buddyReadId: id, userId } },
    data: {
      progressPage: Math.max(0, Math.min(membership.buddyRead.book.pageCount, Math.floor(page))),
    },
  });

  return getBuddyRead(id);
}

/* -------------------------------- messages -------------------------------- */

export interface SerializedBuddyMessage {
  id: string;
  buddyReadId: string;
  user: UserSummary;
  body: string;
  chapter: number | null;
  createdAt: string;
}

async function assertMember(userId: string, buddyReadId: string): Promise<void> {
  const member = await prisma.buddyReadMember.count({ where: { buddyReadId, userId } });
  // Discussion is spoiler territory; only members read it.
  if (member === 0) throw forbidden('Join this buddy read to see the discussion');
}

export async function listMessages(
  userId: string,
  buddyReadId: string,
  skip: number,
  take: number,
): Promise<{ items: SerializedBuddyMessage[]; total: number }> {
  await assertMember(userId, buddyReadId);

  const [rows, total] = await Promise.all([
    prisma.buddyReadMessage.findMany({
      where: { buddyReadId },
      include: { user: { select: userSummarySelect } },
      orderBy: { createdAt: 'asc' },
      skip,
      take,
    }),
    prisma.buddyReadMessage.count({ where: { buddyReadId } }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      buddyReadId: row.buddyReadId,
      user: serializeUserSummary(row.user),
      body: row.body,
      chapter: row.chapter,
      createdAt: row.createdAt.toISOString(),
    })),
    total,
  };
}

export async function postMessage(
  userId: string,
  buddyReadId: string,
  body: string,
  chapter: number | null,
): Promise<SerializedBuddyMessage> {
  await assertMember(userId, buddyReadId);

  const message = await prisma.buddyReadMessage.create({
    data: { buddyReadId, userId, body: body.trim(), chapter },
    include: { user: { select: userSummarySelect } },
  });

  return {
    id: message.id,
    buddyReadId: message.buddyReadId,
    user: serializeUserSummary(message.user),
    body: message.body,
    chapter: message.chapter,
    createdAt: message.createdAt.toISOString(),
  };
}

export { conflict };
