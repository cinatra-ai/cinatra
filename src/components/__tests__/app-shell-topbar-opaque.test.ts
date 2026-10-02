/**
 * THE TOP BAR IS CHROME, NOT CONTENT (cinatra#3142 §3, acceptance 7).
 *
 *   pnpm exec vitest run src/components/__tests__/app-shell-topbar-opaque.test.ts
 *
 * On every scrolled frame the page's own agent-name line was drawn ghosted
 * inside the sticky header band, overlapping the breadcrumb row that lives
 * there. The stacking was never the problem — the band sits above the page
 * content, so the text is BEHIND it, showing through. It is the alpha: the band
 * was drawn `bg-background/90`, ninety per cent, so ten per cent of whatever
 * scrolls beneath it is composited into the band by construction, and
 * `backdrop-blur-xl` blurred that remainder rather than removing it.
 *
 * The drawing: "The top-bar is chrome, not content", and the palette gives
 * chrome its own opaque grounds rather than a see-through band.
 *
 * This suite pins the two halves a static read can prove: the band's ground
 * utility carries no alpha and no backdrop filter, and the token it draws from
 * parses to alpha 1 in every palette (a normalized computed value, not a source
 * string). The pixel half — that a known content string is not composited into
 * the band once it scrolls under it — is measured on the real boot by
 * tests/e2e/design/conformance/header-band-opacity.spec.ts, which samples the
 * band rather than reading a class list.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseCssColor } from "@/lib/color-contrast";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

const SHELL = read("src/components/app-shell.tsx");
const GLOBALS = read("src/app/globals.css");

/** The class string the shell's sticky header band is drawn with. */
function headerClasses(): string {
  const at = SHELL.indexOf('data-testid="app-shell-topbar"');
  expect(at, "the shell must still mark its sticky header band").toBeGreaterThan(-1);
  const window = SHELL.slice(at, at + 2400);
  const m = /"(sticky[^"]*)"/.exec(window);
  expect(m, "the sticky header band must still carry a literal class string").not.toBeNull();
  return m![1];
}

/** The declaration body of a top-level block, by its selector. */
function block(css: string, selector: string): string {
  const open = css.indexOf(`\n${selector} {\n`);
  if (open === -1) throw new Error(`no \`${selector}\` block`);
  const start = open + `\n${selector} {\n`.length;
  const end = css.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`unterminated \`${selector}\` block`);
  return css.slice(start, end);
}

function declaration(css: string, selector: string, token: string): string {
  const body = block(css, selector).replace(/\/\*[\s\S]*?\*\//g, "");
  const m = new RegExp(`(^|\\n)\\s*${token}\\s*:\\s*([^;]+);`).exec(body);
  if (!m) throw new Error(`${selector}: ${token} is not declared`);
  return m[2].trim();
}

describe("the shell's sticky header band is an opaque ground", () => {
  it("draws its ground with no alpha modifier", () => {
    const classes = headerClasses();
    expect(
      /\bbg-background\/\d/.test(classes),
      `the band is drawn ${classes} — an alpha ground composites the scrolled ` +
        "page into the chrome by construction",
    ).toBe(false);
    expect(/\bbg-[\w-]+\/\d/.test(classes), `the band is drawn ${classes}`).toBe(false);
    expect(classes).toMatch(/\bbg-background\b/);
  });

  it("carries no backdrop filter, which only blurred the remainder it let through", () => {
    expect(
      /\bbackdrop-blur(-[\w[\]]+)?\b/.test(headerClasses()),
      "a backdrop filter over an opaque ground draws nothing and costs a layer; " +
        "over a translucent one it is the frosted bleed itself",
    ).toBe(false);
  });

  it("keeps the stacking the band already had — this is about alpha, not order", () => {
    expect(headerClasses()).toContain("z-[140]");
    expect(headerClasses()).toContain("sticky");
  });

  for (const palette of [":root", ".cinatra", ".dark"]) {
    it(`the ground token the band draws from is fully opaque in the ${palette} palette`, () => {
      const raw = declaration(GLOBALS, palette, "--background");
      const parsed = parseCssColor(raw);
      expect(parsed, `${palette}: --background (${raw}) must parse`).not.toBeNull();
      expect(
        parsed!.a,
        `${palette}: --background resolves to ${raw}, alpha ${parsed!.a} — the chrome ` +
          "ground must be alpha 1",
      ).toBe(1);
    });
  }
});
