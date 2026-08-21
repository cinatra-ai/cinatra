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
 * cinatra#2868 — the PER-DISPATCH BOUND, the EXPIRY BREAKER, and what neither of
 * them fixes.
 *
 * `dispatchRecommendationHoldCleared` swallows a THROWN port, so a notifier that
 * fails loudly already reports `false` and the obligation simply stands. A
 * notifier that never SETTLES is not a throw, and an unbounded `await` on one
 * parks the drain forever. Nothing is LOST when that happens — the page was
 * stamped at claim, so its rows rotate and a later sweep recovers them — but the
 * SWEEPER hangs, and it has two callers that cannot afford that:
 *
 *   - the ~60s gate-maintenance BullMQ job (`sweepLifecycleGateMaintenance`
 *     step 3), whose slot stalls for as long as the notifier does; and
 *   - `releaseRecommendationParkForRun`, which awaits `sweepParks`
 *     SYNCHRONOUSLY on a human's confirm/skip — so a wedged notifier blocks a
 *     user-facing request, indefinitely.
 *
 * THE BOUND ABANDONS; IT DOES NOT CANCEL. This is the whole shape of what is and
 * is not fixed here, and it was originally overclaimed. `dispatchHoldClearedBounded`
 * bounds the WAIT, not the OPERATION: on expiry this loop walks away and the
 * dispatch it launched keeps running. Bounding the wait alone therefore converts
 * "one wedged notifier hangs the sweeper" into "one wedged notifier leaves an
 * unbounded pile of live in-flight operations" — a page of 100 wedged rows would
 * abandon up to 100 of them, not 4, because the wave refills the moment each
 * expiry is read. Each abandoned host clear can hold one connection of the agents
 * pool (pg default `max: 10`) for as long as it stays wedged, so the pile is the
 * exact resource the concurrency cap was supposed to protect.
 *
 * Hence the EXPIRY BREAKER. Expiries are counted across the whole pass, and once
 * `HOLD_NOTIFY_EXPIRY_BREAKER` of them have accrued the drain STOPS DISPATCHING:
 * every obligation still on the page is left `live`, undispatched, for a later
 * sweep — and, crucially, with its RETRY CURSOR PUT BACK. Claim-time stamping
 * alone does NOT make skipping safe, which was the third thing overclaimed here:
 * the claim stamps the ENTIRE page, so once the outstanding set fits inside
 * `limit` every pass produced the same queue in the same order, the breaker served
 * the same prefix of it forever, and a healthy row sorted behind a few
 * persistently wedged ones was never attempted again. `drainHoldNotifications`
 * carries the two-part rotation that makes stopping safe.
 *
 * WHY E = 4, WHICH IS EXACTLY C. A fully wedged page expires its ENTIRE FIRST
 * WAVE together, so E = C trips the breaker at the earliest moment "the notifier
 * is wedged" is distinguishable from "one row is slow": the end of wave one.
 *
 * That is E + C - 1 = 7 abandoned operations, not E of them, and the arithmetic is
 * worth being exact about because the wave expires IN UNISON. The C expiries land
 * in the same tick and are read one at a time, so the first C - 1 workers each see
 * a count still under the budget and pull one more row before the C-th worker
 * trips it. A wedged page therefore launches 4 + 3 = 7 dispatches over two waves —
 * measured, not derived — and a MIXED page reaches the same ceiling by the other
 * route, the E-th expiry landing while C - 1 dispatches are still in flight and go
 * on to expire too. Either way E + C - 1 = 7 is the ceiling, and it is under the
 * pool's `max: 10`, which is the property that matters: ONE wedged pass cannot
 * exhaust the connections the rest of the process shares.
 *
 * TOTAL EXPIRIES, NOT CONSECUTIVE. A consecutive counter resets on every healthy
 * row, so a notifier that wedges half its calls would never trip it and would
 * still abandon ~50 operations on a 100-row page. The failure being bounded is
 * cumulative, so the counter has to be too.
 *
 * WHAT STILL LEAKS — SAY IT PLAINLY. An abandoned operation is abandoned, not
 * freed. The breaker bounds how many one PASS can strand; it cannot reclaim any of
 * them, and it does not stop them accumulating ACROSS passes: a notifier that is
 * persistently wedged strands up to E + C - 1 = 7 more operations every sweep
 * interval, and those never settle by assumption. Enough intervals will still
 * exhaust the pool. What the breaker buys is a rate (7 per ~60s instead of 100 per
 * ~60s) and a bounded blast radius per pass — time for the aggregated warning
 * below to be acted on. The real fix is CANCELLATION, and it is not reachable
 * through this seam today:
 *
 *   - The seam is a host-supplied OPTIONAL port (`onClearRecommendationHold`).
 *     Threading an `AbortSignal` through it is easy; making a host HONOUR one is
 *     not something the port can enforce, and a signal every shipped host ignores
 *     would be a false affordance — it would let this docblock claim a
 *     cancellation that never happens.
 *   - The production host's clear is two halves and neither is abortable as
 *     written. The first is `readAgentRunById`, a drizzle-orm/node-postgres
 *     `select` — drizzle exposes no signal on execute, so aborting it means
 *     bypassing drizzle for that read, holding the raw pool client, and cancelling
 *     its backend from a SECOND connection. The second is
 *     `deleteHoldNotificationForUser`, which is SYNCHRONOUS: it runs its query in
 *     a worker thread and blocks the main thread on `Atomics.wait`. No signal can
 *     interrupt that — while it blocks, no timer, no abort listener and no
 *     microtask runs at all, including the bound's own. It is un-abortable by
 *     construction rather than by omission, and it carries its own 30s ceiling
 *     (`POSTGRES_SYNC_TIMEOUT_MS`), which is the only thing bounding that window.
 *
 * THE BUDGET, AND THE TWO DIFFERENT CEILINGS IT CARRIES. The page is the sweep's
 * `limit`: 100 for BOTH production drivers (gate maintenance passes its own
 * default 100; the confirm/skip release takes `sweepParks`' default 100),
 * hard-capped at 500. With the breaker the time this drain can spend WAITING ON
 * TIMEOUTS stops scaling with the page at all — but that is TWO different
 * ceilings, and an earlier round quoted the smaller one as if it were both:
 *
 *   - ABANDONED OPERATIONS per pass: E + C - 1 = 7. A count, it is the number the
 *     pool cares about, and it stands unchanged.
 *   - TIMEOUT CONTRIBUTION per pass: (E + 1) x BOUND = 5 x 500ms = 2.5s, and the
 *     `+ 1` is not slack — it is a second expiry that can only land AFTER the one
 *     that trips the breaker. E x BOUND = 2s is the SINGLE-CHAIN figure: a
 *     worker's loop stops only when the SHARED expiry count reaches E, so one
 *     worker can serially absorb all E expiries — and on a MIXED page it does, its
 *     page-mates chewing through healthy rows in milliseconds while it draws
 *     wedged row after wedged row and pays a full BOUND for each. But that chain
 *     is not the last thing the pass waits on. The breaker is checked before a
 *     PULL, never during a dispatch, so a page-mate that entered its own bounded
 *     call just BEFORE the count tripped is legitimately still inside it when the
 *     E-th expiry lands at E x BOUND — and if its row is wedged too, it goes on to
 *     expire up to one full BOUND later. The pass ends when the LAST worker
 *     returns, so STAGGERED mixed work reaches (E + 1) x BOUND. That is the
 *     general timeout-only ceiling; E x BOUND is the special case where the one
 *     serial chain is also the last thing running.
 *   - `ceil((E + C - 1) / C) x BOUND` = 2 x 500ms = 1s is the FULLY WEDGED case
 *     ONLY, and it is the FLOOR of the three rather than the general bound. There
 *     every dispatch expires, so the expiries land in synchronised waves of C —
 *     nothing is staggered and nothing straggles — instead of in one worker's
 *     chain; ~1010ms is the measured figure for exactly that page.
 *
 * Both ceilings are PAGE-SIZE-INDEPENDENT, which is the property the breaker buys:
 * identical for a 100-row page and for the 500-row cap. The superseded
 * `ceil(page / C) x BOUND` arithmetic (25 waves = 12.5s at 100 rows, 62.5s at the
 * cap) described a drain with no breaker.
 *
 * THAT IS A TIMEOUT CEILING, NOT A SWEEP CEILING, and the distinction was the
 * second thing overclaimed here. A committed dispatch is followed by an ACK UPDATE
 * on the pool, and that write is not bounded by anything in this module. Nor are
 * the claim UPDATE, the TTL fail-close, or any other statement in the pass. What
 * cinatra#2868 removes is the WEDGED-NOTIFIER HANG — an unbounded wait on a port
 * that may never answer. The ack is an ordinary keyed UPDATE on the agents pool,
 * carrying exactly the same trust as every other query this sweep runs, and the
 * sweep is no more and no less bounded than those queries are. There is no total
 * wall-clock ceiling on `sweepParks` and this change does not create one.
 *
 * WHY 500ms IS GENEROUS. A healthy clear is two indexed round-trips on a warm
 * pool — the run's PK read, then the keyed delete. 500ms is an order of magnitude
 * over that. And one asymmetry is what makes a tight bound safe at all: an expiry
 * is not a LOSS, it is a RETRY. The obligation stays `live` with its cursor
 * already moved, so the next sweep serves it, and the cost of a false expiry is
 * one more sweep interval of a stale bell — never a dropped notification. The same
 * asymmetry is what makes the breaker cheap: stopping a pass early costs a sweep
 * interval on rows that were already going to be retried.
 *
 * WHY C = 4 AND NOT SERIAL. The drain dispatched strictly serially on the stated
 * ground that serialising keeps a slow notifier from fanning out connections
 * behind a sweep that is already on a schedule (cinatra#2838). That ground is
 * sound, which is why the fan-out is BOUNDED rather than removed: 4 in flight is
 * under half the agents pool. Serial alone cannot carry a bound generous enough to
 * be safe: at 100 rows it would force BOUND under 600ms merely to fit the ~60s job
 * period, and under 150ms to fit a fifth of it.
 *
 * DELIBERATELY NOT `strandPark`, whose clear is also an unbounded await. That one
 * is a single ops teardown of a single park, not a bounded page inside a job on a
 * schedule, and its contract is the opposite of this one's: it REFUSES the
 * teardown until the obligation discharges. A bound there would convert a slow
 * notifier into a spurious `conflict` throw at the caller rather than into a free
 * retry, so it wants its own decision, not this one's.
 */
const HOLD_NOTIFY_DISPATCH_TIMEOUT_MS = 500;
const HOLD_NOTIFY_DISPATCH_CONCURRENCY = 4;
/** Expiries in ONE pass after which the drain stops dispatching. == C, so a fully
 * wedged page trips it at the end of its first wave. See the docblock above. */
const HOLD_NOTIFY_EXPIRY_BREAKER = 4;

type HoldClearOutcome = "committed" | "declined" | "expired";

/**
 * ONE bounded dispatch. Resolves `"expired"` the moment the bound elapses, and
 * never rejects — the caller reads an expiry as exactly a declined clear.
 *
 * WHAT "EXPIRED" DOES NOT MEAN: it does not mean the dispatch stopped. This bounds
 * the WAIT only; the operation it launched is still running, still holding
 * whatever it holds, and nothing here can reclaim it. Counting expiries is
 * therefore counting ABANDONED OPERATIONS, which is why the caller trips a breaker
 * on that count rather than treating an expiry as a free retry.
 *
 * Two details are load-bearing and easy to lose:
 *
 *   - NO LEAKED TIMER. The timer is cleared the instant the dispatch settles, so
 *     a healthy page leaves nothing pending behind it; once it has fired there is
 *     nothing left to clear either way.
 *   - NO UNHANDLED REJECTION FROM THE LOSER. The handler pair below is attached
 *     ONCE, to the dispatch itself, and is both the settle path and the no-op
 *     catch: after an expiry `resolve` is inert and `clearTimeout` is a no-op,
 *     but a late rejection is still CONSUMED. An abandoned dispatch that rejects
 *     a minute later can therefore never surface as an unhandled rejection —
 *     which Node terminates the process on by default, turning a bounded miss
 *     into an outage.
 */
function dispatchHoldClearedBounded(park: {
  id: string;
  runId: string;
}): Promise<HoldClearOutcome> {
  return new Promise<HoldClearOutcome>((resolve) => {
    const timer = setTimeout(() => resolve("expired"), HOLD_NOTIFY_DISPATCH_TIMEOUT_MS);
    void dispatchRecommendationHoldCleared({ runId: park.runId, parkId: park.id }).then(
      (committed) => {
        clearTimeout(timer);
        resolve(committed ? "committed" : "declined");
      },
      (err) => {
        // Unreachable through the shipped dispatcher (it swallows its own port's
        // throws), but the seam is a wired PORT: a host that hands back a
        // rejecting thenable must not be able to fail a sweep either.
        clearTimeout(timer);
        console.warn(
          "[lifecycle-continuation-park] hold-notification clear threw past the dispatcher:",
          err instanceof Error ? err.message : err,
        );
        resolve("declined");
      },
    );
  });
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
 * BOUNDED PER DISPATCH, AND BOUNDED PER PASS (cinatra#2838's successor,
 * cinatra#2868). Every dispatch below runs under `dispatchHoldClearedBounded` and
 * an EXPIRY is read as exactly a declined clear, so no notifier — however wedged —
 * can park this loop. Because that bound ABANDONS the operation rather than
 * cancelling it, the pass also stops dispatching once
 * `HOLD_NOTIFY_EXPIRY_BREAKER` expiries have accrued, leaving the rest of the page
 * `live` and undispatched. See the bound's docblock for both budgets and for what
 * neither of them reclaims.
 *
 * WHAT GUARANTEES ROTATION NOW THAT A PASS CAN STOP MID-PAGE. Stamping at claim
 * stamps the WHOLE page, which was sound only while the whole page was also
 * dispatched. With a breaker it is not, and the rotation cinatra#2838 argued for
 * simply is not there for a skipped row: the claim writes dispatched and skipped
 * rows the SAME `now()` (one statement, one transaction timestamp), so the two are
 * cursor-identical afterwards and the stamp cannot order one ahead of the other.
 * Once the outstanding set FITS inside `limit` — the ordinary steady state, not a
 * corner — every sweep then claims the same rows with the same key, and WHICH of
 * them the breaker serves comes down to the order `RETURNING` happens to produce.
 * That order is undefined and this module neither controls nor observes it — and
 * measured, under the claim as cinatra#2838 wrote it, it was HEAP order: unrelated
 * to the claim's `ORDER BY` and identical pass after pass. A page of 7 wedged rows
 * in front of 9 healthy ones left between 1 and 4 of the healthy obligations
 * unattempted on every one of ten consecutive sweeps, in every run. Starved, not
 * delayed, for as long as the wedge lasts. Two things fix that:
 *
 *   1. THE QUEUE IS ORDERED BY THE CURSOR, not by `RETURNING`. The claim carries
 *      every row's PRE-CLAIM cursor out with it and the queue is sorted on that
 *      cursor. Read that as the claim's key at a COARSER RESOLUTION, not as the
 *      claim's exact key: Postgres ranks the page on microsecond timestamps, while
 *      the same cursor reaches this sort through a JS `Date` and so compares in
 *      whole milliseconds. Two parks born inside one millisecond tie here, fall to
 *      the `id` tie-break, and can dispatch in the opposite order to the claim.
 *      That costs fairness nothing, because point 2 below is what stops a row from
 *      starving; this ordering only keeps the common case off the planner. Stated
 *      honestly: this half is BELT-AND-BRACES. The joined claim below is measured
 *      to hand its rows back in claim order already, so removing the sort changes
 *      nothing observable today — it would just put a fairness property back at
 *      the mercy of a plan.
 *   2. A SKIPPED ROW GETS ITS CURSOR BACK. This half is the one that carries the
 *      fix, and reverting it alone reddens the pins. One UPDATE before returning restores
 *      `hold_notify_attempted_at` to its pre-claim value on every row the breaker
 *      left undispatched. A row that was claimed but never dispatched is then
 *      cursor-INDISTINGUISHABLE from one that was never claimed, so cinatra#2838's
 *      fairness argument covers it unchanged — while every row that WAS dispatched,
 *      the wedged ones included, keeps its fresh `now()` and sorts last.
 *
 * Together those put the skipped rows FIRST IN LINE on the next sweep whatever the
 * page, whatever the tie-break and whatever order the storage engine felt like
 * returning: a wedge can cost an obligation ONE pass, never every pass. Rotation
 * is now a property of the code rather than of the heap. Two details of the
 * restore, stated rather than hidden. The RESTORED value is millisecond-truncated,
 * because the pre-claim cursor round-trips through a JS `Date` — that moves a
 * restored row a fraction of a millisecond EARLIER in the queue, the safe
 * direction, and far under the resolution anything here orders on. And the restore
 * is a COMPARE-AND-SWAP, not a blind write: it fires only where the row is still
 * `live` AND still carries THIS pass's claim stamp. `live` alone would not do,
 * because sweeps overlap — another sweep can claim, attempt and fail one of these
 * rows inside the window this pass spends dispatching, and restoring over ITS
 * stamp would erase a true record of an attempt and hand a dispatched-and-failed
 * row never-attempted priority. That comparison is made against the stamp as
 * POSTGRES stores it; see the restore itself for why a JS `Date` cannot carry
 * it.
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
  // is chosen by this subquery and the UPDATE stamps exactly what it returns. It is
  // JOINED rather than `IN`-ed for one reason: the join carries every row's
  // PRE-CLAIM cursor out of the claim, and the pass needs that value twice — to
  // dispatch in the claim's own order, and to PUT IT BACK on any row the breaker
  // declines to dispatch. Both halves of the rotation above depend on having it.
  const claim = db
    .select({
      id: lifecycleContinuationPark.id,
      priorAttemptedAt: lifecycleContinuationPark.holdNotifyAttemptedAt,
      priorCreatedAt: lifecycleContinuationPark.createdAt,
    })
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
    .for("update", { skipLocked: true })
    .as("claim");

  const owing = await db
    .update(lifecycleContinuationPark)
    .set({ holdNotifyAttemptedAt: sql`now()` })
    .from(claim)
    .where(eq(lifecycleContinuationPark.id, claim.id))
    .returning({
      id: lifecycleContinuationPark.id,
      runId: lifecycleContinuationPark.runId,
      // The cursor as it stood BEFORE this claim overwrote it — the sort key
      // below, and the value the restore puts back.
      priorAttemptedAt: claim.priorAttemptedAt,
      priorCreatedAt: claim.priorCreatedAt,
      // THIS PASS'S CLAIM STAMP, which is what makes the restore a CAS. In
      // `RETURNING` a column of the UPDATE's target table reads the NEW row, so
      // this is exactly the `now()` the statement above just wrote — one
      // transaction timestamp shared by the whole page. It is carried as TEXT on
      // purpose: `now()` is stored to the MICROSECOND and a JS `Date` truncates to
      // the millisecond, so a stamp round-tripped through JS would be a near-miss
      // that equals nothing in the table. The text goes out and comes back through
      // SQL untouched, and the comparison happens in Postgres against the value as
      // Postgres stores it.
      claimedAt: sql<string>`${lifecycleContinuationPark.holdNotifyAttemptedAt}::text`,
    });

  let cleared = 0;
  let expired = 0;
  // A BOUNDED WAVE, not an unbounded queue (cinatra#2868). Each worker pulls the
  // next obligation off the page and dispatches it under the per-dispatch bound,
  // so at most `HOLD_NOTIFY_DISPATCH_CONCURRENCY` notifier calls are ever in
  // flight. `shift()` is the entire synchronisation: the event loop is
  // single-threaded, so two workers can never take the same row.
  // ORDERED BY THE CURSOR, NOT BY ARRIVAL. `RETURNING` has no defined order, and
  // with a breaker that order decides WHO gets served at all — so it is not
  // something to leave to the planner. Measured both ways: under the previous
  // `WHERE id IN (subquery)` claim it came back in HEAP order, unrelated to the
  // claim's `ORDER BY` and identical pass after pass; under the joined claim above
  // it happens to come back in the claim's own order. The second is a planner
  // choice, not a contract (the same statement shape plans as a hash join whose
  // row order comes from a seq scan of the target), so this sort is what makes the
  // dispatch order a property of the CODE. It is deliberately belt-and-braces: no
  // test can discriminate it while the plan keeps agreeing with it.
  //
  // RESOLUTION, stated rather than implied: `getTime()` is MILLISECONDS, while the
  // claim's `ORDER BY` ranks the same cursor in Postgres microseconds. This sort is
  // therefore the claim's key rounded, not the claim's key. Two rows whose cursors
  // fall inside one millisecond tie here and are separated by the `id` tie-break
  // below, which can put them in the opposite order to the claim. Fairness does not
  // rest on this: the pre-claim restore is what keeps a skipped row from starving,
  // and it does so whatever order this queue lands in.
  const cursorOf = (p: { priorAttemptedAt: Date | null; priorCreatedAt: Date }) =>
    (p.priorAttemptedAt ?? p.priorCreatedAt).getTime();
  const queue = [...owing].sort(
    (a, b) => cursorOf(a) - cursorOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const workers = Array.from(
    { length: Math.min(HOLD_NOTIFY_DISPATCH_CONCURRENCY, queue.length) },
    async () => {
      // THE EXPIRY BREAKER, checked BEFORE each pull rather than after each
      // dispatch. An expiry means the drain ABANDONED a live operation, not that
      // it ended one, so the pile only shrinks by not launching more: once the
      // pass has stranded `HOLD_NOTIFY_EXPIRY_BREAKER` of them, every row still in
      // `queue` is left untouched and `live` for a later sweep. `expired` is
      // shared across the workers on purpose — the budget is per PASS, not per
      // worker — and a worker already inside a dispatch when the breaker trips
      // still finishes and acks it, which is why the true ceiling on abandoned
      // operations is E + C - 1 rather than E.
      while (expired < HOLD_NOTIFY_EXPIRY_BREAKER) {
        const park = queue.shift();
        if (!park) break;
        const outcome = await dispatchHoldClearedBounded(park);
        if (outcome === "expired") expired += 1;
        // An EXPIRY is treated as EXACTLY a `false`, deliberately: both say the
        // same thing — we do not know the row was deleted — and retiring an
        // obligation nothing has discharged is the one failure that loses a bell.
        // The obligation stands, the cursor has already moved, a later sweep
        // retries it.
        if (outcome !== "committed") continue;
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
    },
  );
  await Promise.all(workers);
  // Whatever no worker ever pulled: the breaker tripped and these were never
  // dispatched at all.
  const skipped = queue.splice(0);
  const undispatched = skipped.length;
  if (undispatched > 0) {
    // PUT THE CURSOR BACK — the second half of the rotation, and without it the
    // breaker starves exactly the rows it skips. The claim stamped these on the way
    // in; nothing was attempted on them, so the truthful cursor is the one they
    // arrived with, and restoring it is what sorts them AHEAD of the rows this pass
    // did dispatch (all of which now carry a fresh `now()`) on the next sweep.
    // One statement, `unnest`-joined so the whole page restores in a single round
    // trip, and a COMPARE-AND-SWAP on this pass's own claim stamp rather than a
    // blind write. "Still `live`" is not enough to own the cursor, because sweeps
    // OVERLAP: this pass's claim committed before the first dispatch went out, and
    // for the up-to-(E + 1) x BOUND it spends dispatching another sweep can claim
    // one of these very rows (they sort last, but once the outstanding set fits
    // inside `limit` the other sweep reaches them), attempt it, and have it fail —
    // leaving it `live` carrying ITS newer stamp, which honestly records ITS
    // attempt. Restoring on
    // `live` alone would overwrite that with the pre-claim cursor, so a row that
    // WAS dispatched and DID fail would acquire never-attempted priority and the
    // other sweep's attempt would be erased from the record. Matching on
    // `hold_notify_attempted_at = v.claimed` restores only the rows still carrying
    // OUR stamp: a row someone else re-stamped is left alone and their attempt
    // record stands. The `live` guard is kept alongside it — a row a racing
    // sweeper discharged is left exactly as it left it.
    //
    // Both timestamps travel as TEXT and are cast back inside the statement, so
    // the comparison is against the value as POSTGRES stores it. `claimed` must
    // never round-trip through a JS `Date`: that truncates `now()`'s microseconds
    // to milliseconds and the CAS would then match no row at all, silently
    // restoring nothing and reinstating the starvation this restore exists to fix.
    //
    // The `sql.param` wrappers are load-bearing — a bare array in a `sql` template
    // is expanded into a parenthesised list of placeholders (a record), not bound
    // as one array parameter, and `unnest` needs the array.
    await db.execute(sql`
      update ${lifecycleContinuationPark} as p
         set hold_notify_attempted_at = v.prior::timestamptz
        from unnest(
               ${sql.param(skipped.map((p) => p.id))}::text[],
               ${sql.param(skipped.map((p) => p.priorAttemptedAt?.toISOString() ?? null))}::text[],
               ${sql.param(skipped.map((p) => p.claimedAt))}::text[]
             ) as v(id, prior, claimed)
       where p.id = v.id
         and p.hold_notification = ${HOLD_NOTIFICATION_LIVE}
         and p.hold_notify_attempted_at = v.claimed::timestamptz
    `);
  }
  if (expired > 0) {
    // Aggregated, not per row: under a wedged notifier EVERY dispatch in the page
    // expires, and one line per obligation per pass would bury the signal it is.
    console.warn(
      `[lifecycle-continuation-park] ${expired}/${owing.length} hold-notification clear(s) did not settle within ${HOLD_NOTIFY_DISPATCH_TIMEOUT_MS}ms — left live for a later sweep`,
    );
  }
  if (undispatched > 0) {
    // A DISTINCT line from the one above, because it reports a distinct decision:
    // not "these did not answer" but "this pass stopped asking". Each expiry above
    // left a live operation running that nothing can reclaim, so the breaker is
    // the only thing standing between a persistently wedged notifier and the
    // agents pool — if this line is recurring, the notifier is the incident.
    console.warn(
      `[lifecycle-continuation-park] hold-notification dispatch STOPPED after ${expired} expiries in one pass — ${undispatched} claimed obligation(s) left live and UNDISPATCHED, retry cursor restored so they lead the next sweep; the notifier appears wedged and each expiry above abandoned an operation that is still running`,
    );
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
