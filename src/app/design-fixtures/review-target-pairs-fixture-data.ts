// ---------------------------------------------------------------------------
// Fixture data for the LEGACY TWO-TARGET PENDING review gate (cinatra#4188,
// the design-fixtures card split from cinatra#4129).
//
// A review gate opened before reviews became one per artifact, and still
// pending, can pin two targets. No such gate can be minted any more, so its
// drawing is shown here, on a fixture, with two distinct pinned targets.
//
// The rows follow the header fixture's rule
// (./conformance/lifecycle-review-target-header-fixture-data.ts): a row carries
// the stored artifact's own values and the owner name the host would have
// resolved, and nothing the product composes. The header is composed by the
// header fixture's own `reviewTargetFixtureHeader`, which calls the product's
// composers; the pair keys and island addresses by the protocol's own
// projection section.
//
// This fixture lives ON the photographed /design-fixtures index page on
// purpose: that page is the only page the pixel comparison photographs, in the
// light and the dark palette.
// ---------------------------------------------------------------------------

import type { LifecycleReviewTargetHeaderSeed } from "./conformance/lifecycle-review-target-header-fixture-data";

/** The instant every row's relative updated reading is taken against. */
export const REVIEW_TARGET_PAIRS_NOW = "2026-09-02T12:00:00.000Z";

/** The gate ref the island addresses carry. Not an encrypted ref: the island
 *  refuses the credential below before it reads the ref. */
export const REVIEW_TARGET_PAIRS_GATE_REF = "design-fixture-legacy-gate";

/** A value in the island's credential parameter that is NOT a credential. The
 *  island's credential branch refuses it before it reads anything and serves
 *  its one empty denial document: no session, no sign-in redirect. */
export const REVIEW_TARGET_PAIRS_NOT_A_CREDENTIAL = "design-fixture-not-a-credential";

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
