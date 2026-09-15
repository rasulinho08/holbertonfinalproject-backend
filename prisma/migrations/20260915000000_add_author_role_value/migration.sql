-- Adds the writer role.
--
-- Alone in its own migration on purpose. PostgreSQL allows ALTER TYPE ... ADD
-- VALUE inside a transaction (which is how `prisma migrate deploy` runs a
-- migration file), but the new value cannot be *used* until that transaction
-- commits. Keeping it separate means the next migration, and every insert
-- afterwards, is free to use it.
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'author';
