"use client";

// ---------------------------------------------------------------------------
// Functional-acceptance harness for the SUGGESTION CHIPS of the in-conversation
// review card (cinatra#3156, epic #3155 W0).
//
// Renders the REAL `SuggestionChips` — the shipped chip row of the one review
// renderer, exported from its own owner module — so the assertions in
// tests/e2e/design/conformance/contract.ts run against the shipped two-state
// toggle, the shipped chip presentation and the shipped control names rather
// than against a stand-in.
//
// WHY THIS PART OF THE CARD. The chips are the one piece of the drawing that a
// harness can mount as the product mounts it. The decision floor may not be
// composed outside the card at all (the one-card gate bans a page-direct
// decision composition, and rightly: a second place that composes the floor is a
// second place "approved" could come to mean something different), and the card
// as a whole draws no DOM before an authorised server resolve. The chips have
// neither constraint, because §VIII gives them no submit of their own.
//
// WHAT THE HARNESS HOLDS, AND WHY IT IS NOT AN OUTCOME. On a pending gate a mark
// is LOCAL to the reader (§VIII): it lives in the host's state, it is reversible,
// and it reaches the server only if the reader later takes a terminal decision.
// So the harness holds the reader's dismissal set and nothing else. Which state
// each suggestion is then drawn in, which control the chip offers, and what that
// control is NAMED are all computed by the shipped component from that set. The
// harness never names an outcome.
//
// NOTHING IS INTERCEPTED. There is no transport substitution of any kind here:
// no fetch wrapper, no route stub, no seeded server answer. The chip row is a
// props-only component, so mounting it needs none.
//
// THE MOUNT IS NAMED, NOT THE MANIFEST SURFACE. Everywhere else in this harness
// `data-surface-id` is the manifest surface id; the chips are the one place it
// cannot be, because the chip's spec anchors may appear as a literal in exactly
// one production module and the repository proves that by scanning. The binding
// from mount to manifest surface lives in the driver map, on the test side.
//
// Kept OFF the pixel-diffed /design-fixtures index page (same convention as the
// other conformance fixtures): coverage here is assertion-based —
// tests/e2e/design/conformance/functional-acceptance.spec.ts.
// ---------------------------------------------------------------------------

import { useCallback, useState, type ReactElement } from "react";

import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { SuggestionChips } from "@cinatra-ai/agents/review-gate-card";

import {
  LIFECYCLE_SUGGESTION_CHIP_FIXTURES,
  type LifecycleSuggestionChipFixture,
} from "./lifecycle-card-fixture-data";

function SuggestionChipFixture({
  fixture,
}: {
  fixture: LifecycleSuggestionChipFixture;
}): ReactElement {
  // The READER'S local marks, the same shape the card holds them in. A press
  // toggles membership and nothing else — the drawn state, the control and its
  // name are the component's to decide.
  const [dismissed, setDismissed] = useState<Readonly<Record<string, true>>>({});
  const onToggleMark = useCallback((id: string) => {
    setDismissed((current) => {
      if (current[id]) {
        const next = { ...current };
        delete next[id];
        return next;
      }
      return { ...current, [id]: true };
    });
  }, []);

  return (
    <div data-surface-id={fixture.mount} className="flex flex-col gap-4">
      {/* The IN-THREAD host. The chips are host-independent by design — the same
          row is drawn on every host the card appears on — and the declaration is
          what makes this mount the in-conversation one. */}
      <LifecycleCardSurfaceProvider host="chat_thread">
        <SuggestionChips
          suggestions={[fixture.suggestion]}
          dismissed={dismissed}
          onToggleMark={onToggleMark}
        />
      </LifecycleCardSurfaceProvider>
    </div>
  );
}

/**
 * The in-conversation suggestion chips, one fixture row per manifest surface the
 * family covers.
 */
export function LifecycleSuggestionChipFixtures(): ReactElement {
  return (
    <div className="flex flex-col gap-10">
      {LIFECYCLE_SUGGESTION_CHIP_FIXTURES.map((fixture) => (
        <SuggestionChipFixture key={fixture.mount} fixture={fixture} />
      ))}
    </div>
  );
}
