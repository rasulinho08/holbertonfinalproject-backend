import type { Response } from 'express';

/**
 * The response envelope from backend-guide/CONVENTIONS.md §2.
 *
 * Every 2xx body is `{ data }`, list bodies add `{ meta }`. The frontend's HTTP
 * client unwraps `data` unconditionally, so a route that returns a bare object
 * silently hands the screen the envelope instead of the payload — which is why
 * nothing writes `res.json()` directly.
 */

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export function ok<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json({ data });
}

export function created<T>(res: Response, data: T): Response {
  return ok(res, data, 201);
}

export function noContent(res: Response): Response {
  return res.status(204).end();
}

export function page<T>(res: Response, data: T[], meta: PageMeta): Response {
  return res.status(200).json({ data, meta });
}

/**
 * Builds the `meta` block for a page of results.
 *
 * Callers pass the total from a separate COUNT, since `data.length` is the page
 * size and not the total — getting that wrong makes infinite scroll stop after
 * one page, which is a bug the client cannot detect.
 */
export function buildMeta(total: number, pageNumber: number, limit: number): PageMeta {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    page: pageNumber,
    limit,
    total,
    totalPages,
    hasMore: pageNumber < totalPages,
  };
}
