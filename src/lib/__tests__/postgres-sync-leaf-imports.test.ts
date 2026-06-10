// Sync-leaf import-graph gate (cinatra#104).
//
// Under Turbopack dev, a module whose static import graph reaches an
// `import()`-loaded external (`pg`, `@modelcontextprotocol/sdk`, ...) is
// compiled as an ASYNC module. Turbopack's asyncModule() runtime permanently
// replaces `module.exports` with a getter returning the module's Promise, so
// a CommonJS `require()` of such a module yields a Promise and every named
// export reads as `undefined`. That is exactly how POST /api/chat/save 500'd:
// artifact-refs-store `require("@/lib/database")` -> Promise ->
// `postgresSchema` undefined -> TypeError.
//
// The fix keeps a set of modules SYNC FOREVER: they are composed via
// synchronous `require()` (database.ts -> artifact-refs-store) or run inside
// synchronous Atomics-bridged transactions, so they must never (transitively,
// statically, or via runtime require()) touch an async-root import.
//
// This test walks the real source files and fails when anyone re-introduces
// such an edge.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");

// Modules that must stay synchronous under Turbopack.
const SYNC_REQUIRED_ENTRYPOINTS = [
  "src/lib/artifacts/artifact-refs-store.ts",
  "src/lib/postgres-config.ts",
  "src/lib/postgres-schema-init.ts",
  "src/lib/drizzle-store.ts",
];

// Known async roots (Turbopack loads these via dynamic `import()`), plus the
// async project modules that must never be reached from the sync set.
const BANNED_EXTERNALS = [
  /^pg$/,
  /^pg\//,
  /^drizzle-orm\/node-postgres$/,
  /^@modelcontextprotocol\//,
  /^@openai\/agents/,
];
const BANNED_PROJECT_FILES = [
  /^src\/lib\/database\.ts$/,
  /mcp-server/,
  /^src\/lib\/objects-store\.ts$/,
  /^src\/lib\/objects-dual-write\.ts$/,
];

// postgres-sync.ts embeds `require("pg")` inside its worker-thread SOURCE
// STRING (evaluated with `new Worker(source, { eval: true })`). That require
// runs in a plain Node worker, completely outside the bundler module graph,
// so it is exempt from the edge scan. Keep the exemption file-scoped and
// explicit.
const RAW_REQUIRE_EXEMPT_FILES = new Set(["src/lib/postgres-sync.ts"]);

type Edge = { from: string; specifier: string };

function readSource(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), "utf8");
}

// Comment-stripping keeps doc references like `require("@/lib/database")`
// (this very bug's write-up!) from registering as graph edges. `//` is only
// treated as a comment opener at line start or after whitespace so protocol
// strings ("https://...") survive.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

// Static import / export-from / require() specifiers. `import type` /
// `export type` edges are erased at compile time and excluded.
function collectSpecifiers(relPath: string, source: string): string[] {
  const specifiers: string[] = [];
  const importExportRe =
    /^\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm;
  const sideEffectImportRe = /^\s*import\s+["']([^"']+)["']/gm;
  const requireRe = /require\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of source.matchAll(importExportRe)) {
    if (match[2]) continue; // type-only — no runtime edge
    specifiers.push(match[3]);
  }
  for (const match of source.matchAll(sideEffectImportRe)) {
    specifiers.push(match[1]);
  }
  if (!RAW_REQUIRE_EXEMPT_FILES.has(relPath)) {
    for (const match of source.matchAll(requireRe)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function resolveProjectSpecifier(
  fromRelPath: string,
  specifier: string,
): string | null {
  let base: string | null = null;
  if (specifier.startsWith("@/")) {
    base = path.join("src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.normalize(
      path.join(path.dirname(fromRelPath), specifier),
    );
  }
  if (!base) return null; // bare specifier (external package)
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    try {
      readFileSync(path.join(ROOT, candidate), "utf8");
      return candidate.split(path.sep).join("/");
    } catch {
      // try next candidate
    }
  }
  return null; // unresolvable — treated as external
}

function walkSyncClosure(): { files: Set<string>; externalEdges: Edge[] } {
  const visited = new Set<string>();
  const externalEdges: Edge[] = [];
  const queue = [...SYNC_REQUIRED_ENTRYPOINTS];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = stripComments(readSource(file));
    for (const specifier of collectSpecifiers(file, source)) {
      const resolved = resolveProjectSpecifier(file, specifier);
      if (resolved) {
        if (!visited.has(resolved)) queue.push(resolved);
      } else {
        externalEdges.push({ from: file, specifier });
      }
    }
  }
  return { files: visited, externalEdges };
}

describe("postgres sync-leaf import graph (cinatra#104 regression gate)", () => {
  const { files, externalEdges } = walkSyncClosure();

  it("never reaches async project modules (database.ts, mcp-server, objects-store)", () => {
    const offenders = [...files].filter((file) =>
      BANNED_PROJECT_FILES.some((re) => re.test(file)),
    );
    expect(
      offenders,
      `sync-required modules transitively import async project modules: ${offenders.join(", ")}. ` +
        "Under Turbopack these are async modules; require()-composing them breaks " +
        "(see src/lib/postgres-config.ts). Import from the sync leaves instead.",
    ).toEqual([]);
  });

  it("never imports async-root externals (pg, drizzle-orm/node-postgres, MCP SDK)", () => {
    const offenders = externalEdges.filter((edge) =>
      BANNED_EXTERNALS.some((re) => re.test(edge.specifier)),
    );
    expect(
      offenders,
      `async-root external imported from sync-required closure: ${offenders
        .map((edge) => `${edge.from} -> ${edge.specifier}`)
        .join(", ")}. Real-pg code belongs in src/lib/extension-destinations-store.ts.`,
    ).toEqual([]);
  });

  it("artifact-refs-store and the leaves never require() @/lib/database at runtime", () => {
    for (const file of files) {
      const source = stripComments(readSource(file));
      expect(
        /require\(\s*["']@\/lib\/database["']\s*\)/.test(source),
        `${file} contains require("@/lib/database") — returns a Promise under Turbopack dev (async module), all exports read undefined`,
      ).toBe(false);
    }
  });

  it("still walks a non-trivial closure (sanity)", () => {
    expect(files.size).toBeGreaterThanOrEqual(SYNC_REQUIRED_ENTRYPOINTS.length);
    expect(files).toContain("src/lib/postgres-sync.ts");
  });
});
