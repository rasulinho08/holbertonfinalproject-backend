import type { Request } from 'express';

/**
 * Pagination and query-parameter parsing.
 *
 * CONVENTIONS.md §4 is explicit that out-of-range values are **clamped, not
 * rejected**, and that a page past the end returns an empty array with correct
 * meta rather than a 404. Both matter: the app's infinite scroll fires a
 * request for page N+1 the moment the list nears its end, and a 404 there would
 * surface as an error toast on a perfectly normal scroll.
 */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface Pagination {
  page: number;
  limit: number;
  skip: number;
  take: number;
}

export function pagination(req: Request): Pagination {
  const rawPage = Number(req.query.page);
  const rawLimit = Number(req.query.limit);

  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(rawLimit)))
    : DEFAULT_PAGE_SIZE;

  return { page, limit, skip: (page - 1) * limit, take: limit };
}

/**
 * Reads a repeated query key into an array.
 *
 * The app sends `?genres=novel&genres=poetry`; CONVENTIONS.md §5 makes the
 * repeated form mandatory and the comma form optional, so both are accepted
 * here — a hand-written curl with `?genres=novel,poetry` should not behave
 * differently from the app.
 */
export function queryList(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

export function queryString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = Array.isArray(value) ? String(value[0] ?? '') : String(value);
  const trimmed = s.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function queryNumber(value: unknown): number | undefined {
  const s = queryString(value);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function queryBoolean(value: unknown): boolean | undefined {
  const s = queryString(value)?.toLowerCase();
  if (s === undefined) return undefined;
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return undefined;
}

/**
 * Picks a sort value from a fixed vocabulary.
 *
 * CONVENTIONS.md §6: an unknown value falls back to the default rather than
 * erroring, so a stale client that still sends a retired sort keeps working.
 */
export function querySort<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const s = queryString(value);
  return s && (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}
