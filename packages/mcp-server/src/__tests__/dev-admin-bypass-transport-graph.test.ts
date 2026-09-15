/**
 * The MCP transport's module graph must not carry the boot-time readers.
 *
 * WHY THIS IS A TEST AND NOT A PREFERENCE. `index.tsx` is the package's own
 * entry (`.` in package.json), and a large number of unrelated call sites
 * import that bare specifier for small things, so EVERY module `index.tsx`
 * reaches is a module every one of those callers reaches too. The development
 * admin bypass needs a credential file read (`./dev-local-token`) and a Node
 * HTTP-server capture (`./local-connection`); both belong to the BOOT graph,
 * which installs them once per process. Pulling them in from `index.tsx`
 * spreads a filesystem reader and `node:http` across surfaces that never make
 * the trust decision, and the repository's route-graph budget measures exactly
 * that spread.
 *
 * The decision itself does NOT move: `./dev-admin-bypass-request` stays the
 * one composition. The transport asks for it through the port in
 * `./dev-admin-bypass` (the pure policy module it already carries), and the
 * boot hook installs the composition into that port.
 *
 * The scan follows this package's OWN edges only — relative specifiers and its
 * `@cinatra-ai/mcp-server/...` subpaths — so it is deterministic and needs no
 * workspace resolution.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(SRC_DIR, "index.tsx");
const SUBPATH_PREFIX = "@cinatra-ai/mcp-server/";
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Remove block comments and whole-line `//` comments so a specifier NAMED in
 * prose (this package documents its own module names constantly) is never
 * mistaken for an edge.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Every specifier the module actually imports: static, side-effect, dynamic. */
function extractSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const found = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    // TypeScript's import-equals form, which the three patterns above miss.
    /\bimport\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) found.add(match[1]);
  }
  return [...found];
}

/** Resolve a specifier to a file inside this package, or null when it leaves it. */
function resolveWithinPackage(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else if (specifier.startsWith(SUBPATH_PREFIX)) {
    base = path.join(SRC_DIR, specifier.slice(SUBPATH_PREFIX.length));
  } else {
    return null;
  }
  if (!base.startsWith(SRC_DIR + path.sep)) return null;
  for (const candidate of [base, ...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => path.join(base, "index" + ext))]) {
    try {
      const source = readFileSync(candidate, "utf8");
      if (typeof source === "string") return candidate;
    } catch {
      /* not this candidate */
    }
  }
  return null;
}

/** Breadth-first: every module in this package reachable from the transport entry. */
function transportGraph(): Set<string> {
  const visited = new Set<string>([ENTRY]);
  const queue = [ENTRY];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    let source: string;
    try {
      source = readFileSync(current, "utf8");
    } catch {
      continue;
    }
    for (const specifier of extractSpecifiers(source)) {
      const resolved = resolveWithinPackage(specifier, current);
      if (resolved && !visited.has(resolved)) {
        visited.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return visited;
}

function relative(file: string): string {
  return path.relative(SRC_DIR, file).split(path.sep).join("/");
}

describe("the MCP transport's module graph", () => {
  const graph = new Set([...transportGraph()].map(relative));

  it("does not reach the boot-time readers behind the development admin bypass", () => {
    const bootOnly = ["dev-admin-bypass-request.ts", "dev-local-token.ts", "local-connection.ts"];
    expect([...bootOnly].filter((module) => graph.has(module))).toEqual([]);
  });

  it("still reaches the pure policy module that carries the transport's port", () => {
    expect(graph.has("dev-admin-bypass.ts")).toBe(true);
  });

  it("reaches the entry itself, so an empty scan can never pass this suite", () => {
    expect(graph.has("index.tsx")).toBe(true);
    expect(graph.size).toBeGreaterThan(10);
  });
});
