import { describe, expect, it } from 'vitest';
import { API, api, bearer, login, READER_EMAIL, registerReader } from './helpers.js';

/**
 * Regression cover for src/modules/users/service.ts.
 *
 * A botched merge once cut that file down to a single interface. The server
 * then failed to boot (an ESM import of a missing export), and nothing in the
 * repository noticed. These tests pin the serialized user shape the app
 * renders, so that can never happen silently again.
 */
describe('users', () => {
  it('GET /auth/me returns the full serialized user', async () => {
    const session = await login(READER_EMAIL);
    const res = await api().get(`${API}/auth/me`).set(...bearer(session));

    expect(res.status).toBe(200);
    const me = res.body.data;
    expect(me).toMatchObject({
      id: expect.any(String),
      username: expect.any(String),
      name: expect.any(String),
      email: READER_EMAIL,
      role: 'user',
      createdAt: expect.any(String),
      followersCount: expect.any(Number),
      followingCount: expect.any(Number),
      walletBalance: expect.any(Number),
      twoFactorEnabled: expect.any(Boolean),
      onboardingCompleted: expect.any(Boolean),
      favoriteGenres: expect.any(Array),
      favoriteAuthorIds: expect.any(Array),
      goal: { year: new Date().getFullYear(), target: expect.any(Number), completed: expect.any(Number) },
      stats: {
        booksRead: expect.any(Number),
        pagesRead: expect.any(Number),
        reviewsCount: expect.any(Number),
        quotesCount: expect.any(Number),
        streakDays: expect.any(Number),
        genreDistribution: expect.any(Array),
        weeklyPages: expect.any(Array),
      },
    });
    // Your own profile never carries a follow state.
    expect(me).not.toHaveProperty('isFollowing');
  });

  it("does not expose another reader's email or wallet", async () => {
    const viewer = await registerReader();
    const res = await api().get(`${API}/users/leyla`).set(...bearer(viewer));

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('');
    expect(res.body.data.walletBalance).toBe(0);
    expect(res.body.data.isFollowing).toBe(false);
  });

  it('PATCH /users/me persists profile edits', async () => {
    const session = await registerReader();
    const patch = await api()
      .patch(`${API}/users/me`)
      .set(...bearer(session))
      .send({ name: 'Edited Name', bio: 'Kitab sevirəm.', website: 'https://example.com' });
    expect(patch.status).toBe(200);

    const me = await api().get(`${API}/auth/me`).set(...bearer(session));
    expect(me.body.data).toMatchObject({
      name: 'Edited Name',
      bio: 'Kitab sevirəm.',
      website: 'https://example.com',
    });
  });

  it('PATCH /users/me ignores fields it does not own (role, wallet)', async () => {
    const session = await registerReader();
    const res = await api()
      .patch(`${API}/users/me`)
      .set(...bearer(session))
      .send({ role: 'admin', walletBalance: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('user');
    expect(res.body.data.walletBalance).toBe(0);
  });

  it('rejects a username that is already taken', async () => {
    const session = await registerReader();
    const res = await api().patch(`${API}/users/me`).set(...bearer(session)).send({ username: 'leyla' });
    expect(res.status).toBe(409);
  });

  it('completing onboarding persists preferences and the completed flag', async () => {
    const session = await registerReader();
    const res = await api()
      .patch(`${API}/users/me/preferences`)
      .set(...bearer(session))
      .send({ favoriteGenres: ['novel', 'poetry', 'not-a-genre'] });

    expect(res.status).toBe(200);
    expect(res.body.data.onboardingCompleted).toBe(true);
    expect(res.body.data.favoriteGenres).toEqual(['novel', 'poetry']);
  });

  it('soft-deletes the account, frees the username and kills every session', async () => {
    const session = await registerReader();
    const username = session.user.username;

    const del = await api().delete(`${API}/users/me`).set(...bearer(session));
    expect(del.status).toBe(204);

    expect((await api().get(`${API}/users/${username}`)).status).toBe(404);
    const refresh = await api().post(`${API}/auth/refresh`).send({ refreshToken: session.refreshToken });
    expect(refresh.status).toBe(401);
  });

  it('unknown users are 404, not 500', async () => {
    expect((await api().get(`${API}/users/nobody_here_404`)).status).toBe(404);
  });
});
