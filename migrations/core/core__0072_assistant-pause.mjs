// core__0072 — installation-wide assistant PAUSE table (cinatra#1880, Epic #1873
// W5). The operator-upgrade twin of the fresh-install bootstrap DDL
// (`assistantPauseSchemaQueries` in src/lib/assistant-registry-schema.ts, spread into
// `buildCreateStoreSchemaQueries`). ONE brand-new table `assistant_pause`, keyed
// by the assistant PRINCIPAL (`assistant_user_id` PK) — the SAME axis the W2
// builtin-host fix (f9f70d26a) keys on, so a handle/alias rename never loses or
// retargets a pause. Presence of a row == the assistant is paused; a paused
// principal drops out of the audience-filtered registry reader, so pause is
// enforced fail-closed across every W2 surface through the ONE audience truth.
//
// SEQ RECONCILED. Cut against core__0068 (assistant-thread-binding, #1875 W2) as
// provisional 0069; a sibling W3 lane (assistant-thread-title-slug) landed
// core__0069 on origin/main first, moving this slice to 0070. Then core__0071
// (unbound-output-derivation-outbox, #1893) shipped on origin/main (PR #1989),
// making 0071 the max shipped seq — a new migration's seq must be strictly
// greater than it, so 0070 no longer qualified and this slice was renumbered to
// the next genuinely-free sequence, core__0072 (a rename-only change, zero SQL
// diff — the additive CREATE TABLE is seq-agnostic). migrations/** is HIGH-RISK:
// owner approval is required and the lane never merges.
//
// ADDITIVE + IDEMPOTENT + NON-DESTRUCTIVE. A brand-new table (CREATE TABLE IF NOT
// EXISTS), so a second run — or a fresh-bootstrap DB where the leaf already built
// the shape and this migration is ledger-faked — is a no-op, and no pre-existing
// row is touched (an empty table == "nothing paused"). destructive=false.
//
// TRANSACTION. Single statement in node-pg-migrate's default transaction.
// Unqualified names resolve to the app schema on the runner's search_path.
//
// DOWN. Reversible (additive): drops the table. Any pause rows are lost by design
// (a structural addition, not a rename).

export const ASSISTANT_PAUSE_TABLE = "assistant_pause";

const escId = (s) => s.replaceAll('"', '""');

/** The brand-new assistant_pause table. */
export function buildAssistantPauseSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return [
    `CREATE TABLE IF NOT EXISTS ${t(ASSISTANT_PAUSE_TABLE)} (
      assistant_user_id text PRIMARY KEY,
      paused_at timestamptz NOT NULL DEFAULT now(),
      paused_by text
    )`,
  ];
}

/** The ordered up SQL. */
export function buildUpSql(schema) {
  return [...buildAssistantPauseSql(schema)];
}

/** The reversible down SQL: drop the added table. */
export function buildDownSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return [`DROP TABLE IF EXISTS ${t(ASSISTANT_PAUSE_TABLE)}`];
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  for (const sql of buildUpSql()) pgm.sql(`${sql};`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  for (const sql of buildDownSql()) pgm.sql(`${sql};`);
}
