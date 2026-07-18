// core__0056 — one-time transactional purge of retired-type object rows
// (owner ruling 2026-07-18; epic cinatra#1785; closes #1792).
//
// WHY. The type model is now the dependency model: an object type exists ONLY as
// an explicit definition by an installed artifact extension. The owner ruled NO
// backward compatibility and NO migration-in-place: every row carrying a RETIRED
// type string is deleted outright, together with everything that references it,
// so nothing dangles. The write path already fail-closes (no new retired-type
// row can appear — packages/objects/src/mcp/handlers.ts), and the dynamic
// namespaces are permanently tombstoned (#1789), so this purge runs on a
// substrate that produces no new matches.
//
// RETIRED TYPE STRINGS (see RETIRED_TYPE_PREDICATE_PARTS):
//   - `@cinatra-ai/objects:object` — the generic floor / lossless-fallback type,
//     "dead in every form" per the ruling (its re-point to a Default Artifact
//     claim is retired by the sibling Default Artifact wave; the ROWS go here).
//   - the two permanently-tombstoned dynamic namespaces `@dynamic/types:*` and
//     `@cinatra-ai/dynamic:*` (the auto-derived / classifier-minted umbrella
//     rows). Matched PREFIX-EXACT, mirroring
//     `isTombstonedObjectTypeId` (packages/objects/src/namespace.ts).
//
// SCOPE NOTE — the per-package `@cinatra-ai/<pkg>:artifact` descriptor umbrellas
// are DELIBERATELY NOT purged here: the explicit-definition rewrite wave (epic
// #1785 code-consequences map §3) preserves those identifiers as EXPLICIT type
// definitions with NO row migration, so their rows live on under a now-defined
// type and are NOT retired. Only `@cinatra-ai/objects:object` and the tombstoned
// dynamic namespaces are unambiguously dead. (If the owner later rules specific
// umbrella strings retired, extend RETIRED_TYPE_PREDICATE_PARTS in a follow-up
// migration.)
//
// CASCADE ("nothing dangles"). Every table that references an object row by
// `object_id` (snapshots, proposals/merge, projection/outbox + reconcile queue,
// promotion requests, binding quarantine), the object_change_event history +
// its remote_effect_attempts, and the change_sets that touched ONLY retired
// objects (orphan-sweep — a change_set that also touched a LIVING object keeps
// its living events and is NOT dropped). Run records themselves stay; their
// object outputs are simply gone.
//
// TRANSACTION. Metadata-light DELETEs + two ON COMMIT DROP temp tables: runs in
// node-pg-migrate's default single transaction (all-or-nothing) — no
// noTransaction(). Unqualified names resolve to the app schema on search_path.
//
// IDEMPOTENT / LINEAGE-TOLERANT. Every statement is a DELETE whose predicate
// matches nothing on a second run (the rows are already gone) or on a fresh
// schema (no retired rows were ever written) — a no-op, so re-running or the
// bootstrap-produced fresh shape does nothing.
//
// DOWN. Irreversible by design (0033/0048 precedent): the deleted rows are not
// retained; a coherent rollback restores from a backup, not this migration.

/**
 * The retired-type-string SQL predicate parts, evaluated against `objects.type`.
 * Kept as data so the test can assert the exact retired set and a follow-up can
 * extend it. The generic floor is matched exactly; the two tombstoned dynamic
 * namespaces are matched prefix-exact (LIKE `<prefix>%`).
 */
export const RETIRED_TYPE_PREDICATE_PARTS = [
  `type = '@cinatra-ai/objects:object'`,
  `type LIKE '@dynamic/types:%'`,
  `type LIKE '@cinatra-ai/dynamic:%'`,
];

/** Build the `objects.type` retired-string predicate (parenthesized OR). */
export function retiredTypePredicate() {
  return `(${RETIRED_TYPE_PREDICATE_PARTS.join(" OR ")})`;
}

/** Tables that reference an object row by `object_id` and must be swept so
 *  nothing dangles. Order is irrelevant among these (all keyed to _purge_obj). */
export const OBJECT_ID_REFERENCING_TABLES = [
  "object_content_snapshots",
  "graphiti_projection_outbox",
  "merge_proposal",
  "artifact_promotion_request",
  "artifact_binding_reconcile_queue",
  "object_binding_quarantine",
];

/**
 * Build the ordered purge statements.
 *
 * @param {string} [schema] optional schema to qualify identifiers (integration
 *   path); when omitted, names are unqualified and resolve via search_path
 *   (the runner sets it to the app schema — what keeps worktree/branch schemas
 *   working).
 * @returns {string[]} statements in dependency-safe order (children first,
 *   `objects` last).
 */
export function buildPurgeSql(schema) {
  const t = (name) =>
    schema ? `"${schema.replaceAll('"', '""')}"."${name}"` : name;
  const pred = retiredTypePredicate();

  const stmts = [];

  // 1. Capture the retired object ids and the change_sets they touched BEFORE
  //    any delete (the change_set orphan-sweep needs the pre-delete membership).
  stmts.push(
    `CREATE TEMP TABLE _purge_obj ON COMMIT DROP AS
       SELECT id FROM ${t("objects")} WHERE ${pred}`,
  );
  stmts.push(
    `CREATE TEMP TABLE _purge_cs ON COMMIT DROP AS
       SELECT DISTINCT change_set_id AS id FROM ${t("object_change_event")}
        WHERE object_id IN (SELECT id FROM _purge_obj)`,
  );

  // 2. Sweep every table that references a retired object by object_id.
  for (const tbl of OBJECT_ID_REFERENCING_TABLES) {
    stmts.push(
      `DELETE FROM ${t(tbl)} WHERE object_id IN (SELECT id FROM _purge_obj)`,
    );
  }

  // 3. History: remote-effect attempts hang off the change events; drop them
  //    before the events they reference.
  stmts.push(
    `DELETE FROM ${t("remote_effect_attempts")} WHERE change_event_id IN (
        SELECT id FROM ${t("object_change_event")}
         WHERE object_id IN (SELECT id FROM _purge_obj))`,
  );
  stmts.push(
    `DELETE FROM ${t("object_change_event")} WHERE object_id IN (SELECT id FROM _purge_obj)`,
  );

  // 4. Orphan-sweep the change_sets that touched retired objects and now have
  //    NO remaining events (a change_set that also touched a LIVING object keeps
  //    its living events and is intentionally NOT dropped — nothing dangles).
  stmts.push(
    `DELETE FROM ${t("change_set")} c
       WHERE c.id IN (SELECT id FROM _purge_cs)
         AND NOT EXISTS (
           SELECT 1 FROM ${t("object_change_event")} e WHERE e.change_set_id = c.id)`,
  );

  // 5. Finally the object rows themselves.
  stmts.push(`DELETE FROM ${t("objects")} WHERE id IN (SELECT id FROM _purge_obj)`);

  return stmts;
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  for (const sql of buildPurgeSql()) {
    pgm.sql(`${sql};`);
  }
}

/** @param {import("node-pg-migrate").MigrationBuilder} _pgm */
export function down() {
  throw new Error(
    "core__0056 is a one-time clean-break purge of retired-type object rows " +
      "(owner ruling 2026-07-18; epic cinatra#1785; #1792): the owner ruled no backward " +
      "compatibility and the deleted rows + their references are not retained. " +
      "Roll back by restoring from a backup, not this migration alone.",
  );
}
