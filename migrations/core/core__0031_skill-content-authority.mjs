// core__0031 — skill content authority + rollback (cinatra#1362, epic #1358 A2).
//
// Builds ON the A1 lifecycle foundation (core__0029): the append-only
// `skill_revisions` history + the single mutable `skills.active_revision_id`
// pointer. A1 recorded a revision's content DIGEST but never the content itself,
// so a rollback could not restore prior content. A2 adds the AUTHORITATIVE
// content and the first-class rollback revision:
//
//   - `skill_revision_contents`: content-addressable immutable blobs keyed by
//     the sha256 digest. Two DB CHECKs make a wrong blob IMPOSSIBLE — the digest
//     equals sha256(content) and byte_length equals octet_length(content) — so a
//     revision's content_digest resolves to PROVABLY-correct content. A BEFORE
//     UPDATE OR DELETE trigger raises (content is a pure function of its digest).
//   - `skill_revisions.restores_revision_id`: the prior revision a rollback
//     restored (provenance), self-FK'd to the SAME skill's revisions and bound
//     biconditionally to source='rollback'.
//   - the `skill_revisions.source` CHECK gains 'rollback'.
//
// DESTRUCTIVE (changes a CHECK + adds a CHECK/FK over the populated
// `skill_revisions` table), so this artifact + its manifest fragment are
// REQUIRED by the schema-migration gate. The DDL below MIRRORS the idempotent
// bootstrap (buildCreateStoreSchemaQueries + skillLifecycleSchemaQueries) so the
// fresh-bootstrap and operator-upgrade paths converge; it is fully guarded, so
// it is a no-op on a schema the bootstrap already evolved.
//
// The migration-SPECIFIC work is the BACKFILL: seed a content blob from every
// custom/personal skill's CURRENT content so every TRUTHFUL active head (one
// whose recorded digest matches its content) resolves to durable authoritative
// content. A head whose recorded digest does NOT match its content is a
// pre-existing history/content inconsistency A2 does not silently rewrite — it
// resolves on the skill's next content write and fails CLOSED at rollback until
// then (never restores content whose digest can't be verified). Unqualified
// names ride the runner's search_path (the app schema).

// The custom/personal predicate — the SQL mirror of @cinatra-ai/skills
// `isCustomOrPersonalSkillPayload` (identical to core__0029's).
const CUSTOM_PREDICATE = `(
  (payload::jsonb ->> 'packageId') LIKE 'custom:%'
  OR (payload::jsonb ->> 'isCustomSkill')::boolean IS TRUE
  OR (payload::jsonb ->> 'isPersonal')::boolean IS TRUE
)`;

/** Idempotent DDL mirroring the bootstrap — safe to run after it. */
export const contentAuthorityDdlSql = `
  CREATE TABLE IF NOT EXISTS skill_revision_contents (
    content_digest text PRIMARY KEY,
    content text NOT NULL,
    byte_length integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT skill_revision_contents_digest_check CHECK (content_digest = encode(sha256(convert_to(content, 'UTF8')), 'hex')),
    CONSTRAINT skill_revision_contents_length_check CHECK (byte_length = octet_length(content))
  );

  CREATE OR REPLACE FUNCTION fn_skill_revision_contents_append_only() RETURNS trigger LANGUAGE plpgsql AS $body$
  BEGIN
    RAISE EXCEPTION 'skill_revision_contents is append-only: % forbidden — content is immutable per digest', TG_OP;
  END;
  $body$;
  DROP TRIGGER IF EXISTS trg_skill_revision_contents_append_only ON skill_revision_contents;
  CREATE TRIGGER trg_skill_revision_contents_append_only BEFORE UPDATE OR DELETE ON skill_revision_contents FOR EACH ROW EXECUTE FUNCTION fn_skill_revision_contents_append_only();

  ALTER TABLE skill_revisions ADD COLUMN IF NOT EXISTS restores_revision_id text;

  -- Widen the source CHECK to add 'rollback'. A CHECK's IN-list can't be changed
  -- by the guarded add-if-absent pattern (the name already exists), so DROP+ADD
  -- in a DO block — atomic (no window where source is unconstrained).
  DO $$
  BEGIN
    ALTER TABLE skill_revisions DROP CONSTRAINT IF EXISTS skill_revisions_source_check;
    ALTER TABLE skill_revisions ADD CONSTRAINT skill_revisions_source_check
      CHECK (source IN ('manual','autosave','hitl','chat-capture','migration','rollback'));
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = current_schema() AND table_name = 'skill_revisions' AND constraint_name = 'skill_revisions_rollback_provenance_check') THEN
      ALTER TABLE skill_revisions ADD CONSTRAINT skill_revisions_rollback_provenance_check
        CHECK ((source = 'rollback') = (restores_revision_id IS NOT NULL));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = current_schema() AND table_name = 'skill_revisions' AND constraint_name = 'skill_revisions_restores_fk') THEN
      ALTER TABLE skill_revisions ADD CONSTRAINT skill_revisions_restores_fk
        FOREIGN KEY (restores_revision_id, skill_id) REFERENCES skill_revisions(id, skill_id);
    END IF;
  END $$;
`;

// ---- Backfill (content-authority seed — idempotent) ----

/** (1) Seed a content blob from every custom/personal skill's CURRENT content.
 * Keyed by sha256(content); the table CHECKs guarantee integrity. DISTINCT on
 * the content avoids intra-statement duplicate keys; ON CONFLICT dedups across
 * re-runs and identical content. A well-formed head's recorded digest equals
 * sha256(content), so this is exactly the blob that head resolves to. */
export const backfillSeedBlobsSql = `INSERT INTO skill_revision_contents (content_digest, content, byte_length)
   SELECT encode(sha256(convert_to(c, 'UTF8')), 'hex'), c, octet_length(c)
     FROM (
       SELECT DISTINCT (payload::jsonb ->> 'content') AS c
         FROM skills
        WHERE (payload::jsonb ->> 'content') IS NOT NULL
          AND ${CUSTOM_PREDICATE}
     ) t
   ON CONFLICT (content_digest) DO NOTHING`;

/** (2) Fail-closed postcondition: PROVE the seed populated a blob for every
 * TRUTHFUL custom/personal head (active revision whose recorded digest matches
 * its content). This can only fail if (1)'s SQL is wrong — a fail-closed guard
 * on the operator's real DB. Anomalous heads (recorded digest != content) are
 * intentionally NOT required to resolve (documented above); they are excluded. */
export const assertTruthfulHeadsResolveSql = `DO $$
DECLARE unresolved integer;
BEGIN
  SELECT count(*) INTO unresolved
    FROM skills s
   WHERE ${CUSTOM_PREDICATE.replaceAll("payload", "s.payload")}
     AND (s.payload::jsonb ->> 'content') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM skill_revisions r
        WHERE r.id = s.active_revision_id AND r.skill_id = s.id
          AND r.content_digest = encode(sha256(convert_to(s.payload::jsonb ->> 'content', 'UTF8')), 'hex')
     )
     AND NOT EXISTS (
       SELECT 1 FROM skill_revision_contents c
        WHERE c.content_digest = encode(sha256(convert_to(s.payload::jsonb ->> 'content', 'UTF8')), 'hex')
     );
  IF unresolved > 0 THEN
    RAISE EXCEPTION 'core__0031 content-authority backfill incomplete: % truthful custom/personal head(s) lack a content blob', unresolved;
  END IF;
END $$`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(contentAuthorityDdlSql);
  pgm.sql(backfillSeedBlobsSql);
  pgm.sql(assertTruthfulHeadsResolveSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible w.r.t. the A2 SCHEMA additions on any lineage that has not
  // RECORDED a rollback revision. A rollback revision is immutable history the
  // append-only trigger forbids deleting, and it is only valid under the widened
  // source CHECK — so narrowing the CHECK back would fail on it. Guard FIRST,
  // before any DDL, and fail loudly: down() after the feature has been exercised
  // is intentionally unsupported (a forward fix-migration is the path).
  pgm.sql(`DO $$
  DECLARE rollbacks integer;
  BEGIN
    SELECT count(*) INTO rollbacks FROM skill_revisions WHERE source = 'rollback';
    IF rollbacks > 0 THEN
      RAISE EXCEPTION 'core__0031 down() unsupported: % rollback revision(s) exist (immutable history invalid under the narrowed source CHECK)', rollbacks;
    END IF;
  END $$;`);
  // Drop the A2 constraints/column first, then narrow the source CHECK back to
  // the A1 five-value set, then drop the content table + its trigger/function.
  pgm.sql(`
    ALTER TABLE skill_revisions DROP CONSTRAINT IF EXISTS skill_revisions_restores_fk;
    ALTER TABLE skill_revisions DROP CONSTRAINT IF EXISTS skill_revisions_rollback_provenance_check;
    ALTER TABLE skill_revisions DROP CONSTRAINT IF EXISTS skill_revisions_source_check;
    ALTER TABLE skill_revisions ADD CONSTRAINT skill_revisions_source_check
      CHECK (source IN ('manual','autosave','hitl','chat-capture','migration'));
    ALTER TABLE skill_revisions DROP COLUMN IF EXISTS restores_revision_id;
    DROP TRIGGER IF EXISTS trg_skill_revision_contents_append_only ON skill_revision_contents;
    DROP FUNCTION IF EXISTS fn_skill_revision_contents_append_only();
    DROP TABLE IF EXISTS skill_revision_contents;
  `);
}
