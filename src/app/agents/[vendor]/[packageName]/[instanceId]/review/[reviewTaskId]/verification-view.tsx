import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { VerificationSummaryCard } from "@cinatra-ai/agents/verification-summary-card";

/**
 * The run-embedded VERIFICATION region (cinatra#2042, re-anchored 2026-07-25) —
 * reached from the run rail's "Audit" entry (`?view=verification`).
 *
 * WHAT MOVED, AND WHAT DID NOT (cinatra#2789, epic #2784 S9e). This component
 * used to DRAW §VII itself: the Core-analysis chrome, the outcome pill, the
 * revision pins, the before/after table and the advisory comments were all
 * composed here, and the same reading in a chat transcript drew the S1 shell
 * instead. That was the epic's parallel-renderer problem in its plainest form —
 * two drawings of one reading, free to drift — so the CORE is now
 * `VerificationSummaryCard`, the one component the chat thread, the run card
 * and this page all mount, and this page draws nothing beside it.
 *
 * WHY THERE IS NO PICTURE PAIR (cinatra#3862 leg 8). The page used to draw a
 * page-only adjunct under the card: the reviewed and the applied pictures read
 * from pinned captures. Section VII draws the reading with no picture block ("on the
 * run's own review page the same regions sit unframed in the page column"), and
 * the lifecycle cards spec, section III, says a pinned capture pair is not
 * drawn anywhere. So the adjunct went, and the page is the one core alone.
 *
 * WHY THERE IS NO "BACK TO THE REVIEW GATE" LINK ANY MORE (plan §8.3(5), §8.4,
 * resolved by this slice). The link was never in the design: "it exists because
 * the reading lives on its own page today; the drawn card has no link and no
 * buttons at all, so the link goes when the card lands" (§8.3, row 5). §8.4's
 * as-designed sequence says the same from the reader's side — "on the review
 * page the same regions sit unframed in the page column, and there is no back
 * link, because the reading is no longer a separate place you had to travel
 * to". The card landing IS that condition, so the link goes with it here.
 * §VII's own no-floor rule points the same way: the reading "asks nothing, so
 * it draws nothing to press", and a route affordance welded to the bottom of an
 * advisory is the last thing on this surface that could be pressed. The reader
 * reaches the gate the way they reached this reading — the run's step rail —
 * and the browser's own back.
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
}

export function VerificationView({ cardRef }: VerificationViewProps) {
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
    </div>
  );
}
