// Canonical history-aware writer API.
//
// Every mutation of cinatra.objects flows through this module. The atomic
// CTE emits the object_change_event in the SAME DB transaction as the
// object mutation + the Graphiti outbox enqueue.
//
// CAS contract:
//   expectedBaseVersion === null  -> create-only; ON CONFLICT DO NOTHING.
//                                    A pre-existing row yields row-exists.
//   expectedBaseVersion === N     -> update-only; WHERE version = N.
//                                    Mismatch yields stale-write.
// Concurrency-safe because the WHERE clause is evaluated AT THE TIME of the
// UPDATE/INSERT, not pre-evaluated as a separate CTE guard.
//
// Append-only history: the event_row is INSERTed in
// the same single statement that performs the object mutation + outbox
// enqueue. No post-update. The checksum is computed JS-side from
// deterministic inputs (operation, ids, idempotency_key, baseVersion,
// resultVersion, input-data hash) and stored at INSERT time.

import { createHash, randomUUID } from "node:crypto";

import {
  ensurePostgresSchema,
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { mcpRequestContextStorage } from "@/lib/mcp-request-context";
import { assertProjectWritableSync } from "@/lib/project-writable";
import { resolveProjectInheritanceForType } from "@/lib/project-inheritance";

import {
  closeChangeSet,
  openChangeSet,
} from "./change-set";
import {
  HistoryWriterContractError,
  VersionConflictError,
} from "./errors";
import {
  buildSnapshotFromRow,
  canonicalJsonStringify,
  newIdempotencyKey,
} from "./event-snapshot";
import type {
  ChangeSetHandle,
  HistoryActor,
  HistoryEffect,
  HistoryOperation,
  HistoryWriteOptions,
  ObjectChangeEvent,
  RemoteRevisionRef,
} from "./types";

export type HistoryAwareUpsertInput = {
  id?: string | null;
  type: string;
  data: unknown;
  parentId?: string | null;
  parentType?: string | null;
  createdBy?: string | null;
  orgId?: string | null;
  source?: string | null;
  runId?: string | null;
  agentId?: string | null;
  packageVersion?: string | null;
  agentSpecVersion?: string | null;
  ownerLevel?: string | null;
  ownerId?: string | null;
  visibility?: string | null;
  payloadHash?: string | null;
};

export type HistoryAwareUpsertResult = {
  objectId: string;
  resultVersion: number;
  event: ObjectChangeEvent;
  changeSetId: string;
  rowSnapshot: Record<string, unknown>;
};

const SUPPORTED_SCHEMA_VERSIONS = new Set(["v1"]);
const DEFAULT_SCHEMA_VERSION = "v1";

function ensureActor(actor: HistoryActor | undefined): asserts actor {
  if (!actor || !actor.actorKind) {
    throw new HistoryWriterContractError(
      "missing-actor",
      "history-aware writer requires actor: { actorId, actorKind, orgId }",
    );
  }
}

function ensureEffect(
  effect: HistoryEffect | undefined,
  compensatingTemplateId: string | undefined,
): asserts effect is HistoryEffect {
  if (
    effect !== "reversible-internal" &&
    effect !== "irreversible-logged" &&
    effect !== "compensating-action"
  ) {
    throw new HistoryWriterContractError(
      "invalid-effect",
      `history-aware writer requires a valid historyEffect; got ${String(effect)}`,
    );
  }
  if (effect === "compensating-action" && !compensatingTemplateId) {
    throw new HistoryWriterContractError(
      "missing-compensating-template",
      "history-aware writer requires compensatingTemplateId when historyEffect === 'compensating-action'",
    );
  }
}

function ensureSchemaVersion(schemaVersion: string | undefined): string {
  return schemaVersion ?? DEFAULT_SCHEMA_VERSION;
}

function autoChangeSet(
  actor: HistoryActor,
  changeSet: ChangeSetHandle | undefined,
): { handle: ChangeSetHandle; autoOpened: boolean } {
  if (changeSet) return { handle: changeSet, autoOpened: false };
  const handle = openChangeSet({ actor });
  return { handle, autoOpened: true };
}

function maybeAutoClose(
  autoOpened: boolean,
  handle: ChangeSetHandle,
  closureReason: string,
): void {
  if (!autoOpened) return;
  try {
    closeChangeSet(handle, { closureReason });
  } catch (e) {
    console.warn(
      `[object-history] auto-close change_set ${handle.changeSetId} failed:`,
      e,
    );
  }
}

function computeChecksum(input: {
  objectId: string;
  operation: HistoryOperation;
  historyEffect: HistoryEffect;
  baseVersion: number | null;
  resultVersion: number;
  idempotencyKey: string;
  inputDataHash: string;
}): string {
  return createHash("sha256")
    .update(
      canonicalJsonStringify({
        objectId: input.objectId,
        operation: input.operation,
        historyEffect: input.historyEffect,
        baseVersion: input.baseVersion,
        resultVersion: input.resultVersion,
        idempotencyKey: input.idempotencyKey,
        inputDataHash: input.inputDataHash,
      }),
    )
    .digest("hex");
}

function hashInputData(data: unknown): string {
  return createHash("sha256")
    .update(canonicalJsonStringify(data ?? null))
    .digest("hex");
}

function readObjectRowForSnapshot(
  schema: string,
  objectId: string,
): Record<string, unknown> | null {
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, type, parent_id, parent_type, data, created_at, updated_at,
                      created_by, org_id, source, run_id, agent_id, package_version,
                      agent_spec_version, version, deleted_at,
                      owner_level, owner_id, visibility, project_id,
                      canonical_keys, external_id, exported_to
               FROM "${schema}"."objects"
               WHERE id = $1`,
        values: [objectId],
      },
    ],
  });
  return (result?.rows[0] as Record<string, unknown>) ?? null;
}

function getNextEventSequence(changeSetId: string): number {
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT COALESCE(MAX(sequence), 0) AS max_seq
               FROM "${schema}"."object_change_event"
               WHERE change_set_id = $1`,
        values: [changeSetId],
      },
    ],
  });
  const max = Number(result?.rows[0]?.max_seq ?? 0);
  return max + 1;
}

function eligibilityForEffect(
  effect: HistoryEffect,
  compensatingTemplateId: string | undefined,
  schemaVersion: string,
): { eligible: boolean; reason: string | null } {
  if (!SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) {
    return { eligible: false, reason: "schema-version-mismatch" };
  }
  if (effect === "irreversible-logged") {
    return { eligible: false, reason: "irreversible-no-compensating" };
  }
  if (effect === "compensating-action" && !compensatingTemplateId) {
    return { eligible: false, reason: "irreversible-no-compensating" };
  }
  return { eligible: true, reason: null };
}

// ===========================================================================
// Statement builders (returned for batched-transaction use by restore engine)
// ===========================================================================

export type CreateStmtArgs = {
  schema: string;
  id: string;
  type: string;
  parentId: string | null;
  parentType: string | null;
  data: unknown;
  createdBy: string | null;
  orgId: string | null;
  source: string | null;
  runId: string | null;
  agentId: string | null;
  packageVersion: string | null;
  agentSpecVersion: string | null;
  ownerLevel: string | null;
  ownerId: string | null;
  visibility: string | null;
  projectId: string | null;
  changeSetId: string;
  eventId: string;
  sequence: number;
  historyEffect: HistoryEffect;
  compensatingTemplateId: string | null;
  remoteRevisionRefJson: string | null;
  schemaVersion: string;
  restoreEligible: boolean;
  restoreIneligibleReason: string | null;
  actorId: string | null;
  actorKind: HistoryActor["actorKind"] | null;
  auditEventId: string | null;
  idempotencyKey: string;
  checksum: string;
  payloadHash: string | null;
};

function buildCreateStatement(args: CreateStmtArgs): {
  text: string;
  values: unknown[];
} {
  const schema = args.schema;
  return {
    text: `WITH inserted AS (
             INSERT INTO "${schema}"."objects"
               (id, type, parent_id, parent_type, data, created_by, org_id,
                source, run_id, agent_id, package_version, agent_spec_version,
                graphiti_sync_status, version,
                owner_level, owner_id, visibility, project_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                     'pending', 1,
                     COALESCE($13, 'organization'),
                     COALESCE($14, $7, $6, ''),
                     COALESCE($15, 'organization'),
                     $16)
             ON CONFLICT (id) DO NOTHING
             RETURNING id, type, parent_id, parent_type, data, created_at, updated_at,
                       created_by, org_id, source, run_id, agent_id, package_version,
                       agent_spec_version, version, deleted_at,
                       owner_level, owner_id, visibility, project_id,
                       row_to_json("${schema}"."objects".*)::jsonb AS row_json
           ),
           outbox_row AS (
             INSERT INTO "${schema}"."graphiti_projection_outbox"
               (id, object_id, object_version, org_id, operation, payload_hash, status, attempts)
             SELECT gen_random_uuid()::text,
                    inserted.id, inserted.version, inserted.org_id, 'upsert', $17, 'pending', 0
             FROM inserted
           ),
           event_row AS (
             INSERT INTO "${schema}"."object_change_event"
               (id, change_set_id, sequence, object_id, object_type, operation,
                history_effect, before_snapshot, after_snapshot,
                base_version, result_version, object_schema_version,
                restore_eligible, restore_ineligible_reason,
                compensating_template_id, remote_revision_ref,
                actor_id, actor_kind, run_id, audit_event_id,
                org_id, project_id, owner_level, owner_id, visibility,
                idempotency_key, event_checksum, created_at)
             SELECT
                $18, $19, $20, inserted.id, inserted.type, 'create',
                $21,
                NULL,
                inserted.row_json,
                NULL, inserted.version, $22,
                $23, $24,
                $25, $26::jsonb,
                $27, $28, $9, $29,
                inserted.org_id, inserted.project_id, inserted.owner_level, inserted.owner_id, inserted.visibility,
                $30, $31, now()
             FROM inserted
           ),
           cas_assert AS (
             SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM inserted) THEN 1 ELSE 0 END AS ok
           )
           SELECT id, type, parent_id, parent_type, data, created_at, updated_at,
                  created_by, org_id, source, run_id, agent_id, package_version,
                  agent_spec_version, version, deleted_at,
                  owner_level, owner_id, visibility, project_id, row_json
           FROM cas_assert LEFT JOIN inserted ON TRUE`,
    values: [
      args.id, // $1
      args.type, // $2
      args.parentId, // $3
      args.parentType, // $4
      args.data, // $5
      args.createdBy, // $6
      args.orgId, // $7
      args.source, // $8
      args.runId, // $9
      args.agentId, // $10
      args.packageVersion, // $11
      args.agentSpecVersion, // $12
      args.ownerLevel, // $13
      args.ownerId, // $14
      args.visibility, // $15
      args.projectId, // $16
      args.payloadHash, // $17
      args.eventId, // $18
      args.changeSetId, // $19
      args.sequence, // $20
      args.historyEffect, // $21
      args.schemaVersion, // $22
      args.restoreEligible, // $23
      args.restoreIneligibleReason, // $24
      args.compensatingTemplateId, // $25
      args.remoteRevisionRefJson, // $26
      args.actorId, // $27
      args.actorKind, // $28
      args.auditEventId, // $29
      args.idempotencyKey, // $30
      args.checksum, // $31
    ],
  };
}

export type UpdateStmtArgs = CreateStmtArgs & {
  expectedBaseVersion: number;
  beforeSnapshotJson: string;
};

function buildUpdateStatement(args: UpdateStmtArgs): {
  text: string;
  values: unknown[];
} {
  const schema = args.schema;
  return {
    text: `WITH updated AS (
             UPDATE "${schema}"."objects" SET
               type = $2,
               data = $5,
               parent_id = $3,
               parent_type = $4,
               created_by = COALESCE($6, created_by),
               source = COALESCE($8, source),
               run_id = COALESCE($9, run_id),
               agent_id = COALESCE($10, agent_id),
               package_version = COALESCE($11, package_version),
               agent_spec_version = COALESCE($12, agent_spec_version),
               graphiti_sync_status = 'pending',
               graphiti_projection_error = NULL,
               version = version + 1,
               updated_at = now(),
               project_id = COALESCE($16, project_id),
               owner_level = COALESCE($13, owner_level),
               owner_id = COALESCE($14, owner_id),
               visibility = COALESCE($15, visibility)
             WHERE id = $1
               AND version = $32
               AND (org_id = $7 OR $7 IS NULL OR org_id IS NULL)
             RETURNING id, type, parent_id, parent_type, data, created_at, updated_at,
                       created_by, org_id, source, run_id, agent_id, package_version,
                       agent_spec_version, version, deleted_at,
                       owner_level, owner_id, visibility, project_id,
                       row_to_json("${schema}"."objects".*)::jsonb AS row_json
           ),
           outbox_row AS (
             INSERT INTO "${schema}"."graphiti_projection_outbox"
               (id, object_id, object_version, org_id, operation, payload_hash, status, attempts)
             SELECT gen_random_uuid()::text,
                    updated.id, updated.version, updated.org_id, 'upsert', $17, 'pending', 0
             FROM updated
           ),
           event_row AS (
             INSERT INTO "${schema}"."object_change_event"
               (id, change_set_id, sequence, object_id, object_type, operation,
                history_effect, before_snapshot, after_snapshot,
                base_version, result_version, object_schema_version,
                restore_eligible, restore_ineligible_reason,
                compensating_template_id, remote_revision_ref,
                actor_id, actor_kind, run_id, audit_event_id,
                org_id, project_id, owner_level, owner_id, visibility,
                idempotency_key, event_checksum, created_at)
             SELECT
                $18, $19, $20, updated.id, updated.type, 'update',
                $21,
                $33::jsonb,
                updated.row_json,
                $32, updated.version, $22,
                $23, $24,
                $25, $26::jsonb,
                $27, $28, $9, $29,
                updated.org_id, updated.project_id, updated.owner_level, updated.owner_id, updated.visibility,
                $30, $31, now()
             FROM updated
           ),
           cas_assert AS (
             SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM updated) THEN 1 ELSE 0 END AS ok
           )
           SELECT id, type, parent_id, parent_type, data, created_at, updated_at,
                  created_by, org_id, source, run_id, agent_id, package_version,
                  agent_spec_version, version, deleted_at,
                  owner_level, owner_id, visibility, project_id, row_json
           FROM cas_assert LEFT JOIN updated ON TRUE`,
    values: [
      args.id, // $1
      args.type, // $2
      args.parentId, // $3
      args.parentType, // $4
      args.data, // $5
      args.createdBy, // $6
      args.orgId, // $7
      args.source, // $8
      args.runId, // $9
      args.agentId, // $10
      args.packageVersion, // $11
      args.agentSpecVersion, // $12
      args.ownerLevel, // $13
      args.ownerId, // $14
      args.visibility, // $15
      args.projectId, // $16
      args.payloadHash, // $17
      args.eventId, // $18
      args.changeSetId, // $19
      args.sequence, // $20
      args.historyEffect, // $21
      args.schemaVersion, // $22
      args.restoreEligible, // $23
      args.restoreIneligibleReason, // $24
      args.compensatingTemplateId, // $25
      args.remoteRevisionRefJson, // $26
      args.actorId, // $27
      args.actorKind, // $28
      args.auditEventId, // $29
      args.idempotencyKey, // $30
      args.checksum, // $31
      args.expectedBaseVersion, // $32
      args.beforeSnapshotJson, // $33
    ],
  };
}

export type SoftDeleteStmtArgs = {
  schema: string;
  id: string;
  orgId: string | null;
  expectedBaseVersion: number;
  beforeSnapshotJson: string;
  changeSetId: string;
  eventId: string;
  sequence: number;
  historyEffect: HistoryEffect;
  compensatingTemplateId: string | null;
  remoteRevisionRefJson: string | null;
  schemaVersion: string;
  restoreEligible: boolean;
  restoreIneligibleReason: string | null;
  actorId: string | null;
  actorKind: HistoryActor["actorKind"] | null;
  runId: string | null;
  auditEventId: string | null;
  idempotencyKey: string;
  checksum: string;
};

function buildSoftDeleteStatement(args: SoftDeleteStmtArgs): {
  text: string;
  values: unknown[];
} {
  const schema = args.schema;
  return {
    text: `WITH deleted AS (
             UPDATE "${schema}"."objects"
             SET deleted_at = now(),
                 graphiti_sync_status = 'pending',
                 version = version + 1,
                 updated_at = now()
             WHERE id = $1
               AND version = $2
               AND (org_id = $3 OR $3 IS NULL OR org_id IS NULL)
               AND deleted_at IS NULL
             RETURNING id, version, org_id, type, project_id, owner_level, owner_id, visibility,
                       row_to_json("${schema}"."objects".*)::jsonb AS row_json
           ),
           outbox_row AS (
             INSERT INTO "${schema}"."graphiti_projection_outbox"
               (id, object_id, object_version, org_id, operation, payload_hash, status, attempts)
             SELECT gen_random_uuid()::text,
                    deleted.id, deleted.version, deleted.org_id, 'delete', NULL, 'pending', 0
             FROM deleted
           ),
           event_row AS (
             INSERT INTO "${schema}"."object_change_event"
               (id, change_set_id, sequence, object_id, object_type, operation,
                history_effect, before_snapshot, after_snapshot,
                base_version, result_version, object_schema_version,
                restore_eligible, restore_ineligible_reason,
                compensating_template_id, remote_revision_ref,
                actor_id, actor_kind, run_id, audit_event_id,
                org_id, project_id, owner_level, owner_id, visibility,
                idempotency_key, event_checksum, created_at)
             SELECT
                $4, $5, $6, deleted.id, deleted.type, 'soft-delete',
                $7, $8::jsonb, deleted.row_json,
                $2, deleted.version, $9,
                $10, $11,
                $12, $13::jsonb,
                $14, $15, $16, $17,
                deleted.org_id, deleted.project_id, deleted.owner_level, deleted.owner_id, deleted.visibility,
                $18, $19, now()
             FROM deleted
           ),
           cas_assert AS (
             SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM deleted) THEN 1 ELSE 0 END AS ok
           )
           SELECT id, version, org_id, type, project_id, owner_level, owner_id, visibility, row_json
           FROM cas_assert LEFT JOIN deleted ON TRUE`,
    values: [
      args.id, // $1
      args.expectedBaseVersion, // $2
      args.orgId, // $3
      args.eventId, // $4
      args.changeSetId, // $5
      args.sequence, // $6
      args.historyEffect, // $7
      args.beforeSnapshotJson, // $8
      args.schemaVersion, // $9
      args.restoreEligible, // $10
      args.restoreIneligibleReason, // $11
      args.compensatingTemplateId, // $12
      args.remoteRevisionRefJson, // $13
      args.actorId, // $14
      args.actorKind, // $15
      args.runId, // $16
      args.auditEventId, // $17
      args.idempotencyKey, // $18
      args.checksum, // $19
    ],
  };
}

export type UndeleteStmtArgs = {
  schema: string;
  id: string;
  orgId: string | null;
  expectedBaseVersion: number;
  restoredData: unknown;
  beforeSnapshotJson: string;
  changeSetId: string;
  eventId: string;
  sequence: number;
  schemaVersion: string;
  actorId: string | null;
  actorKind: HistoryActor["actorKind"] | null;
  runId: string | null;
  auditEventId: string | null;
  idempotencyKey: string;
  checksum: string;
};

function buildUndeleteStatement(args: UndeleteStmtArgs): {
  text: string;
  values: unknown[];
} {
  const schema = args.schema;
  return {
    text: `WITH undeleted AS (
             UPDATE "${schema}"."objects"
             SET deleted_at = NULL,
                 data = $4,
                 graphiti_sync_status = 'pending',
                 version = version + 1,
                 updated_at = now()
             WHERE id = $1
               AND version = $2
               AND (org_id = $3 OR $3 IS NULL OR org_id IS NULL)
               AND deleted_at IS NOT NULL
             RETURNING id, version, org_id, type, project_id, owner_level, owner_id, visibility,
                       row_to_json("${schema}"."objects".*)::jsonb AS row_json
           ),
           outbox_row AS (
             INSERT INTO "${schema}"."graphiti_projection_outbox"
               (id, object_id, object_version, org_id, operation, payload_hash, status, attempts)
             SELECT gen_random_uuid()::text,
                    undeleted.id, undeleted.version, undeleted.org_id, 'upsert', NULL, 'pending', 0
             FROM undeleted
           ),
           event_row AS (
             INSERT INTO "${schema}"."object_change_event"
               (id, change_set_id, sequence, object_id, object_type, operation,
                history_effect, before_snapshot, after_snapshot,
                base_version, result_version, object_schema_version,
                restore_eligible, restore_ineligible_reason,
                compensating_template_id, remote_revision_ref,
                actor_id, actor_kind, run_id, audit_event_id,
                org_id, project_id, owner_level, owner_id, visibility,
                idempotency_key, event_checksum, created_at)
             SELECT
                $5, $6, $7, undeleted.id, undeleted.type, 'restore',
                'reversible-internal', $8::jsonb, undeleted.row_json,
                $2, undeleted.version, $9,
                TRUE, NULL,
                NULL, NULL,
                $10, $11, $12, $13,
                undeleted.org_id, undeleted.project_id, undeleted.owner_level, undeleted.owner_id, undeleted.visibility,
                $14, $15, now()
             FROM undeleted
           ),
           cas_assert AS (
             SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM undeleted) THEN 1 ELSE 0 END AS ok
           )
           SELECT id, version, org_id, type, project_id, owner_level, owner_id, visibility, row_json
           FROM cas_assert LEFT JOIN undeleted ON TRUE`,
    values: [
      args.id, // $1
      args.expectedBaseVersion, // $2
      args.orgId, // $3
      args.restoredData, // $4
      args.eventId, // $5
      args.changeSetId, // $6
      args.sequence, // $7
      args.beforeSnapshotJson, // $8
      args.schemaVersion, // $9
      args.actorId, // $10
      args.actorKind, // $11
      args.runId, // $12
      args.auditEventId, // $13
      args.idempotencyKey, // $14
      args.checksum, // $15
    ],
  };
}

// Public statement builders for the restore engine.
export const __statementBuilders = {
  create: buildCreateStatement,
  update: buildUpdateStatement,
  softDelete: buildSoftDeleteStatement,
  undelete: buildUndeleteStatement,
};

export const __internals = {
  hashInputData,
  computeChecksum,
  eligibilityForEffect,
  readObjectRowForSnapshot,
  getNextEventSequence,
  SUPPORTED_SCHEMA_VERSIONS,
};

// ===========================================================================
// Public API
// ===========================================================================


// cas_assert raises Postgres `division_by_zero` (SQLSTATE 22012)
// when the write CTE returned zero rows. Convert that into a typed
// VersionConflictError with the precise reason so callers see the same
// shape regardless of how CAS failed.
function isCasAssertError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; message?: string };
  if (err.code === "22012") return true;
  return /division by zero/i.test(err.message ?? "");
}

function casMissToVersionConflict(
  id: string,
  expectedBaseVersion: number | null,
  current: Record<string, unknown> | null,
  isUpdate: boolean,
): VersionConflictError {
  const currentVersion =
    current && current.version != null ? Number(current.version) : null;
  return new VersionConflictError({
    objectId: id,
    currentVersion,
    expectedBaseVersion,
    latestSnapshot: buildSnapshotFromRow(current),
    conflictingFields: [],
    reason: isUpdate
      ? current
        ? "stale-write"
        : "row-missing"
      : current
        ? "row-exists"
        : "stale-write",
  });
}

export function historyAwareUpsert(
  input: HistoryAwareUpsertInput,
  options: HistoryWriteOptions,
): HistoryAwareUpsertResult {
  ensurePostgresSchema();
  ensureActor(options.actor);
  ensureEffect(options.historyEffect, options.compensatingTemplateId);
  const schemaVersion = ensureSchemaVersion(options.objectSchemaVersion);
  const schema = postgresSchema.replaceAll('"', '""');
  const id = input.id ?? randomUUID();

  // Project inheritance + archive gate, same as legacy writer.
  const frame = mcpRequestContextStorage.getStore()?.projectContext;
  const projectId = resolveProjectInheritanceForType(
    frame?.projectId,
    input.type,
  );
  if (projectId !== null) {
    assertProjectWritableSync(projectId);
  }

  const { handle, autoOpened } = autoChangeSet(options.actor, options.changeSet);
  const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey();
  const sequence = getNextEventSequence(handle.changeSetId);
  const eventId = randomUUID();

  const before = readObjectRowForSnapshot(schema, id);
  const beforeSnapshot = before ? buildSnapshotFromRow(before) : null;
  const beforeSnapshotJson = beforeSnapshot
    ? JSON.stringify(beforeSnapshot.payload)
    : null;

  const isUpdate = options.expectedBaseVersion !== null;
  const expectedBaseVersion = options.expectedBaseVersion;
  const resultVersion = isUpdate
    ? Number(expectedBaseVersion) + 1
    : 1;

  const elig = eligibilityForEffect(
    options.historyEffect,
    options.compensatingTemplateId,
    schemaVersion,
  );
  const inputDataHash = hashInputData(input.data);
  const checksum = computeChecksum({
    objectId: id,
    operation: isUpdate ? "update" : "create",
    historyEffect: options.historyEffect,
    baseVersion: isUpdate ? Number(expectedBaseVersion) : null,
    resultVersion,
    idempotencyKey,
    inputDataHash,
  });

  const remoteRevisionRefJson = options.remoteRevisionRef
    ? JSON.stringify(options.remoteRevisionRef)
    : null;

  const common = {
    schema,
    id,
    type: input.type,
    parentId: input.parentId ?? null,
    parentType: input.parentType ?? null,
    data: input.data,
    createdBy: input.createdBy ?? null,
    orgId: input.orgId ?? null,
    source: input.source ?? null,
    runId: input.runId ?? options.actor.runId ?? null,
    agentId: input.agentId ?? null,
    packageVersion: input.packageVersion ?? null,
    agentSpecVersion: input.agentSpecVersion ?? null,
    ownerLevel: input.ownerLevel ?? null,
    ownerId: input.ownerId ?? null,
    visibility: input.visibility ?? null,
    projectId,
    changeSetId: handle.changeSetId,
    eventId,
    sequence,
    historyEffect: options.historyEffect,
    compensatingTemplateId: options.compensatingTemplateId ?? null,
    remoteRevisionRefJson,
    schemaVersion,
    restoreEligible: elig.eligible,
    restoreIneligibleReason: elig.reason,
    actorId: options.actor.actorId,
    actorKind: options.actor.actorKind,
    auditEventId: options.auditEventId ?? null,
    idempotencyKey,
    checksum,
    payloadHash: input.payloadHash ?? null,
  } satisfies CreateStmtArgs;

  const statement = isUpdate
    ? buildUpdateStatement({
        ...common,
        expectedBaseVersion: Number(expectedBaseVersion),
        beforeSnapshotJson: beforeSnapshotJson ?? "null",
      })
    : buildCreateStatement(common);

  let result: { rows: Array<Record<string, unknown>>; rowCount: number } | undefined;
  try {
    [result] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      transaction: true,
      queries: [statement],
    });
  } catch (e) {
    if (isCasAssertError(e)) {
      const current = readObjectRowForSnapshot(schema, id);
      throw casMissToVersionConflict(id, options.expectedBaseVersion, current, isUpdate);
    }
    throw e;
  }
  // With the cas_assert LEFT JOIN, when CAS hits we always get exactly one
  // row from cas_assert padded with the write columns. When CAS misses,
  // the SQL above raised and we already converted in the catch block.
  const row = result?.rows[0];
  if (!row || row.id == null) {
    const current = readObjectRowForSnapshot(schema, id);
    throw casMissToVersionConflict(id, options.expectedBaseVersion, current, isUpdate);
  }

  maybeAutoClose(autoOpened, handle, "single-mutation-close");

  const rowSnapshot = (row.row_json as Record<string, unknown>) ?? row;
  const finalVersion = Number(row.version);

  return {
    objectId: id,
    resultVersion: finalVersion,
    event: buildSyntheticEvent({
      eventId,
      changeSetId: handle.changeSetId,
      sequence,
      objectId: id,
      objectType: input.type,
      operation: isUpdate ? "update" : "create",
      historyEffect: options.historyEffect,
      beforeSnapshot,
      afterSnapshot: buildSnapshotFromRow(rowSnapshot),
      baseVersion: isUpdate ? Number(expectedBaseVersion) : null,
      resultVersion: finalVersion,
      schemaVersion,
      restoreEligible: elig.eligible,
      restoreIneligibleReason: elig.reason,
      compensatingTemplateId: options.compensatingTemplateId ?? null,
      remoteRevisionRef: options.remoteRevisionRef ?? null,
      actorId: options.actor.actorId,
      actorKind: options.actor.actorKind,
      runId: options.actor.runId ?? null,
      auditEventId: options.auditEventId ?? null,
      orgId: input.orgId ?? null,
      projectId,
      ownerLevel: (rowSnapshot?.owner_level as string | undefined) ?? null,
      ownerId: (rowSnapshot?.owner_id as string | undefined) ?? null,
      visibility: (rowSnapshot?.visibility as string | undefined) ?? null,
      idempotencyKey,
      checksum,
    }),
    changeSetId: handle.changeSetId,
    rowSnapshot,
  };
}

function buildSyntheticEvent(args: {
  eventId: string;
  changeSetId: string;
  sequence: number;
  objectId: string;
  objectType: string;
  operation: HistoryOperation;
  historyEffect: HistoryEffect;
  beforeSnapshot: ReturnType<typeof buildSnapshotFromRow>;
  afterSnapshot: ReturnType<typeof buildSnapshotFromRow>;
  baseVersion: number | null;
  resultVersion: number;
  schemaVersion: string;
  restoreEligible: boolean;
  restoreIneligibleReason: string | null;
  compensatingTemplateId: string | null;
  remoteRevisionRef: RemoteRevisionRef | null;
  actorId: string | null;
  actorKind: HistoryActor["actorKind"] | null;
  runId: string | null;
  auditEventId: string | null;
  orgId: string | null;
  projectId: string | null;
  ownerLevel: string | null;
  ownerId: string | null;
  visibility: string | null;
  idempotencyKey: string;
  checksum: string;
}): ObjectChangeEvent {
  return {
    id: args.eventId,
    changeSetId: args.changeSetId,
    sequence: args.sequence,
    objectId: args.objectId,
    objectType: args.objectType,
    operation: args.operation,
    historyEffect: args.historyEffect,
    beforeSnapshot: args.beforeSnapshot,
    afterSnapshot: args.afterSnapshot,
    baseVersion: args.baseVersion,
    resultVersion: args.resultVersion,
    objectSchemaVersion: args.schemaVersion,
    restoreEligible: args.restoreEligible,
    restoreIneligibleReason:
      (args.restoreIneligibleReason as ObjectChangeEvent["restoreIneligibleReason"]) ??
      null,
    compensatingTemplateId: args.compensatingTemplateId,
    remoteRevisionRef: args.remoteRevisionRef,
    actorId: args.actorId,
    actorKind: args.actorKind,
    runId: args.runId,
    auditEventId: args.auditEventId,
    orgId: args.orgId,
    projectId: args.projectId,
    ownerLevel: args.ownerLevel,
    ownerId: args.ownerId,
    visibility: args.visibility,
    idempotencyKey: args.idempotencyKey,
    eventChecksum: args.checksum,
    createdAt: new Date().toISOString(),
    tombstonedAt: null,
  };
}

export type HistoryAwareSoftDeleteInput = {
  objectId: string;
  orgId: string | null;
  type?: string;
};

export function historyAwareSoftDelete(
  input: HistoryAwareSoftDeleteInput,
  options: HistoryWriteOptions,
): HistoryAwareUpsertResult {
  ensurePostgresSchema();
  ensureActor(options.actor);
  ensureEffect(options.historyEffect, options.compensatingTemplateId);
  const schemaVersion = ensureSchemaVersion(options.objectSchemaVersion);
  const schema = postgresSchema.replaceAll('"', '""');

  if (options.expectedBaseVersion === null) {
    throw new HistoryWriterContractError(
      "missing-base-version",
      "historyAwareSoftDelete requires concrete expectedBaseVersion",
    );
  }
  const expectedBaseVersion = Number(options.expectedBaseVersion);

  const before = readObjectRowForSnapshot(schema, input.objectId);
  if (!before) {
    throw new VersionConflictError({
      objectId: input.objectId,
      currentVersion: null,
      expectedBaseVersion,
      latestSnapshot: null,
      conflictingFields: [],
      reason: "row-missing",
    });
  }
  const beforeSnapshot = buildSnapshotFromRow(before)!;

  const { handle, autoOpened } = autoChangeSet(options.actor, options.changeSet);
  const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey();
  const sequence = getNextEventSequence(handle.changeSetId);
  const eventId = randomUUID();

  const elig = eligibilityForEffect(
    options.historyEffect,
    options.compensatingTemplateId,
    schemaVersion,
  );
  const inputDataHash = hashInputData(null);
  const resultVersion = expectedBaseVersion + 1;
  const checksum = computeChecksum({
    objectId: input.objectId,
    operation: "soft-delete",
    historyEffect: options.historyEffect,
    baseVersion: expectedBaseVersion,
    resultVersion,
    idempotencyKey,
    inputDataHash,
  });

  const statement = buildSoftDeleteStatement({
    schema,
    id: input.objectId,
    orgId: input.orgId,
    expectedBaseVersion,
    beforeSnapshotJson: JSON.stringify(beforeSnapshot.payload),
    changeSetId: handle.changeSetId,
    eventId,
    sequence,
    historyEffect: options.historyEffect,
    compensatingTemplateId: options.compensatingTemplateId ?? null,
    remoteRevisionRefJson: options.remoteRevisionRef
      ? JSON.stringify(options.remoteRevisionRef)
      : null,
    schemaVersion,
    restoreEligible: elig.eligible,
    restoreIneligibleReason: elig.reason,
    actorId: options.actor.actorId,
    actorKind: options.actor.actorKind,
    runId: options.actor.runId ?? null,
    auditEventId: options.auditEventId ?? null,
    idempotencyKey,
    checksum,
  });

  let result: { rows: Array<Record<string, unknown>>; rowCount: number } | undefined;
  try {
    [result] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      transaction: true,
      queries: [statement],
    });
  } catch (e) {
    if (isCasAssertError(e)) {
      const current = readObjectRowForSnapshot(schema, input.objectId);
      throw new VersionConflictError({
        objectId: input.objectId,
        currentVersion: current ? Number(current.version) : null,
        expectedBaseVersion,
        latestSnapshot: buildSnapshotFromRow(current),
        conflictingFields: [],
        reason: current ? "concurrent-mutation" : "row-missing",
      });
    }
    throw e;
  }

  const row = result?.rows[0];
  if (!row || row.id == null) {
    const current = readObjectRowForSnapshot(schema, input.objectId);
    throw new VersionConflictError({
      objectId: input.objectId,
      currentVersion: current ? Number(current.version) : null,
      expectedBaseVersion,
      latestSnapshot: buildSnapshotFromRow(current),
      conflictingFields: [],
      reason: current ? "concurrent-mutation" : "row-missing",
    });
  }

  maybeAutoClose(autoOpened, handle, "soft-delete-close");

  const rowSnapshot = (row.row_json as Record<string, unknown>) ?? row;
  const finalVersion = Number(row.version);

  return {
    objectId: input.objectId,
    resultVersion: finalVersion,
    event: buildSyntheticEvent({
      eventId,
      changeSetId: handle.changeSetId,
      sequence,
      objectId: input.objectId,
      objectType: input.type ?? String(before.type ?? ""),
      operation: "soft-delete",
      historyEffect: options.historyEffect,
      beforeSnapshot,
      afterSnapshot: buildSnapshotFromRow(rowSnapshot),
      baseVersion: expectedBaseVersion,
      resultVersion: finalVersion,
      schemaVersion,
      restoreEligible: elig.eligible,
      restoreIneligibleReason: elig.reason,
      compensatingTemplateId: options.compensatingTemplateId ?? null,
      remoteRevisionRef: options.remoteRevisionRef ?? null,
      actorId: options.actor.actorId,
      actorKind: options.actor.actorKind,
      runId: options.actor.runId ?? null,
      auditEventId: options.auditEventId ?? null,
      orgId: input.orgId,
      projectId: (rowSnapshot?.project_id as string | undefined) ?? null,
      ownerLevel: (rowSnapshot?.owner_level as string | undefined) ?? null,
      ownerId: (rowSnapshot?.owner_id as string | undefined) ?? null,
      visibility: (rowSnapshot?.visibility as string | undefined) ?? null,
      idempotencyKey,
      checksum,
    }),
    changeSetId: handle.changeSetId,
    rowSnapshot,
  };
}

export type HistoryAwareTombstoneInput = {
  objectId: string;
  orgId: string | null;
  type?: string;
  privacyZeroFields?: readonly string[];
};

export function historyAwareTombstone(
  input: HistoryAwareTombstoneInput,
  options: HistoryWriteOptions,
): HistoryAwareUpsertResult {
  void input.privacyZeroFields;
  return historyAwareSoftDelete(
    {
      objectId: input.objectId,
      orgId: input.orgId,
      type: input.type,
    },
    options,
  );
}

export type HistoryAwareUndeleteInput = {
  objectId: string;
  orgId: string | null;
  type?: string;
  restoredData: unknown;
};

export function historyAwareUndelete(
  input: HistoryAwareUndeleteInput,
  options: HistoryWriteOptions,
): HistoryAwareUpsertResult {
  ensurePostgresSchema();
  ensureActor(options.actor);
  const schemaVersion = ensureSchemaVersion(options.objectSchemaVersion);
  const schema = postgresSchema.replaceAll('"', '""');

  if (options.expectedBaseVersion === null) {
    throw new HistoryWriterContractError(
      "missing-base-version",
      "historyAwareUndelete requires concrete expectedBaseVersion",
    );
  }
  const expectedBaseVersion = Number(options.expectedBaseVersion);

  const before = readObjectRowForSnapshot(schema, input.objectId);
  if (!before) {
    throw new VersionConflictError({
      objectId: input.objectId,
      currentVersion: null,
      expectedBaseVersion,
      latestSnapshot: null,
      conflictingFields: [],
      reason: "row-missing",
    });
  }
  if (before.deleted_at == null) {
    throw new HistoryWriterContractError(
      "invalid-effect",
      "historyAwareUndelete: row is not soft-deleted",
    );
  }
  const beforeSnapshot = buildSnapshotFromRow(before)!;

  const { handle, autoOpened } = autoChangeSet(options.actor, options.changeSet);
  const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey();
  const sequence = getNextEventSequence(handle.changeSetId);
  const eventId = randomUUID();

  const inputDataHash = hashInputData(input.restoredData);
  const resultVersion = expectedBaseVersion + 1;
  const checksum = computeChecksum({
    objectId: input.objectId,
    operation: "restore",
    historyEffect: "reversible-internal",
    baseVersion: expectedBaseVersion,
    resultVersion,
    idempotencyKey,
    inputDataHash,
  });

  const statement = buildUndeleteStatement({
    schema,
    id: input.objectId,
    orgId: input.orgId,
    expectedBaseVersion,
    restoredData: input.restoredData,
    beforeSnapshotJson: JSON.stringify(beforeSnapshot.payload),
    changeSetId: handle.changeSetId,
    eventId,
    sequence,
    schemaVersion,
    actorId: options.actor.actorId,
    actorKind: options.actor.actorKind,
    runId: options.actor.runId ?? null,
    auditEventId: options.auditEventId ?? null,
    idempotencyKey,
    checksum,
  });

  let result: { rows: Array<Record<string, unknown>>; rowCount: number } | undefined;
  try {
    [result] = runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      transaction: true,
      queries: [statement],
    });
  } catch (e) {
    if (isCasAssertError(e)) {
      const current = readObjectRowForSnapshot(schema, input.objectId);
      throw new VersionConflictError({
        objectId: input.objectId,
        currentVersion: current ? Number(current.version) : null,
        expectedBaseVersion,
        latestSnapshot: buildSnapshotFromRow(current),
        conflictingFields: [],
        reason: current ? "concurrent-mutation" : "row-missing",
      });
    }
    throw e;
  }
  const row = result?.rows[0];
  if (!row || row.id == null) {
    const current = readObjectRowForSnapshot(schema, input.objectId);
    throw new VersionConflictError({
      objectId: input.objectId,
      currentVersion: current ? Number(current.version) : null,
      expectedBaseVersion,
      latestSnapshot: buildSnapshotFromRow(current),
      conflictingFields: [],
      reason: current ? "concurrent-mutation" : "row-missing",
    });
  }
  maybeAutoClose(autoOpened, handle, "undelete-close");

  const rowSnapshot = (row.row_json as Record<string, unknown>) ?? row;
  const finalVersion = Number(row.version);
  return {
    objectId: input.objectId,
    resultVersion: finalVersion,
    event: buildSyntheticEvent({
      eventId,
      changeSetId: handle.changeSetId,
      sequence,
      objectId: input.objectId,
      objectType: input.type ?? String(before.type ?? ""),
      operation: "restore",
      historyEffect: "reversible-internal",
      beforeSnapshot,
      afterSnapshot: buildSnapshotFromRow(rowSnapshot),
      baseVersion: expectedBaseVersion,
      resultVersion: finalVersion,
      schemaVersion,
      restoreEligible: true,
      restoreIneligibleReason: null,
      compensatingTemplateId: null,
      remoteRevisionRef: null,
      actorId: options.actor.actorId,
      actorKind: options.actor.actorKind,
      runId: options.actor.runId ?? null,
      auditEventId: options.auditEventId ?? null,
      orgId: input.orgId,
      projectId: (rowSnapshot?.project_id as string | undefined) ?? null,
      ownerLevel: (rowSnapshot?.owner_level as string | undefined) ?? null,
      ownerId: (rowSnapshot?.owner_id as string | undefined) ?? null,
      visibility: (rowSnapshot?.visibility as string | undefined) ?? null,
      idempotencyKey,
      checksum,
    }),
    changeSetId: handle.changeSetId,
    rowSnapshot,
  };
}
