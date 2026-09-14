/**
 * The dim overlay covers EVERYTHING below the 4rem navbar (cinatra#2735).
 *
 *   pnpm exec vitest run src/components/ui/__tests__/modal-overlay-dims-below-navbar.test.ts
 *
 * The ratified drawing settles both halves of the coverage question. Dialog:
 * "Overlay `top: 4rem` so it doesn't cover the navbar." Drawer: "the overlay
 * dims everything below the 4rem navbar like Dialog." So the navbar staying
 * bright is INTENDED (`top-16`), and everything under it — the left sidebar
 * included — must be dimmed.
 *
 * The geometry half (`inset-x-0 bottom-0 top-16`) was already true of all three
 * modal families. The STACKING half was not: the sidebar is a fixed `z-[70]`
 * element, and a scrim painted below that number leaves it bright however wide
 * the scrim is. `AlertDialogOverlay` sat at `z-50` and lost to it.
 *
 * Two arms, both read off the shared primitives themselves so no call site can
 * opt out:
 *   1. every dim overlay out-stacks the sidebar (the sidebar IS dimmed);
 *   2. every modal's own content out-stacks its own overlay — a raised scrim
 *      must never dim the dialog it belongs to.
 *
 * Source-text assertions are this directory's convention for the Radix
 * wrappers (the vitest env here has no CSS engine, so a computed z-index is not
 * expressible). The rendered coverage in both palettes is measured on the live
 * boot.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const UI = path.join(process.cwd(), "src", "components", "ui");
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

/** The numeric z-index of the first `z-[N]` / `z-N` class in a snippet. */
function zIndexOf(snippet: string, label: string): number {
  const bracketed = snippet.match(/\bz-\[(\d+)\]/);
  if (bracketed) return Number(bracketed[1]);
  const bare = snippet.match(/\bz-(\d+)\b/);
  if (!bare) throw new Error(`no z-index class found on ${label}`);
  return Number(bare[1]);
}

/** The class string carrying a z-index on the element with `data-slot="<slot>"`. */
function slotClasses(source: string, slot: string): string {
  const at = [`data-slot="${slot}"`, `data-slot='${slot}'`]
    .map((needle) => source.indexOf(needle))
    .find((i) => i >= 0);
  if (at === undefined) throw new Error(`no element carries data-slot ${slot}`);
  const quoted = source.slice(at).match(/["'`]([^"'`]*\bz-[^"'`]*)["'`]/);
  if (!quoted) throw new Error(`no class string with a z-index follows ${slot}`);
  return quoted[1];
}

/** The `z-[70]` the fixed sidebar paints at — the number every scrim must beat. */
const SIDEBAR_Z = zIndexOf(
  read("src/components/ui/sidebar.tsx").match(/"fixed inset-y-0 [^"]*"/)?.[0] ?? "",
  "the fixed sidebar",
);

/**
 * The `z-[160]` the portalled popover / dropdown / select content paints at —
 * the number no scrim or dialog panel may reach, or a select opened from
 * inside a dialog would render behind it.
 */
const POPOVER_Z = zIndexOf(
  slotClasses(read("src/components/ui/popover.tsx"), "popover-content"),
  "the portalled popover content",
);

/** The three modal families that paint a dim scrim below the navbar. */
const MODALS = [
  { name: "Dialog", file: "dialog.tsx", overlay: "dialog-overlay", content: "dialog-content" },
  {
    name: "AlertDialog",
    file: "alert-dialog.tsx",
    overlay: "alert-dialog-overlay",
    content: "alert-dialog-content",
  },
  { name: "Sheet", file: "sheet.tsx", overlay: "sheet-overlay", content: "sheet-content" },
] as const;

describe("the sidebar's own stacking level is the number to beat", () => {
  it("reads a real z-index off the fixed sidebar", () => {
    expect(SIDEBAR_Z).toBeGreaterThan(0);
  });
});

describe.each(MODALS)(
  'clause: "the overlay dims everything below the 4rem navbar" — $name',
  ({ file, overlay, content }) => {
    const source = readFileSync(path.join(UI, file), "utf8");
    const overlayClasses = slotClasses(source, overlay);
    const contentClasses = slotClasses(source, content);

    it("leaves the navbar bright: the scrim starts one navbar down", () => {
      expect(overlayClasses).toContain("top-16");
      expect(overlayClasses).toContain("inset-x-0");
      expect(overlayClasses).toContain("bottom-0");
    });

    it("out-stacks the sidebar, so the sidebar is dimmed too", () => {
      expect(
        zIndexOf(overlayClasses, overlay),
        `${overlay} paints below the sidebar's z-${SIDEBAR_Z}, which leaves the sidebar bright`,
      ).toBeGreaterThan(SIDEBAR_Z);
    });

    it("keeps its own content above its own scrim", () => {
      expect(zIndexOf(contentClasses, content)).toBeGreaterThan(
        zIndexOf(overlayClasses, overlay),
      );
    });

    it("stays BELOW the portalled popover band, so a select inside it still opens", () => {
      // The band is bounded on BOTH sides: a scrim raised far enough to dim the
      // sidebar could just as easily bury the popover / dropdown / select
      // content a dialog's own form portals out to.
      expect(
        zIndexOf(contentClasses, content),
        `${content} must not out-stack the portalled popover band (z-${POPOVER_Z})`,
      ).toBeLessThan(POPOVER_Z);
    });
  },
);
