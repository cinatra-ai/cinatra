/**
 * Terminal-run outcome resolution (cinatra#2482).
 *
 * A `completed` run used to render NOTHING actionable on the canonical run
 * view: `OrchestratorStepperPanel` set `stageCard = null` for every terminal
 * status that was not `failed`/`stopped`, and `AgenticRunPanel` fell through to
 * a bare "No messages yet." — so the immediate-trigger flow ("Run right after
 * setup" → Continue) landed the user on a frozen stepper with all steps marked
 * complete, no output, and no way forward.
 *
 * This module is the PURE half of the fix: given the run's terminal status and
 * the evidence the run actually left behind, it names which of the three states
 * the issue's acceptance criteria enumerate applies —
 *
 *   1. still progressing        → `not-terminal` (the spinner/gate cards own it)
 *   2. produced output          → `completed-with-output` (link the outputs, or
 *                                 point at the transcript rendered below)
 *   3. terminated with nothing  → `completed-no-output` (say so, offer the next
 *                                 action)
 *
 * No React, no I/O — the decision is unit-testable on its own, and the card
 * (`run-completion-card.tsx`) only renders what this returns.
 */

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
    return { kind: "completed-with-output", outputs: [], outputRenderedBelow: true };
  }
  if (evidence.outputs.length > 0) {
    return {
      kind: "completed-with-output",
      outputs: evidence.outputs,
      outputRenderedBelow: false,
    };
  }
  if (evidence.hasTranscript || evidence.hasStepResults) {
    return { kind: "completed-with-output", outputs: [], outputRenderedBelow: true };
  }
  // The produced-output read failed, so an empty `outputs` proves nothing.
  // Stay conservative rather than assert the run produced nothing.
  if (evidence.outputsUnavailable) {
    return { kind: "completed-with-output", outputs: [], outputRenderedBelow: true };
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
