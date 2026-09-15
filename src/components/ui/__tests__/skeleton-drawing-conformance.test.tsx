// @vitest-environment jsdom
//
// Skeleton — the graded checklist for the components drawing's
// "Skeleton / Spinner" section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/skeleton-drawing-conformance.test.tsx
//
// The clauses this primitive is answerable for, quoted verbatim:
//
//   "Skeleton: surface-muted bars"
//   "Skeletons mirror the layout they're replacing; never use a global spinner
//    overlay when a skeleton would do."
//
// NO DEPARTURE FOUND.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Skeleton } from "@/components/ui/skeleton";

afterEach(cleanup);

function renderSkeleton(className?: string) {
  const { container } = render(<Skeleton className={className} />);
  return container.querySelector('[data-slot="skeleton"]') as HTMLElement;
}

describe('clause: "Skeleton: surface-muted bars"', () => {
  it("paints the bar on the muted surface", () => {
    // `bg-muted` resolves through --color-muted to --surface-muted, the token
    // the clause names. The computed ground is re-read on the boot in both
    // palettes ("skeleton bar", primitive-wave-leg1.spec.ts).
    expect(renderSkeleton().className).toContain("bg-muted");
  });

  it("draws a bar — a filled block — rather than an outline", () => {
    const cls = renderSkeleton().className;
    expect(cls).not.toMatch(/(^|\s)border(\s|$)/);
    expect(cls).toContain("rounded-md");
  });
});

describe('clause: "Skeletons mirror the layout they\'re replacing"', () => {
  it("takes its geometry from the caller rather than imposing a size", () => {
    // A skeleton that carried its own width/height could not mirror anything.
    // The graded form is the ABSENCE of an intrinsic box plus the presence of
    // a className seam through which the caller supplies one.
    const bare = renderSkeleton().className;
    expect(bare).not.toMatch(/(^|\s)(w|h|size)-/);
    cleanup();
    const sized = renderSkeleton("h-4 w-40").className;
    expect(sized).toContain("h-4");
    expect(sized).toContain("w-40");
  });
});

describe("the skeleton animates so it reads as pending, not as an empty block", () => {
  it("carries the pulse", () => {
    // Not a sentence of the section, but the form "skeleton" makes: a static
    // muted block is indistinguishable from a disabled surface.
    expect(renderSkeleton().className).toContain("animate-pulse");
  });
});

describe('clause: "never use a global spinner overlay when a skeleton would do"', () => {
  // NOT APPLICABLE at this primitive, with the reason: the sentence rules on
  // which loading affordance a SURFACE picks. The skeleton cannot assert that
  // no other surface reached for a spinner instead.
  it.skip(
    "not applicable at this primitive: the skeleton-vs-overlay choice belongs to the surface, not to this component",
    () => {},
  );
});
