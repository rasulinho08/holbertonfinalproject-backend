import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { API, api, bearer, registerReader } from './helpers.js';

async function giftCard(amount: number): Promise<string> {
  const code = `T${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  await prisma.giftCard.create({ data: { code, amount } });
  return code;
}

async function inStockBook(): Promise<{ id: string; price: number }> {
  const book = await prisma.book.findFirst({
    where: { stock: { gte: 5 }, price: { gt: 0 }, deletedAt: null },
    select: { id: true, price: true },
  });
  if (!book) throw new Error('seed has no purchasable book');
  return { id: book.id, price: Number(book.price) };
}

const address = { fullName: 'Test Alıcı', phone: '+994501112233', city: 'Bakı', line: 'Nizami 1' };

describe('commerce', () => {
  it('charges the wallet the discounted order total, not the cart total', async () => {
    const session = await registerReader();
    const auth = bearer(session);
    await api().post(`${API}/gift-cards/redeem`).set(...auth).send({ code: await giftCard(200) }).expect(200);

    const book = await inStockBook();
    await api().post(`${API}/cart/items`).set(...auth).send({ bookId: book.id, quantity: 1 }).expect(200);

    const discountCode = await giftCard(5);
    const checkout = await api()
      .post(`${API}/orders`)
      .set(...auth)
      .send({ paymentMethod: 'wallet', deliveryMethod: 'courier', giftCardCode: discountCode, address });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    const orders = checkout.body.data as { total: number; discount: number }[];
    const paid = orders.reduce((sum, o) => sum + o.total, 0);
    expect(orders[0]!.discount).toBe(5);

    const wallet = await api().get(`${API}/wallet`).set(...auth);
    expect(wallet.body.data.balance).toBeCloseTo(200 - paid, 2);
  });

  it('a gift card cannot be redeemed twice, even concurrently', async () => {
    const a = await registerReader();
    const b = await registerReader();
    const code = await giftCard(30);

    const results = await Promise.all([
      api().post(`${API}/gift-cards/redeem`).set(...bearer(a)).send({ code }),
      api().post(`${API}/gift-cards/redeem`).set(...bearer(b)).send({ code }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);

    const balances = await Promise.all(
      [a, b].map(async (s) => (await api().get(`${API}/wallet`).set(...bearer(s))).body.data.balance),
    );
    expect(balances.sort()).toEqual([0, 30]);
  });

  it('refuses a wallet checkout the balance cannot cover', async () => {
    const session = await registerReader();
    const book = await inStockBook();
    await api().post(`${API}/cart/items`).set(...bearer(session)).send({ bookId: book.id, quantity: 1 }).expect(200);
    const res = await api()
      .post(`${API}/orders`)
      .set(...bearer(session))
      .send({ paymentMethod: 'wallet', deliveryMethod: 'courier', address });
    expect(res.status).toBe(402);
  });

  it('two simultaneous wallet checkouts cannot spend the same balance', async () => {
    const session = await registerReader();
    const auth = bearer(session);
    const book = await inStockBook();
    // Enough for one copy, not two.
    await api().post(`${API}/gift-cards/redeem`).set(...auth).send({ code: await giftCard(book.price + 10) }).expect(200);
    await api().post(`${API}/cart/items`).set(...auth).send({ bookId: book.id, quantity: 1 }).expect(200);

    const order = () =>
      api().post(`${API}/orders`).set(...auth).send({ paymentMethod: 'wallet', deliveryMethod: 'courier', address });
    const results = await Promise.all([order(), order()]);
    const created = results.filter((r) => r.status === 201);
    expect(created.length, JSON.stringify(results.map((r) => [r.status, r.body.error?.code]))).toBe(1);

    const wallet = await api().get(`${API}/wallet`).set(...auth);
    expect(wallet.body.data.balance).toBeGreaterThanOrEqual(0);
  });

  it('two readers racing for the last copy: one order, stock never negative', async () => {
    const book = await inStockBook();
    await prisma.book.update({ where: { id: book.id }, data: { stock: 1 } });
    const [a, b] = await Promise.all([registerReader(), registerReader()]);
    for (const s of [a, b]) {
      await api().post(`${API}/cart/items`).set(...bearer(s)).send({ bookId: book.id, quantity: 1 }).expect(200);
    }

    const results = await Promise.all(
      [a, b].map((s) =>
        api().post(`${API}/orders`).set(...bearer(s)).send({ paymentMethod: 'cod', deliveryMethod: 'courier', address }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);

    const after = await prisma.book.findUniqueOrThrow({ where: { id: book.id }, select: { stock: true } });
    expect(after.stock).toBe(0);
  });
});
