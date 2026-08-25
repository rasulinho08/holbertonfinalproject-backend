import { execFileSync } from 'node:child_process';
const PSQL = process.env.PSQL_PATH || 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe';
const PGHOST = process.env.PGHOST || 'localhost';
const PGPORT = process.env.PGPORT || '5432';
const APP_PGUSER = process.env.APP_PGUSER || 'kitabdostu';
const APP_PGPASSWORD = process.env.APP_PGPASSWORD || '';
const PGDATABASE = process.env.PGDATABASE || 'kitabdostu';
const env = { ...process.env, PGPASSWORD: APP_PGPASSWORD };

const sql = `
  SELECT id, email, username, name, role::text AS role,
         CASE WHEN password_hash IS NOT NULL AND length(password_hash) > 0 THEN 'hashed' ELSE 'no-password' END AS password_status
  FROM users
  WHERE role::text = 'admin';
`;

const out = execFileSync(
  PSQL,
  ['-h', PGHOST, '-p', PGPORT, '-U', APP_PGUSER, '-d', PGDATABASE,
   '-v', 'ON_ERROR_STOP=1', '-X', '-F', '|', '-R', '\n',
   '-P', 'footer=off', '-P', 'tuples_only=off', '-P', 'format=unaligned',
   '-c', sql],
  { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
process.stdout.write(out);
