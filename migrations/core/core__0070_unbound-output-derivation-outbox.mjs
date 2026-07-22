// core__0070 — unbound agent-output derivation outbox + `derived_output`
// materialization-ledger path (cinatra#1893, epic #1883 slice A5).
//
// Two schema changes backing the produces-scoped capture of an unbound agent
// run's final output:
//
//   1. `artifact_materializations.path` CHECK gains `'derived_output'` — the new
//      ledger path the post-terminal derivation job writes through the standard
//      materializer. GUARDED widening (only re-validates when the constraint is
//      absent or lacks the value); no existing row carries it, so it never
//      rejects. Mirrors the core__0040 `sa_assertedby_chk` widening pattern.
//
//   2. `agent_run_output_derivations` — the transactional outbox. ONE row per
//      non-empty WayFlow terminal-success run, written ATOMICALLY with the
//      terminal status CAS + final-output snapshot (the post-terminal derivation
//      job derives against the agent's validated `produces`). PK `run_id` ⇒ the
//      terminal write's `ON CONFLICT (run_id) DO NOTHING` makes capture
//      idempotent under a stop/retry re-drive. `status` carries the derivation
//      lifecycle: `pending` (unclaimed) → `deriving` (LEASED, in-flight) →
//      terminal `done | no_match | no_produces`. A recoverable row lease
//      (`lease_token` + `lease_expires_at`, `attempts` incremented on claim)
//      SERIALIZES the derivation decision across the one-shot job and the
//      reconciliation sweep — two drivers can never split a run into
//      `no_match`+artifact. A reconciliation sweep scans `(status,created_at)`
//      for `pending` rows and `deriving` rows whose lease expired.
//
// SEQ RENUMBERED 0069 -> 0070 (STAGE-2 CI). core__0069 (assistant-thread-title-
// slug) landed on origin/main after this slice was cut, so the provisional 0069
// collided; this migration takes the next genuinely-free sequence, core__0070.
// A rename-only change — zero SQL diff. migrations/** is HIGH-RISK: owner
// approval is required and the lane never merges.
//
// USER-LAND-AFFECTING (fragment destructive:true) BUT IDEMPOTENT + REVERSIBLE +
// NON-DATA-DESTROYING. It ALTERs a DEPLOYED table's CHECK
// (artifact_materializations_path_check — DROP + re-ADD CONSTRAINT), which the
// schema-migration ledger classifies destructive; but the widening only ADMITS a
// new value ('derived_output') and rewrites/drops/rejects no existing row, plus
// one brand-new empty table (nothing REQUIRED). The DDL MIRRORS the idempotent
// bootstrap
// (buildCreateStoreSchemaQueries in src/lib/drizzle-store.ts — the same edit) —
// a no-op on a bootstrap-seeded schema, ledger-faked on a fresh install,
// executed by `db migrate` on an existing deployment. Both statements ride
// node-pg-migrate's default single transaction. Unqualified names resolve to the
// app schema on the runner's search_path; current_schema() is that schema.
//
// DOWN. Reversible in shape: drops the outbox table (its index rides the drop)
// and narrows the CHECK back — GUARDED, narrowing only when no `derived_output`
// row exists (those rows may be pinned by nothing, but a narrowing CHECK cannot
// be added while such a row exists, so the guard leaves the harmless additive
// widening in place and raises a NOTICE otherwise). Any in-flight outbox rows are
// lost by design (a fresh addition; an interrupted derivation is re-runnable).

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const unboundOutputDerivationDdlSql = `
  DO $amchk$
  DECLARE def text;
  BEGIN
    SELECT pg_get_constraintdef(c.oid) INTO def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.conname = 'artifact_materializations_path_check'
       AND t.relname = 'artifact_materializations'
       AND n.nspname = current_schema();
    IF def IS NULL THEN
      -- Constraint absent (older lineage or a differently-named inline CHECK) —
      -- (re)assert the canonical named path CHECK with the full value set.
      ALTER TABLE artifact_materializations DROP CONSTRAINT IF EXISTS artifact_materializations_path_check;
      ALTER TABLE artifact_materializations
        ADD CONSTRAINT artifact_materializations_path_check
        CHECK (path IN ('end_node_binding','materialize_tool','llm_emit','derived_output'));
    ELSIF position('derived_output' IN def) = 0 THEN
      ALTER TABLE artifact_materializations DROP CONSTRAINT artifact_materializations_path_check;
      ALTER TABLE artifact_materializations
        ADD CONSTRAINT artifact_materializations_path_check
        CHECK (path IN ('end_node_binding','materialize_tool','llm_emit','derived_output'));
    END IF;
  END $amchk$;

  CREATE TABLE IF NOT EXISTS agent_run_output_derivations (
    run_id           text PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
    org_id           text NOT NULL,
    template_id      text NOT NULL,
    package_version  text,
    created_by       text,
    content          text NOT NULL,
    content_is_json  boolean NOT NULL DEFAULT false,
    content_hash     text NOT NULL,
    status           text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','deriving','done','no_match','no_produces')),
    attempts         integer NOT NULL DEFAULT 0,
    lease_token      text,
    lease_expires_at timestamptz,
    detail           jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS agent_run_output_derivations_status_idx
    ON agent_run_output_derivations (status, created_at);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(unboundOutputDerivationDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS agent_run_output_derivations;
    DO $amchk_down$
    BEGIN
      IF EXISTS (SELECT 1 FROM artifact_materializations WHERE path = 'derived_output') THEN
        RAISE NOTICE 'core__0070 down(): derived_output ledger rows exist; leaving artifact_materializations_path_check widened. Archive/migrate those rows manually to narrow it.';
      ELSE
        ALTER TABLE artifact_materializations DROP CONSTRAINT IF EXISTS artifact_materializations_path_check;
        ALTER TABLE artifact_materializations
          ADD CONSTRAINT artifact_materializations_path_check
          CHECK (path IN ('end_node_binding','materialize_tool','llm_emit'));
      END IF;
    END $amchk_down$;
  `);
}
