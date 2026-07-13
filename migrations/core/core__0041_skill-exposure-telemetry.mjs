// core__0041 — skill exposure telemetry + deprecation-candidate flag
// (cinatra#1368, epic #1358 — S10 efficacy loop).
//
// Additive, ledger-recorded so the operator-upgrade path stays aligned with the
// idempotent bootstrap (buildCreateStoreSchemaQueries in src/lib/drizzle-store.ts),
// which this DDL MIRRORS. On a bootstrap-seeded schema every statement is a
// no-op; on an operator upgrade it applies the pending additions.
//
// Two exposure-telemetry columns on the per-run usage ledger
// (`agent_run_skills_used`):
//   - `delivery_mode` (text, NULL default) — HOW the skill reached the model on
//     the LLM step that resolved it: 'openai_shell' | 'gemini_inline' |
//     'anthropic_container' | 'personal_inline'. NULL = the sessionless
//     run-start snapshot row, whose mode is not yet known (it resolves at the
//     per-step llm-bridge boundary).
//   - `invocation_attributable` (boolean, NULL default) — whether the delivery
//     mode can attribute a per-skill invocation. Only 'openai_shell' (a named
//     `/skills/<slug>` read) is attributable today; the inline/container modes
//     are not. A skill exposed only via NULL / non-attributable rows can never
//     become a deprecation candidate.
// Plus a plain (non-unique) `skill_id` index serving the per-skill
// exposure/invocation rollup (readSkillExposureAggregates).
//
// One column on `skills`:
//   - `deprecation_candidate_dismissed_at` (timestamptz, NULL) — the human
//     "reviewed — keep it" decision that clears an exposed-but-never-invoked
//     skill from the candidate list without deprecating it (the positive
//     decision remains the existing lifecycle transition to 'deprecated').
//
// Gate class NON-destructive (additive): nullable columns + a non-unique index
// on existing tables — no NOT NULL, no unique index, no constraint, no data
// rewrite (schema-migration-gate.mjs additive carve-out). Shipped as the
// optional artifact the convention allows alongside additive changes
// (migrations/README.md), keeping the ledger + upgrade proof complete.
// Unqualified names ride the runner's search_path (the app schema); no
// noTransaction() (guarded, metadata-only DDL).

/** Idempotent DDL mirroring the bootstrap — safe to run after it. */
export const skillExposureTelemetryDdlSql = `
  ALTER TABLE agent_run_skills_used ADD COLUMN IF NOT EXISTS delivery_mode text;
  ALTER TABLE agent_run_skills_used ADD COLUMN IF NOT EXISTS invocation_attributable boolean;
  CREATE INDEX IF NOT EXISTS agent_run_skills_used_skill_id_idx ON agent_run_skills_used (skill_id);
  ALTER TABLE skills ADD COLUMN IF NOT EXISTS deprecation_candidate_dismissed_at timestamptz;
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(skillExposureTelemetryDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible in shape. HONEST COST: any exposure telemetry written after up()
  // (delivery_mode / invocation_attributable) and any dismissal decision is lost
  // on --down; the invocation_count already-shipped column is untouched.
  pgm.sql(`
    DROP INDEX IF EXISTS agent_run_skills_used_skill_id_idx;
    ALTER TABLE agent_run_skills_used
      DROP COLUMN IF EXISTS delivery_mode,
      DROP COLUMN IF EXISTS invocation_attributable;
    ALTER TABLE skills
      DROP COLUMN IF EXISTS deprecation_candidate_dismissed_at;
  `);
}
