import { describe, expect, it } from 'vitest';
import { API, api, bearer, login, READER_EMAIL, registerReader, SEED_PASSWORD } from './helpers.js';

describe('auth', () => {
  it('registers a reader and returns a session with the full user', async () => {
    const session = await registerReader();
    expect(session.accessToken).toEqual(expect.any(String));
    expect(session.refreshToken).toEqual(expect.any(String));
    expect(session.user).toMatchObject({ role: 'user', onboardingCompleted: false });
  });

  it('rejects a duplicate email with 409', async () => {
    const first = await registerReader();
    const res = await api()
      .post(`${API}/auth/register`)
      .send({
        name: 'Duplicate',
        username: `dup_${Date.now().toString(36)}`.slice(0, 20),
        email: first.user.email,
        password: 'correct-horse-battery',
      });
    expect(res.status).toBe(409);
  });

  it('never lets registration claim the admin role', async () => {
    const res = await api()
      .post(`${API}/auth/register`)
      .send({
        name: 'Sneaky',
        username: `sneaky_${Date.now().toString(36)}`.slice(0, 20),
        email: `sneaky.${Date.now()}@example.com`,
        password: 'correct-horse-battery',
        accountType: 'admin',
      });
    expect(res.status).toBe(422);

    // A `role` field is not part of the schema and must be ignored, not applied.
    const session = await registerReader({ role: 'admin' });
    expect(session.user.role).toBe('user');
  });

  it('rejects a wrong password with 401 and a valid one with a session', async () => {
    const bad = await api().post(`${API}/auth/login`).send({ email: READER_EMAIL, password: 'nope-nope' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toEqual(expect.any(String));

    const session = await login(READER_EMAIL, SEED_PASSWORD);
    expect(session.user.email).toBe(READER_EMAIL);
  });

  it('rotates refresh tokens and burns the family when an old one is replayed', async () => {
    const session = await login(READER_EMAIL);

    const first = await api().post(`${API}/auth/refresh`).send({ refreshToken: session.refreshToken });
    expect(first.status).toBe(200);
    const rotated = first.body.data.refreshToken as string;
    expect(rotated).not.toBe(session.refreshToken);

    // Replaying the consumed token is treated as theft…
    const replay = await api().post(`${API}/auth/refresh`).send({ refreshToken: session.refreshToken });
    expect(replay.status).toBe(401);

    // …which also revokes the successor issued from the same family.
    const successor = await api().post(`${API}/auth/refresh`).send({ refreshToken: rotated });
    expect(successor.status).toBe(401);
  });

  it('revokes the refresh token on logout, and logout is idempotent', async () => {
    const session = await login(READER_EMAIL);

    const out = await api().post(`${API}/auth/logout`).send({ refreshToken: session.refreshToken });
    expect(out.status).toBe(204);

    const again = await api().post(`${API}/auth/logout`).send({ refreshToken: session.refreshToken });
    expect(again.status).toBe(204);

    const refresh = await api().post(`${API}/auth/refresh`).send({ refreshToken: session.refreshToken });
    expect(refresh.status).toBe(401);
  });

  it('requires a valid access token on protected routes', async () => {
    expect((await api().get(`${API}/auth/me`)).status).toBe(401);
    expect((await api().get(`${API}/auth/me`).set('Authorization', 'Bearer not-a-jwt')).status).toBe(401);

    const session = await login(READER_EMAIL);
    const me = await api().get(`${API}/auth/me`).set(...bearer(session));
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(READER_EMAIL);
  });
});
