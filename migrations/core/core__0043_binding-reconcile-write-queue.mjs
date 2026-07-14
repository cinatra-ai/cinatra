// core__0043 — object-side (write-driven) binding-reconcile queue records
// (cinatra#1493, epic #1424).
//
// The write-path binding reconcile (upsertObjectAndEnqueue) must survive a
// crash: a create into a claimed type, or a type-change AWAY from a claimed
// type, has to converge even if the process dies right after the object write.
// The claim-side queue (core__0034) is winner-transition-driven and TYPE-swept,
// which cannot select a row whose type has already moved away from the claimed
// type — so the object-side axis needs its own per-artifact durable record,
// written in the SAME transaction as the object write.
//
// This migration extends `artifact_binding_reconcile_queue` to carry that
// record: two nullable identity columns (object_id, org_id), a relaxed
// claim_event_id (a write-driven row has no claim event), a widened kind CHECK
// admitting 'binding-reconcile-write', and a shape CHECK keeping each kind's
// required columns honest (write rows require object_id+org_id; claim rows
// require claim_event_id).
//
// Additive/loosening — NON-destructive: new NULLABLE columns, a DROP NOT NULL,
// a CHECK that only ADMITS a new kind value, and a new CHECK that every
// existing (claim-side) row already satisfies (they all carry claim_event_id).
// No data rewrite, no tightening. MIRRORS the idempotent bootstrap DDL in
// src/lib/artifact-claim-schema.ts (buildCreateStoreSchemaQueries →
// artifactClaimSchemaQueries): on a bootstrap-seeded schema every statement is
// a no-op; on an operator upgrade it applies the pending additions. Unqualified
// names ride the runner's search_path (the app schema); metadata-only DDL, no
// noTransaction().

/** Idempotent DDL mirroring the bootstrap — safe to run after it. */
export const bindingReconcileWriteQueueDdlSql = `
  ALTER TABLE artifact_binding_reconcile_queue ADD COLUMN IF NOT EXISTS object_id text;
  ALTER TABLE artifact_binding_reconcile_queue ADD COLUMN IF NOT EXISTS org_id text;
  ALTER TABLE artifact_binding_reconcile_queue ALTER COLUMN claim_event_id DROP NOT NULL;
  ALTER TABLE artifact_binding_reconcile_queue DROP CONSTRAINT IF EXISTS artifact_binding_reconcile_queue_kind_check;
  ALTER TABLE artifact_binding_reconcile_queue ADD CONSTRAINT artifact_binding_reconcile_queue_kind_check
    CHECK (kind IN ('binding-reconcile','re-projection','binding-reconcile-write'));
  ALTER TABLE artifact_binding_reconcile_queue DROP CONSTRAINT IF EXISTS artifact_binding_reconcile_queue_shape_check;
  ALTER TABLE artifact_binding_reconcile_queue ADD CONSTRAINT artifact_binding_reconcile_queue_shape_check
    CHECK (CASE WHEN kind = 'binding-reconcile-write'
                THEN object_id IS NOT NULL AND org_id IS NOT NULL
                ELSE claim_event_id IS NOT NULL END);
`;

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(bindingReconcileWriteQueueDdlSql);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible in shape. HONEST COST: any write-driven ('binding-reconcile-write')
  // rows still PENDING are lost when the kind CHECK narrows — they are
  // idempotently re-enqueued by the next object write of an affected artifact,
  // so no binding permanently diverges (the reconcile always resolves the live
  // winner). Narrow the kind CHECK first (deleting the rows it would now
  // reject), then restore claim_event_id NOT NULL and drop the added columns.
  pgm.sql(`
    DELETE FROM artifact_binding_reconcile_queue WHERE kind = 'binding-reconcile-write';
    ALTER TABLE artifact_binding_reconcile_queue DROP CONSTRAINT IF EXISTS artifact_binding_reconcile_queue_shape_check;
    ALTER TABLE artifact_binding_reconcile_queue DROP CONSTRAINT IF EXISTS artifact_binding_reconcile_queue_kind_check;
    ALTER TABLE artifact_binding_reconcile_queue ADD CONSTRAINT artifact_binding_reconcile_queue_kind_check
      CHECK (kind IN ('binding-reconcile','re-projection'));
    ALTER TABLE artifact_binding_reconcile_queue ALTER COLUMN claim_event_id SET NOT NULL;
    ALTER TABLE artifact_binding_reconcile_queue
      DROP COLUMN IF EXISTS object_id,
      DROP COLUMN IF EXISTS org_id;
  `);
}
