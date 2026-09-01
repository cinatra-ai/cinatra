import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// ROUTE-GRAPH PRESSURE ON THE RAIL'S SHARED ROW (cinatra#3029, epic #3023 W5).
//
// WHAT WENT WRONG. The conformance-fix leg made the run's own record a step that
// opens, so the shared non-step row (`run-step-rail-extra-entry.tsx`) had to read
// the frame's selection. It reached for `useRunStepSelection` in
// `run-surface-rail.tsx` — the module that also carries the whole two-column
// FRAME and every row component in it. That row module is reachable from four
// LOCKED routes (`/api/mcp`, `/api/a2a`, `/api/llm-bridge`, `/chat`), so one
// import for a two-line hook pulled the frame and its step module onto all four
// graphs: +2 reachable first-party modules per route, measured, and the
// route-graph ratchet said so.
//
// THE PROPERTY. The selection a row consumes lives in its OWN module, and the
// shared row imports it from there — never from the frame module. This is the
// same split the labels (`run-surface-rail-labels.ts`) and the step predicate
// (`run-surface-rail-step.ts`) already took, for the same reason: a consumer
// that needs one small thing must not drag the frame in behind it.
//
// This is a STATIC import check, deliberately. The cost this guards is paid at
// module-graph time, not at render time, so no rendered assertion can see it —
// only the import statements can.
// ---------------------------------------------------------------------------

const SRC = path.join(__dirname, "..");

/** Strip comments (string-aware) exactly as the route-graph reporter does, so a
 *  specifier written inside prose can never be counted as an edge. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** EVERY module specifier that costs a module-graph edge — the same four forms
 *  scripts/route-graph.mjs counts: `import`/`export ... from`, side-effect
 *  `import "x"`, dynamic `import("x")` and `require("x")`. Statement-level
 *  `import type` / `export type` crosses no graph and is excluded, exactly as
 *  the reporter excludes it. A guard that saw only the first form could pass
 *  while a side-effect import, a re-export or a dynamic import put the frame
 *  straight back onto the locked routes. */
export function graphEdgeSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  const fromRe = /\b(?:import|export)\s+(type\s+)?([^'"`;]*?)\bfrom\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code)) !== null) {
    if (m[1]) continue;
    out.push(m[3]);
  }
  for (const re of [
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    let n: RegExpExecArray | null;
    while ((n = re.exec(code)) !== null) out.push(n[1]);
  }
  return out;
}

function moduleEdges(moduleRel: string): string[] {
  return graphEdgeSpecifiers(readFileSync(path.join(SRC, moduleRel), "utf8"));
}

function moduleSource(moduleRel: string): string {
  return readFileSync(path.join(SRC, moduleRel), "utf8");
}

describe("the edge extractor sees every form the route graph counts", () => {
  it("counts from-imports, re-exports, side-effect, dynamic and require edges, and no type-only ones", () => {
    const fixture = [
      'import { a } from "./a";',
      'import type { T } from "./type-only";',
      'export type { U } from "./type-only-export";',
      'export { b } from "./b";',
      'import "./side-effect";',
      'const c = await import("./dynamic");',
      'const d = require("./required");',
      '// a comment naming "./commented" must not count',
    ].join("\n");
    const edges = graphEdgeSpecifiers(fixture);
    expect(edges.sort()).toEqual(
      ["./a", "./b", "./dynamic", "./required", "./side-effect"].sort(),
    );
  });
});

describe("the shared rail row does not drag the run-surface frame onto the locked routes", () => {
  it("reads the selection from the selection module, not from the frame module", () => {
    const edges = moduleEdges("run-step-rail-extra-entry.tsx");
    expect(edges).toContain("./run-surface-rail-selection");
    expect(edges).not.toContain("./run-surface-rail");
  });

  it("keeps the selection module free of the frame, so importing it costs one module", () => {
    const edges = moduleEdges("run-surface-rail-selection.tsx");
    // Only React. The step vocabulary is taken as a TYPE, which crosses no
    // graph; anything else here would put the cost straight back.
    expect(edges).not.toContain("./run-surface-rail");
    expect(edges.filter((s) => s.startsWith("."))).toEqual([]);
  });

  it("leaves the frame module itself as the selection's one provider", () => {
    const frame = moduleSource("run-surface-rail.tsx");
    expect(graphEdgeSpecifiers(frame)).toContain("./run-surface-rail-selection");
    // The frame does not re-declare the context, and it is the module that
    // MOUNTS it: the provider element lives here and nowhere else.
    expect(frame).not.toMatch(/createContext\s*</);
    expect(frame).toContain("<RunStepSelectionContext.Provider");
    const selection = moduleSource("run-surface-rail-selection.tsx");
    expect(selection).toMatch(/createContext\s*</);
    expect(selection).not.toContain("RunStepSelectionContext.Provider");
  });
});
