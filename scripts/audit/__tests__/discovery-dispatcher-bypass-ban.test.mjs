import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  scanBypassFiles,
  diffFiles,
  baselineGrowth,
  GATED_SYMBOLS,
} from "../discovery-dispatcher-bypass-ban.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts/audit/discovery-dispatcher-bypass-ban.mjs");

function runGate(extraEnv = {}) {
  return spawnSync("node", [GATE], { cwd: REPO_ROOT, env: { ...process.env, ...extraEnv }, encoding: "utf8" });
}

describe("discovery-dispatcher-bypass-ban gate", () => {
  it("gates the lifecycle-active agent reader symbol", () => {
    expect(GATED_SYMBOLS).toContain("readActiveExtensionTemplates");
  });

  it("scans real bypass files but ALLOWLISTS the reader definition + handler facet", () => {
    const files = scanBypassFiles();
    // The marketplace screen still reads the native store directly (baseline).
    expect(files).toContain("packages/extensions/src/screens/extensions-marketplace-screen.tsx");
    // Sanctioned references are allowlisted — never counted as bypasses.
    expect(files).not.toContain("packages/agents/src/store.ts"); // defines it
    expect(files).not.toContain("packages/agents/src/index.ts"); // re-exports it
    expect(files).not.toContain("packages/agents/src/extension-handler.ts"); // the dispatcher reader facet
    // The CONVERTED registry-catalog screen no longer bypasses (routes through the dispatcher).
    expect(files).not.toContain("packages/extensions/src/screens/registry-catalog-screen.tsx");
  });

  it("diffFiles flags a NEW bypass as added and a migrated file as removed", () => {
    const base = ["packages/extensions/src/screens/extensions-marketplace-screen.tsx"];
    const cur = [
      "packages/extensions/src/screens/extensions-marketplace-screen.tsx",
      "src/app/new-surface/page.tsx",
    ];
    const { added, removed } = diffFiles(base, cur);
    expect(added).toEqual(["src/app/new-surface/page.tsx"]);
    expect(removed).toEqual([]);

    const d2 = diffFiles(["a.tsx", "b.tsx"], ["a.tsx"]);
    expect(d2.added).toEqual([]);
    expect(d2.removed).toEqual(["b.tsx"]);
  });

  it("baselineGrowth catches a committed baseline that GREW vs base (regenerate-to-pass bypass)", () => {
    const baseBaseline = ["a.tsx"];
    const committed = ["a.tsx", "sneaky.tsx"];
    expect(baselineGrowth(baseBaseline, committed)).toEqual(["sneaky.tsx"]);
    // shrink-only is allowed
    expect(baselineGrowth(committed, baseBaseline)).toEqual([]);
  });

  it("the committed repo state PASSES the gate (--check default, no base ref)", () => {
    const res = runGate();
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(res.stdout).toMatch(/no NEW dispatcher bypass/);
  });

  it("fails CLOSED on a set-but-unresolvable base ref (no silent guard disable)", () => {
    const res = runGate({ DISCOVERY_BYPASS_BASE: "refs/does/not/exist-deadbeef" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/did not resolve|Failing closed/);
  });

  it("rejects a flag-like base ref", () => {
    const res = runGate({ DISCOVERY_BYPASS_BASE: "--upload-pack=evil" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/flag-like/);
  });
});
