# Seed data

Exported from the frontend's mock dataset (`src/api/mock/seed.ts`) by
`scripts/export-seed.mjs`. Seeding the real database with these files means the
app looks and behaves **identically** before and after switching from the mock
API to the live backend — which turns the cutover into something you can verify
rather than hope for.

| File | Records | Notes |
|---|---|---|
| `publishers.json` | 10 | Azerbaijani publishing houses |
| `authors.json` | 618 | 455 have a real portrait URL |
| `books.json` | 1000 | 981 have a real cover URL |
| `users.json` | 14 | `users[0]` (`leyla`) is the demo account |
| `shelves.json` | 58 | 4 default shelves per user + 2 custom for the demo user |
| `shelf_entries.json` | 221 | Books distributed across shelves with progress |
| `reviews.json` | 715 | 1–10 ratings, some flagged as spoilers |
| `quotes.json` | 26 | With background presets and page numbers |
| `reading_sessions.json` | 62 | ~2 months of history for the demo account |
| `book_lists.json` | 8 | Curated lists; `items[]` is inline |
| `buddy_reads.json` | 2 | Plus `buddy_read_messages.json` |
| `reports.json` | 5 | Pre-populated moderation queue |
| `badges.json` | 10 | Badge definitions — insert these in every environment |
| `quote_backgrounds.json` | 8 | Reference only; the gradients live in the client |

## Where the catalogue comes from

The 1000 books and 618 authors are harvested from **[Open Library](https://openlibrary.org)**
by `scripts/build-catalog.mjs`, which writes `src/api/mock/catalog.json`. Open
Library's bibliographic data is public domain (CC0) and its cover images are
served from `covers.openlibrary.org`.

Open Library knows nothing about prices, stock levels, Azerbaijani descriptions
or anything social, so `seed.ts` generates those from a fixed PRNG seed
(`mulberry32(20260810)`) on top of the real bibliographic records. That is why
the export is deterministic: re-running it produces byte-identical files.

The catalogue is weighted towards books that actually have an Azerbaijani or
Turkish edition (Open Library's `language:aze` / `language:tur` pools), with a
genre spread on top so every filter chip in Explore has real results behind it.

**Cover and portrait URLs point at Open Library's CDN.** For a student project
that is fine and is what the frontend ships with. For production you should
mirror the images to your own storage during seeding and rewrite the URLs — you
do not want your catalogue's availability tied to a third party's CDN, and
Open Library asks that you not hammer it with production traffic.

The URLs encode a size suffix:

```
https://covers.openlibrary.org/b/id/8231856-M.jpg      # book cover
https://covers.openlibrary.org/a/id/6674332-M.jpg      # author portrait
                                          ^ S (~40px) | M (~180px) | L (~500px)
```

The client rewrites that suffix to match the rendered width, so keep whatever
sizing scheme you migrate to suffix-compatible, or update
`sizedUri()` in `src/components/book/BookCover.tsx`.

User avatars use `api.dicebear.com`, which generates a portrait from a seed
string. Same advice: fine for the demo, mirror it for production.

## Field mapping

The JSON uses the **API shape** (camelCase, as returned by the endpoints), not
the database shape (snake_case). When writing your seeder, map accordingly:

| JSON | Column |
|---|---|
| `authorId` | `author_id` |
| `publisherId` | `publisher_id` |
| `pageCount` | `page_count` |
| `publishedYear` | `published_year` |
| `oldPrice` | `old_price` |
| `ratingAverage` + `ratingCount` | `rating_sum` = round(avg × count), `rating_count` |
| `coverUrl` | `cover_url` |
| `photoUrl` | `photo_url` |
| `createdAt` | `created_at` |
| `durationSeconds` | `duration_seconds` |
| `startPage` / `endPage` | `start_page` / `end_page` |
| `isOfficial` | `is_official` |

Ids are prefixed strings (`b_1`, `u_3`, `pub_2`, `rs_4`, `bl_2`). Either keep
them as text primary keys, or generate UUIDs and hold a mapping while seeding —
the frontend treats ids as opaque, so both work.

## Notes

- `reading_sessions.json` has no `session_date` column; derive it from
  `startedAt` in the account's timezone. See
  [`DATABASE.md`](../DATABASE.md#reading_sessions).
- `book_lists.json` nests its books under `items[]`. Split those into
  `book_list_items` rows, preserving `position`. `followerIds` is empty in the
  export — `followersCount` is a plausible number with no rows behind it, so
  either seed matching `book_list_follows` rows or accept the counter cache
  starting out ahead of reality.
- `users[].email` follows `<username>@kitabdostu.az`. There are no password
  hashes — set a known development password for every seeded user.
- `reviews.json` contains multiple reviews per book. Since the schema enforces
  one review per user per book, de-duplicate on `(user.id, bookId)` while
  seeding, or the unique constraint will reject rows.
- `books[].isbn` comes from Open Library where available; the rest are generated
  and are **not** valid ISBNs. Do not add a checksum constraint.
- Dates are ISO-8601 and were generated relative to the export date. Shifting
  them to be relative to your seed run keeps "3 days ago" labels sensible.

## Regenerating

From the frontend repository root:

```bash
node scripts/build-catalog.mjs --target 1000
```

```bash
node scripts/export-seed.mjs
```

The first hits Open Library (a few minutes; responses are cached in
`scripts/.ol-cache.json`) and is only needed when you want a fresh or larger
catalogue. The second is offline and instant.
