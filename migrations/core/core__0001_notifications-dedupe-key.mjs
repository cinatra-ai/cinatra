// core__0001 — runner form of migrations/0001_notifications-dedupe-key.sql.
//
// Issue #50: add the per-user notification dedupe key — a nullable
// `dedupe_key` column plus the partial unique index the writer's
// `ON CONFLICT (user_id, dedupe_key) WHERE …` arbitrates on.
//
// This module re-expresses the shipped hand-apply artifact 1:1 so the
// node-pg-migrate ledger covers the full core history (cinatra#116). It is
// idempotent on every lineage:
//   - deployments that applied the .sql by hand: both statements no-op;
//   - deployments that only ever booted: the bootstrap DDL already created
//     column + index; both statements no-op;
//   - fresh schemas: setup ledger-fakes the chain instead of executing it
//     (see packages/cli/src/core-migrations.mjs).
//
// Table names are unqualified: the runner sets search_path to the app schema
// (SUPABASE_SCHEMA), which keeps worktree schemas working. The index
// statement is guarded on `notifications.user_id` existing because a
// half-set-up schema (CLI base tables, never booted) has only (id, payload);
// the full bootstrap creates the same index later in that lineage.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS dedupe_key text;`);
  pgm.sql(`DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'notifications'
      AND column_name = 'user_id'
  ) THEN
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key_idx
         ON %I.notifications (user_id, dedupe_key)
         WHERE dedupe_key IS NOT NULL AND user_id IS NOT NULL',
      current_schema()
    );
  END IF;
END $$;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`DROP INDEX IF EXISTS notifications_dedupe_key_idx;`);
  pgm.sql(`ALTER TABLE notifications
  DROP COLUMN IF EXISTS dedupe_key;`);
}
