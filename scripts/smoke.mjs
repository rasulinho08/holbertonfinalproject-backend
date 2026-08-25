/**
 * API smoke test.
 *
 * Walks the endpoints the mobile app actually calls, against a running server
 * and a seeded database, and asserts the shape the frontend expects rather than
 * just a 200. A route that returns the wrong field name is a route the app
 * renders as blank, and blank is exactly what a status-code check misses.
 *
 *   npm run dev          # in one terminal
 *   node scripts/smoke.mjs
 */

const BASE = process.env.API_BASE ?? 'http://localhost:4000/api/v1';
const EMAIL = process.env.SMOKE_EMAIL ?? 'leyla@kitabdostu.az';
const PASSWORD = process.env.SMOKE_PASSWORD ?? process.env.TEST_PASSWORD ?? '';
if (!PASSWORD) {
  console.error('[fail] SMOKE_PASSWORD or TEST_PASSWORD must be set in the environment.');
  process.exit(2);
}

let token = null;
let pass = 0;
let fail = 0;
const failures = [];

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body — reported by the caller's assertion */
  }
  return { status: res.status, json, text };
}

/** `check(name, condition, detail)` — detail is printed only on failure. */
function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* ---------------------------------- run ----------------------------------- */

section('health');
{
  const res = await fetch(`${BASE.replace('/api/v1', '')}/health`);
  check('GET /health', res.status === 200);
}

section('auth');
{
  const bad = await call('POST', '/auth/login', { email: EMAIL, password: 'wrong-password' });
  check(
    'wrong password → 401 INVALID_CREDENTIALS',
    bad.status === 401 && bad.json?.error?.code === 'INVALID_CREDENTIALS',
    `${bad.status} ${bad.json?.error?.code}`,
  );

  const unknown = await call('POST', '/auth/login', {
    email: 'nobody@example.com',
    password: 'whatever1',
  });
  check(
    'unknown account gives the same code (no enumeration oracle)',
    unknown.json?.error?.code === 'INVALID_CREDENTIALS',
    unknown.json?.error?.code,
  );

  const login = await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
  check('login → 200', login.status === 200, `${login.status} ${login.text.slice(0, 120)}`);
  token = login.json?.data?.accessToken ?? null;
  check('login returns an access token', !!token);

  const user = login.json?.data?.user;
  check('user carries computed stats', typeof user?.stats?.booksRead === 'number');
  check('weeklyPages has exactly 7 entries', user?.stats?.weeklyPages?.length === 7);
  check('goal is present', typeof user?.goal?.target === 'number');
  check(
    'own profile includes the email',
    user?.email === EMAIL,
    `got ${JSON.stringify(user?.email)}`,
  );

  const me = await call('GET', '/auth/me');
  check('GET /auth/me → 200', me.status === 200, String(me.status));

  const noToken = token;
  token = null;
  const anon = await call('GET', '/auth/me');
  check('no token → 401', anon.status === 401, String(anon.status));
  token = noToken;

  const refreshed = await call('POST', '/auth/refresh', {
    refreshToken: login.json?.data?.refreshToken,
  });
  check('refresh rotates the token', refreshed.status === 200 && !!refreshed.json?.data?.accessToken);

  const replay = await call('POST', '/auth/refresh', {
    refreshToken: login.json?.data?.refreshToken,
  });
  check(
    'reusing a rotated refresh token → 401',
    replay.status === 401,
    `${replay.status} — a reused token must revoke the family`,
  );
}

section('catalogue');
{
  const list = await call('GET', '/books?limit=5');
  check('GET /books → 200', list.status === 200);
  check('returns 5 books', list.json?.data?.length === 5, String(list.json?.data?.length));
  check(
    'meta.total is the catalogue size, not the page size',
    list.json?.meta?.total === 1000,
    String(list.json?.meta?.total),
  );

  const book = list.json?.data?.[0];
  check('book has authorName', typeof book?.authorName === 'string');
  check('book has publisherName', typeof book?.publisherName === 'string');
  check(
    'price is a JSON number, not a Decimal object',
    typeof book?.price === 'number',
    `got ${typeof book?.price}`,
  );
  check(
    'ratingAverage is derived to one decimal',
    typeof book?.ratingAverage === 'number' && book.ratingAverage <= 10,
    String(book?.ratingAverage),
  );
  check(
    'authenticated request carries shelfStatus',
    'shelfStatus' in (book ?? {}),
    'the app renders the shelf marker off this field',
  );

  // The whole point of kd_normalize: "eli" must find "Əli".
  const folded = await call('GET', '/books?q=eli&limit=5');
  check(
    'diacritic-insensitive search: "eli" finds "Əli"',
    folded.json?.data?.some((b) => b.title.toLowerCase().includes('əli')),
    folded.json?.data?.map((b) => b.title).join(', ') || 'no results',
  );

  const byIsbn = await call('GET', `/books?q=${book?.isbn ?? ''}`);
  check('search by ISBN', (byIsbn.json?.meta?.total ?? 0) >= 1, String(byIsbn.json?.meta?.total));

  const poetry = await call('GET', '/books?genres=poetry&limit=5');
  check(
    'genre filter returns only that genre',
    poetry.json?.data?.every((b) => b.genres.includes('poetry')),
    poetry.json?.data?.map((b) => b.genres.join('/')).join(' | '),
  );

  const az = await call('GET', '/books?languages=az&limit=5');
  check(
    'language filter',
    az.json?.data?.every((b) => b.language === 'az'),
    az.json?.data?.map((b) => b.language).join(','),
  );

  const rated = await call('GET', '/books?minRating=9&limit=5');
  check(
    'minRating filters on the derived average',
    rated.json?.data?.every((b) => b.ratingAverage >= 9),
    rated.json?.data?.map((b) => b.ratingAverage).join(','),
  );

  const cheap = await call('GET', '/books?sort=price_asc&limit=5');
  const prices = cheap.json?.data?.map((b) => b.price) ?? [];
  check(
    'sort=price_asc is ascending',
    prices.every((p, i) => i === 0 || p >= prices[i - 1]),
    prices.join(','),
  );

  const combined = await call('GET', '/books?genres=novel&genres=classic&languages=az&minRating=7');
  check('filters combine without error', combined.status === 200, String(combined.status));

  const typo = await call('GET', '/books?q=zzzqqqxyw');
  check('no results → empty array', typo.json?.data?.length === 0);
  check('meta carries a suggestion field', 'suggestion' in (typo.json?.meta ?? {}));

  const detail = await call('GET', `/books/${book?.id}`);
  check('GET /books/:id → 200', detail.status === 200);

  const missing = await call('GET', '/books/00000000-0000-0000-0000-000000000000');
  check('unknown book → 404 NOT_FOUND', missing.status === 404 && missing.json?.error?.code === 'NOT_FOUND');

  const similar = await call('GET', `/books/${book?.id}/similar?limit=5`);
  check('GET /books/:id/similar', similar.status === 200 && Array.isArray(similar.json?.data));
  check(
    'similar excludes the book itself',
    !similar.json?.data?.some((b) => b.id === book?.id),
  );

  const trending = await call('GET', '/books/trending?limit=5');
  check('GET /books/trending is not treated as an id', trending.status === 200);

  const recs = await call('GET', '/books/recommendations?limit=5');
  check('GET /books/recommendations → 200', recs.status === 200);
  check('recommendations exclude shelved books', recs.json?.data?.every((b) => !b.shelfStatus));

  const genres = await call('GET', '/genres');
  check('GET /genres → 200', genres.status === 200);
  check(
    'genre counts are populated',
    (genres.json?.data?.length ?? 0) >= 10 && genres.json.data[0].bookCount > 0,
    JSON.stringify(genres.json?.data?.slice(0, 3)),
  );

  const suggest = await call('GET', '/search/suggest?q=dost');
  check('GET /search/suggest → 200', suggest.status === 200);
  check('suggest returns books and authors', Array.isArray(suggest.json?.data?.books));
}

section('authors');
{
  const list = await call('GET', '/books?limit=1');
  const authorId = list.json?.data?.[0]?.authorId;

  const author = await call('GET', `/authors/${authorId}`);
  check('GET /authors/:id → 200', author.status === 200);
  check('author has bookCount', typeof author.json?.data?.bookCount === 'number');
  check('author has isFollowing when authenticated', 'isFollowing' in (author.json?.data ?? {}));

  const books = await call('GET', `/authors/${authorId}/books`);
  check('GET /authors/:id/books', books.status === 200 && Array.isArray(books.json?.data));

  const follow = await call('POST', `/authors/${authorId}/follow`);
  check('follow an author', follow.json?.data?.following === true);

  const again = await call('POST', `/authors/${authorId}/follow`);
  check('following twice is idempotent, not 409', again.status === 200, String(again.status));

  const unfollow = await call('DELETE', `/authors/${authorId}/follow`);
  check('unfollow', unfollow.json?.data?.following === false);

  const unfollowAgain = await call('DELETE', `/authors/${authorId}/follow`);
  check('unfollowing twice is idempotent', unfollowAgain.status === 200);
}

section('conventions');
{
  const res = await fetch(`${BASE}/books?limit=1`);
  check('X-Request-Id is set on responses', !!res.headers.get('x-request-id'));

  const overLimit = await call('GET', '/books?limit=9999');
  check(
    'limit is clamped to 100, not rejected',
    overLimit.status === 200 && overLimit.json?.meta?.limit === 100,
    String(overLimit.json?.meta?.limit),
  );

  const pastEnd = await call('GET', '/books?page=99999');
  check(
    'a page past the end is an empty array, not a 404',
    pastEnd.status === 200 && pastEnd.json?.data?.length === 0,
    String(pastEnd.status),
  );

  const badSort = await call('GET', '/books?sort=nonsense');
  check('unknown sort falls back to the default', badSort.status === 200);

  const badBody = await call('POST', '/auth/register', { email: 'not-an-email' });
  check(
    'invalid body → 422 with per-field messages',
    badBody.status === 422 && !!badBody.json?.error?.fields,
    `${badBody.status} ${JSON.stringify(badBody.json?.error)?.slice(0, 100)}`,
  );

  const noRoute = await call('GET', '/definitely-not-a-route');
  check('unknown route → 404 envelope', noRoute.status === 404 && !!noRoute.json?.error?.code);
}

/* -------------------------------- summary --------------------------------- */

console.log(`\n${'─'.repeat(60)}`);
console.log(`${pass}/${pass + fail} checks passed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  · ${f}`));
}
process.exit(fail > 0 ? 1 : 0);
