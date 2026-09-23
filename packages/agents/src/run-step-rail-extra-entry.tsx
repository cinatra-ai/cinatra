"use client";

import { createContext, useContext } from "react";
import Link from "next/link";
import { ClipboardCheck, ScanSearch, SkipForward } from "lucide-react";

import { StepperIndicator, StepperTitle, StepperTrigger } from "@/components/reui/stepper";

import { cn } from "@/lib/utils";

import type { RunStepRailEntry } from "./run-step-rail";
// THE SELECTION VOCABULARY, AS A TYPE ONLY (cinatra#3478, the click leg).
// `run-surface-rail-step` carries no directive and this import is erased at
// compile time, so reading the run detail's selection here adds no module to
// any route graph -- the rule this file's head states for every declaration it
// holds.
import type { RunStepSelection } from "./run-surface-rail-step";

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
 *
 * AND THE CIRCLE IS CENTRED IN THE ROW'S OWN BOX (cinatra#3225 item 3, fix leg
 * 10). The drawing states the row's cross-axis alignment itself —
 * ".rail .step { display: flex; align-items: center; gap: 8px; padding: 2px 0 }"
 * — so on a row whose label wraps inside the 208px column (cinatra#3226) the
 * circle sits at the middle of the WHOLE row box. The drawing gives the rail's
 * type its leading in the same sentence — "font-size: 14px; line-height: 1.15" —
 * so a line box is 16.1px and a three-line row is 3 x 16.1 of text over the
 * row's own 2px either side, 52.3px, with its circle's centre at that box's
 * centre.
 *
 * AND THE ROW STARTS AT THE COLUMN'S LEFT EDGE (cinatra#3514). The drawing
 * draws the rail as ONE column -- "The step the run is paused on is
 * highlighted; steps already passed sit above it, steps still to come below" --
 * and nothing in it indents a row. This declaration used to state no horizontal
 * alignment at all, so every row drawn through `StepperTrigger` kept the shared
 * `Button` base's own `justify-center` (`src/components/ui/button.tsx`), and on
 * a row whose wrapper spans the rail column (the `flex w-full min-w-0` row
 * wrapper below) that CENTRED the circle and the label inside the column: half
 * the row's leftover width became a left indent, so the shorter the label the
 * further right the row sat. Measured on a development boot 2026-09-15 on the
 * Email Outreach Agent's run page, in both palettes at a 2880px frame: the gate
 * entries "Account scope", "Review drafts" and "Test & send" stood about 12, 18
 * and 25px right of the plain steps beside them, and the same shift on the List
 * Curator's run page. `justify-start` is the sentence the run-surface rail's own
 * row class next door already states (`RUN_SURFACE_RAIL_ROW_CLASS`), so one
 * rail reads at one edge instead of two.
 *
 * TWO EARLIER READINGS ARE WITHDRAWN HERE. Leg 8 pinned the circle to the
 * label's FIRST line (`items-start` plus a 2px nudge on the label); leg 9 then
 * took the mark out of the flow to keep its gaps even under that reading. The
 * sixth proof round measured what the pair composes on a real run: a circle
 * centre at 286 in a row box running 272..354 — 27px above the box's own
 * centre — and the mark standing INSIDE that row's box with 25px above it and
 * 25px below. The drawing's own sentence needs neither device.
 */
export const RUN_PAGE_RAIL_ROW_CLASS =
  "h-auto w-full min-w-0 items-center justify-start gap-2 border-0 px-0 py-0.5 text-left whitespace-normal";

/**
 * THE LABEL FITS THE RAIL COLUMN (cinatra#3226, the fourth proof round's
 * follow-up).
 *
 * The rail column is 208px wide and the row is drawn inside it. The shared
 * `Button` the rows render through pins `whitespace-nowrap`, so a work step
 * named by what it did — which is what the drawing asks a rail entry to say,
 * and what this branch made the settled step say — ran straight out of the
 * column and was cut by the detail card beside it: measured on the live boot
 * at 208px of overflow past a 208px column, in both palettes.
 *
 * IT WRAPS, IT DOES NOT TRUNCATE, for the reason the lifecycle reason below
 * already states: a clipped label answers nothing, and the drawing's own rail
 * rows carry their whole name. `min-w-0` is what lets the flex row give the
 * label back to the column instead of growing past it; `break-words` catches a
 * single long token that no wrap point can break.
 *
 * AND IT STATES THE DRAWING'S OWN LINE BOX (cinatra#3225 item 3, fix leg 10).
 * The leading is the drawing's, not a choice made here: ".rail .step" carries
 * "font-size: 14px; line-height: 1.15", so `leading-[1.15]` is that sentence
 * rather than a rounding of it, and each line box measures 16.1px. It is the
 * SAME box the run-surface rail's rows compose, which is one rail with one
 * rhythm rather than two: a one-line row is the 24px circle over the row's own
 * 2px either side, 28px, and a three-line row is 3 x 16.1 over that same
 * padding, 52.3px. THE ROW GROWS BY ITS OWN LINE BOXES AND BY NOTHING ELSE,
 * which is the half of the drawing's rhythm the label owns; the row class above
 * owns the other half and centres the circle in whatever box those lines make.
 *
 * `leading-5` IS WITHDRAWN WITH THE READING IT SERVED. It made every line box
 * 20px — a number the drawing states nowhere — which grew a three-line row to
 * 64px and the pitch beside it to 62px, where the drawing composes 52.3 and 56.
 *
 * The `mt-0.5` leg 8 used to nudge the first line onto the circle is GONE too:
 * it put an extra pixel into every row's height and it only ever existed to
 * serve the first-line reading that leg withdraws.
 */
export const RUN_PAGE_RAIL_TITLE_CLASS =
  "min-w-0 leading-[1.15] break-words whitespace-normal text-start";

/**
 * THE MARK BETWEEN TWO ENTRIES, which is the whole gap between them:
 *
 *   ".rail .sep { width: 2px; height: 8px; margin: 4px 0 4px 11px;
 *      border-radius: 1px; background: var(--line); }"
 *
 * ONE DEFINITION FOR BOTH RAILS (cinatra#3225). This class used to set the
 * indent, the margins and the height, and neither the mark's width nor its
 * radius, so both fell to the vendored primitive's defaults — while the
 * run-surface rail drew its mark at the drawing's measurements. Measured on a
 * real completed run, the run page's own panel rail composed a 50.0px and then
 * a 45.5px pitch between adjacent circle centres where the run-surface rail
 * composed the drawing's 44.0px. Two compositions of one rail are two rhythms;
 * the mark is declared ONCE, HERE, and both rails read it.
 *
 * AND IT IS A SIBLING IN NORMAL FLOW, WITH THE DRAWING'S OWN MARGINS
 * (cinatra#3225 items 2 and 3, fix leg 10). The drawing composes the rail from
 * siblings — a row box, the mark, the next row box — and its margins are stated
 * against those boxes: "margin: 4px 0 4px 11px" is 4px under the row above and
 * 4px over the row below, whatever height either of them has. Nothing in it
 * reserves a slot for the mark, and nothing takes the mark out of the flow.
 *
 * Leg 9 read the 4px, the 8px mark and the 4px as a 16px SLOT that the row above
 * reserved (`pb-4`), and centred an absolutely-positioned mark inside it. The
 * sixth proof round measured what that composes once a row wraps: the mark at
 * y 323..331 with 25px of margin above and below it, INSIDE the row box that
 * runs 272..354, and pitches of 44 then 82 down one rail. A slot the drawing
 * does not draw cannot be the rule, so the mark is back in the flow:
 *
 *   `!my-1`         the 4px above and the 4px below, measured against the row
 *                   boxes either side. `!` because the vendored
 *                   `StepperSeparator` emits its own `m-0.5`.
 *   `!ml-[11px]`    the drawing's indent, the centre of the 24px circle the
 *                   entries carry, so the marks and the circles read as one
 *                   line down the rail; `!mr-0` clears the same `m-0.5` on the
 *                   other side.
 *   `!h-2`          the vendored `StepperSeparator` sets its vertical height
 *                   through a variant-scoped token emitted AFTER the plain
 *                   utilities, so the drawing's 8px has to win by importance
 *                   there; on the run-surface frame's plain mark the importance
 *                   is inert.
 *
 * ONE RHYTHM FALLS OUT OF THE TWO RULES rather than being asserted on top of
 * them: with the circle centred in its own row box, the pitch between two
 * adjacent circles is half of each box plus the mark's own 16px — 44 for a pair
 * of one-line rows, 56.2 for a one-line row beside a three-line one — and the gap
 * from a row box to the mark is 4px at every pair, whatever the rows weigh.
 *
 * WHY HERE AND NOT IN A LEAF OF ITS OWN. The declaration first landed in a
 * zero-import leaf beside this file. A leaf is still a MODULE: it entered the
 * reachable first-party graph of the four route-budgeted routes that already
 * reach this module, and the route-graph ratchet refuses a locked route that
 * grows. The rule belongs where the rows already meet -- the same reason the
 * indicator and the row classes above are held here and not in the rail frame.
 *
 * THE ROW IS CONTENT-SIZED for the same reason (`h-auto` above): the shared
 * Button pins a fixed `h-8`, a 32px box around a 24px circle, where the
 * drawing's `.rail .step { padding: 2px 0 }` over the circle is 28px.
 */
export const RUN_RAIL_MARK_CLASS =
  "!my-1 !mr-0 !ml-[11px] !h-2 w-0.5 rounded-[1px] bg-line";

/** The run page's own panel rails read the same mark under the rail's name. */
export const RUN_PAGE_RAIL_SEP_CLASS = RUN_RAIL_MARK_CLASS;

/**
 * THE ROW THAT OPENS NOTHING (cinatra#3002, acceptance 3).
 *
 * A run on the agent runtime leaves one step result, and the rail carries it as
 * a row: it IS a thing that happened and it keeps its place. It opens nothing —
 * only gate, verification and lifecycle rows carry a target — so fix leg 6 took
 * the button off it. The row went on drawing the same circle, the same numeral,
 * the same title and the same box as the rows that DO open, so on pixels
 * nothing told a reader it does not open: a difference only the DOM carried.
 *
 * THE DRAWING GIVES NO SUCH ROW TO COPY. The ratified drawing names ONE action
 * for this rail — "open-run-step -> step-detail" — and every rail row it draws
 * opens on selection; its rows are parted by the state ink alone (the entry
 * passed and the entry ahead share one muted ground, the entry being read takes
 * the ink). There is no drawn treatment for a row that looks like a step and
 * cannot be opened, and inventing a mark the drawing does not have would be a
 * second departure rather than a fix for the first.
 *
 * SO THE ROW TAKES THE RAIL'S OWN READING FOR A ROW A READER CANNOT PRESS. This
 * rail already draws them: a step still ahead is rendered `disabled`, and the
 * vendored stepper row's own class list is
 * "... cursor-pointer ... disabled:pointer-events-none disabled:opacity-60" —
 * so on this very surface "cannot be pressed" is already 60% ink and no pointer
 * cursor. The literal classes are carried here rather than the `disabled:`
 * variants because this row is not a disabled CONTROL — it is not a control at
 * all, and a variant keyed off a button's disabled attribute never fires on a
 * div.
 *
 * WHAT DOES NOT CHANGE: the drawing's row anatomy. The 24px glyph, the numeral,
 * the title, the 28px box and the marks between the rows are untouched, so the
 * rail's geometry reads exactly as it was graded. Only the affordance moves,
 * which is the one thing the row was saying wrongly.
 */
export const RUN_PAGE_RAIL_INERT_ROW_CLASS = "cursor-default opacity-60";


// ---------------------------------------------------------------------------
// WHICH STEP THE RUN DETAIL IS SHOWING (cinatra#3478, the click leg).
//
// THE DEFECT THIS CLOSES. The rail's gate row was a plain link into the
// review's OWN page, and it was that link for the gate the run is PARKED on as
// much as for a settled one: a real pointer press on the step the reader is
// standing at took the browser off the run page altogether. The ratified
// drawing gives the opposite reading twice --
//
//   "Selecting a step opens it on the right ... a gate step opens the gate's
//    own surface in place -- a pending review renders the review gate right
//    here in the run detail, under the same rail, never as a standalone
//    document";
//
//   "A review is a step, and it opens where every step opens ... selecting it
//    opens the review in place, in the run detail."
//
// -- so the parked row selects the step's screen instead of navigating to one.
//
// WHY THE DECLARATION LIVES HERE AND NOT IN THE FRAME. The frame
// (`run-surface-rail`) already imports this module for the rail's own
// vocabulary and for the frame flag beneath this file's foot; a row reaching
// back INTO the frame for the context would close that edge into a cycle and
// pull the frame into the module graph of four route-budgeted routes, which
// the route-graph ratchet refuses -- the same lesson cinatra#3188 wrote at the
// head of this file. The frame PROVIDES the selection (nothing else may) and
// the rows READ it, exactly as they already read whether the frame draws the
// rail at all.
// ---------------------------------------------------------------------------

/** The run detail's selection, and the one road that changes it. */
export type RunStepSelectionHandle = {
  selected: RunStepSelection;
  select: (next: RunStepSelection) => void;
};

const RunStepSelectionContext = createContext<RunStepSelectionHandle | null>(null);

/** The frame states the selection; nothing else may provide this. */
export const RunStepSelectionProvider = RunStepSelectionContext.Provider;

/**
 * The run detail's selection, for a row drawn anywhere inside the frame.
 *
 * `null` outside a frame -- the default -- which is how a rail mounted without
 * one (a host that composes no run detail) reads exactly as it always has.
 */
export function useRunStepSelection(): RunStepSelectionHandle | null {
  return useContext(RunStepSelectionContext);
}


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
}: {
  entry: RunStepRailEntry;
  reviewHrefBase: string;
  /** Numeral for a plain STEP row (a surplus stepResult past the policy spine —
   *  the only `kind: "step"` entry that ever reaches this component). Gates,
   *  verifications and lifecycle decisions draw an icon instead. */
  displayStep?: number;
}) {
  const isGate = entry.kind === "gate";
  const isVerification = entry.kind === "verification";
  // cinatra#2047 D-5: a lifecycle POLICY decision that opened no gate.
  const isLifecycle = entry.kind === "lifecycleDecision";
  const lifecycleOutcome = entry.lifecycleDecision?.outcome;
  const isResolved = entry.status === "resolved";
  const isPending = entry.status === "pending";

  // THE GATE THE RUN IS PARKED ON OPENS IN PLACE (cinatra#3478, the click leg).
  // The run detail is where a gate's own surface is drawn, so the row that
  // stands for it SELECTS that step rather than navigating to a page of its
  // own. Where there is no frame around this rail there is no run detail to
  // open into, and the row keeps the deep link it has always carried -- which
  // is also the review's own page, reached from its own navigation, unchanged.
  const selection = useRunStepSelection();
  const gateOpensInTheRunDetail = isGate && isPending && selection !== null;
  // AND WHILE ITS SCREEN IS THE ONE DRAWN, THE ROW READS CURRENT. The run
  // detail is where the parked gate's own surface stands, so a detail-selected
  // frame IS this row's screen being shown -- the reader is standing on this
  // step, and the rail says so in the vocabulary its spine rows already use.
  const gateIsTheOpenScreen = gateOpensInTheRunDetail && selection?.selected === "detail";

  const titleNode = (
    <StepperTitle
      className={cn(
        RUN_PAGE_RAIL_TITLE_CLASS,
        "data-[state=inactive]:text-muted-foreground data-[state=completed]:text-muted-foreground",
      )}
    >
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
      // EVERY entry's indicator is centred in the row's OWN box (cinatra#3225
      // item 3, fix leg 10) — the drawing's ".rail .step { align-items: center }",
      // stated once on the shared row class above and read here as everywhere
      // else. Leg 8 pinned it to the label's first line instead, which the sixth
      // proof round measured 27px off the row's own centre.
      // The row spans the rail column and may SHRINK inside it, which is what
      // lets a long label wrap instead of running past the column (cinatra#3226).
      className="flex w-full min-w-0 items-center gap-1"
      data-rail-kind={entry.kind}
      data-rail-status={entry.status}
      // The row that opens nothing says so here on BOTH rails, so one reading
      // of the rail answers for both mounts (cinatra#3002).
      data-rail-openable={entry.openable === false ? "false" : undefined}
      data-rail-gated-step={isGate ? "true" : undefined}
      data-rail-gate-history={isGate && isResolved ? "true" : undefined}
      data-rail-gate-pending={isGate && isPending ? "true" : undefined}
      data-rail-verification={isVerification ? "true" : undefined}
      data-rail-verification-outcome={isVerification ? entry.verification?.outcome : undefined}
      data-rail-lifecycle-decision={isLifecycle ? lifecycleOutcome : undefined}
      data-rail-lifecycle-decided-by={
        isLifecycle ? entry.lifecycleDecision?.decidedBy ?? undefined : undefined
      }
      title={isLifecycle ? entry.lifecycleDecision?.reason : undefined}
    >
      {isGate && entry.gate && gateOpensInTheRunDetail ? (
        // THE PARKED GATE'S OWN CONTROL. A press selects the step the run is
        // standing on, and the review is drawn as that step's screen in the run
        // detail beside this rail -- "the same detail, under the same rail".
        // The location never leaves the run page, and the rail is untouched by
        // the press: the row was already the entry the run is paused on.
        //
        // IT IS THE ROW THE OTHER STEPS DRAW. `StepperTrigger` is what every
        // spine row of this rail presses through, so the gate row takes the
        // same control, the same box (the shared row class) and the same
        // reading -- only its handlers are its own. `tabIndex={0}` keeps the
        // row reachable from the keyboard, and the key handler below keeps it
        // openable from there, as the link it replaces was.
        <StepperTrigger
          className={RUN_PAGE_RAIL_ROW_CLASS}
          tabIndex={0}
          data-rail-gate-open={entry.gate.reviewTaskId}
          // THE STEP THE SCREEN BELONGS TO IS MARKED, and marked the way the
          // frame's own rows mark theirs, so one reading of the rail answers
          // for every row of it.
          aria-current={gateIsTheOpenScreen ? "step" : undefined}
          data-run-surface-rail-selected={gateIsTheOpenScreen ? "true" : "false"}
          onClick={() => selection?.select("detail")}
          // AND THE KEY OPENS WHAT THE POINTER OPENS. The control's own
          // keyboard road answers Enter and Space by moving the stepper's
          // active step and stopping the browser's activation there, so the
          // press handler above would never run for a reader on the keyboard
          // and this row would open nothing -- where the link it replaces
          // opened on Enter. The row states its own answer for those two keys.
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            selection?.select("detail");
          }}
        >
          {indicatorNode}
          {titleNode}
        </StepperTrigger>
      ) : isGate && entry.gate ? (
        // A gate row links into the run-embedded review surface. A resolved
        // gate still links — the review page replays the completed submission
        // read-only. Rendered as a plain Link (not a StepperTrigger button) to
        // avoid a button-in-anchor.
        <Link
          href={`${reviewHrefBase}/${encodeURIComponent(entry.gate.reviewTaskId)}`}
          // ONE ROW BOX FOR EVERY ROW (cinatra#3225). The row's geometry is the
          // shared declaration above, not a second copy written out here: a
          // gate row that stated its own box is how the rail came to compose
          // two rhythms in the first place.
          className={cn(
            "flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            RUN_PAGE_RAIL_ROW_CLASS,
          )}
          data-rail-gate-link={entry.gate.reviewTaskId}
        >
          {indicatorNode}
          {titleNode}
        </Link>
      ) : isVerification && entry.verification ? (
        // A verification row (S4) deep-links into the same review surface's
        // VERIFICATION view — the before/after "Audit".
        <Link
          href={`${reviewHrefBase}/${encodeURIComponent(entry.verification.reviewTaskId)}?view=verification`}
          className={cn(
            "flex rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            RUN_PAGE_RAIL_ROW_CLASS,
          )}
          data-rail-verification-link={entry.verification.reviewTaskId}
        >
          {indicatorNode}
          {titleNode}
        </Link>
      ) : entry.openable === false ? (
        // A SURPLUS STEP-RESULT ROW reaches this component from the live rail
        // inside `OrchestratorStepperPanel`, which renders every non-spine
        // entry through here — a `kind: "step"` row past the policy spine
        // included. It opens nothing, so it is not drawn as a control and not
        // drawn at the ink of one; it keeps the geometry of the row it stands
        // beside (`h-auto min-h-8` and the shared row box) so only the
        // affordance differs. Same reading as the page rail's own step rows —
        // one row, one declaration (cinatra#3002).
        <div
          className={cn(
            "flex h-auto min-h-8 items-center",
            RUN_PAGE_RAIL_ROW_CLASS,
            RUN_PAGE_RAIL_INERT_ROW_CLASS
          )}
          data-rail-inert=""
        >
          {indicatorNode}
          {titleNode}
        </div>
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
            // The row's own box AND its alignment are the shared row class's
            // (`h-auto`, content sized, `items-center`, cinatra#3225) — no
            // `min-h-8` floor, which held this row at the 32px the drawing does
            // not draw, and no second copy of any alignment rule here: the
            // drawing centres the circle in the row's own box and this row is
            // sized by its content, so a wrapped reason grows the box and takes
            // the circle to its new middle with it.
            RUN_PAGE_RAIL_ROW_CLASS,
          )}
          tabIndex={-1}
        >
          {indicatorNode}
          {titleNode}
        </StepperTrigger>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// THE ENTRY THE RUN IS PARKED ON (cinatra#3221).
//
// The ratified drawing, agent run and review surface, "The step rail -- merged
// steps and gate entries": "The step the run is paused on is highlighted; steps
// already passed sit above it, steps still to come below" -- "so the rail is
// the run's whole lifecycle at a glance, not just its live tip."
//
// The run page's live rail elects its highlighted entry from ONE number, the
// stepper's `value`, and every row -- the template spine's rows and the
// trailing rows a gate arrives on -- is capable of taking it. The number used
// to be derived from the run's status and the live interrupt's spine step
// alone, so a gate that arrives as a TRAILING entry (a context-selection gate,
// a review gate past the spine) was never its target: with no spine step number
// the election fell through to the first row, with `awaitingNextStep` it
// pointed one past the row the run was parked on, and a finished run pointed
// one past the spine -- which is the FIRST trailing row. On a gate reading
// nothing highlighted; on a finished rail the wrong thing could.
//
// The election is PURE, so the rail's one number can be read against the
// drawing's sentence without mounting the panel. It lives in THIS module and
// not in a leaf of its own for the reason the mark above states: its only
// caller, the live rail in `orchestrator-stepper-panel`, already imports the
// rail vocabulary from here, so the election reaches it over an edge that
// already exists -- where a leaf of its own is one more module in the
// reachable graph of four route-budgeted routes.
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

  // THE RUN PARKED AT ITS SCHEDULE (cinatra#3221, fix leg 8). The scheduling
  // gate is the drawing's second gate entry and it parks on two statuses of its
  // own -- `pending_trigger` while the choice is outstanding, `armed` once the
  // choice named an instant. Neither was a branch here, so a run standing at
  // its schedule fell through to the function's last line and elected the FIRST
  // row: the fourth proof round measured exactly that, nothing highlighted on
  // the very step the reader was standing at. The gate's own trailing row wins,
  // the same rule the review gate above takes; with no trailing row of its own
  // the rail is left exactly as it was.
  if (status === "pending_trigger" || status === "armed") {
    return parkedTrailingStep ?? 1;
  }

  if (status === "pending_approval") {
    // THE GATE THE RUN IS PARKED AT WINS, WHATEVER STEP PRODUCED THE WORK
    // (cinatra#3221, fix leg 7). A gate that arrives as a trailing entry is its
    // own row, and that row is where the run stands: "The step the run is
    // paused on is highlighted." The spine test used to be asked first, so a
    // WORK REVIEW gate — which opens at a marked step and therefore arrives
    // with that step's number on the live interrupt — elected the settled work
    // step instead of the review entry the reader was standing at, and the
    // third proof round measured exactly that: nothing elected on the gate.
    // The spine reading below is unchanged for the gates that have no trailing
    // row of their own.
    if (parkedTrailingStep !== null) return parkedTrailingStep;
    // A gate that arrives ON the spine is the row the live interrupt names.
    if (currentStepNumber !== null && onSpine(currentStepNumber) && !awaitingNextStep) {
      return toDisplayIndex(currentStepNumber);
    }
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

// ---------------------------------------------------------------------------
// IS THIS SUBTREE DRAWN INSIDE THE RUN SURFACE'S OWN RAIL FRAME? (cinatra#3478)
//
// THE DEFECT THIS CLOSES. `screenHostsStepRail` (cinatra#2739) suppressed the
// page-level `RunStepRailPanel` on the branch where `OrchestratorStepperPanel`
// raises a column of its own, and that answer was correct for the ONE rail it
// knew about. It was never asked about the SECOND one: the run surface's own
// frame (`RunSurfaceRail`) draws a rail column whenever the screen hands it any
// rail step — a schedule, an input form, the gate the run is stopped at, the
// run's own record — and nothing suppressed that column. So a run on the
// stepper branch that also carried any such row drew TWO live rail columns side
// by side: the frame's at the left, the panel's beside it, then the detail. It
// was measured on three run pages on 2026-09-13 — a rail at x≈464, a second at
// x≈583 — and the ratified drawing gives ONE: "a two-column frame: a step rail
// down the left names the run's ordered steps, and the run detail on the right".
//
// WHY A CONTEXT AND NOT A SECOND PREDICATE. The frame's column is drawn from a
// list the screen composes LAST — after the run detail (and the panel inside it)
// is already built — so a prop would have to restate, ahead of time, exactly
// when that list ends up non-empty. A second derivation of the same fact is how
// this page came to draw two rails in the first place: `screenHostsStepRail`
// answered for one column and nothing answered for the other. The composition
// itself is the fact, and it is read where it is true: inside the frame.
//
// The frame provides it; the run panel asks it and stands its own column down,
// exactly as the page-level rail already stands down for the panel. What the
// panel's column carried alone -- the deep links that travel as `railExtras` --
// is drawn by the page-level rail inside the frame's column, which the screen
// mounts there for this branch (`screenDrawsPageRail`).
// ---------------------------------------------------------------------------
//
// WHY THIS MODULE HOLDS IT. Both sides of the question -- the frame in
// run-surface-rail.tsx that answers it, and the run panel in
// orchestrator-stepper-panel.tsx that asks it -- already import the rail
// vocabulary from here, so the declaration reaches them over edges that
// already exist. Held in a module of its own it added one module to four
// route-budgeted route graphs, which the route-graph ratchet refuses (the
// same lesson cinatra#3188 wrote at the head of this file): the rule lives
// where the rows already meet.
// ---------------------------------------------------------------------------

const RunSurfaceRailFrameContext = createContext<boolean>(false);

/** The frame states it draws the rail; nothing else may provide this. */
export const RunSurfaceRailFrameProvider = RunSurfaceRailFrameContext.Provider;

/**
 * Does the run surface's own frame draw the step rail around this subtree?
 *
 * `false` outside a frame — the default — so every host that is not composed by
 * `RunSurfaceRail` reads exactly as it always has.
 */
export function useRunSurfaceRailFrame(): boolean {
  return useContext(RunSurfaceRailFrameContext);
}
