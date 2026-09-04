"use client";

import { useRouter } from "next/navigation";
import { CheckCheck, CircleX, RotateCcw } from "lucide-react";
import { SpinnerArc } from "@cinatra-ai/sdk-ui";

import { Button } from "@/components/ui/button";
import {
  reviewBlockedCopy,
  reviewSettledCopy,
  type ReviewBlockedReason,
  type ReviewSettledOutcome,
} from "@/lib/artifacts/review-surface-model";

/**
 * The gate-level BLOCKED state (cinatra#1795 S12 item 4; spec design@0c484154b069c6369a33c1375056126289888997 §V):
 * a single blocked panel naming the reason from the closed set, with a REFRESH
 * back to the live gate. It never lets a stale decision through — the gate is no
 * longer the one the reviewer opened. Distinct from a per-target floor (§III),
 * which keeps a target visible; a block stops the whole surface.
 *
 * Conformance anchor: `review-gate-blocked`.
 *
 * cinatra#2566 (epic #2564 S2): the component MOVED here from the review route
 * so the ONE review renderer can draw §IV's "no longer open" with the SHIPPED
 * panel on every first-party host. Its only new seam is `onRefresh`: on the
 * review PAGE the Refresh still re-renders the route (unchanged default), but a
 * card sitting in a chat transcript must re-resolve ITSELF — refreshing the
 * whole thread route would neither re-authorize the gate nor keep the reader's
 * place. The copy, the anchors and the page behaviour are untouched.
 */
export function ReviewGateBlocked({
  reason,
  onRefresh,
}: {
  reason: ReviewBlockedReason;
  /** Card-local refresh. Omitted → the route refresh the page has always used. */
  onRefresh?: () => void;
}) {
  const router = useRouter();
  const copy = reviewBlockedCopy(reason);
  return (
    <div
      data-conformance-id="review-gate-blocked"
      data-blocked-reason={reason}
      className="rounded-control border border-line bg-surface-strong px-4 py-5 text-center"
    >
      <div className="mx-auto mb-2.5 grid size-9 place-items-center rounded-lg bg-destructive/10 text-destructive">
        <CircleX aria-hidden="true" className="size-[18px]" />
      </div>
      <p className="font-sans text-sm font-semibold text-foreground">{copy.title}</p>
      <p className="mx-auto mt-1 max-w-[46ch] text-xs text-muted-foreground">{copy.body}</p>
      <Button
        variant="link"
        size="sm"
        className="mt-1"
        data-action="refresh-gate -> live-gate"
        onClick={() => (onRefresh ? onRefresh() : router.refresh())}
      >
        Refresh
      </Button>
    </div>
  );
}

/**
 * The gate-level SETTLED state with a RECORDED OUTCOME (cinatra#2855; plan
 * §4.2). The card that knows what happened says so: "Approved by …" /
 * "Rejected by …" / "Changes requested by …", over the shipped sentence for
 * that outcome, and with the recorded suggestion chips still drawn above it by
 * the caller.
 *
 * NO REFRESH, AND THAT IS THE POINT. `ReviewGateBlocked` carries one because its
 * copy cannot say which of two things happened, so a fresh pull is the reader's
 * only way to find out. Here the pull has already answered. A Refresh beside a
 * named outcome would offer to resolve an ambiguity that is not there, and
 * invite the reader to press it as though something might still change.
 *
 * A gate this build cannot read an outcome for never reaches this component:
 * the caller draws `ReviewGateBlocked` for it, unchanged, Refresh and all.
 *
 * Conformance anchor: `review-gate-settled`.
 */
export function ReviewGateSettled({
  outcome,
  decidedByName,
}: {
  outcome: ReviewSettledOutcome;
  /** A SURFACE-SAFE display name. Never an id — the resolver drops a decider it
   *  cannot name safely, and the copy then states the outcome alone. */
  decidedByName?: string;
}) {
  const copy = reviewSettledCopy(outcome, decidedByName);
  const Icon =
    outcome === "approved" ? CheckCheck : outcome === "rejected" ? CircleX : RotateCcw;
  // The status palette's own tokens (`--success` / `--destructive` / `--warning`),
  // in the tint-over-token shape the shipped status chips already use.
  const tone =
    outcome === "approved"
      ? "bg-success/10 text-success"
      : outcome === "rejected"
        ? "bg-destructive/10 text-destructive"
        : "bg-warning/10 text-warning";
  return (
    <div
      data-conformance-id="review-gate-settled"
      data-review-outcome={outcome}
      className="rounded-control border border-line bg-surface-strong px-4 py-5 text-center"
    >
      <div className={`mx-auto mb-2.5 grid size-9 place-items-center rounded-lg ${tone}`}>
        <Icon aria-hidden="true" className="size-[18px]" />
      </div>
      <p className="font-sans text-sm font-semibold text-foreground">{copy.title}</p>
      <p className="mx-auto mt-1 max-w-[46ch] text-xs text-muted-foreground">{copy.body}</p>
    </div>
  );
}

/**
 * The gate LOADING skeleton (§V) — shown in each target slot while the host
 * prepares the targets, never a flash of empty chrome.
 *
 * Conformance anchor: `review-gate-loading`.
 */
export function ReviewGateLoading() {
  return (
    <div
      data-conformance-id="review-gate-loading"
      aria-busy="true"
      className="overflow-hidden rounded-control border border-line bg-surface-strong"
    >
      <div className="border-b border-line px-4 py-3">
        <div className="mb-1.5 h-2 w-1/2 rounded bg-surface-muted" />
        <div className="h-1.5 w-2/5 rounded bg-surface-muted" />
      </div>
      <div className="grid gap-2 p-4">
        <div className="h-1.5 w-11/12 rounded bg-surface-muted" />
        <div className="h-1.5 w-4/5 rounded bg-surface-muted" />
        <div className="h-1.5 w-2/3 rounded bg-surface-muted" />
      </div>
    </div>
  );
}


/**
 * THE RUN CARD'S PLACEHOLDER FOR THE REVIEW SCREEN (cinatra#2997, redrawn to the
 * ratified drawing in cinatra#3051 after the eighth proof round graded it).
 *
 * THE DRAWING IS THE SPECIFICATION, so its sentences are quoted rather than
 * paraphrased — Agent run & review, "the run progress card":
 *
 *   "While the run works, the detail carries a placeholder. A run that will ask
 *    for a review carries, in the run detail, the run progress card — and while
 *    the run is working that card is a placeholder for the review screen: the
 *    card frame, and a spinning icon, the indigo arc of Components § Skeleton /
 *    Spinner. It names no status, reports no result and draws nothing to press."
 *
 *   "It is replaced, in place, when the output is generated. The placeholder
 *    becomes the Review requested gate above — the same detail, under the same
 *    rail. It happens on its own: there is nothing for the reader to open or
 *    press to bring it."
 *
 * AND THE DRAWN ANATOMY at the anchors `run-progress-placeholder` (Agent run &
 * review) and `run-progress-placeholder-in-thread` (Lifecycle cards § I), which
 * draw the SAME card as each other: the card, a title in the sans face at 14px /
 * weight 700 / ink reading "Agentic Run Progress", then ONE arc — centred, 22px,
 * stroked in the indigo accent, spinning 1s linear — and nothing else.
 *
 * WHAT THIS USED TO DRAW, AND WHY IT WAS WRONG. It drew no title at all, a small
 * ink-toned spinner inside a 30px top-left tile, and the shipped
 * `ReviewGateLoading` five-bar skeleton as a nested panel under it. That reading
 * came from the request that opened cinatra#2997 — "maybe even an empty review
 * screen" — which the drawing has since settled: §IV's loading skeleton is a
 * DIFFERENT state, drawn while the host prepares a target that already exists,
 * and Components § Skeleton / Spinner steers against pairing the two marks in
 * one slot. The eighth proof round read all three back off the pixels in both
 * palettes; they are pinned now in
 * `__tests__/review-gate-placeholder-as-drawn.test.tsx`.
 *
 * THE TITLE BELONGS TO THIS COMPONENT, not to its hosts. All four mounts — the
 * run page's panel, the setup run page's review step, the orchestrator stepper's
 * terminal card and the conversation column inside the site widget — wrap it in
 * a card frame that draws no title of its own, so the card is named once here
 * and every host reads the same drawing.
 *
 * THE ARC IS THE DESIGN SYSTEM'S. `SpinnerArc` from `@cinatra-ai/sdk-ui` is
 * Components § Skeleton / Spinner drawn once — the ratified path
 * (`M21 12a9 9 0 1 1-6.219-8.56`) with no ring behind it, which is what "the
 * indigo arc" means and what the sibling `LoadingSpinner` (arc over a
 * 25%-opacity track ring) is not.
 *
 * AND ITS ARC IS INDIGO, ON A REGISTERED TOKEN (cinatra#3044). The drawing
 * fixes this icon as "the indigo arc"; the spinner paints with `currentColor`,
 * so the arc is whatever colour this wrapper sets. It set `text-mustard-ink`,
 * and no `--color-mustard-ink` is registered in the theme block — so the utility
 * emitted no rule at all and the arc silently took the INHERITED foreground,
 * measured as rgb(21,33,58) in light and rgb(248,250,252) in dark. `text-primary`
 * is the registered indigo the drawing names, and it is the same token the
 * chosen row's edge takes, so the arc and the edge can never drift apart. In the
 * dark theme that token resolves to the application's near-white dark primary —
 * the dark-token deviation this branch already records for the row and the
 * floor, which now covers the arc with them rather than as a second item.
 *
 * Conformance anchor: `review-gate-placeholder`.
 */
const REVIEW_GATE_PLACEHOLDER_TITLE_ID = "review-gate-placeholder-title";

export function ReviewGatePlaceholder() {
  return (
    <div
      data-conformance-id="review-gate-placeholder"
      // A busy REGION, named for a reader who cannot see the spin. The card names
      // itself on screen now, so the region takes its accessible name FROM THAT
      // TITLE — `role="status"` is not named from its contents, so the name has
      // to be pointed at explicitly (convergence round: dropping the old
      // `aria-label` without this left the region unnamed) rather than carrying a
      // second, invisible label that could drift from the drawn one.
      role="status"
      aria-busy="true"
      aria-labelledby={REVIEW_GATE_PLACEHOLDER_TITLE_ID}
      className="w-full"
    >
      <p
        id={REVIEW_GATE_PLACEHOLDER_TITLE_ID}
        data-placeholder-title="agentic-run-progress"
        className="font-sans text-sm font-bold text-foreground"
      >
        Agentic Run Progress
      </p>
      <div className="grid w-full place-items-center pb-[22px] pt-[26px]">
        <SpinnerArc className="size-[22px] text-primary" />
      </div>
    </div>
  );
}
