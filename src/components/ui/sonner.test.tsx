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
