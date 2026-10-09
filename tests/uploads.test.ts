import { describe, expect, it } from 'vitest';
import { API, api, bearer, registerReader } from './helpers.js';

// A 1×1 transparent PNG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('uploads', () => {
  it('stores an image and serves the same bytes back with the sniffed type', async () => {
    const session = await registerReader();
    const res = await api()
      .post(`${API}/uploads`)
      .set(...bearer(session))
      .send({ kind: 'avatar', data: `data:image/jpeg;base64,${PNG}` });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { id, url } = res.body.data as { id: string; url: string };
    expect(url).toMatch(new RegExp(`/api/v1/uploads/files/${id}$`));

    const file = await api().get(`${API}/uploads/files/${id}`);
    expect(file.status).toBe(200);
    // The client claimed JPEG; the bytes are PNG, and the bytes win.
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['cache-control']).toContain('immutable');
    expect(Buffer.from(file.body).equals(Buffer.from(PNG, 'base64'))).toBe(true);
  });

  it('rejects non-images, garbage and anonymous uploads', async () => {
    const session = await registerReader();
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');

    const notImage = await api().post(`${API}/uploads`).set(...bearer(session)).send({ kind: 'avatar', data: html });
    expect(notImage.status).toBe(422);

    const garbage = await api().post(`${API}/uploads`).set(...bearer(session)).send({ kind: 'avatar', data: '%%%' });
    expect(garbage.status).toBe(422);

    expect((await api().post(`${API}/uploads`).send({ kind: 'avatar', data: PNG })).status).toBe(401);
  });

  it('unknown or malformed file ids are 404', async () => {
    expect((await api().get(`${API}/uploads/files/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await api().get(`${API}/uploads/files/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });

  it('a replaced avatar stops being served, and so does everything after account deletion', async () => {
    const session = await registerReader();
    const upload = async () =>
      (await api().post(`${API}/uploads`).set(...bearer(session)).send({ kind: 'avatar', data: PNG })).body
        .data as { id: string; url: string };

    const first = await upload();
    await api().patch(`${API}/users/me`).set(...bearer(session)).send({ avatarUrl: first.url }).expect(200);
    const second = await upload();
    await api().patch(`${API}/users/me`).set(...bearer(session)).send({ avatarUrl: second.url }).expect(200);

    expect((await api().get(`${API}/uploads/files/${first.id}`)).status).toBe(404);
    expect((await api().get(`${API}/uploads/files/${second.id}`)).status).toBe(200);

    await api().delete(`${API}/users/me`).set(...bearer(session)).expect(204);
    expect((await api().get(`${API}/uploads/files/${second.id}`)).status).toBe(404);
  });

  it('profile links must be http(s)', async () => {
    const session = await registerReader();
    for (const field of ['website', 'avatarUrl', 'coverPhotoUrl']) {
      const res = await api()
        .patch(`${API}/users/me`)
        .set(...bearer(session))
        .send({ [field]: 'javascript:alert(document.cookie)' });
      expect(res.status, field).toBe(422);
    }
  });
});
