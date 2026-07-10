/**
 * Transitive import-PURITY guard for the sidebar Approvals badge graph
 * (cinatra#1283).
 *
 * The root layout (on EVERY route's build module graph) resolves the badge off
 * `sources/nav-registry`. If ANYTHING reachable from that module imports the
 * heavy decide/render surface — `@cinatra-ai/agents/mcp-handlers` (the agents
 * runtime, via `../decision-helpers`) or a `*decision-actions` React client
 * component — webpack compiles that whole subtree into every route again and
 * `next build` OOMs (the exact regression this issue fixes: 1372 vs 141 root-
 * layout modules, +~380MB peak RSS). A green unit/e2e suite does NOT catch this;
 * only a static walk of the module graph does.
 *
 * This test STATICALLY walks the nav-registry graph (following relative + `@/`
 * alias imports, stopping at package boundaries but recording the specifier) and
 * fails if any forbidden specifier is reachable. It is a build-shape invariant,
 * not a behavioral one — it must run in plain node (no bundler).
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// .../src
const srcRoot = here.slice(0, here.indexOf(`${sep}src${sep}`) + `${sep}src`.length);
const NAV_REGISTRY = resolve(here, "..", "nav-registry.ts");

// The heavy specifiers that must NOT be reachable from the layout badge graph.
// `decision-helpers` (→ `@cinatra-ai/agents/mcp-handlers`) and any
// `*decision-actions` React client component are the +380MB OOM cause.
const FORBIDDEN = /@cinatra-ai\/agents\/mcp-handlers|decision-helpers|decision-actions/;

// Match `import x from "S"`, `export … from "S"`, bare `import "S"`, and dynamic
// `import("S")`.
const SPECIFIER_RE = /(?:import|export)\s*(?:[\s\S]*?\sfrom\s*|\s*\(\s*)?["']([^"']+)["']/g;

function resolveToFile(base: string): string | null {
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".jsx"].map((e) => base + e),
    ...[".ts", ".tsx", ".js", ".jsx"].map((e) => join(base, `index${e}`)),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

function specifiersOf(source: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  SPECIFIER_RE.lastIndex = 0;
  while ((m = SPECIFIER_RE.exec(source)) !== null) out.push(m[1]);
  return out;
}

/** Walk the graph; return every reachable file plus every import specifier seen. */
function walk(entry: string): { files: Set<string>; specifiers: Set<string> } {
  const files = new Set<string>();
  const specifiers = new Set<string>();
  const stack = [entry];

  while (stack.length > 0) {
    const file = stack.pop()!;
    if (files.has(file)) continue;
    files.add(file);

    const source = readFileSync(file, "utf8");
    for (const spec of specifiersOf(source)) {
      specifiers.add(spec);
      let base: string | null = null;
      if (spec.startsWith("@/")) {
        base = join(srcRoot, spec.slice(2));
      } else if (spec.startsWith(".")) {
        base = resolve(dirname(file), spec);
      } else {
        // Bare specifier — a package boundary. Recorded (for the forbidden
        // check) but NOT followed into node_modules.
        continue;
      }
      const resolved = resolveToFile(base);
      if (resolved && !files.has(resolved)) stack.push(resolved);
    }
  }

  return { files, specifiers };
}

describe("nav-registry import purity", () => {
  const { files, specifiers } = walk(NAV_REGISTRY);

  it("actually walked the graph (scanner sanity)", () => {
    // Proves the walker reached the contracts + shared plumbing rather than
    // false-greening on an empty graph.
    const joined = [...files].join("\n");
    expect(joined).toMatch(/marketplace-shared\.ts$/m);
    expect(joined).toMatch(/agent-creation-requests\.contract\.ts$/m);
    // Reached the workflow contract's package-boundary store import — proves the
    // walker followed the contract graph out to its bare specifiers.
    expect([...specifiers].some((s) => s.startsWith("@cinatra-ai/workflows"))).toBe(true);
  });

  it("never reaches the agents runtime, decision-helpers, or decision-actions", () => {
    const leakedFiles = [...files].filter((f) => FORBIDDEN.test(f));
    const leakedSpecifiers = [...specifiers].filter((s) => FORBIDDEN.test(s));
    expect(
      { leakedFiles, leakedSpecifiers },
      "the sidebar badge graph must stay off the heavy decide/render surface",
    ).toEqual({ leakedFiles: [], leakedSpecifiers: [] });
  });
});
