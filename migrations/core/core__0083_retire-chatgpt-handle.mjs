// core__0083 — retire the persisted `@chatgpt` handle (owner ruling 2026-07-21
// M2: the OpenAI assistant is @openai, never @chatgpt; M5: the local CLI is no
// longer a distinct @-mention assistant). Epic #1873 W6 — the ONE-WAY removal
// of the legacy `chatgpt` flat handle/alias from the registry tables.
//
// SEQ PROVISIONAL: assigned at MERGE. The gate requires a new seq strictly
// greater than the max SHIPPED seq; max shipped on origin/main at build time is
// core__0082 (dashboard-twin scope backfill, #1898). This module takes the
// provisional 0083 and is RENUMBERED-AT-MERGE by the coordinator if a concurrent
// lane lands an intervening seq first (rename-only, zero SQL change; the runner
// tolerates sequence gaps).
//
// WHY. `@chatgpt` was a dev-only local-CLI bridge (a hardcoded route +
// Codex-CLI producer), NOT a boot-seeded principal — the boot seeds only mint
// cinatra/wordpress/drupal handles (src/lib/auth.ts). W2 already retired the
// hardcoded routing (an `@chatgpt` mention resolves to nothing), and W6 deletes
// the bridge route/gate/fixtures in the SAME PR. The owner ruling frees the flat
// `chatgpt` token entirely: the OpenAI assistant is `@openai`, and the local-CLI
// mechanism relocates to the connector setup page as a connection-mode option
// (dev/preview only) — never a standalone `@chatgpt` handle again.
//
// TARGET SET. Any residual registry row keyed on the retired flat token:
//   * assistant_handles.handle = 'chatgpt'   — the mention-handle registration.
//   * assistant_tag_alias.alias = 'chatgpt'  — a flat-token alias sibling.
// In a code-seeded database neither row exists (nothing ever inserted a
// `chatgpt` handle/alias — only the immutable `cinatra` builtin alias is
// seeded), so this migration is a NO-OP on a clean/fresh DB. It exists to
// converge any operator DB where a `chatgpt` row was persisted at runtime
// (e.g. a manual namespace-primitive UPDATE) to the post-ruling state.
//
// IDEMPOTENT / RERUNNABLE. A DELETE keyed on the exact token matches ZERO rows
// on a second run (the row is gone). A fresh bootstrap has no `chatgpt` rows →
// no-op; the chain is ledger-faked there. Table-existence guarded (to_regclass),
// so a partial/fresh DB where a registry table is absent RETURNs early rather
// than erroring.
//
// FAIL-LOUD ON PARTIAL APPLY. node-pg-migrate wraps the queued `pgm.sql` steps
// in ONE transaction, so any statement error rolls the WHOLE migration back (no
// half-applied removal). A postcondition DO block asserts the forward invariant
// — ZERO `chatgpt` handle/alias rows remain — and RAISEs (aborting + rolling the
// transaction back; in production, aborting boot) if any survive.
//
// DOWN is IRREVERSIBLE (throws). This is a one-way retirement per the owner
// ruling: the deleted `chatgpt` handle/alias rows carried no reconstructible
// state (the flat token is retired, not renamed — there is no `@chatgpt` handle
// to restore it to), so a faithful reverse mapping does not exist. Same class as
// core__0064. Restore from a backup if a rollback is genuinely required.

/** SQL-identifier escaper for an optional schema qualifier (integration path). */
function escId(s) {
  return String(s).replaceAll('"', '""');
}

/** The retired flat local-CLI-bridge token. */
export const RETIRED_HANDLE = "chatgpt";

export const ASSISTANT_HANDLES_TABLE = "assistant_handles";
export const ASSISTANT_TAG_ALIAS_TABLE = "assistant_tag_alias";

/**
 * Build the existence-guarded one-way DELETE for one registry table + column.
 * RETURNs early (no-op) when the table is absent on a partial/fresh DB.
 *
 * @param {string} table  registry table name
 * @param {string} column the flat-token column ('handle' | 'alias')
 * @param {string} tag    the DO-block dollar-quote tag (unique per statement)
 * @param {string} [schema] optional schema qualifier (integration path); when
 *   omitted, names resolve via the runner's search_path.
 * @returns {string}
 */
function buildGuardedDeleteSql(table, column, tag, schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  const toReg = (name) =>
    schema ? `to_regclass('"${escId(schema)}"."${name}"')` : `to_regclass('${name}')`;
  return `DO $${tag}$
BEGIN
  IF ${toReg(table)} IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM ${t(table)} WHERE ${column} = '${RETIRED_HANDLE}';
END
$${tag}$`;
}

/**
 * Build the FAIL-LOUD postcondition. Asserts ZERO `chatgpt` handle/alias rows
 * remain after the deletes; RAISEs (rolling the transaction back) otherwise.
 * Each table read is existence-guarded so an absent table contributes zero.
 *
 * @param {string} [schema] optional schema qualifier (integration path).
 * @returns {string}
 */
export function buildPostconditionSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  const toReg = (name) =>
    schema ? `to_regclass('"${escId(schema)}"."${name}"')` : `to_regclass('${name}')`;
  return `DO $core0083post$
DECLARE
  remaining bigint := 0;
  n bigint;
BEGIN
  IF ${toReg(ASSISTANT_HANDLES_TABLE)} IS NOT NULL THEN
    SELECT count(*) INTO n FROM ${t(ASSISTANT_HANDLES_TABLE)} WHERE handle = '${RETIRED_HANDLE}';
    remaining := remaining + n;
  END IF;
  IF ${toReg(ASSISTANT_TAG_ALIAS_TABLE)} IS NOT NULL THEN
    SELECT count(*) INTO n FROM ${t(ASSISTANT_TAG_ALIAS_TABLE)} WHERE alias = '${RETIRED_HANDLE}';
    remaining := remaining + n;
  END IF;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'core__0083: % chatgpt handle/alias row(s) remain after the one-way retirement (expected 0). Transaction rolled back (no partial apply).', remaining;
  END IF;
END
$core0083post$`;
}

/**
 * Build the ordered statement list (the two guarded deletes, then the
 * postcondition). Exposed for the integration test to drive against a real
 * schema.
 * @param {string} [schema]
 * @returns {string[]}
 */
export function buildUpSql(schema) {
  return [
    buildGuardedDeleteSql(ASSISTANT_HANDLES_TABLE, "handle", "core0083h", schema),
    buildGuardedDeleteSql(ASSISTANT_TAG_ALIAS_TABLE, "alias", "core0083a", schema),
    buildPostconditionSql(schema),
  ];
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  for (const sql of buildUpSql()) {
    pgm.sql(`${sql};`);
  }
}

/** @param {import("node-pg-migrate").MigrationBuilder} _pgm */
export function down() {
  throw new Error(
    "core__0083 is a one-way `@chatgpt` handle retirement (owner ruling " +
      "2026-07-21 M2/M5; epic cinatra#1873 W6): the flat `chatgpt` token is " +
      "retired, not renamed — there is no `@chatgpt` handle to restore the " +
      "deleted registry rows to, so a faithful reverse mapping does not exist. " +
      "Restore from a backup if a rollback is genuinely required.",
  );
}
