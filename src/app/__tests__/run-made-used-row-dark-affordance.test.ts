/**
 * The used artifact's dashed mark, in the dark palette (cinatra#3029, fix leg 2).
 *
 *   pnpm exec vitest run src/app/__tests__/run-made-used-row-dark-affordance.test.ts
 *
 * The ratified drawing marks the artifact a run USED with a dashed row box:
 * "border:1px dashed var(--line-strong); background:var(--surface)". The app
 * declares `--line-strong` for the light palette only, and the dark palette must
 * NOT re-declare it — the etched-rule conformance gate binds to that, and
 * src/app/__tests__/control-border-contrast.test.ts pins it undeclared there.
 *
 * So the first proof round measured the dashed mark at 1.20:1 in the dark
 * palette: the drawing's own mark, not perceivable. The app already has a
 * strengthened line token for exactly this — `--line-control`, which IS
 * `var(--line-strong)` in the light palette and a findable white in the dark —
 * and the row draws from that. This suite pins both halves of that: the light
 * reading is still the drawing's own value, and the dark reading clears the 3:1
 * non-text floor on the grounds the row sits on.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { contrastAgainst } from "@/lib/color-contrast";

/** The WCAG floor for a boundary that carries meaning but is not text. */
const NON_TEXT_FLOOR = 3;

const CSS = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
const SURFACE = readFileSync(
  path.join(process.cwd(), "packages/agents/src/run-made-step-surface.tsx"),
  "utf8",
);

function block(selector: string): string {
  const open = CSS.indexOf(`\n${selector} {\n`);
  if (open === -1) throw new Error(`no \`${selector}\` block in globals.css`);
  const start = open + `\n${selector} {\n`.length;
  const end = CSS.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`unterminated \`${selector}\` block`);
  return CSS.slice(start, end);
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of body.replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
    const m = stmt.match(/^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/);
    if (m) out.set(m[1], m[2].replace(/\s+/g, " "));
  }
  return out;
}

const ROOT = declarations(block(":root"));
const DARK = declarations(block(".dark"));
const THEME = declarations(block("@theme inline"));

function resolve(theme: Map<string, string>, token: string, seen = new Set<string>()): string {
  if (seen.has(token)) throw new Error(`cyclic token chain at ${token}`);
  seen.add(token);
  const raw = theme.get(token) ?? ROOT.get(token);
  if (raw === undefined) throw new Error(`undeclared token ${token}`);
  const alias = raw.match(/^var\((--[\w-]+)\)$/);
  return alias ? resolve(theme, alias[1], seen) : raw;
}

describe("the used row's dashed mark draws from a token both palettes declare", () => {
  it("is the drawing's own `--line-strong` value in the light palette", () => {
    expect(resolve(ROOT, "--line-control")).toBe(resolve(ROOT, "--line-strong"));
    expect(resolve(ROOT, "--line-control")).toBe("#15213a");
  });

  it("clears the non-text floor on the row's grounds in the dark palette", () => {
    const ink = resolve(DARK, "--line-control");
    for (const ground of ["--surface", "--surface-strong", "--background"]) {
      const ratio = contrastAgainst(ink, resolve(DARK, ground));
      expect(
        ratio,
        `dark: --line-control resolves to ${ink}; over ${ground} that is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(NON_TEXT_FLOOR);
    }
  });

  it("exposes the token to the utility layer, so the row can name it", () => {
    expect(THEME.get("--color-line-control")).toBe("var(--line-control)");
  });

/** The row classes the step actually renders with — the string literals, not
 *  the prose around them, so a comment naming a class cannot pass for one. */
function rowClass(name: string): string {
  const m = new RegExp(`const ${name} =\\s*"([^"]*)"`).exec(SURFACE);
  if (!m) throw new Error(`no ${name} string in run-made-step-surface.tsx`);
  return m[1];
}

  it("is the token the run-made step's used row actually draws", () => {
    expect(rowClass("USED_ROW_CLASS")).toContain("border-dashed border-line-control");
    expect(rowClass("USED_ROW_CLASS")).not.toContain("border-line-strong");
    expect(rowClass("ROW_CLASS")).not.toContain("border-line-strong");
  });

  it("states the drawing's 8px radius literally, never the 10px scale step", () => {
    for (const name of ["ROW_CLASS", "USED_ROW_CLASS"]) {
      expect(rowClass(name)).toContain("rounded-[8px]");
      expect(rowClass(name)).not.toContain("rounded-lg");
    }
  });
});
