// core__0059 — one-time transactional purge of the RETIRED generic Default
// Artifact floor object rows `@cinatra-ai/artifact:object`, plus a DB-level
// write guard rejecting any NEW row of that type (owner ruling 2026-07-18;
// epic cinatra#1785 wave A6; sibling of the SHIPPED core__0056).
//
// WHY. The type model is now the dependency model: an object type exists ONLY
// as an explicit definition by an installed kind:artifact extension. Wave A3
// cut the writer over — createSemanticArtifact now persists the EXACT declared
// pack/host objectType and the generic `@cinatra-ai/artifact:object`
// registration is RETIRED, so NO live path writes the generic type anymore.
// The surviving `@cinatra-ai/artifact:object` rows are LEGACY RESIDUE created
// before the A3 cutover, not the live library. The owner ruled NO backward
// compatibility and NO migration-in-place: every residual generic-floor row is
// deleted outright together with everything that references it, so nothing
// dangles.
//
// DISTINCT FROM core__0056. core__0056 purged the SEPARATE generic floor
// `@cinatra-ai/objects:object` + the two tombstoned dynamic namespaces (a
// 10-table object_id cascade). It DELIBERATELY left `@cinatra-ai/artifact:object`
// for the Default-Artifact retirement wave (this migration) because those rows
// carry the FULL artifact sub-graph (representation/resource pins, semantic
// assertions, refs, materializations, publication + uninstall lineage) keyed by
// `artifact_id` — and `artifact_id == objects.id` for an artifact object.
//
// CASCADE ("nothing dangles"). The full ~20-table map:
//   - artifact_id children (artifact_id == objects.id): artifact_audit,
//     artifact_refs, artifact_provider_cache, artifact_materializations,
//     authoring_step_artifacts, artifact_publication_operations,
//     semantic_assertion, run_context_selections, representation, and the
//     append-only artifact_uninstall_operation_assertions + their now-orphan
//     artifact_uninstall_operations parents.
//   - object_id children (the core__0056 set): object_content_snapshots,
//     graphiti_projection_outbox, merge_proposal, artifact_promotion_request,
//     artifact_binding_reconcile_queue, object_binding_quarantine.
//   - history: remote_effect_attempts (hang off the change events) → the
//     object_change_event rows → the change_sets that touched ONLY retired
//     objects (orphan-swept via NOT EXISTS; a change_set that also touched a
//     LIVING object keeps its living events and is intentionally NOT dropped).
//   - dangling parent refs: any SURVIVING object whose parent_id points at a
//     purged row has parent_id/parent_type NULLed (never deletes the survivor).
//   - the objects rows themselves, LAST.
//
// TRIGGER-AWARE. representation, run_context_selections, and
// artifact_uninstall_operation_assertions each carry an append-only
// `BEFORE UPDATE OR DELETE` guard (trg_*_append_only) that RAISEs on DELETE.
// The purge DISABLEs each named trigger (existence-guarded via pg_trigger — a
// no-op where the trigger is absent) for the duration of the transaction and
// RE-ENABLEs it at the end. DISABLE/ENABLE TRIGGER needs only table ownership
// (the migration role owns these tables); no superuser session_replication_role.
//
// BLOBS BY REACHABILITY ONLY. resource + artifact_blobs rows (and the on-disk
// bytes) are content-addressed and SHARED across artifacts — this migration
// NEVER deletes them. Deleting the representations/artifact_refs above makes a
// resource unreachable IFF no surviving artifact still references it; the
// existing reachability-guarded GC (artifact-retention.ts#runResourceBlobGc,
// gated by NOT EXISTS over surviving representation/artifact_refs) reclaims the
// resource row + blob row + disk bytes ATOMICALLY on its normal cycle. A
// blanket blob delete here would destroy bytes still pinned by a live pack-typed
// artifact and would orphan on-disk bytes the DB-only migration cannot unlink.
//
// WRITE GUARD (survives mixed-version deploy). A BEFORE INSERT OR UPDATE trigger
// on `objects` RAISEs on any attempt to write NEW.type =
// `@cinatra-ai/artifact:object`. During a rolling deploy an OLD (pre-A3) image
// could still try to write the generic type; the guard fail-closes that write
// (see the deploy-quiesce note in the PR body). Post-cutover every image writes
// exact types, so the guard is a pure backstop. Applied HERE (the boot migration
// runner reaches production); the fresh-install bootstrap mirror + the
// generic-seeding fixture sweep are the COUPLED A5-remainder follow-up.
//
// TRANSACTION. Metadata-light DELETEs + two ON COMMIT DROP temp tables + the
// trigger toggles + the guard DDL: node-pg-migrate's default single transaction
// (all-or-nothing) — no noTransaction(). Unqualified names resolve to the app
// schema on search_path (the runner sets it).
//
// IDEMPOTENT / LINEAGE-TOLERANT. Every DELETE matches nothing on a second run or
// on a fresh schema (no residual rows were ever written); the guard DDL is
// CREATE OR REPLACE + DROP TRIGGER IF EXISTS + CREATE TRIGGER.
//
// DOWN. Irreversible by design (0033/0048/0056 precedent): the deleted rows are
// not retained; roll back by restoring from a backup, not this migration.

/** The retired generic Default-Artifact floor object type. */
export const RETIRED_GENERIC_ARTIFACT_TYPE = "@cinatra-ai/artifact:object";

/** The `objects.type` retired-string predicate (exact match — the floor is a
 *  single literal type, unlike core__0056's prefix-matched dynamic namespaces). */
export function retiredTypePredicate() {
  return `type = '${RETIRED_GENERIC_ARTIFACT_TYPE}'`;
}

/** Children keyed by `artifact_id` (== objects.id for an artifact object).
 *  Revision-carrying children first, the representation pin itself last among
 *  the NON-trigger tables — ordering is cosmetic (no FKs; object lifecycle owns
 *  the graph) but kept dependency-sensible. Trigger-guarded tables are handled
 *  separately (see TRIGGER_GUARDED_DELETES). */
export const ARTIFACT_ID_REFERENCING_TABLES = [
  "artifact_audit",
  "artifact_refs",
  "artifact_provider_cache",
  "artifact_materializations",
  "authoring_step_artifacts",
  "artifact_publication_operations",
  "semantic_assertion",
];

/** Children keyed by `object_id` (the core__0056 set — same object_id join). */
export const OBJECT_ID_REFERENCING_TABLES = [
  "object_content_snapshots",
  "graphiti_projection_outbox",
  "merge_proposal",
  "artifact_promotion_request",
  "artifact_binding_reconcile_queue",
  "object_binding_quarantine",
];

/** Append-only delete-rejection triggers the purge must bypass. Each entry
 *  deletes the retired rows from an append-only table (keyed by `artifact_id`)
 *  with its named `BEFORE UPDATE OR DELETE` trigger disabled for the duration. */
export const TRIGGER_GUARDED_DELETES = [
  { table: "run_context_selections", trigger: "trg_run_context_selections_append_only", column: "artifact_id" },
  {
    table: "artifact_uninstall_operation_assertions",
    trigger: "trg_artifact_uninstall_op_assertions_append_only",
    column: "artifact_id",
  },
  { table: "representation", trigger: "trg_representation_append_only", column: "artifact_id" },
];

/** Content-addressed + shared physical-storage tables this migration NEVER
 *  deletes — reclamation is DELEGATED to the reachability-guarded GC. Exposed as
 *  data so the test can assert none of them appears in a DELETE statement. */
export const REACHABILITY_DELEGATED_TABLES = [
  "resource",
  "artifact_blobs",
  "project_resource_refs",
  "resource_project_moves",
];

const escId = (s) => s.replaceAll('"', '""');

/**
 * Build the ordered purge statements.
 *
 * @param {string} [schema] optional schema to qualify identifiers (integration
 *   path); when omitted, names are unqualified and resolve via search_path.
 * @returns {string[]} statements in dependency-safe order (children first,
 *   `objects` last), with the delete-rejection triggers toggled around the
 *   append-only deletes.
 */
export function buildPurgeSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  const reg = (name) => (schema ? `'"${escId(schema)}"."${name}"'::regclass` : `'${name}'::regclass`);
  const pred = retiredTypePredicate();
  const inObj = "(SELECT id FROM _purge_obj)";

  const toggleTrigger = (table, trigger, action) =>
    `DO $core0059$ BEGIN
       IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = ${reg(table)} AND tgname = '${trigger}') THEN
         ALTER TABLE ${t(table)} ${action} TRIGGER ${trigger};
       END IF;
     END $core0059$`;

  const stmts = [];

  // 1. Capture the retired object ids and the change_sets they touched BEFORE
  //    any delete (the change_set orphan-sweep needs pre-delete membership).
  stmts.push(
    `CREATE TEMP TABLE _purge_obj ON COMMIT DROP AS
       SELECT id FROM ${t("objects")} WHERE ${pred}`,
  );
  stmts.push(
    `CREATE TEMP TABLE _purge_cs ON COMMIT DROP AS
       SELECT DISTINCT change_set_id AS id FROM ${t("object_change_event")}
        WHERE object_id IN ${inObj}`,
  );
  // Capture the uninstall operations that had an assertion for a retired
  // artifact BEFORE those assertions are deleted — the parent orphan-sweep is
  // scoped to THESE only (a zero-assertion operation unrelated to the purge is
  // a valid live/audit row and must NOT be swept).
  stmts.push(
    `CREATE TEMP TABLE _purge_uop ON COMMIT DROP AS
       SELECT DISTINCT operation_id AS id
         FROM ${t("artifact_uninstall_operation_assertions")}
        WHERE artifact_id IN ${inObj}`,
  );

  // 2. Disable the append-only delete-rejection triggers for the transaction.
  for (const { table, trigger } of TRIGGER_GUARDED_DELETES) {
    stmts.push(toggleTrigger(table, trigger, "DISABLE"));
  }

  // 3. artifact_id children (non-trigger).
  for (const tbl of ARTIFACT_ID_REFERENCING_TABLES) {
    stmts.push(`DELETE FROM ${t(tbl)} WHERE artifact_id IN ${inObj}`);
  }

  // 4. Trigger-guarded artifact_id children (triggers disabled above).
  for (const { table, column } of TRIGGER_GUARDED_DELETES) {
    stmts.push(`DELETE FROM ${t(table)} WHERE ${column} IN ${inObj}`);
  }

  // 5. Orphan-sweep ONLY the uninstall operations touched by this purge
  //    (captured in _purge_uop) that now have NO remaining assertion — an
  //    operation that also carried an assertion for a SURVIVING artifact, and a
  //    zero-assertion operation unrelated to the purge, are both intentionally
  //    kept (they are valid live/audit rows — never blanket-sweep by count).
  stmts.push(
    `DELETE FROM ${t("artifact_uninstall_operations")} op
       WHERE op.id IN (SELECT id FROM _purge_uop)
         AND NOT EXISTS (
           SELECT 1 FROM ${t("artifact_uninstall_operation_assertions")} a
            WHERE a.operation_id = op.id)`,
  );

  // 6. object_id children (the core__0056 set).
  for (const tbl of OBJECT_ID_REFERENCING_TABLES) {
    stmts.push(`DELETE FROM ${t(tbl)} WHERE object_id IN ${inObj}`);
  }

  // 7. History: remote-effect attempts hang off the change events; drop them
  //    before the events they reference, then the events.
  stmts.push(
    `DELETE FROM ${t("remote_effect_attempts")} WHERE change_event_id IN (
        SELECT id FROM ${t("object_change_event")} WHERE object_id IN ${inObj})`,
  );
  stmts.push(`DELETE FROM ${t("object_change_event")} WHERE object_id IN ${inObj}`);

  // 8. Orphan-sweep the change_sets that touched ONLY retired objects.
  stmts.push(
    `DELETE FROM ${t("change_set")} c
       WHERE c.id IN (SELECT id FROM _purge_cs)
         AND NOT EXISTS (
           SELECT 1 FROM ${t("object_change_event")} e WHERE e.change_set_id = c.id)`,
  );

  // 9. NULL dangling parent refs on SURVIVING objects (never delete a survivor).
  stmts.push(
    `UPDATE ${t("objects")} SET parent_id = NULL, parent_type = NULL
       WHERE parent_id IN ${inObj} AND id NOT IN ${inObj}`,
  );

  // 10. Finally the retired object rows themselves.
  stmts.push(`DELETE FROM ${t("objects")} WHERE id IN ${inObj}`);

  // 11. Re-enable the delete-rejection triggers.
  for (const { table, trigger } of TRIGGER_GUARDED_DELETES) {
    stmts.push(toggleTrigger(table, trigger, "ENABLE"));
  }

  return stmts;
}

/**
 * Build the DB-level write-guard: a BEFORE INSERT OR UPDATE trigger on `objects`
 * that RAISEs on any attempt to write the retired generic floor type. Survives a
 * mixed-version deploy (an old image's generic write fail-closes).
 *
 * @param {string} [schema] optional schema to qualify identifiers.
 * @returns {string[]} idempotent DDL statements (function, drop trigger, trigger).
 */
export function buildGenericWriteGuardSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  const fn = schema ? `"${escId(schema)}"."fn_objects_reject_retired_generic_type"` : "fn_objects_reject_retired_generic_type";
  const trg = "trg_objects_reject_retired_generic_type";

  return [
    `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $core0059guard$
       BEGIN
         IF NEW.type = '${RETIRED_GENERIC_ARTIFACT_TYPE}' THEN
           RAISE EXCEPTION 'objects.type % is the RETIRED generic Default Artifact floor (@cinatra-ai/artifact:object, epic cinatra#1785): the write is refused — an object type exists ONLY as an explicit installed artifact-extension definition, never a catch-all floor', NEW.type;
         END IF;
         RETURN NEW;
       END
     $core0059guard$`,
    `DROP TRIGGER IF EXISTS ${trg} ON ${t("objects")}`,
    `CREATE TRIGGER ${trg} BEFORE INSERT OR UPDATE ON ${t("objects")} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
  ];
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  for (const sql of buildPurgeSql()) {
    pgm.sql(`${sql};`);
  }
  for (const sql of buildGenericWriteGuardSql()) {
    pgm.sql(`${sql};`);
  }
}

/** @param {import("node-pg-migrate").MigrationBuilder} _pgm */
export function down() {
  throw new Error(
    "core__0059 is a one-time clean-break purge of the retired generic Default " +
      "Artifact floor rows + a write guard (owner ruling 2026-07-18; epic cinatra#1785 " +
      "wave A6): the owner ruled no backward compatibility and the deleted rows + their " +
      "references are not retained. Roll back by restoring from a backup, not this migration.",
  );
}
