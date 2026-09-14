import { prisma } from '../../lib/prisma.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { localDateColumn } from '../../lib/dates.js';
import { serializeUserSummary, userSummarySelect, type UserSummary } from '../users/service.js';
import { notify } from '../notifications/service.js';
import { checkGoalReached, defaultShelvesByStatus } from '../shelves/service.js';
import { evaluateBadges } from '../gamification/badges.js';

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
  /** The viewer's invitation to this group, when one is open. */
  invitation?: { id: string; status: 'pending' | 'accepted' | 'declined' } | null;
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

export async function getBuddyRead(
  id: string,
  viewerId?: string | null,
): Promise<SerializedBuddyRead> {
  const row = await prisma.buddyRead.findUnique({ where: { id }, include: buddyInclude });
  if (!row) throw notFound('Buddy read');
  const result = serialize(row as BuddyRow);

  if (viewerId) {
    const invite = await prisma.buddyReadInvitation.findUnique({
      where: { buddyReadId_inviteeId: { buddyReadId: id, inviteeId: viewerId } },
      select: { id: true, status: true },
    });
    result.invitation = invite ?? null;
  }

  return result;
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

  return getBuddyRead(id, userId);
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
    include: { buddyRead: { include: { book: { select: { id: true, pageCount: true } } } } },
  });
  if (!membership) throw forbidden('You are not a member of this buddy read');

  const book = membership.buddyRead.book;
  const targetPage = Math.max(0, Math.min(book.pageCount, Math.floor(page)));

  await prisma.buddyReadMember.update({
    where: { buddyReadId_userId: { buddyReadId: id, userId } },
    data: { progressPage: targetPage },
  });

  // Mirrors the group's page onto the reader's own shelf entry, the same way
  // `updateProgress` in shelves/service.ts does for a solo read. Without this,
  // a buddy read was a second, disconnected progress tracker: finishing a book
  // here never touched `ShelfEntry`, so it never counted toward "books read",
  // the annual goal ring, or badges — all of which read `ShelfEntry`, not
  // `BuddyReadMember`. A reader who does all their reading through a group
  // would show 0 read books forever.
  const defaults = await defaultShelvesByStatus(userId);
  const entry = await prisma.shelfEntry.findUnique({
    where: { userId_bookId: { userId, bookId: book.id } },
  });

  // No entry yet: the reader joined the group without shelving the book
  // themselves. They are demonstrably reading it, so "reading" is the shelf a
  // fresh entry belongs on — the same default a first page turn would pick.
  const previousPage = entry?.progressPage ?? 0;
  const pagesAdvanced = targetPage - previousPage;

  let status = entry?.status ?? 'reading';
  let shelfId = entry?.shelfId ?? defaults.reading.id;
  let finishedAt = entry?.finishedAt ?? null;
  let startedAt = entry?.startedAt ?? null;

  if (targetPage >= book.pageCount) {
    status = 'read';
    finishedAt = entry?.finishedAt ?? new Date();
    if (!entry || entry.status !== 'read') shelfId = defaults.read.id;
  } else if (targetPage > 0 && status !== 'reading') {
    status = 'reading';
    finishedAt = null;
    startedAt = entry?.startedAt ?? new Date();
    if (!entry || entry.status === 'want_to_read') shelfId = defaults.reading.id;
  }
  if (targetPage > 0 && !startedAt) startedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.shelfEntry.upsert({
      where: { userId_bookId: { userId, bookId: book.id } },
      create: {
        userId,
        bookId: book.id,
        shelfId,
        status,
        progressPage: targetPage,
        startedAt,
        finishedAt,
      },
      update: { shelfId, status, progressPage: targetPage, startedAt, finishedAt },
    });

    // Same signal a manual progress update or a logged session leaves: an
    // entry in `ReadingSession` so the streak and the reading-marathon badge
    // see pages turned via a buddy read exactly like pages turned any other way.
    if (pagesAdvanced > 0) {
      const now = new Date();
      await tx.readingSession.create({
        data: {
          userId,
          bookId: book.id,
          startPage: previousPage,
          endPage: targetPage,
          durationSeconds: 0,
          startedAt: now,
          endedAt: now,
          sessionDate: localDateColumn(now),
        },
      });
    }
  });

  if (status === 'read') await checkGoalReached(userId);
  void evaluateBadges(userId).catch(() => undefined);

  return getBuddyRead(id, userId);
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

/* ------------------------------- invitations ------------------------------ */

export interface SerializedBuddyInvitation {
  id: string;
  buddyReadId: string;
  inviter: UserSummary;
  invitee: UserSummary;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: string;
  respondedAt: string | null;
}

function serializeInvitation(row: {
  id: string;
  buddyReadId: string;
  inviter: { id: string; username: string; name: string; avatarUrl: string | null };
  invitee: { id: string; username: string; name: string; avatarUrl: string | null };
  status: 'pending' | 'accepted' | 'declined';
  createdAt: Date;
  respondedAt: Date | null;
}): SerializedBuddyInvitation {
  return {
    id: row.id,
    buddyReadId: row.buddyReadId,
    inviter: serializeUserSummary(row.inviter),
    invitee: serializeUserSummary(row.invitee),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    respondedAt: row.respondedAt?.toISOString() ?? null,
  };
}

/**
 * People the caller follows who can still be invited: not themselves, not
 * already a member, and not already holding an invitation.
 *
 * The client's "friends" are the people they follow — the `Follow` table is the
 * social graph, so the candidate set comes from `follows.followerId = me`.
 */
export async function invitableFriends(
  userId: string,
  id: string,
  search?: string,
): Promise<{ user: UserSummary }[]> {
  const group = await prisma.buddyRead.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!group) throw notFound('Buddy read');

  const [memberIds, invitedIds] = await Promise.all([
    prisma.buddyReadMember.findMany({
      where: { buddyReadId: id },
      select: { userId: true },
    }),
    prisma.buddyReadInvitation.findMany({
      where: { buddyReadId: id },
      select: { inviteeId: true },
    }),
  ]);
  const excluded = new Set([userId, ...memberIds.map((m) => m.userId)]);
  invitedIds.forEach((i) => excluded.add(i.inviteeId));

  const rows = await prisma.follow.findMany({
    where: {
      followerId: userId,
      ...(search
        ? {
            followee: {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { username: { contains: search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    },
    include: { followee: { select: userSummarySelect } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return rows
    .filter((r) => !excluded.has(r.followeeId))
    .map((r) => ({ user: serializeUserSummary(r.followee) }));
}

/**
 * Invite a friend into a group.
 *
 * Only members may invite. Inviting a member, yourself, or re-inviting an
 * already-pending friend conflicts; an invitation that was declined can be
 * sent again by flipping the row back to pending.
 */
export async function inviteToBuddyRead(
  inviterId: string,
  id: string,
  inviteeId: string,
): Promise<SerializedBuddyInvitation> {
  if (inviterId === inviteeId) throw conflict('You cannot invite yourself');

  const group = await prisma.buddyRead.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!group) throw notFound('Buddy read');

  const [membership, target] = await Promise.all([
    prisma.buddyReadMember.count({ where: { buddyReadId: id, userId: inviterId } }),
    prisma.user.findFirst({ where: { id: inviteeId, deletedAt: null } }),
  ]);
  if (membership === 0) throw forbidden('Only members can invite to a buddy read');
  if (!target) throw notFound('User');
  if ((await prisma.buddyReadMember.count({ where: { buddyReadId: id, userId: inviteeId } })) > 0) {
    throw conflict('That user is already a member');
  }

  const existing = await prisma.buddyReadInvitation.findUnique({
    where: { buddyReadId_inviteeId: { buddyReadId: id, inviteeId } },
  });
  if (existing && existing.status === 'pending') {
    throw conflict('Invitation already sent');
  }

  const invitation = await prisma.buddyReadInvitation.upsert({
    where: { buddyReadId_inviteeId: { buddyReadId: id, inviteeId } },
    create: { buddyReadId: id, inviterId, inviteeId, status: 'pending' },
    update: { status: 'pending', inviterId, respondedAt: null, createdAt: new Date() },
    include: { inviter: { select: userSummarySelect }, invitee: { select: userSummarySelect } },
  });

  const me = await prisma.user.findUnique({ where: { id: inviterId }, select: { name: true } });
  await notify(inviteeId, 'buddy_invite', { name: me?.name ?? '' }, `/buddy-reads/${id}`, inviterId);

  return serializeInvitation(invitation);
}

/** Confirms an invitation is writable by this reader, and returns it. */
async function assertInvitationOwner(
  userId: string,
  buddyReadId: string,
  invitationId: string,
) {
  const invitation = await prisma.buddyReadInvitation.findUnique({
    where: { id: invitationId },
    include: { inviter: { select: userSummarySelect }, invitee: { select: userSummarySelect } },
  });
  if (!invitation || invitation.buddyReadId !== buddyReadId) throw notFound('Invitation');
  if (invitation.inviteeId !== userId) throw forbidden('Only the invited reader can respond');
  return invitation;
}

export async function acceptBuddyInvitation(
  userId: string,
  buddyReadId: string,
  invitationId: string,
): Promise<SerializedBuddyRead> {
  const invitation = await assertInvitationOwner(userId, buddyReadId, invitationId);
  if (invitation.status === 'accepted') return getBuddyRead(buddyReadId, userId);

  await prisma.$transaction([
    prisma.buddyReadInvitation.update({
      where: { id: invitationId },
      data: { status: 'accepted', respondedAt: new Date() },
    }),
    prisma.buddyReadMember.upsert({
      where: { buddyReadId_userId: { buddyReadId, userId } },
      create: { buddyReadId, userId, progressPage: 0 },
      update: {},
    }),
  ]);

  return getBuddyRead(buddyReadId, userId);
}

export async function declineBuddyInvitation(
  userId: string,
  buddyReadId: string,
  invitationId: string,
): Promise<void> {
  const invitation = await assertInvitationOwner(userId, buddyReadId, invitationId);
  if (invitation.status === 'pending') {
    await prisma.buddyReadInvitation.update({
      where: { id: invitationId },
      data: { status: 'declined', respondedAt: new Date() },
    });
  }
}

/** All invitations to a group — members only, so the list is spoiler-safe. */
export async function listInvitations(
  userId: string,
  buddyReadId: string,
): Promise<SerializedBuddyInvitation[]> {
  await assertMember(userId, buddyReadId);

  const rows = await prisma.buddyReadInvitation.findMany({
    where: { buddyReadId },
    include: { inviter: { select: userSummarySelect }, invitee: { select: userSummarySelect } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    buddyReadId: r.buddyReadId,
    inviter: serializeUserSummary(r.inviter),
    invitee: serializeUserSummary(r.invitee),
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    respondedAt: r.respondedAt?.toISOString() ?? null,
  }));
}

export { conflict };
