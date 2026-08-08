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
