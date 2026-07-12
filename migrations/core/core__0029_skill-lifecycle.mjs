// core__0029 — skill lifecycle foundation (cinatra#1361, epic #1358 A1).
//
// Adds the custom/personal skill lifecycle layer to the core store:
//   - typed columns on the EXISTING `skills` table: lifecycle_state
//     (draft|active|deprecated|archived, nullable — NULL = a DERIVED extension
//     skill), superseded_by (self-FK, no-cycle enforced app-side), and
//     active_revision_id (the ONLY mutable pointer; composite FK to the
//     owning revision);
//   - `skill_revisions`: append-only immutable revision history (distinct event
//     id — NOT the content digest; source manual|autosave|hitl|chat-capture|
//     migration; based_on_skill_ids + base_digests). A BEFORE UPDATE OR DELETE
//     trigger raises, so a revision can never be mutated or deleted;
//   - `skill_lifecycle_audit`: one row per lifecycle transition.
//
// DESTRUCTIVE (adds CHECK + FK constraints over the populated `skills` table),
// so this artifact + its manifest fragment are REQUIRED by the schema-migration
// gate. The DDL below MIRRORS the idempotent bootstrap (buildCreateStoreSchema
// Queries + skillLifecycleSchemaQueries) so the fresh-bootstrap and operator-
// upgrade paths converge; it is fully guarded, so it is a no-op on a schema the
// bootstrap already evolved (boot order: bootstrap DDL THEN this chain).
//
// The migration-SPECIFIC work is the BACKFILL: existing custom/personal skills
// become `active` and get a seeded `migration` revision + active-revision
// pointer. Unqualified names ride the runner's search_path (the app schema).
//
// INVARIANT: `skills.payload` is always valid JSON (JSON.stringify output of
// replaceSkillCatalogInDatabase / buildUpsertJsonRowQuery), so `payload::jsonb`
// never throws in practice; a genuinely malformed row would abort the migration
// loudly (fail-closed — better than silent misclassification).

// The custom/personal predicate — the SQL mirror of
// @cinatra-ai/skills `isCustomOrPersonalSkillPayload`. Canonical marker:
// packageId begins with "custom:" (every custom/personal upsertSkill write sets
// it); the isCustomSkill / isPersonal flags are honored for defense in depth.
const CUSTOM_PREDICATE = `(
  (payload::jsonb ->> 'packageId') LIKE 'custom:%'
  OR (payload::jsonb ->> 'isCustomSkill')::boolean IS TRUE
  OR (payload::jsonb ->> 'isPersonal')::boolean IS TRUE
)`;

/** Idempotent DDL mirroring the bootstrap — safe to run after it. */
export const lifecycleDdlSql = `
  ALTER TABLE skills ADD COLUMN IF NOT EXISTS lifecycle_state text;
  ALTER TABLE skills ADD COLUMN IF NOT EXISTS superseded_by text;
  ALTER TABLE skills ADD COLUMN IF NOT EXISTS active_revision_id text;

  CREATE TABLE IF NOT EXISTS skill_revisions (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    skill_id text NOT NULL,
    content_digest text,
    source text NOT NULL,
    based_on_skill_ids jsonb,
    base_digests jsonb,
    author_user_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT skill_revisions_source_check CHECK (source IN ('manual','autosave','hitl','chat-capture','migration')),
    CONSTRAINT skill_revisions_id_skill_uk UNIQUE (id, skill_id)
  );
  CREATE INDEX IF NOT EXISTS skill_revisions_skill_created_idx ON skill_revisions (skill_id, created_at DESC);

  CREATE OR REPLACE FUNCTION fn_skill_revisions_append_only() RETURNS trigger LANGUAGE plpgsql AS $body$
  BEGIN
    RAISE EXCEPTION 'skill_revisions is append-only: % forbidden — record a NEW revision instead', TG_OP;
  END;
  $body$;
  DROP TRIGGER IF EXISTS trg_skill_revisions_append_only ON skill_revisions;
  CREATE TRIGGER trg_skill_revisions_append_only BEFORE UPDATE OR DELETE ON skill_revisions FOR EACH ROW EXECUTE FUNCTION fn_skill_revisions_append_only();

  CREATE TABLE IF NOT EXISTS skill_lifecycle_audit (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    skill_id text NOT NULL,
    from_state text,
    to_state text NOT NULL,
    actor_user_id text,
    actor_type text,
    reason text,
    metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS skill_lifecycle_audit_skill_created_idx ON skill_lifecycle_audit (skill_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS skills_superseded_by_idx ON skills (superseded_by) WHERE superseded_by IS NOT NULL;
  CREATE INDEX IF NOT EXISTS skills_lifecycle_state_idx ON skills (lifecycle_state) WHERE lifecycle_state IS NOT NULL;

  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = current_schema() AND table_name = 'skills' AND constraint_name = 'skills_lifecycle_state_check') THEN
      ALTER TABLE skills ADD CONSTRAINT skills_lifecycle_state_check
        CHECK (lifecycle_state IS NULL OR lifecycle_state IN ('draft','active','deprecated','archived'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = current_schema() AND table_name = 'skills' AND constraint_name = 'skills_superseded_by_fkey') THEN
      ALTER TABLE skills ADD CONSTRAINT skills_superseded_by_fkey
        FOREIGN KEY (superseded_by) REFERENCES skills(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = current_schema() AND table_name = 'skills' AND constraint_name = 'skills_active_revision_fkey') THEN
      ALTER TABLE skills ADD CONSTRAINT skills_active_revision_fkey
        FOREIGN KEY (active_revision_id, id) REFERENCES skill_revisions(id, skill_id);
    END IF;
  END $$;
`;

// ---- Backfill (three ordered, idempotent statements — codex-converged) ----
// A single row must never be UPDATEd twice in one statement, so activation and
// pointer-set are distinct statements with the revision seed between them.

/** (1) Activate existing custom/personal skills that have no state yet. */
export const backfillActivateSql = `UPDATE skills
     SET lifecycle_state = 'active'
   WHERE lifecycle_state IS NULL
     AND ${CUSTOM_PREDICATE}`;

/** (2) Seed one immutable `migration` revision per just-activated skill. The
 * deterministic id 'migration:'||id makes re-runs idempotent (ON CONFLICT) and
 * inherently binds the row to its skill (the composite active-revision FK). */
export const backfillSeedRevisionsSql = `INSERT INTO skill_revisions (id, skill_id, content_digest, source, created_at)
   SELECT 'migration:' || id, id, (payload::jsonb #>> '{source,revision}'), 'migration', now()
     FROM skills
    WHERE lifecycle_state = 'active'
      AND active_revision_id IS NULL
      AND ${CUSTOM_PREDICATE}
   ON CONFLICT (id) DO NOTHING`;

/** (3) Point active_revision_id at the seeded revision (guarded so the composite
 * FK can never be violated — only points when the revision row exists). */
export const backfillSetPointerSql = `UPDATE skills
     SET active_revision_id = 'migration:' || id
   WHERE lifecycle_state = 'active'
     AND active_revision_id IS NULL
     AND EXISTS (SELECT 1 FROM skill_revisions r WHERE r.id = 'migration:' || skills.id AND r.skill_id = skills.id)`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(lifecycleDdlSql);
  pgm.sql(backfillActivateSql);
  pgm.sql(backfillSeedRevisionsSql);
  pgm.sql(backfillSetPointerSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: everything here is a #1361 addition, so down() restores the
  // exact pre-0029 shape on any lineage. Drop constraints first (they reference
  // skills/skill_revisions), then the trigger + its function, then the tables,
  // then the columns (which take their partial indexes with them).
  pgm.sql(`
    ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_active_revision_fkey;
    ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_superseded_by_fkey;
    ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_lifecycle_state_check;
    DROP TRIGGER IF EXISTS trg_skill_revisions_append_only ON skill_revisions;
    DROP FUNCTION IF EXISTS fn_skill_revisions_append_only();
    DROP TABLE IF EXISTS skill_revisions;
    DROP TABLE IF EXISTS skill_lifecycle_audit;
    ALTER TABLE skills DROP COLUMN IF EXISTS active_revision_id;
    ALTER TABLE skills DROP COLUMN IF EXISTS superseded_by;
    ALTER TABLE skills DROP COLUMN IF EXISTS lifecycle_state;
  `);
}
