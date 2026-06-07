import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  scanInstanceCoupling,
  diffGrown,
  diffShrunk,
  baselineGrowth,
  discoverExtensionNames,
} from "../core-extension-instance-coupling-ban.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts/audit/core-extension-instance-coupling-ban.mjs");

function runGate(extraEnv = {}) {
  return spawnSync("node", [GATE], { cwd: REPO_ROOT, env: { ...process.env, ...extraEnv }, encoding: "utf8" });
}

describe("core-extension-instance-coupling-ban gate", () => {
  it("derives extension names from package.json (same source as the import-ban gate)", () => {
    const names = discoverExtensionNames();
    expect(names.size).toBeGreaterThan(50);
    expect(names.has("@cinatra-ai/blog-skills")).toBe(true);
  });

  it("counts real hardcoded coupling (string + path literals) — sentinel: src/lib/blog/generation.ts", () => {
    const occ = scanInstanceCoupling();
    const genKeys = Object.keys(occ).filter((k) => k.startsWith("src/lib/blog/generation.ts ::"));
    expect(genKeys.length).toBeGreaterThan(0);
    expect(genKeys.some((k) => k.includes("package :: @cinatra-ai/"))).toBe(true);
  });

  it("regression guard: src/lib/blog/openai.ts is de-coupled (IoC cutover — resolves skills by capability key, not hardcoded extension)", () => {
    const occ = scanInstanceCoupling();
    const openaiKeys = Object.keys(occ).filter((k) => k.startsWith("src/lib/blog/openai.ts ::"));
    expect(openaiKeys).toEqual([]);
    // prefill-generation.ts is likewise de-coupled.
    const prefillKeys = Object.keys(occ).filter((k) => k.includes("prefill-generation.ts ::"));
    expect(prefillKeys).toEqual([]);
  });

  it("counts imports too (the src-only import-ban does not scan packages/ — close that hole)", () => {
    const occ = scanInstanceCoupling();
    // packages/* files that reference an extension package name (incl. imports)
    const pkgRefs = Object.keys(occ).filter((k) => k.startsWith("packages/") && k.includes(":: package ::"));
    expect(pkgRefs.length).toBeGreaterThan(0);
  });

  it("does NOT false-positive on the CORE @cinatra-ai/extensions/<subpath> package path", () => {
    const occ = scanInstanceCoupling();
    // `extensions/components/...` is a core packages/extensions subpath, NOT an
    // extensions/<scope>/<name> folder → must not be counted as a path.
    const fp = Object.keys(occ).filter((k) => k.includes("path :: extensions/components"));
    expect(fp).toEqual([]);
  });

  it("does NOT scan the extensions/ tree, src/lib/generated/**, or tests", () => {
    const occ = scanInstanceCoupling();
    const files = new Set(Object.keys(occ).map((k) => k.split(" :: ")[0]));
    for (const f of files) {
      expect(f.startsWith("extensions/")).toBe(false);
      expect(f.startsWith("src/lib/generated/")).toBe(false);
      expect(/\.(test|spec)\.|\/__tests__\/|\/__mocks__\//.test(f)).toBe(false);
    }
  });

  it("diffGrown flags a NEW occurrence and a GROWN count; diffShrunk flags a reduced count", () => {
    const base = { "a.ts :: package :: @x/foo": 1 };
    const cur = { "a.ts :: package :: @x/foo": 2, "b.ts :: path :: extensions/x/y": 1 };
    expect(diffGrown(base, cur)).toEqual([
      "a.ts :: package :: @x/foo (1 -> 2)",
      "b.ts :: path :: extensions/x/y (0 -> 1)",
    ]);
    expect(diffShrunk({ "a.ts :: package :: @x/foo": 2 }, { "a.ts :: package :: @x/foo": 1 })).toEqual([
      "a.ts :: package :: @x/foo (2 -> 1)",
    ]);
  });

  it("baselineGrowth catches a committed baseline that exceeds the base (regenerate-to-pass bypass)", () => {
    expect(baselineGrowth({ "a :: package :: @x/y": 1 }, { "a :: package :: @x/y": 2 })).toEqual([
      "a :: package :: @x/y (1 -> 2)",
    ]);
    // shrink-only is allowed
    expect(baselineGrowth({ "a :: package :: @x/y": 2 }, { "a :: package :: @x/y": 1 })).toEqual([]);
  });

  it("the committed repo state PASSES the gate (no NEW coupling vs the baseline)", () => {
    const res = runGate();
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(res.stdout).toMatch(/no NEW instance coupling/);
  });

  it("fails CLOSED on a set-but-unresolvable base ref", () => {
    const res = runGate({ CORE_EXT_INSTANCE_BAN_BASE: "refs/does/not/exist-deadbeef" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/did not resolve|Failing closed/);
  });

  it("rejects a flag-like base ref", () => {
    const res = runGate({ CORE_EXT_INSTANCE_BAN_BASE: "--upload-pack=evil" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/flag-like/);
  });
});
