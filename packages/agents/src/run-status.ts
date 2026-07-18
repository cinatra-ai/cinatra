// ---------------------------------------------------------------------------
// Run-status state machine (extracted from store.ts, #1037 P1 file-size ratchet)
// ---------------------------------------------------------------------------
//
// The pure, zero-dependency run-status domain: the AgentRunStatus union, the
// terminal-status set, the legal from->to transition table (and its test-only
// read-only view), and the two structured lifecycle error classes. Extracted
// verbatim from packages/agents/src/store.ts so the state machine has a home
// independent of the persistence hub; store.ts re-exports every symbol below so
// its public surface is unchanged for existing `./store` importers.
//
// This module imports nothing (no DB, no drizzle) — it is a leaf.
// ---------------------------------------------------------------------------

export type AgentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "pending_approval"
  | "pending_input"
  | "stopped"
  // gated state for runs whose trigger has not yet released.
  // The pending_input → armed flip pairs with the armed → queued
  // transition fired by the release job to close the loop.
  | "armed"
  // first-step form open, awaiting submit.
  // Transient waiting state; not terminal. Used by the trigger UI to mark
  // a run that the user is actively configuring before it transitions to
  // armed (scheduled/recurring) or queued (immediate).
  | "pending_trigger"
  // IN-FLIGHT WayFlow run paused at a TriggerWaitNode.
  // Distinct from `pending_trigger` (which is the pre-dispatch form-open
  // state). A `waiting_trigger` run has an active a2aContextId held open by
  // the WayFlow worker; the trigger-release-job resumes it by sending an A2A
  // message into that same context (NOT by re-dispatching from start).
  | "waiting_trigger";

export const TERMINAL_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  "completed",
  "failed",
  "stopped",
]);

// Derived from exhaustive grep of existing updateAgentRunStatus* callsites
// Transition table includes cancel/reject edges from any live state so
// user-cancel works consistently.
// and <non-terminal>→failed edges so user-cancel works from any live state).
// Exported so store.ts (which retains transitionRunStatus) can import it for the
// illegal-transition guard. NOT re-exported from ./store — the public `./store`
// surface never exposed LEGAL_TRANSITIONS (only the __LEGAL_TRANSITIONS__ view).
export const LEGAL_TRANSITIONS = new Set<`${AgentRunStatus}->${AgentRunStatus}`>([
  // Setup / dispatch
  "pending_input->queued",        // run-actions.ts: triggerAgentRun, createAndTriggerRunCore, startDevChildPreviewRun
  "queued->pending_input",        // run-actions.ts: compensation reverts (x2)
  "queued->pending_approval",     // execution.ts: setup-interrupt loop (per-field + grouped)
  "queued->running",              // execution.ts: dispatch CAS (langgraph + external branches)
  "pending_approval->running",    // langgraph-execution.ts:89 (resume CAS)

  // Running transitions
  "running->pending_approval",    // langgraph-stream-handler: interrupt paths A/B/C
  "running->completed",           // langgraph-execution.ts:253; execution.ts:439 (external proxy)
  "running->failed",              // many — OAS compile, SSE error, timeout, missing lgThreadId, outer catch, etc.
  "running->stopped",             // langgraph-execution.ts: outcome.kind === "stopped_rejected"

  // Early failures from queued
  "queued->failed",               // execution.ts: template not found, snapshot corrupt, orchestrator gate, etc.

  // Successes from paused states (resume terminal-success).
  // A WayFlow run that returns task.status.state === "completed" on resume must
  // transition pending_approval -> completed without an intermediate hop. The
  // multi-gate handler (handleWayflowTaskState in execution.ts) calls
  // transitionRunStatus(runId, "pending_approval", "completed", ...) directly
  // when fromStatus === "pending_approval" and the task state is terminal-success.
  // Without this edge, the helper would throw RunTransitionError code="illegal_transition"
  // (NOT swallowable).
  "pending_approval->completed",  // execution.ts: handleWayflowTaskState (resume terminal-success path)

  // Failures from paused states
  "pending_approval->failed",     // langgraph-resume-handler.ts + actions.ts rejectReviewTask setup-path
  "pending_input->failed",        // actions.ts rejectReviewTask setup-path

  // User-driven resets / resumes
  "failed->pending_input",        // run-actions.ts: resetAgentRun
  "stopped->queued",              // orchestrator-actions.ts: resumeStoppedOrchestratorAction
  "queued->stopped",              // orchestrator-actions.ts:165 (compensation) + mcp/handlers.ts + orchestrator-execution.ts cancel

  // Cancel paths — user-press-Stop must work from any non-terminal state (Pitfall 3)
  "pending_approval->stopped",    // mcp/handlers.ts: agent_run_stop + orchestrator-execution.ts cancel
  "pending_input->stopped",       // mcp/handlers.ts: agent_run_stop

  // gated trigger lifecycle.
  // transitions pending_input → armed when the user submits a
  // scheduled/recurring trigger; the release job transitions
  // armed → queued when the gate opens and then enqueues
  // AGENT_BUILDER_EXECUTION. Cancel/fail edges mirror the pattern used
  // by other gated states.
  "pending_input->armed",         // run-actions.ts:setRunTrigger
  "armed->queued",                // trigger-release-job.ts
  "armed->stopped",               // run-actions.ts:cancelRun  + bulk stop paths
  "armed->failed",                // defensive — failure during arming/release
  "armed->pending_input",         // user removes trigger, returns to setup
  // pending_trigger lifecycle (form-open transient state).
  "pending_input->pending_trigger",   // user opens the trigger form
  "pending_trigger->pending_input",   // user navigates away without submitting
  "pending_trigger->armed",           // form submit with scheduled/recurring fallback
  // TriggerWaitNode pause/resume in-flight WayFlow run.
  // Distinct lifecycle from `armed` (clone-on-tick); `waiting_trigger` resumes
  // the same a2aContextId.
  "running->waiting_trigger",         // execution.ts: WayFlow yielded at TriggerWaitNode
  "waiting_trigger->running",         // trigger-release-job.ts: A2A resume into existing context
  "waiting_trigger->stopped",         // user-press-Stop during the trigger wait
  "waiting_trigger->failed",          // timeout expiry, stale release, or A2A resume failure
]);

// Test-only export: lets transition-coverage.test.ts import the set without
// re-typing it. Named with double-underscore to signal "internal".
export const __LEGAL_TRANSITIONS__: ReadonlySet<string> = LEGAL_TRANSITIONS;

/**
 * Structured error thrown by transitionRunStatus. Callers differentiate via
 * `code`:
 *   - "illegal_transition"  — programmer error; the from→to pair is not in
 *                              LEGAL_TRANSITIONS. Do NOT catch and swallow.
 *   - "stale_from_status"   — race; the DB row changed between read and CAS.
 *                              Usually benign (another worker won); log + continue.
 */
/**
 * thrown when ownership reassignment is attempted on a template
 * that has already been run (first_run_at IS NOT NULL). The pre-run gate is
 * enforced atomically in SQL via WHERE first_run_at IS NULL. Callers (UI,
 * server actions) should catch this and surface a clear error to the user
 * suggesting they uninstall + reinstall to change ownership.
 */
export class CannotReassignAfterFirstRun extends Error {
  readonly code = "CANNOT_REASSIGN_AFTER_FIRST_RUN" as const;
  readonly templateId: string;
  constructor(templateId: string) {
    super(
      `Agent template ${templateId} has been run and cannot be reassigned. ` +
        `Uninstall and reinstall to change ownership.`,
    );
    this.name = "CannotReassignAfterFirstRun";
    this.templateId = templateId;
  }
}

export class RunTransitionError extends Error {
  readonly code: "illegal_transition" | "stale_from_status";
  readonly runId: string;
  readonly from: AgentRunStatus;
  readonly to: AgentRunStatus;

  constructor(args: {
    code: "illegal_transition" | "stale_from_status";
    runId: string;
    from: AgentRunStatus;
    to: AgentRunStatus;
    message?: string;
  }) {
    super(
      args.message ??
        `transitionRunStatus(${args.runId}) ${args.code}: ${args.from} → ${args.to}`,
    );
    this.name = "RunTransitionError";
    this.code = args.code;
    this.runId = args.runId;
    this.from = args.from;
    this.to = args.to;
  }
}
