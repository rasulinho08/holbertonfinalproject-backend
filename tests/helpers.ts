import crypto from 'node:crypto';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app.js';
import { TEST_SEED_PASSWORD } from './test-env.js';

export const app = createApp();

export const API = '/api/v1';

/** Seeded accounts — see prisma/seed.ts. */
export const READER_EMAIL = 'leyla@kitabdostu.az';
export const PUBLISHER_EMAIL = 'publisher@kitabdostu.az';
export const ADMIN_EMAIL = 'admin@kitabdostu.az';
export const SEED_PASSWORD = TEST_SEED_PASSWORD;

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; email: string; role: string } & Record<string, unknown>;
}

export const api = () => request(app);

export function bearer(session: Session): [string, string] {
  return ['Authorization', `Bearer ${session.accessToken}`];
}

export async function login(email: string, password = SEED_PASSWORD): Promise<Session> {
  const res = await api().post(`${API}/auth/login`).send({ email, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as Session;
}

/** Registers a brand-new reader with unique credentials. */
export async function registerReader(overrides: Record<string, unknown> = {}): Promise<Session> {
  const suffix = crypto.randomBytes(4).toString('hex');
  const res = await api()
    .post(`${API}/auth/register`)
    .send({
      name: `Test Reader ${suffix}`,
      username: `t_${suffix}`,
      email: `reader.${suffix}@example.com`,
      password: 'correct-horse-battery',
      ...overrides,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as Session;
}

/** Any id that is a well-formed uuid but matches nothing. */
export const MISSING_ID = '00000000-0000-4000-8000-000000000000';
