import { execFileSync } from 'node:child_process';
const PSQL = 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe';
const env = { ...process.env, PGPASSWORD: 'kitabdostu' };

const sql = `
  SELECT id, email, username, name, role::text AS role,
         CASE WHEN password_hash IS NOT NULL AND length(password_hash) > 0 THEN 'hashed' ELSE 'no-password' END AS password_status
  FROM users
  WHERE role::text = 'admin';
`;

const out = execFileSync(
  PSQL,
  ['-h', 'localhost', '-p', '5432', '-U', 'kitabdostu', '-d', 'kitabdostu',
   '-v', 'ON_ERROR_STOP=1', '-X', '-F', '|', '-R', '\n',
   '-P', 'footer=off', '-P', 'tuples_only=off', '-P', 'format=unaligned',
   '-c', sql],
  { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
process.stdout.write(out);
