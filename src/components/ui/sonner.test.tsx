import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Regression test for the "Toasts must not be transparent" behavior.
//
// Root cause:
//   The shadcn Sonner wrapper passed `theme="cinatra"` (or `"dark"`) straight
//   through to Sonner, which only accepts `"light" | "dark" | "system"`.
//   Sonner then set `data-sonner-theme="cinatra"`, so neither of its built-in
//   `[data-sonner-theme="light"]` / `[data-sonner-theme="dark"]` rules
//   matched and none of the type-bg CSS variables (`--info-bg`,
//   `--normal-bg`, ...) were defined by Sonner's bundled CSS. The wrapper
//   set `--normal-bg` / `--success-bg` / `--warning-bg` / `--error-bg`
//   inline, but **omitted `--info-bg`**, so any `toast.info(...)` toast
//   resolved `background: var(--info-bg)` to its CSS initial value
//   (transparent) and the page chrome bled through the toast surface.
//
// This test guards three contract points the wrapper must keep satisfied:
//   1. Every rich-colors toast type defined in Sonner's bundled CSS
//      (normal, info, success, warning, error) gets a `--<type>-bg`
//      override from the wrapper.
//   2. Each `--<type>-bg` resolves to an opaque project token
//      (`var(--popover)` per project styling rules — no raw colors).
//   3. The Sonner `theme` prop is mapped from the project theme name
//      (`"cinatra"`, `"dark"`, ...) onto a value Sonner understands
//      (`"light" | "dark" | "system"`), so Sonner's own theme-scoped
//      variable rules apply as a defense-in-depth fallback.

describe("Sonner Toaster wrapper — opacity contract", () => {
  const src = readFileSync(
    path.join(__dirname, "sonner.tsx"),
    "utf8",
  );

  it("sets --normal-bg to var(--popover)", () => {
    expect(src).toMatch(/'--normal-bg':\s*'var\(--popover\)'/);
  });

  it("sets --info-bg to var(--popover) — fixes the transparent-info-toast bug", () => {
    expect(src).toMatch(/'--info-bg':\s*'var\(--popover\)'/);
  });

  it("sets --success-bg to var(--popover)", () => {
    expect(src).toMatch(/'--success-bg':\s*'var\(--popover\)'/);
  });

  it("sets --warning-bg to var(--popover)", () => {
    expect(src).toMatch(/'--warning-bg':\s*'var\(--popover\)'/);
  });

  it("sets --error-bg to var(--popover)", () => {
    expect(src).toMatch(/'--error-bg':\s*'var\(--popover\)'/);
  });

  it("does not pass raw color tokens (bg-white, #fff, hsl(...)) for toast surfaces — semantic tokens only", () => {
    // Project styling rule: never raw colors for surfaces.
    // The wrapper must drive backgrounds via the popover token.
    const surfaceLines = src
      .split("\n")
      .filter((line) => /-bg':/.test(line) && !/info-text|warning-text|error-text|success-text/.test(line));
    for (const line of surfaceLines) {
      expect(line).toMatch(/var\(--popover\)/);
      expect(line).not.toMatch(/#fff|#FFF|bg-white|hsl\(/);
    }
  });

  it("normalizes the project theme name onto Sonner's accepted theme set ('light' | 'dark' | 'system')", () => {
    // Sonner's ToasterProps.theme is exactly 'light' | 'dark' | 'system'.
    // The project's next-themes ThemeProvider uses 'cinatra' and 'dark'.
    // The wrapper must map 'cinatra' (and any unknown value) to a Sonner-
    // understood theme, otherwise data-sonner-theme="cinatra" leaves
    // Sonner's built-in --info-bg / --normal-bg variables undefined.
    // Accept any branching on the resolved theme that yields one of the
    // three allowed values.
    expect(src).toMatch(/['"]light['"]/);
    expect(src).toMatch(/['"]dark['"]/);
    // The cast `as ToasterProps['theme']` is no longer sufficient on its own.
    // Require an explicit normalization step — either a ternary, a switch,
    // or a helper — before the value reaches the <Sonner theme={...}> prop.
    // We assert the wrapper does NOT pass the raw next-themes value through.
    expect(src).not.toMatch(/theme=\{theme as ToasterProps\['theme'\]\}/);
  });
});

/**
 * COPY AND CLOSE SIT TOGETHER ON THE RIGHT, INSIDE THE TOAST.
 *
 * The ratified drawing describes a toast as "the popover surface, a
 * status-coloured border and matching text, the type's icon leading, Copy and
 * Close on the right" — one row, both controls in it.
 *
 * AN EARLIER READING OF THIS FILE CLAIMED THAT PLACEMENT AND DID NOT SHIP IT.
 * It moved three of the toast library's own custom properties, which only
 * choose WHICH CORNER the library's corner badge is pinned outside of: the
 * close control went from outside the top-LEFT corner to outside the top-RIGHT
 * one. It was still a circular badge hanging off the toast's border rather than
 * a control beside Copy, and on a real surface it measured overlapping the
 * application header's own notification badge. The corner is not the placement
 * the drawing asks for, and this suite now says so in the terms that can be
 * checked: the control is IN the row, not pinned outside a corner.
 *
 * THE GEOMETRY IS A RULE, NOT A VARIABLE, so it lives in the application's own
 * stylesheet: the library pins the badge with `position: absolute` and a
 * transform, and no custom property it exposes can undo either. The rule
 * out-specifies the library's own (four attribute selectors against three), so
 * it does not depend on which stylesheet the browser sees first. It takes the
 * GEOMETRY only and leaves every colour to the library's status rules, which is
 * what keeps the close control's border and text status-coloured with the rest
 * of the toast.
 */
describe("the toast's Close sits beside Copy, in the toast's own row", () => {
  const src = readFileSync(path.join(__dirname, "sonner.tsx"), "utf8");
  const css = readFileSync(
    path.join(__dirname, "..", "..", "app", "globals.css"),
    "utf8",
  );
  const SELECTOR =
    '[data-sonner-toaster] [data-sonner-toast][data-styled="true"] [data-close-button]';
  const rule = () => {
    const at = css.indexOf(SELECTOR + " {");
    expect(at, "no close-control placement rule in the application stylesheet").toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("\n}", at));
  };

  it("takes the control OUT of the corner — it is in the toast's flow, not pinned to it", () => {
    expect(rule()).toMatch(/position:\s*static/);
    expect(rule()).toMatch(/transform:\s*none/);
  });

  it("puts it AFTER the Copy action in the row, so the two read as a pair", () => {
    // The toast is a flex row and Copy carries the auto margin that pushes the
    // pair to the right; ordering Close after it is what puts Close outermost.
    expect(rule()).toMatch(/order:\s*[1-9]/);
  });

  it("gives it the shape of a control rather than of a badge", () => {
    // A 50% radius is a badge. A control in a row is not round.
    const radius = rule().match(/border-radius:\s*([^;]+);/)?.[1]?.trim();
    expect(radius, "no border-radius — the library's 50% badge radius would stand").toBeTruthy();
    expect(radius).not.toMatch(/50%|9999px/);
  });

  it("out-specifies the library's own rule — both are unlayered", () => {
    // The library writes [data-sonner-toast][data-styled='true'] [data-close-button]:
    // three attribute selectors. This rule carries four, so source order between
    // the two stylesheets cannot decide it.
    expect((SELECTOR.match(/\[[^\]]+\]/g) ?? []).length).toBeGreaterThan(3);
    expect(css).toContain(SELECTOR);
  });

  it("leaves every COLOUR to the library's status rules", () => {
    // The drawing asks for "a status-coloured border and matching text"; the
    // close control is part of that reading, so this rule must not paint it.
    expect(rule()).not.toMatch(/(^|;)\s*(background|color|border-color)\s*:/);
  });

  it("no longer pins the control outside a corner", () => {
    for (const property of [
      "--toast-close-button-start",
      "--toast-close-button-end",
      "--toast-close-button-transform",
    ]) {
      expect(src, `${property} still chooses a corner for a badge`).not.toContain(property);
    }
  });

  it("states, where the chrome is wired, where the control is drawn", () => {
    // A reader who changes the wrapper must find the placement note beside it,
    // not in a review thread.
    expect(src).toMatch(/close/i);
    expect(src).toMatch(/globals\.css/);
  });

  it("is direction-neutral — nothing here reads as physical left or right", () => {
    // The corner properties this replaces were read by the library as PHYSICAL
    // left and right, which is why they carried a right-to-left caveat. Flow
    // order and a logical margin carry none: the pair follows the reading
    // direction on its own.
    expect(rule()).not.toMatch(/(^|;)\s*(left|right)\s*:/);
    const layout = readFileSync(
      path.join(__dirname, "..", "..", "app", "layout.tsx"),
      "utf8",
    );
    expect(layout).toMatch(/<html\s+lang="en"/);
  });
});
