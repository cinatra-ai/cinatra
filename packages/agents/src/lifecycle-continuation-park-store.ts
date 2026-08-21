import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-continuation-park-store (cinatra#2038, epic #2037 S0)
//
// The durable half of the CHECKPOINTED continuation mode (evaluate-then-park).
// The pre-park synchronous DECISION is the pure `evaluateThenPark`
// (src/lib/lifecycle/lifecycle-continuation.ts); this store PERSISTS the park and
// runs the sweeper:
//
//   maybeParkCheckpoint — parks ONLY when the evaluate-then-park outcome is
//     `park`; a `proceed` (policy skip/forbidden/ungated) NEVER parks (the AC
//     invariant). Idempotent on (run_id, event_id, checkpoint).
//   sweepParks — the resume sweeper. Releases parks whose linked decision
//     RESOLVED (release/skip) and TTL-fail-closes the rest of the DUE parks into a
//     terminal `policy_unresolved` block on the protected effect (always-resume;
//     never an indefinite strand). Ops-surfaced. THE one primitive through which a
//     park leaves `parked`, so it is also where a recommendation hold's human-wait
//     notification is cleared (cinatra#2835).
//   strandPark — the forced-strand GUARD: refuses to tear down a still-parked
//     (non-terminal) park; only an already-resolved park is strippable.
//   readPolicyUnresolvedParks — the ops visibility reader for blocked effects.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte, ne, sql } from "drizzle-orm";

import { db } from "./db";
import { artifactProducedOutbox, lifecycleContinuationPark } from "./schema";
import {
  dispatchRecommendationHoldCleared,
  HOLD_NOTIFICATION_CLEARED,
  HOLD_NOTIFICATION_LIVE,
  RECOMMENDATION_HOLD_CHECKPOINT,
  type HoldNotificationState,
} from "./run-wait-notifier";
import {
  isStrandable,
  resolvePark,
  type EvaluateThenParkOutcome,
} from "@/lib/lifecycle/lifecycle-continuation";

export class ContinuationParkError extends Error {
  readonly code: "forced-strand" | "not-found" | "conflict";
  constructor(code: "forced-strand" | "not-found" | "conflict", message: string) {
    super(message);
    this.name = "ContinuationParkError";
    this.code = code;
  }
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface MaybeParkInput {
  runId: string;
  eventId: string;
  policyDecisionId?: string | null;
  ttlMs?: number;
}

export type MaybeParkResult =
  | { parked: false; reason: string }
  | { parked: true; parkId: string; reevaluationIntent: boolean };

/**
 * Evaluate-then-park: given the pure outcome, park ONLY when it says `park`. A
 * `proceed` outcome returns `parked: false` and writes NO row — the AC invariant
 * that a checkpointed run whose policy says skip never parks. The park row is
 * idempotent on (run_id, event_id, checkpoint): a re-attempt returns the existing
 * park id.
 */
export async function maybeParkCheckpoint(
  outcome: EvaluateThenParkOutcome,
  input: MaybeParkInput,
): Promise<MaybeParkResult> {
  if (outcome.kind === "proceed") {
    return { parked: false, reason: outcome.reason };
  }
  // Floor at 1ms only — a sub-second TTL is the caller's explicit choice; the
  // floor exists solely to bar a zero/negative interval.
  const ttlMs = Math.max(1, input.ttlMs ?? DEFAULT_TTL_MS);

  // Retry once. An insert-conflict means a park already exists for this
  // (run, event, checkpoint) — normally we return it (idempotent). But that park
  // can be concurrently STRANDED (deleted once terminal) between our conflict and
  // our read, leaving the slot free again; rather than fabricate a park id that
  // names no row, we RE-ATTEMPT the insert into the now-free slot.
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = randomUUID();
    const [row] = await db
      .insert(lifecycleContinuationPark)
      .values({
        id,
        runId: input.runId,
        eventId: input.eventId,
        checkpoint: outcome.checkpoint,
        policyDecisionId: input.policyDecisionId ?? null,
        protectedEffect: outcome.protectedEffect,
        reevaluationIntent: outcome.reevaluationIntent,
        status: "parked",
        ttlExpiresAt: sql`now() + (${ttlMs} || ' milliseconds')::interval`,
      })
      .onConflictDoNothing({
        target: [
          lifecycleContinuationPark.runId,
          lifecycleContinuationPark.eventId,
          lifecycleContinuationPark.checkpoint,
        ],
      })
      .returning({ id: lifecycleContinuationPark.id });

    if (row) {
      return { parked: true, parkId: row.id, reevaluationIntent: outcome.reevaluationIntent };
    }
    // Conflict — the slot is occupied. Return the existing park (idempotent) IFF
    // it is still present; if it vanished (concurrently stranded), loop and retry.
    const existing = await db
      .select({ id: lifecycleContinuationPark.id })
      .from(lifecycleContinuationPark)
      .where(
        and(
          eq(lifecycleContinuationPark.runId, input.runId),
          eq(lifecycleContinuationPark.eventId, input.eventId),
          eq(lifecycleContinuationPark.checkpoint, outcome.checkpoint),
        ),
      )
      .limit(1);
    if (existing[0]) {
      return { parked: true, parkId: existing[0].id, reevaluationIntent: outcome.reevaluationIntent };
    }
  }
  throw new ContinuationParkError(
    "conflict",
    `park slot ${input.runId}/${input.eventId}/${outcome.checkpoint} is being concurrently mutated; retry`,
  );
}

export interface ParkRow {
  id: string;
  runId: string;
  eventId: string;
  checkpoint: string;
  policyDecisionId: string | null;
  protectedEffect: string;
  reevaluationIntent: boolean;
  status: "parked" | "released" | "policy_unresolved";
  /** cinatra#2835 — what this park owes the notification feed. See
   * `HoldNotificationState`; only a recommendation hold ever leaves `none`. */
  holdNotification: HoldNotificationState;
  ttlExpiresAt: Date;
  resolvedAt: Date | null;
}

export async function readPark(parkId: string): Promise<ParkRow | null> {
  const rows = await db
    .select()
    .from(lifecycleContinuationPark)
    .where(eq(lifecycleContinuationPark.id, parkId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return toParkRow(r);
}

export interface SweepParksInput {
  /** Park ids whose linked decision RESOLVED (release or resolved-skip) — the
   * sweeper releases these regardless of TTL. */
  resolvedSkipParkIds?: readonly string[];
  releasedParkIds?: readonly string[];
  /** Bound on rows swept per pass. */
  limit?: number;
}

export interface SweepParksResult {
  released: number;
  blocked: number;
  /** cinatra#2835 — hold-notification clear obligations RETIRED this pass (a
   * delete that committed and was acked). Includes obligations left behind by an
   * earlier pass or another sweeper, not only the parks this pass transitioned. */
  holdNotificationsCleared: number;
}

/**
 * The resume sweeper (one pass). Two effects, both CAS-guarded on `status =
 * 'parked'` so a concurrent sweep never double-transitions:
 *
 *   1. RELEASE — parks whose decision resolved (released / resolved-skip) move to
 *      `released` (the protected effect is not blocked). This is the "a parked run
 *      whose decision resolves skip is released by the sweeper" path.
 *   2. TTL FAIL-CLOSE — the remaining DUE parks (ttl_expires_at <= now) always
 *      resume into a terminal `policy_unresolved` block on the protected effect
 *      (ops-surfaced). This is the ONLY path that blocks an effect.
 *
 * The `resolvePark` pure transition dictates the terminal status + whether the
 * effect blocks; the store applies it.
 *
 * cinatra#2835 — this is ALSO where a run-start recommendation hold's "needs your
 * input" notification is CLEARED, because this function is the one primitive
 * through which a park leaves `parked` (`maybeParkCheckpoint` only inserts;
 * `strandPark` refuses anything non-terminal and drains the obligation before it
 * deletes). Wiring the clear into the caller that releases a hold on a human
 * decision — `releaseRecommendationParkForRun` — covered only that one path, and
 * left every OTHER release stale: notably this function's own TTL fail-close,
 * whose production driver is the gate-maintenance drain
 * (`releaseResolvedAutoGateParks`) and which sweeps EVERY due park including a
 * held run's. A hold moves no run status, so no transition would ever clear the
 * row behind it and the bell would point at a card the human can no longer act on,
 * forever. Wired at the primitive, every caller inherits it (Codex convergence
 * round 2, finding 1).
 *
 * THE CLEAR IS AN OBLIGATION, NOT A DISPATCH (Codex convergence round 3, finding
 * 3). It used to be a post-commit, error-swallowing call per park this pass
 * transitioned — so a notifier throw, or a process that died in the microseconds
 * after the CAS, stranded the row permanently: the park was already terminal, and
 * a terminal park can never be re-returned by a later CAS, so nothing would ever
 * retry. The drain below is driven off `hold_notification = 'live'` instead — a
 * flag the ENTER wrote in the same transaction as the notification INSERT — and
 * retires it only on an awaited, successful delete. Two consequences:
 *
 *   - the parks this pass just transitioned are picked up immediately (they are
 *     terminal-and-`live` the instant the CAS commits), so the same-pass clear the
 *     round-2 fix delivered is unchanged in behaviour; and
 *   - anything that goes wrong leaves the obligation standing, and EVERY later
 *     sweep re-drains it. Delete-by-key is idempotent, so over-retrying is free.
 *     That second claim is only true of a FAIR page (cinatra#2838): the drain is
 *     bounded per pass, so an unordered page let `limit` permanently-failing
 *     obligations hold it forever while the ones behind them were never attempted.
 *     The page is claimed oldest-retry-cursor-first — see `drainHoldNotifications`.
 *
 * BOTH arms are covered — a decision-resolved release and a TTL fail-close alike
 * end the human's ability to act — and so is a park some OTHER sweep transitioned,
 * which the old `returning()`-driven collection could not see. A notification can
 * still never fail a sweep: every dispatch is internally swallowed and reports
 * failure by declining to ack.
 */
export async function sweepParks(input: SweepParksInput = {}): Promise<SweepParksResult> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const resolveIds = [
    ...new Set([...(input.resolvedSkipParkIds ?? []), ...(input.releasedParkIds ?? [])]),
  ];

  let released = 0;
  let blocked = 0;

  // 1. Decision-resolved releases (bounded by the caller's explicit id list). The
  // pure transition confirms the effect is not blocked for a resolved-skip /
  // release; the status='parked' CAS makes it exactly-once under concurrent sweeps.
  if (resolveIds.length > 0) {
    const transition = resolvePark({ kind: "resolved_skip" });
    const rows = await db
      .update(lifecycleContinuationPark)
      .set({ status: transition.status, resolvedAt: sql`now()` })
      .where(
        and(
          inArray(lifecycleContinuationPark.id, resolveIds),
          eq(lifecycleContinuationPark.status, "parked"),
        ),
      )
      .returning({ id: lifecycleContinuationPark.id });
    released += rows.length; // the ACTUAL number transitioned
  }

  // 2. TTL fail-close of the due parks, BOUNDED to `limit` per pass via a LIMIT
  // subquery (a bare UPDATE has no LIMIT). The status='parked' CAS keeps it
  // exactly-once; `blocked` reports the ACTUAL count transitioned.
  const ttlTransition = resolvePark({ kind: "ttl_expired" }); // → policy_unresolved, blocked
  const dueIds = db
    .select({ id: lifecycleContinuationPark.id })
    .from(lifecycleContinuationPark)
    .where(
      and(
        eq(lifecycleContinuationPark.status, "parked"),
        lte(lifecycleContinuationPark.ttlExpiresAt, sql`now()`),
      ),
    )
    .limit(limit);
  const dueRows = await db
    .update(lifecycleContinuationPark)
    .set({ status: ttlTransition.status, resolvedAt: sql`now()` })
    .where(
      and(
        inArray(lifecycleContinuationPark.id, dueIds),
        eq(lifecycleContinuationPark.status, "parked"),
      ),
    )
    .returning({ id: lifecycleContinuationPark.id });
  blocked += dueRows.length;

  // The clear-obligation drain. AFTER both CAS updates, so the parks this pass
  // ended are already visible to it.
  const holdNotificationsCleared = await drainHoldNotifications(limit);

  return { released, blocked, holdNotificationsCleared };
}

/**
 * cinatra#2835 — discharge every OUTSTANDING hold-notification clear.
 *
 * The predicate IS the invariant: a park that is no longer `parked` must not have
 * a live "needs your input" row behind it. Every park that violates it — because
 * this pass just transitioned it, because another sweep did, or because an earlier
 * pass's delete failed or never ran — is retried here, bounded to `limit` per pass
 * and index-backed by the partial `…_hold_notify_idx` so the scan sees only parks
 * that actually owe something.
 *
 * FAIR SELECTION, OR THE BOUND IS A STARVATION BOUND (Codex convergence round 4).
 * The page used to be an UNORDERED `limit`, and a failed dispatch was simply
 * skipped with the row left exactly as the scan found it. So `limit` obligations
 * whose dispatch always fails — a notification whose recipient no longer exists, a
 * park whose run row was hard-deleted, any deterministic poison — could occupy the
 * page on EVERY pass, and every obligation behind them was never attempted at all.
 * Not delayed: never attempted. "Every later sweep re-drains every outstanding
 * obligation" was false for anything queued behind the poison.
 *
 * The page is now a CLAIM, ordered by a retry cursor the claim itself advances:
 *
 *   ORDER BY coalesce(hold_notify_attempted_at, created_at) ASC, id ASC
 *
 * — least-recently-touched first, where a never-attempted obligation is ordered by
 * when it was created (the truthful reading of a null cursor: it has waited since
 * the park was written). Claiming STAMPS `hold_notify_attempted_at = now()` on the
 * page in the same statement that selects it, so an attempted row goes to the BACK
 * of the queue before its dispatch is even made. A poison page can therefore delay
 * the obligations behind it by one pass — never starve them: the cursor of every
 * row advances only when that row is served, so each one reaches the front.
 *
 * STAMPED AT CLAIM, NOT AT FAILURE. The weaker shape — bump only when the dispatch
 * comes back false — leaves the same hole one level down: a sweeper that DIES
 * mid-dispatch (or a dispatch that hangs past the loop's lifetime) never records
 * the attempt, so the row it was holding sorts first again on the next pass, and a
 * poison that kills sweepers keeps its place forever. Stamping at claim costs one
 * bounded UPDATE of rows we are about to dispatch for anyway, and makes the
 * rotation independent of how the attempt ends.
 *
 * NOTHING IS DROPPED. The stamp moves a cursor; it does not retire an obligation.
 * A failed dispatch leaves the row `live` and it is re-drained on a later pass,
 * exactly as before — the only change is WHERE in the queue it comes back.
 *
 * FOR UPDATE SKIP LOCKED because sweeps genuinely overlap: the ~60s
 * gate-maintenance loop (`releaseResolvedAutoGateParks`) is not the only driver —
 * `releaseRecommendationParkForRun` sweeps synchronously on a human's confirm/skip,
 * and a deployment runs more than one host. Correctness never depended on it (the
 * delete is idempotent and the ack is a CAS off `'live'`, so a doubly-claimed
 * obligation is dispatched twice and retired once), but without it two concurrent
 * sweeps claim the SAME page and the second does no useful work. With it, the
 * second sweeper skips the locked page and drains the next one.
 *
 * DELETE-THEN-ACK, never the reverse. The ack is a CAS off `'live'`, so two sweeps
 * racing the same park both delete (idempotent) and exactly one acks. Acking first
 * would be the one ordering that can lose an obligation: a crash between the ack
 * and the delete would leave a terminal park marked `cleared` with its row still
 * standing, and nothing would ever look at it again.
 */
async function drainHoldNotifications(limit: number): Promise<number> {
  // The claim page: the `limit` least-recently-attempted live obligations, locked
  // against a concurrent sweeper. A bare UPDATE has no ORDER BY/LIMIT, so the page
  // is chosen by the subquery and the UPDATE stamps exactly what it returns.
  const claimIds = db
    .select({ id: lifecycleContinuationPark.id })
    .from(lifecycleContinuationPark)
    .where(
      and(
        eq(lifecycleContinuationPark.holdNotification, HOLD_NOTIFICATION_LIVE),
        ne(lifecycleContinuationPark.status, "parked"),
        eq(lifecycleContinuationPark.checkpoint, RECOMMENDATION_HOLD_CHECKPOINT),
      ),
    )
    .orderBy(
      sql`coalesce(${lifecycleContinuationPark.holdNotifyAttemptedAt}, ${lifecycleContinuationPark.createdAt}) asc`,
      lifecycleContinuationPark.id,
    )
    .limit(limit)
    .for("update", { skipLocked: true });

  // RETURNING has no defined order, and none is needed: WHICH obligations make up
  // the page is the fairness property, and every row in the page is dispatched in
  // this same pass. The order WITHIN a page changes nothing about which
  // obligations get a turn.
  const owing = await db
    .update(lifecycleContinuationPark)
    .set({ holdNotifyAttemptedAt: sql`now()` })
    .where(inArray(lifecycleContinuationPark.id, claimIds))
    .returning({
      id: lifecycleContinuationPark.id,
      runId: lifecycleContinuationPark.runId,
    });

  let cleared = 0;
  // Sequential: the set is bounded by `limit`, each dispatch is a swallowed
  // best-effort call, and serialising keeps a slow notifier from fanning out
  // connections behind a sweep that is itself already on a schedule.
  for (const park of owing) {
    const committed = await dispatchRecommendationHoldCleared({
      runId: park.runId,
      parkId: park.id,
    });
    if (!committed) continue; // obligation stands, cursor moved; a later sweep retries it.
    const acked = await db
      .update(lifecycleContinuationPark)
      .set({ holdNotification: HOLD_NOTIFICATION_CLEARED })
      .where(
        and(
          eq(lifecycleContinuationPark.id, park.id),
          eq(lifecycleContinuationPark.holdNotification, HOLD_NOTIFICATION_LIVE),
        ),
      )
      .returning({ id: lifecycleContinuationPark.id });
    cleared += acked.length; // the ACTUAL number retired (a racing sweep wins once)
  }
  return cleared;
}

/**
 * The forced-strand GUARD. A park may be torn down ONLY when it is already
 * terminal (released / policy_unresolved) — a still-`parked` (non-terminal) park
 * can NEVER be stranded: every park must terminate through the sweeper. Throws
 * `forced-strand` on an attempt to strip a live park (the AC's "a forced-strand
 * attempt fails").
 *
 * cinatra#2835 — a terminal park may still OWE a hold-notification clear, and the
 * row is the only place that obligation is recorded. Deleting it would abandon the
 * notification with nothing left to re-drive it, so the obligation is discharged
 * FIRST and the teardown proceeds only once it is. A clear that will not commit
 * (no notifier wired, a throwing port) keeps the park alive for the sweeper to
 * retry rather than trading a stale bell for a tidy table.
 */
export async function strandPark(parkId: string): Promise<void> {
  const park = await readPark(parkId);
  if (!park) throw new ContinuationParkError("not-found", `park ${parkId} not found`);
  if (!isStrandable(park)) {
    throw new ContinuationParkError(
      "forced-strand",
      `park ${parkId} is still ${park.status} — a live park cannot be stranded; it must resolve through the sweeper`,
    );
  }
  if (
    park.holdNotification === HOLD_NOTIFICATION_LIVE &&
    park.checkpoint === RECOMMENDATION_HOLD_CHECKPOINT
  ) {
    const committed = await dispatchRecommendationHoldCleared({
      runId: park.runId,
      parkId: park.id,
    });
    if (!committed) {
      throw new ContinuationParkError(
        "conflict",
        `park ${parkId} still owes a hold-notification clear that did not commit; the row would be stranded by the teardown — retry once the notifier is reachable`,
      );
    }
    await db
      .update(lifecycleContinuationPark)
      .set({ holdNotification: HOLD_NOTIFICATION_CLEARED })
      .where(eq(lifecycleContinuationPark.id, parkId));
  }
  await db.delete(lifecycleContinuationPark).where(eq(lifecycleContinuationPark.id, parkId));
}

/** Run-scoped park reader (cinatra#2066, C0). Lists EVERY checkpointed
 * continuation park a run owns — parked, released, or policy_unresolved — so the
 * canonical run-detail aggregate can surface a run's parked continuations
 * alongside its gates. Ordered by creation for a stable rail projection. */
export async function readContinuationParksForRun(runId: string): Promise<ParkRow[]> {
  const rows = await db
    .select()
    .from(lifecycleContinuationPark)
    .where(eq(lifecycleContinuationPark.runId, runId))
    .orderBy(lifecycleContinuationPark.createdAt);
  return rows.map(toParkRow);
}

/** An ops row: the park PLUS the produced-event coordinates an operator needs to
 * act on it (which artifact/revision, and which org owns it). The park table
 * carries no org column — the org lives on the produced event the park is keyed
 * to, so the ops read JOINS it (which is also what makes the surface org-scopable
 * at all). */
export interface PolicyUnresolvedParkRow extends ParkRow {
  orgId: string | null;
  artifactId: string | null;
  representationRevisionId: string | null;
}

/**
 * Ops visibility: the parks the sweeper fail-closed into a terminal
 * `policy_unresolved` block (their protected effect is blocked pending an explicit
 * policy decision). Consumed by the lifecycle-operations ops surface
 * (`/configuration/lifecycle-operations`, cinatra#2047 D-7) — S0's continuation
 * contract calls this state "ops-surfaced", and until #2047 nothing read it.
 *
 * `orgId` SCOPES the read through the joined produced event (a multi-tenant ops
 * surface must never show another org's blocked effects); omitting it returns the
 * unscoped set (tests / a single-org instance script).
 */
export async function readPolicyUnresolvedParks(opts?: {
  orgId?: string;
  limit?: number;
}): Promise<PolicyUnresolvedParkRow[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
  const rows = await db
    .select({
      park: lifecycleContinuationPark,
      orgId: artifactProducedOutbox.orgId,
      artifactId: artifactProducedOutbox.artifactId,
      representationRevisionId: artifactProducedOutbox.representationRevisionId,
    })
    .from(lifecycleContinuationPark)
    // LEFT join so an ORPHANED park (its produced event purged) still resolves in
    // the UNSCOPED read, carrying null artifact coordinates. Note the org-scoped
    // read necessarily drops those orphans — a park with no event has no org, and
    // a multi-tenant surface cannot show a row it cannot attribute. That is the
    // deliberate trade: the product surface is org-scoped; the unscoped read is
    // the operator/script path that can still see an orphan.
    .leftJoin(
      artifactProducedOutbox,
      eq(artifactProducedOutbox.eventId, lifecycleContinuationPark.eventId),
    )
    .where(
      opts?.orgId
        ? and(
            eq(lifecycleContinuationPark.status, "policy_unresolved"),
            eq(artifactProducedOutbox.orgId, opts.orgId),
          )
        : eq(lifecycleContinuationPark.status, "policy_unresolved"),
    )
    .orderBy(lifecycleContinuationPark.resolvedAt)
    .limit(limit);
  return rows.map((r) => ({
    ...toParkRow(r.park),
    orgId: r.orgId ?? null,
    artifactId: r.artifactId ?? null,
    representationRevisionId: r.representationRevisionId ?? null,
  }));
}

function toParkRow(r: typeof lifecycleContinuationPark.$inferSelect): ParkRow {
  return {
    id: r.id,
    runId: r.runId,
    eventId: r.eventId,
    checkpoint: r.checkpoint,
    policyDecisionId: r.policyDecisionId,
    protectedEffect: r.protectedEffect,
    reevaluationIntent: r.reevaluationIntent,
    status: r.status as ParkRow["status"],
    holdNotification: r.holdNotification as HoldNotificationState,
    ttlExpiresAt: r.ttlExpiresAt,
    resolvedAt: r.resolvedAt,
  };
}
