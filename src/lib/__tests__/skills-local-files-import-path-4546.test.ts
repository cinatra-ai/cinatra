import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

// cinatra#4546 — `src/lib/mcp-instructions.ts` and `src/lib/openai-builder.ts`
// call the local SKILL.md reader at module load. The `@cinatra-ai/skills`
// package index re-exports `./skills-registry` (and other modules) before
// `./local-skill-files`, and the registry's import chain leads back to
// `src/lib/mcp-instructions.ts`. When the index is entered first, the reader
// export is still undefined when the module-level call runs, and the webpack
// dev server fails in the instrumentation hook.
//
// This static test pins the cycle-free road: both modules import the reader
// from the leaf subpath `@cinatra-ai/skills/local-skill-files`, the package
// `exports` map serves that subpath from `./src/local-skill-files.ts`, and the
// leaf itself imports only `server-only` and `node:*` modules, so it cannot
// join a cycle.

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const LEAF_SPECIFIER = "@cinatra-ai/skills/local-skill-files";
const BARREL_SPECIFIER = "@cinatra-ai/skills";

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

// Every static import / re-export specifier of a module source: `... from "x"`
// and the side-effect form `import "x"`.
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const fromRe = /\bfrom\s+["']([^"']+)["']/g;
  const bareRe = /^\s*import\s+["']([^"']+)["']/gm;
  for (const m of source.matchAll(fromRe)) specs.push(m[1]);
  for (const m of source.matchAll(bareRe)) specs.push(m[1]);
  return specs;
}

describe("cinatra#4546: local skill files are imported without the package index", () => {
  for (const rel of ["src/lib/mcp-instructions.ts", "src/lib/openai-builder.ts"]) {
    it(`${rel} imports the reader from the leaf subpath, not the package index`, () => {
      const specs = importSpecifiers(read(rel));
      expect(specs).not.toContain(BARREL_SPECIFIER);
      expect(specs).toContain(LEAF_SPECIFIER);
    });
  }

  it("packages/skills/package.json exports the leaf subpath from src/local-skill-files.ts", () => {
    const pkg = JSON.parse(read("packages/skills/package.json")) as {
      exports?: Record<string, string>;
    };
    expect(pkg.exports?.["./local-skill-files"]).toBe("./src/local-skill-files.ts");
  });

  it("packages/skills/src/local-skill-files.ts imports only server-only and node:* modules", () => {
    const specs = importSpecifiers(read("packages/skills/src/local-skill-files.ts"));
    expect(specs.length).toBeGreaterThan(0);
    const foreign = specs.filter((s) => s !== "server-only" && !s.startsWith("node:"));
    expect(foreign).toEqual([]);
  });
});
