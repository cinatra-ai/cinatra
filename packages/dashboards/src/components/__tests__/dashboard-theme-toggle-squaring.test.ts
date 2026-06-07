// Source-level regression guard for the Grid/Rows segmented-toggle
// inner-corner squaring in `dashboard-theme.css`.
//
// The Grid/Rows toggle is a DESCENDANT of the DC toolbar — drizzle-cube
// nests it one layout `<div>` deep and only renders it in edit mode — NOT
// a direct child. An earlier revision scoped the squaring with a `>`
// direct-child combinator, which silently never matched: the wrapper kept
// DC's 8px radius and both buttons kept 7px inner corners (a rounded notch
// at the seam instead of a flush join). A live Playwright UAT caught it.
//
// This guard asserts the shipped CSS uses the descendant combinator (no
// `>` between the toolbar hook and the toggle wrapper) and keeps the
// `:not(.dc:absolute *)` guard that scopes the override off DC's
// absolutely-positioned colour-palette dropdown. It is intentionally a
// source assertion: the runtime behaviour depends on DC's edit-mode DOM,
// which is not deterministically reproducible in a seeded headless run
// (the toggle only renders for certain dashboard layout states), so the
// authoritative runtime proof lives in the verify-work UAT record while
// this test fail-louds on the specific selector regression.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(
  fileURLToPath(new URL("../dashboard-theme.css", import.meta.url)),
  "utf8",
);

// The toggle wrapper class signature, exactly as it appears in the
// stylesheet (literal `\:` Tailwind colon escapes).
const TOGGLE = "div.dc\\:inline-flex.dc\\:rounded-md.dc\\:border";

describe("dashboard-theme Grid/Rows toggle squaring", () => {
  it("scopes the toggle rules with a descendant combinator, never `>` direct-child", () => {
    // The regressed form (`> ` direct child) must NOT appear anywhere — it
    // silently never matches the nested toggle.
    expect(CSS).not.toContain(`[data-cinatra-dc-toolbar] > ${TOGGLE}`);
    // The descendant form must be present.
    expect(CSS).toContain(`[data-cinatra-dc-toolbar] ${TOGGLE}`);
  });

  it("squares both inner corners + keeps the palette-dropdown guard", () => {
    // Both per-button squaring rules carry the `:not(.dc:absolute *)` guard
    // (so the override never leaks into DC's absolutely-positioned palette)
    // and target the direct button children of the toggle wrapper.
    const firstSel = `${TOGGLE}:not(.dc\\:absolute *) > button:first-child:not(:only-child)`;
    const lastSel = `${TOGGLE}:not(.dc\\:absolute *) > button:last-child:not(:only-child)`;
    expect(CSS).toContain(firstSel);
    expect(CSS).toContain(lastSel);

    // Assert each rule's BODY actually zeroes the inner corners — not just
    // that the selector exists (a value change to e.g. 7px would otherwise
    // slip through). Slice from the selector to its closing brace.
    const ruleBody = (sel: string) => {
      const start = CSS.indexOf(sel);
      const open = CSS.indexOf("{", start);
      const close = CSS.indexOf("}", open);
      return CSS.slice(open, close);
    };
    const firstBody = ruleBody(firstSel);
    expect(firstBody).toContain("border-top-right-radius: 0");
    expect(firstBody).toContain("border-bottom-right-radius: 0");
    const lastBody = ruleBody(lastSel);
    expect(lastBody).toContain("border-top-left-radius: 0");
    expect(lastBody).toContain("border-bottom-left-radius: 0");

    // The wrapper rule keeps overflow:hidden + a 7px radius so the seam is
    // clipped flush even before the per-button squaring lands.
    const wrapperIdx = CSS.indexOf(`[data-cinatra-dc-toolbar] ${TOGGLE}:not(.dc\\:absolute *) {`);
    expect(wrapperIdx).toBeGreaterThan(-1);
    const wrapperRule = CSS.slice(wrapperIdx, wrapperIdx + 400);
    expect(wrapperRule).toContain("overflow: hidden");
    expect(wrapperRule).toContain("border-radius: 7px");
  });
});
