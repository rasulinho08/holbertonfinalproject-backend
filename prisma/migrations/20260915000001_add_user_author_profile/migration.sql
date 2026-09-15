-- Links a writer account to the Author profile it speaks for.
--
-- Nullable and ON DELETE SET NULL: removing an author profile must not delete
-- the person's account along with it.
ALTER TABLE "users" ADD COLUMN "author_id" UUID;

ALTER TABLE "users"
  ADD CONSTRAINT "users_author_id_fkey"
  FOREIGN KEY ("author_id") REFERENCES "authors"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "users_author_id_idx" ON "users"("author_id");
