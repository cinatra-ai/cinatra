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
// The drawing also gives both example bars an explicit 4px corner.
// Native CSS compilation checks the recipe; the separate browser case reads
// the final cascade in both palettes.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { compile } from "tailwindcss";

import { Skeleton } from "@/components/ui/skeleton";

afterEach(cleanup);

function renderSkeleton(className?: string) {
  const { container } = render(<Skeleton className={className} />);
  return container.querySelector('[data-slot="skeleton"]') as HTMLElement;
}

describe('clause: "Skeleton: surface-muted bars"', () => {
  it("paints the bar on the muted surface", () => {
    // `bg-muted` resolves through --color-muted to --surface-muted, the token
    // the clause names. This native assertion preserves that semantic role.
    expect(renderSkeleton().className).toContain("bg-muted");
  });

  it("draws a bar — a filled block — rather than an outline", () => {
    const cls = renderSkeleton().className;
    expect(cls).not.toMatch(/(^|\s)border(\s|$)/);

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

// Compile the shipped stylesheet and its cached imports, rather than pretending
// jsdom applies Tailwind. Evaluate only the radius recipe at a 16px rem base;
// the browser test remains responsible for the final live cascade.
let radiusRules: { selector: string; value: string }[];
let paletteRadius: Record<"cinatra" | "dark", number>;
beforeAll(async () => {
  const stylesheet = resolve(process.cwd(), "src/app/globals.css");
  const globals = await readFile(stylesheet, "utf8");
  const require = createRequire(resolve(process.cwd(), "package.json"));
  const compiled = await compile(globals, {
    base: dirname(stylesheet),
    loadStylesheet: async (id, base) => {
      let path: string;
      if (id === "tw-animate-css") {
        // This dependency exports CSS under the standard style condition.
        const root = resolve(dirname(stylesheet), "../../node_modules", id);
        const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
        path = resolve(root, manifest.exports["."].style);
      } else {
        path = id.startsWith(".") ? resolve(base, id) : require.resolve(id, { paths: [base] });
      }
      return { path, base: dirname(path), content: await readFile(path, "utf8") };
    },
  });
  const css = compiled.build(["rounded-md", "rounded-[4px]", "rounded-none", "rounded-lg"]);
  radiusRules = [...css.matchAll(/(\.rounded[^{}]+)\{([^{}]+)\}/g)].map((rule) => {
    const value = rule[2].match(/border-radius:\s*([^;]+);/)?.[1];
    if (!value) throw new Error(`Missing compiled radius for ${rule[1]}`);
    return { selector: rule[1].trim(), value };
  });
  paletteRadius = { cinatra: 0, dark: 0 };
  for (const palette of ["cinatra", "dark"] as const) {
    const block = globals.match(new RegExp(`\\.${palette}\\s*\\{([^}]+)\\}`))?.[1];
    const rem = block?.match(/--radius:\s*([\d.]+)rem;/)?.[1];
    if (!rem) throw new Error(`Missing actual ${palette} radius`);
    paletteRadius[palette] = Number(rem) * 16;
  }
});

function radiusPx(element: HTMLElement, palette: "cinatra" | "dark") {
  const matching = radiusRules.filter((rule) => element.matches(rule.selector));
  expect(matching).toHaveLength(1);
  const value = matching[0].value.replace("var(--radius)", `${paletteRadius[palette]}px`);
  if (value === "0") return 0;
  if (/^[\d.]+px$/.test(value)) return Number.parseFloat(value);
  const calc = value.match(/^calc\(([\d.]+)px - ([\d.]+)px\)$/);
  if (!calc) throw new Error(`Unsupported compiled radius: ${value}`);
  return Number(calc[1]) - Number(calc[2]);
}

describe("drawing example: the default bars have 4px corners", () => {
  for (const palette of ["cinatra", "dark"] as const) {
    it(`resolves the default corner to 4px in ${palette}`, () => {
      expect(radiusPx(renderSkeleton(), palette)).toBe(4);
    });
    it(`keeps explicit caller corner overrides in ${palette}`, () => {
      expect(radiusPx(renderSkeleton("rounded-none"), palette)).toBe(0);
      expect(radiusPx(renderSkeleton("rounded-lg h-4 w-40"), palette)).toBe(paletteRadius[palette]);
    });
  }
  it("distinguishes the old palette-dependent medium radius", () => {
    const probe = document.createElement("div");
    probe.className = "rounded-md";
    expect(radiusPx(probe, "cinatra")).toBe(6);
    expect(radiusPx(probe, "dark")).toBe(8);
  });
  it("forwards ordinary div properties and handlers", () => {
    const onClick = vi.fn();
    const { getByTitle } = render(<Skeleton id="pending-row" aria-busy="true" title="Loading row" onClick={onClick} />);
    const bar = getByTitle("Loading row");
    expect(bar.id).toBe("pending-row");
    expect(bar.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(bar);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
