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
