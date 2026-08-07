import type { Book, BookLanguage, Prisma } from '@prisma/client';
import { prisma, money, moneyOrNull } from '../../lib/prisma.js';
import { notFound } from '../../lib/errors.js';

/**
 * Catalogue read models and queries.
 *
 * Two things here are worth reading before changing anything:
 *
 *  - `ratingAverage` is derived from `rating_sum / rating_count`, never stored.
 *    Filtering and sorting on it therefore cannot use a plain column, which is
 *    why `minRating` and `sort=rating` drop to raw SQL.
 *  - Search folds diacritics through the `kd_normalize` SQL function and the
 *    generated `search_text` column. Doing it in JavaScript would mean loading
 *    the catalogue into memory on every query.
 */

export const GENRE_SLUGS = [
  'novel', 'mystery', 'scifi', 'fantasy', 'history', 'biography', 'poetry',
  'psychology', 'philosophy', 'business', 'children', 'classic', 'science', 'selfHelp',
] as const;

export type GenreSlug = (typeof GENRE_SLUGS)[number];

export function isGenreSlug(value: string): value is GenreSlug {
  return (GENRE_SLUGS as readonly string[]).includes(value);
}

export const BOOK_SORTS = ['relevance', 'rating', 'newest', 'price_asc', 'price_desc'] as const;
export type BookSort = (typeof BOOK_SORTS)[number];

/* ------------------------------- serialising ------------------------------ */

type BookWithRelations = Book & {
  author: { id: string; name: string };
  publisher: { id: string; name: string };
};

export interface SerializedBook {
  id: string;
  title: string;
  subtitle: string | null;
  authorId: string;
  authorName: string;
  publisherId: string;
  publisherName: string;
  isbn: string;
  language: string;
  genres: string[];
  coverUrl: string | null;
  description: string;
  pageCount: number;
  publishedYear: number;
  price: number;
  oldPrice: number | null;
  stock: number;
  ratingAverage: number;
  ratingCount: number;
  reviewsCount: number;
  quotesCount: number;
  createdAt: string;
  shelfStatus?: string | null;
  progressPage?: number;
}

export const bookInclude = {
  author: { select: { id: true, name: true } },
  publisher: { select: { id: true, name: true } },
} satisfies Prisma.BookInclude;

/** `rating_sum / rating_count`, to one decimal. */
export function ratingAverage(sum: number, count: number): number {
  if (count <= 0) return 0;
  return Math.round((sum / count) * 10) / 10;
}

export function serializeBook(
  book: BookWithRelations,
  shelf?: { status: string; progressPage: number } | null,
): SerializedBook {
  return {
    id: book.id,
    title: book.title,
    subtitle: book.subtitle,
    authorId: book.authorId,
    authorName: book.author.name,
    publisherId: book.publisherId,
    publisherName: book.publisher.name,
    isbn: book.isbn ?? '',
    language: book.language,
    genres: book.genres,
    coverUrl: book.coverUrl,
    description: book.description,
    pageCount: book.pageCount,
    publishedYear: book.publishedYear ?? 0,
    price: money(book.price),
    oldPrice: moneyOrNull(book.oldPrice),
    stock: book.stock,
    ratingAverage: ratingAverage(book.ratingSum, book.ratingCount),
    ratingCount: book.ratingCount,
    reviewsCount: book.reviewsCount,
    quotesCount: book.quotesCount,
    createdAt: book.createdAt.toISOString(),
    // CONVENTIONS.md §15.2: present on every Book for an authenticated request,
    // null/0 otherwise. The client renders the shelf marker off these.
    shelfStatus: shelf?.status ?? null,
    progressPage: shelf?.progressPage ?? 0,
  };
}

/**
 * Attaches the caller's shelf state to a page of books in one query.
 *
 * Serialising each book with its own lookup would be N+1 — forty queries for a
 * forty-book grid, on the app's most-hit endpoint.
 */
export async function withShelfState(
  books: BookWithRelations[],
  viewerId: string | null,
): Promise<SerializedBook[]> {
  if (!viewerId || books.length === 0) return books.map((b) => serializeBook(b));

  const entries = await prisma.shelfEntry.findMany({
    where: { userId: viewerId, bookId: { in: books.map((b) => b.id) } },
    select: { bookId: true, status: true, progressPage: true },
  });
  const byBook = new Map(entries.map((e) => [e.bookId, e]));

  return books.map((b) => serializeBook(b, byBook.get(b.id) ?? null));
}

/* --------------------------------- filters -------------------------------- */

export interface BookFilters {
  q?: string | undefined;
  genres?: string[];
  languages?: string[];
  minRating?: number | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  authorId?: string | undefined;
  publisherId?: string | undefined;
  sort: BookSort;
}

/**
 * Builds the WHERE clause.
 *
 * Filter groups AND together, values within a group OR — which is what
 * `genres: { hasSome: [...] }` and `language: { in: [...] }` already mean.
 */
function buildWhere(filters: BookFilters): Prisma.BookWhereInput {
  const where: Prisma.BookWhereInput = { deletedAt: null };

  if (filters.genres?.length) where.genres = { hasSome: filters.genres };
  if (filters.languages?.length) where.language = { in: filters.languages as BookLanguage[] };
  if (filters.authorId) where.authorId = filters.authorId;
  if (filters.publisherId) where.publisherId = filters.publisherId;

  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    where.price = {
      ...(filters.minPrice !== undefined && { gte: filters.minPrice }),
      ...(filters.maxPrice !== undefined && { lte: filters.maxPrice }),
    };
  }

  return where;
}

function buildOrder(sort: BookSort): Prisma.BookOrderByWithRelationInput[] {
  switch (sort) {
    case 'newest':
      // Publication year first, then when we catalogued it — two books from
      // 1937 should still have a stable order.
      return [{ publishedYear: 'desc' }, { createdAt: 'desc' }];
    case 'price_asc':
      return [{ price: 'asc' }];
    case 'price_desc':
      return [{ price: 'desc' }];
    case 'rating':
    case 'relevance':
    default:
      // Popularity as a proxy: a 10.0 from three readers should not outrank an
      // 8.6 from nine thousand.
      return [{ ratingCount: 'desc' }, { createdAt: 'desc' }];
  }
}

export interface BookPage {
  books: SerializedBook[];
  total: number;
  suggestion: string | null;
}

/**
 * The catalogue query behind Explore.
 *
 * Text search and rating filters need SQL Prisma cannot express, so when either
 * is present the matching ids are fetched with `$queryRaw` and handed back to
 * Prisma as an `id IN (...)`. That keeps one code path for serialising and
 * relations while still using the trigram index.
 */
export async function listBooks(
  filters: BookFilters,
  skip: number,
  take: number,
  viewerId: string | null,
): Promise<BookPage> {
  const where = buildWhere(filters);

  // Both the text search and the rating filter narrow to a set of ids. They are
  // tracked here rather than read back out of `where`, so intersecting two of
  // them is a plain array operation.
  let candidateIds: string[] | null = null;

  if (filters.q) {
    candidateIds = await searchBookIds(filters.q);
    if (candidateIds.length === 0) {
      return { books: [], total: 0, suggestion: await suggestTerm(filters.q) };
    }
  }

  if (filters.minRating !== undefined && filters.minRating > 0) {
    const byRating = await ratingFilterIds(filters.minRating);
    candidateIds = candidateIds ? intersect(candidateIds, byRating) : byRating;
    if (candidateIds.length === 0) {
      return { books: [], total: 0, suggestion: null };
    }
  }

  if (candidateIds) where.id = { in: candidateIds };

  const [rows, total] = await Promise.all([
    prisma.book.findMany({
      where,
      include: bookInclude,
      orderBy: buildOrder(filters.sort),
      skip,
      take,
    }),
    prisma.book.count({ where }),
  ]);

  return {
    books: await withShelfState(rows, viewerId),
    total,
    // Only offered when a search returned nothing — a suggestion alongside
    // results reads as "you typed this wrong" when they did not.
    suggestion: null,
  };
}

function intersect(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((id) => set.has(id));
}

/**
 * Diacritic-insensitive id search.
 *
 * `kd_normalize` folds ə→e, ı→i, ş→s and friends, and `search_text` is a
 * generated column with a GIN trigram index over it, so "eli" finds "Əli"
 * without a sequential scan. ISBN and publisher are matched separately because
 * they are not part of `search_text`.
 */
async function searchBookIds(term: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT b.id
    FROM books b
    JOIN authors a ON a.id = b.author_id
    JOIN publishers p ON p.id = b.publisher_id
    WHERE b.deleted_at IS NULL
      AND (
        b.search_text LIKE '%' || kd_normalize(${term}) || '%'
        OR a.search_text LIKE '%' || kd_normalize(${term}) || '%'
        OR kd_normalize(p.name) LIKE '%' || kd_normalize(${term}) || '%'
        OR b.isbn = ${term}
      )
    LIMIT 2000
  `;
  return rows.map((r) => r.id);
}

async function ratingFilterIds(minRating: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM books
    WHERE deleted_at IS NULL
      AND rating_count > 0
      AND (rating_sum::numeric / rating_count) >= ${minRating}
    LIMIT 5000
  `;
  return rows.map((r) => r.id);
}

/**
 * "Did you mean…?" — the closest title or author name by trigram similarity.
 *
 * The 0.3 threshold is the point where suggestions stop being helpful: below
 * it, a two-letter typo starts matching unrelated books and the prompt does
 * more harm than the empty state it replaces.
 */
async function suggestTerm(term: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ suggestion: string; score: number }[]>`
    SELECT title AS suggestion, similarity(search_text, kd_normalize(${term})) AS score
    FROM books
    WHERE deleted_at IS NULL AND similarity(search_text, kd_normalize(${term})) > 0.3
    UNION ALL
    SELECT name AS suggestion, similarity(search_text, kd_normalize(${term})) AS score
    FROM authors
    WHERE similarity(search_text, kd_normalize(${term})) > 0.3
    ORDER BY score DESC
    LIMIT 1
  `;
  return rows[0]?.suggestion ?? null;
}

/* --------------------------------- detail --------------------------------- */

export async function getBook(id: string, viewerId: string | null): Promise<SerializedBook> {
  const book = await prisma.book.findFirst({
    where: { id, deletedAt: null },
    include: bookInclude,
  });
  if (!book) throw notFound('Book');

  const [serialized] = await withShelfState([book], viewerId);
  return serialized!;
}

/**
 * "Readers also liked".
 *
 * Scored per ENDPOINTS.md §3: shared genres ×2, same author ×3, same language
 * ×1, tie-broken by rating. Done in SQL because scoring in JavaScript would
 * mean loading the whole catalogue per request.
 */
export async function similarBooks(
  id: string,
  limit: number,
  viewerId: string | null,
): Promise<SerializedBook[]> {
  const book = await prisma.book.findFirst({ where: { id, deletedAt: null } });
  if (!book) throw notFound('Book');

  const scored = await prisma.$queryRaw<{ id: string }[]>`
    SELECT b.id
    FROM books b
    -- Every parameter compared against a uuid column needs an explicit cast:
    -- Prisma binds strings as text, and Postgres has no uuid <> text operator.
    WHERE b.deleted_at IS NULL AND b.id <> ${id}::uuid
    ORDER BY
      (
        cardinality(ARRAY(SELECT unnest(b.genres) INTERSECT SELECT unnest(${book.genres}::text[]))) * 2
        + CASE WHEN b.author_id = ${book.authorId}::uuid THEN 3 ELSE 0 END
        + CASE WHEN b.language = ${book.language}::book_language THEN 1 ELSE 0 END
      ) DESC,
      (CASE WHEN b.rating_count > 0 THEN b.rating_sum::numeric / b.rating_count ELSE 0 END) DESC
    LIMIT ${limit}
  `;

  return hydrate(scored.map((r) => r.id), viewerId);
}

/**
 * Personalised recommendations.
 *
 * Excludes anything already on one of the caller's shelves — recommending a
 * book someone is halfway through is the fastest way to look like the app is
 * not paying attention.
 */
export async function recommendations(
  userId: string,
  limit: number,
): Promise<SerializedBook[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { favoriteGenres: true },
  });
  const favoriteAuthors = await prisma.userFavoriteAuthor.findMany({
    where: { userId },
    select: { authorId: true },
  });

  const genres = user?.favoriteGenres ?? [];
  const authorIds = favoriteAuthors.map((f) => f.authorId);

  const scored = await prisma.$queryRaw<{ id: string }[]>`
    SELECT b.id
    FROM books b
    WHERE b.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM shelf_entries se
        WHERE se.book_id = b.id AND se.user_id = ${userId}::uuid
      )
    ORDER BY
      (
        cardinality(ARRAY(SELECT unnest(b.genres) INTERSECT SELECT unnest(${genres}::text[]))) * 3
        + CASE WHEN b.author_id = ANY(${authorIds}::uuid[]) THEN 4 ELSE 0 END
        + (CASE WHEN b.rating_count > 0 THEN b.rating_sum::numeric / b.rating_count ELSE 0 END) / 2
      ) DESC,
      b.rating_count DESC
    LIMIT ${limit}
  `;

  return hydrate(scored.map((r) => r.id), userId);
}

/** Loads books by id and restores the ranked order the SQL produced. */
async function hydrate(ids: string[], viewerId: string | null): Promise<SerializedBook[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.book.findMany({ where: { id: { in: ids } }, include: bookInclude });
  const byId = new Map(rows.map((b) => [b.id, b]));
  // `IN` does not preserve order, and the order is the entire point of a
  // ranked query.
  const ordered = ids.map((id) => byId.get(id)).filter((b): b is BookWithRelations => !!b);
  return withShelfState(ordered, viewerId);
}

export async function trendingBooks(
  limit: number,
  viewerId: string | null,
): Promise<SerializedBook[]> {
  // Engagement rather than rating: what people are reading and talking about
  // now, not what scored well in 1937.
  const rows = await prisma.book.findMany({
    where: { deletedAt: null },
    include: bookInclude,
    orderBy: [{ reviewsCount: 'desc' }, { quotesCount: 'desc' }, { ratingCount: 'desc' }],
    take: limit,
  });
  return withShelfState(rows, viewerId);
}

export async function newReleases(limit: number, viewerId: string | null): Promise<SerializedBook[]> {
  const rows = await prisma.book.findMany({
    where: { deletedAt: null, publishedYear: { not: null } },
    include: bookInclude,
    orderBy: [{ publishedYear: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  });
  return withShelfState(rows, viewerId);
}

/* --------------------------------- genres --------------------------------- */

export async function genreCounts(): Promise<{ slug: string; bookCount: number }[]> {
  const rows = await prisma.$queryRaw<{ slug: string; count: bigint }[]>`
    SELECT genre AS slug, COUNT(*) AS count
    FROM books, unnest(genres) AS genre
    WHERE deleted_at IS NULL
    GROUP BY genre
    ORDER BY count DESC
  `;
  return rows
    .filter((r) => isGenreSlug(r.slug))
    .map((r) => ({ slug: r.slug, bookCount: Number(r.count) }));
}

/* --------------------------------- search --------------------------------- */

export interface Suggestions {
  books: { id: string; title: string; authorName: string }[];
  authors: { id: string; name: string }[];
  recent: string[];
}

export async function suggest(term: string, userId: string | null): Promise<Suggestions> {
  const [books, authors, recent] = await Promise.all([
    prisma.$queryRaw<{ id: string; title: string; authorName: string }[]>`
      SELECT b.id, b.title, a.name AS "authorName"
      FROM books b
      JOIN authors a ON a.id = b.author_id
      WHERE b.deleted_at IS NULL
        AND (b.search_text LIKE '%' || kd_normalize(${term}) || '%'
             OR a.search_text LIKE '%' || kd_normalize(${term}) || '%')
      ORDER BY b.rating_count DESC
      LIMIT 5
    `,
    prisma.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM authors
      WHERE search_text LIKE '%' || kd_normalize(${term}) || '%'
      LIMIT 3
    `,
    userId
      ? prisma.searchHistory
          .findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            distinct: ['term'],
            take: 5,
            select: { term: true },
          })
          .then((rows) => rows.map((r) => r.term))
      : Promise.resolve([]),
  ]);

  return { books, authors, recent };
}

/** Records a search so `recent` has something to show. Never blocks a response. */
export async function recordSearch(userId: string | null, term: string): Promise<void> {
  if (!userId || term.trim().length < 2) return;
  await prisma.searchHistory.create({ data: { userId, term: term.trim().slice(0, 100) } });
}
