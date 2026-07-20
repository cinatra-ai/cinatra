// core__0060 — guarded destructive teardown of the dynamic-types ENGINE:
// DROP the `dynamic_object_types` registry table (owner ruling 2026-07-18;
// epic cinatra#1785 entry 95; closes #1793; the engine is deleted LAST).
//
// WHY. The type model is now the dependency model: an object type exists ONLY
// as an explicit definition by an installed kind:artifact extension. Every live
// type is registry-declared; the write path fail-closes with
// OBJECTS_TYPE_NOT_REGISTERED (packages/objects/src/mcp/handlers.ts — an
// unclassifiable / dynamic / tombstoned / unregistered save is REFUSED, never
// fallback-persisted); the two dynamic namespaces are permanently tombstoned
// (#1789, isTombstonedObjectTypeId); the generic floors were purged (#1792
// core__0056 + #1785-A6 core__0059). `dynamic_object_types` is now DEAD
// substrate: the auto-registrar that wrote it and every read of it are deleted
// in this same PR, so the table produces and consumes nothing. It is dropped
// outright.
//
// GUARDED ("refuses unless clean") — owner-ratified entry-95 interlock. The
// migration REFUSES (RAISEs, aborting the transaction) unless the table is
// decoupled from every live surface, so the drop can never orphan in-flight
// work. Three preconditions, each a distinct RAISE (so the operator sees which
// one blocked):
//   (a) ZERO non-retired `artifact_type_claims` reference a type still present
//       in `dynamic_object_types` (claims key by object_type_id STRING, never an
//       FK, and were NOT swept by the object-row purges — so a residual
//       non-retired claim over a dynamic type would dangle when the table is
//       dropped). Covers reserved/active/dormant/retiring (status <> 'retired').
//   (b) The binding-reconcile queue is DRAINED of UNFINISHED (pending/failed)
//       dynamic-type work. The queue's OWN `object_type_id` is a NOT-NULL
//       denormalized column populated on BOTH axes (claim-side = the winner
//       transition's type; write-side 'binding-reconcile-write' = the object's
//       type), so it is the authoritative per-row signal — robust to the
//       referenced object/claim-event row already being purged. A durable 'done'
//       row is harmless history.
//   (c) The #1792 projection purge has CONVERGED — no UNFINISHED
//       (`status <> 'done'`, which INCLUDES the transient 'processing' state)
//       `graphiti_projection_outbox` row remains for an object whose type is
//       still in `dynamic_object_types`.
//
// UNFINISHED-WORK SEMANTICS. The queue/outbox checks block ONLY on UNFINISHED
// work, never on completed history: `artifact_binding_reconcile_queue.status IN
// ('pending','failed')` (a durable `done` row is harmless history — blocking on
// it would make teardown permanently impossible), and
// `graphiti_projection_outbox.status <> 'done'` (which INCLUDES the transient
// `processing` state — a row a projector claimed but has not yet completed is
// in-flight work the drop must not race).
//
// TABLE-EXISTENCE + COLUMN GUARDED (fresh DB + partial + legacy schema safe).
// Every check first probes `to_regclass` for BOTH `dynamic_object_types` and the
// referenced table (a NULL — table absent — makes the check a no-op), AND that
// `dynamic_object_types` actually carries a `type` column (a pre-historic
// `id`/`payload`-shaped table that never had `type` cannot be referenced by the
// modern claim/queue/outbox by-type strings, so the checks are skipped and the
// table is dropped). On a database that NEVER had `dynamic_object_types` (a fresh
// install after the bootstrap DDL stopped creating it), the whole guard is
// skipped and `DROP TABLE IF EXISTS` is a no-op — boot is green with no table
// (AC#4). On a database MIGRATED from a populated modern table, the guard runs
// against the real claim/queue/outbox tables and the drop removes it (AC#4).
//
// DEPLOY-QUIESCE (mixed-version note, mirrors core__0059). This is a clean-break
// teardown (owner ruled NO backward compatibility): the ONLY writer of
// `dynamic_object_types` — the auto-registrar — is deleted in this same PR, so no
// NEW image writes the table. A rolling deploy where an OLD (pre-teardown) image
// is still live during the migration would have that image's write ERROR once the
// table is gone; that is the intended fail-closed outcome, not a regression. The
// entry-95 ordering guarantees every dynamic writer is retired before this runs;
// operators quiesce or drain old images across the cutover as with core__0059.
//
// TRIGGER-AWARE (like core__0059). `dynamic_object_types` carries NO row
// triggers and NO table FKs point at it, so `DROP TABLE` needs no
// trigger-disable dance and no CASCADE — a plain `DROP TABLE IF EXISTS` removes
// the table and its own PK index cleanly. The trigger-aware discipline it
// inherits from core__0059 is the RIGOR: table-existence guards, distinct
// RAISEs, schema-qualifiable builders exported as data for the shape test,
// idempotency, and a refusing down().
//
// TRANSACTION. Guard DO-blocks + one DROP in node-pg-migrate's default single
// transaction (all-or-nothing): a tripped precondition RAISEs and rolls the
// whole migration back — the table is never half-dropped. Unqualified names
// resolve to the app schema on the runner's search_path.
//
// IDEMPOTENT. A second run (or a fresh schema) finds `to_regclass` NULL — the
// guard is skipped and `DROP TABLE IF EXISTS` is a no-op.
//
// DOWN. Irreversible by design (0033/0048/0056/0059 precedent): the dropped
// table + its rows are not retained; roll back by restoring from a backup, not
// this migration.

/** The engine registry table this migration drops. */
export const DYNAMIC_OBJECT_TYPES_TABLE = "dynamic_object_types";

/**
 * The three owner-ratified drop preconditions (entry 95). Exposed as data so
 * the shape test can assert the exact guard set and a follow-up can extend it.
 * Each `label` appears verbatim in its RAISE message; `refs` are the tables the
 * check joins (each existence-guarded).
 */
export const DROP_PRECONDITIONS = [
  {
    id: "a",
    label: "non-retired artifact_type_claims still reference a dynamic_object_types type",
    refs: ["artifact_type_claims"],
  },
  {
    id: "b",
    label: "the binding-reconcile queue is not drained of dynamic-type work",
    refs: ["artifact_binding_reconcile_queue"],
  },
  {
    id: "c",
    label: "the #1792 projection purge has not converged (unfinished outbox rows — status <> 'done', incl. 'processing' — remain for a dynamic type)",
    refs: ["graphiti_projection_outbox", "objects"],
  },
];

const escId = (s) => s.replaceAll('"', '""');

/**
 * Build the ordered guard statements — one existence-guarded PL/pgSQL DO-block
 * per precondition, each RAISEing a distinct EXCEPTION when tripped.
 *
 * @param {string} [schema] optional schema to qualify identifiers (integration
 *   path); when omitted, names are unqualified and resolve via search_path.
 * @returns {string[]} one DO-block per precondition, in (a),(b),(c) order.
 */
export function buildGuardSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  // to_regclass takes a text name; qualify it the same way identifiers are.
  const toReg = (name) => (schema ? `to_regclass('"${escId(schema)}"."${name}"')` : `to_regclass('${name}')`);
  const dot = t(DYNAMIC_OBJECT_TYPES_TABLE);

  // Bail out (RETURN) unless `dynamic_object_types` exists AND carries a `type`
  // column — a legacy `id`/`payload`-shaped table (no `type`) predates the
  // by-type claim/queue/outbox coupling, so nothing can reference it by type and
  // the drop is safe. Emitted at the top of every guard block.
  const existsAndHasType = `IF ${toReg(DYNAMIC_OBJECT_TYPES_TABLE)} IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = ${toReg(DYNAMIC_OBJECT_TYPES_TABLE)}
          AND attname = 'type' AND attnum > 0 AND NOT attisdropped
     ) THEN
    RETURN;
  END IF;`;

  // (a) non-retired claims over a still-present dynamic type.
  const guardA = `DO $core0060a$
DECLARE n bigint;
BEGIN
  ${existsAndHasType}
  IF ${toReg("artifact_type_claims")} IS NULL THEN RETURN; END IF;
  SELECT count(*) INTO n
    FROM ${t("artifact_type_claims")} c
   WHERE c.status <> 'retired'
     AND c.object_type_id IN (SELECT type FROM ${dot});
  IF n > 0 THEN
    RAISE EXCEPTION 'core__0060 precondition (a) FAILED: % non-retired artifact_type_claims still reference a dynamic_object_types type (epic cinatra#1785 entry 95, #1793) — retire the claims before the dynamic-types engine teardown', n;
  END IF;
END $core0060a$`;

  // (b) reconcile queue drained of UNFINISHED (pending/failed) dynamic-type work.
  //     The queue's own `object_type_id` is a NOT-NULL denormalized column
  //     populated on BOTH axes — claim-side (the winner-transition's type) and
  //     write-side ('binding-reconcile-write', the object's type) — so it is the
  //     authoritative per-row signal, robust to the referenced object/claim-event
  //     row having already been purged. A durable 'done' row is harmless history.
  const guardB = `DO $core0060b$
DECLARE n bigint;
BEGIN
  ${existsAndHasType}
  IF ${toReg("artifact_binding_reconcile_queue")} IS NULL THEN RETURN; END IF;
  SELECT count(*) INTO n
    FROM ${t("artifact_binding_reconcile_queue")} q
   WHERE q.status IN ('pending', 'failed')
     AND q.object_type_id IN (SELECT type FROM ${dot});
  IF n > 0 THEN
    RAISE EXCEPTION 'core__0060 precondition (b) FAILED: % pending/failed artifact_binding_reconcile_queue rows still reference a dynamic type (epic cinatra#1785 entry 95, #1793) — drain the binding-reconcile queue before the teardown', n;
  END IF;
END $core0060b$`;

  // (c) #1792 projection purge converged: no UNFINISHED (status <> 'done', which
  //     includes the transient 'processing' state) outbox row for a dynamic-typed
  //     object.
  const guardC = `DO $core0060c$
DECLARE n bigint;
BEGIN
  ${existsAndHasType}
  IF ${toReg("graphiti_projection_outbox")} IS NULL OR ${toReg("objects")} IS NULL THEN RETURN; END IF;
  SELECT count(*) INTO n
    FROM ${t("graphiti_projection_outbox")} g
    JOIN ${t("objects")} o ON o.id = g.object_id
   WHERE g.status <> 'done'
     AND o.type IN (SELECT type FROM ${dot});
  IF n > 0 THEN
    RAISE EXCEPTION 'core__0060 precondition (c) FAILED: % unfinished graphiti_projection_outbox rows remain for a dynamic type — the #1792 projection purge has not converged (epic cinatra#1785 entry 95, #1793)', n;
  END IF;
END $core0060c$`;

  return [guardA, guardB, guardC];
}

/**
 * Build the drop statement. `dynamic_object_types` has no row triggers and no
 * table FKs point at it, so a plain `DROP TABLE IF EXISTS` (no CASCADE) removes
 * the table + its own PK index cleanly and is idempotent on a fresh schema.
 *
 * @param {string} [schema] optional schema to qualify the identifier.
 * @returns {string[]} the single drop statement.
 */
export function buildDropSql(schema) {
  const t = (name) => (schema ? `"${escId(schema)}"."${name}"` : name);
  return [`DROP TABLE IF EXISTS ${t(DYNAMIC_OBJECT_TYPES_TABLE)}`];
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  for (const sql of buildGuardSql()) {
    pgm.sql(`${sql};`);
  }
  for (const sql of buildDropSql()) {
    pgm.sql(`${sql};`);
  }
}

/** @param {import("node-pg-migrate").MigrationBuilder} _pgm */
export function down() {
  throw new Error(
    "core__0060 is a one-time clean-break teardown of the dynamic-types engine " +
      "table dynamic_object_types (owner ruling 2026-07-18; epic cinatra#1785 entry 95; " +
      "#1793): the owner ruled no backward compatibility and the dropped table + its rows " +
      "are not retained. Roll back by restoring from a backup, not this migration.",
  );
}
