// ---------------------------------------------------------------------------
// Run-status state machine (extracted from store.ts, #1037 P1 file-size ratchet)
// ---------------------------------------------------------------------------
//
// The pure, zero-dependency run-status domain: the AgentRunStatus union, the
// terminal-status set, the legal from->to transition table (and its test-only
// read-only view), the two structured lifecycle error classes, and the pure
// TERMINAL-OUTCOME resolution the run panels render (cinatra#2482, second
// section below). Extracted verbatim from packages/agents/src/store.ts so the
// state machine has a home independent of the persistence hub; store.ts
// re-exports the state-machine symbols so its public surface is unchanged for
// existing `./store` importers.
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
  // cinatra#1940 P1 (Decision 5): terminal edges from the form-open state.
  "pending_trigger->stopped",         // cancel/bulk-stop from the form-open state (single CAS, no pending_input detour)
  "pending_trigger->failed",          // defensive — arming/template failure while the form is open (mirrors armed->failed)
  // cinatra#2523 (owner ruling 2026-08-09, remedy (c)) — the setup -> trigger
  // hand-off becomes a REAL pair of edges.
  //
  // Before this, a run whose setup form was submitted fell straight through to
  // dispatch. On an agent with no gated steps (`gatedSteps: []` — every agent
  // whose steps carry no side-effect risk class) the trigger gate does not
  // apply, so the run EXECUTED and landed `completed` before the user ever
  // reached the trigger form; "Run right after setup" then had nothing left to
  // dispatch and the refusal was swallowed. `pending_trigger` already MEANS
  // "the trigger step is open, awaiting the user's choice" — it simply had no
  // producer, which is why `pending_trigger->armed` sat unreachable. These two
  // edges give it one, and give the immediate choice a legal dispatch edge, so
  // no caller has to fake a transition out of a terminal status.
  "queued->pending_trigger",          // execution.ts: setup finished, no trigger chosen yet
  "pending_trigger->queued",          // trigger-service.ts: the user chose "Run right after setup"
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

// ---------------------------------------------------------------------------
// Terminal-run OUTCOME resolution (folded in from run-terminal-outcome.ts,
// cinatra#2482 — route-graph ratchet: the locked routes carry this graph, so
// the decision lives in the existing pure run-status leaf rather than in a
// net-new module)
// ---------------------------------------------------------------------------
//
// A `completed` run used to render NOTHING actionable on the canonical run
// view: `OrchestratorStepperPanel` set `stageCard = null` for every terminal
// status that was not `failed`/`stopped`, and `AgenticRunPanel` fell through to
// a bare "No messages yet." — so the immediate-trigger flow ("Run right after
// setup" -> Continue) landed the user on a frozen stepper with all steps marked
// complete, no output, and no way forward.
//
// This section is the PURE half of the fix: given the run's terminal status and
// the evidence the run actually left behind, it names which of the three states
// the issue's acceptance criteria enumerate applies —
//
//   1. still progressing        -> `not-terminal` (the spinner/gate cards own it)
//   2. produced output          -> `completed-with-output` (link the outputs, or
//                                  point at the transcript rendered below)
//   3. terminated with nothing  -> `completed-no-output` (say so, offer the next
//                                  action)
//
// No React, no I/O — the decision stays unit-testable on its own, and the card
// (`run-completion-affordances.tsx`) only renders what this returns.
// ---------------------------------------------------------------------------

/**
 * A provenance-linked output object produced by a run (`objects.run_id = runId`),
 * reduced to what the completion card needs to link it.
 */
export type RunProducedOutput = {
  /** `objects.id` — the artifact detail route is `/artifacts/<id>`. */
  id: string;
  /**
   * Resolved artifact type. Not rendered — it is the input to the title
   * fallback (see {@link deriveProducedOutputTitle}) for a row whose data
   * carries no usable label.
   */
  type: string;
  /** Human title, already derived (see {@link deriveProducedOutputTitle}). */
  title: string;
};

/**
 * Evidence the run left behind, read fresh at card-mount time rather than
 * captured at SSR — a run that completes while the user watches would otherwise
 * be judged on a snapshot taken while it was still `queued`.
 */
export type RunOutputEvidence = {
  /** Provenance-linked output objects, newest first. */
  outputs: readonly RunProducedOutput[];
  /** Persisted run messages or accumulated streamed text exist. */
  hasTranscript: boolean;
  /** `agent_runs.step_results` is a non-empty array. */
  hasStepResults: boolean;
  /**
   * True when the produced-output read FAILED, so `outputs: []` means "we could
   * not look", not "there was nothing".
   *
   * Without this the fail-soft catch turned an infrastructure error into a
   * confident "this run produced no output" — the same false claim this module
   * exists to prevent, just arriving by a different route (codex round-2
   * finding). An empty-but-unavailable read takes the conservative branch.
   */
  outputsUnavailable?: boolean;
  /**
   * True when the run DID write provenance-linked rows but NONE of them could be
   * linked — every candidate was non-artifact-typed or read-denied, or the scan
   * window filled with such rows.
   *
   * Distinct from {@link outputsUnavailable}: the read SUCCEEDED, so this is not
   * an infrastructure failure. It is the stronger statement "this run saved
   * something we cannot open from here" — and it must never be collapsed into
   * `outputs: []` meaning "the run produced nothing", because that is a flat
   * falsehood about a run that demonstrably saved rows (confirmation-round
   * finding).
   */
  unlinkableOutputs?: boolean;
};

export type RunTerminalOutcome =
  | { kind: "not-terminal" }
  | {
      kind: "completed-with-output";
      outputs: readonly RunProducedOutput[];
      /**
       * True when the ONLY evidence is transcript/step-results, i.e. the output
       * is already rendered further down the panel and the card should point at
       * it rather than claim there is nothing.
       */
      outputRenderedBelow: boolean;
      /**
       * True when we could NOT establish what the run left behind: the read is
       * still in flight, it failed, or it returned only rows we cannot link.
       *
       * The card MUST NOT make a definite claim in this state. Before this flag
       * every conservative branch reused the "its output is in the run
       * transcript below" copy, so a failed read told the user to look at a
       * transcript that was not there — the panel even suppresses its "No
       * messages yet." line under the card, so the user was pointed at blank
       * space (confirmation-round finding).
       */
      evidenceIndeterminate: boolean;
    }
  | { kind: "completed-no-output" };

/**
 * The one terminal status this module speaks for. `failed` and `stopped` have
 * their own dedicated cards (FailedCard / CancelledCard) with their own
 * recovery affordances — re-deciding them here would double-render them.
 */
export const COMPLETED_STATUS = "completed";

/**
 * Resolve which terminal state a run is in.
 *
 * Only `completed` resolves to a terminal outcome. Any other status — including
 * `failed`/`stopped`, which are terminal but separately handled — returns
 * `not-terminal` so the caller's existing branch keeps ownership.
 */
export function resolveRunTerminalOutcome(input: {
  status: string;
  evidence: RunOutputEvidence | null;
}): RunTerminalOutcome {
  if (input.status !== COMPLETED_STATUS) return { kind: "not-terminal" };
  const evidence = input.evidence;
  // Evidence not resolved yet (the read is in flight or failed). Treat it as
  // "output may exist" rather than asserting the run produced nothing — a false
  // "no output" claim on a run that DID produce output is the worse error.
  if (evidence === null) {
    return {
      kind: "completed-with-output",
      outputs: [],
      outputRenderedBelow: false,
      evidenceIndeterminate: true,
    };
  }
  if (evidence.outputs.length > 0) {
    return {
      kind: "completed-with-output",
      outputs: evidence.outputs,
      outputRenderedBelow: false,
      evidenceIndeterminate: false,
    };
  }
  // Ordered BEFORE the indeterminate branches on purpose: transcript/step
  // evidence is positively known, so "its output is below" is a TRUE statement
  // even if the object read separately came back unusable.
  if (evidence.hasTranscript || evidence.hasStepResults) {
    return {
      kind: "completed-with-output",
      outputs: [],
      outputRenderedBelow: true,
      evidenceIndeterminate: false,
    };
  }
  // Either the produced-output read failed, or it succeeded but every row it
  // found is unlinkable. In both cases an empty `outputs` proves nothing, so
  // stay conservative rather than assert the run produced nothing — and mark
  // the state indeterminate so the card does not point at output it cannot
  // vouch for.
  if (evidence.outputsUnavailable || evidence.unlinkableOutputs) {
    return {
      kind: "completed-with-output",
      outputs: [],
      outputRenderedBelow: false,
      evidenceIndeterminate: true,
    };
  }
  return { kind: "completed-no-output" };
}

/**
 * Derive a display title for a produced output object.
 *
 * `objects.data` is free-form JSONB; the library surface uses `title` and falls
 * back to the id. Accept the handful of keys the artifact writers actually use,
 * then degrade to `<type> <short-id>` so a link is never blank.
 */
export function deriveProducedOutputTitle(input: {
  data: unknown;
  type: string;
  id: string;
}): string {
  const data = input.data;
  if (data !== null && typeof data === "object") {
    const bag = data as Record<string, unknown>;
    for (const key of ["title", "name", "headline", "subject"]) {
      const value = bag[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
  }
  const shortId = input.id.length > 8 ? input.id.slice(0, 8) : input.id;
  return `${input.type} ${shortId}`;
}

// ---------------------------------------------------------------------------
// THE REPORT A START ANSWERS WITH (cinatra#2935, lifecycle-b W5d).
// ---------------------------------------------------------------------------
// From the plan (PLAN: Agents Lifecycle (B), "The card is the visible truth"):
//
//   "The assistant's line reports what came back and adds nothing. Where the
//    sentence and the card could disagree, the card is right."
//
// THAT RULE PRESUPPOSES THERE IS SOMETHING TO SAY BACK, and until this change
// there was not. A start answered with machine fields alone — a run id and a
// status — so an assistant told to report the answer and add nothing to it had
// only the envelope to report, and inside a third-party application that is
// exactly what a reader was shown: the tool result, printed. The same model on
// the same call relayed the REFUSAL as a sentence, because a refusal already
// answered with one. The difference was never the host and never the model; it
// was whether the platform's answer carried a sentence.
//
// SO THE PLATFORM WRITES IT, HERE, ONCE, and both doors onto the start road
// carry the same bytes: `agent_run`, which the conversation's assistant calls,
// and the site widget's `agent_named_start`, which relays this primitive's
// answer through its own narrower door. One wording, wherever it appears.
//
// CHOSEN BY THE STATUS THE START ANSWERED — never by anything a caller said, and
// never derived — so the two clauses cannot both be true of one turn: a run that
// parked is described as parked, a run that did not is described as running.
//
// EVENT TENSE, deliberately, in BOTH clauses: this line is persisted with the
// turn and re-read long after the card beside it has settled, while the run it
// names goes on changing under both of them.
// "The run paused" and "The run started" record what happened; "the run is
// paused" or "the agent is running" would keep asserting a state that stopped
// being true the moment somebody decided, or the moment the run finished.
//
// IT NAMES THE RUN. The card carries the run's own link, but the line is what
// makes the turn readable beside it — and a turn that never names the run it
// started cannot be read back later without the card.
// ---------------------------------------------------------------------------

/**
 * THE ONE REPLY RULE A START ANSWERS WITH — the same bytes on every door.
 *
 * From the plan (PLAN: Agents Lifecycle (B), "The card is the visible truth"):
 *
 *   "After the action fires, the card re-reads its state from the server and
 *    settles in place. The assistant's line reports what came back and adds
 *    nothing. Where the sentence and the card could disagree, the card is
 *    right."
 *
 * IT IS ONE RULE, AND THAT IS THE WHOLE POINT. `agent_run`'s description used to
 * carry two: say the platform's sentence back exactly, AND follow the start with
 * `agent_run_get` polling until a terminal status. In the turns the final W5d
 * pictures caught, the second one is what the model did: the widget's door, which
 * carried the reply rule ALONE, relayed the platform's sentence word for word on
 * every capture, while the chat host, whose door carried both, polled the run and
 * then wrote prose of its own about what it had found. Same platform, same
 * sentence on the wire, two sets of instructions, two answers. That is an
 * observation about what happened, not a law about models — and it is enough:
 * one rule cannot lose to a second rule that is not there.
 *
 * SO THE PROGRESS IS THE CARD'S JOB, SAID OUTRIGHT. The card re-reads the run and
 * settles in place; a model chasing the same run in the same turn can only
 * produce a second, staler account of it beside the card that is right. The read
 * primitive is still there for a person who asks how a run is doing — what is
 * gone is the ORDER to call it after a start.
 *
 * IT LIVES BESIDE THE SENTENCE IT GOVERNS, in this leaf that imports nothing, so
 * the primitive's own schema and the widget's narrower door can both carry the
 * identical bytes without either pulling a graph.
 */
export const RUN_START_REPLY_RULE =
  "The run's own card in the conversation re-reads the run's state and shows its progress, " +
  "so do not poll the run after a start and do not describe its progress yourself. " +
  "The answer carries `message` — the platform's own sentence about what happened — and that " +
  "sentence is your reply: say it back exactly as it is written, add nothing to it, and never " +
  "print the answer itself. When it refuses, relay the refusal the same way and do not try " +
  "another way.";

/** The clause for a start that parked on its recommendation checkpoint. */
export const RUN_START_PARKED_CLAUSE =
  "The run paused for a decision on the recommended skills.";

/**
 * The clause for a start that did not park.
 *
 * IT REPORTS THE EVENT, NOT A STATE, and that is what makes it safe to say
 * back later. "The agent is running" is a claim about NOW: the answer names a
 * status the moment the start returned, the card beside the line goes on
 * re-reading the run after the turn is written, and a run can also come back
 * already settled when a concurrent writer won the dispatch. Any of those makes
 * a present-tense claim false by the time a person reads it. "The run started"
 * is true from the moment it happens and stays true; the status the answer
 * actually named is in the sentence beside it, which is where a reader who
 * wants the state should get it.
 */
export const RUN_START_STARTED_CLAUSE = "The run started.";

/**
 * The platform's own report for a started run — the sentence the assistant says
 * back, on every host.
 *
 * PURE, and deliberately in this leaf: the report is chosen by the run status
 * whose vocabulary lives here, and this module imports nothing, so the sentence
 * can be read by a test, by the primitive that mints it and by the surfaces that
 * pin it without any of them pulling a graph.
 */
export function describeStartedRun(input: {
  packageName: string;
  runId: string;
  status: string;
}): string {
  const clause =
    input.status === "pending_input" ? RUN_START_PARKED_CLAUSE : RUN_START_STARTED_CLAUSE;
  return (
    `Dispatched \`${input.packageName}\` (runId: \`${input.runId}\`, ` +
    `status: \`${input.status}\`). ${clause}`
  );
}
