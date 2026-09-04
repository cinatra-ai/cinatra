import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// ROUTE-GRAPH PRESSURE ON THE REVIEW TARGET'S CONTENT CHANNEL (cinatra#3029,
// epic #3023 W5; the seam taken in for #3150).
//
// WHAT WENT WRONG. Wiring the versioned content channel into the review
// target's props builder put the call in `review-target-prepare.ts` — the
// artifact-side binder that four LOCKED routes (`/api/mcp`, `/chat`,
// `/api/a2a`, `/api/llm-bridge`) already reach statically, through the review
// surface's own server action. One value import for one call therefore pulled
// the channel, its contract package module and the digest module behind it onto
// all four graphs: +3 reachable first-party modules per route, MEASURED by the
// route-graph analyzer, and the ratchet said so.
//
// LAZINESS DOES NOT HELP, and this is measured too, not assumed: the analyzer
// counts a dynamic `import("x")` exactly like a static one, so moving the call
// behind `await import(...)` leaves the same +3.
//
// THE PROPERTY. The content road lives in its OWN module next to the surfaces
// that draw it, and the binder takes it as a PORT — the same discipline the
// binder's own header already states for the run/gate ports, which are supplied
// by the caller "so this artifact-side binder stays free of any agents-package
// coupling and grows no locked route graph". The four locked routes reach the
// binder and never execute a preparation; the two review surfaces execute one
// and supply the port. So the cost is paid where the content is drawn, and
// nowhere else.
//
// AND NO SURFACE MAY SILENTLY DRAW THE FLOOR. A port that is simply forgotten
// would put back the exact defect #3150 names — a readable document drawn as
// "no content" — so both drawing surfaces are pinned here as well.
//
// This is a STATIC import check, deliberately. The cost this guards is paid at
// module-graph time, not at render time, so no rendered assertion can see it —
// only the import statements can.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..", "..");

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
 *  the analyzer excludes it. A guard that saw only the first form could pass
 *  while a re-export or a dynamic import put the channel straight back onto the
 *  locked routes. */
function graphEdgeSpecifiers(source: string): string[] {
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

function moduleEdges(repoRel: string): string[] {
  return graphEdgeSpecifiers(readFileSync(path.join(REPO_ROOT, repoRel), "utf8"));
}

const BINDER = "src/app/artifacts/[id]/review-target-prepare.ts";
const CONTENT = "src/app/artifacts/[id]/review-target-content.ts";
const REVIEW_PAGE =
  "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx";
const ISLAND_PAGE = "src/app/lifecycle/review-island/page.tsx";

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
    expect(graphEdgeSpecifiers(fixture).sort()).toEqual(
      ["./a", "./b", "./dynamic", "./required", "./side-effect"].sort(),
    );
  });
});

describe("the review binder does not drag the content channel onto the locked routes", () => {
  it("keeps the channel, its contract and the blob store off the binder", () => {
    const edges = moduleEdges(BINDER);
    expect(edges).not.toContain("@/lib/artifacts/artifact-content-channel");
    expect(edges).not.toContain("@/lib/artifacts/local-disk-blob-store");
    expect(edges).not.toContain("@cinatra-ai/sdk-extensions/artifact-content-channel");
    expect(edges).not.toContain("@/lib/artifacts/object-backed-contract");
    // Not through the content module either: taking it as a port is the whole
    // point, and an import of the port's implementation costs the same three.
    expect(edges).not.toContain("./review-target-content");
  });

  it("keeps the content road in its own module, where the cost is paid once", () => {
    const edges = moduleEdges(CONTENT);
    expect(edges).toContain("@/lib/artifacts/artifact-content-channel");
    expect(edges).toContain("@/lib/artifacts/local-disk-blob-store");
  });
});

describe("every surface that draws a review target supplies the content port", () => {
  it("the review page reaches the content module", () => {
    expect(moduleEdges(REVIEW_PAGE)).toContain("@/app/artifacts/[id]/review-target-content");
  });

  it("the review island page reaches the content module", () => {
    expect(moduleEdges(ISLAND_PAGE)).toContain("@/app/artifacts/[id]/review-target-content");
  });

  // An import alone would satisfy the two readings above while the surface
  // quietly drew the channel's named absence, so each surface must also be seen
  // HANDING the road to the loader.
  for (const [name, repoRel] of [
    ["the review page", REVIEW_PAGE],
    ["the review island page", ISLAND_PAGE],
  ] as const) {
    it(`${name} hands the road to loadReviewGateSurface`, () => {
      const source = readFileSync(path.join(REPO_ROOT, repoRel), "utf8");
      const call = /loadReviewGateSurface\(\{[\s\S]*?\n\s*\}\)/.exec(source);
      expect(call).not.toBeNull();
      expect(call?.[0]).toMatch(/buildContent:\s*buildReviewTargetContentProjection/);
    });
  }
});
