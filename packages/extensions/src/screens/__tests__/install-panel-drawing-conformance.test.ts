/**
 * The §I.1 in-card install panel, against the drawing (cinatra#2737).
 *
 *   pnpm --filter ./packages/extensions exec vitest run \
 *     src/screens/__tests__/install-panel-drawing-conformance.test.ts
 *
 * The drawing stacks the panel body as ONE centred column — eyebrow, then the
 * 36px scope-picker trigger, then the actions, 10px apart:
 *
 *   <div style="padding: 14px; flex: 1 1 auto; display: flex;
 *               flex-direction: column; justify-content: center; gap: 10px;">
 *     …"Install for"… …the 36px trigger… …Cancel / Install now…
 *
 * and its prose says a close × sits "in the header's corner" and "does the same
 * thing as Cancel", at `top: 10px; right: 10px`, 24×24, on the banner's own
 * ink at 0.85 opacity.
 *
 * What shipped instead put the eyebrow OUTSIDE the region that carried
 * `justify-center`, so the region grew to fill the face and floated the lone
 * 36px picker to its vertical middle — leaving the eyebrow stranded above a
 * void instead of adjacent to the control it labels.
 *
 * The other two clauses of the same section are pinned here too, because both
 * are invariants a layout edit can silently break: the fixed block size that
 * keeps the grid row from jumping, and errors reporting as a toast rather than
 * growing the panel.
 *
 * Source-text assertions are this directory's convention for these client
 * screens; the package's vitest environment is `node`, so a computed style is
 * not expressible here. The rendered geometry, in both palettes and on a long-
 * and a short-title card, is measured on the live boot.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const SCREENS = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(SCREENS, file), "utf8");

const PANEL = read("extension-install-scope-panel.tsx");
const CARD = read("marketplace-listing-card.tsx");
const SWITCHER = read("card-face-switcher.tsx");

/** The panel body's own root element — the drawn centred column. */
const PANEL_ROOT =
  PANEL.match(/<div\s+data-testid="extension-install-panel-body"[\s\S]*?>/)?.[0] ?? "";

/** The wrapper the picker (and each availability empty state) renders inside. */
const PICKER_REGION =
  PANEL.match(/\{\/\* ONLY the middle region scrolls[\s\S]*?\n\s*<div className="([^"]*)"/)?.[1] ??
  PANEL.match(/<div className="(flex min-h-0[^"]*overflow-y-auto[^"]*)">/)?.[1] ??
  "";

describe('clause: the panel body is one centred column — eyebrow, 36px trigger, actions', () => {
  it("centres the whole column, at the drawn 10px rhythm", () => {
    expect(PANEL_ROOT).toBeTruthy();
    expect(PANEL_ROOT).toMatch(/flex-col/);
    // `flex-1` is what makes the body FILL the fixed face; without it the
    // column shrinks to its own content and `justify-center` centres nothing,
    // so the three children ride at the top of the face instead of its middle.
    expect(
      PANEL_ROOT,
      "the drawing's body is `flex: 1 1 auto` — it fills the face, and only then can it centre its column",
    ).toMatch(/\bflex-1\b/);
    // gap-2.5 === 0.625rem === the drawing's 10px.
    expect(PANEL_ROOT).toMatch(/\bgap-2\.5\b/);
    expect(
      PANEL_ROOT,
      "the drawing centres the BODY (justify-content: center), not one region inside it",
    ).toMatch(/\bjustify-center\b/);
  });

  it("leaves nothing growing between the eyebrow and the control it labels", () => {
    expect(PICKER_REGION).toBeTruthy();
    expect(
      PICKER_REGION,
      "a flex-1 middle region absorbs the free space and floats the 36px picker away from its eyebrow",
    ).not.toMatch(/\bflex-1\b/);
    expect(
      PICKER_REGION,
      "a second justify-center re-centres the picker inside the grown region, stranding the eyebrow",
    ).not.toMatch(/\bjustify-center\b/);
  });

  it("keeps the region scrollable so long content never grows the fixed face", () => {
    expect(PICKER_REGION).toMatch(/\bmin-h-0\b/);
    expect(PICKER_REGION).toMatch(/\boverflow-y-auto\b/);
  });

  it("stacks eyebrow, then picker, then actions — in that order", () => {
    const eyebrow = PANEL.indexOf("Install for");
    const picker = PANEL.indexOf('data-testid="extension-install-panel-picker"');
    const actions = PANEL.indexOf("<InstallPanelCancelButton />");
    expect(eyebrow).toBeGreaterThan(-1);
    expect(picker).toBeGreaterThan(eyebrow);
    expect(actions).toBeGreaterThan(picker);
  });
});

describe('clause: "A close × in the header\'s corner does the same thing as Cancel"', () => {
  it("sits at the drawn 10px corner offset, over the header band", () => {
    // top-2.5 / right-2.5 === 0.625rem === the drawing's 10px.
    expect(CARD).toMatch(
      /<div className="absolute top-2\.5 right-2\.5">\{closeControl\}<\/div>/,
    );
  });

  it("is the drawn 24px mark on the banner's own ink at 0.85", () => {
    const close =
      SWITCHER.match(/export function InstallPanelCloseButton\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(close).toBeTruthy();
    expect(close).toMatch(/\bsize-6\b/); // 24×24
    expect(close).toMatch(/\brounded-control\b/); // the shared control radius
    expect(close).toMatch(/\btext-current\b/); // inherits the banner ground's ink
    expect(close).toMatch(/\bopacity-85\b/); // the drawing's 0.85
  });

  it("returns the card to idle exactly as Cancel does", () => {
    for (const control of ["InstallPanelCloseButton", "InstallPanelCancelButton"]) {
      const body = SWITCHER.match(
        new RegExp(`export function ${control}\\(\\)[\\s\\S]*?\\n\\}`),
      )?.[0];
      expect(body).toBeTruthy();
      expect(body).toMatch(/const \{ closePanel \} = useCardFace\(\);/);
      expect(body).toMatch(/onClick=\{closePanel\}/);
    }
  });
});

describe('clause: "A fixed block-size, so the grid never jumps"', () => {
  it("records the drawn 299px once, as a spec constant", () => {
    expect(CARD).toMatch(/const CARD_BLOCK_SIZE = "min-h-\[299px\]";/);
  });

  it("applies that one constant to BOTH faces, so the row cannot move", () => {
    const faces = CARD.match(/CARD_BLOCK_SIZE,/g) ?? [];
    expect(
      faces.length,
      "the idle face and the install face must both carry the constant",
    ).toBeGreaterThanOrEqual(2);
    const at = CARD.indexOf("export function MarketplaceListingCardInstallFace(");
    const rest = at < 0 ? "" : CARD.slice(at + 1);
    const installFace = at < 0 ? "" : rest.slice(0, rest.indexOf("\nexport "));
    expect(installFace).toContain("CARD_BLOCK_SIZE");
  });
});

describe('clause: "Errors are a toast, never inline"', () => {
  it("reports a failed install through the toast surface", () => {
    const report = PANEL.match(/const reportFailure = \(message: string\) => \{[\s\S]*?\n {2}\};/)?.[0];
    expect(report).toBeTruthy();
    expect(report).toMatch(/toast\.error\(message\)/);
  });

  it("keeps the announcement visually hidden, so the panel never grows", () => {
    const mirror = PANEL.match(/<span[\s\S]*?data-testid="extension-install-panel-error"[\s\S]*?>/)?.[0];
    expect(mirror).toBeTruthy();
    expect(mirror).toMatch(/role="alert"/);
    expect(mirror).toMatch(/className="sr-only"/);
  });

  it("routes every failure branch through it — no inline error state", () => {
    const submit = PANEL.match(/async function handleSubmit\(\)[\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(submit).toBeTruthy();
    // The three ways an install can fail, each pinned separately: a
    // non-committable audience, a server result that says `ok === false`, and
    // an unexpected throw. A bare "at least one call" count passes with two of
    // the three silently dropped.
    const uninstallable = submit.slice(0, submit.indexOf("try {"));
    expect(uninstallable, "a non-committable audience must report").toMatch(/reportFailure\(/);
    const attempt = submit.slice(submit.indexOf("try {"));
    const failedResult = attempt.slice(0, attempt.indexOf("} catch"));
    expect(failedResult, "a server result of `ok === false` must report").toMatch(
      /result\.ok === false[\s\S]*?reportFailure\(/,
    );
    const thrown = attempt.slice(attempt.indexOf("} catch"));
    expect(thrown, "an unexpected throw must report").toMatch(/reportFailure\(/);
    expect(submit.match(/reportFailure\(/g) ?? []).toHaveLength(3);
    expect(submit).not.toMatch(/setError|<Alert/);
  });
});
