-- CreateTable
CREATE TABLE "publications" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "cover_url" TEXT,
    "author_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication_books" (
    "publication_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "note" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publication_books_pkey" PRIMARY KEY ("publication_id","book_id")
);

-- CreateIndex
CREATE INDEX "publications_created_at_idx" ON "publications"("created_at");

-- CreateIndex
CREATE INDEX "publications_author_id_idx" ON "publications"("author_id");

-- CreateIndex
CREATE INDEX "publication_books_publication_id_position_idx" ON "publication_books"("publication_id", "position");

-- CreateIndex
CREATE INDEX "publication_books_book_id_idx" ON "publication_books"("book_id");

-- AddForeignKey
ALTER TABLE "publications" ADD CONSTRAINT "publications_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_books" ADD CONSTRAINT "publication_books_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "publications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_books" ADD CONSTRAINT "publication_books_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;
