import { execFileSync } from 'node:child_process';
const PSQL = process.env.PSQL_PATH || 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe';
const PGHOST = process.env.PGHOST || 'localhost';
const PGPORT = process.env.PGPORT || '5432';
const SUPERUSER = process.env.PG_SUPERUSER || 'postgres';
const SUPERUSER_PASSWORD = process.env.PG_SUPERUSER_PASSWORD || '';
const APP_PGUSER = process.env.APP_PGUSER || 'kitabdostu';
const APP_PGPASSWORD = process.env.APP_PGPASSWORD || '';
const PGDATABASE = process.env.PGDATABASE || 'kitabdostu';
const env = { ...process.env, PGPASSWORD: SUPERUSER_PASSWORD }; // trust/empty for postgres superuser by default

function psql(db, sql) {
  try {
    const out = execFileSync(
      PSQL,
      ['-h', PGHOST, '-p', PGPORT, '-U', SUPERUSER, '-d', db,
       '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A', '-c', sql],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, err: (e.stderr ?? e.message ?? String(e)).trim() };
  }
}

const steps = [
  [`GRANT ALL ON DATABASE ${PGDATABASE} TO ${APP_PGUSER};`, 'grant db'],
  [`GRANT ALL ON SCHEMA public TO ${APP_PGUSER};`, 'grant schema'],
  [`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${APP_PGUSER};`, 'grant existing tables'],
  [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${APP_PGUSER};`, 'default tables'],
  [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${APP_PGUSER};`, 'default sequences'],
  [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TYPES TO ${APP_PGUSER};`, 'default types'],
  [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SCHEMAS TO ${APP_PGUSER};`, 'default schema usage'],
  [`ALTER USER ${APP_PGUSER} WITH CREATEDB;`, 'allow createdb (needed for shadow DB during dev)'],
];

let okCount = 0;
for (const [sql, label] of steps) {
  const r = psql(PGDATABASE, sql);
  if (r.ok) { console.log(`[ok] ${label}`); okCount++; }
  else console.log(`[warn] ${label}: ${(r.err||'').split('\n')[0].slice(0,180)}`);
}

// quick sanity check as app user
const asApp = { ...process.env, PGPASSWORD: APP_PGPASSWORD };
try {
  const out = execFileSync(
    PSQL,
    ['-h', PGHOST, '-p', PGPORT, '-U', APP_PGUSER, '-d', PGDATABASE, '-X', '-q', '-t', '-A',
     '-c', `SELECT has_schema_privilege('public','USAGE') || ' / tables: ' || has_schema_privilege('public','CREATE')`],
    { env: asApp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  console.log(`[ok] app user schema privs: ${out}`);
} catch (e) {
  console.log(`[check] app schema privs: ` + (e.stderr || e.message).split('\n')[0]);
}

console.log(`\nDone (${okCount}/${steps.length} ok).`);
