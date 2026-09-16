// @vitest-environment jsdom
//
// The composer-focus row NAMES ITS CONTROL THE WAY THE DRAWING NAMES IT
// (cinatra#3159, epic #3155 W3).
//
// WHY THIS IS ITS OWN FILE, next to the card's own suite rather than inside it.
// What is pinned here is not a behaviour of the card — `review-gate-card.test.tsx`
// already pins the binding itself: that the affordance exists only where a
// composer does, that the binding the card SAYS is the binding the resolver
// computes, and that a comment travels the card's own decision path. What is
// pinned here is the CONTRACT the functional-acceptance driver reads: the one
// toggle carries, as a plain attribute, the action-and-outcome pair the ratified
// drawing declares for the reading it is currently drawn in. That is a
// conformance property of the row, and it is checked at the row rather than
// through the whole card so the check cannot be satisfied by an authorised
// resolve happening to land the right way.
//
// THE DRAWING'S OWN NAMES. §I gives the row ONE control with two names, one per
// reading, exactly as §VIII gives a suggestion chip one control with two names:
//
//   bound      "Replying to this review"   -> release-review-composer -> unbound
//   not bound  "Reply from the chat box"   -> focus-review-composer   -> bound
//
// A toggle whose name did not move with its reading would let a driver press the
// control in one reading and report the other reading's outcome. That is the
// single failure this file exists to prevent.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactElement } from "react";

import {
  LifecycleComposerFocusProvider,
  createComposerFocusStore,
  useComposerFocusBinding,
  type ComposerCommentAction,
  type ComposerFocusStore,
} from "../lifecycle-card-runtime";
import { ComposerFocusRow } from "../review-gate-card";

afterEach(() => {
  cleanup();
});

// Never called: no assertion in this file sends a comment. The row is about
// WHERE a typed message would go; the sending is the floor's own surface.
const NOOP_COMMENT: ComposerCommentAction = async () => ({
  ok: true,
  message: "",
});

/**
 * One gate's row, drawn from the REAL binding.
 *
 * Nothing here decides which reading the row is in: `useComposerFocusBinding`
 * reads the shipped store and `resolveComposerTarget` decides, exactly as it
 * does on the chat page. This component only says which gate the row belongs to.
 */
function Row({ gate }: { gate: string }): ReactElement {
  const binding = useComposerFocusBinding({
    ref: gate,
    eligible: true,
    comment: NOOP_COMMENT,
  });
  return <ComposerFocusRow binding={binding} />;
}

function mount(gates: readonly string[], store: ComposerFocusStore): HTMLElement {
  const { container } = render(
    <LifecycleComposerFocusProvider store={store}>
      {gates.map((gate) => (
        <Row key={gate} gate={gate} />
      ))}
    </LifecycleComposerFocusProvider>,
  );
  return container;
}

function control(container: HTMLElement): HTMLElement {
  const row = container.querySelector('[data-conformance-id="review-composer-focus"]');
  expect(row, "the row draws at all").not.toBeNull();
  const button = row!.querySelector("button");
  expect(button, "the row carries its one toggle").not.toBeNull();
  return button as HTMLElement;
}

describe("#3159 the composer-focus row names its control as the drawing does", () => {
  it("BOUND: the one control offers the drawing's release action and its outcome", () => {
    // A single open review binds the composer with no press at all (§I), so the
    // reading here is the resolver's, not this test's.
    const container = mount(["gate-a"], createComposerFocusStore());
    expect(
      container.querySelector('[data-conformance-id="review-composer-bound"]'),
    ).not.toBeNull();
    expect(control(container).getAttribute("data-action")).toBe(
      "release-review-composer -> unbound",
    );
  });

  it("NOT BOUND: the same control offers the drawing's focus action and its outcome", () => {
    // Two open reviews and no choice yet: the resolver says ambiguous, so the
    // control is the one that TAKES the binding.
    const container = mount(["gate-a", "gate-b"], createComposerFocusStore());
    expect(
      container.querySelector('[data-conformance-id="review-composer-ambiguous"]'),
    ).not.toBeNull();
    expect(control(container).getAttribute("data-action")).toBe(
      "focus-review-composer -> bound",
    );
  });

  it("the name MOVES with the reading — the toggle is its own inverse", () => {
    const store = createComposerFocusStore();
    const container = mount(["gate-a"], store);
    const button = control(container);
    expect(button.getAttribute("data-action")).toBe("release-review-composer -> unbound");
    // The REAL press, through the shipped control's own handler.
    act(() => {
      fireEvent.click(button);
    });
    expect(
      container.querySelector('[data-conformance-id="review-composer-unbound"]'),
    ).not.toBeNull();
    expect(control(container).getAttribute("data-action")).toBe(
      "focus-review-composer -> bound",
    );
    // And back again, so the two names are one control and not two.
    act(() => {
      fireEvent.click(control(container));
    });
    expect(control(container).getAttribute("data-action")).toBe(
      "release-review-composer -> unbound",
    );
  });
});
