// ---------------------------------------------------------------------------
// Fixture data for the SUGGESTION-CHIP family (cinatra#3156, epic #3155 W0).
//
// The in-conversation lifecycle drawing gives a surfaced suggestion ONE control
// and TWO drawn states: a suggestion arrives accepted, one press dismisses it,
// one press accepts it again — the toggle is its own inverse. The drawing's two
// chip surfaces are therefore the two ends of one shape, which is why they are
// driven by ONE family factory (`suggestionChipDriver`,
// tests/e2e/design/conformance/contract.ts) over this list, exactly as the six
// extension listing cards are driven by `cardDriver` over
// CONFORMANCE_CARD_FIXTURES.
//
// W0 lands ONE row and proves the road end to end; the later waves add rows.
//
// WHY A ROW NAMES A MOUNT AND NOT A MANIFEST SURFACE. Everywhere else in this
// harness `data-surface-id` IS the manifest surface id. The chips are the one
// place that cannot be: the suggestion chip's spec anchors may appear as a
// literal in exactly one production module — the card that draws them — and the
// repository proves it by scanning (src/lib/lifecycle/__tests__/
// suggestion-chips-one-renderer.test.ts). So a row names its MOUNT here, and the
// binding from mount to manifest surface lives on the test side, in the driver
// map. Nothing is weakened by that: the driver still keys on the manifest
// surface id, and the one-renderer scan keeps meaning exactly what it says.
//
// THIS FILE CARRIES NO PRODUCT BEHAVIOUR. A row names the mount and the one
// surfaced suggestion the harness draws, in the protocol's own shape. Which
// state that suggestion is drawn in, which control the chip offers, and what
// that control is named are all decided by the shipped component.
// ---------------------------------------------------------------------------

import type { LifecycleSuggestion } from "@cinatra-ai/agent-ui-protocol/renderable-views";

/** The mounts this family draws. One per row, and the driver map binds each to
 *  the manifest surface it stands for. */
export const LIFECYCLE_SUGGESTION_CHIP_MOUNTS = ["chip-row-live", "chip-row-dismissed"] as const;

export type LifecycleSuggestionChipMount = (typeof LIFECYCLE_SUGGESTION_CHIP_MOUNTS)[number];

export type LifecycleSuggestionChipFixture = {
  /** The harness mount this row draws, carried as `data-surface-id`. */
  mount: LifecycleSuggestionChipMount;
  /**
   * The surfaced suggestion, in the protocol's own type — so a change to what a
   * suggestion carries is a typecheck failure here rather than a fixture that
   * quietly stops resembling the wire.
   */
  suggestion: LifecycleSuggestion;
  /**
   * The reader's marks this row starts from (cinatra#3164, epic #3155 W8).
   *
   * A suggestion ARRIVES accepted (§VIII), and that is still the only reading a
   * suggestion is born in: a row seeded with the mark already made is the SAME
   * suggestion one press later, which is exactly what the drawing's own example
   * puts on the card — one accepted chip beside one dismissed one. The mark set
   * is the harness's whole state either way; which state the chip is drawn in,
   * which control it then offers and what that control is named stay the shipped
   * component's to decide.
   */
  startsDismissed?: true;
};

export const LIFECYCLE_SUGGESTION_CHIP_FIXTURES: readonly LifecycleSuggestionChipFixture[] = [
  {
    mount: "chip-row-live",
    suggestion: {
      id: "conformance-suggestion-1",
      label: "summary",
      op: "replace",
      message: "Normalise the summary to the canonical one-line form.",
      before: "a long road over layered ground",
      after: "A long road over layered ground.",
    },
  },
  {
    // The same one-control shape at its other end (cinatra#3164): a suggestion
    // the reader has already dismissed, which is where the way back is offered.
    mount: "chip-row-dismissed",
    startsDismissed: true,
    suggestion: {
      id: "conformance-suggestion-2",
      label: "closing ask",
      op: "replace",
      message: "Make the closing ask concrete and small.",
      before: "Are you open to a short call next week?",
      after: "Book 15 minutes here — no prep needed.",
    },
  },
];
