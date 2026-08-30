/**
 * Control-token and portable-primitive parity (cinatra#3105, #3106, #3107).
 *
 *   pnpm exec vitest run src/app/__tests__/control-token-parity.test.ts
 *
 * Two hazards this batch has to answer, neither of which the per-defect suites
 * can see:
 *
 * 1. `--input` is BOTH a boundary and, through shadcn's `dark:bg-input/30`,
 *    `/50` and `/80`, a tinted control GROUND. Raising the boundary to the 3:1
 *    floor would have multiplied every one of those fills four-fold — a
 *    wholesale restyle of the dark form surface that nobody asked for. The
 *    fills therefore draw from their own `--input-fill`, pinned to the value
 *    `--input` carried before the boundary was raised, so the fills are
 *    unchanged in both themes.
 *
 * 2. The three defects each exist twice: once in the host at `src/`, once in
 *    the packages the app itself imports — the design-tokens package ships the
 *    token layer to portable surfaces, and the sdk-ui package ships the tab row
 *    and the popover and dropdown primitives that the connector setup pages and
 *    the prompt field render inside this same app shell. Fixing only the host
 *    copy leaves the reported defect on screen.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { contrastAgainst } from "@/lib/color-contrast";

const NON_TEXT_FLOOR = 3;
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

const GLOBALS = read("src/app/globals.css");
const TOKENS = read("packages/design/src/tokens.css");

/** The declaration body of a top-level block, by its selector. */
function block(css: string, selector: string): string {
  const open = css.indexOf(`\n${selector} {\n`);
  if (open === -1) throw new Error(`no \`${selector}\` block`);
  const start = open + `\n${selector} {\n`.length;
  const end = css.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`unterminated \`${selector}\` block`);
  return css.slice(start, end);
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of body.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")) {
    const m = /^\s*(--[\w-]+)\s*:\s*([^;]+);/.exec(line);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

/** Resolve a `var()` chain within a theme block, falling back to `:root`. */
function resolve(css: string, selector: string, name: string): string {
  const theme = declarations(block(css, selector));
  const root = declarations(block(css, ":root"));
  let value = theme.get(name) ?? root.get(name);
  for (let hop = 0; hop < 8; hop += 1) {
    const m = /^var\((--[\w-]+)\)$/.exec(value ?? "");
    if (!m) break;
    value = theme.get(m[1]) ?? root.get(m[1]);
  }
  if (!value) throw new Error(`${selector}: ${name} does not resolve`);
  return value;
}

describe("the control fill keeps its pre-#3107 value while the boundary rises", () => {
  for (const [label, css] of [
    ["src/app/globals.css", GLOBALS],
    ["packages/design/src/tokens.css", TOKENS],
  ] as const) {
    it(`${label}: --input-fill is the value --input carried before the fix, in every palette`, () => {
      // Light: the full navy, exactly as before. Dark: the 10% hairline the
      // fills were always tinted from.
      for (const selector of [":root", ".cinatra"]) {
        expect(declarations(block(css, selector)).get("--input-fill")).toBe("var(--line-strong)");
      }
      expect(declarations(block(css, ".dark")).get("--input-fill")).toBe("var(--line)");
    });

    it(`${label}: --input is the strengthened control token in every palette`, () => {
      for (const selector of [":root", ".cinatra", ".dark"]) {
        expect(declarations(block(css, selector)).get("--input")).toBe("var(--line-control)");
      }
    });

    it(`${label}: the dark control boundary clears the 3:1 non-text floor`, () => {
      const ink = resolve(css, ".dark", "--input");
      const ground = resolve(css, ".dark", "--background");
      expect(contrastAgainst(ink, ground)).toBeGreaterThanOrEqual(NON_TEXT_FLOOR);
    });
  }

  it("both theme layers expose the fill token as its own utility", () => {
    expect(read("src/app/globals.css")).toContain("--color-input-fill: var(--input-fill);");
    expect(read("packages/design/src/theme.css")).toContain("--color-input-fill: var(--input-fill);");
  });
});

describe("no control ground is still tinted from the boundary token", () => {
  const FILL_CALLERS = [
    "src/components/ui/input.tsx",
    "src/components/ui/textarea.tsx",
    "src/components/ui/select.tsx",
    "src/components/ui/input-group.tsx",
    "src/components/ui/checkbox.tsx",
    "src/components/ui/radio-group.tsx",
    "src/components/ui/switch.tsx",
    "src/components/ui/input-otp.tsx",
    "src/components/ui/button.tsx",
    "src/components/ui/command.tsx",
    "packages/sdk-ui/src/ui/input.tsx",
    "packages/sdk-ui/src/ui/checkbox.tsx",
    "packages/sdk-ui/src/ui/button.tsx",
  ];

  for (const file of FILL_CALLERS) {
    it(`${file} tints from --input-fill, never from the boundary token`, () => {
      const source = read(file);
      expect(source).not.toMatch(/\bbg-input\//);
      expect(source).toMatch(/\bbg-input-fill\//);
    });
  }
});

describe("the portable primitives carry the same fixes as the host's", () => {
  it("the sdk-ui tab row's trailing rule sits on the baseline (#3106)", () => {
    const source = read("packages/sdk-ui/src/ui/tabs.tsx");
    const rule = /className="divider-etched([^"]*)"/.exec(source);
    expect(rule, "no etched rule in the portable tab row").not.toBeNull();
    expect(rule![1]).not.toMatch(/\bm[bty]-\[/);
    expect(rule![1]).toContain("self-end");
  });

  for (const file of [
    "packages/sdk-ui/src/ui/popover.tsx",
    "packages/sdk-ui/src/ui/dropdown-menu.tsx",
  ]) {
    it(`${file} takes the shared header bound and keeps it overridable (#3105)`, () => {
      const source = read(file);
      expect(source).toMatch(
        /import \{ overlayCollisionPadding \} from "\.\.\/lib\/overlay-collision"/,
      );
      expect(source).toContain("collisionPadding={collisionPadding ?? overlayCollisionPadding()}");
      expect(source).toMatch(/^\s+collisionPadding,$/m);
    });
  }
});
