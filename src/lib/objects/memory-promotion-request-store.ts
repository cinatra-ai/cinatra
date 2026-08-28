import "server-only";

import { randomUUID } from "node:crypto";

import {
  getPostgresConnectionString,
  ensurePostgresSchema,
  postgresSchema,
} from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import type { CoCommitStatement } from "@/lib/object-history/types";

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
export type MemoryPromotionRejectOutcome =
  | { ok: true }
  /** The request was not pending: somebody else decided it first. */
  | { ok: false; reason: "not_pending" }
  /** The decider held no membership in this organization AT THE WRITE. */
  | { ok: false; reason: "not_a_member" };

export function casRejectMemoryPromotionRequest(input: {
  id: string;
  orgId: string;
  decidedBy: string;
  note?: string | null;
  /** The decider whose org MEMBERSHIP must hold AT THE MOMENT OF THE WRITE.
   *  Omit only for a caller that has no membership to assert. */
  requireMemberUserId?: string;
}): MemoryPromotionRejectOutcome {
  ensurePostgresSchema();
  const schema = q();
  const values: unknown[] = [input.id, input.orgId, input.decidedBy, input.note ?? null];

  // MEMBERSHIP IN THE SAME STATEMENT, AND ITS OWN ANSWER OUT OF IT.
  //
  // The ladder pre-checks the decider's membership so the ordinary refusal has
  // an actionable message. That read and this write are two operations, so a
  // membership revoked in between would otherwise let a now-non-member reject
  // an organization's request permanently. Carrying the predicate INSIDE the
  // UPDATE closes that window: one statement is one snapshot, and `FOR SHARE`
  // makes a concurrent revocation wait for this statement rather than commit
  // underneath it.
  //
  // WHY THE STATEMENT ALSO RETURNS THE MEMBERSHIP COUNT (codex round 2 of the
  // #1381 review round). A lost CAS has two possible causes and one rowCount,
  // so asking a SECOND time afterwards cannot say which: the second read sees a
  // newer world and would report "decided concurrently" for a membership that
  // was restored, or `not_authorized` for a race that a real member lost. Both
  // counts are measured HERE, at one snapshot, so the cause the caller is told
  // is the cause that actually applied.
  let text: string;
  if (input.requireMemberUserId === undefined) {
    text = `WITH updated AS (
  UPDATE "${schema}"."${T}"
  SET status = 'rejected', decided_by = $3, decided_at = now(),
      decision_note = $4, updated_at = now()
  WHERE id = $1 AND org_id = $2 AND status = 'pending'
  RETURNING id
)
SELECT (SELECT count(*) FROM updated)::int AS updated, 1 AS member`;
  } else {
    values.push(input.requireMemberUserId);
    text = `WITH member_locked AS (
  SELECT 1 AS ok FROM public."member" m
  WHERE m."organizationId" = $2 AND m."userId" = $${values.length}
  FOR SHARE
),
updated AS (
  UPDATE "${schema}"."${T}"
  SET status = 'rejected', decided_by = $3, decided_at = now(),
      decision_note = $4, updated_at = now()
  WHERE id = $1 AND org_id = $2 AND status = 'pending'
    AND EXISTS (SELECT 1 FROM member_locked)
  RETURNING id
)
SELECT (SELECT count(*) FROM updated)::int AS updated,
       (SELECT count(*) FROM member_locked)::int AS member`;
  }

  const [res] = runPostgresQueriesSync({
    connectionString: conn(),
    queries: [{ text, values }],
  });
  const row = (res?.rows?.[0] ?? {}) as { updated?: number; member?: number };
  if (Number(row.updated ?? 0) === 1) return { ok: true };
  // Membership first: it is the stronger statement about this caller, and at
  // this one snapshot it is the reason the UPDATE could not have matched.
  if (Number(row.member ?? 0) === 0) return { ok: false, reason: "not_a_member" };
  return { ok: false, reason: "not_pending" };
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
}): CoCommitStatement {
  const schema = q();
  return {
    kind: "memory-promotion-approve-claim",
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

/**
 * The TEAM-target containment assert, as a CO-COMMIT statement.
 *
 * Closes the residual the artifact sibling documents and leaves open: its
 * containment check runs in its own read, so a team deleted or moved to another
 * organization in the window between that read and the widen still ends up as
 * the row's owner. Here the predicate rides INSIDE the apply transaction, so a
 * team that is not in this organization AT COMMIT TIME aborts the widen, the
 * claim, the history event and the outbox row together.
 *
 * IT LOCKS, it does not merely look (codex round 2, finding 1). An unlocked
 * `EXISTS` inside the transaction still leaves a window: under READ COMMITTED a
 * concurrent transaction can delete the team, or move it to another
 * organization, AFTER this statement reads it and commit before this one does —
 * and nothing would fail. `FOR SHARE` takes a shared row lock that is held for
 * the REST of this transaction, so a concurrent DELETE or UPDATE of that team
 * row blocks until the promotion commits or rolls back. The containment the
 * assert reports is therefore the containment at COMMIT time, which is the only
 * one that matters. `FOR SHARE` rather than `FOR KEY SHARE`: moving a team to
 * another organization is a NON-key update, and only `FOR SHARE` conflicts with
 * that.
 *
 * It raises the same way every other in-transaction assert on this path does
 * (division by zero on an empty match), so a race resolves as a stale snapshot:
 * the destination the reviewer approved is not the destination that exists, and
 * the request is void rather than applied to a different place.
 *
 * The pre-check in the decide ladder is NOT redundant. It runs first and gives
 * the reviewer an actionable `invalid_state` message in the ordinary case; this
 * statement is the guarantee for the window the pre-check cannot cover.
 */
export function buildMemoryPromotionTeamContainmentAssert(input: {
  teamId: string;
  orgId: string;
}): CoCommitStatement {
  return {
    kind: "memory-promotion-team-containment-assert",
    text: `WITH locked AS (
             SELECT 1 AS ok
             FROM public."team" t
             WHERE t.id = $1 AND t."organizationId" = $2
             FOR SHARE
           )
           SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM locked) THEN 1 ELSE 0 END AS ok`,
    values: [input.teamId, input.orgId],
  };
}

/**
 * The REQUESTER-MEMBERSHIP assert, as a CO-COMMIT statement.
 *
 * The request surface only ever opens a TEAM request for a team the REQUESTER
 * belongs to. That condition was checked once, when the request was opened, and
 * a pending request can outlive it: a requester removed from the team while the
 * request sat pending would otherwise still get the row moved into that team
 * (cinatra#1381 review, finding 4).
 *
 * Same shape and same reasoning as the containment assert next to it. It LOCKS
 * the membership row `FOR SHARE`, so a concurrent DELETE of that membership
 * blocks until this transaction commits or rolls back, and the membership the
 * assert reports is the membership at COMMIT time. It raises the same way every
 * other in-transaction assert on this path does (division by zero on an empty
 * match), so a race resolves as a stale snapshot rather than a widen into a
 * team the requester has left.
 *
 * The decide ladder pre-checks the same predicate for an actionable message;
 * this statement is the guarantee for the window the pre-check cannot cover.
 */
export function buildMemoryPromotionRequesterMembershipAssert(input: {
  teamId: string;
  userId: string;
}): CoCommitStatement {
  return {
    kind: "memory-promotion-requester-membership-assert",
    text: `WITH locked AS (
             SELECT 1 AS ok
             FROM public."teamMember" tm
             WHERE tm."teamId" = $1 AND tm."userId" = $2
             FOR SHARE
           )
           SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM locked) THEN 1 ELSE 0 END AS ok`,
    values: [input.teamId, input.userId],
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
 *   2. the audience predicate is the TARGET's, INTERSECTED with what the
 *      VIEWER may already see, and every arm of it is a clause the CANONICAL
 *      read filter (`derived-store-ownership.ts`) would also admit, never a
 *      near-miss of one. For an organization target that is the org-VISIBLE
 *      rows (`visibility = 'organization'`), not the org-OWNED ones: an
 *      org-owned row that is only team-visible is readable by nobody here. For a TEAM target the team's own rows are counted ONLY
 *      when the viewer is a member of that team — an org admin reviewing a
 *      promotion into a team they are not in would otherwise learn that the team
 *      already holds a concept with this identity, which is an existence oracle
 *      over content they cannot read (codex round 1, finding 2). A user-owned
 *      `visibility='team'` row is NOT team-readable at all (the same asymmetry
 *      `deriveScopeLane` documents), so it is never in the audience either.
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
  /** The VIEWER the hint is being computed for. A team-owned row is counted
   *  only when this user is a member of the target team. */
  viewerId: string;
}): number {
  ensurePostgresSchema();
  const schema = q();
  const values: unknown[] = [input.orgId, input.objectId, input.objectType];
  // The ORGANIZATION arm is `visibility = 'organization'` and NOTHING ELSE.
  //
  // It used to also carry `OR other.owner_level = 'organization'`, which is a
  // NEAR-MISS of the reader's rule rather than the reader's rule (cinatra#1381
  // review, finding 6). `owner_level = 'organization'` with
  // `visibility = 'team'` is a legal tuple in the canonical vocabulary, and NO
  // clause in `derived-store-ownership.ts` admits it to an ordinary member or
  // admin, so that arm let the count be raised by a row the approver cannot
  // read, which is the existence oracle the team arm was narrowed to close.
  // Every row this flow actually promotes to an organization target is written
  // `organization/organization`, so the narrowed arm still counts them all.
  const orgVisible = `other.visibility = 'organization'`;
  let audience = `(${orgVisible})`;
  if (input.toVisibility === "team") {
    values.push(input.toOwnerId);
    const teamParam = `$${values.length}`;
    values.push(input.viewerId);
    const viewerParam = `$${values.length}`;
    audience = `((other.owner_level = 'team' AND other.owner_id = ${teamParam}
                  AND EXISTS (SELECT 1 FROM public."teamMember" tm
                              WHERE tm."teamId" = ${teamParam} AND tm."userId" = ${viewerParam}))
                 OR ${orgVisible})`;
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
