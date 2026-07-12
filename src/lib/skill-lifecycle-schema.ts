// Bootstrap DDL for the skill-lifecycle history + audit tables (cinatra#1361,
// epic #1358) — the ADDITIVE half of the lifecycle schema: the two brand-new
// tables, their indexes, and the append-only immutability trigger on
// `skill_revisions`. The DESTRUCTIVE half (the `skills` typed columns +
// CHECK / self-FK / composite active-revision FK) stays INLINE in
// buildCreateStoreSchemaQueries (src/lib/drizzle-store.ts) so the
// schema-migration gate SEES it and demands the core__0029 migration artifact.
//
// A pure string builder with ZERO imports — a synchronous leaf, safe for
// drizzle-store.ts's synchronous require() composition (same contract as
// co-owner-constraint-schema.ts / the postgres-sync-leaf-imports test). The
// enum value sets below are a schema contract mirrored by @cinatra-ai/skills
// `REVISION_SOURCES`; skill-lifecycle-schema.test.ts asserts they stay in sync.

/**
 * skill_revisions (immutable revision history) + skill_lifecycle_audit
 * (transition audit log). Spread into buildCreateStoreSchemaQueries AFTER the
 * `skills` CREATE TABLE + the inline `skills` lifecycle columns (skill_revisions
 * needs no FK to skills, but the inline composite active-revision FK on `skills`
 * needs skill_revisions to exist — that inline FK is spread AFTER this).
 */
export function skillLifecycleSchemaQueries(schemaName: string): { text: string }[] {
  const q = schemaName.replaceAll('"', '""'); // identifier
  return [
    // ---- skill_revisions: append-only immutable content-revision history ----
    // `id` is a DISTINCT event id (NOT the content digest) — repeated identical
    // content still gets a distinct revision, so provenance is per write.
    // `skill_id` carries NO foreign key ON PURPOSE: revisions are durable /
    // tombstoned history that survives a hard skill delete, and — critically —
    // an FK ON DELETE CASCADE would fire the BELOW append-only BEFORE DELETE
    // trigger during a parent-skill delete and abort the whole catalog-replace
    // transaction (replaceSkillCatalogInDatabase deletes vanished skill rows).
    // `content_digest` is NULLABLE: the migration backfill seeds it from a
    // legacy row's stored source digest when present, NULL when unknown.
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."skill_revisions" (
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
    )` },
    { text: `CREATE INDEX IF NOT EXISTS skill_revisions_skill_created_idx ON "${q}"."skill_revisions" (skill_id, created_at DESC)` },
    // DB-level immutability: any UPDATE or DELETE of a revision row raises.
    // The active-revision POINTER lives on skills.active_revision_id — the
    // only mutable element — so re-pointing never touches a revision row.
    // Mirrors fn_representation_append_only / fn_run_context_selections_append_only.
    { text: `CREATE OR REPLACE FUNCTION "${q}"."fn_skill_revisions_append_only"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'skill_revisions is append-only: % forbidden — record a NEW revision instead', TG_OP;
END;
$body$` },
    { text: `DROP TRIGGER IF EXISTS trg_skill_revisions_append_only ON "${q}"."skill_revisions"` },
    { text: `CREATE TRIGGER trg_skill_revisions_append_only BEFORE UPDATE OR DELETE ON "${q}"."skill_revisions" FOR EACH ROW EXECUTE FUNCTION "${q}"."fn_skill_revisions_append_only"()` },

    // ---- skill_lifecycle_audit: one row per state->state transition ----
    // `skill_id` carries NO FK (durable across skill deletion — the
    // audit_events / extension_lifecycle_audit precedent). Audit rows record
    // TRANSITIONS between states, so `from_state` is the (real) prior state; a
    // skill's INITIAL activation (NULL -> active) is provenance carried by its
    // first `skill_revisions` row, NOT an audit row. `from_state` stays nullable
    // for forward-compatibility only.
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."skill_lifecycle_audit" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      skill_id text NOT NULL,
      from_state text,
      to_state text NOT NULL,
      actor_user_id text,
      actor_type text,
      reason text,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )` },
    { text: `CREATE INDEX IF NOT EXISTS skill_lifecycle_audit_skill_created_idx ON "${q}"."skill_lifecycle_audit" (skill_id, created_at DESC)` },
  ];
}
