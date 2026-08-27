import "server-only";

import { randomUUID } from "node:crypto";

import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";

import { MEMORY_PROMOTION_REQUEST_TABLE } from "./memory-promotion-request-schema";

// The widen-target TEAM containment reader is SHARED with the artifact
// promotion flow, not re-implemented here: both flows ask the same question
// ("is this team in this org, and — at request time — is this user in it?")
// against the same Better Auth tables, and two copies of a tenant-containment
// query is exactly how the two would drift. Re-exported so this store presents
// one surface to its own data layer.
export { readTeamInOrgSync } from "./artifact-promotion-request-store";

// ---------------------------------------------------------------------------
// memory_promotion_request store (cinatra#1381, epic #1373).
//
// Pending requests to WIDEN one memory row's ownership/visibility tuple
// (`user/private -> team/team | organization/organization`, `team/team ->
// organization/organization`) through the shared approvals surface (promotion
// subject type "memory", `sources/promotion-requests.ts`). Pending state lives
// ONLY on this row; the memory OBJECT is widened only inside the ONE
// transaction an approve runs in `memory-row-promotion.ts`.
//
// Mirrors the `artifact_promotion_request` store idiom: synchronous raw SQL via
// runPostgresQueriesSync, business decisions are VALUES (a lost CAS is `false`,
// never a throw), CAS via a guarded UPDATE whose win is the UPDATE's rowCount
// (NOT a status re-read — two same-decision racers both re-read the decided
// status, but only one gets rowCount = 1).
//
// WHERE IT DIVERGES FROM THE ARTIFACT SIBLING — and it is the point of this
// issue. The artifact flow CLAIMS the request in one transaction and applies
// the widen in a second, then COMPENSATES the claim when the apply fails. This
// flow has no compensation because it has no window to compensate: the claim
// statement is built here (`buildMemoryPromotionApproveClaim`) and co-committed
// with the widen, the object history append and the Graphiti re-projection
// enqueue in ONE transaction, so either all four land or none does.
// ---------------------------------------------------------------------------

const conn = (): string => getPostgresConnectionString();
const q = (): string => postgresSchema.replaceAll('"', '""');
const T = MEMORY_PROMOTION_REQUEST_TABLE;

export type MemoryPromotionRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "superseded";

/** A widen target the decide path applies to the memory object row. */
export type MemoryPromotionVisibility = "team" | "organization";

export type MemoryPromotionRequestRow = {
  id: string;
  orgId: string;
  objectId: string;
  /** Human title snapshotted at request time (a review row never re-reads the
   *  object just to render a label). */
  objectTitle: string;
  requestedBy: string;
  /** The SOURCE tuple, BOTH axes — the transition matrix is a rule about the
   *  whole `(ownerLevel, visibility)` pair, not about visibility alone. */
  fromOwnerLevel: string;
  fromOwnerId: string;
  fromVisibility: string;
  toVisibility: MemoryPromotionVisibility;
  /** The ownership axes the widen writes alongside `toVisibility`, so the
   *  graphiti scope->lane policy (cinatra#1379) resolves the new lane. */
  toOwnerLevel: string;
  toOwnerId: string;
  /** DISPLAY-ONLY snapshot of the widen target's human label (the team name).
   *  Null for organization targets. Never used for authorization. */
  toOwnerLabel: string | null;
  /** objects.version captured at request time (the CAS anchor). */
  rowVersion: number;
  status: MemoryPromotionRequestStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Raised when a second pending request is opened for a row that already has
 *  one in flight (the `mpr_one_pending` generated-column UNIQUE constraint). A
 *  VALUE-shaped refusal at the data layer above translates it. */
export class MemoryPromotionRequestConflictError extends Error {
  constructor(objectId: string) {
    super(`${T}: a pending promotion already exists for object ${objectId}`);
    this.name = "MemoryPromotionRequestConflictError";
  }
}

type Row = {
  id: string;
  org_id: string;
  object_id: string;
  object_title: string;
  requested_by: string;
  from_owner_level: string;
  from_owner_id: string;
  from_visibility: string;
  to_visibility: MemoryPromotionVisibility;
  to_owner_level: string;
  to_owner_id: string;
  to_owner_label: string | null;
  row_version: number;
  status: MemoryPromotionRequestStatus;
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

function rowToRecord(row: Row): MemoryPromotionRequestRow {
  return {
    id: row.id,
    orgId: row.org_id,
    objectId: row.object_id,
    objectTitle: row.object_title,
    requestedBy: row.requested_by,
    fromOwnerLevel: row.from_owner_level,
    fromOwnerId: row.from_owner_id,
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

export function createMemoryPromotionRequest(input: {
  orgId: string;
  objectId: string;
  objectTitle: string;
  requestedBy: string;
  fromOwnerLevel: string;
  fromOwnerId: string;
  fromVisibility: string;
  toVisibility: MemoryPromotionVisibility;
  toOwnerLevel: string;
  toOwnerId: string;
  toOwnerLabel: string | null;
  rowVersion: number;
}): MemoryPromotionRequestRow {
  ensurePostgresSchema();
  const schema = q();
  const id = randomUUID();
  let rowCount = 0;
  try {
    const [res] = runPostgresQueriesSync({
      connectionString: conn(),
      queries: [
        {
          text: `INSERT INTO "${schema}"."${T}" (
  id, org_id, object_id, object_title, requested_by,
  from_owner_level, from_owner_id, from_visibility,
  to_visibility, to_owner_level, to_owner_id, to_owner_label, row_version, status
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending')`,
          values: [
            id,
            input.orgId,
            input.objectId,
            input.objectTitle,
            input.requestedBy,
            input.fromOwnerLevel,
            input.fromOwnerId,
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
    if (isUniqueViolation(error)) throw new MemoryPromotionRequestConflictError(input.objectId);
    throw error;
  }
  if (rowCount !== 1) throw new MemoryPromotionRequestConflictError(input.objectId);
  return readMemoryPromotionRequestById(id, input.orgId)!;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error ?? "");
  // pg unique_violation SQLSTATE, or the sync bridge's stringified message.
  return code === "23505" || /duplicate key|unique constraint|mpr_one_pending/i.test(message);
}

export function readMemoryPromotionRequestById(
  id: string,
  orgId: string,
): MemoryPromotionRequestRow | null {
  ensurePostgresSchema();
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT * FROM "${schema}"."${T}" WHERE id = $1 AND org_id = $2`,
        values: [id, orgId],
      },
    ],
  });
  const row = res?.rows?.[0] as Row | undefined;
  return row ? rowToRecord(row) : null;
}

export function listMemoryPromotionRequests(input: {
  orgId: string;
  status?: MemoryPromotionRequestStatus | "all";
  requestedBy?: string;
  /** Exclude rows requested by this user — the Inbox is someone-ELSE's work. */
  excludeRequester?: string;
  limit?: number;
}): MemoryPromotionRequestRow[] {
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
        text: `SELECT * FROM "${schema}"."${T}"
WHERE ${where.join(" AND ")}
ORDER BY created_at DESC
LIMIT ${limitParam}`,
        values,
      },
    ],
  });
  return ((res?.rows ?? []) as Row[]).map(rowToRecord);
}

export function countMemoryPromotionRequests(input: {
  orgId: string;
  status?: MemoryPromotionRequestStatus;
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
        text: `SELECT COUNT(*)::int AS count FROM "${schema}"."${T}" WHERE ${where.join(" AND ")}`,
        values,
      },
    ],
  });
  const rows = (res?.rows ?? []) as { count: number }[];
  return rows[0]?.count ?? 0;
}

/**
 * CAS-guarded REJECT: pending -> rejected. The WHERE pins `status = 'pending'`
 * so exactly one decider wins; the win is the UPDATE's rowCount, returned as a
 * boolean (never a throw). The memory row is NEVER touched on this path — that
 * is why a reject is a plain single-statement update while an approve is the
 * co-committed claim below.
 */
export function casRejectMemoryPromotionRequest(input: {
  id: string;
  orgId: string;
  decidedBy: string;
  note?: string | null;
}): boolean {
  ensurePostgresSchema();
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `UPDATE "${schema}"."${T}"
SET status = 'rejected',
    decided_by = $3,
    decided_at = now(),
    decision_note = $4,
    updated_at = now()
WHERE id = $1 AND org_id = $2 AND status = 'pending'`,
        values: [input.id, input.orgId, input.decidedBy, input.note ?? null],
      },
    ],
  });
  return (res?.rowCount ?? 0) === 1;
}

/** Move a pending request to `superseded` (an edit-after-request invalidated
 *  the reviewed snapshot). CAS on `status = 'pending'`; the boolean is the win.
 *  The memory row is untouched. */
export function markMemoryPromotionRequestSuperseded(input: {
  id: string;
  orgId: string;
}): boolean {
  ensurePostgresSchema();
  const schema = q();
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `UPDATE "${schema}"."${T}"
SET status = 'superseded', updated_at = now()
WHERE id = $1 AND org_id = $2 AND status = 'pending'`,
        values: [input.id, input.orgId],
      },
    ],
  });
  return (res?.rowCount ?? 0) === 1;
}

/**
 * The APPROVE claim as a STATEMENT rather than an executed update — the piece
 * that makes the apply atomic (the issue's atomic-apply bullet).
 *
 * The caller co-commits this statement with the canonical writer's own
 * widen/history/outbox statement inside ONE org-write-guarded transaction, so
 * the request transition and the row widen are the same commit. There is no
 * claimed-but-unapplied state to compensate, and no window in which a reader
 * sees an `approved` request over an un-widened row.
 *
 * FAIL-CLOSED ON A LOST CAS. The statement asserts its own rowCount inside SQL:
 * when the guarded UPDATE matches nothing (a concurrent decider already moved
 * the request out of `pending`), the `1/0` in `claim_assert` raises and the
 * whole transaction — widen, history and outbox included — rolls back. The
 * canonical writer's own CAS uses the same division-by-zero idiom, so the two
 * raises are NOT distinguishable by SQLSTATE; the decide path re-reads the
 * request afterwards to say which one fired. That post-hoc read is sound
 * because both outcomes left the world unchanged.
 */
export function buildMemoryPromotionApproveClaim(input: {
  id: string;
  orgId: string;
  decidedBy: string;
  note?: string | null;
  /** The version the request captured. Pinned in the WHERE as well, so a
   *  request whose captured anchor was somehow rewritten cannot be claimed. */
  expectedRowVersion: number;
}): { text: string; values: unknown[] } {
  const schema = q();
  return {
    text: `WITH claimed AS (
             UPDATE "${schema}"."${T}"
             SET status = 'approved',
                 decided_by = $3,
                 decided_at = now(),
                 decision_note = $4,
                 updated_at = now()
             WHERE id = $1 AND org_id = $2 AND status = 'pending' AND row_version = $5
             RETURNING id
           ),
           claim_assert AS (
             SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM claimed) THEN 1 ELSE 0 END AS ok
           )
           SELECT ok FROM claim_assert`,
    values: [input.id, input.orgId, input.decidedBy, input.note ?? null, input.expectedRowVersion],
  };
}

// ── advisory duplicate signal (memory-specific, cinatra#1381) ───────────────

/**
 * COUNT memory rows that already carry the same concept identity AND are
 * already visible to the REQUESTED TARGET AUDIENCE. Advisory only — it never
 * gates a decision, and it returns a COUNT and nothing else.
 *
 * THREE PRIVACY PROPERTIES, all enforced in the SQL rather than by the caller:
 *
 *   1. `other.visibility <> 'private'` — a private row is never inspected and
 *      never contributes, so the signal can never tell an approver that some
 *      other person holds a similar private note. This is the AC's "never
 *      inspect or signal another user's private row", written as a predicate.
 *   2. the audience predicate is the TARGET's, not the viewer's: for an
 *      organization target, org-visible rows; for a team target, rows the team
 *      actually owns plus the org-visible ones. A user-owned `visibility='team'`
 *      row is NOT team-readable (the same asymmetry `deriveScopeLane` documents)
 *      so it is excluded.
 *   3. the comparison key is computed on BOTH sides in this one statement, from
 *      the subject row itself, so a caller cannot supply a probe key of its own
 *      choosing and use the count as an existence oracle.
 *
 * The count UNDER-reports rather than over-reports by design; an advisory
 * signal that leaks is worse than one that misses.
 */
export function countAudienceVisibleMemoryDuplicates(input: {
  orgId: string;
  objectId: string;
  objectType: string;
  toVisibility: MemoryPromotionVisibility;
  /** The target team id for a team target; ignored for an organization one. */
  toOwnerId: string;
}): number {
  ensurePostgresSchema();
  const schema = q();
  const values: unknown[] = [input.orgId, input.objectId, input.objectType];
  let audience = `(other.visibility = 'organization' OR other.owner_level = 'organization')`;
  if (input.toVisibility === "team") {
    values.push(input.toOwnerId);
    audience = `((other.owner_level = 'team' AND other.owner_id = $${values.length})
                 OR other.visibility = 'organization' OR other.owner_level = 'organization')`;
  }
  const key = (alias: string) =>
    `lower(btrim(coalesce(${alias}.data->'frontmatter'->>'title', ${alias}.data->>'conceptId', '')))`;
  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [
      {
        text: `SELECT COUNT(*)::int AS count
FROM "${schema}"."objects" other
JOIN "${schema}"."objects" subj
  ON subj.id = $2 AND subj.org_id = $1 AND subj.deleted_at IS NULL
WHERE other.org_id = $1
  AND other.type = $3
  AND other.deleted_at IS NULL
  AND other.id <> subj.id
  AND other.visibility <> 'private'
  AND ${audience}
  AND ${key("other")} = ${key("subj")}
  AND ${key("subj")} <> ''
  AND coalesce(other.data->>'okfType', '') = coalesce(subj.data->>'okfType', '')`,
        values,
      },
    ],
  });
  const rows = (res?.rows ?? []) as { count: number }[];
  return rows[0]?.count ?? 0;
}
