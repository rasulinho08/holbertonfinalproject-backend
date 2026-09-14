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

export interface SerializedAuthorWithReaders extends SerializedAuthor {
  readers: number;
}

/**
 * Authors ranked by how many distinct readers have their books on the reading
 * or read shelf. Uses batched queries to avoid N+1 when hydrating counts.
 */
export async function mostReadAuthors(
  limit: number,
  viewerId: string | null,
): Promise<SerializedAuthorWithReaders[]> {
  const rows = await prisma.$queryRaw<{ authorId: string; readers: number }[]>`
    SELECT b.author_id AS "authorId", COUNT(DISTINCT se.user_id)::int AS readers
    FROM shelf_entries se
    JOIN books b ON b.id = se.book_id AND b.deleted_at IS NULL
    JOIN authors a ON a.id = b.author_id
    WHERE se.status IN ('reading', 'read')
    GROUP BY b.author_id
    ORDER BY readers DESC
    LIMIT ${limit}
  `;

  const ids = rows.map((r) => r.authorId);
  if (ids.length === 0) return [];

  const [authors, bookCounts, followerCounts, follows] = await Promise.all([
    prisma.author.findMany({ where: { id: { in: ids } } }),
    prisma.book.groupBy({
      by: ['authorId'],
      where: { authorId: { in: ids }, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.authorFollow.groupBy({
      by: ['authorId'],
      where: { authorId: { in: ids } },
      _count: { _all: true },
    }),
    viewerId
      ? prisma.authorFollow.findMany({
          where: { authorId: { in: ids }, userId: viewerId },
          select: { authorId: true },
        })
      : Promise.resolve([]),
  ]);

  const bookCountsByAuthor = new Map(bookCounts.map((r) => [r.authorId, r._count._all]));
  const followersByAuthor = new Map(followerCounts.map((r) => [r.authorId, r._count._all]));
  const following = new Set(follows.map((f) => f.authorId));
  const byId = new Map(authors.map((a) => [a.id, a]));
  const readersByAuthor = new Map(rows.map((r) => [r.authorId, r.readers]));

  return ids
    .map((id) => byId.get(id))
    .filter((a): a is NonNullable<typeof a> => !!a)
    .map((author) => ({
      id: author.id,
      name: author.name,
      slug: author.slug,
      bio: author.bio,
      photoUrl: author.photoUrl,
      bookCount: bookCountsByAuthor.get(author.id) ?? 0,
      followersCount: followersByAuthor.get(author.id) ?? 0,
      ...(viewerId ? { isFollowing: following.has(author.id) } : {}),
      readers: readersByAuthor.get(author.id) ?? 0,
    }));
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
