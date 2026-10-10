/**
 * Sets new passwords for existing accounts — the safe way to retire the shared
 * demo password before real users arrive. Unlike `npm run seed`, this never
 * truncates anything: it changes only the password hash of the accounts named,
 * and signs out their existing sessions.
 *
 *   # every seeded demo account (14 readers + publisher + admin), new random passwords
 *   DATABASE_URL="postgresql://…" npm run user:set-password -- --demo --confirm
 *
 *   # one account, a random password
 *   DATABASE_URL="postgresql://…" npm run user:set-password -- publisher@kitabdostu.az --confirm
 *
 *   # one account, a password you choose (≥ 12 characters)
 *   DATABASE_URL="postgresql://…" npm run user:set-password -- leyla@kitabdostu.az --password 'your-choice' --confirm
 *
 * New passwords are printed once and stored nowhere else: copy them into a
 * password manager. Same hashing as sign-up (argon2id).
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const chosenPassword = option('--password');
const emails = new Set(
  args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--password').map((e) => e.toLowerCase()),
);

if (flag('--demo')) {
  const here = dirname(fileURLToPath(import.meta.url));
  const seeded = JSON.parse(readFileSync(resolve(here, '../prisma/seed-data/users.json'), 'utf8')) as {
    email: string;
  }[];
  for (const u of seeded) emails.add(u.email.toLowerCase());
  emails.add('publisher@kitabdostu.az');
  emails.add('admin@kitabdostu.az');
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (emails.size === 0) fail('Name at least one email, or pass --demo. See the header of this file.');
if (chosenPassword !== undefined && emails.size !== 1) fail('--password can only be used with a single account.');
if (chosenPassword !== undefined && chosenPassword.length < 12) fail('Choose a password of at least 12 characters.');
if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set.');

const host = new URL(process.env.DATABASE_URL).host;
if (!flag('--confirm')) {
  fail(
    `This would set new passwords for ${emails.size} account(s) on ${host}.\n` +
      'Re-run with --confirm to do it.',
  );
}

/** 18 random bytes → 24 URL-safe characters (~144 bits). */
const randomPassword = () => crypto.randomBytes(18).toString('base64url');

const prisma = new PrismaClient();
const results: { email: string; password: string }[] = [];
const missing: string[] = [];

try {
  for (const email of emails) {
    const user = await prisma.user.findFirst({ where: { email, deletedAt: null }, select: { id: true } });
    if (!user) {
      missing.push(email);
      continue;
    }
    const password = chosenPassword ?? randomPassword();
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      // Whoever was signed in with the old password is signed out.
      prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    results.push({ email, password });
  }
} finally {
  await prisma.$disconnect();
}

console.log(`\nUpdated ${results.length} account(s) on ${host}. Store these now; they are not saved anywhere:\n`);
for (const r of results) console.log(`  ${r.email.padEnd(28)} ${r.password}`);
if (missing.length) console.log(`\nNot found (skipped): ${missing.join(', ')}`);
console.log('');
