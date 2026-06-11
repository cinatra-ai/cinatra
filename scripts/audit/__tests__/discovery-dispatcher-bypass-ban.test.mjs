import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  scanBypassFiles,
  diffFiles,
  baselineGrowth,
  sanctionedReaderDefects,
  staleSanctionedReaders,
  GATED_SYMBOLS,
  SANCTIONED_READERS,
} from "../discovery-dispatcher-bypass-ban.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts/audit/discovery-dispatcher-bypass-ban.mjs");

function runGate(extraEnv = {}) {
  return spawnSync("node", [GATE], { cwd: REPO_ROOT, env: { ...process.env, ...extraEnv }, encoding: "utf8" });
}

describe("discovery-dispatcher-bypass-ban gate (zero-tolerance, #36)", () => {
  it("gates BOTH native readers — lifecycle-active AND archived (a direct archived read is still a native-store read)", () => {
    expect(GATED_SYMBOLS).toContain("readActiveExtensionTemplates");
    expect(GATED_SYMBOLS).toContain("readArchivedExtensionTemplates");
  });

  it("the live tree has ZERO non-sanctioned direct readers (the baseline floor is zero)", () => {
    expect(scanBypassFiles()).toEqual([]);
  });

  it("sanctioned readers are documented, never counted — incl. the two justified install-state screens", () => {
    const files = scanBypassFiles();
    for (const sanctioned of [
      "packages/agents/src/store.ts", // defines the readers
      "packages/agents/src/index.ts", // barrel re-export
      "packages/agents/src/extension-handler.ts", // the dispatcher's reader facet
      "packages/extensions/src/screens/extensions-marketplace-screen.tsx", // install-state read model
      "packages/extensions/src/screens/registry-catalog-screen.tsx", // archived-only install-state read
    ]) {
      expect(SANCTIONED_READERS.has(sanctioned), sanctioned).toBe(true);
      expect(files).not.toContain(sanctioned);
    }
  });

  it("the committed baseline file is PINNED EMPTY (zero-tolerance: nothing is tolerated outside the sanctioned allowlist)", () => {
    const doc = JSON.parse(
      readFileSync(join(REPO_ROOT, "scripts/audit/discovery-dispatcher-bypass-ban.baseline.json"), "utf8"),
    );
    expect(doc.files).toEqual([]);
    expect(doc.gatedSymbols).toEqual(GATED_SYMBOLS);
  });

  it("every sanctioned entry carries a written justification; defects are flagged", () => {
    expect(sanctionedReaderDefects()).toEqual([]); // the committed allowlist is clean
    for (const [file, justification] of SANCTIONED_READERS) {
      expect(justification.trim().length, file).toBeGreaterThan(20);
    }
    expect(sanctionedReaderDefects(new Map([["a.ts", ""]]))).toEqual(["a.ts"]);
    expect(sanctionedReaderDefects(new Map([["a.ts", "   "]]))).toEqual(["a.ts"]);
    expect(sanctionedReaderDefects(new Map([["a.ts", null]]))).toEqual(["a.ts"]);
    expect(sanctionedReaderDefects(new Map([["a.ts", "real justification"]]))).toEqual([]);
  });

  it("staleness self-policing: a sanctioned entry whose file no longer references a gated reader (or is gone) is flagged", () => {
    const root = mkdtempSync(join(tmpdir(), "bypass-gate-stale-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/live.ts"), "export const x = readActiveExtensionTemplates();\n");
      writeFileSync(join(root, "src/dormant.ts"), "export const y = 1; // no reader reference\n");
      const allowlist = new Map([
        ["src/live.ts", "j"],
        ["src/dormant.ts", "j"],
        ["src/deleted.ts", "j"],
      ]);
      expect(staleSanctionedReaders(root, allowlist)).toEqual(["src/deleted.ts", "src/dormant.ts"]);
      // the live committed allowlist itself has no stale entries
      expect(staleSanctionedReaders()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a NON-sanctioned direct reader (either symbol) IS scanned as a bypass — fixture", () => {
    const root = mkdtempSync(join(tmpdir(), "bypass-gate-scan-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/active-bypass.ts"), 'import { readActiveExtensionTemplates } from "@cinatra-ai/agents";\n');
      writeFileSync(join(root, "src/archived-bypass.ts"), 'import { readArchivedExtensionTemplates } from "@cinatra-ai/agents";\n');
      writeFileSync(join(root, "src/clean.ts"), "export const ok = true;\n");
      expect(scanBypassFiles(root, ["src"], new Map())).toEqual([
        "src/active-bypass.ts",
        "src/archived-bypass.ts",
      ]);
      // a sanctioned entry suppresses ONLY its own file
      expect(scanBypassFiles(root, ["src"], new Map([["src/active-bypass.ts", "j"]]))).toEqual([
        "src/archived-bypass.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("diffFiles flags a NEW bypass as added and a migrated file as removed", () => {
    const { added, removed } = diffFiles([], ["src/app/new-surface/page.tsx"]);
    expect(added).toEqual(["src/app/new-surface/page.tsx"]);
    expect(removed).toEqual([]);

    const d2 = diffFiles(["a.tsx", "b.tsx"], ["a.tsx"]);
    expect(d2.added).toEqual([]);
    expect(d2.removed).toEqual(["b.tsx"]);
  });

  it("baselineGrowth catches a committed baseline that GREW vs base (regenerate-to-pass bypass)", () => {
    const baseBaseline = [];
    const committed = ["sneaky.tsx"];
    expect(baselineGrowth(baseBaseline, committed)).toEqual(["sneaky.tsx"]);
    // shrink-only is allowed
    expect(baselineGrowth(committed, baseBaseline)).toEqual([]);
  });

  it("the committed repo state PASSES the gate (zero floor holds)", () => {
    const res = runGate();
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(res.stdout).toMatch(/no dispatcher bypass \(zero-tolerance holds/);
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
