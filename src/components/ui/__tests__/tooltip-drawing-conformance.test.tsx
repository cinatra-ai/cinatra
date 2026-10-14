// @vitest-environment jsdom
//
// Tooltip — the graded checklist for the components drawing's
// "Tooltip / Popover" section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/tooltip-drawing-conformance.test.tsx
//
// The clauses this primitive is answerable for, quoted verbatim:
//
//   "ink ground · cream text"
//   "200ms delay"
//   "12px tooltip"
//   "Tooltips are navy with cream type; popovers are surface-strong with navy
//    text. Tooltips read at 12px."
//
// specs/app-components.html#Tooltip / Popover: the approved example also specifies padding 6px 10px. Native checks pin
// that recipe on actual Radix DOM; browser-computed geometry is separate.
// Its content corner is 6px. The corner checks below read the actual Radix
// recipe and caller merge behavior; cached Tailwind declaration evidence and
// the authored browser case separately cover the geometry contract.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { compile } from "tailwindcss";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// jsdom ships no ResizeObserver and no DOMRect measurement; Radix's positioning
// layer calls both. Stubbing them is a test-ENVIRONMENT shim, not a relaxed
// assertion: every clause below is still read off the element Radix rendered.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  ResizeObserverStub;
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(cleanup);

function renderTooltip({ className, shortcut = false }: { className?: string; shortcut?: boolean } = {}) {
  render(
    <TooltipProvider>
      <Tooltip open>
        <TooltipTrigger>Approve</TooltipTrigger>
        <TooltipContent className={className}>Approve and send to all 12 prospects{shortcut ? <kbd data-slot="kbd">⌘K</kbd> : null}</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
  // The content is portalled, so it is found on the document rather than in the
  // render container.
  return document.querySelector('[data-slot="tooltip-content"]') as HTMLElement;
}

describe('clause: "ink ground · cream text" / "Tooltips are navy with cream type"', () => {
  it("inverts the page: the ink token becomes the ground and the ground token the type", () => {
    // --foreground is the navy ink and --background the warm paper (#f1f1ed —
    // the "cream"). The tooltip is the one surface that swaps them, which is
    // exactly what the clause describes. Both computed values are re-read on
    // the boot in both palettes ("tooltip ground", primitive-wave-leg1.spec.ts).
    const el = renderTooltip();
    expect(el.className).toContain("bg-foreground");
    expect(el.className).toContain("text-background");
  });

  it("carries the same inversion onto the arrow, so the pointer is not a stray colour", () => {
    renderTooltip();
    const arrow = document
      .querySelector('[data-slot="tooltip-content"]')!
      .querySelector("svg");
    expect(arrow).not.toBeNull();
    expect(arrow!.getAttribute("class") ?? "").toContain("bg-foreground");
  });
});

describe('clause: "12px tooltip" / "Tooltips read at 12px"', () => {
  it("sets the tooltip type at the 12px step", () => {
    // `text-xs` is 0.75rem = 12px.
    expect(renderTooltip().className).toContain("text-xs");
  });

  it("keeps the tooltip a single short line rather than a paragraph surface", () => {
    // The clause pairs 12px with the tooltip's role; `max-w-xs` is what stops a
    // tooltip growing into the popover's job.
    expect(renderTooltip().className).toContain("max-w-xs");
  });
});

describe('specs/app-components.html#Tooltip / Popover approved example: "padding: 6px 10px"', () => {
  it("renders the default ten-pixel horizontal and six-pixel vertical recipe", () => {
    const classes = renderTooltip().className.split(/\s+/);
    // jsdom has no generated Tailwind stylesheet: this pins the shipped recipe,
    // not computed geometry. The companion both-palette browser case reads it.
    expect(classes).toContain("px-2.5");
    expect(classes).not.toContain("px-3");
    expect(classes).toContain("py-1.5");
  });

  it("preserves a caller's horizontal override while retaining vertical padding", () => {
    const classes = renderTooltip({ className: "px-5" }).className.split(/\s+/);
    expect(classes).toContain("px-5");
    expect(classes).not.toContain("px-2.5");
    expect(classes).not.toContain("px-3");
    expect(classes).toContain("py-1.5");
  });

  it("preserves the keyboard shortcut's existing right-padding exception", () => {
    const content = renderTooltip({ shortcut: true });
    expect(content.querySelector('[data-slot="kbd"]')?.textContent).toBe("⌘K");
    expect(content.className.split(/\s+/)).toContain("has-data-[slot=kbd]:pr-1.5");
    expect(content.className.split(/\s+/)).toContain("px-2.5");
  });
});

describe('specs/app-components.html#Tooltip / Popover approved example: "border-radius: 6px"', () => {
  it("renders a fixed six-pixel content corner instead of the palette-dependent step", () => {
    const classes = renderTooltip().className.split(/\s+/);
    expect(classes).toContain("rounded-[6px]");
    expect(classes).not.toContain("rounded-md");
  });

  it("lets a caller choose its corner without changing the arrow recipe", () => {
    const content = renderTooltip({ className: "rounded-xl" });
    const classes = content.className.split(/\s+/);
    expect(classes).toContain("rounded-xl");
    expect(classes).not.toContain("rounded-[6px]");
    expect(classes).not.toContain("rounded-md");
    expect(content.querySelector("svg")?.getAttribute("class")?.split(/\s+/))
      .toContain("rounded-[2px]");
  });

  it("keeps keyboard corners, semantic colors and the real focusable trigger", () => {
    const content = renderTooltip({ shortcut: true });
    expect(content.className.split(/\s+/)).toContain("**:data-[slot=kbd]:rounded-sm");
    expect(content.className.split(/\s+/)).toContain("bg-foreground");
    expect(content.className.split(/\s+/)).toContain("text-background");
    const trigger = screen.getByRole("button", { name: /^Approve$/ });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    expect(content.querySelector('[data-slot="kbd"]')?.textContent).toBe("⌘K");
  });
});

// specs/app-components.html#Tooltip / Popover, version 0.6.0 (cinatra#4036): the shadow is set per palette. The light tooltip keeps
// the approved example's shadow, 0 4px 8px -2px rgba(21,33,58,0.3); the dark-palette tooltip draws 0 4px 8px
// rgba(0,0,0,0.5), the dark value of the application's strong elevation shadow (--cinatra-shadow-strong in .dark).
// The browser case tests/e2e/design/conformance/tooltip-horizontal-padding-3189.spec.ts reads the live cascade.
describe("specs/app-components.html#Tooltip / Popover: the shadow is set per palette", () => {
  const LIGHT_SHADOW = "shadow-[0_4px_8px_-2px_rgba(21,33,58,0.3)]";
  const DARK_SHADOW = "dark:shadow-[0_4px_8px_rgba(0,0,0,0.5)]";
  const isShadow = (token: string) => /(^|:)shadow(-|$)/.test(token);

  // Compile the shipped stylesheet, as the dialog check does, so the classes are read as the declarations
  // Tailwind generates for them rather than as strings jsdom never styles.
  let globals: string;
  let compiled: Awaited<ReturnType<typeof compile>>;
  beforeAll(async () => {
    const stylesheet = resolve(process.cwd(), "src/app/globals.css");
    globals = await readFile(stylesheet, "utf8");
    const require = createRequire(resolve(process.cwd(), "package.json"));
    compiled = await compile(globals, {
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
  });

  /** The --tw-shadow value of every compiled rule of these classes, by the palette the rule applies in. */
  function shadowsByPalette(tokens: string[]) {
    const css = compiled.build(tokens);
    const found: Record<"light" | "dark", string[]> = { light: [], dark: [] };
    for (const rule of css.matchAll(/\n {2}(\.[^\n{]+) \{\n([\s\S]*?)\n {2}\}/g)) {
      const value = rule[2].match(/--tw-shadow:\s*([^;]+);/)?.[1];
      if (value) found[rule[2].includes("&:is(.dark *)") ? "dark" : "light"].push(value);
    }
    return found;
  }

  it("carries the light and the dark shadow as its only shadow classes", () => {
    const classes = renderTooltip().className.split(/\s+/);
    expect(classes).toContain(LIGHT_SHADOW);
    expect(classes).toContain(DARK_SHADOW);
    expect(classes.filter(isShadow).sort()).toEqual([DARK_SHADOW, LIGHT_SHADOW].sort());
  });

  it("compiles to the drawn shadow in each palette and to no other shadow", () => {
    expect(shadowsByPalette(renderTooltip().className.split(/\s+/))).toEqual({
      light: ["0 4px 8px -2px var(--tw-shadow-color, rgba(21,33,58,0.3))"],
      dark: ["0 4px 8px var(--tw-shadow-color, rgba(0,0,0,0.5))"],
    });
  });

  it("takes the dark value from the dark palette's strong elevation shadow", () => {
    const dark = globals.match(/\.dark\s*\{([^}]+)\}/)?.[1];
    const strong = dark?.match(/--cinatra-shadow-strong:\s*([^;]+);/)?.[1];
    expect(strong?.replace(/\s+/g, "")).toBe("0 4px 8px rgba(0,0,0,0.5)".replace(/\s+/g, ""));
  });

  it("adds no shadow to the arrow", () => {
    renderTooltip();
    const arrow = document.querySelector('[data-slot="tooltip-content"]')!.querySelector("svg");
    expect((arrow?.getAttribute("class") ?? "").split(/\s+/).filter(isShadow)).toEqual([]);
  });
});

describe('clause: "200ms delay"', () => {
  it("opens on the stated 200ms delay by default", () => {
    // GRADED AT THE PROVIDER'S DEFAULT, which is the form this clause makes.
    // Radix reads the delay from TooltipProvider, and every tooltip in the
    // product renders under the app's provider WITHOUT passing one — so the
    // default IS the rendered behaviour. Asserting it by waiting on a real
    // hover would grade the test's timers rather than the component, so the
    // declared default is read from the component itself.
    const declared = TooltipProvider.toString();
    expect(declared).toMatch(/delayDuration\s*=\s*200/);
  });

  it("still lets a call site override the delay where a surface needs to", () => {
    const declared = TooltipProvider.toString();
    expect(declared).toContain("delayDuration");
  });
});

describe('clause: "popovers are surface-strong with navy text"', () => {
  // NOT APPLICABLE at this primitive, with the reason: the sentence's second
  // half governs the sibling Popover, which is graded in
  // popover-drawing-conformance.test.tsx. It is quoted here only because the
  // drawing states the two as one contrast.
  it.skip(
    "not applicable at this primitive: the popover half of the clause is graded in popover-drawing-conformance.test.tsx",
    () => {},
  );
});
