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

/**
 * The run statuses a run holds BEFORE it has ever run (cinatra#2788, S9d).
 *
 * `armed` and `pending_trigger` are the schedule's own states — the trigger is
 * set and the agent is waiting for it — and `pending_input` is the setup that
 * precedes both. None of them can carry an execution record, so none of them
 * has run progress to show.
 *
 * Lives here beside `TERMINAL_RUN_STATUSES`, the other run-status set, so the
 * screens that ask the question and the tests that pin the answer can both read
 * it without importing a screen's whole module graph.
 */
export const PRE_EXECUTION_RUN_STATUSES: ReadonlySet<string> = new Set<AgentRunStatus>([
  "pending_input",
  "pending_trigger",
  "armed",
]);


/**
 * HAS THIS RUN STARTED RUNNING? (cinatra#3047, review point 1.)
 *
 * The ONE place the boundary is expressed, so the resolver that publishes it,
 * the screen that reads it, the store's own guarded write and the suite that
 * pins it cannot answer it four ways. A run in one of the pre-execution statuses
 * above has not begun executing — it is at its setup, at its schedule, or at any
 * other pre-start moment — and every other status means it has. The FIRST status
 * on the far side is `queued`, which is the dispatch CAS itself
 * (`pending_input->queued`, `armed->queued`).
 *
 * `pending_trigger` IS PRE-START ON BOTH OF ITS ENTRY EDGES, and the objection is
 * worth answering rather than leaving to be discovered. The state is reached from
 * `pending_input` (the reader opened the trigger form) AND from `queued`
 * (`execution.ts`: setup finished with no trigger chosen yet), so a
 * `pending_trigger` run may have been `queued` before. It still has not
 * EXECUTED: it leaves this state for execution through `pending_trigger->queued`
 * ("the user chose Run right after setup"), and the work itself begins at the
 * `queued->running` dispatch CAS after that. The trigger step is therefore a
 * pre-start moment however it was reached, which is exactly what this set has
 * always claimed of it - "none of them can carry an execution record".
 *
 * AN UNKNOWN OR ABSENT STATUS READS AS NOT STARTED, which is the decidable side.
 * That is deliberate and it is the same direction the rest of this reading takes:
 * the resolver's own `canDecide` derives FAIL-OPEN, and the authority that
 * actually decides is the decision path. Withholding an editable box from a
 * reader who may in fact still edit is a regression; showing one to a reader
 * whose run has moved on costs one honest refusal - and that refusal is real
 * rather than assumed: the selection write tests the run's status INSIDE its own
 * transaction and refuses a started run outright, so the screen being wrong
 * about the moment can never make the STORE wrong about it.
 */
export function recommendationRunHasStarted(status: string | null | undefined): boolean {
  if (typeof status !== "string" || status.length === 0) return false;
  return !PRE_EXECUTION_RUN_STATUSES.has(status);
}

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

/**
 * The HITL gate is no longer pending (cinatra#3219).
 *
 * `approveReviewTaskInternal` refuses an approval whose run has already left
 * `pending_approval` by the time the status is read. That refusal is an
 * EXPECTED race — someone pressed Continue in the small window where the run
 * had already moved on — and the run surface draws a ratified blocked state
 * for it, so it has to reach the caller as something the caller can act on.
 *
 * The carrier is `code` (and the observed `currentStatus`), never the message:
 * an ordinary error thrown by a Server Action crosses the App Router boundary
 * in production as a generic masked error carrying an opaque digest, so the
 * original text is not there to read. The boundary maps this class to a
 * returned discriminated result BEFORE the mask is applied.
 *
 * `message` is preserved verbatim from the throw site for logs and for the
 * non-Server-Action caller (the A2A resume route) that still reads it.
 */
export class GateNotPendingError extends Error {
  readonly code = "gate_not_pending" as const;
  readonly runId: string;
  /** The status the run was actually in when the guard read it. */
  readonly currentStatus: string;

  constructor(args: {
    runId: string;
    currentStatus: string;
    message: string;
  }) {
    super(args.message);
    this.name = "GateNotPendingError";
    this.runId = args.runId;
    this.currentStatus = args.currentStatus;
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
/**
 * DOES THIS RUN HAVE A TRANSCRIPT? (cinatra#3002)
 *
 * The one rule, in one place. A run page shows a transcript when the run
 * accumulated streamed text (the external-peer proxy path writes
 * `agent_runs.streamed_text`) or when `agent_run_messages` holds rows for it
 * (every other path, including the receipt a completed runtime-executed run
 * writes). `readRunOutputEvidence` reads the two facts from the database and
 * asks this; `deriveRunOutcome` below turns the answer into the reading the
 * completion card draws.
 *
 * It lives here, in the pure domain, because a test that proves the joined
 * path — a completed run writes its row, the card then names a transcript —
 * must apply the PRODUCT's rule rather than restate it (convergence finding).
 */
export function hasTranscriptEvidence(input: {
  streamedText: string | null | undefined;
  messageCount: number;
}): boolean {
  return (input.streamedText ?? "") !== "" || input.messageCount > 0;
}

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
       * WHICH evidence the outcome rests on (cinatra#3002).
       *
       * `hasTranscript` and `hasStepResults` are two independent facts, and this
       * resolver used to fold them into one boolean — so a run whose only record
       * of output was a step result was reported exactly like a run with a
       * transcript, and the card told the reader to look at a transcript that
       * was never written. The two hosts render DIFFERENT things (one draws the
       * message thread, the other keeps output behind the step rail), so the
       * caller has to know which fact it is holding before it names a place.
       *
       *   `outputs`      provenance-linked output objects (the card links them)
       *   `transcript`   message rows / accumulated streamed text exist
       *   `step-results` `agent_runs.step_results` only — recorded, but not the
       *                  transcript, and not every host can point at it
       *   `none`         nothing established (the read is in flight, failed, or
       *                  returned only unlinkable rows)
       */
      outputEvidence: "outputs" | "transcript" | "step-results" | "none";
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
      outputEvidence: "none",
      evidenceIndeterminate: true,
    };
  }
  if (evidence.outputs.length > 0) {
    return {
      kind: "completed-with-output",
      outputs: evidence.outputs,
      outputRenderedBelow: false,
      outputEvidence: "outputs",
      evidenceIndeterminate: false,
    };
  }
  // Ordered BEFORE the indeterminate branches on purpose: transcript/step
  // evidence is positively known, so "its output is below" is a TRUE statement
  // even if the object read separately came back unusable.
  //
  // The two are reported SEPARATELY (cinatra#3002). A transcript is the thing
  // the transcript host renders; a step result is not, and a run executed on the
  // agent runtime leaves exactly one. Folding them into `outputRenderedBelow`
  // alone let the card name the transcript for a run that never wrote one.
  // Transcript first: it is the stronger claim, and a run holding both is a run
  // whose text IS below.
  if (evidence.hasTranscript) {
    return {
      kind: "completed-with-output",
      outputs: [],
      outputRenderedBelow: true,
      outputEvidence: "transcript",
      evidenceIndeterminate: false,
    };
  }
  if (evidence.hasStepResults) {
    return {
      kind: "completed-with-output",
      outputs: [],
      outputRenderedBelow: true,
      outputEvidence: "step-results",
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
      outputEvidence: "none",
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
// EVENT TENSE WHERE THERE IS AN EVENT: this line is persisted with the turn and
// re-read long after the card beside it has settled, while the run it names goes
// on changing under it.
// "The run paused" and "The run started" record what happened; "the agent is
// running" would keep asserting a state that stopped being true the moment the
// run finished.
// A status that has NOT run has no event to record, and that is the one case
// where a state reading is the honest one (cinatra#3147): the line names the
// state the answer carried, the status it names is printed in the same
// sentence, and the card beside it is what a reader follows from there. What is
// never allowed is the reverse of both — an event sentence for a run that has
// not had the event.
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
 * The clause for a start whose run is waiting for its schedule (cinatra#3044).
 *
 * THE TURN THAT INTRODUCES THE CARD MAY NOT CONTRADICT IT. A run that reaches
 * its schedule moment has not started: it stands at a card that is still asking
 * "When should this run?", and a line above that card reading "The run started."
 * — with a status token of `queued` beside it — is the one reading in the turn
 * that is false. This clause says what is true of the run AND points at the
 * thing that decides it, which is the card itself: where the sentence and the
 * card could disagree, the card is right, so the sentence defers to it in words.
 *
 * IT STAYS TRUE FOR THE WHOLE WAIT. The wait does not end at Confirm — a
 * confirmed schedule is armed, not started — so the same clause is correct
 * while the card is pending and after it has settled, and the turn does not
 * change its wording underneath a person who is reading it.
 */
export const RUN_START_SCHEDULE_WAIT_CLAUSE =
  "The run has not started: it is waiting for its schedule, and the card in " +
  "this conversation is where that schedule is decided.";

/**
 * Is this reading of a run one of a run WAITING FOR ITS SCHEDULE?
 *
 * ONE definition, so the sentence the start mints and the correction the
 * conversation applies cannot disagree about which runs are waiting. The
 * moment must be the schedule's own, and the run must be in one of the statuses
 * it holds before it has ever run (`PRE_EXECUTION_RUN_STATUSES` above) — which
 * is what keeps a `pending_trigger` reached for another reason, and a run that
 * has moved on past its schedule, out of it.
 */
export function runIsWaitingForItsSchedule(reading: {
  status: string | null | undefined;
  moment: string | null | undefined;
}): boolean {
  return (
    reading.moment === "schedule" &&
    typeof reading.status === "string" &&
    PRE_EXECUTION_RUN_STATUSES.has(reading.status)
  );
}

/**
 * The clause for a start whose run was enqueued and has not been picked up.
 *
 * `queued` is pre-dispatch: the job is on the queue and no worker has taken it
 * yet. The line is composed at that instant and said back without a read of the
 * run, so "The run started." was a claim about something that had not happened.
 * This says the two things that ARE true then — the run is on the queue, and
 * nobody has to do anything more for it to run — so a reader is neither misled
 * nor left wondering whether the start needs chasing.
 */
export const RUN_START_QUEUED_CLAUSE = "The run is queued and will start on its own.";

/**
 * The clause for a start that landed on a human decision before running.
 *
 * `pending_approval` has TWO producers in the transition table above —
 * `queued->pending_approval` (the setup interrupt, nothing has executed) and
 * `running->pending_approval` (an interrupt raised mid-flight) — and a start
 * answer can carry either, because the lost-dispatch-race branch re-reads
 * whatever state the winning writer left. So this clause says only what is
 * true of BOTH: a decision is outstanding. It does not claim the run has yet
 * to start, and it does not name who may make the decision — standing is the
 * approval surface's own answer, not this sentence's.
 */
export const RUN_START_AWAITING_APPROVAL_CLAUSE = "The run is waiting for an approval.";

/**
 * The clause for a start held by a trigger that IS set — `armed`.
 *
 * `armed` is the one status where a trigger has actually been established
 * (`pending_trigger->armed` is its only producer besides `pending_input->armed`,
 * both of them a submitted trigger), and the release job is what moves it on.
 * Deliberately GENERIC about WHICH trigger: the schedule's own moment-specific
 * wording is a separate concern layered above this choice, and this clause has
 * to stay true of every trigger a run can wait on rather than describe one of
 * them.
 */
export const RUN_START_AWAITING_TRIGGER_CLAUSE =
  "The run is waiting for its trigger and has not started.";

/**
 * The clause for a start sitting in the trigger FORM — `pending_trigger`.
 *
 * Not the same state as `armed`, and this is why it cannot share its sentence:
 * `pending_trigger` means the trigger step is open and awaiting the person's
 * choice (see its own comment on the status union above), so no trigger exists
 * yet for the run to be waiting on. Saying it were "waiting for its trigger"
 * would hand a reader the same shape of untruth this whole block answers —
 * a sentence describing a thing that has not happened.
 */
export const RUN_START_TRIGGER_NOT_SET_CLAUSE =
  "The run has not started: its trigger is not set yet.";

/**
 * The clauses for a start that answered with a TERMINAL status.
 *
 * A start answer reaches these only through the lost-dispatch-race branch,
 * which re-reads the row a concurrent writer settled — and `failed` and
 * `stopped` are both reachable WITHOUT the run ever executing
 * (`queued->failed`, `pending_input->failed`, `armed->failed`,
 * `pending_trigger->failed`, and the matching `->stopped` cancel edges). So
 * neither may say "The run started."; each reports the outcome the status
 * names, which is true whether or not there was an execution. `completed` is
 * the terminal status that DOES imply one, and it keeps the started clause.
 */
export const RUN_START_FAILED_CLAUSE = "The run ended in failure.";
export const RUN_START_STOPPED_CLAUSE = "The run was stopped.";

/**
 * The floor for a status outside the vocabulary entirely.
 *
 * `describeStartedRun` takes `status: string` because the value crosses a wire,
 * so a string the union does not name can still arrive. It falls here rather
 * than back to `RUN_START_STARTED_CLAUSE` — the defect this whole block answers
 * was exactly a fallback that claimed a start for statuses nobody had
 * considered — and this clause errs the safe way, toward the card, which the
 * plan makes right wherever the two could disagree. A status ADDED to
 * `AgentRunStatus` never reaches this line: the clause table below is
 * exhaustive and will not compile without it.
 */
export const RUN_START_NOT_STARTED_CLAUSE = "The run has not started yet.";

/**
 * The clause EVERY run status is described with — one entry per status, and
 * exhaustive by the type checker.
 *
 * TYPED `Record<AgentRunStatus, string>` ON PURPOSE. The defect this block
 * answers was a fallback: a status nobody had considered fell through to a
 * sentence claiming a start. A lookup table keyed by `string` with a default
 * would have rebuilt exactly that, one status later. Here a status added to
 * `AgentRunStatus` fails to compile until somebody writes what is true of it,
 * which is the only guarantee that scales past this change.
 *
 * READ BY THE STATUS ALONE, so the sentence a person is handed cannot disagree
 * with the status printed beside it in the same line. Note this table is NOT
 * `PRE_EXECUTION_RUN_STATUSES`: that set answers a different question (which
 * statuses can never carry an execution record) and is deliberately not
 * consulted here.
 */
const RUN_START_CLAUSES: Readonly<Record<AgentRunStatus, string>> = {
  queued: RUN_START_QUEUED_CLAUSE,
  pending_input: RUN_START_PARKED_CLAUSE,
  pending_approval: RUN_START_AWAITING_APPROVAL_CLAUSE,
  pending_trigger: RUN_START_TRIGGER_NOT_SET_CLAUSE,
  armed: RUN_START_AWAITING_TRIGGER_CLAUSE,
  // These three DID start: `running` by definition, `waiting_trigger` only ever
  // from `running` (its single producer in the table above), and `completed`
  // only from `running` or a WayFlow resume that executed.
  running: RUN_START_STARTED_CLAUSE,
  waiting_trigger: RUN_START_STARTED_CLAUSE,
  completed: RUN_START_STARTED_CLAUSE,
  failed: RUN_START_FAILED_CLAUSE,
  stopped: RUN_START_STOPPED_CLAUSE,
};

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
  /**
   * The lifecycle moment the run stands at, where the caller already knows it.
   * Absent means "not known here", which is the ordinary dispatch case: the
   * schedule moment opens later, and the turn's own correction below is what
   * reconciles the sentence with the card when it does.
   */
  moment?: string | null;
}): string {
  // THE SENTENCE MAY NOT OUTRANK THE CARD BENEATH IT. A run waiting for its
  // schedule has not started and is not queued, so neither word is said and
  // the status token — the one that read `queued` over a card still asking
  // "When should this run?" — is not printed at all.
  if (runIsWaitingForItsSchedule({ status: input.status, moment: input.moment ?? null })) {
    return (
      `Dispatched \`${input.packageName}\` (runId: \`${input.runId}\`). ` +
      RUN_START_SCHEDULE_WAIT_CLAUSE
    );
  }
  // The status decides, and every status the vocabulary knows has its own
  // sentence — no status falls through to another status's claim. `status` is
  // widened to `string` on this boundary (the answer crosses a wire), so a
  // value outside the vocabulary lands on the floor rather than on a start it
  // cannot vouch for: the sentence still prints the status the answer named,
  // and the card beside the line is right where the two could disagree.
  const clause = RUN_START_CLAUSES[input.status as AgentRunStatus] ?? RUN_START_NOT_STARTED_CLAUSE;
  return (
    `Dispatched \`${input.packageName}\` (runId: \`${input.runId}\`, ` +
    `status: \`${input.status}\`). ${clause}`
  );
}

/**
 * THE LINE THE RATIFIED DRAWING PUTS OVER A FIRED ONE-OFF'S READING
 * (cinatra#3044).
 *
 * Section VI's fifth reading gives the card its own words, and its example
 * draws them as the assistant's whole line above the read-only rows:
 *
 *   "It ran at the time you set. A one-time schedule is spent once it fires, so
 *    the rows below are the record of it and cannot be changed."
 *
 * IT REPLACES THE PLATFORM'S SENTENCE RATHER THAN CLAUSING IT. Every other
 * correction in this module swaps the CLAUSE after a head that names the
 * package and the run, because in each of those readings the run is still the
 * subject: it is queued, waiting, parked. Over a spent one-off the subject is
 * the schedule, and the drawing writes it as one standing sentence with no
 * dispatch head at all -- so the head goes with the clause. A line that kept
 * "Dispatched `pkg` (runId: `...`, status: `queued`)." over a schedule that has
 * already run would be the same untruth this module exists to answer, said in
 * the tense the drawing explicitly retires.
 *
 * ONLY A ONE-OFF EVER REACHES IT. "Only a one-off -- Run right after setup or
 * Schedule for later -- reaches this reading. A recurring schedule is never
 * spent by firing." The decision is not taken here: this leaf is pure and the
 * one thing that knows a schedule was spent is the CARD's own resolved reading,
 * which is what asks for this sentence.
 */
export const RUN_START_SCHEDULE_FIRED_SENTENCE =
  "It ran at the time you set. A one-time schedule is spent once it fires, " +
  "so the rows below are the record of it and cannot be changed.";

/** Regex-escape a literal. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * THE PLATFORM'S OWN SENTENCE FOR ONE RUN, as a pattern.
 *
 * EVERY CLAUSE THIS MODULE MINTS, and nothing else. The set is read off the
 * status table itself rather than listed by hand, so a status given its own
 * sentence is correctable the day it is added: a platform sentence a corrector
 * does not recognise is a sentence left claiming a tense the run's row does not
 * support, which is the whole defect these functions answer, and a hand-kept
 * list is how one gets missed.
 *
 * THE CORRECTED CLAUSES ARE IN THE SET TOO, which is what makes the corrections
 * idempotent: a turn that has already been corrected matches WHOLE and is
 * replaced by the identical bytes, rather than matching its head and growing a
 * second clause.
 *
 * LONGEST FIRST. Alternation is ordered, and three of these clauses share the
 * head "The run has not started"; a shorter one placed first would match that
 * head and leave the rest of a longer clause standing beside the replacement.
 *
 * ONE definition, so the two corrections below cannot come to disagree about
 * which sentences are the platform's to rewrite.
 */
function platformStartSentencePattern(runId: string): RegExp {
  const clauses = [
    ...new Set([
      ...Object.values(RUN_START_CLAUSES),
      RUN_START_NOT_STARTED_CLAUSE,
      RUN_START_PARKED_CLAUSE,
      RUN_START_SCHEDULE_WAIT_CLAUSE,
    ]),
  ]
    .sort((a, b) => b.length - a.length)
    .map(escapeLiteral)
    .join("|");
  return new RegExp(
    "Dispatched\\s+`([^`\\n]+)`\\s+\\(runId:\\s*`" +
      escapeLiteral(runId) +
      "`(?:,\\s*status:\\s*`[^`\\n]*`)?\\)\\.(?:[ \\t]*(" +
      clauses +
      "))?",
    "g",
  );
}

/**
 * Rewrite the platform's own start sentence for ONE run, wherever it stands in
 * a turn's text, and leave everything else byte-identical.
 *
 * A CLAUSE-LESS SENTENCE IS ONLY THE PLATFORM'S WHEN IT STANDS ALONE. One door
 * mints the head with no clause after it, and that door writes the sentence as
 * the whole line. The same characters INSIDE prose are a quotation of the line,
 * not the line, and a corrector that rewrote a quotation would be a second
 * author of the turn -- so a clause-less match is taken only when nothing but
 * whitespace shares its line.
 */
function rewritePlatformStartSentence(input: {
  text: string;
  runId: string;
  replace: (packageName: string) => string;
}): string {
  return input.text.replace(
    platformStartSentencePattern(input.runId),
    (
      match: string,
      packageName: string,
      clause: string | undefined,
      offset: number,
    ) => {
      if (clause === undefined) {
        const before = input.text.slice(0, offset);
        const after = input.text.slice(offset + match.length);
        const ownsTheLine = /(?:^|\n)[ \t]*$/.test(before) && /^[ \t]*(?:\n|$)/.test(after);
        if (!ownsTheLine) return match;
      }
      return input.replace(packageName);
    },
  );
}

/**
 * THE SENTENCE THE PLATFORM ALREADY MINTED, CORRECTED AT THE CARD
 * (cinatra#3044).
 *
 * WHY A CORRECTION AND NOT A BETTER CHOICE AT THE START. The start answers the
 * instant the run is dispatched, and the schedule moment opens later — after
 * the setup card's own Continue, in the executor. The sentence is frozen into
 * the turn before the park exists, so no clause chosen at that instant can know
 * about it. What the conversation CAN know, at the moment it draws the card, is
 * that this very run is standing at its schedule moment; so the turn's line is
 * re-read against the run's own row there, and a line that claims a tense the
 * row does not support is replaced with the one it does.
 *
 * NARROW BY CONSTRUCTION. It rewrites only the platform's OWN sentence, only
 * for the run named in it, and only where that sentence carries one of the
 * clauses this module mints. Prose the model wrote, another run's sentence, and
 * a sentence already corrected are all returned untouched — a correction that
 * could reach arbitrary text would be a second author of the turn.
 *
 * PURE, and in this leaf, so the surface that draws the card and the primitive
 * that mints the sentence say the same words without either pulling a graph.
 */
export function correctRunStartSentenceForScheduleWait(input: {
  text: string;
  runId: string;
}): string {
  return rewritePlatformStartSentence({
    text: input.text,
    runId: input.runId,
    replace: (packageName) =>
      describeStartedRun({
        packageName,
        runId: input.runId,
        status: "pending_trigger",
        moment: "schedule",
      }),
  });
}

/**
 * THE SAME SENTENCE, OVER A ONE-OFF THAT HAS ALREADY FIRED (cinatra#3044).
 *
 * The wait correction above answers a run standing AT its schedule. This one
 * answers the reading after it: the one-off fired, the run moved on, and the
 * card beneath the line settled into the record of a schedule that is spent.
 * The line frozen into the turn at dispatch still said the run was queued and
 * would start on its own, which is now false in both halves — it has started,
 * and nothing is waiting to start it.
 *
 * IT IS THE DRAWING'S SENTENCE, WHOLE. See
 * `RUN_START_SCHEDULE_FIRED_SENTENCE` for why the dispatch head goes with the
 * clause rather than staying above it.
 *
 * IDEMPOTENT AND NARROW, on exactly the same terms as the wait correction: the
 * replacement carries no dispatch head, so a corrected line no longer matches
 * the platform's own pattern and a second pass changes nothing at all.
 *
 * THE TWO CORRECTIONS CANNOT BOTH APPLY TO ONE RUN. A run is either standing at
 * its schedule or past it, and the container that reports these two answers
 * reads both off the same reading — so whichever runs first, the other finds no
 * platform sentence left for that run to rewrite.
 */
export function correctRunStartSentenceForFiredSchedule(input: {
  text: string;
  runId: string;
}): string {
  return rewritePlatformStartSentence({
    text: input.text,
    runId: input.runId,
    replace: () => RUN_START_SCHEDULE_FIRED_SENTENCE,
  });
}
