// ---------------------------------------------------------------------------
// Fixture data for the SUGGESTION-CHIP family (cinatra#3156, epic #3155 W0).
//
// The in-conversation lifecycle drawing gives a surfaced suggestion ONE control
// and TWO drawn states: a suggestion arrives accepted, one press dismisses it,
// one press accepts it again — the toggle is its own inverse. The two manifest
// surfaces (`suggestion-accepted`, `suggestion-dismissed`) are therefore the two
// ends of one shape, which is why they are driven by ONE family factory
// (`suggestionChipDriver`, tests/e2e/design/conformance/contract.ts) over this
// list, exactly as the six extension listing cards are driven by `cardDriver`
// over CONFORMANCE_CARD_FIXTURES.
//
// W0 lands ONE row and proves the road end to end; the later waves add rows.
//
// THIS FILE CARRIES NO PRODUCT BEHAVIOUR. A row names the manifest surface and
// the one surfaced suggestion the harness mounts, in the protocol's own shape.
// Which state that suggestion is drawn in, which control the chip offers, and
// what that control is named are all decided by the shipped component.
// ---------------------------------------------------------------------------

import type { LifecycleSuggestion } from "@cinatra-ai/agent-ui-protocol/renderable-views";

export type LifecycleSuggestionChipFixture = {
  /** The manifest surface id this row drives. */
  surfaceId: string;
  /**
   * The surfaced suggestion, in the protocol's own type — so a change to what a
   * suggestion carries is a typecheck failure here rather than a fixture that
   * quietly stops resembling the wire.
   */
  suggestion: LifecycleSuggestion;
};

export const LIFECYCLE_SUGGESTION_CHIP_FIXTURES: readonly LifecycleSuggestionChipFixture[] = [
  {
    surfaceId: "suggestion-accepted",
    suggestion: {
      id: "conformance-suggestion-1",
      label: "summary",
      op: "replace",
      message: "Normalise the summary to the canonical one-line form.",
      before: "a long road over layered ground",
      after: "A long road over layered ground.",
    },
  },
];
