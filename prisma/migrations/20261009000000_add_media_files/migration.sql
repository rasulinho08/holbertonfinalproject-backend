-- CreateTable
CREATE TABLE "media_files" (
    "id" UUID NOT NULL,
    "owner_id" UUID,
    "kind" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_files_owner_id_idx" ON "media_files"("owner_id");

-- AddForeignKey
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

