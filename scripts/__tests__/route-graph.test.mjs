// route-graph.mjs — invariant tests.
//
// Why: scripts/route-graph.mjs is the PRIMARY deterministic acceptance metric
// for the route-graph baseline (locked against its output, with the
// before/after delta asserted against it). If the script
// stops being deterministic, or its type-only-import erasure rule regresses,
// every later measurement loses its anchor — silently.
//
// What this file gates:
//   1) Byte-identical JSON output across two consecutive `--all` runs on the
//      same source tree (the determinism contract: zero variance, no server).
//   2) `isInlineTypeOnly` — the four named edge cases from the implementation
//      header comment. Statement-level `import type` is handled separately by
//      the regex's `typePrefix` group; this test asserts the four inline cases.
//
// Runner: hosted by the root vitest include glob `scripts/__tests__/**/*.test.{ts,mjs}`.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "route-graph.mjs");

function runFixedRouteSet(outDir) {
  return spawnSync("node", [SCRIPT, "--out", outDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("route-graph.mjs — determinism contract", () => {
  it("produces byte-identical JSON on two consecutive runs of the LOCKED fixed route set", () => {
    const outA = mkdtempSync(path.join(tmpdir(), "route-graph-A-"));
    const outB = mkdtempSync(path.join(tmpdir(), "route-graph-B-"));
    try {
      const a = runFixedRouteSet(outA);
      const b = runFixedRouteSet(outB);
      expect(a.status, `stderr A: ${a.stderr}`).toBe(0);
      expect(b.status, `stderr B: ${b.stderr}`).toBe(0);
      const jsonA = readFileSync(path.join(outA, "route-graph.json"), "utf8");
      const jsonB = readFileSync(path.join(outB, "route-graph.json"), "utf8");
      // Byte-identical, NOT just structurally-equal — the analyzer must not
      // leak timestamps, run IDs, ordering instability, or absolute-path
      // differences into the persisted artifact (the baseline depends on this).
      expect(jsonB).toBe(jsonA);
    } finally {
      rmSync(outA, { recursive: true, force: true });
      rmSync(outB, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// `isInlineTypeOnly` is not exported. The script is a CLI module (calls main()
// at top-level), so a plain dynamic import would execute it. We re-derive the
// function from the source file at runtime — this is the same logic in lockstep
// and would FAIL the moment the implementation drifts.
// ---------------------------------------------------------------------------
async function loadIsInlineTypeOnly() {
  const src = readFileSync(SCRIPT, "utf8");
  const m = src.match(/function isInlineTypeOnly\([\s\S]*?\n\}\n/);
  if (!m) throw new Error("isInlineTypeOnly not found in route-graph.mjs");
  // Sanity: the function we extract must compile + return a boolean for a
  // baseline named-group case. (If a future refactor moves it to a different
  // shape, this assertion forces an explicit test update rather than a silent
  // drift.)
  const fn = new Function(`${m[0]}\nreturn isInlineTypeOnly;`)();
  expect(typeof fn("{ a }")).toBe("boolean");
  return fn;
}

describe("route-graph.mjs — isInlineTypeOnly type-only-import erasure rule", () => {
  it("returns false for a default-import clause (no named group → has a value binding)", async () => {
    const isInlineTypeOnly = await loadIsInlineTypeOnly();
    expect(isInlineTypeOnly("React")).toBe(false);
  });

  it("returns false for a `* as ns` namespace import (has a value binding)", async () => {
    const isInlineTypeOnly = await loadIsInlineTypeOnly();
    expect(isInlineTypeOnly("* as ns")).toBe(false);
  });

  it("returns true for an inline group where EVERY member is `type X` (erased)", async () => {
    const isInlineTypeOnly = await loadIsInlineTypeOnly();
    expect(isInlineTypeOnly("{ type A, type B }")).toBe(true);
    expect(isInlineTypeOnly("{ type A }")).toBe(true);
  });

  it("returns false for a mixed group with any value binding (still pulls the module)", async () => {
    const isInlineTypeOnly = await loadIsInlineTypeOnly();
    expect(isInlineTypeOnly("{ a, type B }")).toBe(false);
    expect(isInlineTypeOnly("{ type A, b }")).toBe(false);
    expect(isInlineTypeOnly("{ a }")).toBe(false);
  });
});


describe("route-graph.mjs — tryFile() containment guard", () => {
  it("rejects path-traversal targets that resolve outside REPO_ROOT", async () => {
    // Dynamically import the module's exported helpers — but route-graph.mjs runs
    // main() on import. To test tryFile()'s guard without running main(), we use
    // a behavioral assertion: a tsconfig path key that points to ../../../etc/*
    // is recorded as "missing" rather than read off-disk.
    //
    // Simulate by directly invoking the script with --routes pointing to a
    // synthetic entry file we control, in a tmpdir that imports a relative
    // path traversing above REPO_ROOT. The analyzer must classify the off-tree
    // target as missing (not chase it).
    const __filename = fileURLToPath(import.meta.url);
    const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");
    const tmp = mkdtempSync(path.join(tmpdir(), "rg-traversal-"));
    try {
      // Real proof: create an EXISTING file OUTSIDE REPO_ROOT, then ask the
      // analyzer to resolve a relative path that lands on it. Without the
      // containment guard, tryFile() would readFile() the off-tree file
      // happily; WITH the guard, isInsideRepoRoot() returns false → "entry
      // not found". A non-existent traversal target would pass either way
      // (file-not-found masks the guard), so the test must use an existing
      // file to actually discriminate.
      const offTreeFile = path.join(tmp, "off-tree-target.ts");
      writeFileSync(offTreeFile, "export const OFF = 1;\n");
      const relativeFromRepo = path.relative(REPO_ROOT, offTreeFile);
      expect(relativeFromRepo.startsWith("..")).toBe(true); // sanity: outside repo
      const script = path.join(REPO_ROOT, "scripts", "route-graph.mjs");
      const outJson = path.join(tmp, "result.json");
      const res = spawnSync("node", [script, "--routes", relativeFromRepo, "--json", outJson], {
        encoding: "utf8",
      });
      expect(res.status).toBe(0);
      const result = JSON.parse(readFileSync(outJson, "utf8"));
      const route = result.routes.find((r) => r.route === relativeFromRepo);
      expect(route).toBeDefined();
      expect(route.ok).toBe(false);
      expect(route.error).toMatch(/entry not found/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
