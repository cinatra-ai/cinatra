// @vitest-environment jsdom
//
// Dialog — the graded checklist for the components drawing's "Dialog / Sheet"
// section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/dialog-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "--paper (= pages)"
//   "starts below 4rem navbar"
//   "dim overlay"
//   "etched header rule"
//   "Modal dialogs use --paper — the same background as pages; right-side
//    sheets sit at full-height. Overlay top: 4rem so it doesn't cover the
//    navbar. Dialog header uses an etched paired-line rule for separation."
//
// THE DEPARTURE THIS FILE PINS. The content panel drew `bg-popover`, which
// resolves through `--popover` to `--surface-strong` — white — while the
// clause names `--paper`, the ground the pages themselves are drawn on
// (`--background`). The gap was already visible in the product: the
// marketplace detail modal hand-rolls `bg-background` onto its own
// `DialogContent` with a comment naming the same clause, which is precisely
// the failure class this wave exists to remove — a surface repairing, one
// screen at a time, something the shared primitive should have drawn. The
// primitive now draws the paper ground and that surface's override is
// redundant rather than load-bearing.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { compile } from "tailwindcss";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

afterEach(cleanup);

function renderDialog() {
  render(
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve drafts.</DialogTitle>
          <DialogDescription>Twelve drafts pending your read.</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>,
  );
  const content = document.querySelector(
    '[data-slot="dialog-content"]',
  ) as HTMLElement;
  const overlay = document.querySelector(
    '[data-slot="dialog-overlay"]',
  ) as HTMLElement;
  const header = document.querySelector(
    '[data-slot="dialog-header"]',
  ) as HTMLElement;
  return { content, overlay, header };
}

describe('clause: "Modal dialogs use --paper — the same background as pages"', () => {
  it("draws the content panel on the page ground, not on the white card level", () => {
    const { content } = renderDialog();
    // REGRESSION PIN for the fixed clause. `bg-background` resolves through
    // `--background` to the drawing's `--paper` (#f1f1ed in the light palette);
    // `bg-popover` — the value this replaced — resolves to `--surface-strong`.
    // The computed rgb, in both palettes, is read on the boot
    // ("dialog paper ground", primitive-wave-leg1.spec.ts).
    expect(content.className).toContain("bg-background");
    expect(content.className).not.toContain("bg-popover");
  });

  it("still lets a surface override the ground it inherits", () => {
    render(
      <Dialog open>
        <DialogContent className="bg-card">
          <DialogTitle>Ground override</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const overridden = document.querySelectorAll('[data-slot="dialog-content"]');
    const last = overridden[overridden.length - 1] as HTMLElement;
    expect(last.className).toContain("bg-card");
    expect(last.className).not.toContain("bg-background");
  });
});

describe('clause: "Overlay top: 4rem so it doesn\'t cover the navbar."', () => {
  it("starts the overlay one navbar down and runs it to the viewport floor", () => {
    const { overlay } = renderDialog();
    expect(overlay.className).toContain("top-16");
    expect(overlay.className).toContain("bottom-0");
    expect(overlay.className).toContain("inset-x-0");
  });
});

describe('clause: "dim overlay"', () => {
  it("dims the surface behind the dialog rather than blanking it", () => {
    const { overlay } = renderDialog();
    expect(overlay.className).toContain("bg-black/50");
  });

  it("renders the backdrop by default, without the caller asking", () => {
    const { overlay } = renderDialog();
    expect(overlay).not.toBeNull();
  });
});

describe('clause: "Dialog header uses an etched paired-line rule for separation."', () => {
  it("closes the header with the shared etched rule, not a plain border", () => {
    const { header } = renderDialog();
    expect(header.className).toContain("divider-etched-after");
    expect(header.className).not.toContain("border-b");
  });
});

describe('clause: "right-side sheets sit at full-height."', () => {
  // NOT APPLICABLE to this primitive, with the reason: the sentence reads on
  // `SheetContent`, a separate file with its own side geometry. It is graded
  // in this leg's record for `sheet`, not here — grading it against
  // `DialogContent` would assert a rule about a component this file does not
  // render.
  it.skip("not applicable to Dialog: the sentence governs SheetContent's side geometry", () => {});
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
  const css = compiled.build(["rounded-lg", "rounded-[8px]", "rounded-none", "rounded-md"]);
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

function renderCornerDialog(className?: string) {
  render(
    <Dialog open>
      <DialogContent className={className}>
        <DialogTitle>Approve drafts.</DialogTitle>
        <DialogDescription>Twelve drafts pending your read.</DialogDescription>
      </DialogContent>
    </Dialog>,
  );
  return document.querySelector('[data-slot="dialog-content"]') as HTMLElement;
}

describe("drawing example: the inner dialog has 8px corners", () => {
  for (const palette of ["cinatra", "dark"] as const) {
    it(`resolves the default corner to 8px in ${palette}`, () => {
      expect(radiusPx(renderCornerDialog(), palette)).toBe(8);
    });
    it(`keeps explicit caller corner overrides in ${palette}`, () => {
      expect(radiusPx(renderCornerDialog("rounded-none"), palette)).toBe(0);
      cleanup();
      expect(radiusPx(renderCornerDialog("rounded-md"), palette)).toBe(paletteRadius[palette] - 2);
    });
  }
  it("distinguishes the old palette-dependent large radius", () => {
    const probe = document.createElement("div");
    probe.className = "rounded-lg";
    expect(radiusPx(probe, "cinatra")).toBe(8);
    expect(radiusPx(probe, "dark")).toBe(10);
  });
  it("keeps the portal, focus and close-button interaction", async () => {
    const onOpenChange = vi.fn();
    const { container, getByRole } = render(
      <Dialog defaultOpen onOpenChange={onOpenChange}>
        <DialogContent id="approve-dialog" data-example="approval">
          <DialogTitle>Approve drafts.</DialogTitle>
          <DialogDescription>Twelve drafts pending your read.</DialogDescription>
          <input aria-label="Approval note" />
        </DialogContent>
      </Dialog>,
    );
    const dialog = getByRole("dialog");
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(dialog.id).toBe("approve-dialog");
    expect(dialog.getAttribute("data-example")).toBe("approval");
    await waitFor(() => expect(document.activeElement).toBe(getByRole("textbox", { name: "Approval note" })));
    fireEvent.click(getByRole("button", { name: /^Close$/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull());
  });
  it("keeps Escape dismissal and caller overlay/close-button options", async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog defaultOpen onOpenChange={onOpenChange}>
        <DialogContent showOverlay={false} showCloseButton={false}>
          <DialogTitle>Approve drafts.</DialogTitle>
          <DialogDescription>Twelve drafts pending your read.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull());
  });
});
