// @vitest-environment jsdom
//
// RadioGroup — the graded checklist for the components drawing's
// "Checkbox / Radio / Switch" section (cinatra#3189, shared-primitives wave,
// leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/radio-group-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "control 16-18px"
//   "indigo when on"
//   "surface-muted when off"
//   "Single-select (radio), multi-select (checkbox), and instant-binary
//    (switch). Indigo for active state."
//
// NO DEPARTURE FOUND.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

afterEach(cleanup);

function renderRadios(value = "daily") {
  const { container } = render(
    <RadioGroup value={value} onValueChange={() => {}}>
      <RadioGroupItem value="daily" aria-label="Daily" />
      <RadioGroupItem value="weekly" aria-label="Weekly" />
    </RadioGroup>,
  );
  const items = Array.from(
    container.querySelectorAll('[data-slot="radio-group-item"]'),
  ) as HTMLElement[];
  return { container, items };
}

describe('clause: "control 16-18px"', () => {
  it("draws the control inside the stated band", () => {
    // `size-4` = 16px, the band's floor. The laid-out box is re-read on the
    // boot ("radio box", primitive-wave-leg1.spec.ts) in both palettes.
    const { items } = renderRadios();
    expect(items[0].className).toContain("size-4");
  });

  it("keeps the control a circle, which is what separates it from a checkbox", () => {
    const { items } = renderRadios();
    expect(items[0].className).toContain("rounded-full");
    expect(items[0].className).toContain("aspect-square");
  });
});

describe('clause: "indigo when on" / "Indigo for active state"', () => {
  it("fills the selected radio's dot with the primary indigo", () => {
    const { container, items } = renderRadios("daily");
    expect(items[0].getAttribute("data-state")).toBe("checked");
    const dot = container.querySelector(
      '[data-slot="radio-group-indicator"] svg',
    ) as SVGElement | null;
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute("class") ?? "").toContain("fill-primary");
  });

  it("shows no dot at all on the unselected radio", () => {
    const { items } = renderRadios("daily");
    expect(items[1].getAttribute("data-state")).toBe("unchecked");
    expect(items[1].querySelector("svg")).toBeNull();
  });
});

describe('clause: "surface-muted when off"', () => {
  it("grounds the control on the muted surface", () => {
    const { items } = renderRadios();
    expect(items[0].className).toContain("bg-surface-muted");
  });
});

describe('clause: "Single-select (radio)"', () => {
  it("lets exactly one item be selected at a time", () => {
    const { items } = renderRadios("weekly");
    const checked = items.filter(
      (i) => i.getAttribute("data-state") === "checked",
    );
    expect(checked).toHaveLength(1);
    expect(checked[0].getAttribute("value")).toBe("weekly");
  });

  it("exposes the group and its items with radio semantics", () => {
    const { container, items } = renderRadios();
    expect(
      container.querySelector('[data-slot="radio-group"]')!.getAttribute("role"),
    ).toBe("radiogroup");
    expect(items[0].getAttribute("role")).toBe("radio");
  });
});
