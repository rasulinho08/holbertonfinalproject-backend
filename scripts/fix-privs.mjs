import { execFileSync } from 'node:child_process';
const PSQL = 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe';
const env = { ...process.env, PGPASSWORD: '' }; // trust/empty for postgres superuser

function psql(db, sql) {
  try {
    const out = execFileSync(
      PSQL,
      ['-h', 'localhost', '-p', '5432', '-U', 'postgres', '-d', db,
       '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A', '-c', sql],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, err: (e.stderr ?? e.message ?? String(e)).trim() };
  }
}

const steps = [
  [`GRANT ALL ON DATABASE kitabdostu TO kitabdostu;`, 'grant db'],
  [`GRANT ALL ON SCHEMA public TO kitabdostu;`, 'grant schema'],
  [`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO kitabdostu;`, 'grant existing tables'],
  [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO kitabdostu;`, 'default tables'],
  [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO kitabdostu;`, 'default sequences'],
  [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TYPES TO kitabdostu;`, 'default types'],
  [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SCHEMAS TO kitabdostu;`, 'default schema usage'],
  [`ALTER USER kitabdostu WITH CREATEDB;`, 'allow createdb (needed for shadow DB during dev)'],
];

let okCount = 0;
for (const [sql, label] of steps) {
  const r = psql('kitabdostu', sql);
  if (r.ok) { console.log(`[ok] ${label}`); okCount++; }
  else console.log(`[warn] ${label}: ${(r.err||'').split('\n')[0].slice(0,180)}`);
}

// quick sanity check as app user
const asApp = { ...process.env, PGPASSWORD: 'kitabdostu' };
try {
  const out = execFileSync(
    PSQL,
    ['-h','localhost','-p','5432','-U','kitabdostu','-d','kitabdostu','-X','-q','-t','-A',
     '-c',`SELECT has_schema_privilege('public','USAGE') || ' / tables: ' || has_schema_privilege('public','CREATE')`],
    { env: asApp, encoding: 'utf8', stdio:['ignore','pipe','pipe'] },
  ).trim();
  console.log(`[ok] app user schema privs: ${out}`);
} catch (e) {
  console.log(`[check] app schema privs: ` + (e.stderr||e.message).split('\n')[0]);
}

console.log(`\nDone (${okCount}/${steps.length} ok).`);
