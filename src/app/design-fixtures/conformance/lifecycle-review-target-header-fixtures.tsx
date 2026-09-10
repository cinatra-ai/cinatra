"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness for the ARTIFACT-KIND cards of the
// in-conversation review card (cinatra#3157, epic #3155 W1).
//
// Renders the REAL `ReviewTargetHeaders` — the immutable target header of the
// review screen's drawing §IV, drawn by the review card itself and exported from
// that card's own owner module — one mount per artifact kind the drawing draws,
// so the assertions in
// tests/e2e/design/conformance/contract.ts run against the shipped header rather
// than against a stand-in.
//
// WHY THIS PART OF THE CARD, AND WHAT IT IS NOT. That header is the one thing
// every artifact kind shares: the kinds differ in the representation the island
// renders beneath the header, and they are identical on the header itself. The
// header is also the one part of the card a harness can mount as the product
// mounts it: it is props-only, and it is drawn in EVERY island state, which is
// the whole reason it moved out of the island (cinatra#3141 item 7). The
// representation below it is server-rendered inside the island document; no
// per-kind representation ships on the default branch, so nothing here draws or
// asserts one, and the manifest's `representation.*` field bindings stay on this
// wave's readiness list instead of being approximated through a different value.
//
// NOTHING IS INTERCEPTED. There is no transport substitution of any kind here:
// no fetch wrapper, no route stub, no seeded server answer. `ReviewTargetHeaders`
// takes the headers the resolve answer composed and draws them, so mounting it
// needs none.
//
// THE HARNESS COMPOSES NOTHING THE PRODUCT COMPOSES. A fixture row carries the
// stored artifact's own values and stops there; the two readings the header
// draws over them — the type TAG's label and the meta line's row FACTS — are
// composed HERE by the product's own `artifactKindLabelFor` and
// `reviewTargetRowFacts`, which are the same two calls the server-side composer
// makes (src/lib/lifecycle/lifecycle-target-headers.ts:154). So this mount is
// the shipped chain composer → component with the transport left out, and a
// driver over it cannot be satisfied by a reading the shipped composer would
// never produce. Handing the component a finished `facts` array instead would
// have made every fact assertion an echo of the harness's own prop.
//
// The relative updated reading is taken against the fixture module's fixed
// instant rather than the wall clock, which is exactly why
// `reviewTargetRowFacts` takes that instant as an argument.
//
// Kept OFF the pixel-diffed /design-fixtures index page (same convention as the
// other conformance fixtures): coverage here is assertion-based —
// tests/e2e/design/conformance/functional-acceptance.spec.ts.
// ---------------------------------------------------------------------------

import type { ReactElement } from "react";

import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { ReviewTargetHeaders } from "@cinatra-ai/agents/review-gate-card";

import { artifactKindLabelFor } from "@/lib/artifacts/artifact-kind-label";
import { reviewTargetRowFacts } from "@/lib/artifacts/review-surface-model";

import {
  LIFECYCLE_REVIEW_TARGET_HEADER_FIXTURES,
  LIFECYCLE_REVIEW_TARGET_HEADER_NOW,
  type LifecycleReviewTargetHeaderFixture,
} from "./lifecycle-review-target-header-fixture-data";

function ReviewTargetHeaderFixture({
  fixture,
}: {
  fixture: LifecycleReviewTargetHeaderFixture;
}): ReactElement {
  const now = new Date(LIFECYCLE_REVIEW_TARGET_HEADER_NOW);
  const headers = fixture.headers.map((seed) => ({
    title: seed.title,
    objectType: seed.objectType,
    revisionId: seed.revisionId,
    // Both readings are worded by the SURFACE MODEL, never by the harness —
    // the same two calls the server-side composer makes.
    typeLabel: artifactKindLabelFor(seed.objectType),
    facts: reviewTargetRowFacts(seed.row, now),
  }));

  return (
    <div data-surface-id={fixture.surfaceId} className="flex flex-col gap-2">
      {/* The IN-THREAD host. The header is host-independent by design — the same
          reading is drawn on every host the card appears on — and the
          declaration is what makes this mount the in-conversation one. */}
      <LifecycleCardSurfaceProvider host="chat_thread">
        <ReviewTargetHeaders headers={headers} />
      </LifecycleCardSurfaceProvider>
    </div>
  );
}

/**
 * The in-conversation artifact-kind cards, one fixture row per manifest surface
 * the family covers.
 */
export function LifecycleReviewTargetHeaderFixtures(): ReactElement {
  return (
    <div className="flex flex-col gap-10">
      {LIFECYCLE_REVIEW_TARGET_HEADER_FIXTURES.map((fixture) => (
        <ReviewTargetHeaderFixture key={fixture.surfaceId} fixture={fixture} />
      ))}
    </div>
  );
}
