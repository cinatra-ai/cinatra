"use client";

import { useRouter } from "next/navigation";
import { CircleX } from "lucide-react";
import { LoadingSpinner } from "@cinatra-ai/sdk-ui";

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
 * ONE BORDERED INLINE ROW, NOT A CENTRED STACK (cinatra#3080, fix leg 7). The
 * eighth proof round measured a 144-css-px centred block here — a tinted icon
 * disc over a heading over a centred sentence — against the drawing, which draws
 * the settled marker as a single bordered row below the whole gate: `display:
 * flex; align-items:center; gap:8px; border:1px solid var(--line);
 * border-radius:8px; padding:9px 12px; margin-top:10px`, holding the approved
 * pill with its dot beside a muted twelve-pixel sentence. The icon disc appears
 * in no settled marker the drawing draws.
 *
 * Conformance anchor: `review-gate-settled`.
 */
export function ReviewGateSettled({ outcome }: { outcome: ReviewSettledOutcome }) {
  const copy = reviewSettledCopy(outcome);
  // The status palette's own tokens, in the dot-and-pill shape the drawing draws
  // and the shipped status chips already use.
  const tone =
    outcome === "approved"
      ? { pill: "border-success/40 bg-success/15 text-success", dot: "bg-success" }
      : outcome === "rejected"
        ? { pill: "border-destructive/40 bg-destructive/15 text-destructive", dot: "bg-destructive" }
        : { pill: "border-warning/40 bg-warning/15 text-warning", dot: "bg-warning" };
  return (
    <div
      data-conformance-id="review-gate-settled"
      data-review-outcome={outcome}
      className="mt-2.5 flex flex-wrap items-center gap-2 rounded-control border border-line bg-surface px-3 py-2.5"
    >
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tone.pill}`}
      >
        <span
          data-review-settled-dot=""
          aria-hidden="true"
          className={`size-[7px] rounded-full ${tone.dot}`}
        />
        {copy.title}
      </span>
      <span className="text-xs text-muted-foreground">{copy.body}</span>
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
 * nothing else, under the card's own NAME. The section's worked example draws
 * that fixed name as the box's first child, so the heading stays; what the prose
 * forbids is a status word, a result and a control, and a fixed card name is
 * none of the three. There is no status word, no progress sentence and no step
 * list, because the words authorize none of those: it is the review screen's own
 * frame, empty but named, while the screen is still coming.
 *
 * WHY IT LIVES BESIDE THE REVIEW STATES rather than in the run panel. It is one
 * of the review screen's states — the one before the gate exists — and it is
 * built from the piece the review screen is already built from: the same 30px
 * header tile the gate header draws its clipboard mark in. Keeping it here is
 * what makes the swap read as one card changing rather than two cards trading
 * places, and it is why the replacement needs no new geometry of its own: the
 * placeholder and the screen that replaces it stand in the SAME BOX, the one
 * the enclosing surface draws. They are not the same HEIGHT and nothing here
 * claims they are -- no minimum-height contract exists on this slot, and a
 * placeholder that reserved the finished screen's height would be reporting a
 * result it does not have.
 *
 * AND IT CARRIES THE CARD'S OWN NAME (cinatra#3044, the eleventh set). The
 * drawing's placeholder example is markup, and its first child is the heading
 * "Agentic Run Progress" at weight 700, 14px, `var(--ink)`. The same section's
 * prose says the placeholder "names no status, reports no result and draws
 * nothing to press", and an earlier set read that as "no text at all". The two
 * readings settle once each clause's subject is read: what is forbidden is a
 * STATUS word, a RESULT and a CONTROL. A fixed card name is none of the three —
 * it is the name §II itself uses for this card in prose. So the card names
 * itself and still names no status.
 *
 * AND IT DRAWS THE TWO THINGS THE SENTENCE ENUMERATES, NEVER A THIRD
 * (cinatra#3044). This used to draw the shipped `ReviewGateLoading` bar motif
 * beneath the tile as well — two bars in a header band over three in a body
 * band — and a graded set measured them. No sentence gives them: the drawing
 * says the placeholder is "the card frame, and a spinning icon, the indigo arc
 * of Components § Skeleton / Spinner", and its own placeholder example draws
 * the card box with one arc in it and nothing else. Bars beside the arc are a
 * third thing, and one that reads as content arriving when nothing has. The bar
 * motif keeps its own job — it is the GATE's loading state, drawn in the target
 * slots while the host prepares them — and that use is untouched.
 *
 * THE SPINNER IS THE DESIGN SYSTEM'S. `LoadingSpinner` from `@cinatra-ai/sdk-ui`
 * — the same component the orchestrator stepper's executing card spins — not a
 * second spinner drawn here.
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
export function ReviewGatePlaceholder() {
  return (
    <div
      data-conformance-id="review-gate-placeholder"
      // A busy REGION, named for a reader who cannot see the spin. The label is
      // not copy on the card — nothing is drawn from it — it is the accessible
      // name of a region whose only words are the card's own fixed name.
      role="status"
      aria-busy="true"
      aria-label="Working"
      className="flex w-full flex-col gap-3"
    >
      {/* THE CARD'S OWN NAME, the heading the drawn placeholder puts at its
          head: `font-weight:700; font-size:14px; color:var(--ink)`. It is not
          a status word and not a result — it is the fixed name §II uses for
          this card in its own prose ("the run progress card"), identical on
          every run. The drawing's `--ink` is #15213a, and the token registered
          at that value here is `--foreground`. */}
      <div className="text-sm font-bold text-foreground">Agentic Run Progress</div>
      {/* THE ARC SITS ON THE CARD'S CENTRE. The drawn band is
          `display:grid; place-items:center; padding:26px 0 22px` — the full
          width of the card with the arc in the middle of it. It used to be a
          left-aligned `flex flex-wrap items-center` row, which put the arc hard
          against the card's leading edge. Nothing else goes in this band: a
          sibling here pulls the arc off the centre exactly as the row did. */}
      <div className="grid w-full place-items-center pt-[26px] pb-[22px]">
        <span className="grid size-[30px] flex-none place-items-center rounded-lg bg-mustard-ink/15 text-primary">
          <LoadingSpinner className="size-4" />
        </span>
      </div>
    </div>
  );
}
