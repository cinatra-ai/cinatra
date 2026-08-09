// cinatra#2546 — the collapsed-sidebar nav tooltip was clipped along its top
// edge by the sticky app-shell header.
//
// It is NOT an overflow/portal bug (the tooltip IS portaled): it is a stacking
// conflict. Tooltip content rendered at `z-50` while the header paints an
// opaque, blurred 64px band at `z-[140]`, so the header outranked it — and
// `sideOffset=0` leaves no clearance, which maximises the overlap for the items
// pinned to the top of the rail (Approvals, Configuration).
//
// This is a RELATIONSHIP contract, not a magic-number one: the tooltip must
// outrank every surface that can host a tooltip trigger. Asserting the numbers
// against each other (rather than pinning "z-[210]") keeps the test meaningful
// when a layer is re-banded — raise the header and this fails until the tooltip
// follows.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** First `z-[<n>]` on the line that contains `anchor`. */
function zIndexNear(source: string, anchor: string): number {
  const line = source.split("\n").find((l) => l.includes(anchor));
  if (!line) throw new Error(`anchor not found: ${anchor}`);
  const match = line.match(/z-\[(\d+)\]/);
  if (!match) throw new Error(`no z-[n] on the line for: ${anchor}`);
  return Number(match[1]);
}

/** Every `z-[<n>]` in a file — used where the file declares more than one. */
function allZIndexes(source: string): number[] {
  return [...source.matchAll(/z-\[(\d+)\]/g)].map((m) => Number(m[1]));
}

const tooltipZ = zIndexNear(
  read("src/components/ui/tooltip.tsx"),
  "data-[side=bottom]:slide-in-from-top-2",
);

describe("tooltip stacking (#2546)", () => {
  it("outranks the sticky app-shell header that used to clip it", () => {
    const headerZ = zIndexNear(read("src/components/app-shell.tsx"), "sticky z-[");
    expect(headerZ).toBeGreaterThan(0);
    expect(tooltipZ).toBeGreaterThan(headerZ);
  });

  it("outranks EVERY layer the app shell declares, not just the header", () => {
    // The shell also raises its own menus above the header band (z-[200]
    // overrides on the notifications popover and the profile dropdown). Take
    // the file's maximum so a newly added layer is covered automatically.
    const shellLayers = allZIndexes(read("src/components/app-shell.tsx"));
    expect(shellLayers.length).toBeGreaterThan(1);
    expect(tooltipZ).toBeGreaterThan(Math.max(...shellLayers));
  });

  it("outranks every other surface that can host a tooltip trigger", () => {
    const layers: Array<[string, number]> = [
      ["dialog overlay", zIndexNear(read("src/components/ui/dialog.tsx"), "fixed inset-x-0 bottom-0 top-16")],
      ["dialog content", zIndexNear(read("src/components/ui/dialog.tsx"), "fixed top-1/2 left-1/2")],
      ["popover content", zIndexNear(read("src/components/ui/popover.tsx"), "origin-(--radix-popover-content-transform-origin)")],
      ["dropdown content", zIndexNear(read("src/components/ui/dropdown-menu.tsx"), "origin-(--radix-dropdown-menu-content-transform-origin)")],
      ["select content", zIndexNear(read("src/components/ui/select.tsx"), "origin-(--radix-select-content-transform-origin)")],
    ];
    for (const [name, z] of layers) {
      expect({ layer: name, z, tooltipZ, above: tooltipZ > z }).toMatchObject({
        above: true,
      });
    }
  });

  it("stays a plain integer band value (no z-auto / no bare z-50 regression)", () => {
    const source = read("src/components/ui/tooltip.tsx");
    // The content class must not carry the old out-of-band `z-50`.
    expect(/"z-50 inline-flex/.test(source)).toBe(false);
    expect(Number.isInteger(tooltipZ)).toBe(true);
  });
});
