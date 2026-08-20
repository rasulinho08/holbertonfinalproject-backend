<div align="center">

# KitabDostu — Backend API

**REST API for KitabDostu / Reader** — Azerbaijan's social network and
marketplace for book lovers.

Node.js · Express · TypeScript · Prisma · PostgreSQL

</div>

---

## Quick start

```bash
npm install && cp .env.example .env && docker compose up -d
```

```bash
npx prisma migrate dev && npm run seed && npm run dev
```

→ **http://localhost:4000/api/v1**

Full walkthrough, troubleshooting and how to connect a phone:
**[SETUP.md](./SETUP.md)**

---

## What this is

The mobile app in
[holbertonfinalproject](https://github.com/rasulinho08/holbertonfinalproject)
is already built and already calls every endpoint here — against a bundled mock
API. This repository replaces that mock. When it answers, the app switches over
by changing one environment variable and no code.

The contract is specified in the frontend repository under `backend-guide/`:

| Document | Covers |
|---|---|
| `CONVENTIONS.md` | Response envelope, pagination, error codes, headers |
| `ENDPOINTS.md` | Every route — method, path, auth, body, response, errors |
| `DATABASE.md` | The schema this Prisma model implements |
| `AUTH.md` | JWT rotation, OAuth, 2FA, roles |
| `ROADMAP.md` | The build order this repository follows |

That guide is the source of truth. Where this code and the guide disagree, the
guide is right and the code is a bug.

---

## Architecture

```
src/
├─ index.ts              server bootstrap, graceful shutdown
├─ app.ts                express app — testable without binding a port
├─ config/env.ts         typed environment, validated at boot
├─ lib/
│  ├─ prisma.ts          client + Decimal→number money helpers
│  ├─ errors.ts          ApiError and the code vocabulary
│  ├─ envelope.ts        { data } / { data, meta } response shapes
│  ├─ pagination.ts      query parsing, clamping
│  ├─ tokens.ts          access/refresh signing, rotation families
│  └─ logger.ts          pino, with auth headers redacted
├─ middleware/
│  ├─ auth.ts            optionalAuth · requireAuth · requireRole
│  ├─ validate.ts        Zod → 422 with per-field messages
│  ├─ error.ts           every throw → the error envelope
│  ├─ rateLimit.ts       per-user, falling back to per-IP
│  └─ requestId.ts       X-Request-Id
├─ modules/              one folder per resource
│  └─ <name>/
│     ├─ routes.ts       wiring only
│     ├─ service.ts      logic; the only place that touches Prisma
│     └─ schemas.ts      Zod schemas for bodies and queries
└─ integrations/         payments, SMS, push, OCR, storage — stubbed by default
```

Three rules keep it navigable:

1. **Routes do not contain logic.** A route validates, calls a service, and
   wraps the result. If a route has an `if`, it is probably in the wrong file.
2. **Services do not know about HTTP.** They take arguments and throw
   `ApiError`; they never touch `req` or `res`. That is what makes them
   testable without Supertest.
3. **Nothing outside `modules/` builds a query.** One place per resource knows
   its table.

---

## Money, dates and ids

- Money is `numeric(10,2)` in Postgres and `Decimal` in Prisma. Serialising a
  `Decimal` straight to JSON produces `{"s":1,"e":1,"d":[14,9]}`, so every money
  field goes through `money()` in `lib/prisma.ts` and reaches the client as a
  plain number with two decimals.
- All timestamps are ISO-8601 UTC.
- Ids are UUIDs. The frontend treats them as opaque strings and never parses
  them.
- Reading streaks and daily buckets are computed in the reader's timezone
  (`Asia/Baku` by default). UTC days would cost a Baku reader their streak
  every time they read after 20:00.

---

## Status

All 124 endpoints are implemented and verified against a seeded database.

```bash
npm run smoke:full
```

```
156/156 checks passed
```

| Milestone | Covers |
|---|---|
| M0 | Docker, 30-table schema, migrations, seed (1000 books) |
| M1 | Auth — JWT rotation, OAuth, TOTP 2FA, password reset |
| M2 | Catalogue — books, search, authors, genres, recommendations |
| M3 | Shelves, progress, profiles, follows, activity feed |
| M3b | Reading sessions and statistics |
| M4 | Book lists |
| M5 | Reviews, quotes, likes, comments |
| M6 | Cart, multi-publisher checkout, orders, payments, wallet |
| M7 | Badges, leaderboard, streaks, notifications |
| M8 | Buddy reads |
| M9 | Publisher panel |
| M10 | Moderation and admin |
| M11 | Uploads, OCR, integration stubs |

Two suites: `npm run smoke` covers auth and the catalogue in isolation,
`npm run smoke:full` walks every module end to end. Both assert the response
*shape* the app expects, not just the status code — a route returning the wrong
field name is a route the app renders blank, which a 200 check misses.

### Integrations

Every third-party integration runs as a stub when its key is absent, so a fresh
clone works without a single external account. Each one is a single file with
the real call to fill in:

| Integration | File | Without a key |
|---|---|---|
| Card payments (Payriff) | `integrations/payments.ts` | approves and logs; refuses in production |
| OAuth (Google, Facebook) | `integrations/oauth.ts` | accepts `stub:<uid>:<email>:<name>` |
| Push (Expo) | `integrations/push.ts` | logs the payload |
| Email | `integrations/mail.ts` | logs the reset link |
| Storage (S3) | `integrations/storage.ts` | echoes the URI |
| OCR | `integrations/ocr.ts` | returns a sample Azerbaijani passage |

Apple sign-in is deliberately left unimplemented rather than approximated — a
half-verified Apple token is an authentication bypass, not a missing feature.
