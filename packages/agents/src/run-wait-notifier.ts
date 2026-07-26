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
  }): void | Promise<void>;
  /** A run left a human-wait state — hard-delete the notification (idempotent). */
  onLeaveHumanWait(input: { runId: string }): void | Promise<void>;
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
 */
export type RunWaitClassification =
  | { kind: "enter"; reason: RunHumanWaitReason }
  | { kind: "leave" }
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
    return { kind: "leave" };
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
