// ---------------------------------------------------------------------------
// Run human-wait notifier seam (cinatra #1559 / notifications epic E9).
//
// A run that parks on a genuine human gate must mint a DURABLE, actionable
// notification to its initiator (so the wait is discoverable off the run
// panel), and that notification must be hard-deleted the moment the wait
// resolves. The emit/clear I/O is a NOTIFICATIONS concern; wiring it directly
// into `packages/agents` would deepen this package's dependency cycle with the
// notifications package (which already reaches back here via `readAgentRunById`
// for run-href resolution). So the actual write path is injected by the HOST
// through this leaf seam, and `transitionRunStatus` (the single canonical
// entry point for every `agent_runs.status` change) drives it.
//
// TRUE LEAF: this module imports NOTHING at runtime from the package graph
// (only a type-only `AgentRunStatus` import, erased at compile) and has ZERO
// runtime dependencies, so the boot-reachable host wiring can inject the
// notifier without pulling any notifications/service code onto a cold import
// graph. The default (no host wired — package unit tests, non-host entrypoints)
// is a silent no-op.
//
// The wait-vs-not classification lives HERE (this package owns run-status
// semantics), so the host implementation is pure notification I/O and cannot
// drift from the run lifecycle.
// ---------------------------------------------------------------------------

import type { AgentRunStatus } from "./store";
// TYPE-ONLY (erased at compile), so the true-leaf property in the header holds:
// this module still pulls NOTHING at runtime from the package graph.
import type { RunWaitInterruptKind } from "./run-surface-status";

/**
 * Which flavour of human gate a run just entered.
 *   - `pending_approval` — a real HITL gate (setup-field interrupt, WayFlow /
 *     langgraph mid-run interrupt). EVERY entry into `pending_approval` is a
 *     human-wait gate (this is the status `deriveRunHitlContext` keys on).
 *   - `pending_input` — the OVERLOADED status. Only ONE of its reasons is a
 *     genuine human wait: the stop-run-hitl pause (cinatra #1058) where a human
 *     must install optional sub-agents and resume. Every other `pending_input`
 *     reason (setup, trigger editing, failed-run reset, enqueue-compensation)
 *     is NOT a human-wait gate and must NOT notify — so a `pending_input` enter
 *     only counts when the transition caller explicitly flags it.
 */
export type RunHumanWaitReason = "pending_approval" | "pending_input";

/**
 * The host-injected write path. Implemented in
 * `src/lib/agent-run-wait-notifications.ts` and wired at boot by
 * `src/lib/register-run-wait-notifier.ts`. Both methods are best-effort in the
 * host impl; this seam adds a second backstop (see `dispatchRunWaitTransition`).
 */
export interface RunWaitNotifier {
  /** A run parked on a human gate — mint/refresh the durable notification. */
  onEnterHumanWait(input: {
    runId: string;
    reason: RunHumanWaitReason;
    /**
     * cinatra#2835 — the wait's INPUT-vs-APPROVAL flavour, when the CALLER
     * already knows it. The host otherwise re-derives this from the run's live
     * HITL context (`deriveRunHitlContext` → `classifyRunWaitInterrupt`), which
     * only ever answers for a `pending_approval` interrupt; a wait that is NOT
     * an interrupt at all — the run-start recommendation HOLD, which parks an
     * already-`pending_input` run on a card rather than moving its status — has
     * no context to derive from and would fail closed to the generic
     * "waiting on you to continue" copy with a run-page link.
     *
     * PRESENTATION + DESTINATION only, exactly like the derived classification
     * it stands in for: `"input"` selects the "needs your input" copy and the
     * conversation deep-link (#2729's ruling). Omitted → the pre-existing
     * derivation, unchanged for every existing caller.
     */
    waitKind?: RunWaitInterruptKind;
  }): void | Promise<void>;
  /** A run left a human-wait state — hard-delete the notification (idempotent). */
  onLeaveHumanWait(input: { runId: string }): void | Promise<void>;
  /**
   * cinatra#2413 — a run left a human-wait state BECAUSE IT FAILED (never a
   * human decision: reject/resume/stop stay on `onLeaveHumanWait` above).
   * Supersedes the bare delete: the implementation must still clear the
   * stale approval row (it is no longer actionable — the gate is gone) AND
   * mint a durable run-failure notification in its place, so the feed is
   * never silent about a run that died while a human was told to review it.
   * OPTIONAL for structural back-compat with existing notifier doubles; a
   * host/double that does not implement it falls back to the plain
   * `onLeaveHumanWait` delete (`dispatchRunWaitTransition` below) — the
   * PRODUCTION host (`src/lib/agent-run-wait-notifications.ts`) always wires
   * it, so the fallback is a test-double-only affordance, not a shipped gap.
   */
  onHumanWaitFailed?(input: { runId: string }): void | Promise<void>;
  /**
   * cinatra#2066 C2 — a LIFECYCLE AUTO-GATE opened on a run. Distinct from
   * `onEnterHumanWait`: an auto-gate (the #2039 review-orchestration path) is
   * created via `emitArtifactReviewGate` + a continuation park and NEVER moves
   * the producing run to `pending_approval`, so the human-wait classifier above
   * never fires for it. This seam mints a durable, actionable notification to
   * the run's reviewer-resolvable audience (its initiator) deep-linking to the
   * RUN VIEW, so an auto-gated run is discoverable off the run panel exactly like
   * a flow-authored gate. Keyed per (runId, reviewTaskId) so several gates on one
   * run never collide. OPTIONAL: a host that wires no auto-gate notifier (or a
   * unit-test double) simply skips the emit. */
  onAutoGateOpen?(input: {
    runId: string;
    reviewTaskId: string;
  }): void | Promise<void>;
  /** The auto-gate reached a terminal review decision — hard-delete the
   * `onAutoGateOpen` row by its (runId, reviewTaskId) key (idempotent; a no-op
   * when none was minted, e.g. a flow-authored gate or an initiator-less run). */
  onAutoGateResolved?(input: {
    runId: string;
    reviewTaskId: string;
  }): void | Promise<void>;
  /**
   * cinatra#2835 — a run-start recommendation HOLD parked a run. Distinct from
   * `onEnterHumanWait` (which rides a status transition) because a hold moves no
   * status at all, and distinct in its WRITE CONTRACT: the implementation must
   * write the row behind `buildHoldNotificationFence`, in ONE transaction with
   * the park row it names, so the write is impossible for a park that does not
   * exist, does not belong to this run, or is no longer `parked`.
   *
   * OPTIONAL only for structural back-compat with existing notifier doubles; the
   * production host always wires it. A host that does not is not "best-effort
   * degraded" — it simply never notifies for holds, which is the safe direction.
   */
  onEnterRecommendationHold?(input: {
    runId: string;
    parkId: string;
  }): void | Promise<void>;
  /**
   * cinatra#2835 — the hold ended: hard-delete the row `onEnterRecommendationHold`
   * wrote for THIS park (scoped by the park id the row carries, so a later,
   * unrelated awaiting-human row for the same run is never collateral).
   *
   * Returns whether the delete is COMMITTED. That answer is the sweeper's ack
   * signal: only a `true` retires the park's `hold_notification = 'live'`
   * obligation, so a swallowed failure, a dead process, or an unwired notifier all
   * leave the obligation standing for the next sweep to retry (finding 3). An
   * implementation must therefore never report `true` optimistically.
   */
  onClearRecommendationHold?(input: {
    runId: string;
    parkId: string;
  }): boolean | Promise<boolean>;
}

// Module singleton behind a global symbol slot (same idiom as
// `setLiveAgentManifestProvider`) so a duplicated module instance across bundle
// boundaries still resolves to ONE holder.
const RUN_WAIT_NOTIFIER_SLOT = Symbol.for("cinatra.agents.runWaitNotifier.v1");
type NotifierHolder = { notifier: RunWaitNotifier | null };
function notifierHolder(): NotifierHolder {
  const g = globalThis as unknown as Record<
    symbol,
    NotifierHolder | undefined
  >;
  return (g[RUN_WAIT_NOTIFIER_SLOT] ??= { notifier: null });
}

/** Host wiring entry: inject the notifier. Pass `null` to clear (tests). */
export function setRunWaitNotifier(notifier: RunWaitNotifier | null): void {
  notifierHolder().notifier = notifier;
}

/** Internal getter — the wired notifier, or `null` when no host wired one. */
export function getRunWaitNotifier(): RunWaitNotifier | null {
  return notifierHolder().notifier;
}

/**
 * PURE. Classify a run status transition against the human-wait lifecycle.
 *
 *   - ENTER: the run just parked on a human gate → mint the notification.
 *   - LEAVE: the run just departed a state that MIGHT have carried one.
 *     Clearing is a delete-by-dedupeKey (idempotent), so it is safe to clear on
 *     EVERY departure from `pending_approval` / `pending_input` even when no row
 *     was ever written (the unflagged `pending_input` reasons) — over-clearing
 *     is a harmless no-op and guarantees no stale row survives.
 *   - NONE: an ordinary transition (queued→running, running→completed, …).
 *
 * ENTER wins over LEAVE for the same transition (they are mutually exclusive
 * under LEGAL_TRANSITIONS anyway; the ordering is a defensive belt).
 *
 * cinatra#2413 — LEAVE splits in two: a `failed` destination is a distinct
 * `leave_failed` kind, checked BEFORE the generic `leave` (a run cannot land
 * on both `pending_approval`/`pending_input` and `failed` at once, so this
 * ordering is a defensive belt, same as ENTER-over-LEAVE above). Every other
 * departure (resume/reject/stop/complete) stays plain `leave` — those ARE a
 * human decision or an ordinary terminal landing, not a silent death mid-wait.
 */
export type RunWaitClassification =
  | { kind: "enter"; reason: RunHumanWaitReason }
  | { kind: "leave" }
  | { kind: "leave_failed" }
  | { kind: "none" };

export function classifyRunWaitTransition(
  from: AgentRunStatus,
  to: AgentRunStatus,
  humanWaitGate: boolean,
): RunWaitClassification {
  if (to === "pending_approval") {
    return { kind: "enter", reason: "pending_approval" };
  }
  if (to === "pending_input" && humanWaitGate) {
    return { kind: "enter", reason: "pending_input" };
  }
  if (from === "pending_approval" || from === "pending_input") {
    return to === "failed" ? { kind: "leave_failed" } : { kind: "leave" };
  }
  return { kind: "none" };
}

/**
 * Drive the wired notifier for one run status transition. Called by
 * `transitionRunStatus` AFTER a successful CAS. No-op when the transition is
 * not wait-relevant or no host wired a notifier. Best-effort: a thrown port
 * (or a rejected promise) is swallowed so a notification failure can NEVER
 * fail a run status transition.
 */
export async function dispatchRunWaitTransition(args: {
  runId: string;
  from: AgentRunStatus;
  to: AgentRunStatus;
  humanWaitGate: boolean;
}): Promise<void> {
  const classification = classifyRunWaitTransition(
    args.from,
    args.to,
    args.humanWaitGate,
  );
  if (classification.kind === "none") return;
  const notifier = notifierHolder().notifier;
  if (!notifier) return;
  try {
    if (classification.kind === "enter") {
      await notifier.onEnterHumanWait({
        runId: args.runId,
        reason: classification.reason,
      });
    } else if (classification.kind === "leave_failed") {
      // Prefer the dedicated failure handoff; fall back to the plain delete
      // for a notifier/double that hasn't wired the optional hook (see the
      // interface doc above — production always wires it).
      if (notifier.onHumanWaitFailed) {
        await notifier.onHumanWaitFailed({ runId: args.runId });
      } else {
        await notifier.onLeaveHumanWait({ runId: args.runId });
      }
    } else {
      await notifier.onLeaveHumanWait({ runId: args.runId });
    }
  } catch (err) {
    console.warn(
      "[run-wait-notifier] transition side-effect failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The lifecycle checkpoint a run-start recommendation HOLD parks on — the ONE
 * non-transition human wait this seam serves.
 *
 * Declared HERE, in the leaf, rather than in the hold module, for two reasons:
 * the seam's own hold-binding guard below must compare against it (and this
 * module may import nothing at runtime — see the header's TRUE LEAF property),
 * and the park store's release primitive must recognise the same checkpoint to
 * clear the row. Both import it from here, so the three sites that must agree on
 * "which park is a notifying hold" share one literal instead of three copies.
 * `recommendation-hold.ts` re-exports it as `RECOMMENDATION_CHECKPOINT`.
 */
export const RECOMMENDATION_HOLD_CHECKPOINT = "recommendation" as const;

/**
 * The park table the hold notification is fenced against, and the column that
 * records whether a row was written for a hold. Declared HERE (a pure string, no
 * runtime import) so the ONE place that composes the fence SQL — the host writer,
 * which is the only module that can reach both this table and the notifications
 * table on one connection — never hand-spells the identifiers.
 */
export const HOLD_PARK_TABLE = "lifecycle_continuation_park" as const;

/**
 * `lifecycle_continuation_park.hold_notification` — the DURABLE record of what a
 * hold owes the notification feed. Three states, and the transitions between them
 * are what make the clear retryable rather than best-effort:
 *
 *   `none`    — nothing was ever written for this park (no initiator to notify, a
 *               non-recommendation checkpoint, a fence that refused). Nothing owed.
 *   `live`    — a notification row EXISTS for this hold. Set in the SAME
 *               transaction as the insert, so it can never claim a row that was
 *               not written, and never miss one that was.
 *   `cleared` — the row has been deleted. Set only AFTER an awaited, successful
 *               delete, so the ack can never run ahead of the effect it acks.
 *
 * The invariant the sweeper enforces: a park that is no longer `parked` and is
 * still `live` OWES a clear, and every subsequent sweep re-attempts it. A process
 * that dies between the status CAS and the delete therefore leaves a retryable
 * obligation, not a permanently stale bell (Codex convergence round 3, finding 3).
 */
export const HOLD_NOTIFICATION_NONE = "none" as const;
export const HOLD_NOTIFICATION_LIVE = "live" as const;
export const HOLD_NOTIFICATION_CLEARED = "cleared" as const;
export type HoldNotificationState =
  | typeof HOLD_NOTIFICATION_NONE
  | typeof HOLD_NOTIFICATION_LIVE
  | typeof HOLD_NOTIFICATION_CLEARED;

/**
 * A single SQL statement, in the shape every host query runner in this codebase
 * takes. Declared locally so this leaf keeps its zero-runtime-imports property.
 */
export interface HoldFenceStatement {
  text: string;
  values: unknown[];
}

/**
 * The TRANSACTIONAL FENCE a hold notification must be written behind
 * (cinatra#2835, Codex convergence round 3, findings 1 + 2).
 *
 * `guard` is a `SELECT … FOR UPDATE` that yields ONE row while — and only while —
 * the named park exists, belongs to the named run, is a recommendation hold, and
 * is still `parked`. `mark` records the write on that same row. The host runs
 * BOTH in ONE transaction on ONE connection, with the notification INSERT
 * sandwiched between them and fed FROM the guard, so:
 *
 *   - the insert is a `SELECT`-driven insert over the guard's rows: an invented
 *     park id yields zero rows and therefore writes NOTHING. The fabrication
 *     boundary is the DATABASE, not a structural TypeScript shape a cast can
 *     satisfy (finding 2). This seam's own arguments are two opaque ids; there is
 *     no longer any claim that holding a value proves anything.
 *   - `FOR UPDATE` takes the park's row lock, which is the SAME lock `sweepParks`'
 *     `status = 'parked'` CAS must take. The two therefore SERIALIZE on the park
 *     row: either the enter commits first and the sweep's CAS then sees a
 *     still-`parked` row, transitions it, and goes on to clear what we wrote — or
 *     the sweep commits first and our guard, re-evaluated against the new row
 *     version under READ COMMITTED, matches nothing and writes nothing. A clear
 *     can no longer land BETWEEN a liveness check and the write it was checking
 *     for, because there is no gap left to land in (finding 1).
 *
 * PURE — string building only. Callers pass the resolved schema name; the
 * placeholders start at `$1` and are independent of the notification insert's own
 * (each statement runs as its own query inside the shared transaction).
 */
export function buildHoldNotificationFence(input: {
  schema: string;
  parkId: string;
  runId: string;
}): { guard: HoldFenceStatement; mark: HoldFenceStatement } {
  const table = `"${input.schema.replaceAll('"', '""')}"."${HOLD_PARK_TABLE}"`;
  const match = `id = $1 AND run_id = $2 AND checkpoint = $3 AND status = 'parked'`;
  const values = [input.parkId, input.runId, RECOMMENDATION_HOLD_CHECKPOINT];
  return {
    // LIMIT 1 is belt-and-braces (`id` is the primary key): it makes "at most one
    // row feeds the insert" true by construction rather than by key knowledge.
    guard: { text: `SELECT id FROM ${table} WHERE ${match} LIMIT 1 FOR UPDATE`, values },
    // Same predicate as the guard, so a fence that refused the insert cannot mark
    // a park `live` — the two statements agree about what they are looking at.
    mark: {
      text: `UPDATE ${table} SET hold_notification = '${HOLD_NOTIFICATION_LIVE}' WHERE ${match}`,
      values,
    },
  };
}

/**
 * cinatra#2835 — drive the wired notifier for a run-start recommendation HOLD.
 *
 * `dispatchRunWaitTransition` above is driven by `transitionRunStatus`, so it can
 * only fire for a wait a run ENTERS by changing status. The recommendation HOLD is
 * a human wait that does not: the run is ALREADY `pending_input` (it was created
 * that way and is simply never dispatched), and the hold parks it on a
 * continuation park instead of moving the status column — so there is no
 * transition to ride and the classifier never sees the wait. This is the seam that
 * path calls directly.
 *
 * TWO OPAQUE IDS, AND THE DATABASE DECIDES (Codex convergence round 3, findings
 * 1 + 2). This seam used to take a `RunHoldBinding` — a structural park shape —
 * and validate it here, in TypeScript, against caller-supplied fields. That guard
 * proved nothing at runtime: a cast satisfied it, and even an HONEST caller could
 * only assert what was true when it read the park, not what is true when the row
 * is written. Both defects had the same root cause — the check and the write were
 * in different places, with a window between them.
 *
 * So the check MOVED INTO THE WRITE. This function forwards a run id and a park
 * id and asserts nothing about either; the host writes the row behind
 * `buildHoldNotificationFence`, which locks the park and feeds the INSERT from it
 * inside ONE transaction. A park id that names no row (or the wrong run, or a
 * checkpoint that is not a hold, or a park that already left `parked`) yields no
 * guard row and therefore no notification — including for a caller that invented
 * the id outright. There is nothing left here for a cast to defeat, and nothing
 * left for a concurrent sweep to slip between.
 *
 * The host also records the write on the park row (`hold_notification = 'live'`,
 * same transaction), which is what makes the matching clear RETRYABLE — see
 * `dispatchRecommendationHoldCleared`.
 *
 * Best-effort in the same sense as every other emitter here: a thrown port is
 * swallowed, because a notification must never fail a hold that is already parked.
 */
export async function dispatchRecommendationHoldEntered(input: {
  runId: string;
  parkId: string;
}): Promise<void> {
  const notifier = notifierHolder().notifier;
  if (!notifier?.onEnterRecommendationHold) return;
  try {
    await notifier.onEnterRecommendationHold({
      runId: input.runId,
      parkId: input.parkId,
    });
  } catch (err) {
    console.warn(
      "[run-wait-notifier] recommendation-hold enter side-effect failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * cinatra#2835 — the hold ENDED: delete the row its enter wrote.
 *
 * A hold that is CONFIRMED or SKIPPED goes on to dispatch, and that
 * `pending_input → queued` transition also clears through
 * `dispatchRunWaitTransition`. But a hold can equally be RELEASED with no dispatch
 * behind it (the TTL sweeper's fail-close; a decision whose dispatch is refused
 * downstream), and that run stays `pending_input` — no transition, so nothing else
 * would ever clear the row. A park leaving `parked` is therefore itself a clear,
 * and `sweepParks` — the ONE primitive a park transitions through — drives it
 * (Codex convergence round 2, finding 1).
 *
 * RETURNS THE ACK (Codex convergence round 3, finding 3). The clear cannot ride
 * the park CAS's own transaction: the notification row is written through the
 * host's separate connection, so "committed transition ⇒ committed delete" is not
 * available to us. What IS available is "committed transition ⇒ committed
 * OBLIGATION": the park carries `hold_notification = 'live'` from the enter, the
 * CAS leaves it there, and the sweeper retires it only on a `true` from here.
 * Anything else — a throwing port, a dead process, a host that wired no clear —
 * leaves the park terminal-and-`live`, which every later sweep re-drains. The
 * delete is idempotent, so over-retrying costs nothing and under-retrying is the
 * only failure that matters.
 *
 * A missing notifier returns `false` DELIBERATELY: it means we did not clear, and
 * claiming otherwise would retire an obligation nothing has discharged.
 */
export async function dispatchRecommendationHoldCleared(input: {
  runId: string;
  parkId: string;
}): Promise<boolean> {
  const notifier = notifierHolder().notifier;
  if (!notifier?.onClearRecommendationHold) return false;
  try {
    return await notifier.onClearRecommendationHold({
      runId: input.runId,
      parkId: input.parkId,
    });
  } catch (err) {
    console.warn(
      "[run-wait-notifier] recommendation-hold clear side-effect failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * cinatra#2066 C2 — drive the wired notifier for a lifecycle AUTO-GATE opening.
 * Called by the review-orchestration store when it emits a NEW auto-gate (not an
 * idempotent re-emit). No-op when no host wired a notifier or the host wired one
 * without the optional `onAutoGateOpen`. Best-effort: a thrown port is swallowed
 * so a notification failure can NEVER fail orchestration (matching every other
 * emitter in this codebase). NOT exported from the package index — an
 * intra-package leaf the store imports directly, so it adds no public surface. */
export async function dispatchAutoGateOpen(input: {
  runId: string;
  reviewTaskId: string;
}): Promise<void> {
  const notifier = notifierHolder().notifier;
  if (!notifier?.onAutoGateOpen) return;
  try {
    await notifier.onAutoGateOpen(input);
  } catch (err) {
    console.warn(
      "[run-wait-notifier] auto-gate-open side-effect failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * cinatra#2066 C2 — drive the wired notifier to CLEAR an auto-gate-open row when
 * the gate reaches a terminal review decision. Called by the gate-decision commit
 * on a terminal (approve/reject) resolution. Idempotent + best-effort: a delete
 * by (runId, reviewTaskId) that names no row is a harmless no-op (a flow-authored
 * gate or an initiator-less run never minted one). */
export async function dispatchAutoGateResolved(input: {
  runId: string;
  reviewTaskId: string;
}): Promise<void> {
  const notifier = notifierHolder().notifier;
  if (!notifier?.onAutoGateResolved) return;
  try {
    await notifier.onAutoGateResolved(input);
  } catch (err) {
    console.warn(
      "[run-wait-notifier] auto-gate-resolved side-effect failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
