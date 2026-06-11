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
    // The remaining residual is the nango cluster (the lazy/guarded
    // host-access cutover retired every other connector's value-import edges,
    // including the un-exempt anthropic-connector's — cinatra#7); nango stays
    // scanned.
    expect(flat).toContain("@cinatra-ai/nango-connector");
    expect(flat).not.toContain("@cinatra-ai/anthropic-connector");
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

  it("baselineGrowth is STRICT subset-only — the un-exempt seed transition (the gate's only growth path) is retired (zero-tolerance, #36)", () => {
    // Before the flip (#36), a NEWLY_UNEXEMPTED_BASELINE_SEED member could seed its
    // pre-existing edges into the baseline (a sanctioned one-PR growth). The
    // the flip (#36) removed the mechanism entirely: baselineGrowth takes NO seed
    // parameter and flags EVERY edge not present in the base — there is no
    // data path that can grow this baseline.
    expect(baselineGrowth.length).toBe(2); // (base, committed) — no seed param
    const base = { "src/a.ts": ["@cinatra-ai/x-connector"] };
    const committed = {
      "src/a.ts": ["@cinatra-ai/x-connector"],
      "src/apis-page.tsx": ["@cinatra-ai/anthropic-connector"], // formerly seedable — now flagged
    };
    expect(baselineGrowth(base, committed)).toEqual([
      "src/apis-page.tsx -> @cinatra-ai/anthropic-connector",
    ]);
    // shrink-only is allowed
    expect(baselineGrowth(committed, base)).toEqual([]);
  });

  it("exempts ONLY the explicit generator-emitted files under lib/generated/ — a hand-added sibling file is counted (smuggling guard, #36)", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-ext-gate-gen-"));
    mkdirSync(join(dir, "lib", "generated"), { recursive: true });
    // Generator-emitted manifest file: exempt (its names are generator data).
    writeFileSync(
      join(dir, "lib", "generated", "extensions.server.ts"),
      'import "@cinatra-ai/blog-skills/register";\n',
    );
    // Hand-added file in the SAME dir: counted (the exemption is the explicit
    // emitted list, never a directory prefix).
    writeFileSync(
      join(dir, "lib", "generated", "hand-added-smuggle.ts"),
      'import "@cinatra-ai/blog-skills/register";\n',
    );
    const extNames = new Set(["@cinatra-ai/blog-skills"]);
    const edges = scanCoreExtensionEdges(dir, extNames);
    expect(edges["src/lib/generated/extensions.server.ts"]).toBeUndefined();
    expect(edges["src/lib/generated/hand-added-smuggle.ts"]).toEqual(["@cinatra-ai/blog-skills"]);
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
