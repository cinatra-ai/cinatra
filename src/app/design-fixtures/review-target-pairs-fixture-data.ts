// ---------------------------------------------------------------------------
// Fixture data for the LEGACY TWO-TARGET PENDING review gate (cinatra#4129).
//
// A review gate opened before reviews became one per artifact, and still
// pending, can pin two targets. No such gate can be minted any more, so the
// drawing of one is shown here, on a fixture, with two distinct pinned targets.
//
// The rows follow the header fixture's rule
// (./conformance/lifecycle-review-target-header-fixture-data.ts): a row carries
// the stored artifact's own values and the owner name the host would have
// resolved, and nothing the product composes. The type
// tag and the row facts are composed by the product's own calls in
// ./review-target-pairs-fixture.tsx. The two type ids are artifact kinds that
// file already carries, under the same stand-in vendor scope.
//
// This fixture lives ON the photographed /design-fixtures index page on
// purpose: that page is the only page the pixel comparison photographs, in the
// light and the dark palette, and its two snapshots are the only ones the
// baseline refresh draws.
// ---------------------------------------------------------------------------

import type { LifecycleReviewTargetHeaderSeed } from "./conformance/lifecycle-review-target-header-fixture-data";

/**
 * The instant every row's relative updated reading is taken against, so the
 * drawn line is the same in every run.
 */
export const REVIEW_TARGET_PAIRS_NOW = "2026-09-02T12:00:00.000Z";

/** The two pinned targets of the gate, in gate order. */
export const REVIEW_TARGET_PAIRS_TARGETS: readonly LifecycleReviewTargetHeaderSeed[] = [
  {
    title: "Launch announcement — first draft",
    objectType: "@acme/email-body:body",
    revisionId: "rev_3e90",
    row: {
      ownerLevel: "team",
      ownerName: "Growth",
      visibility: "private",
      mime: "text/markdown",
      updatedAt: "2026-09-02T11:40:00.000Z",
    },
  },
  {
    title: "Board update — October",
    objectType: "@acme/slide-deck:artifact",
    revisionId: "rev_b7d5",
    row: {
      ownerLevel: "team",
      ownerName: "Growth",
      visibility: "private",
      mime: "application/pdf",
      updatedAt: "2026-09-01T16:05:00.000Z",
    },
  },
];
