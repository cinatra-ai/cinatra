"use client";

import { useRouter } from "next/navigation";
import { CheckCheck, CircleX, RotateCcw } from "lucide-react";
import { LoadingSpinner } from "@cinatra-ai/sdk-ui";

import { Button } from "@/components/ui/button";
import {
  reviewBlockedCopy,
  reviewSettledCopy,
  type ReviewBlockedReason,
  type ReviewSettledOutcome,
} from "@/lib/artifacts/review-surface-model";

/**
 * The gate-level BLOCKED state (cinatra#1795 S12 item 4; spec design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f §V):
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
 * §4.2). The card that knows what happened says so — "Continued", "Rejected",
 * "Superseded" — over the shipped sentence for that outcome, and with the
 * recorded suggestion chips still drawn above it by the caller.
 *
 * AND IT NAMES NO PERSON (cinatra#3080, fix leg 6). This block read
 * "Superseded by {name}" on the sixth reading; the ratified drawing names nobody
 * in any settled marker it draws — see `reviewSettledCopy`, where the four
 * drawn markers are quoted. The decider is still carried on the wire for the
 * audit trail and is simply not drawn here.
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
export function ReviewGateSettled({ outcome }: { outcome: ReviewSettledOutcome }) {
  const copy = reviewSettledCopy(outcome);
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
 * THE RUN CARD'S PLACEHOLDER FOR THE REVIEW SCREEN (cinatra#2997).
 *
 * The maintainer's words are the whole specification, so they are quoted rather
 * than paraphrased:
 *
 *   "The 'Agentic Run Progress' card should basically just be a card (maybe even
 *    an empty review screen) with a spinning icon which is a temporary
 *    placeholder for the review screen. Once the agent is done and the output
 *    generated, that 'Agentic Run Progress' card is being automatically replaced
 *    with the 'Review requested' screen."
 *
 * So this draws A CARD, THE EMPTY REVIEW SCREEN, AND A SPINNING ICON — and
 * nothing else. There is no heading, no status word, no progress sentence and no
 * step list, because the words authorize none of those and the card they
 * describe is defined by what it does NOT say: it is the review screen's own
 * frame, empty, while the screen is still coming.
 *
 * WHY IT LIVES BESIDE THE REVIEW STATES rather than in the run panel. It is one
 * of the review screen's states — the one before the gate exists — and it is
 * built from the two pieces the review screen is already built from: the same
 * 30px header tile the gate header draws its clipboard mark in, and the shipped
 * `ReviewGateLoading` bar motif. Keeping it here is what makes the swap read as
 * one card changing rather than two cards trading places, and it is why the
 * replacement needs no new geometry: the placeholder and the screen that
 * replaces it are the same box.
 *
 * THE SPINNER IS THE DESIGN SYSTEM'S. `LoadingSpinner` from `@cinatra-ai/sdk-ui`
 * — the same component the orchestrator stepper's executing card spins — not a
 * second spinner drawn here.
 *
 * Conformance anchor: `review-gate-placeholder`.
 */
export function ReviewGatePlaceholder() {
  return (
    <div
      data-conformance-id="review-gate-placeholder"
      // A busy REGION, named for a reader who cannot see the spin. The label is
      // not copy on the card — nothing is drawn from it — it is the accessible
      // name of a region that is deliberately wordless.
      role="status"
      aria-busy="true"
      aria-label="Working"
      className="flex w-full flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="grid size-[30px] flex-none place-items-center rounded-lg bg-mustard-ink/15 text-mustard-ink">
          <LoadingSpinner className="size-4" />
        </span>
      </div>
      <ReviewGateLoading />
    </div>
  );
}
