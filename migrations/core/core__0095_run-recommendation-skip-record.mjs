// core__0095 — the RUN-LEVEL recommendation-skip record (cinatra#2794 S9b).
//
// ONE brand-new table, `run_recommendation_skips`, that gives a skipped run's
// decision a record keyed by the RUN rather than by a skill.
//
// THE DEFECT. A skip is a decision about the run, and the §V card settles only
// when that decision is on record. The record lived in
// `run_rejected_recommendations`, which is keyed (run_id, skill_id) — so a skip
// that named no skill (drift retired every offered candidate while the run sat
// parked, or the template read back with no package name) had no row to occupy.
// The stop-gap was a RESERVED skill id, `__run_level_skip__`, written into that
// table as though it were a skill.
//
// WHY THE STOP-GAP COULD NOT STAY. Skill ids are caller-provided text
// (`createOrUpdateSkill` takes `input.skillId` verbatim in
// packages/skills/src/skills-store.ts) and NO constraint excludes the reserved
// value, so a real skill can carry that id. One collision produces two
// failures: the efficacy reader filtered the id out, silently dropping a
// genuine rejected skill from the accepted/rejected split, and a genuine
// rejection could be misread as a run-level marker. A marker that is only safe
// while nobody types a particular string is not a marker. Hence a real table.
//
// SHAPE. One row per run — `run_id` is the PRIMARY KEY, so the write is
// naturally idempotent and a retried skip (a lost response, a double-click)
// converges on the same row instead of duplicating. `skipped_by` names the
// principal whose decision it was; the skip path is already fail-closed on
// `run.runBy === userId`, so it is always known at write time. `candidate_count`
// carries the fact the sentinel row destroyed: how many per-skill efficacy rows
// accompanied this skip — 0 means the scorer returned nothing to name, n means
// n candidates were offered and recorded — so the efficacy split can tell those
// apart WITHOUT inventing a rejected skill.
//
// NO FOREIGN KEY, deliberately, on the sibling precedent: both members of this
// family — run_selected_skill_revisions (the accepted half, core__0079) and
// run_rejected_recommendations (the rejected half, core__0081) — carry a bare
// `run_id text NOT NULL`, and this record is read beside them by the same
// efficacy path. There is a behavioural reason too: a failed marker write now
// REFUSES the skip and leaves the park live, so an FK would turn a benign race
// (the run row deleted concurrently) into a user-visible refusal on a decision
// that is otherwise fine.
//
// ADDITIVE (one brand-new empty table + one index; migrations/README.md
// "Additive") — no artifact is REQUIRED. Shipped anyway (the core__0067 / 0072 /
// 0093 precedent) so the fresh-install and operator-upgrade paths stay aligned:
// an already-running instance never re-runs the bootstrap DDL, so without this
// module the table would exist on fresh installs only, and on an upgraded
// instance EVERY skip would fail its marker write and refuse — the hold would
// become undecidable. The DDL MIRRORS the idempotent bootstrap leaf
// (runRecommendationSkipsSchemaQueries in
// src/lib/artifacts/artifact-review-gate-schema.ts, spread into
// buildCreateStoreSchemaQueries in the SAME PR) — a no-op on a bootstrap-seeded
// schema, ledger-faked on a fresh install, executed by `db migrate` on an
// existing deployment. Unqualified names ride the runner's search_path (the app
// schema); metadata-only DDL on an empty table, no noTransaction().
//
// NO BACKFILL, and that is a decision rather than an omission. Runs skipped
// before this migration carry their evidence as `user_skipped` rows in
// run_rejected_recommendations; `hasRunRecommendationSkip` therefore reads the
// run-level record OR that legacy evidence, so an already-skipped run's card
// keeps settling. Backfilling would have to invent a `skipped_by` the old rows
// never recorded.
//
// SEQ 0095 — strictly greater than the max shipped seq on origin/main
// (core__0094 recommendation-hold-notification-state). RENUMBERED FROM 0094 AT
// THE FORWARD-MERGE: the concurrent lane cinatra#2875 claimed core__0094 first,
// which this note anticipated, so the rename-only renumber is the normal move.
// The two migrations touch different tables, so nothing reorders. migrations/** is HIGH-RISK: owner
// approval required; the lane never merges.
//
// DOWN. Reversible in shape: a fresh addition, so dropping it restores the exact
// pre-0095 shape on any lineage (the index rides the table drop). HONEST COST:
// run-level skip markers are lost, which returns those runs to reading their
// skip from the legacy `user_skipped` rejected rows — and a skip that named NO
// candidate has no such row, so its card reverts to the unsettled state this
// change removes. An operator-initiated `--down` accepts that.

/** Idempotent DDL mirroring the bootstrap leaf — safe to run after it. */
export const runRecommendationSkipsDdlSql = `
  CREATE TABLE IF NOT EXISTS run_recommendation_skips (
    run_id          text PRIMARY KEY,
    skipped_by      text NOT NULL,
    candidate_count integer NOT NULL DEFAULT 0,
    skipped_at      timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS run_recommendation_skips_skipped_at_idx
    ON run_recommendation_skips (skipped_at DESC);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(runRecommendationSkipsDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: a fresh addition (the index rides the table drop). HONEST COST:
  // run-level skip markers are lost, so a skip that named no candidate loses its
  // only evidence and its card reverts to unsettled — an operator-initiated
  // `--down` accepts that.
  pgm.sql(`DROP TABLE IF EXISTS run_recommendation_skips;`);
}
