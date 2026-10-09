import { describe, expect, it } from 'vitest';
import { API, api, MISSING_ID } from './helpers.js';

describe('catalogue', () => {
  it('lists books with pagination meta and numeric prices', async () => {
    const res = await api().get(`${API}/books?limit=5`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 5, hasMore: true });
    expect(res.body.meta.total).toBeGreaterThan(5);
    for (const book of res.body.data) {
      expect(typeof book.price === 'number' || book.price === null).toBe(true);
    }
  });

  it('pages do not overlap', async () => {
    const one = await api().get(`${API}/books?limit=10&page=1`);
    const two = await api().get(`${API}/books?limit=10&page=2`);
    const ids = new Set(one.body.data.map((b: { id: string }) => b.id));
    for (const book of two.body.data) expect(ids.has(book.id)).toBe(false);
  });

  it('search finds books by title', async () => {
    const sample = (await api().get(`${API}/books?limit=1`)).body.data[0];
    const word = String(sample.title).split(/\s+/)[0];
    const res = await api().get(`${API}/books`).query({ q: word, limit: 20 });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('returns a book by id, and 404 for a missing or malformed id', async () => {
    const sample = (await api().get(`${API}/books?limit=1`)).body.data[0];
    const res = await api().get(`${API}/books/${sample.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(sample.id);

    expect((await api().get(`${API}/books/${MISSING_ID}`)).status).toBe(404);
    expect((await api().get(`${API}/books/not-a-uuid`)).status).toBe(404);
  });

  it('clamps limit instead of rejecting it', async () => {
    const res = await api().get(`${API}/books?limit=1000`);
    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBeLessThanOrEqual(100);
  });
});

describe('conventions', () => {
  it('health is outside the API prefix', async () => {
    const res = await api().get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('unknown routes return the 404 error envelope with a request id', async () => {
    const res = await api().get(`${API}/definitely-not-a-route`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('invalid JSON is a 400, not a 500', async () => {
    const res = await api()
      .post(`${API}/auth/login`)
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(res.status).toBe(400);
  });
});
