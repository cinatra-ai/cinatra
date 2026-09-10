// @vitest-environment jsdom
//
// Accordion — the graded checklist for the components drawing's
// "Accordion / Collapsible" section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/accordion-drawing-conformance.test.tsx
//
// One `describe` per clause of that section, quoted verbatim. The section is
// three spec-column clauses plus one prose sentence:
//
//   "navy hairline rows"
//   "rotating chevron"
//   "200ms ease"
//   "Use for sectioned settings panels and FAQ-style content. Default to
//    single-open; allow multi-open only when items are truly independent."
//
// Each assertion is taken at the form its clause makes. Structure and behaviour
// are asserted here in the real DOM; the two clauses that name a rendered VALUE
// (the hairline's colour, the animation's duration) are read as computed styles
// on the live boot by tests/e2e/design/conformance/primitive-wave-leg1.spec.ts,
// because a value carried by a token or a scale step cannot be graded outside
// the palette the surface renders in — the method note this wave recorded on
// 2026-09-01. What this file pins is the RECIPE that produces those values, so
// a silent revert of the class is caught in the fast suite as well.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

afterEach(cleanup);

function renderAccordion() {
  const { container } = render(
    <Accordion type="single" collapsible defaultValue="details">
      <AccordionItem value="details">
        <AccordionTrigger>Run details</AccordionTrigger>
        <AccordionContent>Step 3 of 7 · 12 drafts pending review.</AccordionContent>
      </AccordionItem>
      <AccordionItem value="tools">
        <AccordionTrigger>Tool calls</AccordionTrigger>
        <AccordionContent>Two tool calls.</AccordionContent>
      </AccordionItem>
    </Accordion>,
  );
  const items = Array.from(
    container.querySelectorAll('[data-slot="accordion-item"]'),
  ) as HTMLElement[];
  const triggers = Array.from(
    container.querySelectorAll('[data-slot="accordion-trigger"]'),
  ) as HTMLElement[];
  return { container, items, triggers };
}

describe('clause: "navy hairline rows"', () => {
  it("separates the rows with the shared --line hairline, not a grey border", () => {
    const { items } = renderAccordion();
    expect(items).toHaveLength(2);
    // The row rule is `border-b border-line` on every item but the last, so the
    // stroke is the design system's navy-at-low-alpha hairline. The COMPUTED
    // rgba is read on the boot (primitive-wave-leg1.spec.ts, "accordion row
    // hairline"); this pins the token the class resolves through.
    expect(items[0].className).toContain("not-last:border-b");
    expect(items[0].className).toContain("not-last:border-line");
  });

  it("draws the rule between rows — the last row carries no trailing stroke", () => {
    const { items } = renderAccordion();
    // Reading recorded, not acted on: the section's EXAMPLE additionally draws a
    // rule above the first row and below the last one, so a strict reading of
    // the example's own CSS would put a stroke on both outer edges. The stated
    // clause is "navy hairline rows" and the app draws exactly that between the
    // rows; the outer-edge reading belongs to whatever container hosts the
    // accordion and is left to the surface, not forced into the primitive.
    expect(items[1].className).toContain("not-last:border-b");
  });
});

describe('clause: "rotating chevron"', () => {
  it("renders one chevron per trigger", () => {
    const { triggers } = renderAccordion();
    for (const trigger of triggers) {
      expect(
        trigger.querySelectorAll('[data-slot="accordion-trigger-icon"]'),
      ).toHaveLength(1);
    }
  });

  it("turns the chevron over when its row opens, and back when it closes", () => {
    const { triggers } = renderAccordion();
    // The rotation is bound to the trigger's own expanded state
    // (`group-aria-expanded/accordion-trigger:rotate-180`), so the BEHAVIOUR the
    // clause names is asserted through the state the rule keys off.
    const closed = triggers[1];
    expect(closed.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(closed);
    expect(closed.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(closed);
    expect(closed.getAttribute("aria-expanded")).toBe("false");

    const icon = closed.querySelector(
      '[data-slot="accordion-trigger-icon"]',
    ) as HTMLElement;
    expect(icon.getAttribute("class")).toContain(
      "group-aria-expanded/accordion-trigger:rotate-180",
    );
  });
});

describe('clause: "200ms ease"', () => {
  it("moves the chevron over 200ms on an easing curve", () => {
    const { triggers } = renderAccordion();
    const icon = triggers[0].querySelector(
      '[data-slot="accordion-trigger-icon"]',
    ) as HTMLElement;
    expect(icon.getAttribute("class")).toContain("transition-transform");
    expect(icon.getAttribute("class")).toContain("duration-200");
  });

  it("opens and closes the panel on the same 200ms step", () => {
    const { container } = renderAccordion();
    const content = container.querySelector(
      '[data-slot="accordion-content"]',
    ) as HTMLElement;
    // REGRESSION PIN for a fixed clause. The panel asked for its animation
    // through `data-open:` / `data-closed:`, which compile to `[data-open]` and
    // `[data-closed]` — attributes nothing writes. The underlying primitive
    // publishes `data-state="open"`, so the rule never matched any element and
    // the panel snapped open with no animation at all: the clause's 200ms was
    // absent, not wrong. Reading the class alone could never have caught it,
    // which is why the value is also read in the browser
    // ("200ms ease", primitive-wave-leg1.spec.ts) where the computed
    // `animation-duration` was 0s before this fix and is 0.2s after it.
    expect(content.getAttribute("class")).toContain(
      "data-[state=open]:animate-accordion-down",
    );
    expect(content.getAttribute("class")).toContain(
      "data-[state=closed]:animate-accordion-up",
    );
    // The dead form must not come back.
    expect(content.getAttribute("class")).not.toContain("data-open:animate");
    expect(content.getAttribute("class")).not.toContain("data-closed:animate");
  });

  it("keys the animation off the state the underlying primitive actually writes", () => {
    const { container } = renderAccordion();
    const open = container.querySelector(
      '[data-slot="accordion-content"][data-state="open"]',
    );
    // The attribute the fixed selector matches on. If the primitive ever stops
    // publishing it, the animation goes silent again and this row says so.
    expect(open).not.toBeNull();
  });
});

describe('clause: "Default to single-open; allow multi-open only when items are truly independent."', () => {
  it("opens one row at a time when the caller asks for the single mode", () => {
    const { triggers } = renderAccordion();
    fireEvent.click(triggers[1]);
    expect(triggers[0].getAttribute("aria-expanded")).toBe("false");
    expect(triggers[1].getAttribute("aria-expanded")).toBe("true");
  });

  // NOT APPLICABLE at the primitive, with the reason. The underlying Root's
  // props are a discriminated union keyed on `type`, so `single` cannot be
  // supplied as a default without widening the component's public type and
  // making `value`/`onValueChange` unsound for the multi-open caller. The
  // clause therefore reads on the call sites, which name the mode explicitly;
  // the primitive's part — that the single mode behaves as one-at-a-time — is
  // the assertion above.
  it.skip(
    "not applicable at the primitive: the mode cannot be defaulted without widening the public type",
    () => {},
  );
});
