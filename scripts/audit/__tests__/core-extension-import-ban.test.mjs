import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  scanCoreExtensionEdges,
  diffEdges,
  baselineGrowth,
  staleUnexemptedSeed,
  discoverExtensionNames,
} from "../core-extension-import-ban.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts/audit/core-extension-import-ban.mjs");

function runGate(extraEnv = {}) {
  return spawnSync("node", [GATE], { cwd: REPO_ROOT, env: { ...process.env, ...extraEnv }, encoding: "utf8" });
}

describe("core-extension-import-ban gate", () => {
  it("scans real core->extension edges (and the MCP registration surfaces stay decoupled)", () => {
    const edges = scanCoreExtensionEdges();
    // The scanner still sees the REMAINING real connector edges in the tree
    // (the decoupling sweep shrinks this set toward zero).
    const flat = Object.values(edges).flat();
    expect(flat.some((e) => e.endsWith("-connector"))).toBe(true);
    // anthropic-connector is un-exempt → its host->ext edges ARE scanned.
    expect(flat).toContain("@cinatra-ai/anthropic-connector");
    // The MCP module + primitive-handler registration surfaces resolve through
    // the generated manifest now — no static connector import may reappear.
    expect(edges["src/lib/mcp-server.ts"]).toBeUndefined();
    expect(edges["src/lib/primitive-handlers.ts"]).toBeUndefined();
  });

  it("diffEdges flags a NEW edge as added and a gone edge as removed", () => {
    const base = { "src/a.ts": ["@cinatra-ai/x-connector"] };
    const cur = { "src/a.ts": ["@cinatra-ai/x-connector", "@cinatra-ai/y-agent"], "src/b.ts": ["@cinatra-ai/z-skill"] };
    const { added, removed } = diffEdges(base, cur);
    expect(added).toEqual(["src/a.ts -> @cinatra-ai/y-agent", "src/b.ts -> @cinatra-ai/z-skill"]);
    expect(removed).toEqual([]);

    const d2 = diffEdges({ "src/a.ts": ["@cinatra-ai/x-connector", "@cinatra-ai/y-agent"] }, { "src/a.ts": ["@cinatra-ai/x-connector"] });
    expect(d2.added).toEqual([]);
    expect(d2.removed).toEqual(["src/a.ts -> @cinatra-ai/y-agent"]);
  });

  it("baselineGrowth catches a committed baseline that GREW vs base (regenerate-to-pass bypass)", () => {
    const baseBaseline = { "src/a.ts": ["@cinatra-ai/x-connector"] };
    const committed = { "src/a.ts": ["@cinatra-ai/x-connector"], "src/new.ts": ["@cinatra-ai/sneaky-agent"] };
    expect(baselineGrowth(baseBaseline, committed)).toEqual(["src/new.ts -> @cinatra-ai/sneaky-agent"]);
    // shrink-only is allowed
    expect(baselineGrowth(committed, baseBaseline)).toEqual([]);
  });

  it("derives extension names from package.json — incl. *-skills + the un-exempt anthropic-connector", () => {
    const names = discoverExtensionNames();
    expect(names.has("@cinatra-ai/blog-skills")).toBe(true); // plural-suffixed skill pkg the old regex missed
    expect(names.has("@cinatra-ai/assistant-skills")).toBe(true);
    expect(names.has("@cinatra-ai/anthropic-connector")).toBe(true); // un-exempt
  });

  it("baselineGrowth ALLOWS growth for a NEWLY_UNEXEMPTED target (the un-exempt seed transition mechanism)", () => {
    // The live NEWLY_UNEXEMPTED_BASELINE_SEED is now EMPTY — the anthropic-connector
    // transition completed and its host->ext edges landed in the baseline. This pins
    // the MECHANISM with an explicit seed (like the staleUnexemptedSeed test below),
    // independent of the current — empty — constant value.
    const seed = new Set(["@cinatra-ai/anthropic-connector"]);
    const base = { "src/a.ts": ["@cinatra-ai/x-connector"] };
    const committed = {
      "src/a.ts": ["@cinatra-ai/x-connector"],
      "src/apis-page.tsx": ["@cinatra-ai/anthropic-connector"], // seeded — allowed
    };
    expect(baselineGrowth(base, committed, seed)).toEqual([]);
    // …but a NON-seed target growing alongside it STILL fails.
    const committed2 = { ...committed, "src/sneaky.ts": ["@cinatra-ai/sneaky-agent"] };
    expect(baselineGrowth(base, committed2, seed)).toEqual(["src/sneaky.ts -> @cinatra-ai/sneaky-agent"]);
    // An explicit EMPTY seed (the CURRENT live state) restores strict growth — the
    // anthropic edge now fails too, proving the allowance is scoped to the seed.
    expect(baselineGrowth(base, committed, new Set())).toEqual([
      "src/apis-page.tsx -> @cinatra-ai/anthropic-connector",
    ]);
  });

  it("staleUnexemptedSeed self-polices: a member whose edges are ALREADY in base is stale (one-PR-only)", () => {
    const seed = new Set(["@cinatra-ai/anthropic-connector"]);
    // Edges NOT yet in base (this IS the seed PR) → not stale.
    expect(staleUnexemptedSeed({ "src/a.ts": ["@cinatra-ai/x-connector"] }, seed)).toEqual([]);
    // Edges already in base (the seed PR merged) → STALE → the member must be removed.
    expect(
      staleUnexemptedSeed({ "src/apis-page.tsx": ["@cinatra-ai/anthropic-connector"] }, seed),
    ).toEqual(["@cinatra-ai/anthropic-connector"]);
  });

  it("CATCHES a *-skills extension import and does NOT flag the host glue pkg @cinatra-ai/connectors", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-ext-gate-"));
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "lib", "feature.ts"), `
      import { register } from "@cinatra-ai/blog-skills/register";
      import { ConnectorsPage } from "@cinatra-ai/connectors/pages"; // host glue — NOT an extension
      import { foo } from "@cinatra-ai/sdk-ui"; // SDK — NOT an extension
    `);
    const extNames = new Set(["@cinatra-ai/blog-skills"]); // host glue + sdk-ui intentionally absent
    const edges = scanCoreExtensionEdges(dir, extNames);
    expect(edges["src/lib/feature.ts"]).toEqual(["@cinatra-ai/blog-skills"]);
  });

  it("the committed repo state passes the gate (baseline is current)", () => {
    const res = runGate();
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toMatch(/no NEW core->extension coupling/);
  });
});
