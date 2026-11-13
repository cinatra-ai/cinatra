// core__0127 — the Regenerate step provenance (cinatra#4264, slice B1a).
// Operator-upgrade twin of the fresh-install bootstrap DDL
// (`artifactMaterializationLedgerSchemaQueries` and
// `agentRunStepSnapshotSchemaQueries` in src/lib/artifact-claim-schema.ts, and
// the B1a lines of `lifecycleRepairSchemaQueries` in
// src/lib/artifacts/artifact-review-gate-schema.ts), shipped in the SAME change.
//
// WHAT. A Regenerate of a reviewed revision reruns the one step that produced
// it. This records the three facts that rerun needs:
//   - `artifact_materializations.verified_step_id`: the runtime's signed id of
//     the ApiNode that filed the revision, written only when it equals the
//     claim's `node_id` (else NULL). An index on
//     (org_id, artifact_id, representation_revision_id) for the
//     `materialize_tool` rows answers "which node filed THIS revision".
//   - `agent_run_step_snapshots`: per run and node, the node's FULL resolved
//     input as the runtime serialized it (`inputs_json`, stored verbatim, never
//     re-serialized), its sha256 and the sha256 of the flow version that ran.
//     A row lives exactly as long as its run (ON DELETE CASCADE), so a run
//     purge (the template purge included) removes its snapshots.
//   - `lifecycle_repair.regenerate_node_id` (the Regenerate intent; NULL = an
//     ordinary repair, as every existing row reads), `source_artifact_id` and
//     `source_representation_revision_id` (the source target a segment repair
//     names; written by a later slice). An index on the successor pair lets the
//     provenance reader walk a refiled successor back to its base.
//
// NO BACKFILL AND NO STORED VALUE CHANGES. Every new column is nullable and
// reads NULL on every existing row; the table is new. A revision filed before
// this migration has no verified step and no snapshot, so a Regenerate of it is
// refused with a plain reason; nothing is invented for it.
//
// LOCKS. `up` runs OUTSIDE a transaction (`pgm.noTransaction()`), one statement
// at a time, so no lock outlives its own statement. The column adds are
// catalog-only (nullable, no default: no rewrite, no scan). The two indexes are
// built CONCURRENTLY, so reads and writes of both tables go on while they
// build; CONCURRENTLY is why `up` cannot run in a transaction. The new table's
// foreign key takes a short SHARE ROW EXCLUSIVE lock on agent_runs.
//
// LOCK WAIT. As core__0126: `up` sets lock_timeout = REGENERATE_LOCK_TIMEOUT_MS
// on its session first and resets it last, so a statement that waits behind a
// long reader fails (55P03) instead of queueing the application behind it. The
// migration then stops with no ledger row, and the next run replays it.
//
// A FAILED CONCURRENT BUILD. A CREATE INDEX CONCURRENTLY that fails (a lock
// wait past the timeout, a crash) leaves an INVALID index of its name, which
// `IF NOT EXISTS` would then keep for ever. Before each build, a guarded
// statement drops an index of that name in the current schema when, and only
// when, pg_index marks it not valid; a valid index is never touched.
//
// IDEMPOTENT. ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, CREATE
// INDEX CONCURRENTLY IF NOT EXISTS after the invalid-index guard: a replay on a
// database already at the target shape changes nothing.
//
// DOWN IS DATA-DESTRUCTIVE. It drops the snapshot table, both indexes and the
// four columns. Once B1 rows exist that loses every step snapshot, every
// verified filing step and every recorded Regenerate intent; the revisions
// they described are refused Regenerate afterwards. Run it only when that loss
// is intended.
//
// Unqualified names ride the runner's search_path (the app schema), matching
// every sibling module in this chain.

/** The longest wait for any lock `up` takes (LOCK WAIT above), in ms. */
export const REGENERATE_LOCK_TIMEOUT_MS = 5_000;

export const LEDGER_REVISION_INDEX = "artifact_materializations_org_artifact_rev_idx";
export const REPAIR_SUCCESSOR_INDEX = "lifecycle_repair_successor_idx";

/** Drop an index of this name in the current schema only while it is INVALID. */
const dropInvalidIndex = (name) => `DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = '${name}'
       AND n.nspname = current_schema()
       AND NOT i.indisvalid
  ) THEN
    EXECUTE format('DROP INDEX %I.%I', current_schema(), '${name}');
  END IF;
END $$`;

/** One statement per entry, in order; `up` runs them as they stand. */
export const regenerateProvenanceDdlStatements = [
  `ALTER TABLE artifact_materializations ADD COLUMN IF NOT EXISTS verified_step_id text`,
  dropInvalidIndex(LEDGER_REVISION_INDEX),
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${LEDGER_REVISION_INDEX} ON artifact_materializations (org_id, artifact_id, representation_revision_id) WHERE path = 'materialize_tool'`,
  `CREATE TABLE IF NOT EXISTS agent_run_step_snapshots (org_id text NOT NULL, run_id text NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, node_id text NOT NULL, inputs_json text NOT NULL, inputs_sha256 text NOT NULL, flow_sha256 text NOT NULL, ambiguous boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_id, node_id))`,
  `ALTER TABLE lifecycle_repair ADD COLUMN IF NOT EXISTS regenerate_node_id text`,
  `ALTER TABLE lifecycle_repair ADD COLUMN IF NOT EXISTS source_artifact_id text`,
  `ALTER TABLE lifecycle_repair ADD COLUMN IF NOT EXISTS source_representation_revision_id text`,
  dropInvalidIndex(REPAIR_SUCCESSOR_INDEX),
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${REPAIR_SUCCESSOR_INDEX} ON lifecycle_repair (successor_artifact_id, successor_representation_revision_id)`,
];

/** DATA-DESTRUCTIVE (see DOWN above): the table, both indexes, the four columns. */
export const regenerateProvenanceDownStatements = [
  `DROP INDEX IF EXISTS ${REPAIR_SUCCESSOR_INDEX}`,
  `ALTER TABLE lifecycle_repair DROP COLUMN IF EXISTS source_representation_revision_id, DROP COLUMN IF EXISTS source_artifact_id, DROP COLUMN IF EXISTS regenerate_node_id`,
  `DROP TABLE IF EXISTS agent_run_step_snapshots`,
  `DROP INDEX IF EXISTS ${LEDGER_REVISION_INDEX}`,
  `ALTER TABLE artifact_materializations DROP COLUMN IF EXISTS verified_step_id`,
];

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql" | "noTransaction">} pgm */
export function up(pgm) {
  // One autocommit statement each (LOCKS above): CREATE INDEX CONCURRENTLY
  // cannot run inside a transaction block.
  pgm.noTransaction();
  pgm.sql(`SET lock_timeout = ${REGENERATE_LOCK_TIMEOUT_MS}`);
  for (const statement of regenerateProvenanceDdlStatements) pgm.sql(statement);
  pgm.sql("RESET lock_timeout");
}

/** @param {Pick<import("node-pg-migrate").MigrationBuilder, "sql">} pgm */
export function down(pgm) {
  for (const statement of regenerateProvenanceDownStatements) pgm.sql(statement);
}
