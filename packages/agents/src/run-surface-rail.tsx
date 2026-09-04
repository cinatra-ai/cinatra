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
// its own row, because each carries its own anchors) or, for a step whose row is
// nothing but a numeral and a word, by the shared `RunSurfaceRailRow` below; the
// run's remaining rows are the page's `rail`, and the run's own reading is the
// page's `detail`. This component never invents any of the three, and it never
// decides which step is open on first paint — the screen does, because only the
// screen knows whether the run has run and whether it is paused on a gate.
//
// WHY THE STEPS ARE A LIST. Plan (A) §6.2 puts the recommendation "at the
// trigger position, the top entry on the step rail, ahead of the work steps it
// would authorize", and §7.2 step 5 puts the schedule "above '1 Review'". A run
// can carry both, so the frame takes them in the order the screen lists them and
// the rail below renumbers around them (`stepOffset`) — one rail, one selection,
// one open surface at a time.
//
// A STEP WITH NOTHING TO OPEN IS NOT SELECTABLE (cinatra#2970).
// The setup run page let every row be opened, so a step the run had not reached
// opened an EMPTY run detail. cinatra#2970: "a step the run has not reached
// cannot be selected. Its row stays on the rail, muted, so the series is
// visible; clicking it does nothing; the scheduler stays open; the right column
// never shows an empty step surface." The frame is the one authority on that,
// because the frame is what changes the selection: `isRunSurfaceStepSelectable`
// below is asked before every selection AND for the first paint, so no row —
// however it is drawn, and by whichever module — can open an empty column.
// ---------------------------------------------------------------------------

import { Check, ClipboardCheck } from "lucide-react";
import {
  Fragment,
  createContext,
  useContext,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RUN_RAIL_MARK_CLASS } from "./run-step-rail-extra-entry";

// THE STEP AND WHETHER IT OPENS ARE NOT DECLARED HERE, for the same reason the
// labels are not: `instance-screens.tsx` is a SERVER component and it composes
// the setup run page's steps, so it has to evaluate the predicate. A
// non-component export of a `"use client"` module reaches the server graph as a
// client reference, and calling one is not calling the function
// (`instance-screens-client-boundary.test.ts`). One definition, in a module with
// no boundary to cross.
import {
  isRunSurfaceStepSelectable,
  resolveRunSurfaceSelection,
  runSurfaceNodeExists,
  runSurfaceStepDrawsGlyph,
  type RunStepSelection,
  type RunSurfaceRailStep,
  type RunSurfaceRailStepKey,
} from "./run-surface-rail-step";

// Re-exported as TYPES ONLY. The subpath consumers already import
// `RunStepSelection` from is this module (`schedule-rail-step.ts` re-exports it
// again for the review page), and a type crosses no boundary. The predicate is
// deliberately NOT re-exported: a server caller that reached it through here
// would be handed a client reference.
export type { RunStepSelection, RunSurfaceRailStep, RunSurfaceRailStepKey };

// THE RAIL'S LABELS ARE NOT DECLARED HERE. They live in
// `run-surface-rail-labels.ts`, a module carrying no directive, because the
// setup run page's SERVER component reads them: an export of THIS module reaches
// the server graph as a client reference, and dotting into a reference yields
// `undefined` rather than the label (cinatra#2970). Both sides import the same
// plain value instead. The components stay here — a component is exactly what
// the boundary is built to carry.

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
 * THE ROW VOCABULARY, shared so the rail's rows cannot drift apart.
 *
 * The row is the shadcn <Button>, not a raw <button> — the design-system
 * boundary (eslint `no-restricted-syntax`) admits no raw control JSX outside the
 * vendored primitives. `ghost` plus the size/hover neutralisers is what keeps a
 * rail ROW looking like a rail row rather than a pill: no chrome at rest, no
 * muted fill while it is selected.
 *
 * `border-0` IS THE DRAWING'S RHYTHM (cinatra#3188 item 2, forward + fix leg 1).
 * The drawing's rail is two boxes and the mark's own margin between them --
 * ".rail .step { ... padding: 2px 0; ... }" over the 24px circle is a 28px
 * entry, and ".rail .sep { ... margin: 4px 0 4px 11px; ... }" is the only
 * whitespace between two of them. The design-system Button draws a 1px
 * TRANSPARENT border on every side: invisible, and still in the box. It made
 * each row 30px and put an extra pixel of whitespace above and below every
 * mark -- the surplus the first proof round measured at 7.5px above and 6.5px
 * below the drawing's own 4px and 4px. Nothing about the row's padding was
 * wrong, so the fix is the box: the rail row carries no border, exactly as the
 * drawing's `.rail .step` carries none. THE ROW KEEPS ITS FOCUS INDICATOR --
 * the base's `focus-visible:ring-3` ring is what draws focus on this control,
 * and a 1px border that is transparent at rest never drew it.
 */
export const RUN_SURFACE_RAIL_ROW_CLASS =
  "h-auto justify-start gap-2 rounded-control border-0 px-0 py-0.5 text-left whitespace-normal hover:bg-transparent hover:opacity-90 dark:hover:bg-transparent";

/**
 * The same row, for one that cannot be opened: neither the hover affordance nor
 * the press animation of a row that does something (cinatra#2970).
 */
export const RUN_SURFACE_RAIL_ROW_CLOSED_CLASS =
  "h-auto justify-start gap-2 rounded-control border-0 px-0 py-0.5 text-left whitespace-normal hover:bg-transparent dark:hover:bg-transparent cursor-default hover:opacity-100 active:not-aria-[haspopup]:translate-y-0";

/**
 * The circle. `filled` carries the rail's own two states — the tokens
 * `StepperIndicator` gives an active or completed step, and the ones
 * `RunStepRailPanel` gives an inactive row — so a gate row reads as one of the
 * rail's rows and no second vocabulary is invented for it.
 *
 * A SETTLED ENTRY IS NEVER FILLED (cinatra#3188 item 1). The ratified drawing
 * names the settled entry and the upcoming entry in ONE rule — ".rail
 * .step.upcoming .glyph, .rail .step.settled .glyph { background:
 * rgba(92,103,121,0.4); color: var(--paper); }" — so the two circles take the
 * same muted ground, and the indigo fill is reserved for the entry the reader
 * is standing on. The rule is HELD HERE rather than at each row, because the
 * rail has three rows in three modules and a rule each of them had to
 * remember is a rule one of them would forget: pass the settled answer and the
 * circle cannot come out filled.
 */
/*
 * THE GROUND IS THE DESIGN SYSTEM'S OWN MUTED INK, AND THAT IS NAMED RATHER
 * THAN SILENTLY DIFFERENT (cinatra#3188, item 4 of the first proof round's
 * record).
 *
 * The drawing writes the ground as a literal -- "background:
 * rgba(92,103,121,0.4)" -- and the rail takes it from the token instead:
 * `bg-muted-foreground/40`, whose ink is the system's own muted `--muted`,
 * `#5a6477` = rgb(90,100,119). At four tenths the two compose one unit apart
 * per channel, which is the distance between a drawing that quotes a colour
 * and a page that owns one. THE TOKEN IS KEPT: a rail that hard-coded the
 * literal would be the one element on the page that stopped following the
 * theme, and the drawing's own rule reads the paper through `var(--paper)` for
 * exactly that reason. The one-unit gap is a named deviation, not a defect to
 * close.
 */
export function runSurfaceRailIndicatorClass(filled: boolean, settled = false) {
  return cn(
    "relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs",
    filled && !settled
      ? "bg-primary text-primary-foreground"
      : "bg-muted-foreground/40 text-background",
  );
}

// THE RUN PAGE'S OWN RAIL ROWS ARE NOT DECLARED HERE. The rows the run page
// draws through the vendored `Stepper` -- the panel rail's steps, the rows
// beside them and the live rail inside the orchestrator panel -- read the same
// drawing anatomy from `run-step-rail-extra-entry`, the module all three
// already import. Held here, that declaration pulled this frame into the module
// graph of four route-budgeted routes and the route-graph ratchet refused it.
/** The title, in the same two states the rail's own titles carry. */
export function runSurfaceRailTitleClass(selected: boolean) {
  return cn("text-sm font-medium", selected ? "text-foreground" : "text-muted-foreground");
}

/**
 * THE SKILLS ENTRY'S OWN GLYPH (cinatra#3047, the re-shoot's third defect).
 *
 * The ratified drawing at the capture contract's pin draws this entry with a
 * clipboard-check glyph while its question is open, where every other step of
 * the rail carries a numeral: the Skills step is the run's gate on what it may
 * use, not the run's Nth piece of work, and the drawing numbers the work alone
 * (`[glyph] Skills · 1 Fetch cohort · 2 Draft email`). The re-shoot photographed
 * a numeral "1" here, with the first work step pushed to "2".
 *
 * ONE AUTHOR. Two rows draw this entry — the run page's and the review page's
 * anchored `RecommendationRailStepRow`, and the setup run page's generic
 * `RunSurfaceRailRow` — and a glyph authored twice is a glyph for one of them to
 * miss, exactly as the label was before review point A. The conformance id is
 * what lets a capture measure "a glyph, and no numeral" without knowing which of
 * the two rows drew it.
 *
 * IT IS NOT DRAWN ON A SETTLED ROW, and that is the drawing's own rule rather
 * than a simplification: a resolved gate is the rail's read-only history row —
 * "the completed circle in place of the numeral" — and every settled
 * illustration draws the Skills entry with exactly the check the rail gives any
 * completed step. So this glyph belongs to the open question, and the check to
 * the answered one.
 */
export function RunSurfaceRailStepGlyph(): ReactElement {
  return (
    // THE ANCHOR IS THE SPAN, NOT THE ICON. A suite that stubs `lucide-react`
    // renders no icon element at all, and an anchor carried by the icon would
    // vanish with it — a capture and a suite would then be measuring different
    // things on the same row. The span is this component's own, so "a glyph and
    // no numeral" is readable wherever the row is drawn.
    <span
      aria-hidden="true"
      data-conformance-id="recommendation-rail-glyph"
      className="flex items-center justify-center"
    >
      <ClipboardCheck className="h-3 w-3" />
    </span>
  );
}

/**
 * ONE RAIL ROW, for a step whose row is a numeral and a word (cinatra#2970).
 *
 * The gate steps that carry their own anchors draw their own rows
 * (`ScheduleRailStepRow`, `RecommendationRailStepRow`); this is the row for a
 * step that carries none, built from the SAME three class helpers above so a
 * rail of both kinds is one rail rather than two vocabularies side by side.
 *
 * It reads the selection from the frame's own context exactly as those rows do,
 * so the frame stays the single authority on what can be opened: a press on a
 * closed row reaches `select`, which refuses it.
 *
 * AND IT DRAWS THE RESOLVED-GATE HISTORY ROW (cinatra#2975), because the rail
 * has exactly one row component and a reading only one of its rows could make is
 * not a reading of the rail. The ratified drawing: "A resolved gate stays on the
 * rail as read-only history — its entry keeps its place and records how it was
 * settled." That is the completed circle in place of the numeral and the title
 * unhighlighted — the same three class helpers, the same circle, one glyph
 * instead of one numeral. `RecommendationRailStepRow` has drawn it since
 * cinatra#2790; the setup run page's rows could not, so a run whose skills
 * question had just been answered came back to that page still numbered.
 */
export function RunSurfaceRailRow({
  selectionKey,
  label,
  displayStep,
  conformanceId,
  indicatorConformanceId,
  action,
  reached,
  settled = false,
  selectable = true,
  rowAttributes,
}: {
  /** The step this row selects. */
  selectionKey: Exclude<RunStepSelection, "detail">;
  label: string;
  /** The numeral the circle shows — the row's position among the rail's
   *  NUMBERED steps. `null` for a step the drawing draws with its own glyph
   *  instead (`runSurfaceStepDrawsGlyph`), which is how the Skills entry stops
   *  consuming a numeral the work steps would otherwise start after. */
  displayStep: number | null;
  /** The row's own conformance id, so a capture can address exactly this row. */
  conformanceId: string;
  /** The indicator's conformance id, where the caller measures the circle. */
  indicatorConformanceId?: string;
  /** The row's `data-action` — what pressing it does, in the walk's vocabulary.
   *  A row that cannot be opened is handed the name of THAT state instead, so a
   *  walk (or a suite) selecting `open-<key>-step` finds no element it cannot
   *  actually press. */
  action: string;
  /** Has the run reached this step? `undefined` states nothing — see
   *  `RunSurfaceRailStep.reached`. */
  reached?: boolean;
  /** Has this step's gate been ANSWERED? A settled row is the rail's read-only
   *  history row: the completed circle where the numeral was, and the title left
   *  unhighlighted because the surface is not on it. It changes neither what the
   *  row opens nor whether it can be opened — see `RunSurfaceRailStep.settled`. */
  settled?: boolean;
  /** Can this row be opened? A row that cannot is still DRAWN — the rail is the
   *  run's series of steps and hiding a row would hide the series — but it does
   *  not act: no click handler, `aria-disabled` so assistive technology is told
   *  what the muted tokens say, and no press animation. */
  selectable?: boolean;
  /** Anchors that belong to THIS row's own host, added verbatim. */
  rowAttributes?: Record<string, string>;
}): ReactElement {
  const selection = useRunStepSelection();
  const selected = selection?.selected === selectionKey;
  // The emphasised treatment is for the row the surface is actually on. A row
  // that cannot be opened never gets it — and neither does a row its page has
  // said the run has not reached.
  const emphasised = Boolean(selected) && selectable && reached !== false;
  return (
    <Button
      type="button"
      variant="ghost"
      data-run-surface-rail-step=""
      data-run-surface-rail-step-key={selectionKey}
      data-run-surface-rail-selected={selected ? "true" : "false"}
      data-run-surface-rail-reached={reached === undefined ? undefined : reached ? "true" : "false"}
      // Mirrors the gate rows' own `data-…-step-settled`, so one capture reads
      // the settled circle the same way on every rail it appears in.
      data-run-surface-rail-settled={settled ? "true" : "false"}
      data-conformance-id={conformanceId}
      data-action={action}
      aria-current={selected ? "step" : undefined}
      // `aria-disabled`, NOT the native `disabled`. Native `disabled` takes the
      // row out of the tab order, so keyboard focus could not reach the row —
      // and "its row stays on the rail, so the series is visible" is precisely
      // what cinatra#2970 keeps. `aria-disabled` leaves the row in the tab order
      // and announces it as unavailable when focus arrives on it.
      aria-disabled={selectable ? undefined : "true"}
      onClick={selectable ? () => selection?.select(selectionKey) : undefined}
      className={selectable ? RUN_SURFACE_RAIL_ROW_CLASS : RUN_SURFACE_RAIL_ROW_CLOSED_CLASS}
      {...rowAttributes}
    >
      <span
        data-conformance-id={indicatorConformanceId}
        // A settled circle takes the drawing's MUTED ground whether or not its
        // step is the open one (cinatra#3188 item 1) — the same ground the
        // entry still ahead takes, which is what makes the row read as history
        // rather than as the entry the reader is standing on. The check inside
        // it is what records that it was answered.
        className={runSurfaceRailIndicatorClass(emphasised, settled)}
      >
        {/* THREE READINGS, IN THE ORDER THE DRAWING RESOLVES THEM
            (cinatra#3047). A settled step is the completed circle — the rail's
            read-only history row, and the same check every completed step
            carries. An unsettled step that the drawing gives its own glyph
            draws the glyph. Everything else is the numeral it has always been.
            The glyph is asked for from the KEY rather than passed in, so a
            caller cannot give one row a numeral and another the glyph for the
            same step. */}
        {settled ? (
          <Check className="h-3 w-3" />
        ) : runSurfaceStepDrawsGlyph(selectionKey) ? (
          <RunSurfaceRailStepGlyph />
        ) : (
          displayStep
        )}
      </span>
      {/* THE TITLE IS NOT EMPHASISED BY THE SETTLING, only by the selection —
          "the completed circle in place of the numeral, the title
          unhighlighted". No status word is added beside it: the drawing shows
          none. */}
      <span className={runSurfaceRailTitleClass(emphasised)}>{label}</span>
    </Button>
  );
}

/**
 * THE MARK BETWEEN TWO ENTRIES (cinatra#3188 item 2).
 *
 * The ratified drawing's rail draws one of these between every pair of adjacent
 * entries, at its own measurements: ".rail .sep { width: 2px; height: 8px;
 * margin: 4px 0 4px 11px; border-radius: 1px; background: var(--line); }" —
 * 11px being the centre of the 24px circle the entries carry, so the marks and
 * the circles read as one line down the rail.
 *
 * It is a MARK, not an entry: nothing to read out and nothing to press, so it
 * is hidden from the accessibility tree.
 */
export function RunSurfaceRailSeparator(): ReactElement {
  return (
    <div
      aria-hidden="true"
      data-run-surface-rail-separator=""
      data-conformance-id="run-step-rail-separator"
      // ONE definition for both rails (cinatra#3225), declared with the rest
      // of the rail vocabulary in `run-step-rail-extra-entry`.
      className={RUN_RAIL_MARK_CLASS}
    />
  );
}

export function RunSurfaceRail({
  steps,
  rail = null,
  detail = null,
  initialSelection,
}: {
  /** The steps heading the rail, in the order the plan puts them. */
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
  const [selected, setSelected] = useState<RunStepSelection>(() =>
    resolveRunSurfaceSelection(steps, detail, initialSelection),
  );
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
    setSelected(resolveRunSurfaceSelection(steps, detail, initialSelection));
  }
  const open = steps.find((step) => step.key === selected) ?? null;

  // THE ONE PLACE A SELECTION CHANGES, so it is the one place that can refuse
  // one (cinatra#2970). A row drawn by any module reaches this; a key naming a
  // step that cannot be opened is dropped and the reader stays where they were,
  // which is "clicking it does nothing" written where it cannot be bypassed.
  const select = (next: RunStepSelection) => {
    if (resolveRunSurfaceSelection(steps, detail, next) !== next) return;
    setSelected(next);
  };

  return (
    <RunStepSelectionContext.Provider value={{ selected, select }}>
      {/* THE LEFT COLUMN — the rail. The gate rows, then the page's own rows,
          with the drawing's separator standing between adjacent entries.

          THE COLUMN ITSELF NO LONGER SPACES THE ROWS (cinatra#3188 item 2). The
          drawing puts the whole gap between two entries INSIDE the mark — 4px
          above it and 4px below — so a column gap on top of that would space
          the rail at three times the drawing's rhythm. The rows keep their own
          2px of padding, exactly as the drawing's `.rail .step` does. */}
      <div
        data-conformance-id="run-step-rail-column"
        data-run-step-rail-column=""
        className="flex shrink-0 flex-col pt-1"
      >
        {steps.map((step, index) => (
          <Fragment key={step.key}>
            {index > 0 ? <RunSurfaceRailSeparator /> : null}
            {step.row}
          </Fragment>
        ))}
        {/* The page's own rows are one more entry after the gate rows, so the
            mark stands before them too. They carry their own separators
            inside (`RunStepRailPanel`), which is why only the join is drawn
            here. */}
        {runSurfaceNodeExists(rail) && steps.length > 0 ? <RunSurfaceRailSeparator /> : null}
        {rail}
      </div>

      {/* THE RIGHT COLUMN — the run detail, showing the selected step. */}
      <div
        data-conformance-id="run-detail-column"
        data-run-detail-column=""
        data-run-surface-selected-step={selected}
        className="flex min-w-0 flex-1 flex-col gap-4"
      >
        {/* A step with no surface of its own keeps the run detail — see
            `RunSurfaceRailStep.surface`.

            THE SAME FUNCTION THAT DECIDED THE ROW COULD BE OPENED decides what
            is drawn, so the two cannot disagree. It used to be `?? detail`
            here and `runSurfaceNodeExists` in the predicate, and they part
            company on `false`: the predicate reads it as nothing drawn and lets
            the row open on the strength of the fallback, while `??` treats it
            as the step's own surface and suppresses the fallback — an openable
            row over an empty column, which is the one thing this rail must not
            produce. */}
        {open && runSurfaceNodeExists(open.surface) ? open.surface : detail}
      </div>
    </RunStepSelectionContext.Provider>
  );
}
