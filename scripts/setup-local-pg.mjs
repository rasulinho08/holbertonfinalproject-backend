// Quick one-off: connect to local PostgreSQL, create the app user + database.
//
// Set these environment variables to override defaults:
//   PSQL_PATH, PGHOST, PGPORT, PG_SUPERUSER, PG_SUPERUSER_PASSWORD,
//   APP_PGUSER, APP_PGPASSWORD, PGDATABASE
//
// If PG_SUPERUSER_PASSWORD is not set, a few well-known defaults are tried
// (trust-auth / no password, and common installer defaults). This keeps the
// script usable on a fresh machine without hard-coding any real password.
import { execFileSync } from 'node:child_process';

const PSQL = process.env.PSQL_PATH || 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe';
const HOST = process.env.PGHOST || 'localhost';
const PORT = process.env.PGPORT || '5432';
const SUPERUSER = process.env.PG_SUPERUSER || 'postgres';
const APP_PGUSER = process.env.APP_PGUSER || 'kitabdostu';
const APP_PGPASSWORD = process.env.APP_PGPASSWORD || '';
const PGDATABASE = process.env.PGDATABASE || 'kitabdostu';

// PG_SUPERUSER_PASSWORD wins; otherwise try a short list of installer defaults
// only. Real passwords must never appear in this file.
const EXPLICIT_SUPER_PWD = process.env.PG_SUPERUSER_PASSWORD;
const CANDIDATES = EXPLICIT_SUPER_PWD !== undefined
  ? [EXPLICIT_SUPER_PWD]
  : [
      '',             // trust auth (no password)
      'postgres',     // EnterpriseDB installer default
    ];

function run(sql, { user = SUPERUSER, password, db = 'postgres' } = {}) {
  const env = { ...process.env };
  if (password) env.PGPASSWORD = password;
  try {
    const out = execFileSync(
      PSQL,
      ['-h', HOST, '-p', PORT, '-U', user, '-d', db,
       '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A', '-c', sql],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, err: (e.stderr ?? e.message ?? String(e)).trim() };
  }
}

if (!APP_PGPASSWORD) {
  console.error('[fail] APP_PGPASSWORD is not set in the environment.');
  console.error('  Example (PowerShell): $env:APP_PGPASSWORD = "your-strong-pw"');
  process.exit(5);
}

let working = null;
for (const pwd of CANDIDATES) {
  const r = run('SELECT current_user', { password: pwd });
  if (r.ok) { working = pwd; console.log(`[ok] Connected as ${SUPERUSER} -> ${r.out}`); break; }
  console.log(`[skip] ${SUPERUSER}/${pwd ? '<set>' : '<empty>'}: ${r.err.split('\n')[0]}`);
}
if (working === null) {
  console.error(`\n[fail] Could not log into local PostgreSQL as "${SUPERUSER}" on ${HOST}:${PORT}.`);
  console.error('Set PG_SUPERUSER_PASSWORD in your shell, or run the equivalent manually:');
  console.error(`  psql -U ${SUPERUSER} -c "CREATE ROLE ${APP_PGUSER} LOGIN PASSWORD '<app-password>';"`);
  console.error(`  psql -U ${SUPERUSER} -c "CREATE DATABASE ${PGDATABASE} OWNER ${APP_PGUSER};"`);
  process.exit(1);
}

const opts = { password: working };
const appPwdQuoted = APP_PGPASSWORD.replace(/'/g, "''");
const steps = [
  [
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${APP_PGUSER}') THEN CREATE ROLE ${APP_PGUSER} LOGIN PASSWORD '${appPwdQuoted}'; END IF; END $$;`,
    `ensure role ${APP_PGUSER} exists`,
  ],
  [`ALTER ROLE ${APP_PGUSER} WITH LOGIN PASSWORD '${appPwdQuoted}';`, `set/confirm ${APP_PGUSER} password`],
  [
    `SELECT 1 FROM pg_database WHERE datname = '${PGDATABASE}'`,
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
  `SELECT count(*) FROM pg_database WHERE datname = '${PGDATABASE}'`,
  opts,
);
if (exists === '0') {
  const r = run(`CREATE DATABASE ${PGDATABASE} OWNER ${APP_PGUSER};`, opts);
  if (!r.ok) { console.error(`[fail] create database: ${r.err}`); process.exit(3); }
  console.log(`[ok] Created database ${PGDATABASE} (owner=${APP_PGUSER})`);
} else {
  console.log(`[ok] Database ${PGDATABASE} already exists -> skipped creation (no reset)`);
}

// Grant connect + schema privileges to the app user (harmless if already granted)
{
  const r1 = run(`GRANT CONNECT ON DATABASE ${PGDATABASE} TO ${APP_PGUSER};`, opts);
  if (!r1.ok) console.warn(`[warn] grant connect (harmless if already applied): ${r1.err.slice(0, 160)}`);
}
// Connect to app db as superuser first, create citext extension (must be superuser)
{
  const env = { ...process.env, PGPASSWORD: working };
  try {
    execFileSync(
      PSQL,
      ['-h', HOST, '-p', PORT, '-U', SUPERUSER, '-d', PGDATABASE,
       '-v', 'ON_ERROR_STOP=1', '-X', '-q',
       '-c', `CREATE EXTENSION IF NOT EXISTS citext SCHEMA public;`],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    console.log(`[ok] Extension citext present in ${PGDATABASE}`);
  } catch (e) {
    console.warn('[warn] citext extension: ' + (e.stderr || e.message).split('\n')[0]);
  }
}

// Sanity-check connection as app user to app db
try {
  const env = { ...process.env, PGPASSWORD: APP_PGPASSWORD };
  const out = execFileSync(
    PSQL,
    ['-h', HOST, '-p', PORT, '-U', APP_PGUSER, '-d', PGDATABASE,
     '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A',
     '-c', `SELECT current_database() || '@' || current_user`],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  console.log(`[ok] App user connectivity: ${out}`);
} catch (e) {
  console.error(`[fail] Cannot log in as ${APP_PGUSER} to ${PGDATABASE}: ` +
                (e.stderr || e.message).split('\n')[0]);
  process.exit(4);
}

console.log(`\nDone. Set DATABASE_URL=postgresql://${APP_PGUSER}:<APP_PGPASSWORD>@${HOST}:${PORT}/${PGDATABASE}?schema=public in your .env`);
