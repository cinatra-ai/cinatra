// core__0068 — assistant-thread CANONICAL BINDING columns (cinatra#1875, Epic
// #1873 W2, AC#4). The operator-upgrade twin of the fresh-install bootstrap DDL
// (the two ADD COLUMN clauses in `assistant-thread-schema.ts`). A structured
// assistant thread gains its canonical binding `{assistantPackage, instanceId?}`
// — WHICH registered assistant package drives the thread, and (optionally) the
// project/site instance the binding is scoped to. The binding is READ/WRITTEN at
// the same thread seam the W1 registry reader supports (package-keyed audience),
// and is SEEDED by the W3 route (this wave lands the persistence + store seam
// only).
//
// SEQ IS PROVISIONAL + FLAGGED. Shipped max on origin/main at cut time is
// core__0065 (assistant-registry-foundation, #1915). Two sibling migrations are
// in flight AHEAD of this one: #1935 holds core__0066 (legacy-bridge deletion)
// and test-delivery #1946 holds core__0067. This slice therefore claims the next
// GENUINELY-free sequence, core__0068. If a further concurrent sibling claims
// 0068 first, renumber-at-merge is normal (a rename-only change, zero SQL diff).
// migrations/** is HIGH-RISK: owner approval is required and the lane never
// merges — W2 routes as ONE unit once AC2 lands.
//
// ADDITIVE + IDEMPOTENT + NON-DESTRUCTIVE. Two nullable columns on the existing
// `assistant_threads` table, both `ADD COLUMN IF NOT EXISTS` so a second run (or
// a fresh-bootstrap DB where the leaf already built the shape and this migration
// is ledger-faked) is a no-op. NULL == an unbound thread (the historical
// implicit-@cinatra default), so every pre-existing row is undisturbed.
//
// TRANSACTION. Both statements in node-pg-migrate's default single transaction
// (all-or-nothing). Unqualified names resolve to the app schema on the runner's
// search_path.
//
// DOWN. Reversible (additive): drops the two columns. Any binding data is lost by
// design (a structural addition, not a rename).

export const ASSISTANT_THREADS_TABLE = "assistant_threads";

const escId = (s) => s.replaceAll('"', '""');

/** The two nullable binding columns on assistant_threads. */
export function buildAssistantThreadBindingSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return [
    // assistant_package — the canonical registered assistant PACKAGE that drives
    // the thread (e.g. `@cinatra-ai/wordpress-assistant`). Package-keyed so the
    // W1 registry reader's audience gate resolves the binding directly. NULL == an
    // unbound thread (implicit-@cinatra, backward compatible).
    `ALTER TABLE ${t(ASSISTANT_THREADS_TABLE)} ADD COLUMN IF NOT EXISTS assistant_package text`,
    // instance_id — the OPTIONAL project/site instance the binding is scoped to
    // (the value carried into dispatch context for an instance-bound thread). NULL
    // when the binding is not instance-scoped.
    `ALTER TABLE ${t(ASSISTANT_THREADS_TABLE)} ADD COLUMN IF NOT EXISTS instance_id text`,
  ];
}

/** The ordered up SQL. */
export function buildUpSql(schema) {
  return [...buildAssistantThreadBindingSql(schema)];
}

/** The reversible down SQL: drop the two added columns. */
export function buildDownSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return [
    `ALTER TABLE ${t(ASSISTANT_THREADS_TABLE)} DROP COLUMN IF EXISTS instance_id`,
    `ALTER TABLE ${t(ASSISTANT_THREADS_TABLE)} DROP COLUMN IF EXISTS assistant_package`,
  ];
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  for (const sql of buildUpSql()) pgm.sql(`${sql};`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  for (const sql of buildDownSql()) pgm.sql(`${sql};`);
}
