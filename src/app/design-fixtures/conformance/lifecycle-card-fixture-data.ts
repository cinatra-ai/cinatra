// ---------------------------------------------------------------------------
// Fixture data for the IN-CONVERSATION REVIEW DECISION FLOOR family
// (cinatra#3156, epic #3155 W0).
//
// The in-conversation lifecycle drawing draws ONE decision floor at the foot of
// every pending review gate, and draws the same floor on more than one surface
// (`review-decision-floor-in-thread`, `decision-floor-live-under-limit`, and the
// floor composed into the bound review-composer card). They differ in what the
// gate is and in the reader's standing on it, never in the floor itself — which
// is why they are driven by ONE family factory (`reviewFloorDriver`,
// tests/e2e/design/conformance/contract.ts) over this list, exactly as the six
// extension listing cards are driven by `cardDriver` over
// CONFORMANCE_CARD_FIXTURES.
//
// W0 lands ONE row and proves the road end to end; the later waves add rows.
//
// THIS FILE CARRIES NO PRODUCT BEHAVIOUR. A row names the manifest surface and
// the reader standing the floor is drawn for, and nothing else. What the floor
// DOES with that standing — which affordances are live, what a landed comment
// draws, whether the gate stays open — is decided entirely by the shipped
// component and the shipped outcome mapper.
// ---------------------------------------------------------------------------

export type LifecycleReviewFloorFixture = {
  /** The manifest surface id this row drives. */
  surfaceId: string;
  /**
   * The reader's standing on the gate, in the product's own shape
   * (`ReviewDecisionPermissions`): `canDecide` is approve access, `canComment`
   * is respond access. Structural, so a change to that type is a typecheck
   * failure where the row is handed to the floor.
   */
  permissions: { canDecide: boolean; canComment: boolean };
};

export const LIFECYCLE_REVIEW_FLOOR_FIXTURES: readonly LifecycleReviewFloorFixture[] = [
  {
    surfaceId: "review-decision-floor-in-thread",
    // A reviewer who may both respond and decide: the floor draws all three
    // shipped affordances live, which is the standing the drawing's in-thread
    // floor is drawn in.
    permissions: { canDecide: true, canComment: true },
  },
];
