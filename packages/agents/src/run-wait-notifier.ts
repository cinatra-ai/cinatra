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
   * unit-test double) simply skips the emit.
   *
   * cinatra#2864 — THE WRITE CONTRACT. The implementation must write the row
   * behind `buildAutoGateNotificationFence`, in ONE statement with the gate row
   * it names, so the insert is impossible for a gate that does not exist, does
   * not belong to this run/task, or has already reached a terminal decision. An
   * implementation that checks the gate BEFORE writing satisfies nothing: the
   * check is over the moment it returns, and the resolve's clear may land in the
   * gap. See `dispatchAutoGateOpen` below. */
  onAutoGateOpen?(input: {
    runId: string;
    reviewTaskId: string;
  }): void | Promise<void>;
  /** The auto-gate reached a terminal review decision — hard-delete the
   * `onAutoGateOpen` row by its (runId, reviewTaskId) key (idempotent; a no-op
   * when none was minted, e.g. a flow-authored gate or an initiator-less run).
   *
   * cinatra#2864 — this delete no longer needs to fear an open still in flight.
   * The caller runs it only AFTER the terminal decision has COMMITTED, and the
   * decision's own transaction takes the gate row's lock. The open's fence takes
   * the SAME lock. So the two orderings are the only two possible: the open
   * committed first (and this delete finds its row), or this delete ran first
   * (and the open's fence, re-evaluated against the resolved row, writes
   * nothing). "Matched no row" therefore means "no row exists", not "no row yet". */
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
 * The gate table an auto-gate notification is fenced against, and the status a
 * gate holds while its review is still open. Declared HERE (pure strings, no
 * runtime import — see the header's TRUE LEAF property) so the ONE place that
 * composes the fence SQL never hand-spells them.
 */
export const AUTO_GATE_TABLE = "artifact_review_gates" as const;
export const AUTO_GATE_PENDING_STATUS = "pending" as const;

/**
 * The fence SQL, in the shape the host's fenced writer takes: one placeholder
 * array (the whole fence is ONE statement, so it has one parameter space) and a
 * guard that numbers its placeholders from `$1` over it. Declared locally so this
 * leaf keeps its zero-runtime-imports property.
 */
export interface AutoGateFenceSql {
  values: unknown[];
  guard: string;
}

/**
 * cinatra#2864 — the TRANSACTIONAL FENCE an auto-gate-open notification must be
 * written behind. The same discipline #2835 gave the recommendation hold
 * (`buildHoldNotificationFence`), adapted to the gate: the SUBJECT of this
 * notification is the gate row, so the gate row is what the write is fenced on.
 *
 * `guard` is a `SELECT … FOR UPDATE` that yields ONE row while — and only while —
 * a gate exists for this (run, task) and is still `pending`. The host composes it
 * as a CTE of the notification INSERT, and the insert is driven FROM its rows, so:
 *
 *   - a gate that reached a terminal decision before the open ever ran yields no
 *     guard row and therefore writes NOTHING. The check is not "before the
 *     write"; it IS the write, so there is no window between them to lose.
 *   - `FOR UPDATE` takes the gate's row lock, which is the SAME lock
 *     `commitReviewDecision` takes for its terminal `pending → resolved` CAS. The
 *     open and the decision therefore SERIALIZE on the gate row. The decision's
 *     clear runs only after that CAS has COMMITTED, so the two possible orderings
 *     are: the open commits first and the clear then finds the row it must
 *     delete; or the decision commits first and the guard, re-evaluated against
 *     the new row version under READ COMMITTED, matches nothing. The
 *     "clear-then-insert" interleaving — the one that left a bell entry pointing
 *     at a review nobody can take — no longer exists.
 *
 * NO MARK, and no obligation column beside it. The hold needed one because the
 * park's transition is the ONLY event that ever clears a hold row, so a clear lost
 * to a failed dispatch had no second chance. The gate's clear is not the gate's
 * only one: this row is keyed per (run, task) and hard-deleted by key, and a
 * failed dispatch is a pre-existing best-effort property of every emitter on this
 * seam, not the ordering defect #2864 names. Adding a durable obligation to the
 * gate row is issue #2864's alternative shape 2 — a strictly larger change (a
 * migration on `artifact_review_gates` plus a sweep to drain it) that closes a
 * DIFFERENT failure, and is deliberately not taken here.
 *
 * PURE — string building only. The caller passes the resolved schema name; the
 * host numbers the insert's own row values behind `values`.
 */
export function buildAutoGateNotificationFence(input: {
  schema: string;
  runId: string;
  reviewTaskId: string;
}): AutoGateFenceSql {
  const table = `"${input.schema.replaceAll('"', '""')}"."${AUTO_GATE_TABLE}"`;
  return {
    values: [input.runId, input.reviewTaskId],
    // LIMIT 1 is belt-and-braces (`artifact_review_gates_run_task_uniq` already
    // makes (run_id, review_task_id) unique): it makes "at most one row feeds the
    // insert" true by construction rather than by index knowledge.
    guard:
      `SELECT id FROM ${table} ` +
      `WHERE run_id = $1 AND review_task_id = $2 ` +
      `AND status = '${AUTO_GATE_PENDING_STATUS}' LIMIT 1 FOR UPDATE`,
  };
}

/**
 * cinatra#2066 C2 — drive the wired notifier for a lifecycle AUTO-GATE opening.
 * Called by the review-orchestration store when it emits a NEW auto-gate (not an
 * idempotent re-emit). No-op when no host wired a notifier or the host wired one
 * without the optional `onAutoGateOpen`. Best-effort: a thrown port is swallowed
 * so a notification failure can NEVER fail orchestration (matching every other
 * emitter in this codebase). NOT exported from the package index — an
 * intra-package leaf the store imports directly, so it adds no public surface.
 *
 * cinatra#2864 — THE ONE SEAM, AND THE FENCE IS INSIDE IT. This dispatch and
 * `dispatchAutoGateResolved` below used to be a best-effort pair with no ordering
 * between them: a resolve that deleted while this insert was still in flight
 * matched nothing, the insert then committed, and the row outlived the gate it
 * announced — a bell entry pointing forever at "This review is no longer open".
 *
 * The fix is not in this function and deliberately not in any caller. An opening
 * path reaches the notifier through THIS dispatch and hands it nothing but the
 * gate's own two ids, so the ordering is closed ONCE, in the host's
 * `onAutoGateOpen`, by writing the row behind `buildAutoGateNotificationFence`
 * above. There is no path-by-path variant to keep in step, and a path added later
 * inherits the fence by calling this function at all.
 *
 * WHICH PATHS, ON THIS BRANCH. One caller dispatches today:
 * `orchestrateProducedEvent`, the single produced artifact. cinatra#2833
 * (https://github.com/cinatra-ai/cinatra/pull/2838, open) adds three more —
 * `orchestrateProducedBatch`, `submitRepairResponse`,
 * `writeVerificationRecordAndMaybeReopen` — and each of them calls THIS function
 * with the same `{runId, reviewTaskId}`. That is why the fix belongs here and not
 * at a call site: the three paths that do not exist yet on this branch are fenced
 * the moment they land, with no change to the code that adds them. */
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
