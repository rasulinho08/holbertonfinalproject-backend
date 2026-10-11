import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

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

  const raw = await res.json().catch(() => ({} as Prisma.InputJsonValue));

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
    // In stub/dev mode, never auto-approve — always pending until a real provider
    // validates the payment. This prevents marking unverified payments as paid.
    return { status: 'pending' };
  }

  // Check if this reference has already been recorded as paid (idempotency)
  const existingPayment = await prisma.payment.findFirst({
    where: { reference },
    include: { order: true },
  });

  if (existingPayment) {
    if (existingPayment.status === 'paid') {
      // Already successfully paid — return idempotently; do not re-advance order.
      return { status: 'paid' };
    }
    if (existingPayment.status === 'failed') {
      return { status: 'failed' };
    }
  }

  const res = await fetch(`${env.PAYRIFF_BASE_URL}/getStatusOrder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: env.PAYRIFF_SECRET_KEY },
    body: JSON.stringify({ merchant: env.PAYRIFF_MERCHANT_ID, body: { orderId: reference } }),
  });

  if (!res.ok) return { status: 'failed' };
  const raw = (await res.json()) as { payload?: { orderStatus?: string } };
  const status = raw.payload?.orderStatus === 'APPROVED' ? 'paid' : 'pending';

  // Record the verification result for idempotency and audit
  await prisma.payment.upsert({
    where: { reference },
    create: {
      reference,
      status,
      amount: 0, // amount unknown from verification alone; order total is separate
      rawResponse: raw,
    },
    update: {
      status,
      rawResponse: raw,
    },
  });

  return { status };
}