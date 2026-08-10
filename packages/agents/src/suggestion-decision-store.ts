import "server-only";

// ---------------------------------------------------------------------------
// suggestion-decision-store (cinatra#2571, epic #2564 S6b).
//
// The READ side of the suggestion partition, and the DRAIN side of the
// application-intent outbox. The WRITE side is deliberately NOT here: ledger rows
// and the intent row are written by `artifact-review-gate-store.commitReviewDecision`,
// inside the same transaction as the gate CAS, because the reviewer's per-item
// choices are part of the one decision that CAS resolves. A module that could
// write them separately would be the parallel approval path #2047 row 8 bans.
//
// WHAT LIVES HERE, and why each piece is where it is.
//
//   readSurfacedSuggestionsForGate — the decision core's `readSurfacedSuggestions`
//     port. Resolves the gate, then reads its ONE hash-verified snapshot. A gate
//     with no snapshot, and a snapshot whose bytes no longer verify, both answer
//     null — which makes every id in a partition unsurfaced, which refuses the
//     decision. That direction is the only safe one: a tampered row must never be
//     presumed to have surfaced MORE than it did.
//
//   the drain (claim / mark-applied / mark-done / dead-letter / ops reads) — the
//     lease machinery, mirroring `artifact-review-gate-store`'s resume drain
//     statement for statement, because the contract is identical: EXACTLY-ONCE
//     PERSISTENCE (the intent was written in the CAS transaction, PK gate_id), and
//     AT-LEAST-ONCE DELIVERY (a worker can apply and then crash before marking
//     done; the expired lease is re-claimed).
//
// WHAT MAKES A REPLAY A NO-OP is the per-item `applied_at` stamp: the drain reads
// the still-UNAPPLIED accepted items (`readUnappliedAcceptedSuggestions`), applies
// only those, and stamps each through a CAS that exactly one caller can win. A
// re-claimed intent therefore finds nothing left to do and closes.
//
// THE STAMP IS LEASE-FENCED (Codex round 1). The CAS predicate is not merely
// `applied_at IS NULL`: the caller must also hold the intent's LIVE lease. Without
// that, any module could record an effect that never happened, and a worker whose
// lease had lapsed could stamp an item a DIFFERENT worker was re-applying. The
// ledger can now only be written by the worker that currently owns the intent.
//
// WHAT IS EXACTLY ONCE, AND WHAT IS NOT — stated precisely, because the sibling
// resume outbox makes the same distinction. The intent is persisted EXACTLY ONCE
// (PK gate_id, written inside the gate-CAS transaction) and the ledger RECORD of
// an application is written exactly once (the fenced CAS). DELIVERY is
// AT-LEAST-ONCE: the applier's effect runs BEFORE the stamp, so a worker that
// applies and then crashes will re-apply that item when its lease lapses.
// The registered applier must therefore be idempotent per (snapshot, suggestion) —
// the same contract the resume consumer carries. Stamping FIRST would trade this
// for something worse: a transient applier failure would leave a permanently-lost
// effect that the ledger nonetheless records as applied.
//
// THE LEDGER IS APPEND-ONLY EXCEPT FOR THAT ONE STAMP. There is no UPDATE in this
// module that touches `decision`, `decided_by` or `decision_fingerprint`: a
// recorded decision is history. The only mutation is `applied_at`, and only from
// NULL.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";

import { db } from "./db";
import {
  artifactReviewGates,
  suggestionApplicationOutbox,
  suggestionDecisionLedger,
} from "./schema";
import { readVerifiedSuggestionSnapshotForGate } from "./gate-suggestion-snapshot-store";
import type { ProducedSuggestion } from "@/lib/lifecycle/lifecycle-suggestion-producer";

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

/** What a gate's pinned snapshot surfaced — the set a partition is checked against. */
export interface SurfacedSuggestionSet {
  snapshotId: string;
  suggestionIds: string[];
}

/**
 * The decision core's `readSurfacedSuggestions` port, bound to the live stores.
 *
 * Returns null for a gate that does not exist, a gate with no snapshot, and a
 * snapshot whose stored bytes fail their hash check. All three mean the same
 * thing to a decision: nothing was surfaced here, so no id may be decided.
 */
export async function readSurfacedSuggestionsForGate(
  runId: string,
  reviewTaskId: string,
): Promise<SurfacedSuggestionSet | null> {
  const gateRows = await db
    .select({ id: artifactReviewGates.id })
    .from(artifactReviewGates)
    .where(
      and(
        eq(artifactReviewGates.runId, runId),
        eq(artifactReviewGates.reviewTaskId, reviewTaskId),
      ),
    )
    .limit(1);
  const gateId = gateRows[0]?.id;
  if (!gateId) return null;

  const snapshot = await readVerifiedSuggestionSnapshotForGate(gateId);
  if (!snapshot) return null;
  return {
    snapshotId: snapshot.id,
    suggestionIds: snapshot.payload.suggestions.map((s) => s.id),
  };
}

/** One recorded per-item decision. */
export interface SuggestionDecisionRow {
  id: string;
  gateId: string;
  snapshotId: string;
  suggestionId: string;
  decision: "applied" | "dismissed";
  decidedBy: string;
  decisionFingerprint: string;
  decidedAt: Date;
  appliedAt: Date | null;
}

/** The gate's decided suggestions, oldest first. Read-only inspection (S6c's
 * chips, the ops surfaces, and the drain's own proofs). */
export async function readSuggestionDecisionsForGate(
  gateId: string,
): Promise<SuggestionDecisionRow[]> {
  const rows = await db
    .select()
    .from(suggestionDecisionLedger)
    .where(eq(suggestionDecisionLedger.gateId, gateId))
    .orderBy(asc(suggestionDecisionLedger.decidedAt), asc(suggestionDecisionLedger.suggestionId));
  return rows.map(toDecisionRow);
}

function toDecisionRow(r: typeof suggestionDecisionLedger.$inferSelect): SuggestionDecisionRow {
  return {
    id: r.id,
    gateId: r.gateId,
    snapshotId: r.snapshotId,
    suggestionId: r.suggestionId,
    decision: r.decision as "applied" | "dismissed",
    decidedBy: r.decidedBy,
    decisionFingerprint: r.decisionFingerprint,
    decidedAt: r.decidedAt,
    appliedAt: r.appliedAt,
  };
}

// ---------------------------------------------------------------------------
// The application-intent drain.
// ---------------------------------------------------------------------------

export interface ApplicationIntentRow {
  gateId: string;
  runId: string;
  reviewTaskId: string;
  snapshotId: string;
  decisionFingerprint: string;
  acceptedIds: string[];
  status: "pending" | "delivering" | "done";
  attempts: number;
  maxAttempts: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
}

function toIntentRow(r: typeof suggestionApplicationOutbox.$inferSelect): ApplicationIntentRow {
  return {
    gateId: r.gateId,
    runId: r.runId,
    reviewTaskId: r.reviewTaskId,
    snapshotId: r.snapshotId,
    decisionFingerprint: r.decisionFingerprint,
    // The column is jsonb; a row whose bytes are not a string array is treated as
    // naming NO accepted ids rather than being coerced — the drain then applies
    // nothing for it instead of guessing at a corrupted set.
    acceptedIds: Array.isArray(r.acceptedIds)
      ? (r.acceptedIds as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
    status: r.status as "pending" | "delivering" | "done",
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    leaseToken: r.leaseToken,
    leaseExpiresAt: r.leaseExpiresAt,
  };
}

/** Read one intent (inspection / proofs). */
export async function readApplicationIntent(
  gateId: string,
): Promise<ApplicationIntentRow | null> {
  const rows = await db
    .select()
    .from(suggestionApplicationOutbox)
    .where(eq(suggestionApplicationOutbox.gateId, gateId))
    .limit(1);
  return rows[0] ? toIntentRow(rows[0]) : null;
}

/**
 * LEASE the next batch of applicable intents (pending, or delivering with an
 * EXPIRED lease — a crashed worker's rows recover). One winner per row
 * (FOR UPDATE SKIP LOCKED), a fresh lease token + expiry stamped, `attempts`
 * incremented. Dead-lettered rows are never re-claimed.
 */
export async function claimPendingApplicationIntents(opts?: {
  limit?: number;
  leaseMs?: number;
}): Promise<ApplicationIntentRow[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 20, 200));
  const leaseMs = Math.max(1000, opts?.leaseMs ?? 60_000);
  const leaseToken = randomUUID();

  const claimed = await db.transaction(async (tx) => {
    const candidates = await tx
      .select({ gateId: suggestionApplicationOutbox.gateId })
      .from(suggestionApplicationOutbox)
      .where(
        and(
          isNull(suggestionApplicationOutbox.deadLetteredAt),
          // EXHAUSTED rows are not claimable (Codex round 1, finding 2). Without
          // this, an intent that used its last attempt is re-leased on the next
          // sweep as attempt N+1 and the dead-letter pass then skips it because
          // its lease is live — a permanently failing intent would churn forever
          // and never reach the ops queue.
          lt(suggestionApplicationOutbox.attempts, suggestionApplicationOutbox.maxAttempts),
          or(
            eq(suggestionApplicationOutbox.status, "pending"),
            and(
              eq(suggestionApplicationOutbox.status, "delivering"),
              lte(suggestionApplicationOutbox.leaseExpiresAt, sql`now()`),
            ),
          ),
        ),
      )
      .orderBy(suggestionApplicationOutbox.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });

    if (candidates.length === 0) return [];
    const ids = candidates.map((c) => c.gateId);
    return tx
      .update(suggestionApplicationOutbox)
      .set({
        status: "delivering",
        leaseToken,
        leaseExpiresAt: sql`now() + (${leaseMs} || ' milliseconds')::interval`,
        attempts: sql`${suggestionApplicationOutbox.attempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(inArray(suggestionApplicationOutbox.gateId, ids))
      .returning();
  });

  return claimed.map(toIntentRow);
}

/** The outcome of claiming ONE accepted suggestion for application. */
export type ApplySuggestionClaim =
  /** This caller won the NULL → now() CAS and owns applying this suggestion. */
  | { status: "claimed" }
  /** Another pass already applied it — a replay, and a no-op by construction. */
  | { status: "already-applied" }
  /** No accepted ledger row for (snapshot, suggestion): the id is not part of
   *  this decision's accepted set. Never applied. */
  | { status: "not-accepted" }
  /** The row is stampable but the caller no longer owns the intent's LIVE lease
   *  (Codex round 1, finding 1) — another worker re-claimed it. The stamp is
   *  refused rather than written by a worker that may no longer be the applier. */
  | { status: "lease-lost" };

/**
 * The accepted suggestions of a snapshot that are still UNAPPLIED — what a drain
 * pass actually has to do. An empty answer means a replay has nothing left, which
 * is what makes the replay a no-op.
 */
export async function readUnappliedAcceptedSuggestions(
  snapshotId: string,
): Promise<string[]> {
  const rows = await db
    .select({ suggestionId: suggestionDecisionLedger.suggestionId })
    .from(suggestionDecisionLedger)
    .where(
      and(
        eq(suggestionDecisionLedger.snapshotId, snapshotId),
        eq(suggestionDecisionLedger.decision, "applied"),
        isNull(suggestionDecisionLedger.appliedAt),
      ),
    )
    .orderBy(asc(suggestionDecisionLedger.suggestionId));
  return rows.map((r) => r.suggestionId);
}

/**
 * Stamp one accepted suggestion APPLIED — LEASE-FENCED (Codex round 1, finding 1).
 *
 * Two predicates, and both are load-bearing:
 *
 *   the LEDGER row must be an accepted one that is not already stamped
 *   (`decision = 'applied' AND applied_at IS NULL`), and
 *
 *   the caller must hold the intent's LIVE lease — the row is stamped only if
 *   this gate's outbox row is `delivering` under THIS `lease_token` with an
 *   unexpired `lease_expires_at`.
 *
 * Without the second predicate any module could record an effect that never
 * happened, and a worker whose lease had already lapsed — while a second worker
 * re-claimed and re-ran the same item — could still win the stamp. Fencing on the
 * live lease means a stamp is only ever written by the worker that currently owns
 * the intent, so the ledger can never claim an application its owner did not
 * perform. `lease-lost` is a distinct, REPORTED outcome, never folded into
 * success.
 *
 * What this does NOT buy, stated plainly: the applier's EFFECT runs before the
 * stamp, so a worker that applies and then loses its lease can have its effect
 * repeated by the next owner. That is at-least-once DELIVERY against an
 * idempotent applier — the contract `artifact-review-resume-delivery` already
 * carries in these words. What is exactly-once is the RECORD.
 */
export async function markSuggestionApplied(input: {
  gateId: string;
  snapshotId: string;
  suggestionId: string;
  leaseToken: string;
}): Promise<ApplySuggestionClaim> {
  const holdsLiveLease = sql`EXISTS (
    SELECT 1 FROM ${suggestionApplicationOutbox}
     WHERE ${suggestionApplicationOutbox.gateId} = ${input.gateId}
       AND ${suggestionApplicationOutbox.leaseToken} = ${input.leaseToken}
       AND ${suggestionApplicationOutbox.status} = 'delivering'
       AND ${suggestionApplicationOutbox.leaseExpiresAt} > now()
  )`;
  const won = await db
    .update(suggestionDecisionLedger)
    .set({ appliedAt: sql`now()` })
    .where(
      and(
        eq(suggestionDecisionLedger.gateId, input.gateId),
        eq(suggestionDecisionLedger.snapshotId, input.snapshotId),
        eq(suggestionDecisionLedger.suggestionId, input.suggestionId),
        eq(suggestionDecisionLedger.decision, "applied"),
        isNull(suggestionDecisionLedger.appliedAt),
        holdsLiveLease,
      ),
    )
    .returning({ id: suggestionDecisionLedger.id });
  if (won.length === 1) return { status: "claimed" };

  // The update matched nothing — discriminate WHY, because the three reasons ask
  // three different things of the drain.
  const existing = await db
    .select({ appliedAt: suggestionDecisionLedger.appliedAt })
    .from(suggestionDecisionLedger)
    .where(
      and(
        eq(suggestionDecisionLedger.gateId, input.gateId),
        eq(suggestionDecisionLedger.snapshotId, input.snapshotId),
        eq(suggestionDecisionLedger.suggestionId, input.suggestionId),
        eq(suggestionDecisionLedger.decision, "applied"),
      ),
    )
    .limit(1);
  if (!existing[0]) return { status: "not-accepted" };
  if (existing[0].appliedAt) return { status: "already-applied" };
  return { status: "lease-lost" };
}

/**
 * Mark a leased intent DONE — single-shot, and guarded by the LIVE lease.
 *
 * The predicate is token + `status='delivering'` + `lease_expires_at > now()` +
 * `dead_lettered_at IS NULL` (Codex round 2). Checking only the TOKEN would leave
 * the same hole the `applied_at` stamp had: expiry is what revokes ownership, and
 * it revokes it the moment it passes — not later, when some other worker happens
 * to write a replacement token. A worker returning from a slow applier after its
 * lease lapsed must not close (or re-open) an intent it no longer owns, and a
 * dead-lettered intent is terminal and must not be quietly marked done.
 *
 * Returns true iff this call owned the live lease.
 */
export async function markApplicationIntentDone(
  gateId: string,
  leaseToken: string,
): Promise<boolean> {
  const done = await db
    .update(suggestionApplicationOutbox)
    .set({ status: "done", updatedAt: sql`now()` })
    .where(
      and(
        eq(suggestionApplicationOutbox.gateId, gateId),
        eq(suggestionApplicationOutbox.leaseToken, leaseToken),
        eq(suggestionApplicationOutbox.status, "delivering"),
        gt(suggestionApplicationOutbox.leaseExpiresAt, sql`now()`),
        isNull(suggestionApplicationOutbox.deadLetteredAt),
      ),
    )
    .returning({ gateId: suggestionApplicationOutbox.gateId });
  return done.length === 1;
}

/**
 * Dead-letter every application intent that has EXHAUSTED its attempts, is not
 * yet `done` / already dead-lettered, and is NOT actively in-flight (a
 * `delivering` row with a LIVE lease is left to finish). Identical eligibility
 * discipline to the resume dead-letter, including the re-asserted predicate under
 * the UPDATE so a concurrent re-claim or completion cannot be dead-lettered out
 * from under itself. Idempotent; returns the count actually transitioned.
 */
export async function deadLetterExhaustedApplicationIntents(opts?: {
  lastError?: string;
  limit?: number;
}): Promise<number> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
  const eligibleCond = and(
    isNull(suggestionApplicationOutbox.deadLetteredAt),
    gte(suggestionApplicationOutbox.attempts, suggestionApplicationOutbox.maxAttempts),
    or(
      eq(suggestionApplicationOutbox.status, "pending"),
      and(
        eq(suggestionApplicationOutbox.status, "delivering"),
        or(
          isNull(suggestionApplicationOutbox.leaseExpiresAt),
          lte(suggestionApplicationOutbox.leaseExpiresAt, sql`now()`),
        ),
      ),
    ),
  );
  const eligible = db
    .select({ gateId: suggestionApplicationOutbox.gateId })
    .from(suggestionApplicationOutbox)
    .where(eligibleCond)
    .limit(limit);
  const dead = await db
    .update(suggestionApplicationOutbox)
    .set({
      deadLetteredAt: sql`now()`,
      lastError: opts?.lastError ?? "suggestion application attempts exhausted",
      updatedAt: sql`now()`,
    })
    .where(and(inArray(suggestionApplicationOutbox.gateId, eligible), eligibleCond))
    .returning({ gateId: suggestionApplicationOutbox.gateId });
  return dead.length;
}

/**
 * Dead-letter ONE leased intent terminally, with its reason — lease-fenced, so a
 * stale worker cannot close another worker's in-flight pass (Codex round 1,
 * finding 3).
 *
 * This is what a terminal REFUSAL lands on. Marking the intent `done` instead
 * would drop it out of every ops read while its accepted suggestions sit
 * unapplied forever, and the console would say "every accepted suggestion has
 * been applied" — a false statement produced by a silent state, which is exactly
 * the defect #2047 D-4 punished. A dead-lettered refusal stays visible and
 * carries its `last_error`.
 */
export async function deadLetterApplicationIntent(
  gateId: string,
  leaseToken: string,
  reason: string,
): Promise<boolean> {
  const dead = await db
    .update(suggestionApplicationOutbox)
    .set({ deadLetteredAt: sql`now()`, lastError: reason, updatedAt: sql`now()` })
    .where(
      and(
        eq(suggestionApplicationOutbox.gateId, gateId),
        eq(suggestionApplicationOutbox.leaseToken, leaseToken),
        eq(suggestionApplicationOutbox.status, "delivering"),
        // The LIVE lease, not merely the token (Codex round 2): a worker whose
        // lease lapsed while its applier ran must not be able to terminally
        // dead-letter an intent that now belongs to someone else.
        gt(suggestionApplicationOutbox.leaseExpiresAt, sql`now()`),
        isNull(suggestionApplicationOutbox.deadLetteredAt),
      ),
    )
    .returning({ gateId: suggestionApplicationOutbox.gateId });
  return dead.length === 1;
}

/** One ops-visible application intent (dead-lettered, or still waiting). */
export interface ApplicationIntentOpsRow {
  gateId: string;
  runId: string;
  reviewTaskId: string;
  acceptedCount: number;
  appliedCount: number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  deadLetteredAt: Date | null;
  createdAt: Date;
  /** The org that owns the gate (the outbox carries no org column — it is joined
   * from the gate, which is what makes the ops surface org-scopable). */
  orgId: string | null;
}

/**
 * Ops visibility: application intents whose attempts were exhausted. The
 * counterpart of `readDeadLetteredResumeIntents`, consumed by
 * `/configuration/lifecycle-operations` — a stuck application must be as visible
 * as a stuck release, or accepting a suggestion becomes a silent no-op.
 *
 * `orgId` SCOPES the read through the joined gate; omitting it returns the
 * unscoped set (tests / a single-org script).
 */
export async function readDeadLetteredApplicationIntents(opts?: {
  orgId?: string;
  limit?: number;
}): Promise<ApplicationIntentOpsRow[]> {
  return readApplicationIntentOps({
    orgId: opts?.orgId,
    limit: opts?.limit,
    filter: isNotNull(suggestionApplicationOutbox.deadLetteredAt),
    order: desc(suggestionApplicationOutbox.deadLetteredAt),
  });
}

/**
 * Ops visibility: intents that are still WAITING to be applied (live, not
 * dead-lettered, not done).
 *
 * This surface exists because of an honest limit of this slice: no production
 * applier is registered yet (see `suggestion-application-delivery.ts`), so a
 * live intent sits here until one is. An accepted suggestion that goes nowhere
 * with nothing to look at would repeat exactly the defect #2047 D-4 punished —
 * a durable state whose contract says an operator can see it, that nothing read.
 */
export async function readAwaitingApplicationIntents(opts?: {
  orgId?: string;
  limit?: number;
}): Promise<ApplicationIntentOpsRow[]> {
  return readApplicationIntentOps({
    orgId: opts?.orgId,
    limit: opts?.limit,
    filter: and(
      isNull(suggestionApplicationOutbox.deadLetteredAt),
      or(
        eq(suggestionApplicationOutbox.status, "pending"),
        eq(suggestionApplicationOutbox.status, "delivering"),
      ),
    ),
    order: asc(suggestionApplicationOutbox.createdAt),
  });
}

async function readApplicationIntentOps(args: {
  orgId?: string;
  limit?: number;
  filter: ReturnType<typeof isNotNull> | ReturnType<typeof and>;
  order: ReturnType<typeof desc>;
}): Promise<ApplicationIntentOpsRow[]> {
  const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
  const where = args.orgId
    ? and(args.filter, eq(artifactReviewGates.orgId, args.orgId))
    : args.filter;
  const rows = await db
    .select({ row: suggestionApplicationOutbox, orgId: artifactReviewGates.orgId })
    .from(suggestionApplicationOutbox)
    .leftJoin(artifactReviewGates, eq(artifactReviewGates.id, suggestionApplicationOutbox.gateId))
    .where(where)
    .orderBy(args.order)
    .limit(limit);
  if (rows.length === 0) return [];

  // The APPLIED count is read from the ledger, not from the intent: the intent
  // knows what was accepted, the ledger knows what actually landed, and the gap
  // between them is the number an operator needs.
  const gateIds = rows.map((r) => r.row.gateId);
  const applied = await db
    .select({
      gateId: suggestionDecisionLedger.gateId,
      count: sql<number>`count(*)::int`,
    })
    .from(suggestionDecisionLedger)
    .where(
      and(
        inArray(suggestionDecisionLedger.gateId, gateIds),
        eq(suggestionDecisionLedger.decision, "applied"),
        isNotNull(suggestionDecisionLedger.appliedAt),
      ),
    )
    .groupBy(suggestionDecisionLedger.gateId);
  const appliedByGate = new Map(applied.map((a) => [a.gateId, a.count]));

  return rows.map(({ row: r, orgId }) => ({
    gateId: r.gateId,
    runId: r.runId,
    reviewTaskId: r.reviewTaskId,
    acceptedCount: toIntentRow(r).acceptedIds.length,
    appliedCount: appliedByGate.get(r.gateId) ?? 0,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    lastError: r.lastError,
    deadLetteredAt: r.deadLetteredAt,
    createdAt: r.createdAt,
    orgId: orgId ?? null,
  }));
}

/**
 * The accepted suggestions an intent names, resolved against the gate's
 * hash-verified snapshot and returned in the snapshot's own order.
 *
 * The intent stores IDS; what an accepted suggestion DOES is read from the
 * immutable snapshot at apply time. That is the property that makes an edited
 * outbox row harmless: an id the snapshot does not carry resolves to nothing, and
 * a snapshot whose bytes no longer verify resolves to nothing at all.
 */
export async function resolveAcceptedSuggestions(
  intent: Pick<ApplicationIntentRow, "gateId" | "snapshotId" | "acceptedIds">,
): Promise<ProducedSuggestion[]> {
  const snapshot = await readVerifiedSuggestionSnapshotForGate(intent.gateId);
  if (!snapshot || snapshot.id !== intent.snapshotId) return [];
  const wanted = new Set(intent.acceptedIds);
  return snapshot.payload.suggestions.filter((s) => wanted.has(s.id));
}
