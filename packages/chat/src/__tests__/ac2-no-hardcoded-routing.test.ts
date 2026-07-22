// AC#2 GREP-ASSERTION (cinatra#1875 W2, Epic #1873).
//
// The ruling retired the hardcoded `chatgpt`/`gemini` routing and forbids a
// `@chatgpt` token on any surface. This test is the structural gate: NO literal
// `chatgpt`/`gemini` ROUTING COMPARISON survives in the two routing decision
// files (`actions.ts`, `mcp/handlers.ts`). Routing is DECLARATION-DRIVEN — a
// handle-literal comparison is the exact anti-pattern being retired.
//
// Scope (per the W2 plan-of-record): comments and render-mode strings are NOT
// routing comparisons, so line/block comments are stripped before the assertion.
// String/identifier occurrences of `chatgpt`/`gemini` in CODE (a Set literal, an
// endpoint map, an `=== "chatgpt"`, a `.has("gemini")`) are the failure the gate
// catches.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

/** Strip `//` line comments and `/* *\/` block comments so only CODE remains. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (leave `://` in URLs alone)
}

const ROUTING_FILES = [
  "actions.ts",
  join("mcp", "handlers.ts"),
];

describe("AC#2 — no hardcoded chatgpt/gemini routing comparison survives", () => {
  for (const rel of ROUTING_FILES) {
    it(`${rel} carries no literal chatgpt/gemini in code (comments excluded)`, () => {
      const source = readFileSync(join(SRC, rel), "utf8");
      const code = stripComments(source);
      const offenders = code
        .split("\n")
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => /chatgpt|gemini/i.test(line));
      expect(
        offenders,
        `Expected no hardcoded chatgpt/gemini routing literal in ${rel}; found:\n` +
          offenders.map((o) => `  L${o.n}: ${o.line}`).join("\n"),
      ).toEqual([]);
    });
  }

  it("the retired BUILT_IN routing tables are gone from actions.ts", () => {
    const source = readFileSync(join(SRC, "actions.ts"), "utf8");
    expect(source).not.toMatch(/BUILT_IN_HANDLES/);
    expect(source).not.toMatch(/BUILT_IN_ENDPOINTS/);
  });
});
