// @vitest-environment jsdom
//
// The SDK's Tooltip (packages/sdk-ui/src/ui/tooltip.tsx) against the components
// drawing's "Tooltip / Popover" section (cinatra#3189, G4 tooltip).
//
//   pnpm exec vitest run src/components/ui/__tests__/sdk-tooltip-drawn-recipe-3189.test.tsx
//
// The drawing: "a shadow per palette"; "In the light palette it is a navy
// shadow, 0 4px 8px -2px rgba(21,33,58,0.3) ... In the application's dark
// palette ... 0 4px 8px rgba(0,0,0,0.5)". Its example draws the tooltip with
// a 6px corner and 6px 10px padding. The host copy (src/components/ui/tooltip.tsx)
// already carries that recipe (tooltip-drawing-conformance.test.tsx). The SDK
// copy is live in the application too: the SDK's AccessCombobox renders it,
// and the application re-exports that component.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { compile } from "tailwindcss";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../../../packages/sdk-ui/src/ui/tooltip";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

afterEach(cleanup);

function renderTooltip(className?: string): HTMLElement {
  render(
    <TooltipProvider>
      <Tooltip open>
        <TooltipTrigger>Share</TooltipTrigger>
        <TooltipContent className={className}>Only members of this workspace</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
  return document.querySelector('[data-slot="tooltip-content"]') as HTMLElement;
}

const LIGHT_SHADOW = "shadow-[0_4px_8px_-2px_rgba(21,33,58,0.3)]";
const DARK_SHADOW = "dark:shadow-[0_4px_8px_rgba(0,0,0,0.5)]";
const isShadow = (token: string) => /(^|:)shadow(-|$)/.test(token);

describe("the SDK tooltip: the shadow is set per palette", () => {
  let compiled: Awaited<ReturnType<typeof compile>>;
  beforeAll(async () => {
    const stylesheet = resolve(process.cwd(), "src/app/globals.css");
    const globals = await readFile(stylesheet, "utf8");
    const require = createRequire(resolve(process.cwd(), "package.json"));
    compiled = await compile(globals, {
      base: dirname(stylesheet),
      loadStylesheet: async (id, base) => {
        let path: string;
        if (id === "tw-animate-css") {
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
    expect(classes.filter(isShadow).sort()).toEqual([DARK_SHADOW, LIGHT_SHADOW].sort());
  });

  it("compiles to the drawn shadow in each palette and to no other shadow", () => {
    expect(shadowsByPalette(renderTooltip().className.split(/\s+/))).toEqual({
      light: ["0 4px 8px -2px var(--tw-shadow-color, rgba(21,33,58,0.3))"],
      dark: ["0 4px 8px var(--tw-shadow-color, rgba(0,0,0,0.5))"],
    });
  });

  it("adds no shadow to the arrow", () => {
    const arrow = renderTooltip().querySelector("svg");
    expect((arrow?.getAttribute("class") ?? "").split(/\s+/).filter(isShadow)).toEqual([]);
  });
});

describe("the SDK tooltip: the drawn example's corner and padding", () => {
  it("draws a 6px corner and 6px 10px padding, as the host copy does", () => {
    const classes = renderTooltip().className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["rounded-[6px]", "px-2.5", "py-1.5"]));
    expect(classes).not.toContain("rounded-md");
    expect(classes).not.toContain("px-3");
  });

  it("keeps the ink ground, the cream type and the 12px step", () => {
    const classes = renderTooltip().className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["bg-foreground", "text-background", "text-xs"]));
  });

  it("lets a caller's own corner win", () => {
    expect(renderTooltip("rounded-xl").className.split(/\s+/)).toContain("rounded-xl");
  });
});
