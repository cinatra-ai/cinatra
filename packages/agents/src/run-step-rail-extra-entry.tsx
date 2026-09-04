"use client";

import Link from "next/link";
import { ClipboardCheck, ScanSearch, SkipForward } from "lucide-react";

import { StepperIndicator, StepperTitle, StepperTrigger } from "@/components/reui/stepper";

import { cn } from "@/lib/utils";

import type { RunStepRailEntry } from "./run-step-rail";
// The SELECTION only — never the frame module that provides it. This row is
// reachable from four LOCKED routes, so importing the frame here to read the
// selection put the whole two-column frame on all four of their graphs
// (`__tests__/run-surface-rail-selection-narrowness.test.ts`).
import { useRunStepSelection } from "./run-surface-rail-selection";

// ---------------------------------------------------------------------------
// THE RUN PAGE'S RAIL VOCABULARY, IN ONE PLACE (cinatra#3188, forward + fix
// leg 1).
//
// The run page draws its rail rows through three modules -- this one (the
// resolved-gate / verification / lifecycle rows), `run-step-rail-panel` (the
// step rows) and the live rail inside `orchestrator-stepper-panel` -- and all
// three mount the same vendored `Stepper` primitives. The drawing states ONE
// anatomy for the rail, so the three modules read it from one declaration
// here rather than each carrying its own copy: a rule three modules had to
// remember is a rule one of them would forget.
//
// WHY THIS MODULE HOLDS IT AND NOT `run-surface-rail`. Both other modules
// already import `RailExtraEntry` from here, so the declaration reaches them
// over an edge that already exists. Held in the rail FRAME module instead, it
// pulled that frame (and the frame's own step module) into the module graph
// of four route-budgeted routes, which the route-graph ratchet refuses -- the
// rule has to live where the rows already meet.

/**
 * THE GLYPH. The ratified drawing names the entry already passed and the entry
 * still ahead in ONE rule --
 *
 *   ".rail .step.upcoming .glyph, .rail .step.settled .glyph {
 *      background: rgba(92,103,121,0.4); color: var(--paper); }"
 *
 * -- and it is a rule about THE RAIL, not about one component of it. The
 * vendored `StepperIndicator`'s own default puts a COMPLETED step on the indigo
 * fill, which is what the first proof round photographed: "a 24x24 circle,
 * primary-fill background, white check". So both states take the muted ground
 * here and the indigo is left to the ACTIVE state alone -- the entry the reader
 * is standing on.
 *
 * WHY NOT IN THE PRIMITIVE: `StepperIndicator` is vendored and its consumers
 * are not all rails. ONE ROW IS DELIBERATELY LEFT ON THE OLD READING and named
 * rather than quietly changed: the review task screen's own step list draws
 * this same vocabulary and still fills a passed step with the indigo. It is the
 * same defect at a fourth site, it is not the run page this leg proves, and it
 * takes this same class when the surface that shows it is graded.
 *
 * THE GROUND IS THE SYSTEM'S OWN MUTED TOKEN, not the drawing's literal, and
 * the difference is named rather than closed: `--muted` is `#5a6477` =
 * rgb(90,100,119) against the drawing's rgba(92,103,121,0.4), which composes
 * one unit apart per channel. A rail that hard-coded the literal would be the
 * one element on the page that stopped following the theme, where the drawing's
 * own rule reads the paper through `var(--paper)` for exactly that reason.
 */
export const RUN_PAGE_RAIL_INDICATOR_CLASS =
  "data-[state=inactive]:bg-muted-foreground/40 data-[state=inactive]:text-background data-[state=completed]:bg-muted-foreground/40 data-[state=completed]:text-background";

/**
 * THE ROW BOX. ".rail .step { ... padding: 2px 0; ... }" over the 24px circle
 * is a 28px entry and nothing else. `StepperTrigger` renders the design-system
 * `Button`, whose base draws a 1px TRANSPARENT border on every side: invisible,
 * and still in the box. It made each row 30px and put an extra pixel of
 * whitespace above and below every mark -- the surplus the first proof round
 * measured at 7.5px above and 6.5px below the drawing's 4px and 4px. The row
 * keeps its focus indicator: the base's `focus-visible:ring-3` ring is what
 * draws focus here, and a border transparent at rest never drew it.
 */
export const RUN_PAGE_RAIL_ROW_CLASS = "gap-2 border-0 px-0 py-0.5";

/**
 * THE MARK BETWEEN TWO ENTRIES, which is the whole gap between them:
 *
 *   ".rail .sep { width: 2px; height: 8px; margin: 4px 0 4px 11px;
 *      border-radius: 1px; background: var(--line); }"
 *
 * The vendored `StepperSeparator` carries `m-0.5` -- 2px on every side -- and
 * the rail used to override only the height and the ink, so the run page's mark
 * stood at 2px above and below (against the drawing's 4px) and 12px in from the
 * column edge (against 11px, `ms-3` rounding the drawing's number). `my-1` and
 * `ms-[11px]` are the drawing's own two numbers; the 2px width and the 8px
 * height are the primitive's and the rail's `!h-2`.
 */
export const RUN_PAGE_RAIL_SEP_CLASS = "ms-[11px] my-1 !h-2 bg-border";


// ---------------------------------------------------------------------------
// The NON-STEP rail rows — gates ("Review"), verifications ("Audit")
// and lifecycle policy decisions — as ONE implementation (cinatra#2739).
//
// WHY THIS FILE EXISTS. The run detail used to mount TWO step rails for a
// flow/orchestrator run: the page-level `RunStepRailPanel` (which owned the
// review DEEP LINKS) and, inside `OrchestratorStepperPanel`, its own
// `StepperColumn` (which owns the LIVE behaviours — the ⓘ gate tooltips, the
// completed-step replay click, the dev stepper, the pause icon, and the active
// step driven by the run stream). Owner ruling 2026-08-14: exactly ONE rail.
//
// The live column survives — its active step comes from the client run stream
// and cannot be lifted into a server-rendered rail — so it has to carry the
// deep links the page rail owned. Those rows are rendered from HERE by BOTH
// rails rather than copied into the second one: a second copy of the review
// linkage is exactly how the two rails drifted into looking identical-but-not
// in the first place.
//
// Renders the row's INNER content only. The caller owns the `StepperItem`
// (step number, completed flag, separator) because that differs between the
// two rails, and this component must be rendered inside one — `StepperIndicator`
// reads the step-item context.
// ---------------------------------------------------------------------------

export function RailExtraEntry({
  entry,
  reviewHrefBase,
  displayStep,
  current = false,
}: {
  entry: RunStepRailEntry;
  reviewHrefBase: string;
  /** Numeral for a plain STEP row (a surplus stepResult past the policy spine —
   *  the only `kind: "step"` entry that ever reaches this component). Gates,
   *  verifications and lifecycle decisions draw an icon instead. */
  displayStep?: number;
  /** Is this the rail's CURRENT entry — the one the reader is standing on
   *  (cinatra#3149 item 3)? Answered by the rail that draws the row, because
   *  only the rail holds the anchor: "one entry is highlighted at a time"
   *  (the ratified drawing, §I.3). A row that opens the record's own page
   *  answers it for itself below and is never handed `true` at the same time —
   *  the rail scopes this to the detail being what is open. */
  current?: boolean;
}) {
  const isGate = entry.kind === "gate";
  const isVerification = entry.kind === "verification";
  // cinatra#2047 D-5: a lifecycle POLICY decision that opened no gate.
  const isLifecycle = entry.kind === "lifecycleDecision";
  // THE RUN'S OWN RECORD IS A STEP THAT OPENS (the conformance-fix leg). The
  // ratified drawing: "Selecting a step opens it on the right ... the page
  // carries the ONE CARD of the step it belongs to." This row is the rail's last
  // entry, and pressing it opens the record's page in the run detail. Outside
  // the run-surface frame there is no selection to make and the row stays the
  // inert row it always was — `useRunStepSelection` answers `null` there.
  const isRunMade = entry.kind === "runMade";
  const selection = useRunStepSelection();
  // "Selecting a step opens it on the right." A row is a CONTROL only where the
  // frame actually carries the step it would open — never merely because a
  // frame is present (the convergence leg).
  const runMadeOpens = isRunMade && Boolean(selection?.canSelect("runMade"));
  const runMadeSelected = isRunMade && selection?.selected === "runMade";
  const lifecycleOutcome = entry.lifecycleDecision?.outcome;
  const isResolved = entry.status === "resolved";
  const isPending = entry.status === "pending";

  const titleNode = (
    <StepperTitle className="data-[state=inactive]:text-muted-foreground data-[state=completed]:text-muted-foreground">
      {entry.label}
      {isGate && isResolved ? (
        <span className="ms-1.5 text-badge-2xs uppercase tracking-widest text-muted-foreground">
          {entry.gate?.disposition ?? "resolved"}
        </span>
      ) : null}
      {isVerification ? (
        <span className="ms-1.5 text-badge-2xs uppercase tracking-widest text-muted-foreground">
          {entry.verification?.outcome ?? "verified"}
        </span>
      ) : null}
      {isLifecycle ? (
        <>
          <span className="ms-1.5 text-badge-2xs uppercase tracking-widest text-muted-foreground">
            {entry.lifecycleDecision?.decidedBy ?? lifecycleOutcome ?? "policy"}
          </span>
          {/* The REASON is the point of the entry: a user must be able to
              tell a deliberately-skipped review from no machinery running.
              It WRAPS inside the narrow rail (never truncates) — a clipped
              reason answers nothing. */}
          <span
            className="mt-0.5 block max-w-36 text-start text-badge-2xs leading-4 break-words whitespace-normal text-muted-foreground"
            data-rail-lifecycle-reason=""
          >
            {entry.lifecycleDecision?.reason}
          </span>
        </>
      ) : null}
    </StepperTitle>
  );

  const indicatorNode = (
    <StepperIndicator className={RUN_PAGE_RAIL_INDICATOR_CLASS}>
      {isVerification ? (
        <ScanSearch className="h-3 w-3" />
      ) : isGate ? (
        <ClipboardCheck className="h-3 w-3" />
      ) : isLifecycle ? (
        <SkipForward className="h-3 w-3" />
      ) : (
        displayStep
      )}
    </StepperIndicator>
  );

  return (
    // The rail ANCHORS live on this wrapper, not on StepperTitle: the reui
    // StepperTitle accepts only {children, className} and drops every other
    // prop, so a data-* attribute placed there never reaches the DOM.
    <div
      // A lifecycle entry's reason wraps to several lines, so its indicator
      // aligns to the FIRST line rather than the block centre.
      className={isLifecycle ? "flex items-start gap-1" : "flex items-center gap-1"}
      data-rail-kind={entry.kind}
      data-rail-status={entry.status}
      data-rail-gated-step={isGate ? "true" : undefined}
      data-rail-gate-history={isGate && isResolved ? "true" : undefined}
      data-rail-gate-pending={isGate && isPending ? "true" : undefined}
      data-rail-verification={isVerification ? "true" : undefined}
      data-rail-verification-outcome={isVerification ? entry.verification?.outcome : undefined}
      data-rail-run-made={isRunMade ? "true" : undefined}
      data-run-surface-rail-selected={isRunMade ? (runMadeSelected ? "true" : "false") : undefined}
      data-rail-lifecycle-decision={isLifecycle ? lifecycleOutcome : undefined}
      data-rail-lifecycle-decided-by={
        isLifecycle ? entry.lifecycleDecision?.decidedBy ?? undefined : undefined
      }
      title={isLifecycle ? entry.lifecycleDecision?.reason : undefined}
    >
      {isGate && entry.gate ? (
        // A gate row links into the run-embedded review surface. A resolved
        // gate still links — the review page replays the completed submission
        // read-only. Rendered as a plain Link (not a StepperTrigger button) to
        // avoid a button-in-anchor.
        <Link
          href={`${reviewHrefBase}/${encodeURIComponent(entry.gate.reviewTaskId)}`}
          className="flex items-center gap-2 rounded-sm px-0 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-rail-gate-link={entry.gate.reviewTaskId}
          // The current-position marker sits on the ROW, whatever element the
          // row is (cinatra#3149 item 3) — a pending review is as often the
          // entry the reader is standing on as a work step is.
          aria-current={current ? "step" : undefined}
        >
          {indicatorNode}
          {titleNode}
        </Link>
      ) : isVerification && entry.verification ? (
        // A verification row (S4) deep-links into the same review surface's
        // VERIFICATION view — the before/after "Audit".
        <Link
          href={`${reviewHrefBase}/${encodeURIComponent(entry.verification.reviewTaskId)}?view=verification`}
          className="flex items-center gap-2 rounded-sm px-0 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-rail-verification-link={entry.verification.reviewTaskId}
          aria-current={current ? "step" : undefined}
        >
          {indicatorNode}
          {titleNode}
        </Link>
      ) : (
        // The row must be sized by its CONTENT. `StepperTrigger` renders the
        // shared Button, whose default size pins a fixed `h-8` — and a
        // lifecycle reason wraps to several lines inside the narrow rail. A
        // pinned row height cannot contain that: the row CENTRED its
        // overflowing content, so the wrapped text escaped the row box in both
        // directions and printed over the rows around it, while the
        // StepperItem (and so every following row's offset) went on being
        // measured from the fixed 2rem (cinatra#2840). `h-auto` hands the
        // height back to the content so a taller row PUSHES the rail down;
        // `min-h-8` keeps every single-line row at exactly the height it had.
        <StepperTrigger
          className={cn(
            "h-auto min-h-8",
            RUN_PAGE_RAIL_ROW_CLASS,
            // Once the row is allowed to grow, the Button's own `items-center`
            // would centre the indicator against the whole wrapped block. A
            // lifecycle indicator belongs on the FIRST line — the same
            // alignment the wrapper above states.
            isLifecycle && "items-start"
          )}
          // The record's row is the one row here a reader PRESSES, so it is the
          // one row that keeps its place in the tab order — an EXPLICIT 0, not
          // `undefined`. `StepperTrigger` reads `undefined` as "not selected by
          // the stepper" and emits `-1`, and a finished rail has no internally
          // selected row at all, so `undefined` took every row out of the tab
          // order and no keyboard could reach this one (the convergence leg).
          tabIndex={runMadeOpens ? 0 : -1}
          aria-current={runMadeSelected || current ? "step" : undefined}
          // `StepperTrigger` renders `role="tab"` and would otherwise announce
          // `aria-selected="false"` on the very row `aria-current` calls open.
          aria-selected={runMadeOpens ? runMadeSelected : undefined}
          data-action={runMadeOpens ? "open-run-made-step -> step-detail" : undefined}
          onClick={runMadeOpens ? () => selection?.select("runMade") : undefined}
          // ENTER AND SPACE, on KEY-UP. `StepperTrigger`'s own key handler calls
          // `preventDefault()` on Enter and Space, which suppresses the native
          // click a button would otherwise synthesise — so `onClick` alone left
          // this row mouse-only. `onKeyUp` is a prop the trigger does not set,
          // so it reaches the button without displacing the arrow-key roving
          // focus the trigger's `onKeyDown` provides.
          onKeyUp={
            runMadeOpens
              ? (event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  selection?.select("runMade");
                }
              : undefined
          }
        >
          {indicatorNode}
          {titleNode}
        </StepperTrigger>
      )}
    </div>
  );
}
