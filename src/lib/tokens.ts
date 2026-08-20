import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from './prisma.js';
import { unauthorized } from './errors.js';
import type { UserRole } from '@prisma/client';

/**
 * Access and refresh tokens.
 *
 * Access tokens are short-lived JWTs carrying just enough to authorise a
 * request without a database round trip. Refresh tokens are long-lived, stored
 * **hashed**, and rotated on every use.
 *
 * Rotation uses a family id: each refresh issues a new token in the same
 * family and revokes the old one. If a token that has already been rotated is
 * presented again, that means a copy leaked, so the entire family is revoked
 * and the thief and the victim are both signed out. Detecting theft is the
 * whole reason the rows are stored at all — a stateless refresh token cannot
 * be revoked.
 */

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  /** Present for publisher accounts; lets ownership checks skip a lookup. */
  pid?: string;
}

const REFRESH_BYTES = 48;

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    issuer: 'kitabdostu',
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: 'kitabdostu',
    }) as AccessTokenPayload;
  } catch {
    // Expired and malformed are deliberately the same response: the client
    // reacts identically (refresh once, then sign out), and distinguishing
    // them tells an attacker whether a forged token had a valid signature.
    throw unauthorized('Access token is invalid or has expired');
  }
}

/** Refresh tokens are opaque random strings, not JWTs — there is nothing to read. */
function generateRefreshToken(): string {
  return crypto.randomBytes(REFRESH_BYTES).toString('base64url');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshExpiry(): Date {
  const ttl = env.JWT_REFRESH_TTL;
  const match = /^(\d+)([smhd])$/.exec(ttl);
  const multipliers = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
  const ms =
    match && match[1] && match[2]
      ? Number(match[1]) * multipliers[match[2] as keyof typeof multipliers]
      : 30 * 86_400_000;
  return new Date(Date.now() + ms);
}

export interface SessionContext {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

/** Issues a refresh token, starting a new rotation family. */
export async function issueRefreshToken(
  userId: string,
  context: SessionContext = {},
): Promise<string> {
  const token = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      familyId: crypto.randomUUID(),
      expiresAt: refreshExpiry(),
      userAgent: context.userAgent?.slice(0, 255) ?? null,
      ip: context.ip ?? null,
    },
  });
  return token;
}

export interface RotationResult {
  userId: string;
  refreshToken: string;
}

/**
 * Consumes a refresh token and issues its successor.
 *
 * Throws `UNAUTHORIZED` for anything suspicious. The caller must not
 * distinguish "unknown token" from "reused token" in its response, or the
 * endpoint becomes an oracle for probing valid tokens.
 */
export async function rotateRefreshToken(
  token: string,
  context: SessionContext = {},
): Promise<RotationResult> {
  const tokenHash = hashToken(token);
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!existing) throw unauthorized('Refresh token is invalid');

  if (existing.revokedAt) {
    // Already rotated once. A second presentation means a copy is in play, so
    // burn the whole lineage rather than just this row.
    await prisma.refreshToken.updateMany({
      where: { familyId: existing.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw unauthorized('Refresh token has been revoked');
  }

  if (existing.expiresAt < new Date()) throw unauthorized('Refresh token has expired');

  const next = generateRefreshToken();

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    }),
    prisma.refreshToken.create({
      data: {
        userId: existing.userId,
        tokenHash: hashToken(next),
        familyId: existing.familyId,
        expiresAt: refreshExpiry(),
        userAgent: context.userAgent?.slice(0, 255) ?? null,
        ip: context.ip ?? null,
      },
    }),
  ]);

  return { userId: existing.userId, refreshToken: next };
}

/** Signs out one session. Unknown tokens are a no-op, not an error. */
export async function revokeRefreshToken(token: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Signs out every session — used after a password change. */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/* ---------------------------- password resets ----------------------------- */

export function generateResetToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export const hashResetToken = hashToken;
