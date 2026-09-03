// ---------------------------------------------------------------------------
// THE ENTRY THE RUN IS PARKED ON (cinatra#3221).
//
// The ratified drawing, agent run and review surface, "The step rail — merged
// steps and gate entries": "The step the run is paused on is highlighted; steps
// already passed sit above it, steps still to come below" — "so the rail is the
// run's whole lifecycle at a glance, not just its live tip."
//
// The run page's live rail elects its highlighted entry from ONE number, the
// stepper's `value`, and every row — the template spine's rows and the trailing
// rows a gate arrives on — is capable of taking it. The number used to be
// derived from the run's status and the live interrupt's spine step alone, so
// a gate that arrives as a TRAILING entry (a context-selection gate, a review
// gate past the spine) was never its target: with no spine step number the
// election fell through to the first row, with `awaitingNextStep` it pointed
// one past the row the run was parked on, and a finished run pointed one past
// the spine — which is the FIRST trailing row. On a gate reading nothing
// highlighted; on a finished rail the wrong thing could.
//
// This is the whole election, pure, so the rail's one number can be read
// against the drawing's sentence without mounting the panel.
// ---------------------------------------------------------------------------

/** A spine row: its display index and the policy step number it stands for. */
export type RailSpineStep = { index: number; stepNumber: number };

/** A trailing row: only its status matters to the election. */
export type RailTrailingEntry = { status: string };

export type RailActiveStepInput = {
  /** The run's live status. */
  status: string;
  /** The live interrupt's policy step number, or null when it carries none. */
  currentStepNumber: number | null;
  /** True between a Continue press and the next interrupt's arrival. */
  awaitingNextStep: boolean;
  /** The highest policy step number the stream has reported so far. */
  highestStepNumber: number;
  /** The template spine, in display order. */
  spine: ReadonlyArray<RailSpineStep>;
  /** The trailing rows, in the order the rail draws them after the spine. */
  railExtras: ReadonlyArray<RailTrailingEntry>;
};

/**
 * The display index of the entry the run is parked on — the stepper's `value`.
 *
 * Display indices are 1-based: the spine takes `1..spine.length` and the
 * trailing rows continue from `spine.length + 1`, exactly as the rail numbers
 * them. A number past every row highlights nothing.
 */
export function electRunRailActiveStep(input: RailActiveStepInput): number {
  const { status, currentStepNumber, awaitingNextStep, highestStepNumber, spine, railExtras } = input;
  const spineLength = spine.length;
  const pastTheEnd = spineLength + railExtras.length + 1;
  const toDisplayIndex = (policyStepNumber: number): number =>
    spine.find((s) => s.stepNumber === policyStepNumber)?.index ?? policyStepNumber;
  const onSpine = (policyStepNumber: number): boolean =>
    spine.some((s) => s.stepNumber === policyStepNumber);

  // THE PARKED TRAILING ROW: the first trailing entry still pending is the gate
  // the run is waiting on, and its display index is its own.
  const parkedTrailingIndex = railExtras.findIndex((entry) => entry.status === "pending");
  const parkedTrailingStep = parkedTrailingIndex === -1 ? null : spineLength + parkedTrailingIndex + 1;

  if (status === "pending_input" || status === "queued") return 1;

  if (status === "pending_approval") {
    // A gate that arrives ON the spine is the row the live interrupt names.
    if (currentStepNumber !== null && onSpine(currentStepNumber) && !awaitingNextStep) {
      return toDisplayIndex(currentStepNumber);
    }
    // A gate that arrives as a TRAILING entry is its own row — whether the
    // interrupt named no spine step, or the reader has already continued past
    // the spine step it did name.
    if (parkedTrailingStep !== null) return parkedTrailingStep;
    if (currentStepNumber !== null) {
      return awaitingNextStep ? toDisplayIndex(currentStepNumber) + 1 : toDisplayIndex(currentStepNumber);
    }
    return 1;
  }

  if (status === "running") {
    return toDisplayIndex(highestStepNumber || 0) + 1;
  }

  if (status === "completed" || status === "stopped") {
    // A gate reached on a stopped run is still where the run stands; a run
    // with nothing pending stands past EVERY row, spine and trailing alike.
    return parkedTrailingStep ?? pastTheEnd;
  }

  if (status === "failed") {
    // Show the step that was active when the run failed, not "all done".
    return toDisplayIndex(highestStepNumber) || 1;
  }

  return 1;
}
