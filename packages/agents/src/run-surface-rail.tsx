"use client";

// ---------------------------------------------------------------------------
// THE RUN SURFACE'S TWO-COLUMN FRAME (cinatra#2790, epic #2784 S9f — the frame
// itself landed with cinatra#2788, S9d, and is lifted here so a SECOND gate step
// can stand in the same rail rather than grow a second frame beside it).
//
// The ratified drawing (`design-run-surface-rail-and-gate.png`): "The surface is
// a two-column frame: a step rail down the left names the run's ordered steps,
// and the run detail on the right shows the selected step … Selecting a step
// opens it on the right … a gate step opens the gate's own surface in place —
// right here in the run detail, under the same rail, never as a standalone
// document."
//
// WHAT THIS FILE IS. Those two columns and the selection between them, and
// nothing else. The rows are drawn by the steps themselves (each gate step owns
// its own row, because each carries its own anchors), the run's remaining rows
// are the page's `rail`, and the run's own reading is the page's `detail`. This
// component never invents any of the three, and it never decides which step is
// open on first paint — the screen does, because only the screen knows whether
// the run has run and whether it is paused on a gate.
//
// WHY THE STEPS ARE A LIST. Plan (A) §6.2 puts the recommendation "at the
// trigger position, the top entry on the step rail, ahead of the work steps it
// would authorize", and §7.2 step 5 puts the schedule "above '1 Review'". A run
// can carry both, so the frame takes them in the order the screen lists them and
// the rail below renumbers around them (`stepOffset`) — one rail, one selection,
// one open surface at a time.
// ---------------------------------------------------------------------------

import {
  Fragment,
  createContext,
  useContext,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

/**
 * WHICH step the run detail is showing: one of the gate steps that head the
 * rail, or the run's own detail (its steps and their progress, the gate the
 * review page opened on).
 */
export type RunStepSelection = "recommendation" | "schedule" | "detail";

/** A gate step that heads the rail: its row, and the surface it opens onto. */
export type RunSurfaceRailStep = {
  /** The selection value this step answers to. */
  key: Exclude<RunStepSelection, "detail">;
  /** The rail ROW. Drawn inside the rail column, above the page's own rows. */
  row: ReactNode;
  /**
   * The step's own surface, drawn in the run detail while this step is open.
   *
   * NULLISH (`null` or `undefined`) means this step HAS no surface of its own,
   * and the run detail stays as the page composed it. `ReactNode` already admits
   * both, which is why the sentinel is stated as nullish rather than narrowed to
   * `null` — a narrower type here would be a claim the type system does not make.
   *
   * That is the settled recommendation on the branch whose panel draws the card
   * (cinatra#2790, S9f): the entry keeps its place on the rail as read-only
   * history, and the reading it would open onto is already inside the run detail
   * beside it. Handing it the card a second time would be a second mount of the
   * one renderer; handing it nothing is exactly right, and is why the run detail
   * FALLS BACK rather than emptying — without that fallback a row resolving to
   * what is already on screen would blank the column instead.
   *
   * Every OTHER step supplies a real surface, including the settled
   * recommendation on the branch the screen hosts.
   */
  surface: ReactNode;
};

const RunStepSelectionContext = createContext<{
  selected: RunStepSelection;
  select: (next: RunStepSelection) => void;
} | null>(null);

/**
 * The selection, for a rail row drawn by the rail BESIDE this frame.
 *
 * The review page's rail is its own component (`ReviewRunSteps`) and its Review
 * row has to be able to bring the review card back into the run detail after a
 * gate step was opened — "selecting a step opens it on the right" is the rail's
 * property, not any one row's. `null` when there is no gate step on the page at
 * all, which is how a rail keeps its inert shape unchanged for a run that has
 * none.
 */
export function useRunStepSelection() {
  return useContext(RunStepSelectionContext);
}

/**
 * THE ROW VOCABULARY, shared so the two gate rows cannot drift apart.
 *
 * The row is the shadcn <Button>, not a raw <button> — the design-system
 * boundary (eslint `no-restricted-syntax`) admits no raw control JSX outside the
 * vendored primitives. `ghost` plus the size/hover neutralisers is what keeps a
 * rail ROW looking like a rail row rather than a pill: no chrome at rest, no
 * muted fill while it is selected.
 */
export const RUN_SURFACE_RAIL_ROW_CLASS =
  "h-auto justify-start gap-2 rounded-control px-0 py-0.5 text-left whitespace-normal hover:bg-transparent hover:opacity-90 dark:hover:bg-transparent";

/**
 * The circle. `filled` carries the rail's own two states — the tokens
 * `StepperIndicator` gives an active or completed step, and the ones
 * `RunStepRailPanel` gives an inactive row — so a gate row reads as one of the
 * rail's rows and no second vocabulary is invented for it.
 */
export function runSurfaceRailIndicatorClass(filled: boolean) {
  return cn(
    "relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs",
    filled ? "bg-primary text-primary-foreground" : "bg-muted-foreground/40 text-background",
  );
}

/** The title, in the same two states the rail's own titles carry. */
export function runSurfaceRailTitleClass(selected: boolean) {
  return cn("text-sm font-medium", selected ? "text-foreground" : "text-muted-foreground");
}

export function RunSurfaceRail({
  steps,
  rail = null,
  detail = null,
  initialSelection,
}: {
  /** The gate steps heading the rail, in the order the plan puts them. */
  steps: readonly RunSurfaceRailStep[];
  /** The REST of the rail: the page's own step rows, drawn under the gate rows. */
  rail?: ReactNode;
  /** The run detail as the page composes it — shown when no gate step is open. */
  detail?: ReactNode;
  /**
   * The step open on first paint. The screen decides it, because only the screen
   * knows whether the agent has run and whether it is paused on a gate.
   */
  initialSelection: RunStepSelection;
}): ReactElement {
  const [selected, setSelected] = useState<RunStepSelection>(initialSelection);
  // THE SERVER'S ANSWER WINS WHEN IT CHANGES, and only then. The decision taken inside a gate step calls `router.refresh()`,
  // which re-renders the server tree WITHOUT remounting this client component —
  // so a selection kept only from the first paint would leave the reader parked
  // on the settled gate after deciding it, when "the run detail returns to what
  // the run page otherwise shows" is the whole point of the settled reading.
  //
  // Adjusted DURING render against the previous prop rather than in an effect:
  // that is React's own shape for state derived from props, and it means the
  // corrected surface paints in the same commit instead of flashing the stale
  // one. A re-render that does NOT change the server's answer leaves the
  // reader's own selection alone, which is what makes the rail's rows work.
  const [lastInitial, setLastInitial] = useState<RunStepSelection>(initialSelection);
  if (initialSelection !== lastInitial) {
    setLastInitial(initialSelection);
    setSelected(initialSelection);
  }
  const open = steps.find((step) => step.key === selected) ?? null;

  return (
    <RunStepSelectionContext.Provider value={{ selected, select: setSelected }}>
      {/* THE LEFT COLUMN — the rail. The gate rows, then the page's own rows. */}
      <div
        data-conformance-id="run-step-rail-column"
        data-run-step-rail-column=""
        className="flex shrink-0 flex-col gap-2 pt-1"
      >
        {steps.map((step) => (
          <Fragment key={step.key}>{step.row}</Fragment>
        ))}
        {rail}
      </div>

      {/* THE RIGHT COLUMN — the run detail, showing the selected step. */}
      <div
        data-conformance-id="run-detail-column"
        data-run-detail-column=""
        className="flex min-w-0 flex-1 flex-col gap-4"
      >
        {/* A step with no surface of its own keeps the run detail — see
            `RunSurfaceRailStep.surface`. `??` and not a truth test: a surface is
            a ReactNode, and a FALSY one that exists — `false`, `0`, `""` — is
            still the step's own and must not fall back. Nullish is the sentinel,
            which is what `??` tests and `ReactNode` admits. */}
        {open?.surface ?? detail}
      </div>
    </RunStepSelectionContext.Provider>
  );
}
