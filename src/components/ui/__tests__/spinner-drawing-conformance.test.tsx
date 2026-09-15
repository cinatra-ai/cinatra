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
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Spinner } from "@/components/ui/spinner";

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
