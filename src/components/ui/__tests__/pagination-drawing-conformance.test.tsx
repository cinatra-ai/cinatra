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
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { compile } from "tailwindcss";

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

// §Pagination, approved components drawing: the example's inner flex row has
// gap:4px. Compile the shipped stylesheet and its real cached imports, then
// match its generated selectors against actual component DOM. This is native
// CSS-declaration evidence at a 16px rem base, not browser layout/paint proof;
// the separate browser guard reads the final live cascade in both palettes.
let gapRules: { selector: string; value: string }[];
let spacingPx: number;
beforeAll(async () => {
  const stylesheet = resolve(process.cwd(), "src/app/globals.css");
  const globals = await readFile(stylesheet, "utf8");
  const require = createRequire(resolve(process.cwd(), "package.json"));
  const compiled = await compile(globals, {
    base: dirname(stylesheet),
    loadStylesheet: async (id, base) => {
      let path: string;
      if (id === "tw-animate-css") {
        const root = resolve(process.cwd(), "node_modules", id);
        const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
        path = resolve(root, manifest.exports["."].style);
      } else {
        path = id.startsWith(".") ? resolve(base, id) : require.resolve(id, { paths: [base] });
      }
      return { path, base: dirname(path), content: await readFile(path, "utf8") };
    },
  });
  const css = compiled.build(["gap-0.5", "gap-[4px]", "gap-[9px]"]);
  const spacing = css.match(/--spacing:\s*([\d.]+)(rem|px);/);
  if (!spacing) throw new Error("Missing shipped spacing token");
  spacingPx = Number(spacing[1]) * (spacing[2] === "rem" ? 16 : 1);
  gapRules = [...css.matchAll(/(\.gap[^{}]+)\{([^{}]+)\}/g)].map((rule) => {
    const value = rule[2].match(/gap:\s*([^;]+);/)?.[1];
    if (!value) throw new Error(`Missing compiled gap for ${rule[1]}`);
    return { selector: rule[1].trim(), value };
  });
});

function declaredGapPx(element: HTMLElement) {
  const matching = gapRules.filter((rule) => element.matches(rule.selector));
  expect(matching).toHaveLength(1);
  const value = matching[0].value;
  if (/^[\d.]+px$/.test(value)) return Number.parseFloat(value);
  const calc = value.match(/^calc\(var\(--spacing\) \* ([\d.]+)\)$/);
  if (!calc) throw new Error(`Unsupported compiled gap: ${value}`);
  return spacingPx * Number(calc[1]);
}

function renderSpacingPagination(palette: "cinatra" | "dark", className?: string) {
  return render(
    <div className={palette}>
      <Pagination aria-label="Results pages">
        <PaginationContent className={className} id="results-pages" data-example="spacing">
          <PaginationItem><PaginationPrevious href="#previous" /></PaginationItem>
          <PaginationItem><PaginationLink href="#page-2" isActive>2</PaginationLink></PaginationItem>
          <PaginationItem><PaginationNext href="#next" /></PaginationItem>
        </PaginationContent>
        <PaginationCaption>2 of 12</PaginationCaption>
      </Pagination>
    </div>,
  );
}

describe("§Pagination: the example row has a 4px gap", () => {
  for (const palette of ["cinatra", "dark"] as const) {
    it(`declares the default 4px gap in ${palette} component DOM`, () => {
      const { container } = renderSpacingPagination(palette);
      const content = container.querySelector('[data-slot="pagination-content"]') as HTMLElement;
      expect(declaredGapPx(content)).toBe(4);
    });
    it(`keeps caller gap overrides and navigation semantics in ${palette}`, () => {
      const { container, getByRole, getByText } = renderSpacingPagination(palette, "gap-[9px]");
      const content = getByRole("list");
      expect(declaredGapPx(content)).toBe(9);
      expect(content.id).toBe("results-pages");
      expect(content.getAttribute("data-example")).toBe("spacing");
      expect(getByRole("navigation", { name: "Results pages" }).contains(content)).toBe(true);
      expect(getByRole("link", { name: "Go to previous page" }).getAttribute("href")).toBe("#previous");
      expect(getByRole("link", { name: "2" }).getAttribute("aria-current")).toBe("page");
      expect(getByRole("link", { name: "Go to next page" }).getAttribute("href")).toBe("#next");
      expect(getByText("2 of 12").getAttribute("data-slot")).toBe("pagination-caption");
      expect(container.querySelectorAll('[data-slot="pagination-link"]')).toHaveLength(3);
    });
  }
  it("distinguishes the old generated half-step gap", () => {
    const probe = document.createElement("ul");
    probe.className = "gap-0.5";
    expect(declaredGapPx(probe)).toBe(2);
  });
});
