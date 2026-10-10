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
// Native DOM/token contracts only. Layout and paint need the App seat's grade.
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// jsdom has no layout observer. Radix uses it for the hidden form input;
// this stub makes no measurement or visual conformance claim.
beforeEach(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
    // `size-4` is the 16px token; this native test does not measure layout.
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
  it("fills the selected radio's dot with the invariant indigo", () => {
    const { container, items } = renderRadios("daily");
    expect(items[0].getAttribute("data-state")).toBe("checked");
    const dot = container.querySelector(
      '[data-slot="radio-group-indicator"] svg',
    ) as SVGElement | null;
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute("class") ?? "").toContain("fill-indigo-ink");
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
    expect(items[1].getAttribute("data-state")).toBe("unchecked");
    expect(items[1].className).toContain("bg-surface-muted");
    expect(items[1].className).not.toMatch(/\bdark:bg-/);
  });
});

describe("the approved active and off tokens survive either palette", () => {
  it.each(["cinatra", "cinatra dark"])("uses invariant dot fill and stroke in %s", (palette) => {
    const { getByRole } = render(
      <div className={palette}>
        <RadioGroup defaultValue="daily">
          <RadioGroupItem value="daily" aria-label="Daily" />
          <RadioGroupItem value="weekly" aria-label="Weekly" />
        </RadioGroup>
      </div>,
    );
    const active = getByRole("radio", { name: "Daily" });
    expect(active.getAttribute("data-state")).toBe("checked");
    expect(active.className).toContain("text-indigo-ink");
    expect(active.className).not.toMatch(/\btext-primary\b/);
    expect(active.querySelector("svg")?.getAttribute("class")).toContain("fill-indigo-ink");
    const off = getByRole("radio", { name: "Weekly" });
    expect(off.getAttribute("data-state")).toBe("unchecked");
    expect(off.className).toContain("bg-surface-muted");
    expect(off.className).not.toMatch(/\bdark:bg-/);
    expect(off.querySelector("svg")).toBeNull();
  });

  it("binds the active utility to the existing invariant drawing value", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css.match(/--indigo-ink\s*:\s*[^;]+;/g)).toEqual(["--indigo-ink: #364e81;"]);
    expect(css).toContain("--color-indigo-ink: var(--indigo-ink)");
    expect(css).toContain("--color-surface-muted: var(--surface-muted)");
  });
});

describe("selection, form and caller contracts stay intact", () => {
  it("updates an uncontrolled group on a click and emits its new value once", () => {
    const changed = vi.fn();
    const { getByRole } = render(
      <RadioGroup defaultValue="daily" onValueChange={changed}>
        <RadioGroupItem value="daily" aria-label="Daily" />
        <RadioGroupItem value="weekly" aria-label="Weekly" />
      </RadioGroup>,
    );
    fireEvent.click(getByRole("radio", { name: "Weekly" }));
    expect(changed.mock.calls).toEqual([["weekly"]]);
    expect(getByRole("radio", { name: "Weekly" }).getAttribute("aria-checked")).toBe("true");
    expect(getByRole("radio", { name: "Daily" }).getAttribute("aria-checked")).toBe("false");
  });

  it("keeps the controlled value until its caller accepts the new selection", () => {
    const changed = vi.fn();
    const { getByRole, rerender } = render(
      <RadioGroup value="daily" onValueChange={changed}>
        <RadioGroupItem value="daily" aria-label="Daily" />
        <RadioGroupItem value="weekly" aria-label="Weekly" />
      </RadioGroup>,
    );
    fireEvent.click(getByRole("radio", { name: "Weekly" }));
    expect(changed.mock.calls).toEqual([["weekly"]]);
    expect(getByRole("radio", { name: "Daily" }).getAttribute("aria-checked")).toBe("true");
    rerender(
      <RadioGroup value="weekly" onValueChange={changed}>
        <RadioGroupItem value="daily" aria-label="Daily" />
        <RadioGroupItem value="weekly" aria-label="Weekly" />
      </RadioGroup>,
    );
    expect(getByRole("radio", { name: "Weekly" }).getAttribute("aria-checked")).toBe("true");
  });

  it("never selects a disabled item", () => {
    const changed = vi.fn();
    const { getByRole } = render(
      <RadioGroup defaultValue="daily" onValueChange={changed}>
        <RadioGroupItem value="daily" aria-label="Daily" />
        <RadioGroupItem value="weekly" aria-label="Weekly" disabled />
      </RadioGroup>,
    );
    fireEvent.click(getByRole("radio", { name: "Weekly" }));
    expect(changed).not.toHaveBeenCalled();
    expect(getByRole("radio", { name: "Daily" }).getAttribute("aria-checked")).toBe("true");
  });

  it("moves horizontal keyboard selection to the next enabled item", async () => {
    const changed = vi.fn();
    const { getByRole } = render(
      <RadioGroup defaultValue="daily" orientation="horizontal" onValueChange={changed}>
        <RadioGroupItem value="daily" aria-label="Daily" />
        <RadioGroupItem value="disabled" aria-label="Disabled" disabled />
        <RadioGroupItem value="weekly" aria-label="Weekly" />
      </RadioGroup>,
    );
    const daily = getByRole("radio", { name: "Daily" });
    daily.focus();
    fireEvent.keyDown(daily, { key: "ArrowRight" });
    await waitFor(() => expect(getByRole("radio", { name: "Weekly" }).getAttribute("aria-checked")).toBe("true"));
    expect(changed.mock.calls).toEqual([["weekly"]]);
  });

  it("keeps its form name, required state and selected value", () => {
    const { container } = render(
      <form>
        <RadioGroup name="cadence" required defaultValue="weekly">
          <RadioGroupItem value="daily" aria-label="Daily" />
          <RadioGroupItem value="weekly" aria-label="Weekly" />
        </RadioGroup>
      </form>,
    );
    const form = container.querySelector("form")!;
    expect(new FormData(form).get("cadence")).toBe("weekly");
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute("aria-required")).toBe("true");
  });

  it("preserves caller classes, styles, names and invalid state", () => {
    const { getByRole } = render(
      <RadioGroup aria-label="Cadence" defaultValue="daily" className="gap-6">
        <RadioGroupItem value="daily" aria-label="Daily" className="size-6 text-destructive" style={{ color: "red" }} aria-invalid />
      </RadioGroup>,
    );
    expect(getByRole("radiogroup", { name: "Cadence" }).className).toContain("gap-6");
    const item = getByRole("radio", { name: "Daily" });
    expect(item.className).toContain("size-6");
    expect(item.className).not.toMatch(/\bsize-4\b/);
    expect(item.className).toContain("text-destructive");
    expect(item.style.color).toBe("red");
    expect(item.getAttribute("aria-invalid")).toBe("true");
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
