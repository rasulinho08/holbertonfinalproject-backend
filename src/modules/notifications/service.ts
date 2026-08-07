import type { NotificationType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { userSummarySelect, serializeUserSummary } from '../users/service.js';
import { sendPush } from '../../integrations/push.js';

/**
 * Notifications.
 *
 * The row stores a type and interpolation `params`, never rendered text. The
 * app owns the wording in both Azerbaijani and English, so a server that
 * stored "Leyla səni izləməyə başladı" would freeze that reader's notification
 * in one language forever — including for a reader who later switches to
 * English.
 */

export interface SerializedNotification {
  id: string;
  type: string;
  params: Record<string, string | number>;
  actor: { id: string; username: string; name: string; avatarUrl: string | null } | null;
  read: boolean;
  link: string | null;
  createdAt: string;
}

/**
 * Creates a notification and pushes it.
 *
 * Never throws: a notification failing must not fail the action that caused it.
 * Finishing a book should not 500 because the push service is down.
 */
export async function notify(
  userId: string,
  type: NotificationType,
  params: Record<string, string>,
  link: string | null = null,
  actorId: string | null = null,
): Promise<void> {
  try {
    // Self-notifications are noise: you know you liked your own quote.
    if (actorId && actorId === userId) return;

    await prisma.notification.create({
      data: { userId, type, params, link, actorId },
    });

    void sendPush(userId, type, params).catch((err) =>
      logger.warn({ err, userId, type }, 'push delivery failed'),
    );
  } catch (err) {
    logger.warn({ err, userId, type }, 'notification not created');
  }
}

export async function listNotifications(
  userId: string,
  skip: number,
  take: number,
): Promise<{ items: SerializedNotification[]; total: number; unread: number }> {
  const [rows, total, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.notification.count({ where: { userId } }),
    prisma.notification.count({ where: { userId, read: false } }),
  ]);

  // Actors are loaded in one query rather than per row.
  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((id): id is string => !!id))];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: userSummarySelect })
    : [];
  const byId = new Map(actors.map((a) => [a.id, a]));

  return {
    items: rows.map((row) => ({
      id: row.id,
      type: row.type,
      params: (row.params ?? {}) as Record<string, string | number>,
      actor: row.actorId ? (byId.get(row.actorId) ? serializeUserSummary(byId.get(row.actorId)!) : null) : null,
      read: row.read,
      link: row.link,
      createdAt: row.createdAt.toISOString(),
    })),
    total,
    unread,
  };
}

export async function markRead(userId: string, id: string): Promise<void> {
  // Scoped to the caller: marking someone else's notification read must be a
  // no-op, not an authorisation check that leaks whether the id exists.
  await prisma.notification.updateMany({ where: { id, userId }, data: { read: true } });
}

export async function markAllRead(userId: string): Promise<{ updated: number }> {
  const result = await prisma.notification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
  return { updated: result.count };
}

export async function registerDeviceToken(
  userId: string,
  token: string,
  platform: string,
): Promise<void> {
  // A device that signs in as a second reader must stop receiving the first
  // reader's notifications, so the token is re-pointed rather than duplicated.
  await prisma.deviceToken.upsert({
    where: { token },
    create: { userId, token, platform },
    update: { userId, platform },
  });
}
