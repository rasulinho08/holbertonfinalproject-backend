import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { env } from '../config/env.js';

/**
 * Calendar-day arithmetic in the reader's timezone.
 *
 * Streaks, "did they read today?" and the weekly chart are all questions about
 * *local* days. Computing them in UTC costs a Baku reader (UTC+4) their streak
 * every time they read after 20:00, because that reading lands on tomorrow's
 * UTC date. Every day boundary in the codebase goes through here.
 */

export const DEFAULT_TZ = env.DEFAULT_TIMEZONE;

/** `2026-08-07` for an instant, in the given timezone. */
export function localDateKey(instant: Date, timeZone = DEFAULT_TZ): string {
  return formatInTimeZone(instant, timeZone, 'yyyy-MM-dd');
}

/**
 * The `date` column value for an instant.
 *
 * Postgres `date` has no timezone, and Prisma round-trips it as UTC midnight,
 * so the stored value must be UTC midnight of the *local* day — not the UTC day.
 */
export function localDateColumn(instant: Date, timeZone = DEFAULT_TZ): Date {
  return new Date(`${localDateKey(instant, timeZone)}T00:00:00.000Z`);
}

/** Today's local date key. */
export function todayKey(timeZone = DEFAULT_TZ): string {
  return localDateKey(new Date(), timeZone);
}

/** `2026-08-07` → the Date to compare a `date` column against. */
export function dateKeyToColumn(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/** Steps a date key back by `days`. */
export function shiftDateKey(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The last `count` local date keys, oldest first — the x-axis of the weekly
 * chart. Always exactly `count` entries, including days with no activity, so
 * the client can zip it against values without checking lengths.
 */
export function recentDateKeys(count: number, timeZone = DEFAULT_TZ): string[] {
  const today = todayKey(timeZone);
  return Array.from({ length: count }, (_, i) => shiftDateKey(today, i - (count - 1)));
}

/** Start of the local day, as an instant — for filtering timestamptz columns. */
export function startOfLocalDay(key: string, timeZone = DEFAULT_TZ): Date {
  // toZonedTime gives the wall-clock time; subtracting the offset recovers the
  // instant that wall-clock midnight corresponds to.
  const naive = new Date(`${key}T00:00:00.000`);
  const zoned = toZonedTime(naive, timeZone);
  return new Date(naive.getTime() - (zoned.getTime() - naive.getTime()));
}
