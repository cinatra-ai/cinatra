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
 * The HOLD a human-wait notification is bound to: the continuation park row that
 * makes the run actually wait. Structurally a `ParkRow` (the park store's row
 * type is assignable to this), so the only way to obtain one is to have READ a
 * park — this seam cannot be driven by a caller that has no hold in hand.
 */
export interface RunHoldBinding {
  id: string;
  runId: string;
  checkpoint: string;
  status: "parked" | "released" | "policy_unresolved";
}

/**
 * cinatra#2835 — drive the wired notifier for a human wait that is NOT a status
 * TRANSITION.
 *
 * `dispatchRunWaitTransition` above is driven by `transitionRunStatus`, so it can
 * only fire for a wait a run ENTERS by changing status. The run-start
 * recommendation HOLD is a human wait that does not: the run is ALREADY
 * `pending_input` (it was created that way and is simply never dispatched), and
 * the hold parks it on a continuation park instead of moving the status column —
 * so there is no transition to ride and the classifier never sees the wait. This
 * is the seam that path calls directly, with the SAME `onEnterHumanWait`
 * contract (per-run dedupeKey, so a re-hold of the same run collapses onto one
 * row) and the SAME best-effort posture: a thrown port is swallowed, because a
 * notification can never be allowed to fail a hold that is already parked.
 *
 * `waitKind` is passed through so the hold is presented as the INPUT wait it is
 * (the #2729 ruling: "needs your input", linking back to the conversation the run
 * was started in) — the host cannot derive that here, since a held run carries no
 * HITL interrupt to classify.
 *
 * BOUND TO THE HOLD (Codex convergence round 2, finding 2). Every other notifying
 * seam in this file is bound to a durable fact the caller cannot invent: a status
 * TRANSITION for `dispatchRunWaitTransition`, a (run, reviewTaskId) gate for the
 * auto-gate pair. This one had no such binding — it forwarded a caller-supplied
 * {runId, reason, waitKind} unconditionally, so ANY code path could mint a "needs
 * your input" row against ANY `pending_input` run and no hold behind it, leaving a
 * bell pointing at a card that does not exist and (a hold moving no run status) no
 * transition to ever clear it. It now REFUSES unless it is handed the live
 * recommendation park that IS the wait:
 *
 *   - no `hold` → not expressible: the argument is required;
 *   - a hold on another checkpoint (an auto-gate `review` park) → refused; that
 *     wait notifies through `onAutoGateOpen`, and a second row would double-ring;
 *   - a hold naming another run → refused (the notification is per-run keyed, so a
 *     mismatched pair would clear under a key nothing wrote);
 *   - a hold that is not `parked` → refused: a released / TTL-fail-closed park is
 *     a wait that is already OVER, and minting for it is exactly the stale row
 *     this issue exists to prevent.
 *
 * The refusal is silent-but-logged rather than a throw, matching the seam's
 * best-effort posture: a notification must never fail a hold, and refusing to
 * write a fabricated row is strictly safer than writing one. The park's LIVENESS
 * is re-read from the database by the caller that owns DB access
 * (`maybeHoldRunForRecommendation`) — this module is a true leaf and cannot query,
 * so the structural guard here and the DB read there are two halves of one bind.
 */
export async function dispatchRunHumanWaitEntered(input: {
  runId: string;
  reason: RunHumanWaitReason;
  waitKind?: RunWaitInterruptKind;
  /** The LIVE recommendation park that makes this run wait. Required. */
  hold: RunHoldBinding;
}): Promise<void> {
  const refusal = describeHoldRefusal(input.runId, input.hold);
  if (refusal) {
    console.warn(`[run-wait-notifier] refusing to notify a human wait with no live hold: ${refusal}`);
    return;
  }
  const notifier = notifierHolder().notifier;
  if (!notifier) return;
  try {
    await notifier.onEnterHumanWait({
      runId: input.runId,
      reason: input.reason,
      waitKind: input.waitKind,
    });
  } catch (err) {
    console.warn(
      "[run-wait-notifier] human-wait enter side-effect failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Why this (run, hold) pair may NOT mint a human-wait notification, or null when
 * it may. Pure — the caller supplies the row it read. */
function describeHoldRefusal(runId: string, hold: RunHoldBinding | undefined | null): string | null {
  if (!hold) return `run ${runId} was given no hold`;
  if (hold.checkpoint !== RECOMMENDATION_HOLD_CHECKPOINT) {
    return `park ${hold.id} is a '${hold.checkpoint}' checkpoint, not a recommendation hold`;
  }
  if (hold.runId !== runId) return `park ${hold.id} belongs to run ${hold.runId}, not ${runId}`;
  if (hold.status !== "parked") return `park ${hold.id} is already ${hold.status} — the wait is over`;
  return null;
}

/**
 * cinatra#2835 — the counterpart clear for a non-transition human wait: the wait
 * ENDED without the run's status necessarily moving.
 *
 * A recommendation hold that is CONFIRMED or SKIPPED goes on to dispatch, and
 * that `pending_input → queued` transition already clears the row through
 * `dispatchRunWaitTransition`. But a hold can also simply be RELEASED with no
 * dispatch behind it (the TTL sweeper's fail-close; a decision whose dispatch is
 * refused downstream), and that run stays `pending_input` — no transition, so
 * nothing would ever clear the row and the bell would keep pointing at a card the
 * human can no longer act on. A park leaving `parked` is therefore itself a clear.
 *
 * The ONE caller is `sweepParks` (lifecycle-continuation-park-store), the single
 * primitive through which a park transitions out of `parked` — so EVERY release
 * path inherits the clear rather than only the one helper that used to wire it
 * (Codex convergence round 2, finding 1).
 *
 * Idempotent by construction (the host's clear is a delete-by-dedupeKey), so
 * firing here AND on a subsequent dispatch transition is a harmless double-no-op.
 */
export async function dispatchRunHumanWaitLeft(input: {
  runId: string;
}): Promise<void> {
  const notifier = notifierHolder().notifier;
  if (!notifier) return;
  try {
    await notifier.onLeaveHumanWait({ runId: input.runId });
  } catch (err) {
    console.warn(
      "[run-wait-notifier] human-wait leave side-effect failed:",
      err instanceof Error ? err.message : err,
    );
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
