import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { VerificationSummaryCard } from "@cinatra-ai/agents/verification-summary-card";

import type { PinnedCapturePairView } from "@/lib/artifacts/cms-preview-capture-view";

import { ReviewPinnedCapture } from "./review-pinned-capture";

/**
 * The run-embedded VERIFICATION region (cinatra#2042, re-anchored 2026-07-25) —
 * reached from the run rail's "Core analysis" entry (`?view=verification`).
 *
 * WHAT MOVED, AND WHAT DID NOT (cinatra#2789, epic #2784 S9e). This component
 * used to DRAW §VII itself: the Core-analysis chrome, the outcome pill, the
 * revision pins, the before/after table and the advisory comments were all
 * composed here, and the same reading in a chat transcript drew the S1 shell
 * instead. That was the epic's parallel-renderer problem in its plainest form —
 * two drawings of one reading, free to drift — so the CORE is now
 * `VerificationSummaryCard`, the one component the chat thread, the run card
 * and this page all mount. The page-only ADJUNCTS stay here, because they are
 * genuinely the page's and no transcript could carry them:
 *
 *   · the PINNED VISUAL PAIR (#2044 L-D) — what was reviewed beside what was
 *     actually applied, with the read-back's out-of-scope paths outlined on the
 *     applied side. It is a server-side store read over pinned captures, sized
 *     for a page column; a card in a turn has neither the width nor the server
 *     pass to draw it.
 *   · the NAVIGATION back to the review gate — a route affordance, which only a
 *     route has.
 *
 * Neither is a second drawing of the reading. They compose AROUND the one core,
 * which is why deleting this file wholesale would have been the wrong move: it
 * would have taken the visual pair with it.
 *
 * THE PAGE PASSES A REF, NOT A READING. The card resolves its own body from the
 * server against the live reader, exactly as it does in a transcript, so this
 * surface cannot hand it a reading the resolver would not have authorized.
 */
export interface VerificationViewProps {
  /**
   * The gate-scoped card ref, minted server-side by the page. `null` when the
   * instance cannot mint one (no app secret) — the core then draws nothing
   * rather than falling back to a second composition.
   */
  cardRef: string | null;
  /** Link back to the review gate this audit annotates. */
  gateHref: string;
  /** S6 (#2044 L-D) — the reviewed/applied picture pair, when the target has
   * pinned captures. `null` for every target that has none (the reading then
   * reads exactly as it did before). */
  visualPair?: PinnedCapturePairView | null;
}

export function VerificationView({
  cardRef,
  gateHref,
  visualPair = null,
}: VerificationViewProps) {
  return (
    <div
      className="flex min-w-0 flex-1 flex-col gap-4"
      data-conformance-id="run-surface"
      data-surface="verification"
    >
      {/* §VII's core — the ONE renderer, on this page's host. */}
      <LifecycleCardSurfaceProvider host="page_gate_region">
        {cardRef ? (
          <VerificationSummaryCard
            view={{
              viewType: "verification_summary",
              schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
              ref: cardRef,
            }}
          />
        ) : null}
      </LifecycleCardSurfaceProvider>

      {/* PAGE-ONLY ADJUNCT — the field diff's VISUAL counterpart: reviewed vs
          applied, drift outlined from the record's own out-of-scope paths. */}
      <ReviewPinnedCapture pair={visualPair} />

      {/* PAGE-ONLY ADJUNCT — the route affordance back to the gate. */}
      <div>
        <Link
          href={gateHref}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-mustard-ink underline-offset-2 hover:underline"
          data-verification-back-to-gate=""
        >
          <ArrowLeft aria-hidden="true" className="size-3" />
          Back to the review gate
        </Link>
      </div>
    </div>
  );
}
