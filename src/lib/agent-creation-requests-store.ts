import "server-only";

import { randomUUID, createHash } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";

// ---------------------------------------------------------------------------
// agent_creation_request store.
//
// Pending creation proposals for the non-admin authoring path. Pending state
// lives ONLY here; agent_templates is created/updated only when admin approval
// dispatches the existing gated publish. CAS via snapshot_hash; state machine
// draft → proposed → approved → published + reopenable rejected → proposed.
//
// `proposal_snapshot` shape (single SKILL.md to
// match the existing agent_source_write_files handler signature):
//   { oas: <oas.json>, packageJson: <package.json>, skillMd: <SKILL.md or null> }
//
// `snapshot_hash` is the canonical-server-normalized sha256 — the SAME bytes
// the approve-path will materialize, so a stale-vs-approved compare is exact.
// ---------------------------------------------------------------------------

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');

export type AgentCreationRequestStatus =
  | "draft"
  | "proposed"
  | "approved"
  | "rejected"
  | "published";

export type AgentCreationRequestSnapshot = {
  oas: Record<string, unknown>;
  packageJson: Record<string, unknown>;
  skillMd?: string | null;
};

/** Author-facing decision-notification tracking (issue #79). The claim
 *  ({decision, claimedAt}) is stamped atomically by the decide CAS UPDATE in
 *  `decideAgentCreationRequestCas`; `sentAt` is merged in after the
 *  notification row was actually created. NULL means "no decision claimed for
 *  the current cycle" — an author edit (rejected → proposed) resets it so the
 *  next decision notifies again. */
export type AgentCreationRequestNotificationState = {
  decision: "approved" | "rejected";
  claimedAt: string;
  sentAt?: string;
};

export type AgentCreationRequestRow = {
  id: string;
  orgId: string;
  authorId: string;
  packageSlug: string;
  packageName: string;
  packageVersion: string;
  status: AgentCreationRequestStatus;
  proposalSnapshot: AgentCreationRequestSnapshot;
  reviewReport: unknown | null;
  snapshotHash: string;
  resolvedApproverIds: string[] | null;
  decidedBy: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
  publishResult: unknown | null;
  notificationState: unknown | null;
  createdAt: string;
  updatedAt: string;
};

/** Canonical-stringify a value with sorted keys so hashes are
 *  order-independent. */
function canonicalize(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) throw new Error("cycle in snapshot");
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = walk(obj[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

/** Compute the canonical snapshot hash — the SAME bytes the approve-path
 *  materializes, so stale-detection is exact. */
export function computeSnapshotHash(snapshot: AgentCreationRequestSnapshot): string {
  return createHash("sha256").update(canonicalize(snapshot)).digest("hex");
}

export class AgentCreationRequestNotFoundError extends Error {
  constructor(id: string) {
    super(`agent_creation_request ${id} not found`);
  }
}

export class StaleProposalError extends Error {
  constructor(id: string) {
    super(
      `agent_creation_request ${id} snapshot changed since this decision was prepared; refresh and try again`,
    );
  }
}

export class InvalidStateTransitionError extends Error {
  constructor(from: AgentCreationRequestStatus, to: AgentCreationRequestStatus) {
    super(`agent_creation_request invalid transition: ${from} → ${to}`);
  }
}

type Row = {
  id: string;
  org_id: string;
  author_id: string;
  package_slug: string;
  package_name: string;
  package_version: string;
  status: AgentCreationRequestStatus;
  proposal_snapshot: AgentCreationRequestSnapshot;
  review_report: unknown | null;
  snapshot_hash: string;
  resolved_approver_ids: string[] | null;
  decided_by: string | null;
  decided_at: Date | string | null;
  rejection_reason: string | null;
  publish_result: unknown | null;
  notification_state: unknown | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function toIso(t: Date | string | null): string | null {
  if (t === null) return null;
  return t instanceof Date ? t.toISOString() : String(t);
}
function rowToRecord(row: Row): AgentCreationRequestRow {
  return {
    id: row.id,
    orgId: row.org_id,
    authorId: row.author_id,
    packageSlug: row.package_slug,
    packageName: row.package_name,
    packageVersion: row.package_version,
    status: row.status,
    proposalSnapshot: row.proposal_snapshot,
    reviewReport: row.review_report,
    snapshotHash: row.snapshot_hash,
    resolvedApproverIds: row.resolved_approver_ids,
    decidedBy: row.decided_by,
    decidedAt: toIso(row.decided_at),
    rejectionReason: row.rejection_reason,
    publishResult: row.publish_result,
    notificationState: row.notification_state,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

export function createAgentCreationRequest(input: {
  orgId: string;
  authorId: string;
  packageSlug: string;
  packageName: string;
  packageVersion: string;
  proposalSnapshot: AgentCreationRequestSnapshot;
  reviewReport?: unknown;
  resolvedApproverIds?: string[];
}): AgentCreationRequestRow {
  ensurePostgresSchema();
  const schema = q();
  const id = randomUUID();
  const snapshotHash = computeSnapshotHash(input.proposalSnapshot);
  runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `INSERT INTO "${schema}"."agent_creation_request" (
  id, org_id, author_id, package_slug, package_name, package_version,
  status, proposal_snapshot, review_report, snapshot_hash, resolved_approver_ids
) VALUES ($1, $2, $3, $4, $5, $6, 'proposed', $7, $8, $9, $10)`,
        values: [
          id,
          input.orgId,
          input.authorId,
          input.packageSlug,
          input.packageName,
          input.packageVersion,
          JSON.stringify(input.proposalSnapshot),
          input.reviewReport ? JSON.stringify(input.reviewReport) : null,
          snapshotHash,
          input.resolvedApproverIds ? JSON.stringify(input.resolvedApproverIds) : null,
        ],
      },
    ],
  });
  return readAgentCreationRequestById(id, input.orgId)!;
}

export function readAgentCreationRequestById(
  id: string,
  orgId: string,
): AgentCreationRequestRow | null {
  ensurePostgresSchema();
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT * FROM "${schema}"."agent_creation_request" WHERE id = $1 AND org_id = $2`,
        values: [id, orgId],
      },
    ],
  });
  const row = res?.rows?.[0] as Row | undefined;
  return row ? rowToRecord(row) : null;
}

export function listAgentCreationRequests(input: {
  orgId: string;
  status?: AgentCreationRequestStatus | "all";
  authorId?: string;
  limit?: number;
}): AgentCreationRequestRow[] {
  ensurePostgresSchema();
  const schema = q();
  const where: string[] = ["org_id = $1"];
  const values: unknown[] = [input.orgId];
  if (input.status && input.status !== "all") {
    values.push(input.status);
    where.push(`status = $${values.length}`);
  }
  if (input.authorId) {
    values.push(input.authorId);
    where.push(`author_id = $${values.length}`);
  }
  const limit = input.limit ?? 200;
  values.push(limit);
  const limitParam = `$${values.length}`;
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT * FROM "${schema}"."agent_creation_request"
WHERE ${where.join(" AND ")}
ORDER BY created_at DESC
LIMIT ${limitParam}`,
        values,
      },
    ],
  });
  return ((res?.rows ?? []) as Row[]).map(rowToRecord);
}

/** Author-edit a rejected request — re-snapshot, re-hash, transition back to
 *  proposed (reopenable). Allowed only when current status is `rejected`. */
export function editRejectedRequest(input: {
  id: string;
  orgId: string;
  authorId: string;
  newSnapshot: AgentCreationRequestSnapshot;
  newReviewReport?: unknown;
  packageVersion?: string;
}): AgentCreationRequestRow {
  const cur = readAgentCreationRequestById(input.id, input.orgId);
  if (!cur) throw new AgentCreationRequestNotFoundError(input.id);
  if (cur.status !== "rejected") {
    throw new InvalidStateTransitionError(cur.status, "proposed");
  }
  if (cur.authorId !== input.authorId) {
    throw new Error("only the original author may edit a rejected request");
  }
  ensurePostgresSchema();
  const schema = q();
  const newHash = computeSnapshotHash(input.newSnapshot);
  runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `UPDATE "${schema}"."agent_creation_request"
SET proposal_snapshot = $3,
    review_report = $4,
    snapshot_hash = $5,
    package_version = COALESCE($6, package_version),
    status = 'proposed',
    decided_by = NULL,
    decided_at = NULL,
    rejection_reason = NULL,
    notification_state = NULL,
    updated_at = now()
WHERE id = $1 AND org_id = $2`,
        values: [
          input.id,
          input.orgId,
          JSON.stringify(input.newSnapshot),
          input.newReviewReport ? JSON.stringify(input.newReviewReport) : null,
          newHash,
          input.packageVersion ?? null,
        ],
      },
    ],
  });
  return readAgentCreationRequestById(input.id, input.orgId)!;
}

/** CAS-guarded decide: proposed → approved | rejected. CAS on snapshot_hash:
 *  if the proposal was edited since the admin saw it, the hash mismatches and
 *  StaleProposalError is thrown (the decision is for a snapshot that no longer
 *  represents the current proposal).
 *
 *  The SAME atomic UPDATE also claims the author-facing decision notification
 *  (issue #79): `notification_state` is stamped {decision, claimedAt} in the
 *  decide statement itself, so "won the decide CAS" and "owns this cycle's
 *  notification" are one and the same — there is no separate claim step for a
 *  delayed notifier from an earlier cycle to race (an author edit resets
 *  notification_state and moves the row back to 'proposed'; the next decide
 *  mints its own fresh claim). The win is verified via the UPDATE's rowCount,
 *  NOT by re-reading the status — two same-decision racers would both see the
 *  decided status on a re-read, but only one gets rowCount=1. */
export function decideAgentCreationRequestCas(input: {
  id: string;
  orgId: string;
  decidedBy: string;
  decision: "approve" | "reject";
  reason?: string;
  expectedSnapshotHash: string;
}): AgentCreationRequestRow {
  const cur = readAgentCreationRequestById(input.id, input.orgId);
  if (!cur) throw new AgentCreationRequestNotFoundError(input.id);
  if (cur.status !== "proposed") {
    throw new InvalidStateTransitionError(
      cur.status,
      input.decision === "approve" ? "approved" : "rejected",
    );
  }
  if (cur.snapshotHash !== input.expectedSnapshotHash) {
    throw new StaleProposalError(input.id);
  }
  ensurePostgresSchema();
  const schema = q();
  const nextStatus: AgentCreationRequestStatus =
    input.decision === "approve" ? "approved" : "rejected";
  const notificationClaim: AgentCreationRequestNotificationState = {
    decision: nextStatus as "approved" | "rejected",
    claimedAt: new Date().toISOString(),
  };
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `UPDATE "${schema}"."agent_creation_request"
SET status = $3,
    decided_by = $4,
    decided_at = now(),
    rejection_reason = $5,
    notification_state = $7,
    updated_at = now()
WHERE id = $1 AND org_id = $2 AND snapshot_hash = $6 AND status = 'proposed'`,
        values: [
          input.id,
          input.orgId,
          nextStatus,
          input.decidedBy,
          input.decision === "reject" ? (input.reason ?? null) : null,
          input.expectedSnapshotHash,
          JSON.stringify(notificationClaim),
        ],
      },
    ],
  });
  if ((res?.rowCount ?? 0) !== 1) {
    // Lost the race or the row changed mid-flight.
    throw new StaleProposalError(input.id);
  }
  const after = readAgentCreationRequestById(input.id, input.orgId);
  if (!after || after.status !== nextStatus) {
    // Row changed again between the UPDATE and the re-read.
    throw new StaleProposalError(input.id);
  }
  return after;
}

/** Stamp `notification_state.sentAt` after the notification row was actually
 *  created (best-effort bookkeeping on top of the claim stamped by the decide
 *  CAS — the decide CAS is the idempotency gate; this records delivery for
 *  observability/backfill). Merging via `||` preserves the claim fields, and
 *  the WHERE is scoped to the EXACT claim being acknowledged
 *  (decision + claimedAt): a stalled cycle-1 notifier that resumes after an
 *  author edit + re-decision finds a DIFFERENT claim on the row and no-ops —
 *  it can never make the new cycle look delivered. */
export function markAgentCreationRequestNotificationSent(input: {
  id: string;
  orgId: string;
  decision: "approved" | "rejected";
  claimedAt: string;
}): void {
  ensurePostgresSchema();
  const schema = q();
  runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `UPDATE "${schema}"."agent_creation_request"
SET notification_state = notification_state || $3::jsonb, updated_at = now()
WHERE id = $1 AND org_id = $2
  AND notification_state IS NOT NULL
  AND notification_state->>'decision' = $4
  AND notification_state->>'claimedAt' = $5`,
        values: [
          input.id,
          input.orgId,
          JSON.stringify({ sentAt: new Date().toISOString() }),
          input.decision,
          input.claimedAt,
        ],
      },
    ],
  });
}

/** Promote approved → published after the gated publish has materialized the
 *  agent_templates row. publish_result carries the publish summary. */
export function markAgentCreationRequestPublished(input: {
  id: string;
  orgId: string;
  publishResult: unknown;
}): AgentCreationRequestRow {
  const cur = readAgentCreationRequestById(input.id, input.orgId);
  if (!cur) throw new AgentCreationRequestNotFoundError(input.id);
  if (cur.status !== "approved") {
    throw new InvalidStateTransitionError(cur.status, "published");
  }
  ensurePostgresSchema();
  const schema = q();
  runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `UPDATE "${schema}"."agent_creation_request"
SET status = 'published', publish_result = $3, updated_at = now()
WHERE id = $1 AND org_id = $2 AND status = 'approved'`,
        values: [input.id, input.orgId, JSON.stringify(input.publishResult)],
      },
    ],
  });
  return readAgentCreationRequestById(input.id, input.orgId)!;
}

export function countPendingAgentCreationRequests(orgId: string): number {
  ensurePostgresSchema();
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT COUNT(*)::int AS count FROM "${schema}"."agent_creation_request" WHERE org_id = $1 AND status = 'proposed'`,
        values: [orgId],
      },
    ],
  });
  const rows = (res?.rows ?? []) as { count: number }[];
  return rows[0]?.count ?? 0;
}
