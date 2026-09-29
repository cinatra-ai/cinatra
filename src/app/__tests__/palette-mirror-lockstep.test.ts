/**
 * Palette-mirror lockstep (cinatra#3192, fix leg 2).
 *
 *   pnpm exec vitest run src/app/__tests__/palette-mirror-lockstep.test.ts
 *
 * `control-token-parity.test.ts` states the hazard this file finishes: every
 * chrome defect exists TWICE, once in the host token layer at
 * `src/app/globals.css` and once in the `packages/design` package that
 * ships the same layer to portable surfaces — the SDK primitives an extension
 * screen renders outside this app shell. Fix leg 2 moved the dark ramp's action
 * colour onto the one indigo the road names. A recipe in
 * `packages/sdk-ui/src/ui/button.tsx` that spells `text-accent-ink` or
 * `border-line-strong-control` draws NOTHING for a portable consumer unless the
 * design package declares those tokens and maps their utilities, so the
 * byte-identical recipe test next door is satisfied while the defect stays on
 * screen. This file pins the token contract that test cannot see.
 *
 * Two further consumers read the raw accent and had to move with it: the
 * sidebar carries its own `--sidebar-ring`, and the dashboard theme hard-codes
 * the dark accent as an RGB triple because drizzle-cube interpolates it inside
 * `rgba(var(--dc-primary-rgb), <alpha>)` and cannot take a colour token.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const HOST = path.join(ROOT, "src/app/globals.css");
const PKG_TOKENS = path.join(ROOT, "packages/design/src/tokens.css");
const PKG_THEME = path.join(ROOT, "packages/design/src/theme.css");
const DASH = path.join(ROOT, "packages/dashboards/src/components/dashboard-theme.css");

/** The near-white slate this leg took off the dark ramp's action colour. */
const SLATE = "oklch(0.929 0.013 255.508)";

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** The body of the first top-level rule whose selector is exactly `selector`. */
function scope(css: string, selector: string): string {
  const lines = css.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === `${selector} {`);
  expect(start, `${selector} block not found`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l.trimEnd() === "}");
  expect(end, `${selector} block not closed`).toBeGreaterThan(start);
  return lines.slice(start + 1, end).join("\n");
}

/** The declared value of `token` in a rule body, comments stripped. */
function decl(body: string, token: string): string | null {
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const m = new RegExp(`^\\s*${token}\\s*:\\s*([^;]+);`, "m").exec(stripped);
  return m ? m[1]!.trim() : null;
}

describe("the design package mirrors the host token layer for every token fix leg 2 moved", () => {
  const host = read(HOST);
  const pkg = read(PKG_TOKENS);

  // scope -> the tokens whose declaration must read the same in both files.
  const PINNED: Array<[string, string[]]> = [
    [":root", ["--accent", "--accent-ink", "--line-strong-control", "--ring"]],
    [".cinatra", ["--accent", "--accent-ink", "--line-strong-control", "--ring"]],
    [
      ".dark",
      [
        "--accent",
        "--accent-ink",
        "--line-strong-control",
        "--primary-foreground",
        "--sidebar-ring",
      ],
    ],
  ];

  for (const [selector, tokens] of PINNED) {
    for (const token of tokens) {
      it(`${selector} ${token} reads the same in both files`, () => {
        const inHost = decl(scope(host, selector), token);
        const inPkg = decl(scope(pkg, selector), token);
        expect(inHost, `${token} is not declared in ${selector} of the host layer`).not.toBeNull();
        expect(inPkg, `${token} is not declared in ${selector} of the design package`).not.toBeNull();
        expect(inPkg).toBe(inHost);
      });
    }
  }

  it("both theme layers map the two new tokens to utilities", () => {
    for (const file of [HOST, PKG_THEME]) {
      const css = read(file);
      expect(css, `${file} does not map --color-accent-ink`).toContain(
        "--color-accent-ink: var(--accent-ink);",
      );
      expect(css, `${file} does not map --color-line-strong-control`).toContain(
        "--color-line-strong-control: var(--line-strong-control);",
      );
    }
  });

  it("no focus-ring token on either dark ramp is still the near-white slate", () => {
    for (const file of [HOST, PKG_TOKENS]) {
      const dark = scope(read(file), ".dark");
      for (const token of ["--ring", "--sidebar-ring"]) {
        const value = decl(dark, token);
        if (value === null) continue; // inherited from :root, which is checked above
        expect(value, `${token} in ${file}`).not.toContain(SLATE);
      }
    }
  });
});

describe("the dashboard theme's hand-copied dark accent tracks the token it copies", () => {
  it("--dc-primary-rgb is the dark --accent, not the slate it replaced", () => {
    const darkAccent = decl(scope(read(HOST), ".dark"), "--accent");
    expect(darkAccent).toBe("#364e81");
    const triple = /--dc-primary-rgb:\s*([^;]+);/g;
    const values = Array.from(read(DASH).matchAll(triple)).map((m) => m[1]!.trim());
    // The light value and the dark override; the dark one is the last written.
    expect(values.length).toBeGreaterThanOrEqual(2);
    expect(values.at(-1)).toBe("54, 78, 129"); // #364E81
    expect(read(DASH)).not.toContain("226, 232, 240");
  });

  it("the filter pill's label does not draw in the FILL indigo on the dark ramp", () => {
    const css = read(DASH);
    // The base block reads raw var(--accent); the dark ramp must override it.
    expect(css).toContain("--dc-filter-text: var(--accent);");
    const darkStart = css.indexOf("html.dark");
    expect(darkStart).toBeGreaterThan(0);
    expect(css.slice(darkStart)).toContain("--dc-filter-text: var(--accent-ink);");
  });
});
