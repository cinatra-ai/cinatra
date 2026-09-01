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
    <StepperIndicator className="data-[state=inactive]:bg-muted-foreground/40 data-[state=inactive]:text-background">
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
            "h-auto min-h-8 gap-2 px-0 py-0.5",
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
          aria-current={runMadeSelected ? "step" : undefined}
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
