-- 0001_notifications-dedupe-key.sql
--
-- Issue #50 (notification flyout shows the same notification twice):
-- add the general per-user notification dedupe key — a nullable
-- `dedupe_key` column plus the partial unique index the writer's
-- `ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND
-- user_id IS NOT NULL DO NOTHING` arbitrates on (the conflict clause must
-- carry the index predicate for Postgres partial-index inference; see
-- packages/notifications/src/service.ts).
--
-- The convention classifies a unique index on an existing table as
-- destructive (it can fail on existing duplicates), which is why this
-- artifact ships. THIS index cannot collide on pre-existing rows: the
-- column is added in the same change, so every existing row has
-- dedupe_key IS NULL and falls outside the partial-index predicate.
--
-- Both statements are idempotent and also ride the bootstrap DDL
-- (buildCreateStoreSchemaQueries in src/lib/drizzle-store.ts); applying
-- this file by hand and then booting (or vice versa) is safe.
--
-- Apply:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v schema=cinatra \
--     -f migrations/0001_notifications-dedupe-key.sql

ALTER TABLE :"schema"."notifications"
  ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key_idx
  ON :"schema"."notifications" (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND user_id IS NOT NULL;
