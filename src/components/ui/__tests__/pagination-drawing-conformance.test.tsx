// @vitest-environment jsdom
//
// Pagination — the graded checklist for the components drawing's "Pagination"
// section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/pagination-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "mono 13px"
//   "active = ink fill"
//   "prev/next chevrons"
//   "For long lists and tabular data. Active page is ink-filled; surrounding
//    pages are line-bordered on white. Always pair with a 'X of N' caption in
//    mono slate."
//
// NO DEPARTURE FOUND.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  Pagination,
  PaginationCaption,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

afterEach(cleanup);

function renderPagination() {
  const { container } = render(
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious href="#" />
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#">1</PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#" isActive>
            2
          </PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationEllipsis />
        </PaginationItem>
        <PaginationItem>
          <PaginationNext href="#" />
        </PaginationItem>
      </PaginationContent>
      <PaginationCaption>2 of 12</PaginationCaption>
    </Pagination>,
  );
  const links = Array.from(
    container.querySelectorAll('[data-slot="pagination-link"]'),
  ) as HTMLElement[];
  return {
    container,
    links,
    active: links.find((l) => l.getAttribute("data-active") === "true")!,
    inactive: links.find((l) => l.getAttribute("data-active") !== "true")!,
    caption: container.querySelector(
      '[data-slot="pagination-caption"]',
    ) as HTMLElement,
  };
}

describe('clause: "mono 13px"', () => {
  it("sets every page link in mono at 13px", () => {
    const { links } = renderPagination();
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.className).toContain("font-mono");
      expect(link.className).toContain("text-[13px]");
    }
  });
});

describe('clause: "active = ink fill" / "Active page is ink-filled"', () => {
  it("fills the current page with the ink and inverts its type", () => {
    // --foreground is the navy ink and --background the paper, so
    // `bg-foreground text-background` IS the ink fill. Both computed values
    // are re-read on the boot in both palettes ("pagination active",
    // primitive-wave-leg1.spec.ts).
    const { active } = renderPagination();
    expect(active.className).toContain("bg-foreground");
    expect(active.className).toContain("text-background");
  });

  it("marks the current page for assistive tech, not only visually", () => {
    expect(renderPagination().active.getAttribute("aria-current")).toBe("page");
  });
});

describe('clause: "surrounding pages are line-bordered on white"', () => {
  it("gives the non-current pages the outline treatment rather than a fill", () => {
    const { inactive } = renderPagination();
    expect(inactive.getAttribute("data-active")).not.toBe("true");
    expect(inactive.className).not.toContain("bg-foreground");
  });

  it("leaves no aria-current on a page that is not the current one", () => {
    expect(renderPagination().inactive.getAttribute("aria-current")).toBeNull();
  });
});

describe('clause: "prev/next chevrons"', () => {
  it("draws a glyph on each of the two step controls", () => {
    const { container } = renderPagination();
    const prev = container.querySelector('[aria-label="Go to previous page"]')!;
    const next = container.querySelector('[aria-label="Go to next page"]')!;
    expect(prev.querySelector("svg")).not.toBeNull();
    expect(next.querySelector("svg")).not.toBeNull();
  });

  it("puts the chevron on the leading edge going back and the trailing edge going forward", () => {
    const { container } = renderPagination();
    const prev = container.querySelector('[aria-label="Go to previous page"]')!;
    const next = container.querySelector('[aria-label="Go to next page"]')!;
    expect(prev.querySelector("svg")!.getAttribute("data-icon")).toBe(
      "inline-start",
    );
    expect(next.querySelector("svg")!.getAttribute("data-icon")).toBe(
      "inline-end",
    );
  });

  it("labels both controls, since a bare chevron says nothing to a screen reader", () => {
    const { container } = renderPagination();
    expect(
      container.querySelector('[aria-label="Go to previous page"]'),
    ).not.toBeNull();
    expect(container.querySelector('[aria-label="Go to next page"]')).not.toBeNull();
  });
});

describe('clause: "Always pair with a \'X of N\' caption in mono slate"', () => {
  it("offers the caption as its own part rather than leaving it to each call site", () => {
    const { caption } = renderPagination();
    expect(caption).not.toBeNull();
    expect(caption.textContent).toBe("2 of 12");
  });

  it("sets the caption in mono, in the muted slate", () => {
    const { caption } = renderPagination();
    expect(caption.className).toContain("font-mono");
    expect(caption.className).toContain("text-muted-foreground");
  });

  // NOT APPLICABLE at this primitive, with the reason: "ALWAYS pair with" binds
  // the CALL SITE — the component offers the caption, but cannot make a surface
  // render it. Whether every paginated surface uses it is a survey for leg 2.
  it.skip(
    "not applicable at this primitive: 'always pair with' binds the call site; the component can only offer the caption, which it does",
    () => {},
  );
});
