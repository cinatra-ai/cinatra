// core__0121 — the one effect record of a reviewed target (cinatra#3978).
// The operator-upgrade twin of the fresh-install bootstrap DDL
// (`artifactReviewGateSchemaQueries` in
// src/lib/artifacts/artifact-review-gate-schema.ts, in the SAME pull request;
// the core__0113 precedent).
//
// WHY. A display may say what a reviewed change did at its site only from the
// actual result of the call that carried it out, and nothing stored that
// result: the verification record holds a field verdict. ONE row per (gate,
// reviewed artifact, reviewed revision), first write wins. The record is
// compact JSON text, so the 8192-byte CHECK counts the bytes the application
// counted (a `jsonb` column re-serializes).
//
// ADDITIVE ONLY: a new table and its unique index; nothing is backfilled.
// SEQ 0121: 0113 is the highest on main at authoring time; open changes claim
// 0114 to 0120. DOWN drops the table only when it is empty (core__0113).

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const artifactReviewEffectRecordsDdlSql = `
  CREATE TABLE IF NOT EXISTS artifact_review_effect_records (
    id                                  text PRIMARY KEY,
    gate_id                             text NOT NULL
                                          REFERENCES artifact_review_gates (id) ON DELETE CASCADE,
    org_id                              text NOT NULL,
    run_id                              text NOT NULL,
    reviewed_artifact_id                text NOT NULL,
    reviewed_representation_revision_id text NOT NULL,
    writer                              text NOT NULL CHECK (writer IN ('cms_apply','dashboard_publish')),
    source_ref                          text NOT NULL CHECK (octet_length(source_ref) BETWEEN 1 AND 256),
    record_json                         text NOT NULL CHECK (
                                          octet_length(record_json) <= 8192
                                          AND jsonb_typeof(record_json::jsonb) = 'object'),
    recorded_at                         timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS artifact_review_effect_records_target_uniq
    ON artifact_review_effect_records (gate_id, reviewed_artifact_id, reviewed_representation_revision_id);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(artifactReviewEffectRecordsDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`
    DO $$
    BEGIN
      IF to_regclass('artifact_review_effect_records') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM artifact_review_effect_records) THEN
          RAISE EXCEPTION
            'core__0121 down: artifact_review_effect_records is not empty; dropping it would destroy the record of reviewed effects. Export or delete the rows deliberately first.';
        END IF;
        DROP TABLE artifact_review_effect_records;
      END IF;
    END
    $$;
  `);
}
