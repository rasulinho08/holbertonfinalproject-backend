import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { optionalAuth, optionalUserId, requireAuth, userId } from '../../middleware/auth.js';
import { buildMeta, noContent, ok, page } from '../../lib/envelope.js';
import { pagination } from '../../lib/pagination.js';
import { ApiError, conflict, notFound } from '../../lib/errors.js';
import { revokeAllUserTokens } from '../../lib/tokens.js';
import { usernameSchema } from '../auth/schemas.js';
import { isGenreSlug } from '../books/service.js';
import { notify } from '../notifications/service.js';
import * as service from './service.js';
import { activityFor, friendsFeed } from './activity.js';
import { deleteMediaOwnedBy, releaseMediaUrl } from '../media/service.js';

export const usersRouter: Router = Router();

/**
 * Links a profile can carry. `z.string().url()` alone accepts any scheme —
 * `javascript:` included, which the web build would happily put in an href —
 * and the old schema let a cover photo be any string at all, including a
 * multi-megabyte data: URI copied into every response that embeds the user.
 */
const httpUrl = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .url()
    .refine((value) => /^https?:\/\//i.test(value), 'Use an http(s) address');

const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  username: usernameSchema.optional(),
  bio: z.string().trim().max(300).nullable().optional(),
  avatarUrl: httpUrl(2000).nullable().optional(),
  coverPhotoUrl: httpUrl(2000).nullable().optional(),
  website: httpUrl(500).nullable().optional(),
});

const goalSchema = z.object({
  target: z.coerce.number().int().min(1, 'Target must be at least 1').max(999, 'Target is too high'),
});

const preferencesSchema = z.object({
  favoriteGenres: z.array(z.string()).max(20).optional(),
  favoriteAuthorIds: z.array(z.string().uuid()).max(50).optional(),
});

/* ------------------------------ own profile ------------------------------- */
/* Registered before /:username, or "me" is looked up as a username.          */

usersRouter.patch(
  '/me',
  requireAuth,
  validate(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const id = userId(req);

    if (req.body.username) {
      const taken = await prisma.user.count({
        where: { username: req.body.username, NOT: { id } },
      });
      if (taken > 0) throw new ApiError('USERNAME_TAKEN', 'That username is taken');
    }

    const before = await prisma.user.findUniqueOrThrow({
      where: { id },
      select: { avatarUrl: true, coverPhotoUrl: true },
    });

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(req.body.name !== undefined && { name: req.body.name }),
        ...(req.body.username !== undefined && { username: req.body.username }),
        ...(req.body.bio !== undefined && { bio: req.body.bio }),
        ...(req.body.avatarUrl !== undefined && { avatarUrl: req.body.avatarUrl }),
        ...(req.body.coverPhotoUrl !== undefined && { coverPhotoUrl: req.body.coverPhotoUrl }),
        ...(req.body.website !== undefined && { website: req.body.website }),
      },
    });

    // A replaced or removed photo that this API stored is deleted, so
    // abandoned images do not pile up in the database.
    if (req.body.avatarUrl !== undefined && req.body.avatarUrl !== before.avatarUrl) {
      await releaseMediaUrl(before.avatarUrl, id);
    }
    if (req.body.coverPhotoUrl !== undefined && req.body.coverPhotoUrl !== before.coverPhotoUrl) {
      await releaseMediaUrl(before.coverPhotoUrl, id);
    }

    ok(res, await service.serializeUser(user, id));
  }),
);

usersRouter.delete(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = userId(req);
    // Soft delete: reviews and quotes stay for moderation, and orders must
    // survive for accounting. The email and username are released so the
    // reader can register again, and are stamped to keep the unique indexes
    // satisfied without colliding with a real address. Everything that
    // identifies the person — name, photos, bio, links — is removed, and
    // their uploaded images stop being served.
    const stamp = Date.now().toString(36);
    await prisma.user.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        email: `deleted_${stamp}_${id}@deleted.kitabdostu.az`,
        username: `deleted_${stamp}`.slice(0, 20),
        name: 'Silinmiş istifadəçi',
        passwordHash: null,
        avatarUrl: null,
        coverPhotoUrl: null,
        bio: null,
        website: null,
        twoFactorEnabled: false,
        twoFactorSecret: null,
      },
    });
    await deleteMediaOwnedBy(id);
    await revokeAllUserTokens(id);
    noContent(res);
  }),
);

usersRouter.patch(
  '/me/goal',
  requireAuth,
  validate(goalSchema),
  asyncHandler(async (req, res) => {
    const id = userId(req);
    const year = new Date().getFullYear();

    const goal = await prisma.readingGoal.upsert({
      where: { userId_year: { userId: id, year } },
      create: { userId: id, year, target: req.body.target },
      update: { target: req.body.target },
    });

    const completed = await prisma.shelfEntry.count({
      where: {
        userId: id,
        status: 'read',
        finishedAt: { gte: new Date(`${year}-01-01T00:00:00.000Z`) },
      },
    });

    ok(res, { year: goal.year, target: goal.target, completed });
  }),
);

usersRouter.patch(
  '/me/preferences',
  requireAuth,
  validate(preferencesSchema),
  asyncHandler(async (req, res) => {
    const id = userId(req);

    if (req.body.favoriteAuthorIds) {
      // Replaced wholesale rather than merged: the onboarding quiz sends the
      // complete set, and merging would make deselecting impossible.
      await prisma.userFavoriteAuthor.deleteMany({ where: { userId: id } });
      await prisma.userFavoriteAuthor.createMany({
        data: req.body.favoriteAuthorIds.map((authorId: string) => ({ userId: id, authorId })),
        skipDuplicates: true,
      });
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(req.body.favoriteGenres && {
          favoriteGenres: req.body.favoriteGenres.filter(isGenreSlug),
        }),
        onboardingCompleted: true,
      },
    });

    ok(res, await service.serializeUser(user, id));
  }),
);

/* ------------------------------ other people ------------------------------ */

usersRouter.get(
  '/:username',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const user = await service.findUserByUsername(req.params.username!);
    ok(res, await service.serializeUser(user, optionalUserId(req)));
  }),
);

usersRouter.get(
  '/:username/stats',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const user = await service.findUserByUsername(req.params.username!);
    ok(res, await service.computeStats(user));
  }),
);

usersRouter.get(
  '/:username/followers',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const user = await service.findUserByUsername(req.params.username!);
    const viewer = optionalUserId(req);

    const [rows, total] = await Promise.all([
      prisma.follow.findMany({
        where: { followeeId: user.id },
        include: { follower: { select: service.userSummarySelect } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.follow.count({ where: { followeeId: user.id } }),
    ]);

    page(res, await withFollowState(rows.map((r) => r.follower), viewer), buildMeta(total, pageNumber, limit));
  }),
);

usersRouter.get(
  '/:username/following',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const user = await service.findUserByUsername(req.params.username!);
    const viewer = optionalUserId(req);

    const [rows, total] = await Promise.all([
      prisma.follow.findMany({
        where: { followerId: user.id },
        include: { followee: { select: service.userSummarySelect } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.follow.count({ where: { followerId: user.id } }),
    ]);

    page(res, await withFollowState(rows.map((r) => r.followee), viewer), buildMeta(total, pageNumber, limit));
  }),
);

/**
 * Adds `isFollowing` to a list of people, in one query.
 *
 * The followers screen renders a follow button on every row, so without this
 * it would be one query per row.
 */
async function withFollowState(
  people: { id: string; username: string; name: string; avatarUrl: string | null }[],
  viewerId: string | null,
) {
  if (!viewerId || people.length === 0) {
    return people.map((p) => ({ ...service.serializeUserSummary(p), isFollowing: false }));
  }
  const follows = await prisma.follow.findMany({
    where: { followerId: viewerId, followeeId: { in: people.map((p) => p.id) } },
    select: { followeeId: true },
  });
  const following = new Set(follows.map((f) => f.followeeId));
  return people.map((p) => ({
    ...service.serializeUserSummary(p),
    isFollowing: following.has(p.id),
  }));
}

usersRouter.post(
  '/:userId/follow',
  requireAuth,
  asyncHandler(async (req, res) => {
    const followerId = userId(req);
    const followeeId = req.params.userId!;

    if (followerId === followeeId) throw conflict('You cannot follow yourself');

    const target = await prisma.user.findFirst({
      where: { id: followeeId, deletedAt: null },
      select: { id: true },
    });
    if (!target) throw notFound('User');

    const existing = await prisma.follow.count({ where: { followerId, followeeId } });

    // Idempotent: the client fires this optimistically and retries on a dropped
    // connection, so a second call must not 409.
    if (existing === 0) {
      await prisma.follow.create({ data: { followerId, followeeId } });
      const me = await prisma.user.findUnique({
        where: { id: followerId },
        select: { name: true, username: true },
      });
      await notify(
        followeeId,
        'follow',
        { name: me?.name ?? '' },
        `/user/${me?.username ?? ''}`,
        followerId,
      );
    }

    ok(res, {
      following: true,
      followersCount: await prisma.follow.count({ where: { followeeId } }),
    });
  }),
);

usersRouter.delete(
  '/:userId/follow',
  requireAuth,
  asyncHandler(async (req, res) => {
    const followerId = userId(req);
    const followeeId = req.params.userId!;
    await prisma.follow.deleteMany({ where: { followerId, followeeId } });
    ok(res, {
      following: false,
      followersCount: await prisma.follow.count({ where: { followeeId } }),
    });
  }),
);

usersRouter.get(
  '/:username/activity',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const user = await service.findUserByUsername(req.params.username!);
    const result = await activityFor([user.id], skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);

/* ---------------------------------- feed ---------------------------------- */

export const feedRouter: Router = Router();

feedRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { page: pageNumber, limit, skip, take } = pagination(req);
    const result = await friendsFeed(userId(req), skip, take);
    page(res, result.items, buildMeta(result.total, pageNumber, limit));
  }),
);
