import { PrismaClient, Prisma } from '@prisma/client';
import { env } from '../config/env.js';

/**
 * The Prisma client.
 *
 * Held on `globalThis` in development so `tsx watch` reloading a module does not
 * open a new connection pool on every save — a few dozen reloads is enough to
 * exhaust Postgres's connection limit otherwise.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.isProduction ? ['warn', 'error'] : ['warn', 'error'],
  });

if (!env.isProduction) globalForPrisma.prisma = prisma;

/**
 * Money is `numeric(10,2)` in Postgres and arrives as a Prisma `Decimal`.
 * Serialising that straight to JSON produces `{"s":1,"e":1,"d":[14,9]}`, which
 * is how you end up with `NaN ₼` on a book card. CONVENTIONS.md §10 requires a
 * plain JSON number with two decimals, so every money field goes through here.
 */
export function money(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value) * 100) / 100;
}

export function moneyOrNull(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return money(value);
}

/** Prisma's own error type, re-exported so services need not import from two places. */
export { Prisma };

/**
 * True when a write failed because a unique index rejected it.
 *
 * Catching this is how duplicate follows, duplicate list entries and duplicate
 * registrations become a 409 rather than a 500, without a read-then-write race
 * in front of every insert.
 */
export function isUniqueViolation(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** True when a nested write referenced a row that does not exist. */
export function isForeignKeyViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

/** True when `update`/`delete` matched nothing. */
export function isNotFoundError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}
