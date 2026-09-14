// @vitest-environment jsdom
//
// Collapsible — the graded checklist for the components drawing's
// "Accordion / Collapsible" section, on the clauses that reach this primitive
// (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/collapsible-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "navy hairline rows"
//   "rotating chevron"
//   "200ms ease"
//   "Use for sectioned settings panels and FAQ-style content. Default to
//    single-open; allow multi-open only when items are truly independent."
//
// NO DEPARTURE FOUND, and most of the section does not reach this file: the
// three spec-column clauses describe the ACCORDION the section's example draws
// — a set of hairline-separated rows, each with its own chevron. `Collapsible`
// is the section's unstyled sibling: one trigger, one panel, no rows and no
// chrome of its own, so a consumer draws the row and the chevron. Grading a
// hairline against a component that paints nothing would be inventing a rule
// the drawing does not make, which this wave's own disposition forbids. What
// the primitive DOES own — the open/closed contract the "200ms ease" and
// "rotating chevron" clauses key off — is asserted below, and the
// not-applicable rows carry their reason.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

afterEach(cleanup);

function renderCollapsible(defaultOpen = false) {
  const { container } = render(
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger>Tool calls</CollapsibleTrigger>
      <CollapsibleContent>Two tool calls.</CollapsibleContent>
    </Collapsible>,
  );
  const q = (slot: string) =>
    container.querySelector(`[data-slot="${slot}"]`) as HTMLElement | null;
  return {
    container,
    root: q("collapsible")!,
    trigger: q("collapsible-trigger")!,
    content: () => q("collapsible-content"),
  };
}

describe("the open/closed contract the section's chrome clauses key off", () => {
  it("starts closed and shows nothing until it is asked", () => {
    const { trigger, content } = renderCollapsible(false);
    expect(trigger.getAttribute("data-state")).toBe("closed");
    // The panel is kept in the tree and hidden, which is what lets an
    // animation play on the way out; what the clause asks for is that nothing
    // is shown, so the reading is taken at the hidden attribute.
    const panel = content();
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute("data-state")).toBe("closed");
    expect(panel!.hasAttribute("hidden")).toBe(true);
  });

  it("opens on the trigger and closes again on the same trigger", () => {
    const { trigger, content } = renderCollapsible(false);
    fireEvent.click(trigger);
    expect(trigger.getAttribute("data-state")).toBe("open");
    expect(content()).not.toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("data-state")).toBe("closed");
  });

  it("publishes the state on the root and the trigger together, so a consumer's chevron rule has something to key off", () => {
    // This is what makes the section's "rotating chevron" clause answerable at
    // all for a consumer of Collapsible: the state is on the DOM, not private.
    const { root, trigger } = renderCollapsible(true);
    expect(root.getAttribute("data-state")).toBe("open");
    expect(trigger.getAttribute("data-state")).toBe("open");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("names its slots, so a consumer's row rule targets the panel and not the whole block", () => {
    const { root, trigger } = renderCollapsible(true);
    expect(root.getAttribute("data-slot")).toBe("collapsible");
    expect(trigger.getAttribute("data-slot")).toBe("collapsible-trigger");
  });
});

describe('clause: "navy hairline rows"', () => {
  // NOT APPLICABLE, with the reason: the clause describes the accordion's
  // separated rows. Collapsible paints no chrome at all — it carries no class
  // of its own — so there is no seam here at which a hairline could be graded.
  // The clause is graded on `accordion` in this same leg.
  it.skip(
    "not applicable: Collapsible paints no chrome; the row hairline is graded on accordion",
    () => {},
  );

  it("paints no ground or stroke of its own, so a consumer's row rule is never fought", () => {
    const { root } = renderCollapsible(true);
    // The positive form of the same fact: the primitive is a behaviour seam.
    expect(root.className === "" || root.className === undefined).toBe(true);
  });
});

describe('clause: "rotating chevron"', () => {
  // NOT APPLICABLE, with the reason: Collapsible renders no icon. Its trigger
  // renders exactly the children a consumer passes, so the chevron — and its
  // rotation — belong to the consumer, which has the state published above to
  // key the rotation off.
  it.skip(
    "not applicable: Collapsible renders no icon; the consumer supplies the chevron and keys it off the published state",
    () => {},
  );
});

describe('clause: "200ms ease"', () => {
  // NOT APPLICABLE, with the reason: Collapsible ships no animation utility;
  // the accordion's `animate-accordion-down/up` pair — 200ms on an ease curve —
  // is applied by `AccordionContent` and graded there. Asserting a duration on
  // an element that carries no animation would pin nothing.
  it.skip(
    "not applicable: Collapsible ships no animation; the 200ms step is graded on accordion's content",
    () => {},
  );
});

describe('clause: "Default to single-open; allow multi-open only when items are truly independent."', () => {
  // NOT APPLICABLE, with the reason: the sentence is about a SET of items, and
  // a collapsible is one item. There is nothing here to hold open one at a
  // time.
  it.skip(
    "not applicable: the sentence governs a set of items; a collapsible is a single item",
    () => {},
  );
});
