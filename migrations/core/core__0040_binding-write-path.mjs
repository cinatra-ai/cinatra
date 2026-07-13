// core__0040 — binding write-path support (cinatra#1429, epic #1424).
//
// The binding-assertion write path + per-claim activation gate need three
// schema changes on top of core__0034 (claim registry) and core__0036
// (assertion_basis binding columns):
//
//   1. sa_assertedby_chk += 'system' — binding reconciliation writes bindings
//      as asserted_by='system' (the service/worker principal driving claim
//      reconciliation, never a human/agent/skill classification). The widening
//      is guarded (only re-validates when the constraint is absent or lacks
//      'system'); existing rows never carry 'system', so it never rejects.
//
//   2. object_binding_quarantine — per-object exclusion set the activation gate
//      populates when an enrolling type's legacy row fails registered-Zod
//      validation; the binding reconcile + backfill sweep skip quarantined
//      rows so an invalid row never receives a binding assertion. NOT an
//      `objects` mutation.
//
//   3. artifact_binding_backfill_checkpoint — resumable backfill watermark
//      (one row per scope × object_type_id × generation; cursor_object_id is
//      the batch watermark). An interrupted backfill resumes from the last
//      committed batch; a completed backfill re-runs to zero new rows.
//
// ADDITIVE + safe CHECK widening (migrations/README.md "Additive"): two
// brand-new empty tables (nothing REQUIRED) and a CHECK that only ADMITS a new
// value — no existing row is rejected, no column drops, no data rewrite.
// Shipped anyway (the core__0034 / core__0037 precedent) to keep fresh
// bootstrap and operator upgrade aligned. The DDL MIRRORS the idempotent
// bootstrap (buildCreateStoreSchemaQueries → bindingWritePathSchemaQueries +
// the semantic_assertion CHECK reconcile in semantic-assertion-schema.ts) — a
// no-op on a bootstrap-seeded schema, executed by `db migrate` on an existing
// deployment. No `noTransaction()` (guarded DDL on empty tables + a CHECK
// widening are instant). Unqualified names ride the runner's search_path (the
// app schema); current_schema() is that schema.

/** Idempotent DDL mirroring the bootstrap — safe to run after it. */
export const bindingWritePathDdlSql = `
  DO $abchk$
  DECLARE def text;
  BEGIN
    SELECT pg_get_constraintdef(c.oid) INTO def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.conname = 'sa_assertedby_chk'
       AND t.relname = 'semantic_assertion'
       AND n.nspname = current_schema();
    IF def IS NULL THEN
      ALTER TABLE semantic_assertion
        ADD CONSTRAINT sa_assertedby_chk CHECK (asserted_by IN ('user','authoring_skill','agent','matcher','system'));
    ELSIF position('system' IN def) = 0 THEN
      ALTER TABLE semantic_assertion DROP CONSTRAINT sa_assertedby_chk;
      ALTER TABLE semantic_assertion
        ADD CONSTRAINT sa_assertedby_chk CHECK (asserted_by IN ('user','authoring_skill','agent','matcher','system'));
    END IF;
  END $abchk$;

  CREATE TABLE IF NOT EXISTS object_binding_quarantine (
    org_id text NOT NULL,
    object_id text NOT NULL,
    object_type_id text NOT NULL,
    quarantined_generation integer,
    reason text NOT NULL,
    detail jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT object_binding_quarantine_pk PRIMARY KEY (org_id, object_id)
  );
  CREATE INDEX IF NOT EXISTS object_binding_quarantine_type_idx
    ON object_binding_quarantine (object_type_id);

  CREATE TABLE IF NOT EXISTS artifact_binding_backfill_checkpoint (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    scope text NOT NULL,
    object_type_id text NOT NULL,
    generation integer NOT NULL,
    cursor_object_id text,
    processed_count integer NOT NULL DEFAULT 0,
    inserted_count integer NOT NULL DEFAULT 0,
    quarantined_skipped integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'running',
    started_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    CONSTRAINT abbc_status_chk CHECK (status IN ('running','done')),
    CONSTRAINT abbc_scope_chk CHECK (scope = 'platform' OR scope LIKE 'org:_%')
  );
  CREATE UNIQUE INDEX IF NOT EXISTS abbc_one_per_key
    ON artifact_binding_backfill_checkpoint (scope, object_type_id, generation);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(bindingWritePathDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible in shape without destroying pinned data. Drop the two fresh
  // tables. The asserted_by CHECK narrow is GUARDED: a narrowing CHECK cannot
  // be added while asserted_by='system' rows exist, and those binding rows may
  // be PINNED by append-only run_context_selections (deleting them would break
  // replay). So down() narrows the CHECK ONLY when no 'system' assertion exists;
  // otherwise it leaves the (harmless, additive) widening in place and raises a
  // NOTICE — the widening admits a value nothing rolled-back depends on. An
  // operator that truly wants the narrow must first archive/migrate the binding
  // rows deliberately (a data operation, not an automatic migration side effect).
  pgm.sql(`
    DROP TABLE IF EXISTS artifact_binding_backfill_checkpoint;
    DROP TABLE IF EXISTS object_binding_quarantine;
    DO $abchk_down$
    BEGIN
      IF EXISTS (SELECT 1 FROM semantic_assertion WHERE asserted_by = 'system') THEN
        RAISE NOTICE 'core__0040 down(): asserted_by=''system'' binding rows exist (possibly pinned by run_context_selections); leaving sa_assertedby_chk widened. Archive/migrate those rows manually to narrow it.';
      ELSE
        ALTER TABLE semantic_assertion DROP CONSTRAINT IF EXISTS sa_assertedby_chk;
        ALTER TABLE semantic_assertion
          ADD CONSTRAINT sa_assertedby_chk CHECK (asserted_by IN ('user','authoring_skill','agent','matcher'));
      END IF;
    END $abchk_down$;
  `);
}
