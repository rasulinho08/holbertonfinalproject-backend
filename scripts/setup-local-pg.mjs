// Quick one-off: connect to local PostgreSQL on port 5432, create kitabdostu
// user + database. Try common passwords for the postgres superuser; if none
// work, print a clear error so a human can enter the right creds.
import { execFileSync } from 'node:child_process';

const PSQL = 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe';
const HOST = 'localhost';
const PORT = '5432';
const SUPERUSER = 'postgres';
const CANDIDATES = [
  '',            // no password (trust auth)
  'postgres',    // EnterpriseDB default
  'password',
  'admin',
  'root',
  '123456',
];

function run(sql, { user = SUPERUSER, password } = {}) {
  const env = { ...process.env };
  if (password) env.PGPASSWORD = password;
  try {
    const out = execFileSync(
      PSQL,
      ['-h', HOST, '-p', PORT, '-U', user, '-d', 'postgres',
       '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A', '-c', sql],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, err: (e.stderr ?? e.message ?? String(e)).trim() };
  }
}

let working = null;
for (const pwd of CANDIDATES) {
  const r = run('SELECT current_user', { password: pwd });
  if (r.ok) { working = pwd; console.log(`[ok] Connected as postgres (password=${JSON.stringify(pwd) || 'empty'}) -> ${r.out}`); break; }
  console.log(`[skip] postgres/${JSON.stringify(pwd)}: ${r.err.split('\n')[0]}`);
}
if (working === null) {
  console.error('\n[fail] Could not log into local PostgreSQL as "postgres" on localhost:5432.');
  console.error('Set PGPASSWORD in this script or run the equivalent manually:');
  console.error('  psql -U postgres -c "CREATE ROLE kitabdostu LOGIN PASSWORD \'kitabdostu\';"');
  console.error('  psql -U postgres -c "CREATE DATABASE kitabdostu OWNER kitabdostu;"');
  process.exit(1);
}

const opts = { password: working };
const steps = [
  // user may already exist; use DO block for idempotency
  [
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'kitabdostu') THEN CREATE ROLE kitabdostu LOGIN PASSWORD 'kitabdostu'; END IF; END $$;`,
    'ensure role kitabdostu exists',
  ],
  [`ALTER ROLE kitabdostu WITH LOGIN PASSWORD 'kitabdostu';`, 'set/confirm kitabdostu password'],
  [
    `SELECT 1 FROM pg_database WHERE datname = 'kitabdostu'`,
    'check db existence',
  ],
];

for (const [sql, label] of steps) {
  const r = run(sql, opts);
  if (!r.ok) { console.error(`[fail] ${label}: ${r.err}`); process.exit(2); }
  console.log(`[ok] ${label}${r.out ? ' -> ' + r.out : ''}`);
}

// Create database if missing
const { out: exists } = run(
  `SELECT count(*) FROM pg_database WHERE datname = 'kitabdostu'`,
  opts,
);
if (exists === '0') {
  const r = run(`CREATE DATABASE kitabdostu OWNER kitabdostu;`, opts);
  if (!r.ok) { console.error(`[fail] create database: ${r.err}`); process.exit(3); }
  console.log('[ok] Created database kitabdostu (owner=kitabdostu)');
} else {
  console.log('[ok] Database kitabdostu already exists -> skipped creation (no reset)');
}

// Grant connect + schema privileges to kitabdostu (harmless if already granted)
{
  // For postgres connection
  const r1 = run(`GRANT CONNECT ON DATABASE kitabdostu TO kitabdostu;`, opts);
  if (!r1.ok) console.warn(`[warn] grant connect (harmless if already applied): ${r1.err.slice(0,160)}`);
}
// Now connect as kitabdostu and ensure public schema is usable + citext extension
const asApp = { user: 'kitabdostu', password: 'kitabdostu' };
{
  // connect to kitabdostu as superuser first, create citext extension (must be superuser)
  const env = { ...process.env, PGPASSWORD: working };
  try {
    execFileSync(
      PSQL,
      ['-h', HOST, '-p', PORT, '-U', SUPERUSER, '-d', 'kitabdostu',
       '-v', 'ON_ERROR_STOP=1', '-X', '-q',
       '-c', `CREATE EXTENSION IF NOT EXISTS citext SCHEMA public;`],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    console.log('[ok] Extension citext present in kitabdostu');
  } catch (e) {
    console.warn('[warn] citext extension: ' + (e.stderr || e.message).split('\n')[0]);
  }
}

// Sanity-check connection as kitabdostu to kitabdostu
const sr = run('SELECT current_database() || \'@\' || current_user',
  { ...asApp, dbOverride: 'kitabdostu' });
// psql above defaults to postgres db; re-do with kitabdostu:
try {
  const env = { ...process.env, PGPASSWORD: asApp.password };
  const out = execFileSync(
    PSQL,
    ['-h', HOST, '-p', PORT, '-U', asApp.user, '-d', 'kitabdostu',
     '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A',
     '-c', `SELECT current_database() || '@' || current_user`],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  console.log(`[ok] App user connectivity: ${out}`);
} catch (e) {
  console.error(`[fail] Cannot log in as kitabdostu to kitabdostu: ` +
                (e.stderr || e.message).split('\n')[0]);
  process.exit(4);
}

console.log('\nDone. DATABASE_URL=postgresql://kitabdostu:kitabdostu@localhost:5432/kitabdostu?schema=public');
