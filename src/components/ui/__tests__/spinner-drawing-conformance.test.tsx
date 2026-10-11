// @vitest-environment jsdom
//
// Spinner — the graded checklist for the components drawing's
// "Skeleton / Spinner" section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/spinner-drawing-conformance.test.tsx
//
// The clauses this primitive is answerable for, quoted verbatim:
//
//   "Spinner: indigo arc 1s linear"
//   "Spinner only for short (<500ms) inline waits inside buttons or icons."
//
// NO DEPARTURE FOUND.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { Spinner } from "@/components/ui/spinner";
import * as buttonPrimitives from "@/components/ui/button";

afterEach(cleanup);

function renderSpinner(className?: string) {
  const { container } = render(<Spinner className={className} />);
  return container.querySelector("svg") as SVGElement;
}

describe('clause: "indigo arc"', () => {
  it("strokes the arc in the primary indigo", () => {
    // The computed colour is re-read on the boot in both palettes
    // ("spinner arc", primitive-wave-leg1.spec.ts).
    expect(renderSpinner().getAttribute("class")).toContain("text-primary");
  });

  it("lets a caller on a coloured ground recolour it, since indigo on indigo is invisible", () => {
    const cls = renderSpinner("text-primary-foreground").getAttribute("class")!;
    expect(cls).toContain("text-primary-foreground");
  });
});

describe('clause: "1s linear"', () => {
  it("spins on the 1s linear rotation", () => {
    // Tailwind's `animate-spin` is exactly `spin 1s linear infinite`, which is
    // the clause's value; the resolved animation shorthand is read on the boot.
    expect(renderSpinner().getAttribute("class")).toContain("animate-spin");
  });
});

describe('clause: "inline waits inside buttons or icons"', () => {
  it("sizes itself to an icon so it drops into a button label without reflowing it", () => {
    // `size-4` = 16px is the icon step every button variant already sets for
    // its own glyphs.
    expect(renderSpinner().getAttribute("class")).toContain("size-4");
  });

  it("announces itself as a live status rather than as a decorative graphic", () => {
    const el = renderSpinner();
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-label")).toBe("Loading");
  });
});

describe('clause: "only for short (<500ms) inline waits"', () => {
  // NOT APPLICABLE at this primitive, with the reason: the duration bound is a
  // rule for the CALL SITE — how long the surface leaves the spinner up. The
  // component has no knowledge of the wait it is decorating.
  it.skip(
    "not applicable at this primitive: the <500ms bound governs the call site's wait, which the spinner cannot observe",
    () => {},
  );
});


describe("shared Spinner public callers keep the same primitive", () => {
  it("preserves the legacy import as the canonical shared function", () => {
    expect(buttonPrimitives.Spinner).toBeTypeOf("function");
    expect(Spinner).toBe(buttonPrimitives.Spinner);
  });

  it.each(["light", "dark"])("keeps default markup and SVG overrides through both exports (%s)", (palette) => {
    document.documentElement.classList.add(palette === "dark" ? "dark" : "cinatra");
    expect(buttonPrimitives.Spinner).toBeTypeOf("function");
    const legacy = render(<Spinner className="size-[22px] text-indigo-ink" strokeWidth={2.4} aria-hidden="true" />);
    const canonical = render(<buttonPrimitives.Spinner className="size-[22px] text-indigo-ink" strokeWidth={2.4} aria-hidden="true" />);
    expect(canonical.container.innerHTML).toBe(legacy.container.innerHTML);
    const arc = canonical.container.querySelector("svg")!;
    expect(arc.getAttribute("stroke-width")).toBe("2.4");
    expect(arc.getAttribute("aria-hidden")).toBe("true");
    expect(arc.getAttribute("class")).toContain("size-[22px]");
    expect(arc.getAttribute("class")).toContain("text-indigo-ink");
    document.documentElement.classList.remove("dark", "cinatra");
  });

  it("preserves SVG refs and caller events, and composes in the actual Button", () => {
    expect(buttonPrimitives.Spinner).toBeTypeOf("function");
    const press = vi.fn();
    const ref = React.createRef<SVGSVGElement>();
    const { container, getByRole } = render(
      <>
        <buttonPrimitives.Button disabled aria-label="Saving">
          <Spinner data-icon="inline-start" aria-hidden="true" />
        </buttonPrimitives.Button>
        <Spinner ref={ref} aria-label="Custom wait" onClick={press} />
      </>,
    );
    const button = getByRole("button", { name: "Saving" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("data-slot")).toBe("button");
    expect(button.querySelector("svg")!.getAttribute("data-icon")).toBe("inline-start");
    const arc = getByRole("status", { name: "Custom wait" });
    expect(ref.current).toBe(arc);
    expect(container.querySelectorAll("svg.animate-spin")).toHaveLength(2);
    fireEvent.click(arc);
    expect(press).toHaveBeenCalledTimes(1);
  });
});
