# Setup — start here

Everything you need to get the API running locally. Follow it top to bottom;
it takes about ten minutes, most of which is downloads.

---

## 0. What you need installed

| | Version | Check with | Where |
|---|---|---|---|
| Node.js | 20 or newer | `node -v` | https://nodejs.org |
| Docker Desktop | any recent | `docker -v` | https://docker.com/products/docker-desktop |
| Git | any | `git -v` | already installed |

You do **not** need to install PostgreSQL. Docker provides it.

---

## 1. Install dependencies

```bash
npm install
```

---

## 2. Create your `.env`

```bash
cp .env.example .env
```

That is enough to run locally — the defaults match `docker-compose.yml`. Two
things are worth changing even in development:

**JWT secrets.** The file ships with placeholders. Generate real ones:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Run it twice and paste the results into `JWT_ACCESS_SECRET` and
`JWT_REFRESH_SECRET`. The server refuses to start in production while the
placeholders are still there.

**Nothing else is required.** Every integration key (`PAYRIFF_*`, `S3_*`,
`SMS_*`, `OCR_*`, OAuth) is optional — each one runs as a stub when its key is
absent, so a fresh clone works without a single third-party account.

---

## 3. Start PostgreSQL

Open **Docker Desktop** first and wait until it says "Engine running". Then:

```bash
docker compose up -d
```

Verify it came up:

```bash
docker compose ps
```

You should see `kitabdostu-postgres` with status `healthy`.

**The database is on port 5544, not 5432.** A PostgreSQL installed natively on
Windows takes 5432, and on at least one machine here it was already on 5433 as
well. That second case is worth knowing about because of how it fails: Docker
still reports the mapping as bound, but connections to `localhost` reach the
*native* server, so `prisma migrate` returns

```
P1000: Authentication failed ... credentials for `kitabdostu` are not valid
```

with credentials that are, in fact, correct. 5544 avoids it. If that port is
also taken on your machine, change it in **both** `docker-compose.yml` and
`DATABASE_URL` — they have to agree.

There is also a web UI for poking at the data at **http://localhost:8090**
(server `postgres`, user `kitabdostu`, password `kitabdostu`, database
`kitabdostu`).

---

## 4. Create the tables

```bash
npx prisma migrate dev
```

This runs both migrations: the tables, then the search index, constraints and
triggers Prisma cannot express on its own.

---

## 5. Load the data

```bash
npm run seed
```

This loads the same 1000 books, 618 authors, users, shelves, reviews and lists
the mobile app ships with, so the app looks identical whether it is running
against the mock or against this API.

It prints the sign-in accounts when it finishes:

| Role | Email | Password |
|---|---|---|
| reader | `leyla@kitabdostu.az` | `password123` |
| publisher | `publisher@kitabdostu.az` | `password123` |
| admin | `admin@kitabdostu.az` | `password123` |

Every seeded account shares that password. Development only — never seed a
production database with this file.

---

## 6. Run it

```bash
npm run dev
```

```
KitabDostu API listening on http://localhost:4000/api/v1
```

Check it:

```bash
curl http://localhost:4000/health
```

---

## Connecting the mobile app

In the **frontend** repository, create `.env.local`:

```bash
EXPO_PUBLIC_API_BASE_URL=http://localhost:4000/api/v1
EXPO_PUBLIC_USE_MOCK_API=false
```

Then restart Metro with `npx expo start --clear`. No frontend code changes.

### From a phone

`localhost` on your phone means *the phone*, not your computer. You need your
computer's LAN IP:

```bash
ipconfig
```

Look for "IPv4 Address" under your Wi-Fi adapter — something like
`192.168.1.42`. Then:

```bash
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.42:4000/api/v1
EXPO_PUBLIC_USE_MOCK_API=false
```

The API already listens on `0.0.0.0`, so it accepts LAN connections. Two things
still commonly block it:

- **Windows Firewall** silently drops the first connection to port 4000. When
  Windows prompts, allow Node.js on *private* networks. If you dismissed the
  prompt, add an inbound rule for TCP 4000.
- **Phone and computer must be on the same Wi-Fi**, and the network must not
  isolate clients (many university and café networks do).

---

## Everyday commands

```bash
npm run dev            # API with hot reload
```

```bash
npm run db:up          # start PostgreSQL
```

```bash
npm run db:down        # stop it, keep the data
```

```bash
npm run db:reset       # drop everything, re-migrate, re-seed
```

```bash
npm run seed           # reload the data without touching the schema
```

```bash
npm test               # run the test suite
```

```bash
npm run typecheck      # tsc --noEmit
```

---

## When something goes wrong

**`Can't reach database server at localhost:5544`**
Docker Desktop is not running, or the container is not up. Open Docker Desktop,
wait for "Engine running", then `docker compose up -d`.

**`P1000: Authentication failed` with credentials that look right**
Another PostgreSQL is already bound to that port and is answering instead of
the container. Check with:

```bash
docker exec kitabdostu-postgres psql -U kitabdostu -d kitabdostu -c "select 1"
```

If that works but Prisma still fails, the container is fine and something on
the host owns the port. Pick a free one and change it in both
`docker-compose.yml` and `DATABASE_URL`.

**`port is already allocated`**
Same cause, reported earlier. Same fix.

**`Environment variable not found: DATABASE_URL`**
You have not created `.env`. Run `cp .env.example .env`.

**Migrations fail with `type "citext" does not exist`**
The extensions are created by the first migration, so this means the migrations
ran out of order or partially. Reset: `npx prisma migrate reset --force`.

**Seed fails with a unique-constraint error**
The seeder truncates first, so this usually means a previous run died halfway
and left the schema in an odd state. `npm run db:reset` fixes it.

**The app connects but every screen is empty**
The API is running but the database was never seeded. Run `npm run seed`.

**Changed the Prisma schema and nothing happened**
Prisma generates a typed client from the schema; regenerate it with
`npx prisma generate`, then create a migration with `npx prisma migrate dev`.

---

## Wiping everything and starting over

```bash
docker compose down -v
```

```bash
docker compose up -d && npx prisma migrate dev && npm run seed
```

The `-v` removes the volume, so this genuinely deletes the data rather than
just stopping the container.
