"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness for the ONE-OFF surfaces of the in-conversation
// lifecycle drawing (cinatra#3165, epic #3155 W9).
//
// Four of this wave's twelve surfaces are addressable on the default branch,
// and each is mounted here from the component that SHIPS it — the review
// target's header, the gate's loading skeleton, the gate's "no longer open"
// panel, the run-progress placeholder, and the chip row §IX's READER matrix is
// drawn with. Nothing is reimplemented, restyled or approximated.
//
// WHY THERE IS NO PRESENCE MATRIX HERE. §IX's presence claim is about what the
// HOST DECLARATION does to a card, so only a card that READS that declaration
// can grade it — and every shipped one resolves its body through the
// lifecycle-card transport before it draws at all. The chip row this file can
// mount props-only does not read the host: dropped into four providers it draws
// four identical rows whatever the declaration says. A matrix built from it
// would grade this harness, not the drawing, so `presence-matrix` is on the
// wave's surface-readiness list instead. The withheld reader reading goes with
// it, for the same reason: an empty suggestion set is not a reader who may not
// read the target.
//
// NOTHING IS INTERCEPTED. There is no transport substitution of any kind: no
// fetch wrapper, no route stub, no seeded server answer. Every component
// mounted here is props-only, so mounting it needs none. The one thing a mount
// supplies that is not a literal is the review target's TYPE LABEL, and even
// that is not written down — it is derived by the shipped `reviewTypeLabel`, so
// the binding the driver grades is the product's own.
//
// THE HARNESS NAMES NO READING. Which mode the chip row is in, which control it
// offers, what the read-only sentence says, what the blocked panel is titled and
// what the placeholder draws are all computed by the shipped components from the
// inputs below. The harness supplies inputs and a `data-surface-id`; the product
// supplies every word on screen.
//
// WHY THE DECISION FLOOR IS NOT HERE. The repository's one-card gate
// (`scripts/audit/chat-hitl-one-card-gate.mjs`, rule
// `page-direct-decision-composition`) bans composing `ReviewDecisionBar`
// anywhere but the card, because a second place that composes the floor is a
// second place a decision could come to mean something different. A conformance
// harness is such a place. The floor surfaces are therefore on this wave's
// surface-readiness list rather than mounted from a look-alike.
//
// Kept OFF the pixel-diffed /design-fixtures index page (same convention as the
// other conformance fixtures): coverage here is assertion-based —
// tests/e2e/design/conformance/functional-acceptance.spec.ts.
// ---------------------------------------------------------------------------

import type { ReactElement } from "react";

import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { ReviewTargetHeader, SuggestionChips } from "@cinatra-ai/agents/review-gate-card";
import { ReviewGateBlocked, ReviewGateLoading, ReviewGatePlaceholder } from "@cinatra-ai/agents/review-gate-states";
import { reviewTypeLabel } from "@/lib/artifacts/review-surface-model";

import {
  LIFECYCLE_MATRIX_SUGGESTION,
  LIFECYCLE_READER_STATES,
  LIFECYCLE_REVIEW_BLOCKED_REASON,
  LIFECYCLE_REVIEW_TARGET_FIXTURE,
  type LifecycleReaderState,
} from "./lifecycle-one-off-fixture-data";

/**
 * The pinned target's header, composed the way the review surface model
 * composes a real one: the title as authored, and the TYPE LABEL derived from
 * the type id by the shipped `reviewTypeLabel`. The harness writes no label.
 */
const REVIEW_TARGET_HEADER = {
  title: LIFECYCLE_REVIEW_TARGET_FIXTURE.title,
  typeLabel: reviewTypeLabel(LIFECYCLE_REVIEW_TARGET_FIXTURE.objectType),
  objectType: LIFECYCLE_REVIEW_TARGET_FIXTURE.objectType,
  revisionId: LIFECYCLE_REVIEW_TARGET_FIXTURE.revisionId,
  facts: [...LIFECYCLE_REVIEW_TARGET_FIXTURE.facts],
};

/** The chip row one matrix cell draws, in the reading that cell stands for. */
function ReaderCell({ reader }: { reader: LifecycleReaderState }): ReactElement {
  // The two readings are two different INPUTS to the shipped component, and they
  // are the PRODUCT's own two: the review card hands the chip row `onToggleMark`
  // exactly when the reader may decide, and omits it otherwise.
  //   may-view-and-act  — a mark handler, so the row is live and its chip is a
  //                       real press target;
  //   may-view-not-act  — no mark handler, so the row is read-only: plain
  //                       elements with no press target and the component's own
  //                       reason sentence.
  // The third reading of §IX — a reader who may not read the target at all — is
  // NOT drawn here from an empty suggestion set: that would assert what an empty
  // list does, not what a denied reader gets. It is on the readiness list.
  return (
    <div data-reader-state={reader}>
      {reader === "may-view-and-act" ? (
        <SuggestionChips
          suggestions={[LIFECYCLE_MATRIX_SUGGESTION]}
          dismissed={{}}
          onToggleMark={() => {}}
        />
      ) : (
        <SuggestionChips suggestions={[LIFECYCLE_MATRIX_SUGGESTION]} dismissed={{}} />
      )}
    </div>
  );
}

/**
 * The one-off surfaces of the in-conversation lifecycle drawing that are
 * addressable today.
 */
export function LifecycleOneOffFixtures(): ReactElement {
  return (
    <div className="flex flex-col gap-10">
      {/* §II — the review card's TARGET panel, in the assistant's turn. The
          three readings the manifest declares for it: the header itself, the
          gate's loading skeleton, and §IV's "no longer open" panel. */}
      <LifecycleCardSurfaceProvider host="chat_thread">
        <div
          data-surface-id="review-target-in-thread"
          data-variant="populated"
          data-review-target-title={LIFECYCLE_REVIEW_TARGET_FIXTURE.title}
          data-review-target-object-type={LIFECYCLE_REVIEW_TARGET_FIXTURE.objectType}
        >
          <ReviewTargetHeader header={REVIEW_TARGET_HEADER} />
        </div>
        <div data-surface-id="review-target-in-thread" data-variant="loading">
          <ReviewGateLoading />
        </div>
        <div data-surface-id="review-target-in-thread" data-variant="error">
          <ReviewGateBlocked reason={LIFECYCLE_REVIEW_BLOCKED_REASON} />
        </div>

        {/* §II — the placeholder BEFORE the output is generated. It has one
            reading and that reading is the loading one: the card's own name, an
            arc, and nothing to press. */}
        <div data-surface-id="run-progress-placeholder-in-thread" data-variant="populated">
          <ReviewGatePlaceholder />
        </div>
      </LifecycleCardSurfaceProvider>

      {/* §XIII.1 — the SAME review states outside a conversation, in the run
          page's own gate region. Same components, same readings; only the host
          declaration changes, which is the section's whole claim. */}
      <LifecycleCardSurfaceProvider host="page_gate_region">
        <div
          data-surface-id="review-states-outside-chat"
          data-variant="populated"
          data-review-target-title={LIFECYCLE_REVIEW_TARGET_FIXTURE.title}
          data-review-target-object-type={LIFECYCLE_REVIEW_TARGET_FIXTURE.objectType}
        >
          <ReviewTargetHeader header={REVIEW_TARGET_HEADER} />
        </div>
        <div data-surface-id="review-states-outside-chat" data-variant="loading">
          <ReviewGateLoading />
        </div>
        <div data-surface-id="review-states-outside-chat" data-variant="error">
          <ReviewGateBlocked reason={LIFECYCLE_REVIEW_BLOCKED_REASON} />
        </div>
      </LifecycleCardSurfaceProvider>

      {/* §IX — the reader matrix. What holds a card back is the reader, and the
          two readings mounted here are the shipped component's own, computed
          from the two inputs the review card itself hands it. */}
      <LifecycleCardSurfaceProvider host="chat_thread">
        <div data-surface-id="reader-state-matrix" data-variant="populated" className="flex flex-col gap-4">
          {LIFECYCLE_READER_STATES.map((reader) => (
            <ReaderCell key={reader} reader={reader} />
          ))}
        </div>
      </LifecycleCardSurfaceProvider>
    </div>
  );
}
