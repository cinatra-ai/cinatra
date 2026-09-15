// @vitest-environment jsdom
//
// Checkbox — the graded checklist for the components drawing's
// "Checkbox / Radio / Switch" section, on the clauses that reach this
// primitive (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/checkbox-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "control 16–18px"
//   "indigo when on"
//   "surface-muted when off"
//   "Single-select (radio), multi-select (checkbox), and instant-binary
//    (switch). Indigo for active state. Switches are reserved for
//    immediate-effect settings; checkboxes for confirmable form choices."
//
// NO DEPARTURE FOUND in the light palette; the committed checklist is the
// record. One reading is written down rather than acted on: in the dark
// palette the resting ground comes from `--input-fill` at 30% rather than
// `--surface-muted`, so the off state answers the clause through a different
// token there. Both readings are taken on the boot.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";

import { Checkbox } from "@/components/ui/checkbox";

afterEach(cleanup);

function renderCheckbox(props: Record<string, unknown> = {}) {
  const { container } = render(<Checkbox aria-label="Email me" {...props} />);
  return container.querySelector('[data-slot="checkbox"]') as HTMLElement;
}

describe('clause: "control 16–18px"', () => {
  it("draws the control at the 16px step, the floor of the stated band", () => {
    // `size-4` = 16px. The laid-out box is measured on the boot
    // ("checkbox control", primitive-wave-leg1.spec.ts).
    expect(renderCheckbox().className).toContain("size-4");
  });

  it("keeps the check mark inside the control rather than overflowing it", () => {
    const box = renderCheckbox({ checked: true });
    const indicator = box.querySelector(
      '[data-slot="checkbox-indicator"]',
    ) as HTMLElement;
    expect(indicator).not.toBeNull();
    // 14px glyph inside the 16px box.
    expect(indicator.querySelector("svg")!.getAttribute("class")).toContain("size-3.5");
  });

  it("refuses to shrink when a tight row squeezes it", () => {
    expect(renderCheckbox().className).toContain("shrink-0");
  });
});

describe('clause: "indigo when on" / "Indigo for active state."', () => {
  it("fills the control from the action colour once it is checked", () => {
    const box = renderCheckbox({ checked: true });
    // `bg-primary` resolves through `--primary` to `--accent`, the canonical
    // desaturated indigo. The computed rgb is read on the boot.
    expect(box.className).toContain("data-[state=checked]:bg-primary");
    expect(box.className).toContain("data-[state=checked]:border-primary");
    expect(box.getAttribute("data-state")).toBe("checked");
  });

  it("carries the on state into the DOM, so the fill and the value cannot disagree", () => {
    const box = renderCheckbox({ defaultChecked: false });
    expect(box.getAttribute("data-state")).toBe("unchecked");
    fireEvent.click(box);
    expect(box.getAttribute("data-state")).toBe("checked");
  });
});

describe('clause: "surface-muted when off"', () => {
  it("rests on the muted ground with the input hairline", () => {
    const box = renderCheckbox();
    expect(box.className).toContain("bg-surface-muted");
    expect(box.className).toContain("border-input");
  });

  // Recorded reading, not a departure: the dark palette overrides the resting
  // ground to `--input-fill` at 30% rather than `--surface-muted`. The clause
  // names one token and the app answers it with two, one per palette; both
  // computed grounds are taken on the boot and written into the record, so a
  // later reading of the drawing can settle whether the dark override is the
  // intended treatment.
  it.skip(
    "recorded reading: the dark palette rests on --input-fill/30 rather than --surface-muted; both grounds are read on the boot",
    () => {},
  );
});

describe('clause: "checkboxes for confirmable form choices."', () => {
  it("presents as a checkbox to assistive technology", () => {
    const box = renderCheckbox();
    expect(box.getAttribute("role")).toBe("checkbox");
  });

  it("holds still when it is disabled, instead of half-answering a click", () => {
    const box = renderCheckbox({ disabled: true });
    expect(box.className).toContain("disabled:cursor-not-allowed");
    expect(box.hasAttribute("disabled")).toBe(true);
    fireEvent.click(box);
    expect(box.getAttribute("data-state")).toBe("unchecked");
  });

  it("shows a focus ring when it is reached from the keyboard", () => {
    const box = renderCheckbox();
    expect(box.className).toContain("focus-visible:ring-[3px]");
    expect(box.className).toContain("focus-visible:ring-ring/50");
  });
});
