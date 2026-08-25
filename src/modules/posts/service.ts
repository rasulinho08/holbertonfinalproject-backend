import type { PublicationBook } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { serializeUserSummary, userSummarySelect, type UserSummary } from '../users/service.js';
import type { PublicationCreateInput, PublicationUpdateInput } from './schemas.js';

/**
 * Publications — editorial articles written by admins and surfaced to every
 * reader in the Explore tab.
 *
 * Admin-only writes are enforced by the route layer (`requireRole('admin')`),
 * not here. Service functions trust the callerId they receive: a route that
 * used the auth middleware passed a verified identity from the JWT payload.
 *
 * Deletes are hard-deletes per spec: the publication vanishes from Explore the
 * moment an admin removes it, and the ID is gone (404 on reopen). Soft-delete
 * would only make sense if the admin UI had an "undo" / trash view, which it
 * does not.
 */

export interface SerializedPublicationBook {
  bookId: string;
  book: {
    id: string;
    title: string;
    authorName: string;
    coverUrl: string | null;
  };
  note: string | null;
  position: number;
}

export interface SerializedPublication {
  id: string;
  title: string;
  content: string;
  coverUrl: string | null;
  author: UserSummary;
  recommendedBooks: SerializedPublicationBook[];
  createdAt: string;
  updatedAt: string;
}

/** Trimmed shape used in list endpoints — saves sending 200KB of article body
 *  over the wire when Explore only needs the title + snippet + cover. */
export interface SerializedPublicationSummary {
  id: string;
  title: string;
  /** First ~160 chars of content, plain text, no HTML stripping needed
   *  because the editor is a plain multi-line textarea. */
  excerpt: string;
  coverUrl: string | null;
  author: UserSummary;
  bookCount: number;
  createdAt: string;
}

const EXCERPT_LENGTH = 160;

/* -------------------------------- helpers -------------------------------- */

function excerpt(content: string): string {
  const stripped = content.replace(/\s+/g, ' ').trim();
  if (stripped.length <= EXCERPT_LENGTH) return stripped;
  return stripped.slice(0, EXCERPT_LENGTH).trimEnd() + '\u2026';
}

function serializeBooks(rows: (PublicationBook & {
  book: { id: string; title: string; coverUrl: string | null; author: { name: string } };
})[]): SerializedPublicationBook[] {
  return rows
    .sort((a, b) => a.position - b.position)
    .map((r) => ({
      bookId: r.bookId,
      book: {
        id: r.book.id,
        title: r.book.title,
        authorName: r.book.author.name,
        coverUrl: r.book.coverUrl,
      },
      note: r.note,
      position: r.position,
    }));
}

function serializeSummary(row: {
  id: string;
  title: string;
  content: string;
  coverUrl: string | null;
  createdAt: Date;
  author: { id: string; username: string; name: string; avatarUrl: string | null };
  recommendedBooks: { bookId: string }[];
}): SerializedPublicationSummary {
  return {
    id: row.id,
    title: row.title,
    excerpt: excerpt(row.content),
    coverUrl: row.coverUrl,
    author: serializeUserSummary(row.author),
    bookCount: row.recommendedBooks.length,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeFull(row: {
  id: string;
  title: string;
  content: string;
  coverUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  author: { id: string; username: string; name: string; avatarUrl: string | null };
  recommendedBooks: (PublicationBook & {
    book: { id: string; title: string; coverUrl: string | null; author: { name: string } };
  })[];
}): SerializedPublication {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    coverUrl: row.coverUrl,
    author: serializeUserSummary(row.author),
    recommendedBooks: serializeBooks(row.recommendedBooks),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const authorSelect = { author: { select: userSummarySelect } } as const;

/* --------------------------------- reads --------------------------------- */

export async function listPublications(
  skip: number,
  take: number,
): Promise<{ items: SerializedPublicationSummary[]; total: number }> {
  const where = {};
  const [rows, total] = await Promise.all([
    prisma.publication.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        author: { select: userSummarySelect },
        recommendedBooks: { select: { bookId: true } },
      },
    }),
    prisma.publication.count({ where }),
  ]);
  return {
    items: rows.map(serializeSummary),
    total,
  };
}

export async function getPublication(id: string): Promise<SerializedPublication> {
  const row = await prisma.publication.findUnique({
    where: { id },
    include: {
      author: { select: userSummarySelect },
      recommendedBooks: {
        include: {
          book: {
            select: {
              id: true,
              title: true,
              coverUrl: true,
              author: { select: { name: true } },
            },
          },
        },
      },
    },
  });
  if (!row) throw notFound('Publication');
  return serializeFull(row);
}

/* -------------------------------- writes --------------------------------- */

export async function createPublication(
  callerId: string,
  input: PublicationCreateInput,
): Promise<SerializedPublication> {
  const { recommendedBooks, ...data } = input;

  const bookIds = (recommendedBooks ?? []).map((r) => r.bookId);
  if (bookIds.length > 0) {
    const existing = await prisma.book.findMany({
      where: { id: { in: bookIds }, deletedAt: null },
      select: { id: true },
    });
    const found = new Set(existing.map((b) => b.id));
    const missing = bookIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw notFound(`Book${missing.length > 1 ? 's' : ''}`);
    }
  }

  const row = await prisma.publication.create({
    data: {
      title: data.title,
      content: data.content,
      coverUrl: data.coverUrl ?? null,
      authorId: callerId,
      recommendedBooks: recommendedBooks && recommendedBooks.length > 0
        ? {
            create: recommendedBooks.map((r, i) => ({
              bookId: r.bookId,
              note: r.note ?? null,
              position: i,
            })),
          }
        : undefined,
    },
    include: {
      author: { select: userSummarySelect },
      recommendedBooks: {
        include: {
          book: {
            select: {
              id: true,
              title: true,
              coverUrl: true,
              author: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  return serializeFull(row);
}

export async function updatePublication(
  callerId: string,
  id: string,
  input: PublicationUpdateInput,
): Promise<SerializedPublication> {
  const existing = await prisma.publication.findUnique({
    where: { id },
    select: { id: true, authorId: true },
  });
  if (!existing) throw notFound('Publication');

  if (existing.authorId !== callerId) {
    throw forbidden('You can only edit publications you created');
  }

  const { recommendedBooks, ...data } = input;

  return await prisma.$transaction(async (tx) => {
    if (recommendedBooks !== undefined) {
      const bookIds = recommendedBooks.map((r) => r.bookId);
      if (bookIds.length > 0) {
        const foundBooks = await tx.book.findMany({
          where: { id: { in: bookIds }, deletedAt: null },
          select: { id: true },
        });
        const found = new Set(foundBooks.map((b) => b.id));
        const missing = bookIds.filter((bid) => !found.has(bid));
        if (missing.length > 0) throw notFound(`Book${missing.length > 1 ? 's' : ''}`);
      }

      await tx.publicationBook.deleteMany({ where: { publicationId: id } });
    }

    const updated = await tx.publication.update({
      where: { id },
      data: {
        ...data,
        recommendedBooks:
          recommendedBooks !== undefined && recommendedBooks.length > 0
            ? {
                create: recommendedBooks.map((r, i) => ({
                  bookId: r.bookId,
                  note: r.note ?? null,
                  position: i,
                })),
              }
            : undefined,
      },
      include: {
        author: { select: userSummarySelect },
        recommendedBooks: {
          include: {
            book: {
              select: {
                id: true,
                title: true,
                coverUrl: true,
                author: { select: { name: true } },
              },
            },
          },
        },
      },
    });

    return serializeFull(updated);
  });
}

export async function deletePublication(callerId: string, id: string): Promise<void> {
  const existing = await prisma.publication.findUnique({
    where: { id },
    select: { id: true, authorId: true },
  });
  if (!existing) throw notFound('Publication');

  if (existing.authorId !== callerId) {
    throw forbidden('You can only delete publications you created');
  }

  await prisma.publication.delete({ where: { id } });
}
