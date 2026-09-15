-- Private buddy reads, joinable by code.
ALTER TABLE "buddy_reads" ADD COLUMN "is_private" BOOLEAN NOT NULL DEFAULT false;

-- Added nullable, backfilled, then tightened: the column is NOT NULL UNIQUE in
-- the schema, and an existing table cannot take that in one step.
ALTER TABLE "buddy_reads" ADD COLUMN "invite_code" TEXT;

-- The row number is the last component of every generated code, so two rows
-- can never collide no matter what the md5 prefix does. Codes minted by the
-- application from here on use the full alphabet.
WITH numbered AS (
  SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS rn
  FROM "buddy_reads"
)
UPDATE "buddy_reads" b
SET "invite_code" = upper(substr(md5(b."id"::text), 1, 4)) || lpad(n.rn::text, 2, '0')
FROM numbered n
WHERE n."id" = b."id";

ALTER TABLE "buddy_reads" ALTER COLUMN "invite_code" SET NOT NULL;

CREATE UNIQUE INDEX "buddy_reads_invite_code_key" ON "buddy_reads"("invite_code");
