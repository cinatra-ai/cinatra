"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness for the ONE-OFF surfaces of the in-conversation
// lifecycle drawing (cinatra#3165, epic #3155 W9).
//
// Five of this wave's twelve surfaces are addressable on the default branch,
// and each is mounted here from the component that SHIPS it — the review
// target's header, the gate's loading skeleton, the gate's "no longer open"
// panel, the run-progress placeholder, and the chip row the two §IX matrices
// are drawn with. Nothing is reimplemented, restyled or approximated.
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

import type { ReactElement, ReactNode } from "react";

import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { ReviewTargetHeader, SuggestionChips } from "@cinatra-ai/agents/review-gate-card";
import { ReviewGateBlocked, ReviewGateLoading, ReviewGatePlaceholder } from "@cinatra-ai/agents/review-gate-states";
import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { reviewTypeLabel } from "@/lib/artifacts/review-surface-model";

import {
  LIFECYCLE_MATRIX_SUGGESTION,
  LIFECYCLE_PRESENCE_HOSTS,
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

/**
 * A host declaration for one cell of the §IX presence matrix.
 *
 * A NON-COOKIE HOST MUST DECLARE ITS CREDENTIAL, and the provider refuses a
 * declaration that does not: `site_widget` is a brokered surface, so it carries
 * `credentials: "omit"` exactly as the embed does. Getting this wrong would not
 * fail loudly — the subtree would simply declare NO host — which is why the
 * matrix driver asserts the card is drawn in every cell.
 */
function HostCell({ host, children }: { host: LifecycleCardHost; children: ReactNode }): ReactElement {
  if (host === "site_widget") {
    return (
      <LifecycleCardSurfaceProvider host={host} auth={{ headers: () => ({}), credentials: "omit" }}>
        {children}
      </LifecycleCardSurfaceProvider>
    );
  }
  return <LifecycleCardSurfaceProvider host={host}>{children}</LifecycleCardSurfaceProvider>;
}

/** The chip row one matrix cell draws, in the reading that cell stands for. */
function ReaderCell({ reader }: { reader: LifecycleReaderState }): ReactElement {
  // The three readings are three different INPUTS to the shipped component, not
  // three presentations chosen here:
  //   may-view-and-act  — a mark handler, so the row is live and its chip is a
  //                       real press target;
  //   may-view-not-act  — no mark handler, so the row is read-only: plain
  //                       elements with no press target and the component's own
  //                       reason sentence;
  //   may-not-read      — nothing surfaced, so the component draws NO DOM at
  //                       all (§IX: absent is no card, never a disabled one).
  return (
    <div data-reader-state={reader}>
      {reader === "may-view-and-act" ? (
        <SuggestionChips
          suggestions={[LIFECYCLE_MATRIX_SUGGESTION]}
          dismissed={{}}
          onToggleMark={() => {}}
        />
      ) : reader === "may-view-not-act" ? (
        <SuggestionChips suggestions={[LIFECYCLE_MATRIX_SUGGESTION]} dismissed={{}} />
      ) : (
        <SuggestionChips suggestions={[]} dismissed={{}} />
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

      {/* §IX — presence. The SAME card, drawn under each of the four host
          declarations. Only the frame changes; the matrix fixes that the card
          appears at all, on every one of them. */}
      <div data-surface-id="presence-matrix" data-variant="populated" className="flex flex-col gap-4">
        {LIFECYCLE_PRESENCE_HOSTS.map((host) => (
          <div key={host} data-presence-host={host}>
            <HostCell host={host}>
              <SuggestionChips
                suggestions={[LIFECYCLE_MATRIX_SUGGESTION]}
                dismissed={{}}
                onToggleMark={() => {}}
              />
            </HostCell>
          </div>
        ))}
      </div>

      {/* §IX — the reader matrix. What holds a card back is the reader, and the
          three readings are the shipped component's own, computed from three
          different inputs. */}
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
