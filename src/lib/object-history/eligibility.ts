// Restore eligibility computation.
//
// Eligibility is computed AT RESTORE-TIME (not just write-time) because:
//   - referenced-object reachability can shift after close
//   - retention can expire (PoC default `indefinite` never does, but the
//     code path is the same)
//   - external freshness can change
//
// The write-time `restore_eligible` flag is a fast-path hint; the restore
// engine re-evaluates here. Eligibility surfaces the SPECIFIC block reason
// for UI rendering.

import {
  ensurePostgresSchema,
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

import { freshnessAllowsRestore } from "./freshness/contract";
import { getRetentionPolicy } from "./retention-policy";
import type {
  HistoryEffect,
  ObjectChangeEvent,
  RestoreIneligibleReason,
} from "./types";

export type EligibilityVerdict = {
  eligible: boolean;
  reason: RestoreIneligibleReason | "ok";
  details: string;
};

export type ChangeSetEligibilitySummary = {
  eligible: boolean;
  reasons: RestoreIneligibleReason[];
  details: string[];
  perEvent: Array<{
    eventId: string;
    objectId: string;
    eligible: boolean;
    reason: RestoreIneligibleReason | "ok";
    details: string;
  }>;
};

const SUPPORTED_SCHEMA_VERSIONS = new Set(["v1"]);

// Cross-stamp: a per-restore-call freshness override map keyed by objectId.
// External freshness plugs in by passing a precomputed map.
export type ExternalFreshnessMap = ReadonlyMap<
  string,
  | { state: "unsupported" }
  | { state: "unknown"; reason?: string }
  | { state: "missing" }
  | { state: "changed"; baseRevision: string; changedFields?: readonly string[] }
  | { state: "fresh"; baseRevision: string }
>;

export function checkEventEligibility(
  event: Pick<
    ObjectChangeEvent,
    | "objectId"
    | "objectType"
    | "operation"
    | "historyEffect"
    | "objectSchemaVersion"
    | "compensatingTemplateId"
    | "restoreEligible"
    | "restoreIneligibleReason"
  > & {
    // Optional — when set, signals the event has a remote source-of-
    // truth and the freshness contract applies. When absent, unsupported
    // freshness verdicts fall through as eligible.
    remoteRevisionRef?: ObjectChangeEvent["remoteRevisionRef"];
  },
  context: {
    externalFreshness?: ExternalFreshnessMap;
    referencedObjectsReachable?: ReadonlyMap<
      string,
      "ok" | "hard-deleted" | "archived-project" | "unwritable"
    >;
  } = {},
): EligibilityVerdict {
  // 1. Schema version compat.
  if (!SUPPORTED_SCHEMA_VERSIONS.has(event.objectSchemaVersion)) {
    return {
      eligible: false,
      reason: "schema-version-mismatch",
      details: `object_schema_version=${event.objectSchemaVersion} not supported`,
    };
  }

  // 2. Effect-class gate.
  if (event.historyEffect === "irreversible-logged") {
    return {
      eligible: false,
      reason: "irreversible-no-compensating",
      details: "irreversible-logged events require a compensating-action template",
    };
  }
  if (event.historyEffect === "compensating-action") {
    if (!event.compensatingTemplateId) {
      return {
        eligible: false,
        reason: "irreversible-no-compensating",
        details: "compensating-action event missing template id",
      };
    }
    // For PoC, the compensating template is assumed approved when present.
    // A future ops milestone hardens "approved" via a registry check.
  }

  // 3. Hard-delete ineligibility. For hard-delete events,
  // the row is gone — only tombstones with snapshots are restorable.
  if (event.operation === "hard-delete") {
    return {
      eligible: false,
      reason: "hard-deleted",
      details: "hard-delete events are not restorable",
    };
  }

  // 4. Retention. PoC default = indefinite, so this never blocks today, but
  // keep the wiring so future ops milestone slots in.
  const policy = getRetentionPolicy(event.objectType);
  if (policy.kind === "duration") {
    // Eligibility re-evaluates retention here. A duration-based policy with
    // a past expiry yields retention-expired. The age check is owned by the
    // caller passing a `currentAgeDays` — for the PoC we always pass
    // undefined, so this stays false.
  }

  // 5. Referenced-object reachability.
  const refs = context.referencedObjectsReachable;
  if (refs) {
    for (const [refId, status] of refs) {
      if (status === "hard-deleted") {
        return {
          eligible: false,
          reason: "referenced-object-hard-deleted",
          details: `referenced object ${refId} is hard-deleted`,
        };
      }
      if (status === "archived-project") {
        return {
          eligible: false,
          reason: "referenced-object-archived-project",
          details: `referenced object ${refId} is in an archived project`,
        };
      }
      if (status === "unwritable") {
        return {
          eligible: false,
          reason: "referenced-object-unwritable",
          details: `referenced object ${refId} is not writable by current actor`,
        };
      }
    }
  }

  // 6. External freshness. Routes through the contract's
  // freshnessAllowsRestore decision rule:
  //   - missing/changed/unknown -> block
  //   - fresh -> allow
  //   - unsupported -> block for CMS-tagged events, allow otherwise
  const freshness = context.externalFreshness?.get(event.objectId);
  if (freshness) {
    // CMS-tagged signal: the event carries a remoteRevisionRef. Explicit
    // `null` means the event is local-only (no remote source-of-truth).
    // `undefined` means the field was not supplied — default to TRUE
    // (treat as CMS) so the safer decision applies.
    const isCmsObject = event.remoteRevisionRef !== null;
    const verdict = freshnessAllowsRestore(freshness, { isCmsObject });
    if (!verdict.allowed) {
      const reason: RestoreIneligibleReason =
        freshness.state === "missing"
          ? "external-source-missing"
          : freshness.state === "changed"
            ? "external-source-changed"
            : "external-source-unknown";
      return {
        eligible: false,
        reason,
        details:
          verdict.reason ??
          `remote freshness blocks restore: ${freshness.state}${
            freshness.state === "changed" && freshness.changedFields
              ? ` (fields: ${freshness.changedFields.join(", ")})`
              : ""
          }`,
      };
    }
  }

  // Honour the write-time flag if it explicitly blocked.
  if (!event.restoreEligible && event.restoreIneligibleReason) {
    return {
      eligible: false,
      reason: event.restoreIneligibleReason,
      details: "write-time eligibility check rejected this event",
    };
  }

  return { eligible: true, reason: "ok", details: "" };
}

// ---------------------------------------------------------------------------
// Per-version restore eligibility gate.
//
// Whether to RENDER the inline "Restore to this version" button on a single
// history event. Composes the full per-event eligibility verdict with the
// presence of an after-snapshot to restore from. An event with no
// after-snapshot (hard-delete, or a malformed event) is never restore-eligible
// — the restore engine has nothing to re-apply. Kept here in eligibility.ts
// (not restore-engine) because this is a verdict, not an engine action.
// ---------------------------------------------------------------------------
export function isEventRestoreEligible(
  event: Pick<
    ObjectChangeEvent,
    | "objectId"
    | "objectType"
    | "operation"
    | "historyEffect"
    | "objectSchemaVersion"
    | "compensatingTemplateId"
    | "restoreEligible"
    | "restoreIneligibleReason"
    | "afterSnapshot"
  > & { remoteRevisionRef?: ObjectChangeEvent["remoteRevisionRef"] },
  context: Parameters<typeof checkEventEligibility>[1] = {},
): EligibilityVerdict {
  if (event.afterSnapshot == null) {
    return {
      eligible: false,
      reason: "hard-deleted",
      details: "event has no after-snapshot to restore from",
    };
  }
  return checkEventEligibility(event, context);
}

export type LoadedChangeSet = {
  changeSet: {
    id: string;
    restorable: boolean;
    restorableReason: string | null;
    effectRollup: HistoryEffect;
    orgId: string | null;
    closedAt: string | null;
    closureReason: string | null;
    openedAt: string;
  };
  events: ObjectChangeEvent[];
};

export function loadChangeSet(
  changeSetId: string,
  options: { orgId?: string | null } = {},
): LoadedChangeSet | null {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  // When orgId is supplied, constrain the change_set
  // lookup to that org so cross-tenant change_set ids cannot leak. Null /
  // undefined orgId is the unauthenticated / dev-bypass path and reads
  // any org.
  const orgFilter =
    options.orgId !== undefined && options.orgId !== null
      ? " AND (org_id = $2 OR org_id IS NULL)"
      : "";
  const csValues = orgFilter ? [changeSetId, options.orgId] : [changeSetId];
  const [csResult, eventsResult] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, restorable, restorable_reason, effect_rollup, org_id,
                      opened_at, closed_at, closure_reason
               FROM "${schema}"."change_set"
               WHERE id = $1${orgFilter}`,
        values: csValues,
      },
      {
        text: `SELECT id, change_set_id, sequence, object_id, object_type,
                      operation, history_effect, before_snapshot, after_snapshot,
                      base_version, result_version, object_schema_version,
                      restore_eligible, restore_ineligible_reason,
                      compensating_template_id, remote_revision_ref,
                      actor_id, actor_kind, run_id, audit_event_id,
                      org_id, project_id, owner_level, owner_id, visibility,
                      idempotency_key, event_checksum, created_at, tombstoned_at
               FROM "${schema}"."object_change_event"
               WHERE change_set_id = $1${orgFilter}
               ORDER BY sequence ASC`,
        values: csValues,
      },
    ],
  });
  const csRow = csResult?.rows[0];
  if (!csRow) return null;
  return {
    changeSet: {
      id: String(csRow.id),
      restorable: csRow.restorable === true,
      restorableReason:
        csRow.restorable_reason == null ? null : String(csRow.restorable_reason),
      effectRollup: String(csRow.effect_rollup) as HistoryEffect,
      orgId: csRow.org_id == null ? null : String(csRow.org_id),
      openedAt:
        csRow.opened_at instanceof Date
          ? csRow.opened_at.toISOString()
          : String(csRow.opened_at ?? ""),
      closedAt:
        csRow.closed_at instanceof Date
          ? csRow.closed_at.toISOString()
          : csRow.closed_at == null
            ? null
            : String(csRow.closed_at),
      closureReason:
        csRow.closure_reason == null ? null : String(csRow.closure_reason),
    },
    events: (eventsResult?.rows ?? []).map(rowToEvent),
  };
}

export type ObjectScopeSnapshot = {
  id: string;
  type: string;
  orgId: string | null;
  ownerLevel: string | null;
  ownerId: string | null;
  visibility: string | null;
  projectId: string | null;
  version: number;
  deletedAt: string | null;
};

// Lightweight reader used by the MCP handlers to fetch the current scope
// of an object without pulling in the host-app objects-store and its
// transitive authz/derived-store-ownership chain. Tests stub the host
// module through vitest aliases; this helper stays inside object-history
// so the consuming MCP package doesn't take the deep dependency.
export function readObjectScopeById(
  objectId: string,
  scope: { orgId: string | null },
): ObjectScopeSnapshot | null {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, type, org_id, owner_level, owner_id, visibility,
                      project_id, version, deleted_at
               FROM "${schema}"."objects"
               WHERE id = $1
                 AND (org_id = $2 OR $2 IS NULL OR org_id IS NULL)`,
        values: [objectId, scope.orgId],
      },
    ],
  });
  const row = result?.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    type: String(row.type),
    orgId: row.org_id == null ? null : String(row.org_id),
    ownerLevel: row.owner_level == null ? null : String(row.owner_level),
    ownerId: row.owner_id == null ? null : String(row.owner_id),
    visibility: row.visibility == null ? null : String(row.visibility),
    projectId: row.project_id == null ? null : String(row.project_id),
    version: Number(row.version),
    deletedAt:
      row.deleted_at instanceof Date
        ? row.deleted_at.toISOString()
        : row.deleted_at == null
          ? null
          : String(row.deleted_at),
  };
}

export function listEventsForObject(
  objectId: string,
  options: { limit?: number; orgId?: string | null } = {},
): ObjectChangeEvent[] {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  // Filter by org so a request from org A cannot read
  // events whose org_id is org B (id-reuse after hard-delete; cross-tenant
  // stale history). When orgId is null we treat the request as
  // unauthenticated/dev-bypass and read all rows; when set we constrain.
  const orgFilter = options.orgId !== undefined && options.orgId !== null
    ? " AND (org_id = $2 OR org_id IS NULL)"
    : "";
  const values: unknown[] = orgFilter ? [objectId, options.orgId] : [objectId];
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, change_set_id, sequence, object_id, object_type,
                      operation, history_effect, before_snapshot, after_snapshot,
                      base_version, result_version, object_schema_version,
                      restore_eligible, restore_ineligible_reason,
                      compensating_template_id, remote_revision_ref,
                      actor_id, actor_kind, run_id, audit_event_id,
                      org_id, project_id, owner_level, owner_id, visibility,
                      idempotency_key, event_checksum, created_at, tombstoned_at
               FROM "${schema}"."object_change_event"
               WHERE object_id = $1${orgFilter}
               ORDER BY created_at DESC, sequence DESC
               LIMIT ${limit}`,
        values,
      },
    ],
  });
  return (result?.rows ?? []).map(rowToEvent);
}

export function rowToEvent(row: Record<string, unknown>): ObjectChangeEvent {
  return {
    id: String(row.id),
    changeSetId: String(row.change_set_id),
    sequence: Number(row.sequence),
    objectId: String(row.object_id),
    objectType: String(row.object_type),
    operation: String(row.operation) as ObjectChangeEvent["operation"],
    historyEffect: String(row.history_effect) as HistoryEffect,
    beforeSnapshot: row.before_snapshot
      ? { payload: row.before_snapshot as Record<string, unknown> }
      : null,
    afterSnapshot: row.after_snapshot
      ? { payload: row.after_snapshot as Record<string, unknown> }
      : null,
    baseVersion: row.base_version == null ? null : Number(row.base_version),
    resultVersion: Number(row.result_version),
    objectSchemaVersion: String(row.object_schema_version),
    restoreEligible: row.restore_eligible === true,
    restoreIneligibleReason:
      row.restore_ineligible_reason == null
        ? null
        : (String(
            row.restore_ineligible_reason,
          ) as ObjectChangeEvent["restoreIneligibleReason"]),
    compensatingTemplateId:
      row.compensating_template_id == null
        ? null
        : String(row.compensating_template_id),
    remoteRevisionRef: row.remote_revision_ref
      ? (row.remote_revision_ref as ObjectChangeEvent["remoteRevisionRef"])
      : null,
    actorId: row.actor_id == null ? null : String(row.actor_id),
    actorKind:
      row.actor_kind == null
        ? null
        : (String(row.actor_kind) as ObjectChangeEvent["actorKind"]),
    runId: row.run_id == null ? null : String(row.run_id),
    auditEventId:
      row.audit_event_id == null ? null : String(row.audit_event_id),
    orgId: row.org_id == null ? null : String(row.org_id),
    projectId: row.project_id == null ? null : String(row.project_id),
    ownerLevel: row.owner_level == null ? null : String(row.owner_level),
    ownerId: row.owner_id == null ? null : String(row.owner_id),
    visibility: row.visibility == null ? null : String(row.visibility),
    idempotencyKey: String(row.idempotency_key),
    eventChecksum: String(row.event_checksum),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    tombstonedAt:
      row.tombstoned_at instanceof Date
        ? row.tombstoned_at.toISOString()
        : row.tombstoned_at == null
          ? null
          : String(row.tombstoned_at),
  };
}

export function summarizeChangeSetEligibility(
  loaded: LoadedChangeSet,
  context: Parameters<typeof checkEventEligibility>[1] = {},
): ChangeSetEligibilitySummary {
  const perEvent = loaded.events.map((e) => {
    const v = checkEventEligibility(e, context);
    return {
      eventId: e.id,
      objectId: e.objectId,
      eligible: v.eligible,
      reason: v.reason,
      details: v.details,
    };
  });
  const blocks = perEvent.filter((p) => !p.eligible);
  const reasons = [
    ...new Set(
      blocks
        .map((b) => b.reason)
        .filter(
          (r): r is RestoreIneligibleReason => r !== "ok",
        ),
    ),
  ];
  return {
    eligible: blocks.length === 0,
    reasons,
    details: blocks.map((b) => b.details),
    perEvent,
  };
}
