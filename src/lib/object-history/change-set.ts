// change_set lifecycle helpers.
//
// Atomic mutation closes its own change_set independently.
// Run-level rollup is a query over closed change_sets, NOT a long-lived open
// change_set. The canonical writer auto-opens + auto-closes a change_set
// when no handle is supplied. When a long-running run wants multiple atomic
// mutations to roll up under one change_set, it opens one explicitly and
// closes it when the run completes.

import { randomUUID } from "node:crypto";

import {
  ensurePostgresSchema,
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

import type {
  ChangeSetHandle,
  ChangeSetRecord,
  HistoryActor,
  HistoryEffect,
} from "./types";

export type OpenChangeSetInput = {
  actor: HistoryActor;
  toolCallId?: string;
  actionId?: string;
  parentChangeSetId?: string;
  restoreOfChangeSetId?: string;
};

const EFFECT_SEVERITY: Record<HistoryEffect, number> = {
  "reversible-internal": 0,
  "compensating-action": 1,
  "irreversible-logged": 2,
};

export function combineEffect(
  a: HistoryEffect,
  b: HistoryEffect,
): HistoryEffect {
  return EFFECT_SEVERITY[a] >= EFFECT_SEVERITY[b] ? a : b;
}

// Idempotent open. Returns a handle scoped to the supplied actor + run.
export function openChangeSet(
  input: OpenChangeSetInput,
): ChangeSetHandle {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const id = `cs_${randomUUID()}`;
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `INSERT INTO "${schema}"."change_set"
                 (id, org_id, opened_at, actor_id, actor_kind, run_id,
                  tool_call_id, action_id, parent_change_set_id,
                  restore_of_change_set_id, effect_rollup, restorable,
                  created_by, created_at, updated_at)
               VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9,
                       'reversible-internal', true, $3, now(), now())`,
        values: [
          id,
          input.actor.orgId,
          input.actor.actorId,
          input.actor.actorKind,
          input.actor.runId ?? null,
          input.toolCallId ?? null,
          input.actionId ?? null,
          input.parentChangeSetId ?? null,
          input.restoreOfChangeSetId ?? null,
        ],
      },
    ],
  });
  return { changeSetId: id };
}

// Closes the change_set, computing the rollup from member events. Returns
// the final record. Idempotent: closing an already-closed change_set is a
// no-op.
export function closeChangeSet(
  handle: ChangeSetHandle,
  options: { closureReason?: string } = {},
): ChangeSetRecord {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [aggregateResult] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT
                  COALESCE(MAX(CASE history_effect
                                  WHEN 'irreversible-logged' THEN 2
                                  WHEN 'compensating-action' THEN 1
                                  ELSE 0
                              END), 0) AS severity,
                  bool_and(restore_eligible) AS all_restorable,
                  bool_or(restore_ineligible_reason IS NOT NULL) AS has_block,
                  string_agg(DISTINCT restore_ineligible_reason, ', ')
                    FILTER (WHERE restore_ineligible_reason IS NOT NULL)
                    AS reasons
               FROM "${schema}"."object_change_event"
               WHERE change_set_id = $1`,
        values: [handle.changeSetId],
      },
    ],
  });
  const agg = aggregateResult?.rows[0] ?? {
    severity: 0,
    all_restorable: true,
    has_block: false,
    reasons: null,
  };
  const severity = Number(agg.severity ?? 0);
  const effectRollup: HistoryEffect =
    severity >= 2
      ? "irreversible-logged"
      : severity >= 1
        ? "compensating-action"
        : "reversible-internal";
  const allRestorable = agg.all_restorable !== false;
  const hasBlock = agg.has_block === true;
  const restorable = allRestorable && !hasBlock;
  const restorableReason = restorable
    ? null
    : agg.reasons ?? "non-restorable-event-present";

  const [updateResult] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."change_set"
               SET closed_at = COALESCE(closed_at, now()),
                   closure_reason = COALESCE(closure_reason, $2),
                   effect_rollup = $3,
                   restorable = $4,
                   restorable_reason = $5,
                   updated_at = now()
               WHERE id = $1
               RETURNING id, org_id, opened_at, closed_at, closure_reason,
                         actor_id, actor_kind, run_id, tool_call_id, action_id,
                         effect_rollup, restorable, restorable_reason,
                         parent_change_set_id, restore_of_change_set_id,
                         created_by, created_at, updated_at`,
        values: [
          handle.changeSetId,
          options.closureReason ?? null,
          effectRollup,
          restorable,
          restorableReason,
        ],
      },
    ],
  });
  const row = updateResult?.rows[0];
  if (!row) {
    throw new Error(
      `closeChangeSet: no row updated for id=${handle.changeSetId}`,
    );
  }
  return rowToChangeSetRecord(row);
}

export function readChangeSetById(
  changeSetId: string,
): ChangeSetRecord | null {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, org_id, opened_at, closed_at, closure_reason,
                      actor_id, actor_kind, run_id, tool_call_id, action_id,
                      effect_rollup, restorable, restorable_reason,
                      parent_change_set_id, restore_of_change_set_id,
                      created_by, created_at, updated_at
               FROM "${schema}"."change_set"
               WHERE id = $1`,
        values: [changeSetId],
      },
    ],
  });
  const row = result?.rows[0];
  return row ? rowToChangeSetRecord(row) : null;
}

export type ListChangeSetsFilter = {
  orgId?: string | null;
  runId?: string | null;
  limit?: number;
  cursor?: string;
  // Filter/search. All optional; omitted = no filter
  // (backward-compatible with prior callers).
  objectId?: string | null;
  actorId?: string | null;
  effectRollup?: HistoryEffect | null;
  restorable?: boolean | null;
  createdAfter?: string | null; // opened_at lower bound (ISO)
  createdBefore?: string | null; // opened_at upper bound (ISO)
  closedAtAfter?: string | null; // closed_at lower bound (ISO)
};

export function listChangeSets(
  filter: ListChangeSetsFilter = {},
): ChangeSetRecord[] {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const conds: string[] = [];
  const values: unknown[] = [];
  if (filter.orgId !== undefined) {
    values.push(filter.orgId);
    conds.push(
      filter.orgId === null
        ? `org_id IS NULL`
        : `org_id = $${values.length}`,
    );
  }
  if (filter.runId) {
    values.push(filter.runId);
    conds.push(`run_id = $${values.length}`);
  }
  if (filter.cursor) {
    values.push(filter.cursor);
    conds.push(`id < $${values.length}`);
  }
  // The change_set columns are aliased "cs" only for
  // the objectId EXISTS subquery; the other filters reference bare columns
  // (unambiguous — single FROM table). objectId uses EXISTS against
  // object_change_event (NOT a join — avoids row multiplication).
  if (filter.actorId) {
    values.push(filter.actorId);
    conds.push(`actor_id = $${values.length}`);
  }
  if (filter.effectRollup) {
    values.push(filter.effectRollup);
    conds.push(`effect_rollup = $${values.length}`);
  }
  if (filter.restorable !== undefined && filter.restorable !== null) {
    values.push(filter.restorable);
    conds.push(`restorable = $${values.length}`);
  }
  if (filter.createdAfter) {
    values.push(filter.createdAfter);
    conds.push(`opened_at > $${values.length}::timestamptz`);
  }
  if (filter.createdBefore) {
    values.push(filter.createdBefore);
    conds.push(`opened_at < $${values.length}::timestamptz`);
  }
  if (filter.closedAtAfter) {
    values.push(filter.closedAtAfter);
    conds.push(`closed_at > $${values.length}::timestamptz`);
  }
  if (filter.objectId) {
    values.push(filter.objectId);
    conds.push(
      `EXISTS (SELECT 1 FROM "${schema}"."object_change_event" oce ` +
        `WHERE oce.change_set_id = "${schema}"."change_set".id ` +
        `AND oce.object_id = $${values.length})`,
    );
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, org_id, opened_at, closed_at, closure_reason,
                      actor_id, actor_kind, run_id, tool_call_id, action_id,
                      effect_rollup, restorable, restorable_reason,
                      parent_change_set_id, restore_of_change_set_id,
                      created_by, created_at, updated_at
               FROM "${schema}"."change_set"
               ${where}
               ORDER BY opened_at DESC, id DESC
               LIMIT ${limit}`,
        values,
      },
    ],
  });
  return (result?.rows ?? []).map(rowToChangeSetRecord);
}

function rowToChangeSetRecord(row: Record<string, unknown>): ChangeSetRecord {
  return {
    id: String(row.id),
    orgId: row.org_id == null ? null : String(row.org_id),
    openedAt: toIso(row.opened_at),
    closedAt: row.closed_at == null ? null : toIso(row.closed_at),
    closureReason:
      row.closure_reason == null ? null : String(row.closure_reason),
    actorId: row.actor_id == null ? null : String(row.actor_id),
    actorKind:
      row.actor_kind == null
        ? null
        : (String(row.actor_kind) as ChangeSetRecord["actorKind"]),
    runId: row.run_id == null ? null : String(row.run_id),
    toolCallId: row.tool_call_id == null ? null : String(row.tool_call_id),
    actionId: row.action_id == null ? null : String(row.action_id),
    effectRollup: String(row.effect_rollup) as HistoryEffect,
    restorable: row.restorable === true,
    restorableReason:
      row.restorable_reason == null ? null : String(row.restorable_reason),
    parentChangeSetId:
      row.parent_change_set_id == null
        ? null
        : String(row.parent_change_set_id),
    restoreOfChangeSetId:
      row.restore_of_change_set_id == null
        ? null
        : String(row.restore_of_change_set_id),
    createdBy: row.created_by == null ? null : String(row.created_by),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
