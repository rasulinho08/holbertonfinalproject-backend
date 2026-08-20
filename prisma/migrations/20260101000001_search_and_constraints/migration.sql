-- Everything the Prisma schema cannot express.
--
-- Prisma has no syntax for CHECK constraints, partial indexes, generated
-- columns, GIN indexes or the citext type, so they live here. The Prisma
-- schema notes each one, and `prisma migrate diff` will not try to undo them
-- because they are additive to tables it already knows about.

-- ============================ case-insensitive identity =====================
-- citext gives "Leyla@..." and "leyla@..." the same uniqueness without a
-- LOWER() call at every lookup, and stops two accounts differing only by case.

ALTER TABLE "users" ALTER COLUMN "username" TYPE citext;
ALTER TABLE "users" ALTER COLUMN "email"    TYPE citext;

-- ================================ search ===================================
-- The catalogue is Azerbaijani, so search has to fold diacritics: typing "eli"
-- must find "Əli". unaccent() alone does not fold ə, ı, ş, ğ — hence translate().
-- IMMUTABLE is required for the generated column below.

CREATE OR REPLACE FUNCTION kd_normalize(input text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(
    translate(unaccent(coalesce(input, '')),
              'əıöüçşğƏIİÖÜÇŞĞ',
              'eioucsgeiioucsg')
  );
$$;

-- Stored, not computed on read: a LIKE over 1000 rows is fine, a LIKE that
-- calls unaccent() per row per query is not, and a GIN index needs a column.
ALTER TABLE "books"
  ADD COLUMN "search_text" text
  GENERATED ALWAYS AS (kd_normalize("title" || ' ' || coalesce("subtitle", ''))) STORED;

ALTER TABLE "authors"
  ADD COLUMN "search_text" text
  GENERATED ALWAYS AS (kd_normalize("name")) STORED;

CREATE INDEX "idx_books_search_trgm"   ON "books"   USING gin ("search_text" gin_trgm_ops);
CREATE INDEX "idx_authors_search_trgm" ON "authors" USING gin ("search_text" gin_trgm_ops);
CREATE INDEX "idx_books_genres"        ON "books"   USING gin ("genres");

-- ============================== partial indexes =============================
-- Soft-deleted rows are excluded from every public query, so the indexes those
-- queries use should not carry them.

CREATE INDEX "idx_books_active"    ON "books" ("created_at" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "idx_reviews_active"  ON "reviews" ("book_id", "created_at" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "idx_quotes_active"   ON "quotes" ("created_at" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "idx_lists_active"    ON "book_lists" ("is_official" DESC, "followers_count" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "idx_users_active"    ON "users" ("role") WHERE "deleted_at" IS NULL;
CREATE INDEX "idx_refresh_live"    ON "refresh_tokens" ("user_id") WHERE "revoked_at" IS NULL;

-- Exactly one default shelf per status per user. A partial unique index rather
-- than a plain one, because custom shelves all have status NULL and would
-- otherwise collide with each other.
CREATE UNIQUE INDEX "idx_shelves_default"
  ON "shelves" ("user_id", "status") WHERE "is_default";

-- ============================= check constraints ============================
-- Validation also happens in Zod at the edge. These are the backstop for
-- anything that reaches the database another way — a migration, a fix-up
-- script, a bug in a service.

ALTER TABLE "users"
  ADD CONSTRAINT "username_format" CHECK ("username" ~ '^[a-z0-9_]{3,20}$'),
  ADD CONSTRAINT "wallet_non_negative" CHECK ("wallet_balance" >= 0),
  -- A publisher account with no publisher can reach the publisher panel and
  -- see nothing, which reads as a broken app rather than a data problem.
  ADD CONSTRAINT "publisher_role" CHECK ("role" <> 'publisher' OR "publisher_id" IS NOT NULL);

ALTER TABLE "follows"
  ADD CONSTRAINT "no_self_follow" CHECK ("follower_id" <> "followee_id");

ALTER TABLE "books"
  ADD CONSTRAINT "page_count_positive" CHECK ("page_count" > 0),
  ADD CONSTRAINT "published_year_sane" CHECK ("published_year" IS NULL OR "published_year" BETWEEN 800 AND 2100),
  ADD CONSTRAINT "price_non_negative"  CHECK ("price" >= 0),
  -- An "old price" below the current price renders as a discount that costs
  -- more, which is the kind of thing a screenshot ends up on social media for.
  ADD CONSTRAINT "old_price_higher"    CHECK ("old_price" IS NULL OR "old_price" > "price"),
  ADD CONSTRAINT "stock_non_negative"  CHECK ("stock" >= 0);

ALTER TABLE "shelves"
  ADD CONSTRAINT "default_has_status" CHECK ("is_default" = ("status" IS NOT NULL));

ALTER TABLE "shelf_entries"
  ADD CONSTRAINT "progress_non_negative" CHECK ("progress_page" >= 0),
  ADD CONSTRAINT "finished_only_when_read" CHECK ("status" = 'read' OR "finished_at" IS NULL);

ALTER TABLE "reading_sessions"
  ADD CONSTRAINT "pages_forward"     CHECK ("end_page" >= "start_page"),
  ADD CONSTRAINT "start_page_valid"  CHECK ("start_page" >= 0),
  ADD CONSTRAINT "duration_valid"    CHECK ("duration_seconds" >= 0),
  ADD CONSTRAINT "ends_after_start"  CHECK ("ended_at" >= "started_at"),
  ADD CONSTRAINT "note_length"       CHECK ("note" IS NULL OR char_length("note") <= 280);

ALTER TABLE "reading_goals"
  ADD CONSTRAINT "target_sane" CHECK ("target" BETWEEN 1 AND 999);

ALTER TABLE "reviews"
  ADD CONSTRAINT "rating_range" CHECK ("rating" BETWEEN 1 AND 10),
  ADD CONSTRAINT "body_length"  CHECK (char_length("body") <= 5000),
  ADD CONSTRAINT "photo_limit"  CHECK (array_length("photos", 1) IS NULL OR array_length("photos", 1) <= 4);

ALTER TABLE "quotes"
  ADD CONSTRAINT "text_length" CHECK (char_length("text") BETWEEN 5 AND 1000),
  ADD CONSTRAINT "page_positive" CHECK ("page" IS NULL OR "page" > 0);

ALTER TABLE "comments"
  ADD CONSTRAINT "comment_length" CHECK (char_length("body") BETWEEN 1 AND 1000);

ALTER TABLE "book_lists"
  ADD CONSTRAINT "list_title_length" CHECK (char_length("title") BETWEEN 3 AND 120),
  ADD CONSTRAINT "list_desc_length"  CHECK (char_length("description") <= 400);

ALTER TABLE "book_list_items"
  ADD CONSTRAINT "list_note_length" CHECK ("note" IS NULL OR char_length("note") <= 200),
  ADD CONSTRAINT "position_non_negative" CHECK ("position" >= 0);

ALTER TABLE "buddy_read_messages"
  ADD CONSTRAINT "message_length" CHECK (char_length("body") BETWEEN 1 AND 2000);

ALTER TABLE "cart_items"
  ADD CONSTRAINT "quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "orders"
  ADD CONSTRAINT "subtotal_non_negative" CHECK ("subtotal" >= 0),
  ADD CONSTRAINT "delivery_non_negative" CHECK ("delivery_fee" >= 0),
  ADD CONSTRAINT "discount_non_negative" CHECK ("discount" >= 0),
  ADD CONSTRAINT "total_non_negative"    CHECK ("total" >= 0);

ALTER TABLE "order_items"
  ADD CONSTRAINT "unit_price_non_negative" CHECK ("unit_price" >= 0),
  ADD CONSTRAINT "item_quantity_positive"  CHECK ("quantity" > 0);

ALTER TABLE "gift_cards"
  ADD CONSTRAINT "gift_amount_positive" CHECK ("amount" > 0);

-- =============================== counter caches =============================
-- likes_count and comments_count are read on every card render and written far
-- less often, so they are maintained by trigger rather than counted per read.
-- A trigger rather than application code because a like can also disappear via
-- ON DELETE CASCADE when an account is removed, and no service call runs then.

CREATE OR REPLACE FUNCTION kd_sync_like_count()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta int := CASE TG_OP WHEN 'INSERT' THEN 1 ELSE -1 END;
  row_target_type target_type := COALESCE(NEW.target_type, OLD.target_type);
  row_target_id uuid := COALESCE(NEW.target_id, OLD.target_id);
BEGIN
  IF row_target_type = 'review' THEN
    UPDATE reviews SET likes_count = GREATEST(0, likes_count + delta) WHERE id = row_target_id;
  ELSE
    UPDATE quotes  SET likes_count = GREATEST(0, likes_count + delta) WHERE id = row_target_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_likes_count
AFTER INSERT OR DELETE ON "likes"
FOR EACH ROW EXECUTE FUNCTION kd_sync_like_count();

CREATE OR REPLACE FUNCTION kd_sync_comment_count()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delta int := CASE TG_OP WHEN 'INSERT' THEN 1 ELSE -1 END;
  row_target_type target_type := COALESCE(NEW.target_type, OLD.target_type);
  row_target_id uuid := COALESCE(NEW.target_id, OLD.target_id);
BEGIN
  IF row_target_type = 'review' THEN
    UPDATE reviews SET comments_count = GREATEST(0, comments_count + delta) WHERE id = row_target_id;
  ELSE
    UPDATE quotes  SET comments_count = GREATEST(0, comments_count + delta) WHERE id = row_target_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_comments_count
AFTER INSERT OR DELETE ON "comments"
FOR EACH ROW EXECUTE FUNCTION kd_sync_comment_count();

CREATE OR REPLACE FUNCTION kd_sync_list_followers()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE book_lists SET followers_count = followers_count + 1 WHERE id = NEW.list_id;
  ELSE
    UPDATE book_lists SET followers_count = GREATEST(0, followers_count - 1) WHERE id = OLD.list_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_list_followers
AFTER INSERT OR DELETE ON "book_list_follows"
FOR EACH ROW EXECUTE FUNCTION kd_sync_list_followers();
