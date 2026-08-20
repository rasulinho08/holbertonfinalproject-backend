import { prisma } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';
import { bookInclude, withShelfState, type SerializedBook } from '../books/service.js';

export interface SerializedAuthor {
  id: string;
  name: string;
  slug: string;
  bio: string;
  photoUrl: string | null;
  bookCount: number;
  followersCount: number;
  isFollowing?: boolean;
}

export async function getAuthor(id: string, viewerId: string | null): Promise<SerializedAuthor> {
  // Resolved by id or slug, so `/authors/nizami-gencevi` is a shareable URL.
  const author = await prisma.author.findFirst({
    where: { OR: [{ id }, { slug: id }] },
  });
  if (!author) throw notFound('Author');

  const [bookCount, followersCount, isFollowing] = await Promise.all([
    prisma.book.count({ where: { authorId: author.id, deletedAt: null } }),
    prisma.authorFollow.count({ where: { authorId: author.id } }),
    viewerId
      ? prisma.authorFollow
          .count({ where: { authorId: author.id, userId: viewerId } })
          .then((n) => n > 0)
      : Promise.resolve(undefined),
  ]);

  return {
    id: author.id,
    name: author.name,
    slug: author.slug,
    bio: author.bio,
    photoUrl: author.photoUrl,
    bookCount,
    followersCount,
    ...(isFollowing !== undefined && { isFollowing }),
  };
}

export async function authorBooks(
  authorId: string,
  skip: number,
  take: number,
  viewerId: string | null,
): Promise<{ books: SerializedBook[]; total: number }> {
  const author = await prisma.author.findFirst({
    where: { OR: [{ id: authorId }, { slug: authorId }] },
    select: { id: true },
  });
  if (!author) throw notFound('Author');

  const [rows, total] = await Promise.all([
    prisma.book.findMany({
      where: { authorId: author.id, deletedAt: null },
      include: bookInclude,
      orderBy: [{ ratingCount: 'desc' }, { publishedYear: 'desc' }],
      skip,
      take,
    }),
    prisma.book.count({ where: { authorId: author.id, deletedAt: null } }),
  ]);

  return { books: await withShelfState(rows, viewerId), total };
}

/**
 * Follow / unfollow.
 *
 * Idempotent in both directions: following twice is not a 409, and unfollowing
 * something you do not follow is not a 404. The client fires these optimistically
 * and a retry after a dropped connection must not surface an error.
 */
export async function setAuthorFollow(
  userId: string,
  authorId: string,
  follow: boolean,
): Promise<{ following: boolean; followersCount: number }> {
  const author = await prisma.author.findUnique({ where: { id: authorId }, select: { id: true } });
  if (!author) throw notFound('Author');

  if (follow) {
    await prisma.authorFollow.upsert({
      where: { userId_authorId: { userId, authorId } },
      create: { userId, authorId },
      update: {},
    });
  } else {
    await prisma.authorFollow.deleteMany({ where: { userId, authorId } });
  }

  return {
    following: follow,
    followersCount: await prisma.authorFollow.count({ where: { authorId } }),
  };
}
