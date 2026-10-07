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
// The approved clause names the same indigo and resting surface in both
// palettes. These native checks verify the shipped class/token contract and
// actual Radix behavior; browser paint remains an independent App reading.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, render, fireEvent } from "@testing-library/react";

import { Checkbox } from "@/components/ui/checkbox";

// jsdom omits the external browser observer Radix uses for its form input.
// Only that notification port is supplied; actual Checkbox/form DOM executes.
beforeAll(() => vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
}));
afterAll(() => vi.unstubAllGlobals());

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark", "cinatra");
});

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
  it("fills the checked control from the drawing's palette-invariant indigo", () => {
    const box = renderCheckbox({ checked: true });
    expect(box.className).toContain("data-[state=checked]:bg-indigo-ink");
    expect(box.className).toContain("data-[state=checked]:border-indigo-ink");
    expect(box.className).not.toContain("data-[state=checked]:bg-primary");
    expect(box.className).not.toContain("data-[state=checked]:border-primary");
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

  it("retains surface-muted in dark rather than overriding it with translucent input-fill", () => {
    document.documentElement.classList.add("dark");
    const box = renderCheckbox();
    expect(box.className).toContain("bg-surface-muted");
    expect(box.className).not.toContain("dark:bg-input-fill/30");
    expect(box.getAttribute("data-state")).toBe("unchecked");
  });
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


describe("the approved Checkbox palette contract preserves real form behavior", () => {
  for (const palette of ["cinatra", "dark"]) {
    it(`${palette}: selected and unselected grounds keep the same approved recipes`, () => {
      document.documentElement.classList.add(palette);
      const off = renderCheckbox();
      const on = renderCheckbox({ checked: true });
      expect(off.className).toContain("bg-surface-muted");
      expect(off.className).not.toContain("dark:bg-input-fill/30");
      expect(on.className).toContain("data-[state=checked]:bg-indigo-ink");
      expect(on.className).toContain("data-[state=checked]:border-indigo-ink");
      expect(on.className).toContain("data-[state=checked]:text-white");
      expect(on.className).not.toContain("dark:data-[state=checked]:bg-primary");
    });

    it(`${palette}: disabled selected state remains selected without firing its callback`, () => {
      document.documentElement.classList.add(palette);
      const onCheckedChange = vi.fn();
      const box = renderCheckbox({ checked: true, disabled: true, onCheckedChange });
      fireEvent.click(box);
      expect(box.getAttribute("data-state")).toBe("checked");
      expect(box.hasAttribute("disabled")).toBe(true);
      expect(box.className).toContain("data-[state=checked]:bg-indigo-ink");
      expect(box.className).toContain("disabled:opacity-50");
      expect(onCheckedChange).not.toHaveBeenCalled();
    });
  }

  it("keeps controlled selection, labels and caller class/style precedence", () => {
    const onCheckedChange = vi.fn();
    const { container, rerender } = render(
      <Checkbox aria-label="Confirm delivery" checked={false} onCheckedChange={onCheckedChange}
        className="rounded-[6px] bg-red-500" style={{ opacity: 0.7 }} />,
    );
    const box = container.querySelector('[data-slot="checkbox"]') as HTMLElement;
    fireEvent.click(box);
    expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(box.getAttribute("data-state")).toBe("unchecked");
    expect(box.getAttribute("aria-label")).toBe("Confirm delivery");
    expect(box.className).toContain("rounded-[6px]");
    expect(box.className).not.toContain("rounded-[4px]");
    expect(box.className).toContain("bg-red-500");
    expect(box.className.split(" ")).not.toContain("bg-surface-muted");
    expect(box.style.opacity).toBe("0.7");
    rerender(<Checkbox checked aria-label="Confirm delivery" onCheckedChange={onCheckedChange} />);
    expect(box.getAttribute("data-state")).toBe("checked");
  });

  it("preserves form name/required, invalid border and the indeterminate callback", () => {
    const onCheckedChange = vi.fn();
    const { container } = render(<form><Checkbox aria-label="Accept terms" name="termsAccepted"
      required checked="indeterminate" aria-invalid onCheckedChange={onCheckedChange} /></form>);
    const box = container.querySelector('[data-slot="checkbox"]') as HTMLElement;
    expect(box.getAttribute("data-state")).toBe("indeterminate");
    expect(box.className).toContain("aria-invalid:border-destructive");
    expect(box.className).toContain("dark:aria-invalid:ring-destructive/40");
    const input = container.querySelector('input[name="termsAccepted"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.required).toBe(true);
    fireEvent.click(box);
    expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("uses the existing fixed indigo token without changing the dark surface token", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toContain("--indigo-ink: #364e81;");
    expect(css).toContain("--color-indigo-ink: var(--indigo-ink);");
    expect(css.match(/--indigo-ink:\s*[^;]+;/g)).toEqual(["--indigo-ink: #364e81;"]);
    expect(css).toContain("--surface-muted: oklch(0.279 0.041 260.031);");
  });

  it("keeps the existing both-palette browser clause aligned with indigo and muted surface", () => {
    const browser = readFileSync("tests/e2e/design/conformance/primitive-wave-leg1.spec.ts", "utf8");
    const start = browser.indexOf('test.describe("checkbox —');
    const end = browser.indexOf('test.describe("dialog and alert dialog', start);
    const checkbox = browser.slice(start, end);
    expect(browser).toContain('for (const { name: palette, theme } of PALETTES)');
    expect(checkbox).toContain('expect(onGround).toBe(await token(page, "--indigo-ink"));');
    expect(checkbox).toContain('expect(offGround).toBe(await token(page, "--surface-muted"));');
    expect(checkbox).not.toContain('token(page, "--primary")');
  });
});
