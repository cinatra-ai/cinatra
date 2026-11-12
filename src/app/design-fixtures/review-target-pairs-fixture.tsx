"use client";

// ---------------------------------------------------------------------------
// The LEGACY TWO-TARGET PENDING review gate, as the run detail draws it
// (cinatra#4188; the drawing is cinatra#4129's).
//
// It mounts the REAL `PairedReviewTargets`: the exact component the review card
// mounts for a pending gate drawn as pairs, under the run detail's card host
// (`run_card`) and in the run detail's card column. Not the whole card: the
// whole card needs the resolve answer of a real gate, which a page with no
// session cannot have.
//
// EVERY READING IS THE PRODUCT'S. The headers are composed by the header
// fixture's `reviewTargetFixtureHeader` (the product's own composers); the pair
// keys by `reviewGateTargetPairKeys`, the card's own rule for a gate drawn as
// pairs; each island address by `composeReviewIslandAddress`, the one composer
// of an island address; and each pair is the shape the card's per-target branch
// emits for an address that carries a credential.
//
// THE BODY FAILS, AND ALWAYS THE SAME WAY. Each frame's credential parameter
// holds a value that is not a credential. The island's credential branch
// refuses it before it reads anything and serves its one empty denial
// document; the card reads that denial and draws its failed-body plate. A frame
// whose load the card misses ends on the same plate at its 12-second bound. So
// in both palettes the end state is fixed: two pairs, each one bordered panel
// whose header sits directly above its own failed body.
// ---------------------------------------------------------------------------

import type { ReactElement } from "react";

import {
  composeReviewIslandAddress,
  reviewGateTargetPairKeys,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import {
  PairedReviewTargets,
  type ReviewTargetPair,
} from "@cinatra-ai/agents/review-gate-card";

import { reviewTargetFixtureHeader } from "./conformance/lifecycle-review-target-header-fixtures";
import {
  REVIEW_TARGET_PAIRS_GATE_REF,
  REVIEW_TARGET_PAIRS_NOT_A_CREDENTIAL,
  REVIEW_TARGET_PAIRS_NOW,
  REVIEW_TARGET_PAIRS_TARGETS,
} from "./review-target-pairs-fixture-data";

export function ReviewTargetPairsFixture(): ReactElement {
  const now = new Date(REVIEW_TARGET_PAIRS_NOW);
  const headers = REVIEW_TARGET_PAIRS_TARGETS.map((seed) => reviewTargetFixtureHeader(seed, now));
  // The card's own rule: a complete answer of several distinct exact ids is
  // drawn as pairs. Fixture data that the rule would not pair is a broken
  // fixture, never a silent aggregate island.
  const keys = reviewGateTargetPairKeys(headers, true);
  if (keys === null) {
    throw new Error("review-target-pairs fixture: the seeded targets are not drawn as pairs");
  }
  const pairs: ReviewTargetPair[] = keys.map((target) => {
    const address = composeReviewIslandAddress({
      ref: REVIEW_TARGET_PAIRS_GATE_REF,
      credential: REVIEW_TARGET_PAIRS_NOT_A_CREDENTIAL,
      target,
    });
    return { target, island: address.ok ? { src: address.value, credentialed: true } : null };
  });

  // The run detail's card column (`flex w-full flex-col gap-3`): the space the
  // card puts between one pair's panel and the next.
  return (
    <div data-fixture="review-target-pairs" className="flex w-full flex-col gap-3">
      <LifecycleCardSurfaceProvider host="run_card">
        <PairedReviewTargets
          headers={headers}
          pairs={pairs}
          onRetryResolve={() => {
            // Nothing to resolve again: the fixture has no gate behind it.
          }}
        />
      </LifecycleCardSurfaceProvider>
    </div>
  );
}
