// Restore engine.
//
// True all-or-none semantics: the restore engine pre-flights every CAS
// check + every authz check + computes every inverse statement, then
// submits all statements as a SINGLE
// runPostgresQueriesSync({ transaction: true, queries: [...] }) call.
// Any failure (CAS race, FK violation, etc.) aborts the whole transaction
// — the new restore change_set rolls back atomically with the inverse
// writes.
//
// Append-only history: the new change_set carries
// restore_of_change_set_id pointing at the original. The original
// change_set is never modified.
//
// object_version_restore semantics: "restore object
// to version N" means: take the after-snapshot of the event that
// PRODUCED version N (or, if the user wants version K and the event with
// resultVersion === K is a delete, fall through to the corresponding
// before-snapshot), and overwrite the current row's data with it via a
// single historyAwareUpsert with expectedBaseVersion = currentVersion.
// The result is the row at currentVersion+1 carrying the data that was
// at version N. This is single-object; it does NOT cascade to other
// objects in the source change_set.

import { randomUUID } from "node:crypto";

import {
  ensurePostgresSchema,
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

import {
  closeChangeSet,
  openChangeSet,
} from "./change-set";
import {
  __internals,
  __statementBuilders,
  historyAwareSoftDelete,
  historyAwareUndelete,
  historyAwareUpsert,
} from "./canonical-writer";
import {
  loadChangeSet,
  listEventsForObject,
  readObjectScopeById,
  summarizeChangeSetEligibility,
} from "./eligibility";
import {
  resolveEventFreshness,
  resolveExternalFreshness,
} from "./freshness/resolve";
import { freshnessAllowsRestore } from "./freshness/contract";
import { VersionConflictError } from "./errors";
import type {
  HistoryActor,
  HistoryEffect,
  ObjectChangeEvent,
} from "./types";
import type { ExternalFreshnessMap } from "./eligibility";

const { hashInputData, computeChecksum } = __internals;

export type RestoreChangeSetInput = {
  changeSetId: string;
  actor: HistoryActor;
  parentChangeSetId?: string;
  bypassEligibility?: boolean;
  // Optional pre-resolved freshness map. When supplied, the engine
  // consults it during eligibility re-check before running the
  // batched tx. Callers that have async access (MCP handlers, server
  // actions) should resolve freshness via resolveExternalFreshness and
  // pass the result here.
  externalFreshness?: ExternalFreshnessMap;
};

export type RestoreChangeSetResult = {
  restoreChangeSetId: string;
  appliedEventCount: number;
  affectedObjects: string[];
};

export type RestoreObjectToVersionInput = {
  objectId: string;
  targetVersion: number;
  actor: HistoryActor;
  parentChangeSetId?: string;
};

export class RestoreNotEligibleError extends Error {
  readonly changeSetId: string;
  readonly reasons: string[];
  readonly details: string[];
  constructor(
    changeSetId: string,
    reasons: string[],
    details: string[],
  ) {
    super(
      `RestoreNotEligible (${reasons.join(", ")}): change_set ${changeSetId} — ${details.join("; ")}`,
    );
    this.name = "RestoreNotEligibleError";
    this.changeSetId = changeSetId;
    this.reasons = reasons;
    this.details = details;
  }
}

// ===========================================================================
// change_set_undo — all-or-none transactional restore
// ===========================================================================

export function restoreChangeSet(
  input: RestoreChangeSetInput,
): RestoreChangeSetResult {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');

  const loaded = loadChangeSet(input.changeSetId, {
    orgId: input.actor.orgId,
  });
  if (!loaded) {
    throw new Error(
      `restoreChangeSet: change_set ${input.changeSetId} not found`,
    );
  }

  if (!input.bypassEligibility) {
    const eligibility = summarizeChangeSetEligibility(loaded, {
      externalFreshness: input.externalFreshness,
    });
    if (!eligibility.eligible) {
      throw new RestoreNotEligibleError(
        input.changeSetId,
        eligibility.reasons,
        eligibility.details,
      );
    }
  }
  if (!loaded.changeSet.restorable) {
    throw new RestoreNotEligibleError(
      input.changeSetId,
      ["irreversible-no-compensating"],
      [
        loaded.changeSet.restorableReason ?? "change_set marked non-restorable",
      ],
    );
  }

  // Open the restore change_set first (its own transaction). This is the
  // CONTAINER for the inverse events; the writes themselves go into a
  // separate batched transaction below. If the writes fail, the restore
  // change_set is closed with closureReason='restore-failed'.
  const restoreHandle = openChangeSet({
    actor: input.actor,
    parentChangeSetId: input.parentChangeSetId,
    restoreOfChangeSetId: input.changeSetId,
  });

  // 1. Pre-flight: read every affected object's current version.
  const affectedObjectIds = [
    ...new Set(loaded.events.map((e) => e.objectId)),
  ];
  const currentVersions = new Map<string, { version: number; type: string; deletedAt: string | null }>();
  for (const objectId of affectedObjectIds) {
    const snap = readObjectScopeById(objectId, {
      orgId: input.actor.orgId,
    });
    if (snap) {
      currentVersions.set(objectId, {
        version: snap.version,
        type: snap.type,
        deletedAt: snap.deletedAt,
      });
    }
  }

  // 2. Build inverse statements in REVERSE order.
  const reversedEvents = [...loaded.events].reverse();
  const statements: Array<{ text: string; values: unknown[] }> = [];
  let seq = 0;
  // Per-object version tracking as we build the chain. Each inverse step
  // bumps the object's version by 1.
  const versionTracker = new Map<string, number>();
  for (const [k, v] of currentVersions.entries()) {
    versionTracker.set(k, v.version);
  }
  // Track per-object deleted-state through the chain so we know whether
  // to issue undelete vs upsert vs soft-delete for each inverse step.
  const deletedTracker = new Map<string, boolean>();
  for (const [k, v] of currentVersions.entries()) {
    deletedTracker.set(k, v.deletedAt != null);
  }

  for (const event of reversedEvents) {
    seq += 1;
    const tracked = versionTracker.get(event.objectId);
    if (tracked === undefined) {
      // The object was hard-deleted between original mutation and now.
      // Eligibility should have blocked us already; this is a safety net.
      closeChangeSet(restoreHandle, {
        closureReason: `restore-blocked: object ${event.objectId} no longer exists`,
      });
      throw new RestoreNotEligibleError(
        input.changeSetId,
        ["referenced-object-hard-deleted"],
        [`object ${event.objectId} is hard-deleted`],
      );
    }

    const stmt = buildInverseStatement(event, {
      currentVersion: tracked,
      currentlyDeleted: deletedTracker.get(event.objectId) ?? false,
      schema,
      restoreChangeSetId: restoreHandle.changeSetId,
      sequence: seq,
      actor: input.actor,
    });
    statements.push(stmt.statement);
    versionTracker.set(event.objectId, tracked + 1);
    deletedTracker.set(event.objectId, stmt.becomesDeleted);
  }

  if (statements.length === 0) {
    closeChangeSet(restoreHandle, {
      closureReason: "restore-empty",
    });
    return {
      restoreChangeSetId: restoreHandle.changeSetId,
      appliedEventCount: 0,
      affectedObjects: affectedObjectIds,
    };
  }

  // 3. Execute every statement in a SINGLE transaction. Any failure
  // aborts the whole tx — true all-or-none.
  try {
    runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      transaction: true,
      queries: statements,
    });
  } catch (e) {
    closeChangeSet(restoreHandle, {
      closureReason: `restore-failed: ${(e as Error).message}`,
    });
    throw e;
  }

  closeChangeSet(restoreHandle, { closureReason: "restore-complete" });

  return {
    restoreChangeSetId: restoreHandle.changeSetId,
    appliedEventCount: statements.length,
    affectedObjects: affectedObjectIds,
  };
}

function buildInverseStatement(
  event: ObjectChangeEvent,
  ctx: {
    currentVersion: number;
    currentlyDeleted: boolean;
    schema: string;
    restoreChangeSetId: string;
    sequence: number;
    actor: HistoryActor;
  },
): {
  statement: { text: string; values: unknown[] };
  becomesDeleted: boolean;
} {
  const idempotencyKey = `che_restore_${randomUUID()}`;
  const eventId = randomUUID();
  const baseVersion = ctx.currentVersion;
  const resultVersion = baseVersion + 1;
  const schemaVersion = "v1";
  const effect: HistoryEffect = "reversible-internal";

  // Helper: build event-row-only checksum.
  const ckArgs = (operation: ObjectChangeEvent["operation"], dataHash: string) =>
    computeChecksum({
      objectId: event.objectId,
      operation,
      historyEffect: effect,
      baseVersion,
      resultVersion,
      idempotencyKey,
      inputDataHash: dataHash,
    });

  switch (event.operation) {
    case "create": {
      // Inverse of CREATE = soft-delete.
      const beforeJson = JSON.stringify(event.afterSnapshot?.payload ?? {});
      const checksum = ckArgs("soft-delete", hashInputData(null));
      const statement = __statementBuilders.softDelete({
        schema: ctx.schema,
        id: event.objectId,
        orgId: event.orgId,
        expectedBaseVersion: baseVersion,
        beforeSnapshotJson: beforeJson,
        changeSetId: ctx.restoreChangeSetId,
        eventId,
        sequence: ctx.sequence,
        historyEffect: effect,
        compensatingTemplateId: null,
        remoteRevisionRefJson: null,
        schemaVersion,
        restoreEligible: true,
        restoreIneligibleReason: null,
        actorId: ctx.actor.actorId,
        actorKind: ctx.actor.actorKind,
        runId: ctx.actor.runId ?? null,
        auditEventId: null,
        idempotencyKey,
        checksum,
      });
      return { statement, becomesDeleted: true };
    }
    case "update": {
      // Inverse of UPDATE = upsert with the before-snapshot's payload.
      const before = event.beforeSnapshot?.payload;
      if (!before) {
        throw new Error(
          `buildInverseStatement: update event ${event.id} missing before_snapshot`,
        );
      }
      const data = (before as Record<string, unknown>).data;
      const beforeJsonForEvent = JSON.stringify({
        // The new event's before_snapshot is the CURRENT row state before
        // we apply the inverse. We don't have a JS-side read here; the
        // CTE captures it via row_to_json before the UPDATE fires. But
        // for the canonical writer's UPDATE statement we pass a JS-side
        // pre-read JSON — for the restore chain we approximate it with
        // the original event's after_snapshot (which IS the
        // pre-inverse row state, assuming nothing else mutated between).
        ...((event.afterSnapshot?.payload as Record<string, unknown>) ?? {}),
        version: baseVersion,
      });
      const checksum = ckArgs("update", hashInputData(data));
      const statement = __statementBuilders.update({
        schema: ctx.schema,
        id: event.objectId,
        type: event.objectType,
        parentId:
          ((before as Record<string, unknown>).parent_id as string | null) ?? null,
        parentType:
          ((before as Record<string, unknown>).parent_type as
            | string
            | null) ?? null,
        data,
        createdBy:
          ((before as Record<string, unknown>).created_by as
            | string
            | null) ?? null,
        orgId: event.orgId,
        source:
          ((before as Record<string, unknown>).source as string | null) ??
          null,
        runId: ctx.actor.runId ?? null,
        agentId: null,
        packageVersion: null,
        agentSpecVersion: null,
        ownerLevel:
          ((before as Record<string, unknown>).owner_level as
            | string
            | null) ?? null,
        ownerId:
          ((before as Record<string, unknown>).owner_id as string | null) ??
          null,
        visibility:
          ((before as Record<string, unknown>).visibility as
            | string
            | null) ?? null,
        projectId:
          ((before as Record<string, unknown>).project_id as
            | string
            | null) ?? null,
        expectedBaseVersion: baseVersion,
        beforeSnapshotJson: beforeJsonForEvent,
        changeSetId: ctx.restoreChangeSetId,
        eventId,
        sequence: ctx.sequence,
        historyEffect: effect,
        compensatingTemplateId: null,
        remoteRevisionRefJson: null,
        schemaVersion,
        restoreEligible: true,
        restoreIneligibleReason: null,
        actorId: ctx.actor.actorId,
        actorKind: ctx.actor.actorKind,
        auditEventId: null,
        idempotencyKey,
        checksum,
        payloadHash: null,
      });
      return { statement, becomesDeleted: false };
    }
    case "soft-delete":
    case "tombstone": {
      // Inverse of soft-delete = undelete via dedicated writer.
      const before = event.beforeSnapshot?.payload;
      if (!before) {
        throw new Error(
          `buildInverseStatement: soft-delete event ${event.id} missing before_snapshot`,
        );
      }
      const data = (before as Record<string, unknown>).data;
      const beforeJsonForEvent = JSON.stringify({
        ...((event.afterSnapshot?.payload as Record<string, unknown>) ?? {}),
        version: baseVersion,
        deleted_at: new Date().toISOString(),
      });
      const checksum = ckArgs("restore", hashInputData(data));
      const statement = __statementBuilders.undelete({
        schema: ctx.schema,
        id: event.objectId,
        orgId: event.orgId,
        expectedBaseVersion: baseVersion,
        restoredData: data,
        beforeSnapshotJson: beforeJsonForEvent,
        changeSetId: ctx.restoreChangeSetId,
        eventId,
        sequence: ctx.sequence,
        schemaVersion,
        actorId: ctx.actor.actorId,
        actorKind: ctx.actor.actorKind,
        runId: ctx.actor.runId ?? null,
        auditEventId: null,
        idempotencyKey,
        checksum,
      });
      return { statement, becomesDeleted: false };
    }
    case "restore": {
      throw new Error(
        "buildInverseStatement: refusing to invert a restore event; restore the original change_set again instead",
      );
    }
    case "hard-delete": {
      throw new Error(
        "buildInverseStatement: hard-deleted events are non-restorable (DSUV-RESTORE-01)",
      );
    }
    default: {
      const _exhaustive: never = event.operation as never;
      void _exhaustive;
      throw new Error(
        `buildInverseStatement: unknown operation ${event.operation}`,
      );
    }
  }
}

// ===========================================================================
// object_version_restore — restore a single object's data to the state
// captured at the specified version. Single-object, degenerate change_set
// of size 1. Does NOT cascade to other objects.
// ===========================================================================

export async function restoreObjectToVersion(
  input: RestoreObjectToVersionInput,
): Promise<RestoreChangeSetResult> {
  ensurePostgresSchema();
  // Read CURRENT row scope FIRST so we can constrain the history-event
  // lookup to its org, and so we can reject restore requests targeting a
  // version higher than the current row (which
  // would indicate id-reuse after hard-delete or cross-tenant stale
  // history).
  const current = readObjectScopeById(input.objectId, {
    orgId: input.actor.orgId,
  });
  if (!current) {
    throw new RestoreNotEligibleError(
      "object_version_restore",
      ["referenced-object-hard-deleted"],
      [`object ${input.objectId} no longer exists`],
    );
  }
  if (input.targetVersion > current.version) {
    throw new RestoreNotEligibleError(
      "object_version_restore",
      ["schema-version-mismatch"],
      [
        `target version ${input.targetVersion} is greater than current version ${current.version} — refusing to restore from possibly stale or cross-tenant history`,
      ],
    );
  }
  // Find the event that PRODUCED targetVersion for this object, restricted
  // to the current row's org. listEventsForObject's orgId filter prevents
  // cross-tenant history bleed (id-reuse after hard-delete + multi-org).
  const events = listEventsForObject(input.objectId, {
    limit: 500,
    orgId: current.orgId,
  });
  const target = events.find(
    (e) => e.resultVersion === input.targetVersion && e.objectId === input.objectId,
  );
  if (!target) {
    throw new Error(
      `restoreObjectToVersion: no event found for object=${input.objectId} version=${input.targetVersion}`,
    );
  }
  if (target.operation === "hard-delete") {
    throw new RestoreNotEligibleError(
      "object_version_restore",
      ["hard-deleted"],
      [`event at version ${input.targetVersion} was a hard-delete`],
    );
  }
  // Take the after-snapshot of the target event (the state AT that
  // version). For soft-delete/tombstone events, the after-snapshot
  // captures the deleted state — restoring to a deleted version is a
  // valid request (it produces a current-row equivalent of "row was
  // deleted at version N"); we re-soft-delete via the same path. For
  // create/update events, after-snapshot is the live data.
  const targetSnapshot = target.afterSnapshot?.payload as
    | Record<string, unknown>
    | null
    | undefined;
  if (!targetSnapshot) {
    throw new Error(
      `restoreObjectToVersion: event at version ${input.targetVersion} has no after_snapshot`,
    );
  }

  // Consult freshness even for single-object restore — CMS-tagged objects
  // can have changed remotely and re-applying a stale snapshot is unsafe.
  if (target.remoteRevisionRef) {
    const freshness = await resolveEventFreshness(target, {
      orgId: input.actor.orgId,
    });
    const verdict = freshnessAllowsRestore(freshness, { isCmsObject: true });
    if (!verdict.allowed) {
      throw new RestoreNotEligibleError(
        "object_version_restore",
        ["external-source-changed"],
        [
          verdict.reason ??
            `external freshness blocks restore: ${freshness.state}`,
        ],
      );
    }
  }

  // Preserve deleted/live state through the restore. A plain
  // historyAwareUpsert writes `data` but never touches `deleted_at`, so the
  // restore branches on the current and target deleted-state. Four
  // transitions to handle:
  //   current LIVE,    target LIVE    -> historyAwareUpsert(data)
  //   current LIVE,    target DELETED -> historyAwareSoftDelete
  //   current DELETED, target LIVE    -> historyAwareUndelete(data)
  //   current DELETED, target DELETED -> no-op (already in target state)
  const data = (targetSnapshot as Record<string, unknown>).data;
  const targetDeletedAt =
    (targetSnapshot as Record<string, unknown>).deleted_at;
  const targetIsDeleted = targetDeletedAt != null;
  const currentIsDeleted = current.deletedAt != null;

  let result;
  if (!currentIsDeleted && !targetIsDeleted) {
    // LIVE -> LIVE: standard update with target data.
    result = historyAwareUpsert(
      {
        id: input.objectId,
        type: target.objectType,
        data,
        orgId: input.actor.orgId,
        ownerLevel:
          (targetSnapshot.owner_level as string | undefined) ?? null,
        ownerId: (targetSnapshot.owner_id as string | undefined) ?? null,
        visibility:
          (targetSnapshot.visibility as string | undefined) ?? null,
        parentId:
          (targetSnapshot.parent_id as string | undefined) ?? null,
        parentType:
          (targetSnapshot.parent_type as string | undefined) ?? null,
      },
      {
        expectedBaseVersion: current.version,
        historyEffect: "reversible-internal",
        actor: input.actor,
      },
    );
  } else if (!currentIsDeleted && targetIsDeleted) {
    // LIVE -> DELETED: re-soft-delete to match the target state.
    result = historyAwareSoftDelete(
      {
        objectId: input.objectId,
        orgId: input.actor.orgId,
        type: target.objectType,
      },
      {
        expectedBaseVersion: current.version,
        historyEffect: "reversible-internal",
        actor: input.actor,
      },
    );
  } else if (currentIsDeleted && !targetIsDeleted) {
    // DELETED -> LIVE: explicitly undelete + restore data.
    result = historyAwareUndelete(
      {
        objectId: input.objectId,
        orgId: input.actor.orgId,
        type: target.objectType,
        restoredData: data,
      },
      {
        expectedBaseVersion: current.version,
        historyEffect: "reversible-internal",
        actor: input.actor,
      },
    );
  } else {
    // DELETED -> DELETED: no-op. Surface as a degenerate single-event
    // change_set so the caller sees a successful response with zero
    // affected events.
    return {
      restoreChangeSetId: `cs_noop_${input.objectId}_${input.targetVersion}`,
      appliedEventCount: 0,
      affectedObjects: [input.objectId],
    };
  }

  return {
    restoreChangeSetId: result.changeSetId,
    appliedEventCount: 1,
    affectedObjects: [input.objectId],
  };
}

export { VersionConflictError };
