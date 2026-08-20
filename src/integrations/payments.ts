import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Card payments, via Payriff (MilliKart).
 *
 * Without merchant credentials this runs as a stub that approves every charge
 * and says so in the log. That is a development convenience and is refused in
 * production — silently approving real orders would be considerably worse than
 * failing to start.
 *
 * The real integration is one function: swap the body of `chargeCard`. Callers
 * see the same result shape either way.
 */

export interface ChargeResult {
  reference: string;
  paid: boolean;
  raw: unknown;
}

export async function chargeCard(orderCode: string, amount: number): Promise<ChargeResult> {
  if (!env.PAYRIFF_MERCHANT_ID || !env.PAYRIFF_SECRET_KEY) {
    if (env.isProduction) {
      throw new Error('Card payments are not configured (PAYRIFF_MERCHANT_ID / PAYRIFF_SECRET_KEY)');
    }
    const reference = `stub_${crypto.randomUUID()}`;
    logger.warn(
      { orderCode, amount, reference },
      '[payments:stub] charge approved without contacting a provider',
    );
    return { reference, paid: true, raw: { stub: true, orderCode, amount } };
  }

  const res = await fetch(`${env.PAYRIFF_BASE_URL}/createOrder`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: env.PAYRIFF_SECRET_KEY,
    },
    body: JSON.stringify({
      merchant: env.PAYRIFF_MERCHANT_ID,
      body: {
        amount,
        // Payriff wants minor units for some endpoints and major for others;
        // createOrder takes major units with two decimals.
        currencyType: 'AZN',
        description: `KitabDostu ${orderCode}`,
        language: 'AZ',
        // The mobile app polls /payments/:reference/verify rather than relying
        // on a redirect, because a native app has no browser to return to.
        directPay: true,
      },
    }),
  });

  const raw = await res.json().catch(() => ({}));

  if (!res.ok) {
    logger.warn({ status: res.status, orderCode }, 'Payriff rejected the charge');
    return { reference: `failed_${orderCode}`, paid: false, raw };
  }

  const payload = raw as { payload?: { orderId?: string; paymentStatus?: string } };
  return {
    reference: payload.payload?.orderId ?? `payriff_${orderCode}`,
    paid: payload.payload?.paymentStatus === 'APPROVED',
    raw,
  };
}

export async function verifyPayment(reference: string): Promise<{ status: string }> {
  if (!env.PAYRIFF_MERCHANT_ID || !env.PAYRIFF_SECRET_KEY) {
    return { status: reference.startsWith('failed_') ? 'failed' : 'paid' };
  }

  const res = await fetch(`${env.PAYRIFF_BASE_URL}/getStatusOrder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: env.PAYRIFF_SECRET_KEY },
    body: JSON.stringify({ merchant: env.PAYRIFF_MERCHANT_ID, body: { orderId: reference } }),
  });

  if (!res.ok) return { status: 'failed' };
  const raw = (await res.json()) as { payload?: { orderStatus?: string } };
  return { status: raw.payload?.orderStatus === 'APPROVED' ? 'paid' : 'pending' };
}
