import { prisma } from './prisma.js';
import { localDateKey, shiftDateKey, todayKey, DEFAULT_TZ } from './dates.js';

/**
 * Reading streaks, derived from `reading_sessions`.
 *
 * Nothing about a streak is stored. It is a pure function of the distinct
 * local days a reader logged a session on, which means it cannot drift out of
 * sync with the sessions and there is no counter to repair after a delete.
 *
 * The window is bounded to a year: a streak longer than that would be a
 * remarkable achievement and is not worth an unbounded scan on every profile
 * read.
 */

const WINDOW_DAYS = 400;

export interface StreakInfo {
  current: number;
  longest: number;
  readToday: boolean;
}

/** The distinct local days a reader has logged a session on, newest first. */
async function activeDays(userId: string, timeZone: string): Promise<string[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const rows = await prisma.readingSession.findMany({
    where: { userId, startedAt: { gte: since } },
    select: { startedAt: true },
    orderBy: { startedAt: 'desc' },
  });

  // Bucketed here rather than by the stored `session_date` column, because a
  // reader who changes timezone should see their history re-bucketed to where
  // they are now, not where they were.
  const keys = new Set(rows.map((r) => localDateKey(r.startedAt, timeZone)));
  return [...keys].sort((a, b) => b.localeCompare(a));
}

export async function getStreak(userId: string, timeZone = DEFAULT_TZ): Promise<StreakInfo> {
  const days = await activeDays(userId, timeZone);
  if (days.length === 0) return { current: 0, longest: 0, readToday: false };

  const today = todayKey(timeZone);
  const yesterday = shiftDateKey(today, -1);
  const readToday = days[0] === today;

  // A streak survives "read yesterday but not yet today" — otherwise it would
  // reset at local midnight and the number would be wrong for most of the day.
  let current = 0;
  if (days[0] === today || days[0] === yesterday) {
    let cursor = days[0]!;
    current = 1;
    for (const day of days.slice(1)) {
      if (day === shiftDateKey(cursor, -1)) {
        current += 1;
        cursor = day;
      } else {
        break;
      }
    }
  }

  // Longest run anywhere in the window.
  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    if (days[i] === shiftDateKey(days[i - 1]!, -1)) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }
  longest = Math.max(longest, current);

  return { current, longest, readToday };
}

/**
 * Pages read per local day for the last `count` days, oldest first.
 *
 * Returns exactly `count` entries including zeros, so the chart's x-axis is
 * stable and the client can render it without padding.
 */
export async function weeklyPages(
  userId: string,
  count = 7,
  timeZone = DEFAULT_TZ,
): Promise<number[]> {
  const since = new Date(Date.now() - (count + 2) * 86_400_000);
  const rows = await prisma.readingSession.findMany({
    where: { userId, startedAt: { gte: since } },
    select: { startedAt: true, startPage: true, endPage: true },
  });

  const byDay = new Map<string, number>();
  for (const row of rows) {
    const key = localDateKey(row.startedAt, timeZone);
    byDay.set(key, (byDay.get(key) ?? 0) + Math.max(0, row.endPage - row.startPage));
  }

  const today = todayKey(timeZone);
  return Array.from({ length: count }, (_, i) =>
    byDay.get(shiftDateKey(today, i - (count - 1))) ?? 0,
  );
}
