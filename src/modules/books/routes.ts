import { Router } from 'express';
import { asyncHandler } from '../../middleware/error.js';
import { optionalAuth, optionalUserId, requireAuth, userId } from '../../middleware/auth.js';
import { buildMeta, ok, page } from '../../lib/envelope.js';
import {
  pagination,
  queryList,
  queryNumber,
  querySort,
  queryString,
} from '../../lib/pagination.js';
import { logger } from '../../lib/logger.js';
import * as service from './service.js';
import { BOOK_SORTS, isGenreSlug } from './service.js';

export const booksRouter: Router = Router();

const LANGUAGES = new Set(['az', 'en', 'tr', 'ru']);

/**
 * Fixed paths are registered before `/:id`.
 *
 * Express matches in declaration order, so with `/:id` first a request for
 * `/books/trending` would look up a book whose id is the string "trending"
 * and 404.
 */

booksRouter.get(
  '/trending',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const limit = Math.min(50, queryNumber(req.query.limit) ?? 10);
    ok(res, await service.trendingBooks(limit, optionalUserId(req)));
  }),
);

booksRouter.get(
  '/new-releases',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const limit = Math.min(50, queryNumber(req.query.limit) ?? 10);
    ok(res, await service.newReleases(limit, optionalUserId(req)));
  }),
);

booksRouter.get(
  '/recommendations',
  requireAuth,
  asyncHandler(async (req, res) => {
    const limit = Math.min(50, queryNumber(req.query.limit) ?? 10);
    ok(res, await service.recommendations(userId(req), limit));
  }),
);

booksRouter.get(
  '/',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const q = queryString(req.query.q);
    const viewer = optionalUserId(req);

    const result = await service.listBooks(
      {
        q,
        // Unknown values are dropped rather than rejected: a stale client
        // sending a retired genre should see an unfiltered list, not an error.
        genres: queryList(req.query.genres).filter(isGenreSlug),
        languages: queryList(req.query.languages).filter((l) => LANGUAGES.has(l)),
        minRating: queryNumber(req.query.minRating),
        minPrice: queryNumber(req.query.minPrice),
        maxPrice: queryNumber(req.query.maxPrice),
        authorId: queryString(req.query.authorId),
        publisherId: queryString(req.query.publisherId),
        sort: querySort(req.query.sort, BOOK_SORTS, 'relevance'),
      },
      skip,
      take,
      viewer,
    );

    // Recorded after the query so a slow write never delays results, and
    // failures are swallowed — search history is not worth a 500.
    if (q) {
      void service.recordSearch(viewer, q).catch((err) => logger.warn({ err }, 'search history'));
    }

    res.json({
      data: result.books,
      meta: { ...buildMeta(result.total, pageNumber, limit), suggestion: result.suggestion },
    });
  }),
);

booksRouter.get(
  '/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    ok(res, await service.getBook(req.params.id!, optionalUserId(req)));
  }),
);

booksRouter.get(
  '/:id/similar',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const limit = Math.min(50, queryNumber(req.query.limit) ?? 10);
    ok(res, await service.similarBooks(req.params.id!, limit, optionalUserId(req)));
  }),
);

/* --------------------------------- genres --------------------------------- */

export const genresRouter: Router = Router();

genresRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    ok(res, await service.genreCounts());
  }),
);

/* --------------------------------- search --------------------------------- */

export const searchRouter: Router = Router();

searchRouter.get(
  '/suggest',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const term = queryString(req.query.q) ?? '';
    if (term.length < 2) {
      // Below two characters every book matches, which is noise rather than a
      // suggestion. Recent searches are still useful, so they are still sent.
      ok(res, { books: [], authors: [], recent: [] });
      return;
    }
    ok(res, await service.suggest(term, optionalUserId(req)));
  }),
);

export { page };
