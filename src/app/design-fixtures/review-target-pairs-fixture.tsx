"use client";

// ---------------------------------------------------------------------------
// The LEGACY TWO-TARGET PENDING review gate, as the run detail draws it
// (cinatra#4129).
//
// It mounts the REAL `PairedReviewTargets`: the exact component the review card
// mounts for a pending gate that pins several targets, under the run detail's
// card host. It is not a stand-in and not the whole card: the whole card needs
// the resolve answer of a real gate, which a page with no session cannot have,
// and the decision floor is drawn only by the card.
//
// THE BODY FAILS, AND ALWAYS THE SAME WAY. Each island frame is pointed at the
// card's own island path with a credential parameter whose value is not a
// credential. The island refuses that value before it reads anything and
// answers its one empty denial document, with no session and no redirect to
// sign-in. The card reads that denial and draws its failed-body plate. So in
// both palettes the end state is fixed: two pairs, each header directly above
// its own failed body.
// ---------------------------------------------------------------------------

import type { ReactElement } from "react";

import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import {
  PairedReviewTargets,
  REVIEW_TARGET_ISLAND_PATH,
} from "@cinatra-ai/agents/review-gate-card";

import { artifactKindLabelFor } from "@/lib/artifacts/artifact-kind-label";
import { reviewTargetRowFacts } from "@/lib/artifacts/review-surface-model";

import {
  REVIEW_TARGET_PAIRS_NOW,
  REVIEW_TARGET_PAIRS_TARGETS,
} from "./review-target-pairs-fixture-data";

/**
 * The island's credential parameter. Written as the literal here: it is
 * `REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM` in
 * src/lib/lifecycle/review-island-credential.ts and the card's own
 * `REVIEW_ISLAND_CREDENTIAL_PARAM`, and neither is imported into this client
 * module.
 */
const ISLAND_CREDENTIAL_PARAM = "ic";

/** The island address: a fixed gate ref and a value that is NOT a credential. */
const ISLAND_SRC = `${REVIEW_TARGET_ISLAND_PATH}?${new URLSearchParams({
  ref: "design-fixture-legacy-gate",
  [ISLAND_CREDENTIAL_PARAM]: "design-fixture-not-a-credential",
}).toString()}`;

export function ReviewTargetPairsFixture(): ReactElement {
  const now = new Date(REVIEW_TARGET_PAIRS_NOW);
  const headers = REVIEW_TARGET_PAIRS_TARGETS.map((seed) => ({
    title: seed.title,
    objectType: seed.objectType,
    revisionId: seed.revisionId,
    // Both readings are worded by the product's own calls, never by the fixture.
    typeLabel: artifactKindLabelFor(seed.objectType),
    facts: reviewTargetRowFacts(seed.row, now),
  }));

  return (
    <div data-fixture="review-target-pairs">
      <LifecycleCardSurfaceProvider host="run_card">
        <PairedReviewTargets
          headers={headers}
          islandSrc={ISLAND_SRC}
          islandCredentialed={false}
          onRetryResolve={() => {
            // Nothing to resolve again: the fixture has no gate behind it.
          }}
        />
      </LifecycleCardSurfaceProvider>
    </div>
  );
}
