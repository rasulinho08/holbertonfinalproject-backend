import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import { PrismaClient, Prisma } from '@prisma/client';
import type {
  BookLanguage,
  NotificationType,
  ReportReason,
  ReportStatus,
  ShelfStatus,
  TargetType,
} from '@prisma/client';

/**
 * Seeds the database from `prisma/seed-data/`.
 *
 * Those files are the frontend's mock dataset, exported verbatim — 1000 books
 * harvested from Open Library, 618 authors, and the social graph on top. The
 * point is that the app looks and behaves identically before and after the
 * cutover from the mock API, which turns the switch into something you can
 * verify rather than hope for.
 *
 *   npm run seed          # idempotent: wipes and re-seeds
 *
 * Every seeded account shares one password so any of them can be used to sign
 * in during development. That is stated loudly below rather than hidden.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, 'seed-data');

/** Every seeded user gets this password. Development only. */
const DEV_PASSWORD = 'password123';

const prisma = new PrismaClient();

function load<T>(name: string): T[] {
  return JSON.parse(readFileSync(resolve(DATA, `${name}.json`), 'utf8')) as T[];
}

/* ------------------------------- source shapes ---------------------------- */
/* The JSON uses the API shape (camelCase); columns are snake_case. Prisma does
   the renaming, so these interfaces describe the files, not the tables.        */

interface SeedPublisher {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  city: string;
}

interface SeedAuthor {
  id: string;
  name: string;
  slug: string;
  bio: string;
  photoUrl: string | null;
}

interface SeedBook {
  id: string;
  title: string;
  subtitle: string | null;
  authorId: string;
  publisherId: string;
  isbn: string;
  language: string;
  genres: string[];
  coverUrl: string | null;
  description: string;
  pageCount: number;
  publishedYear: number;
  price: number;
  oldPrice: number | null;
  stock: number;
  ratingAverage: number;
  ratingCount: number;
  reviewsCount: number;
  quotesCount: number;
  createdAt: string;
}

interface SeedUser {
  id: string;
  username: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: string;
  favoriteGenres: string[];
  walletBalance: number;
  goal: { year: number; target: number };
}

interface SeedShelf {
  id: string;
  userId: string;
  status: string | null;
  name: string;
  isDefault: boolean;
}

interface SeedShelfEntry {
  id: string;
  userId: string;
  bookId: string;
  shelfId: string;
  status: string;
  progressPage: number;
  startedAt: string | null;
  finishedAt: string | null;
  addedAt: string;
}

interface SeedReview {
  id: string;
  bookId: string;
  user: { id: string };
  rating: number;
  body: string;
  isSpoiler: boolean;
  createdAt: string;
}

interface SeedQuote {
  id: string;
  bookId: string;
  user: { id: string };
  text: string;
  page: number | null;
  background: string;
  createdAt: string;
}

interface SeedSession {
  id: string;
  userId: string;
  bookId: string;
  startPage: number;
  endPage: number;
  durationSeconds: number;
  note: string | null;
  startedAt: string;
  endedAt: string;
}

interface SeedList {
  id: string;
  slug: string;
  title: string;
  description: string;
  ownerId: string;
  isOfficial: boolean;
  followersCount: number;
  items: { bookId: string; note: string | null; position: number }[];
  createdAt: string;
}

interface SeedBuddyRead {
  id: string;
  name: string;
  bookId: string;
  ownerId: string;
  members: { user: { id: string }; progressPage: number }[];
  targetDate: string | null;
  createdAt: string;
}

interface SeedBuddyMessage {
  id: string;
  buddyReadId: string;
  user: { id: string };
  body: string;
  chapter: number | null;
  createdAt: string;
}

interface SeedReport {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  note: string | null;
  reportedBy: { id: string };
  status: string;
  createdAt: string;
  snapshot: { text: string; authorName: string; bookTitle: string | null };
}

interface SeedBadge {
  slug: string;
  name: string;
  description: string;
  icon: string;
  target: number;
}

/* --------------------------------- helpers -------------------------------- */

/**
 * Seed ids are prefixed strings (`b_1`, `u_3`); the schema uses uuid columns.
 * Rather than change the column type, each seed id is mapped to a generated
 * uuid once and the map is consulted whenever a foreign key is written.
 */
const ids = new Map<string, string>();
const uuidFor = (seedId: string): string => {
  let existing = ids.get(seedId);
  if (!existing) {
    existing = crypto.randomUUID();
    ids.set(seedId, existing);
  }
  return existing;
};

const decimal = (n: number) => new Prisma.Decimal(n.toFixed(2));
const date = (iso: string | null) => (iso ? new Date(iso) : null);

/** Calendar day in Asia/Baku, matching how the API buckets sessions. */
function bakuDate(iso: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Baku',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
  return new Date(`${parts}T00:00:00.000Z`);
}

const GENRES = new Set([
  'novel', 'mystery', 'scifi', 'fantasy', 'history', 'biography', 'poetry',
  'psychology', 'philosophy', 'business', 'children', 'classic', 'science', 'selfHelp',
]);

const LANGUAGES = new Set(['az', 'en', 'tr', 'ru']);

/**
 * The `published_year_sane` CHECK rejects anything outside 800–2100, and a
 * handful of Open Library records carry no first-publish year at all — which
 * reaches the export as 0. The column is nullable precisely for that case, so
 * an unknown year is stored as unknown rather than as the year zero.
 */
function sanePublishedYear(year: number | null | undefined): number | null {
  if (!year || year < 800 || year > 2100) return null;
  return year;
}

/* ---------------------------------- run ----------------------------------- */

async function main() {
  console.log('Seeding KitabDostu…\n');
  const started = Date.now();

  // Order matters: dependants first, so foreign keys never block a delete.
  console.log('  clearing existing data');
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      search_history, admin_actions, reports, device_tokens, notifications,
      user_badges, badges, wallet_transactions, payments, order_events,
      order_items, orders, gift_cards, cart_items,
      buddy_read_messages, buddy_read_members, buddy_reads,
      book_list_follows, book_list_items, book_lists,
      comments, likes, quotes, reviews,
      reading_goals, reading_sessions, shelf_entries, shelves,
      author_follows, follows, oauth_accounts, password_reset_tokens,
      refresh_tokens, user_favorite_authors,
      books, authors, users, publishers
    RESTART IDENTITY CASCADE
  `);

  /* ------------------------------- catalogue ------------------------------ */

  const publishers = load<SeedPublisher>('publishers');
  await prisma.publisher.createMany({
    data: publishers.map((p) => ({
      id: uuidFor(p.id),
      name: p.name,
      slug: p.slug,
      logoUrl: p.logoUrl,
      city: p.city,
    })),
  });
  console.log(`  publishers      ${publishers.length}`);

  const authors = load<SeedAuthor>('authors');
  await prisma.author.createMany({
    data: authors.map((a) => ({
      id: uuidFor(a.id),
      name: a.name,
      // Slugs must be unique; the harvest can produce two authors whose names
      // fold to the same slug, so collisions get the seed id appended.
      slug: a.slug || a.id,
      bio: a.bio,
      photoUrl: a.photoUrl,
    })),
    skipDuplicates: true,
  });
  // Anything dropped as a duplicate slug is re-inserted with a unique one, so
  // no book ends up pointing at a missing author.
  const insertedAuthors = new Set((await prisma.author.findMany({ select: { id: true } })).map((a) => a.id));
  const missing = authors.filter((a) => !insertedAuthors.has(uuidFor(a.id)));
  if (missing.length > 0) {
    await prisma.author.createMany({
      data: missing.map((a, i) => ({
        id: uuidFor(a.id),
        name: a.name,
        slug: `${a.slug || a.id}-${i + 2}`,
        bio: a.bio,
        photoUrl: a.photoUrl,
      })),
    });
  }
  console.log(`  authors         ${authors.length}`);

  const books = load<SeedBook>('books');
  await prisma.book.createMany({
    data: books.map((b) => ({
      id: uuidFor(b.id),
      title: b.title,
      subtitle: b.subtitle,
      authorId: uuidFor(b.authorId),
      publisherId: uuidFor(b.publisherId),
      isbn: b.isbn,
      language: (LANGUAGES.has(b.language) ? b.language : 'az') as BookLanguage,
      genres: b.genres.filter((g) => GENRES.has(g)),
      coverUrl: b.coverUrl,
      description: b.description,
      pageCount: b.pageCount,
      publishedYear: sanePublishedYear(b.publishedYear),
      price: decimal(b.price),
      oldPrice: b.oldPrice ? decimal(b.oldPrice) : null,
      stock: b.stock,
      // ratingAverage is derived from sum/count, so the sum is reconstructed
      // rather than stored — that is what keeps a new review a single
      // increment instead of a recompute.
      ratingSum: Math.round(b.ratingAverage * b.ratingCount),
      ratingCount: b.ratingCount,
      reviewsCount: b.reviewsCount,
      quotesCount: b.quotesCount,
      createdAt: new Date(b.createdAt),
    })),
    skipDuplicates: true,
  });
  console.log(`  books           ${books.length}`);

  /* --------------------------------- users -------------------------------- */

  const users = load<SeedUser>('users');
  const passwordHash = await argon2.hash(DEV_PASSWORD, { type: argon2.argon2id });

  await prisma.user.createMany({
    data: users.map((u) => ({
      id: uuidFor(u.id),
      username: u.username,
      email: u.email,
      name: u.name,
      passwordHash,
      avatarUrl: u.avatarUrl,
      bio: u.bio,
      favoriteGenres: u.favoriteGenres.filter((g) => GENRES.has(g)),
      walletBalance: decimal(u.walletBalance),
      createdAt: new Date(u.createdAt),
    })),
  });

  // A publisher and an admin account, so all three role experiences can be
  // demonstrated without editing the database by hand.
  const firstPublisher = publishers[0]!;
  await prisma.user.create({
    data: {
      id: uuidFor('u_publisher'),
      username: 'publisher',
      email: 'publisher@kitabdostu.az',
      name: 'Qanun Nəşriyyatı',
      passwordHash,
      role: 'publisher',
      publisherId: uuidFor(firstPublisher.id),
      bio: 'Nəşriyyat hesabı — demo.',
    },
  });
  await prisma.user.create({
    data: {
      id: uuidFor('u_admin'),
      username: 'admin',
      email: 'admin@kitabdostu.az',
      name: 'Moderator',
      passwordHash,
      role: 'admin',
      bio: 'Moderasiya hesabı — demo.',
    },
  });
  console.log(`  users           ${users.length + 2}  (+ publisher, admin)`);

  await prisma.readingGoal.createMany({
    data: users.map((u) => ({
      userId: uuidFor(u.id),
      year: u.goal.year,
      target: u.goal.target,
    })),
    skipDuplicates: true,
  });

  /* -------------------------------- shelves ------------------------------- */

  const shelves = load<SeedShelf>('shelves');
  await prisma.shelf.createMany({
    data: shelves.map((s, i) => ({
      id: uuidFor(s.id),
      userId: uuidFor(s.userId),
      status: (s.status ?? null) as ShelfStatus | null,
      name: s.name,
      isDefault: s.isDefault,
      position: i % 6,
    })),
  });

  // The two extra accounts need their four default shelves too — the app
  // assumes every user has them and would otherwise 404 on the shelves tab.
  for (const seedId of ['u_publisher', 'u_admin']) {
    await prisma.shelf.createMany({
      data: (['reading', 'read', 'want_to_read', 'dnf'] as ShelfStatus[]).map((status, i) => ({
        userId: uuidFor(seedId),
        status,
        name: status,
        isDefault: true,
        position: i,
      })),
    });
  }
  console.log(`  shelves         ${shelves.length + 8}`);

  const entries = load<SeedShelfEntry>('shelf_entries');
  await prisma.shelfEntry.createMany({
    data: entries.map((e) => ({
      id: uuidFor(e.id),
      userId: uuidFor(e.userId),
      bookId: uuidFor(e.bookId),
      shelfId: uuidFor(e.shelfId),
      status: e.status as ShelfStatus,
      progressPage: e.progressPage,
      startedAt: date(e.startedAt),
      finishedAt: date(e.finishedAt),
      addedAt: new Date(e.addedAt),
    })),
    skipDuplicates: true,
  });
  console.log(`  shelf entries   ${entries.length}`);

  /* --------------------------- reading sessions --------------------------- */

  const sessions = load<SeedSession>('reading_sessions');
  await prisma.readingSession.createMany({
    data: sessions.map((s) => ({
      id: uuidFor(s.id),
      userId: uuidFor(s.userId),
      bookId: uuidFor(s.bookId),
      startPage: s.startPage,
      endPage: s.endPage,
      durationSeconds: s.durationSeconds,
      note: s.note,
      startedAt: new Date(s.startedAt),
      endedAt: new Date(s.endedAt),
      sessionDate: bakuDate(s.startedAt),
    })),
  });
  console.log(`  sessions        ${sessions.length}`);

  /* ---------------------------- social content ---------------------------- */

  const reviews = load<SeedReview>('reviews');
  // The schema enforces one review per user per book; the export contains
  // several per book from a pool of 14 users, so duplicates are dropped here
  // rather than letting the unique index reject the whole batch.
  const seenReview = new Set<string>();
  const uniqueReviews = reviews.filter((r) => {
    const key = `${r.user.id}:${r.bookId}`;
    if (seenReview.has(key)) return false;
    seenReview.add(key);
    return true;
  });

  await prisma.review.createMany({
    data: uniqueReviews.map((r) => ({
      id: uuidFor(r.id),
      userId: uuidFor(r.user.id),
      bookId: uuidFor(r.bookId),
      rating: r.rating,
      body: r.body,
      isSpoiler: r.isSpoiler,
      createdAt: new Date(r.createdAt),
    })),
    skipDuplicates: true,
  });
  console.log(`  reviews         ${uniqueReviews.length}  (${reviews.length - uniqueReviews.length} duplicates dropped)`);

  const quotes = load<SeedQuote>('quotes');
  await prisma.quote.createMany({
    data: quotes.map((q) => ({
      id: uuidFor(q.id),
      userId: uuidFor(q.user.id),
      bookId: uuidFor(q.bookId),
      text: q.text,
      page: q.page,
      background: q.background,
      createdAt: new Date(q.createdAt),
    })),
  });
  console.log(`  quotes          ${quotes.length}`);

  /* -------------------------------- lists --------------------------------- */

  const lists = load<SeedList>('book_lists');
  for (const list of lists) {
    await prisma.bookList.create({
      data: {
        id: uuidFor(list.id),
        slug: list.slug,
        title: list.title,
        description: list.description,
        ownerId: uuidFor(list.ownerId),
        isOfficial: list.isOfficial,
        createdAt: new Date(list.createdAt),
        items: {
          createMany: {
            data: list.items.map((item) => ({
              bookId: uuidFor(item.bookId),
              note: item.note,
              position: item.position,
            })),
          },
        },
      },
    });
  }
  console.log(`  lists           ${lists.length}`);

  /* ------------------------------ buddy reads ----------------------------- */

  const buddyReads = load<SeedBuddyRead>('buddy_reads');
  for (const br of buddyReads) {
    await prisma.buddyRead.create({
      data: {
        id: uuidFor(br.id),
        name: br.name,
        bookId: uuidFor(br.bookId),
        ownerId: uuidFor(br.ownerId),
        targetDate: date(br.targetDate),
        createdAt: new Date(br.createdAt),
        members: {
          createMany: {
            data: br.members.map((m) => ({
              userId: uuidFor(m.user.id),
              progressPage: m.progressPage,
            })),
          },
        },
      },
    });
  }

  const buddyMessages = load<SeedBuddyMessage>('buddy_read_messages');
  await prisma.buddyReadMessage.createMany({
    data: buddyMessages.map((m) => ({
      id: uuidFor(m.id),
      buddyReadId: uuidFor(m.buddyReadId),
      userId: uuidFor(m.user.id),
      body: m.body,
      chapter: m.chapter,
      createdAt: new Date(m.createdAt),
    })),
  });
  console.log(`  buddy reads     ${buddyReads.length} (${buddyMessages.length} messages)`);

  /* -------------------------------- badges -------------------------------- */

  const badges = load<SeedBadge>('badges');
  await prisma.badge.createMany({
    data: badges.map((b) => ({
      slug: b.slug,
      // The export carries only the Azerbaijani copy; English is filled in by
      // the API's own dictionary, so the column is seeded with the same text
      // rather than left empty and rendered blank in the EN locale.
      nameAz: b.name,
      nameEn: b.name,
      descriptionAz: b.description,
      descriptionEn: b.description,
      icon: b.icon,
      target: b.target,
    })),
  });
  console.log(`  badges          ${badges.length}`);

  /* ------------------------------- follows -------------------------------- */
  // A social graph, so the friends feed and the followers list are not empty.

  const userIds = users.map((u) => uuidFor(u.id));
  const follows: { followerId: string; followeeId: string }[] = [];
  userIds.forEach((follower, i) => {
    for (let step = 1; step <= 4; step++) {
      const followee = userIds[(i + step) % userIds.length]!;
      if (followee !== follower) follows.push({ followerId: follower, followeeId: followee });
    }
  });
  await prisma.follow.createMany({ data: follows, skipDuplicates: true });
  console.log(`  follows         ${follows.length}`);

  /* -------------------------------- reports ------------------------------- */

  const reports = load<SeedReport>('reports');
  await prisma.report.createMany({
    data: reports.map((r) => ({
      id: uuidFor(r.id),
      targetType: r.targetType as TargetType,
      targetId: uuidFor(r.targetId),
      reason: r.reason as ReportReason,
      note: r.note,
      reporterId: uuidFor(r.reportedBy.id),
      status: r.status as ReportStatus,
      snapshotText: r.snapshot.text,
      snapshotAuthorName: r.snapshot.authorName,
      snapshotBookTitle: r.snapshot.bookTitle,
      createdAt: new Date(r.createdAt),
    })),
  });
  console.log(`  reports         ${reports.length}`);

  /* ------------------------------ gift cards ------------------------------ */

  await prisma.giftCard.createMany({
    data: [
      { code: 'KITAB10', amount: decimal(10) },
      { code: 'KITAB25', amount: decimal(25) },
      { code: 'HEDIYYE5', amount: decimal(5) },
    ],
  });

  /* ----------------------------- notifications ---------------------------- */

  const demoUser = users[0]!;
  const notificationSeeds: {
    type: NotificationType;
    params: Record<string, string>;
    link: string;
    read: boolean;
    daysAgo: number;
  }[] = [
    { type: 'follow', params: { name: users[3]!.name }, link: `/user/${users[3]!.username}`, read: false, daysAgo: 0.2 },
    { type: 'quote_like', params: { name: users[6]!.name }, link: '/quotes', read: false, daysAgo: 0.6 },
    { type: 'review_comment', params: { name: users[2]!.name }, link: '/quotes', read: false, daysAgo: 1.4 },
    { type: 'buddy_invite', params: { name: users[9]!.name }, link: '/buddy-reads', read: true, daysAgo: 3 },
    { type: 'badge_earned', params: { name: 'Sitat ustası' }, link: '/badges', read: true, daysAgo: 8 },
  ];

  await prisma.notification.createMany({
    data: notificationSeeds.map((n) => ({
      userId: uuidFor(demoUser.id),
      type: n.type,
      params: n.params,
      link: n.link,
      read: n.read,
      createdAt: new Date(Date.now() - n.daysAgo * 86_400_000),
    })),
  });

  /* -------------------------------- summary ------------------------------- */

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nSeeded in ${seconds}s.\n`);
  console.log('Sign in with any seeded account:');
  console.log(`  reader     leyla@kitabdostu.az      / ${DEV_PASSWORD}`);
  console.log(`  publisher  publisher@kitabdostu.az  / ${DEV_PASSWORD}`);
  console.log(`  admin      admin@kitabdostu.az      / ${DEV_PASSWORD}`);
  console.log('\nEvery seeded account shares that password. Development only.\n');
}

main()
  .catch((error) => {
    console.error('\nSeed failed:\n', error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
