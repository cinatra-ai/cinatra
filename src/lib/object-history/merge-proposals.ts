// Lossless-merge enrichment-agent pattern.
//
// Contract:
//   1. Enrichment agents fetch external info, build a MergeProposal with
//      MANDATORY baseVersion + per-field provenance.
//   2. The proposal is APPEND-ONLY storage in merge_proposal (status:
//      'pending').
//   3. Human reviewers (or platform-admin tools) approve via approveMergeProposal,
//      which calls historyAwareUpsert with the merged data + the captured
//      baseVersion. CAS-fail produces a typed VersionConflict for the user.
//   4. Agents NEVER mutate objects directly — they only submit proposals.

import { randomUUID } from "node:crypto";

import {
  ensurePostgresSchema,
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

import { historyAwareUpsert } from "./canonical-writer";
import type { HistoryActor } from "./types";

export type MergeProposalStatus =
  | "pending"
  | "applying" // atomic claim during approveMergeProposal
  | "approved"
  | "rejected"
  | "applied"
  | "applied-with-conflict";

export type FieldProvenance = {
  source: string;
  sourceRef?: string;
  confidence?: number;
  capturedAt?: string;
};

export type ProposedField = {
  // The proposed value for this field.
  value: unknown;
  // Per-field provenance.
  provenance: FieldProvenance;
};

export type MergeProposal = {
  id: string;
  objectId: string;
  objectType: string;
  // baseVersion is MANDATORY so CAS can fence stale proposals when the
  // object changed between proposal time and approval.
  baseVersion: number;
  proposingActorId: string | null;
  proposingActorKind: string | null;
  proposingRunId: string | null;
  sourceKind: string;
  sourceRef: unknown;
  proposedFields: Record<string, ProposedField>;
  provenance: Record<string, unknown> | null;
  status: MergeProposalStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  appliedChangeEventId: string | null;
  orgId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SubmitMergeProposalInput = {
  objectId: string;
  objectType: string;
  baseVersion: number;
  proposingActor: HistoryActor;
  sourceKind: string;
  sourceRef?: unknown;
  proposedFields: Record<string, ProposedField>;
  provenance?: Record<string, unknown>;
};

export function submitMergeProposal(
  input: SubmitMergeProposalInput,
): MergeProposal {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const id = `mp_${randomUUID()}`;
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `INSERT INTO "${schema}"."merge_proposal"
                 (id, object_id, object_type, base_version,
                  proposing_actor_id, proposing_actor_kind, proposing_run_id,
                  source_kind, source_ref, proposed_fields, provenance,
                  status, org_id, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb,
                       'pending', $12, now(), now())
               RETURNING id, object_id, object_type, base_version,
                         proposing_actor_id, proposing_actor_kind, proposing_run_id,
                         source_kind, source_ref, proposed_fields, provenance,
                         status, reviewed_by, reviewed_at, review_notes,
                         applied_change_event_id, org_id, created_at, updated_at`,
        values: [
          id,
          input.objectId,
          input.objectType,
          input.baseVersion,
          input.proposingActor.actorId,
          input.proposingActor.actorKind,
          input.proposingActor.runId ?? null,
          input.sourceKind,
          input.sourceRef ? JSON.stringify(input.sourceRef) : null,
          JSON.stringify(input.proposedFields),
          input.provenance ? JSON.stringify(input.provenance) : null,
          input.proposingActor.orgId,
        ],
      },
    ],
  });
  const row = result?.rows[0];
  if (!row) {
    throw new Error("submitMergeProposal: insert failed");
  }
  return rowToProposal(row);
}

export function listPendingMergeProposals(filter: {
  // orgId MUST be non-null. Callers without an active org should not reach
  // this function (UI fails closed on null orgId). The signature keeps null
  // compatible for tests but the SQL constrains to org_id IS NULL when null
  // is passed (system-owned proposals only) — never "any row".
  orgId: string | null;
  objectId?: string;
  limit?: number;
}): MergeProposal[] {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const conds: string[] = ["status = 'pending'"];
  const values: unknown[] = [];
  if (filter.orgId === null) {
    conds.push("org_id IS NULL");
  } else {
    values.push(filter.orgId);
    conds.push(`org_id = $${values.length}`);
  }
  if (filter.objectId) {
    values.push(filter.objectId);
    conds.push(`object_id = $${values.length}`);
  }
  const where = `WHERE ${conds.join(" AND ")}`;
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, object_id, object_type, base_version,
                      proposing_actor_id, proposing_actor_kind, proposing_run_id,
                      source_kind, source_ref, proposed_fields, provenance,
                      status, reviewed_by, reviewed_at, review_notes,
                      applied_change_event_id, org_id, created_at, updated_at
               FROM "${schema}"."merge_proposal"
               ${where}
               ORDER BY created_at DESC
               LIMIT ${limit}`,
        values,
      },
    ],
  });
  return (result?.rows ?? []).map(rowToProposal);
}

export function readMergeProposalById(
  id: string,
  options: { orgId?: string | null } = {},
): MergeProposal | null {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const orgClause =
    options.orgId !== undefined && options.orgId !== null
      ? " AND (org_id = $2 OR org_id IS NULL)"
      : "";
  const values: unknown[] = orgClause ? [id, options.orgId] : [id];
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, object_id, object_type, base_version,
                      proposing_actor_id, proposing_actor_kind, proposing_run_id,
                      source_kind, source_ref, proposed_fields, provenance,
                      status, reviewed_by, reviewed_at, review_notes,
                      applied_change_event_id, org_id, created_at, updated_at
               FROM "${schema}"."merge_proposal"
               WHERE id = $1${orgClause}`,
        values,
      },
    ],
  });
  const row = result?.rows[0];
  return row ? rowToProposal(row) : null;
}

// Approval applies the proposal via historyAwareUpsert. The selectedFields
// argument allows the reviewer to accept some fields and reject others
// (per-field choice). When omitted, all proposed fields apply.
export type ApproveMergeProposalInput = {
  proposalId: string;
  actor: HistoryActor;
  reviewNotes?: string;
  selectedFields?: readonly string[];
  // The current data payload of the object — applies the proposed fields
  // over this base. Caller must read this fresh; we use the proposal's
  // captured baseVersion as the CAS expectation, so a stale base will be
  // rejected with VersionConflict.
  currentData: Record<string, unknown>;
};

export function approveMergeProposal(input: ApproveMergeProposalInput): {
  proposal: MergeProposal;
  changeEventId: string;
  resultVersion: number;
} {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');

  // Atomic claim. Transition status pending -> applying BEFORE running the
  // canonical write so a concurrent reject / approve cannot race. If the row
  // no longer matches (status moved already), RETURNING is empty and we
  // throw.
  const [claimResult] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."merge_proposal"
               SET status = 'applying',
                   reviewed_by = $2,
                   reviewed_at = now(),
                   review_notes = $3,
                   updated_at = now()
               WHERE id = $1
                 AND status = 'pending'
                 AND (org_id = $4 OR (org_id IS NULL AND $4 IS NULL))
               RETURNING id, object_id, object_type, base_version,
                         proposing_actor_id, proposing_actor_kind, proposing_run_id,
                         source_kind, source_ref, proposed_fields, provenance,
                         status, reviewed_by, reviewed_at, review_notes,
                         applied_change_event_id, org_id, created_at, updated_at`,
        values: [
          input.proposalId,
          input.actor.actorId,
          input.reviewNotes ?? null,
          input.actor.orgId,
        ],
      },
    ],
  });
  const claimedRow = claimResult?.rows[0];
  if (!claimedRow) {
    throw new Error(
      `approveMergeProposal: proposal ${input.proposalId} not found, not pending, or not visible in this org`,
    );
  }
  const proposal = rowToProposal(claimedRow);

  // Compose the merged data — selectedFields filters which proposed fields
  // get applied.
  const selected = new Set(
    input.selectedFields ?? Object.keys(proposal.proposedFields),
  );
  const mergedData: Record<string, unknown> = { ...input.currentData };
  for (const fieldKey of selected) {
    const proposed = proposal.proposedFields[fieldKey];
    if (proposed) {
      mergedData[fieldKey] = proposed.value;
    }
  }

  // Apply through canonical writer with proposal's baseVersion as CAS.
  // VersionConflictError propagates if the object moved underneath us —
  // we roll back the claim to leave the proposal pending again.
  try {
    const result = historyAwareUpsert(
      {
        id: proposal.objectId,
        type: proposal.objectType,
        data: mergedData,
        orgId: input.actor.orgId,
      },
      {
        expectedBaseVersion: proposal.baseVersion,
        historyEffect: "reversible-internal",
        actor: input.actor,
      },
    );

    runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `UPDATE "${schema}"."merge_proposal"
                 SET status = 'applied',
                     applied_change_event_id = $2,
                     updated_at = now()
                 WHERE id = $1
                   AND status = 'applying'`,
          values: [proposal.id, result.event.id],
        },
      ],
    });

    return {
      proposal: {
        ...proposal,
        status: "applied",
        appliedChangeEventId: result.event.id,
      },
      changeEventId: result.event.id,
      resultVersion: result.resultVersion,
    };
  } catch (e) {
    // Rollback the claim — restore the proposal to pending so it can be
    // re-reviewed. The reviewer keeps the same status response and can
    // try again on the new baseVersion.
    runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        {
          text: `UPDATE "${schema}"."merge_proposal"
                 SET status = 'pending',
                     reviewed_by = NULL,
                     reviewed_at = NULL,
                     review_notes = NULL,
                     updated_at = now()
                 WHERE id = $1
                   AND status = 'applying'`,
          values: [proposal.id],
        },
      ],
    });
    throw e;
  }
}

export type RejectMergeProposalInput = {
  proposalId: string;
  actor: HistoryActor;
  reviewNotes?: string;
};

export function rejectMergeProposal(input: RejectMergeProposalInput): MergeProposal {
  const proposal = readMergeProposalById(input.proposalId, {
    orgId: input.actor.orgId,
  });
  if (!proposal) {
    throw new Error(`rejectMergeProposal: proposal ${input.proposalId} not found`);
  }
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `UPDATE "${schema}"."merge_proposal"
               SET status = 'rejected',
                   reviewed_by = $2,
                   reviewed_at = now(),
                   review_notes = $3,
                   updated_at = now()
               WHERE id = $1
                 AND status = 'pending'
               RETURNING id, object_id, object_type, base_version,
                         proposing_actor_id, proposing_actor_kind, proposing_run_id,
                         source_kind, source_ref, proposed_fields, provenance,
                         status, reviewed_by, reviewed_at, review_notes,
                         applied_change_event_id, org_id, created_at, updated_at`,
        values: [proposal.id, input.actor.actorId, input.reviewNotes ?? null],
      },
    ],
  });
  const row = result?.rows[0];
  if (!row) {
    throw new Error("rejectMergeProposal: update failed (proposal not pending?)");
  }
  return rowToProposal(row);
}

function rowToProposal(row: Record<string, unknown>): MergeProposal {
  return {
    id: String(row.id),
    objectId: String(row.object_id),
    objectType: String(row.object_type),
    baseVersion: Number(row.base_version),
    proposingActorId: row.proposing_actor_id == null ? null : String(row.proposing_actor_id),
    proposingActorKind: row.proposing_actor_kind == null ? null : String(row.proposing_actor_kind),
    proposingRunId: row.proposing_run_id == null ? null : String(row.proposing_run_id),
    sourceKind: String(row.source_kind),
    sourceRef: row.source_ref ?? null,
    proposedFields: (row.proposed_fields as Record<string, ProposedField>) ?? {},
    provenance: (row.provenance as Record<string, unknown>) ?? null,
    status: String(row.status) as MergeProposalStatus,
    reviewedBy: row.reviewed_by == null ? null : String(row.reviewed_by),
    reviewedAt:
      row.reviewed_at instanceof Date
        ? row.reviewed_at.toISOString()
        : row.reviewed_at == null
          ? null
          : String(row.reviewed_at),
    reviewNotes: row.review_notes == null ? null : String(row.review_notes),
    appliedChangeEventId:
      row.applied_change_event_id == null
        ? null
        : String(row.applied_change_event_id),
    orgId: row.org_id == null ? null : String(row.org_id),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at),
  };
}
