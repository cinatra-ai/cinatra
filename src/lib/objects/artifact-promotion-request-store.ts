import "server-only";

import { randomUUID } from "node:crypto";

import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

// ---------------------------------------------------------------------------
// artifact_promotion_request store (cinatra#1437, epic #1424).
//
// Pending requests to WIDEN one artifact row's visibility (private →
// team | organization) through the shared approvals surface (promotion subject
// type "artifact", `promotion-requests.ts`). Pending state lives ONLY on this
// row; the artifact OBJECT is widened + re-projected only when an admin approve
// clears the CAS/never-narrow/secret-scan gates in
// `artifact-row-promotion.ts`. Mirrors the agent_creation_request store idiom:
// synchronous raw-SQL via runPostgresQueriesSync, business decisions are VALUES
// (this leaf reports a lost CAS as `false`, never a throw), CAS via a guarded
// UPDATE whose win is verified by rowCount (NOT a status re-read — two
// same-decision racers both re-read the decided status, but only one gets
// rowCount = 1).
//
// `row_version` is the objects.version captured at request time — the CAS
// anchor an edit-after-request supersedes (the object's version bumps on every
// write, so a concurrent edit moves it past the captured value).
// ---------------------------------------------------------------------------

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');

export type ArtifactPromotionRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "superseded";

/** A widen target the decide path applies to the artifact object row. */
export type ArtifactPromotionVisibility = "team" | "organization";

export type ArtifactPromotionRequestRow = {
  id: string;
  orgId: string;
  objectId: string;
  /** Human title snapshotted at request time (the review row never re-reads the
   *  object just to render a label). */
  objectTitle: string;
  requestedBy: string;
  fromVisibility: string;
  toVisibility: ArtifactPromotionVisibility;
  /** The ownership axes the widen writes alongside `toVisibility` so the
   *  graphiti scope→lane policy resolves the new lane (org lane for
   *  organization; team lane for a team-owned row). */
  toOwnerLevel: string;
  toOwnerId: string;
  /** DISPLAY-ONLY snapshot of the widen target's human label (the team name),
   *  captured at request time so reviewers see the ACTUAL destination, not a
   *  bare id (codex finding on cinatra#1437). Null for organization targets
   *  (the org is unambiguous). Never used for authorization. */
  toOwnerLabel: string | null;
  /** objects.version captured at request time (the CAS anchor). */
  rowVersion: number;
  status: ArtifactPromotionRequestStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Raised when a second pending request is opened for a row that already has
 *  one in flight (the partial-unique `..._one_pending` index). A VALUE-shaped
 *  refusal at the data layer above translates it. */
export class ArtifactPromotionRequestConflictError extends Error {
  constructor(objectId: string) {
    super(`artifact_promotion_request: a pending promotion already exists for object ${objectId}`);
    this.name = "ArtifactPromotionRequestConflictError";
  }
}

type Row = {
  id: string;
  org_id: string;
  object_id: string;
  object_title: string;
  requested_by: string;
  from_visibility: string;
  to_visibility: ArtifactPromotionVisibility;
  to_owner_level: string;
  to_owner_id: string;
  to_owner_label: string | null;
  row_version: number;
  status: ArtifactPromotionRequestStatus;
  decided_by: string | null;
  decided_at: Date | string | null;
  decision_note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function toIso(t: Date | string | null): string | null {
  if (t === null) return null;
  return t instanceof Date ? t.toISOString() : String(t);
}

function rowToRecord(row: Row): ArtifactPromotionRequestRow {
  return {
    id: row.id,
    orgId: row.org_id,
    objectId: row.object_id,
    objectTitle: row.object_title,
    requestedBy: row.requested_by,
    fromVisibility: row.from_visibility,
    toVisibility: row.to_visibility,
    toOwnerLevel: row.to_owner_level,
    toOwnerId: row.to_owner_id,
    toOwnerLabel: row.to_owner_label ?? null,
    rowVersion: typeof row.row_version === "number" ? row.row_version : Number(row.row_version),
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: toIso(row.decided_at),
    decisionNote: row.decision_note,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

export function createArtifactPromotionRequest(input: {
  orgId: string;
  objectId: string;
  objectTitle: string;
  requestedBy: string;
  fromVisibility: string;
  toVisibility: ArtifactPromotionVisibility;
  toOwnerLevel: string;
  toOwnerId: string;
  toOwnerLabel: string | null;
  rowVersion: number;
}): ArtifactPromotionRequestRow {
  ensurePostgresSchema();
  const schema = q();
  const id = randomUUID();
  let rowCount = 0;
  try {
    const [res] = runPostgresQueriesSync({
      connectionString: conn(),
      queries: [
        {
          text: `INSERT INTO "${schema}"."artifact_promotion_request" (
  id, org_id, object_id, object_title, requested_by,
  from_visibility, to_visibility, to_owner_level, to_owner_id, to_owner_label, row_version, status
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')`,
          values: [
            id,
            input.orgId,
            input.objectId,
            input.objectTitle,
            input.requestedBy,
            input.fromVisibility,
            input.toVisibility,
            input.toOwnerLevel,
            input.toOwnerId,
            input.toOwnerLabel,
            input.rowVersion,
          ],
        },
      ],
    });
    rowCount = res?.rowCount ?? 0;
  } catch (error) {
    // The partial-unique one-pending index collides as a duplicate-key error.
    if (isUniqueViolation(error)) throw new ArtifactPromotionRequestConflictError(input.objectId);
    throw error;
  }
  if (rowCount !== 1) throw new ArtifactPromotionRequestConflictError(input.objectId);
  return readArtifactPromotionRequestById(id, input.orgId)!;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error ?? "");
  // pg unique_violation SQLSTATE, or the sync bridge's stringified message.
  return code === "23505" || /duplicate key|unique constraint|_one_pending/i.test(message);
}

export function readArtifactPromotionRequestById(
  id: string,
  orgId: string,
): ArtifactPromotionRequestRow | null {
  ensurePostgresSchema();
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT * FROM "${schema}"."artifact_promotion_request" WHERE id = $1 AND org_id = $2`,
        values: [id, orgId],
      },
    ],
  });
  const row = res?.rows?.[0] as Row | undefined;
  return row ? rowToRecord(row) : null;
}

export function listArtifactPromotionRequests(input: {
  orgId: string;
  status?: ArtifactPromotionRequestStatus | "all";
  requestedBy?: string;
  /** Exclude rows requested by this user — the Inbox is someone-ELSE's work. */
  excludeRequester?: string;
  limit?: number;
}): ArtifactPromotionRequestRow[] {
  ensurePostgresSchema();
  const schema = q();
  const where: string[] = ["org_id = $1"];
  const values: unknown[] = [input.orgId];
  if (input.status && input.status !== "all") {
    values.push(input.status);
    where.push(`status = $${values.length}`);
  }
  if (input.requestedBy) {
    values.push(input.requestedBy);
    where.push(`requested_by = $${values.length}`);
  }
  if (input.excludeRequester) {
    values.push(input.excludeRequester);
    where.push(`requested_by <> $${values.length}`);
  }
  const limit = input.limit ?? 200;
  values.push(limit);
  const limitParam = `$${values.length}`;
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT * FROM "${schema}"."artifact_promotion_request"
WHERE ${where.join(" AND ")}
ORDER BY created_at DESC
LIMIT ${limitParam}`,
        values,
      },
    ],
  });
  return ((res?.rows ?? []) as Row[]).map(rowToRecord);
}

export function countArtifactPromotionRequests(input: {
  orgId: string;
  status?: ArtifactPromotionRequestStatus;
  requestedBy?: string;
  excludeRequester?: string;
}): number {
  ensurePostgresSchema();
  const schema = q();
  const where: string[] = ["org_id = $1"];
  const values: unknown[] = [input.orgId];
  if (input.status) {
    values.push(input.status);
    where.push(`status = $${values.length}`);
  }
  if (input.requestedBy) {
    values.push(input.requestedBy);
    where.push(`requested_by = $${values.length}`);
  }
  if (input.excludeRequester) {
    values.push(input.excludeRequester);
    where.push(`requested_by <> $${values.length}`);
  }
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT COUNT(*)::int AS count FROM "${schema}"."artifact_promotion_request" WHERE ${where.join(" AND ")}`,
        values,
      },
    ],
  });
  const rows = (res?.rows ?? []) as { count: number }[];
  return rows[0]?.count ?? 0;
}

/**
 * CAS-guarded decide: pending → approved | rejected. The WHERE pins
 * `status = 'pending'` so exactly one decider wins; the win is the UPDATE's
 * rowCount, returned as a boolean (never a throw). A `false` means the row was
 * already decided / superseded / vanished — the caller maps it to a conflict.
 */
export function casDecideArtifactPromotionRequest(input: {
  id: string;
  orgId: string;
  decidedBy: string;
  decision: "approve" | "reject";
  note?: string | null;
}): boolean {
  ensurePostgresSchema();
  const schema = q();
  const nextStatus: ArtifactPromotionRequestStatus =
    input.decision === "approve" ? "approved" : "rejected";
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `UPDATE "${schema}"."artifact_promotion_request"
SET status = $3,
    decided_by = $4,
    decided_at = now(),
    decision_note = $5,
    updated_at = now()
WHERE id = $1 AND org_id = $2 AND status = 'pending'`,
        values: [input.id, input.orgId, nextStatus, input.decidedBy, input.note ?? null],
      },
    ],
  });
  return (res?.rowCount ?? 0) === 1;
}

/** Move a pending request to `superseded` (an edit-after-request invalidated
 *  the reviewed snapshot). CAS on `status = 'pending'`; the boolean is the win. */
export function markArtifactPromotionRequestSuperseded(input: {
  id: string;
  orgId: string;
}): boolean {
  ensurePostgresSchema();
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `UPDATE "${schema}"."artifact_promotion_request"
SET status = 'superseded', updated_at = now()
WHERE id = $1 AND org_id = $2 AND status = 'pending'`,
        values: [input.id, input.orgId],
      },
    ],
  });
  return (res?.rowCount ?? 0) === 1;
}

/**
 * COMPENSATE a just-claimed 'approved' request whose version-guarded widen did
 * NOT land. The decide path claims 'approved' BEFORE applying the widen so the
 * failure is fail-CLOSED (the row is never widened unless the whole apply
 * succeeds); this reverses the claim so no falsely-'approved' request is left
 * stranded:
 *   - `to: 'superseded'` — the approval is permanently void (a concurrent edit
 *     moved the row past the CAS / the row vanished); the decided_by/at stay as
 *     the audit that it WAS approved then voided.
 *   - `to: 'pending'`    — a TRANSIENT apply failure; clear the decision so a
 *     retry re-decides (the version-guarded widen is idempotent on retry).
 * CAS on `status = 'approved'`; the boolean is the win.
 */
export function compensateApprovedArtifactPromotionRequest(input: {
  id: string;
  orgId: string;
  to: "pending" | "superseded";
}): boolean {
  ensurePostgresSchema();
  const schema = q();
  const clearDecision = input.to === "pending";
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `UPDATE "${schema}"."artifact_promotion_request"
SET status = $3,
    decided_by = CASE WHEN $4 THEN NULL ELSE decided_by END,
    decided_at = CASE WHEN $4 THEN NULL ELSE decided_at END,
    decision_note = CASE WHEN $4 THEN NULL ELSE decision_note END,
    updated_at = now()
WHERE id = $1 AND org_id = $2 AND status = 'approved'`,
        values: [input.id, input.orgId, input.to, clearDecision],
      },
    ],
  });
  return (res?.rowCount ?? 0) === 1;
}

/**
 * Resolve a widen-target TEAM within the caller's organization (Better Auth
 * shape: `public."team" (id, name, organizationId)` + `public."teamMember"
 * (teamId, userId)`; `teamMember` has no organizationId so the join goes
 * through `team` — the same join `readChatThreadForClassifier` uses).
 *
 * Fail-closed tenant containment for artifact promotion (codex finding on
 * cinatra#1437): a request may only target a team that EXISTS in the active
 * org, and — when `memberUserId` is given (request time) — one the requester
 * is a member of. Returns the display name for the reviewer-facing snapshot;
 * null is the single indistinguishable refusal (no existence-vs-membership
 * probe oracle).
 */
export function readTeamInOrgSync(input: {
  teamId: string;
  orgId: string;
  memberUserId?: string;
}): { id: string; name: string } | null {
  const membershipJoin = input.memberUserId
    ? `JOIN public."teamMember" tm ON tm."teamId" = t.id AND tm."userId" = $3`
    : "";
  const values: unknown[] = [input.teamId, input.orgId];
  if (input.memberUserId) values.push(input.memberUserId);
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT t.id, t.name
FROM public."team" t
${membershipJoin}
WHERE t.id = $1 AND t."organizationId" = $2
LIMIT 1`,
        values,
      },
    ],
  });
  const row = res?.rows?.[0] as { id: string; name: string } | undefined;
  return row ? { id: row.id, name: row.name } : null;
}
