import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

/**
 * Push notifications, via Expo's push service.
 *
 * Without `EXPO_PUSH_ACCESS_TOKEN` this logs instead of sending. Expo's API in
 * fact accepts unauthenticated requests, but sending real pushes from a
 * developer machine to whatever device tokens happen to be in the database is
 * not a good default.
 *
 * The body text is deliberately minimal and in Azerbaijani: a push cannot carry
 * the app's localisation, so it says the least it can while still being useful,
 * and the app renders the full string once opened.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const TITLES: Record<string, string> = {
  follow: 'Yeni izləyici',
  new_book: 'Yeni kitab',
  order_shipped: 'Sifarişin yoldadır',
  review_comment: 'Rəyinə şərh',
  quote_like: 'Sitatın bəyənildi',
  buddy_invite: 'Birgə oxu dəvəti',
  goal_reached: 'Hədəfinə çatdın',
  badge_earned: 'Yeni nişan',
};

export async function sendPush(
  userId: string,
  type: string,
  params: Record<string, string>,
): Promise<void> {
  const tokens = await prisma.deviceToken.findMany({
    where: { userId },
    select: { token: true },
  });
  if (tokens.length === 0) return;

  const title = TITLES[type] ?? 'KitabDostu';
  const body = params.name ? `${params.name}` : 'Tətbiqi aç';

  if (!env.EXPO_PUSH_ACCESS_TOKEN) {
    logger.info({ userId, type, devices: tokens.length }, `[push:stub] ${title} — ${body}`);
    return;
  }

  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.EXPO_PUSH_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(
      tokens.map((t) => ({ to: t.token, title, body, data: { type, ...params } })),
    ),
  });

  if (!res.ok) {
    logger.warn({ status: res.status }, 'Expo push rejected the batch');
    return;
  }

  // Expo reports per-token failures in the body, not the status. A token for an
  // uninstalled app returns DeviceNotRegistered and must be dropped, or it is
  // retried on every notification forever.
  const payload = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
  const dead = (payload.data ?? [])
    .map((entry, i) => (entry.details?.error === 'DeviceNotRegistered' ? tokens[i]?.token : null))
    .filter((t): t is string => !!t);

  if (dead.length > 0) {
    await prisma.deviceToken.deleteMany({ where: { token: { in: dead } } });
    logger.info({ count: dead.length }, 'removed unregistered device tokens');
  }
}
