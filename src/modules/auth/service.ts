import argon2 from 'argon2';
import { authenticator } from 'otplib';
import type { Prisma, ShelfStatus, User } from '@prisma/client';
import { prisma, isUniqueViolation } from '../../lib/prisma.js';
import { ApiError, badRequest, notFound, unauthorized } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import {
  generateResetToken,
  hashResetToken,
  issueRefreshToken,
  revokeAllUserTokens,
  rotateRefreshToken,
  signAccessToken,
  type SessionContext,
} from '../../lib/tokens.js';
import { serializeUser, type SerializedUser } from '../users/service.js';
import { sendPasswordResetEmail } from '../../integrations/mail.js';
import { verifyOAuthToken, type OAuthProvider } from '../../integrations/oauth.js';

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  user: SerializedUser;
}

const DEFAULT_SHELVES: ShelfStatus[] = ['reading', 'read', 'want_to_read', 'dnf'];

/**
 * Argon2id parameters.
 *
 * The defaults are tuned for a server, not a phone, and deliberately cost
 * ~100ms per hash — that cost is the point: it is what makes an offline attack
 * on a leaked table impractical.
 */
const ARGON_OPTIONS = { type: argon2.argon2id } as const;

async function buildSession(user: User, context: SessionContext): Promise<AuthSession> {
  const [accessToken, refreshToken, serialized] = await Promise.all([
    Promise.resolve(
      signAccessToken({
        sub: user.id,
        role: user.role,
        ...(user.publisherId && { pid: user.publisherId }),
      }),
    ),
    issueRefreshToken(user.id, context),
    serializeUser(user, user.id),
  ]);

  return { accessToken, refreshToken, user: serialized };
}

/**
 * Creates a user together with everything the app assumes exists.
 *
 * The four default shelves and the current year's goal are created in the same
 * transaction: a user without shelves reaches the shelves tab and sees four
 * missing rows, which looks like the app is broken rather than like a race.
 */
async function createUserWithDefaults(
  data: Prisma.UserCreateInput,
): Promise<User> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data });

    await tx.shelf.createMany({
      data: DEFAULT_SHELVES.map((status, position) => ({
        userId: user.id,
        status,
        name: status,
        isDefault: true,
        position,
      })),
    });

    await tx.readingGoal.create({
      data: { userId: user.id, year: new Date().getFullYear(), target: 24 },
    });

    return user;
  });
}

/* -------------------------------- register -------------------------------- */

export async function register(
  input: { name: string; username: string; email: string; password: string },
  context: SessionContext,
): Promise<AuthSession> {
  // Checked up front so the error names the specific field, then caught again
  // below — between the check and the insert another request can win the race,
  // and a 500 from a unique index is a worse experience than a 409.
  const [emailTaken, usernameTaken] = await Promise.all([
    prisma.user.count({ where: { email: input.email } }),
    prisma.user.count({ where: { username: input.username } }),
  ]);
  if (emailTaken > 0) throw new ApiError('EMAIL_TAKEN', 'That email is already registered');
  if (usernameTaken > 0) throw new ApiError('USERNAME_TAKEN', 'That username is taken');

  const passwordHash = await argon2.hash(input.password, ARGON_OPTIONS);

  try {
    const user = await createUserWithDefaults({
      name: input.name,
      username: input.username,
      email: input.email,
      passwordHash,
    });
    return await buildSession(user, context);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const target = (error.meta?.target as string[] | undefined)?.join(',') ?? '';
      throw target.includes('email')
        ? new ApiError('EMAIL_TAKEN', 'That email is already registered')
        : new ApiError('USERNAME_TAKEN', 'That username is taken');
    }
    throw error;
  }
}

/* ---------------------------------- login --------------------------------- */

export async function login(
  input: { email: string; password: string; twoFactorCode?: string | undefined },
  context: SessionContext,
): Promise<AuthSession> {
  const user = await prisma.user.findFirst({ where: { email: input.email, deletedAt: null } });

  // The same error whether the account is unknown, OAuth-only, or the password
  // is wrong. Distinguishing them turns the endpoint into an account-existence
  // oracle, which is how credential-stuffing lists get validated.
  const invalid = () => new ApiError('INVALID_CREDENTIALS', 'Email or password is incorrect');

  if (!user || !user.passwordHash) {
    // Still burn comparable time, so response timing does not reveal whether
    // the address exists.
    await argon2.hash(input.password, ARGON_OPTIONS).catch(() => undefined);
    throw invalid();
  }

  const valid = await argon2.verify(user.passwordHash, input.password).catch(() => false);
  if (!valid) throw invalid();

  if (user.twoFactorEnabled) {
    if (!input.twoFactorCode) {
      throw new ApiError('TWO_FACTOR_REQUIRED', 'Enter the code from your authenticator app');
    }
    const ok =
      user.twoFactorSecret &&
      authenticator.verify({ token: input.twoFactorCode, secret: user.twoFactorSecret });
    if (!ok) {
      throw new ApiError('TWO_FACTOR_REQUIRED', 'That code is not valid');
    }
  }

  return buildSession(user, context);
}

/* ---------------------------------- oauth --------------------------------- */

/**
 * Signs in with a provider token, creating the account on first use.
 *
 * Matching on email as well as on provider uid is deliberate: a reader who
 * registered with a password and later taps "Continue with Google" expects to
 * land in their existing account, not a second one holding none of their books.
 */
export async function oauthLogin(
  provider: OAuthProvider,
  input: { idToken: string; name?: string | undefined },
  context: SessionContext,
): Promise<AuthSession> {
  const profile = await verifyOAuthToken(provider, input.idToken);

  const existingLink = await prisma.oAuthAccount.findUnique({
    where: { provider_providerUid: { provider, providerUid: profile.uid } },
    include: { user: true },
  });
  if (existingLink && !existingLink.user.deletedAt) {
    return buildSession(existingLink.user, context);
  }

  if (profile.email) {
    const byEmail = await prisma.user.findFirst({
      where: { email: profile.email, deletedAt: null },
    });
    if (byEmail) {
      await prisma.oAuthAccount.create({
        data: { userId: byEmail.id, provider, providerUid: profile.uid },
      });
      return buildSession(byEmail, context);
    }
  }

  const name = profile.name ?? input.name ?? 'Oxucu';
  const email = profile.email ?? `${provider}_${profile.uid}@oauth.kitabdostu.az`;

  const user = await createUserWithDefaults({
    name,
    username: await uniqueUsername(profile.email?.split('@')[0] ?? provider),
    email,
    avatarUrl: profile.avatarUrl ?? null,
    // No password hash: this account can only be reached through the provider
    // until the reader sets one.
    oauthAccounts: { create: { provider, providerUid: profile.uid } },
  });

  return buildSession(user, context);
}

/** Finds a free username near the requested one. */
async function uniqueUsername(base: string): Promise<string> {
  const cleaned = base.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16) || 'oxucu';
  const candidate = cleaned.length >= 3 ? cleaned : `${cleaned}_kd`;

  if ((await prisma.user.count({ where: { username: candidate } })) === 0) return candidate;

  for (let i = 2; i < 500; i++) {
    const next = `${candidate.slice(0, 16)}${i}`;
    if ((await prisma.user.count({ where: { username: next } })) === 0) return next;
  }
  return `oxucu_${Date.now().toString(36)}`.slice(0, 20);
}

/* --------------------------------- refresh -------------------------------- */

export async function refresh(
  refreshToken: string,
  context: SessionContext,
): Promise<{ accessToken: string; refreshToken: string }> {
  const rotated = await rotateRefreshToken(refreshToken, context);
  const user = await prisma.user.findFirst({
    where: { id: rotated.userId, deletedAt: null },
  });
  if (!user) throw unauthorized('Account no longer exists');

  return {
    accessToken: signAccessToken({
      sub: user.id,
      role: user.role,
      ...(user.publisherId && { pid: user.publisherId }),
    }),
    refreshToken: rotated.refreshToken,
  };
}

/* ----------------------------- password resets ---------------------------- */

const RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Always resolves, whether or not the address exists.
 *
 * Returning 404 for an unknown address would make this endpoint an account
 * enumerator, which is exactly the kind of list that gets sold.
 */
export async function forgotPassword(email: string): Promise<void> {
  const user = await prisma.user.findFirst({ where: { email, deletedAt: null } });
  if (!user) return;

  const { token, hash } = generateResetToken();

  await prisma.$transaction([
    // One live token at a time: an old link in an old email should stop working
    // the moment a new one is requested.
    prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    }),
  ]);

  await sendPasswordResetEmail(user.email, token);
}

export async function resetPassword(token: string, password: string): Promise<void> {
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(token) },
  });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw badRequest('This reset link is invalid or has expired', { token: 'invalid' });
  }

  const passwordHash = await argon2.hash(password, ARGON_OPTIONS);

  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
  ]);

  // Whoever prompted the reset may be the attacker; every existing session goes.
  await revokeAllUserTokens(record.userId);
  logger.info({ userId: record.userId }, 'Password reset; all sessions revoked');
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('User');

  if (!user.passwordHash) {
    throw badRequest('This account signs in with a provider and has no password');
  }

  const valid = await argon2.verify(user.passwordHash, currentPassword).catch(() => false);
  if (!valid) {
    throw badRequest('Current password is incorrect', { currentPassword: 'incorrect' });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await argon2.hash(newPassword, ARGON_OPTIONS) },
  });

  await revokeAllUserTokens(userId);
}

/* ----------------------------------- 2FA ---------------------------------- */

export interface TwoFactorSetup {
  secret: string;
  /** `otpauth://` URI — the client renders it as a QR code. */
  otpauthUrl: string;
}

/**
 * Starts enrolment.
 *
 * The secret is stored immediately but `twoFactorEnabled` stays false until a
 * code is verified. Flipping the flag here would lock a reader out of their own
 * account if they never finished scanning the QR.
 */
export async function beginTwoFactor(userId: string): Promise<TwoFactorSetup> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('User');

  const secret = authenticator.generateSecret();
  await prisma.user.update({ where: { id: userId }, data: { twoFactorSecret: secret } });

  return {
    secret,
    otpauthUrl: authenticator.keyuri(user.email, 'KitabDostu', secret),
  };
}

export async function confirmTwoFactor(userId: string, code: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.twoFactorSecret) {
    throw badRequest('Start two-factor setup first');
  }
  if (!authenticator.verify({ token: code, secret: user.twoFactorSecret })) {
    throw badRequest('That code is not valid', { code: 'invalid' });
  }
  await prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
}

export async function disableTwoFactor(userId: string, password: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('User');

  // Turning 2FA off is a downgrade in account security, so it re-authenticates
  // rather than trusting the access token — a stolen phone should not be able
  // to remove the second factor.
  if (user.passwordHash) {
    const valid = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!valid) throw badRequest('Password is incorrect', { password: 'incorrect' });
  }

  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorEnabled: false, twoFactorSecret: null },
  });
}

/* ----------------------------------- me ----------------------------------- */

export async function currentUser(userId: string): Promise<SerializedUser> {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
  if (!user) throw unauthorized('Account no longer exists');
  return serializeUser(user, userId);
}

export { env };
