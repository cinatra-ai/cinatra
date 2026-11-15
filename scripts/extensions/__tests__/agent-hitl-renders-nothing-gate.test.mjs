// Unit tests for the agent HITL renders-nothing gate (cinatra#3470, epic
// cinatra#3248).
//
// The rule: connectors render the setup page themselves, artifacts render the
// artifact view themselves, agents do NOT render the HITL view themselves.
// The gate refuses, outright (no baseline, owner ruling of 2026-09-13), any
// package of kind agent that declares a field-renderer component, carries a
// copy of a design-registry primitive under src/components/ui/, reaches into
// the product's primitives directly, or is listed in the vendoring manifest.
//
// Every CLI case runs the gate as a SUBPROCESS against a SYNTHETIC extension
// tree in a throwaway temp dir (AGENT_HITL_GATE_EXT_ROOT), so the assertion is
// the real exit code and message. The committed extensions/ tree is never read.
// The declared set is the package.json beside the synthetic extension root, as
// the repository root's is beside the real one (the census of
// scripts/extensions/self-rendering-extensions-border-gate.mjs).

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as gate from "../agent-hitl-renders-nothing-gate.mjs";
import { scanBorder } from "../self-rendering-extensions-border-gate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE = join(__dirname, "..", "agent-hitl-renders-nothing-gate.mjs");

const temps = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

/**
 * `packages` = [{ dir, kind, fieldRenderers?, files?, manifest? }]. The
 * package.json beside `extensions/` declares exactly those packages unless
 * `opts.declared` gives the devExtensions value itself.
 */
function makeTree(packages, opts = {}) {
  const base = mkdtempSync(join(tmpdir(), "cinatra-agent-hitl-gate-"));
  temps.push(base);
  const extRoot = join(base, "extensions");
  const declared =
    "declared" in opts
      ? opts.declared
      : Object.fromEntries(packages.map((p) => [`@cinatra-ai/${p.dir}`, {}]));
  writeFileSync(
    join(base, "package.json"),
    JSON.stringify({ name: "fixture-root", cinatra: { devExtensions: declared } }, null, 2),
  );
  mkdirSync(join(extRoot, "cinatra-ai"), { recursive: true });
  for (const pkg of packages) {
    const pkgDir = join(extRoot, "cinatra-ai", pkg.dir);
    mkdirSync(pkgDir, { recursive: true });
    if (pkg.manifest !== null) {
      const cinatra = { kind: pkg.kind };
      if (pkg.fieldRenderers !== undefined) cinatra.fieldRenderers = pkg.fieldRenderers;
      writeFileSync(
        join(pkgDir, "package.json"),
        pkg.manifest ?? JSON.stringify({ name: `@cinatra-ai/${pkg.dir}`, cinatra }, null, 2),
      );
    }
    for (const [rel, contents] of Object.entries(pkg.files ?? {})) {
      const dest = join(pkgDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, contents);
    }
  }
  return { base, extRoot };
}

function runGate({ extRoot }) {
  const res = spawnSync(process.execPath, [GATE], {
    encoding: "utf8",
    env: { ...process.env, AGENT_HITL_GATE_EXT_ROOT: extRoot },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const binding = (dir, local, extra = {}) => ({
  id: `@cinatra-ai/${dir}:${local}`,
  kind: "cta",
  priority: 90,
  ...extra,
});
const BUTTON_COPY = 'import { cn } from "../../lib/utils";\nexport const Button = () => null;\n';

describe("agent HITL renders-nothing gate (cinatra#3470)", () => {
  it("PASSES a tree whose agents only declare, and ignores artifact and connector packages", () => {
    const tree = makeTree([
      { dir: "demo-agent", kind: "agent", fieldRenderers: [binding("demo-agent", "pick", { midRunHitl: true })] },
      {
        dir: "demo-artifact",
        kind: "artifact",
        fieldRenderers: [binding("demo-artifact", "view", { component: { entry: "src/renderers/view" } })],
        files: { "src/components/ui/button.tsx": BUTTON_COPY },
      },
      { dir: "demo-connector", kind: "connector" },
    ]);
    const { status, stdout, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("OK");
    expect(stdout).toContain("1 agent package");
  });

  it("FAILS on a field-renderer component declared by an agent package", () => {
    const tree = makeTree([
      {
        dir: "demo-agent",
        kind: "agent",
        fieldRenderers: [binding("demo-agent", "review", { component: { entry: "src/renderers/review" } })],
      },
    ]);
    const { status, stderr } = runGate(tree);
    expect(status).toBe(1);
    expect(stderr).toContain("cinatra#3470");
    expect(stderr).toContain("@cinatra-ai/demo-agent:review");
    expect(stderr).toMatch(/component/);
  });

  it("FAILS on a design-registry primitive copy inside an agent package", () => {
    const tree = makeTree([
      { dir: "demo-agent", kind: "agent", files: { "src/components/ui/button.tsx": BUTTON_COPY } },
    ]);
    const { status, stderr } = runGate(tree);
    expect(status).toBe(1);
    expect(stderr).toContain("demo-agent");
    expect(stderr).toContain("src/components/ui/button.tsx");
  });

  it("FAILS on an agent source file that imports the product's primitives directly", () => {
    const tree = makeTree([
      {
        dir: "demo-agent",
        kind: "agent",
        files: { "src/renderers/review.tsx": 'import { Button } from "@/components/ui/button";\n' },
      },
    ]);
    const { status, stderr } = runGate(tree);
    expect(status).toBe(1);
    expect(stderr).toContain("src/renderers/review.tsx");
    expect(stderr).toContain("@/components/ui/button");
  });

  it("REFUSES a declared package whose package.json is missing (nothing unread passes)", () => {
    const tree = makeTree([{ dir: "demo-agent", kind: "agent", manifest: null }]);
    const { status, stderr } = runGate(tree);
    expect(status).toBe(1);
    expect(stderr).toContain("REFUSED");
    expect(stderr).toContain("@cinatra-ai/demo-agent");
  });

  it("REFUSES an empty declared set (an empty census would pass vacuously)", () => {
    const tree = makeTree([{ dir: "demo-agent", kind: "agent" }], { declared: {} });
    const { status, stderr } = runGate(tree);
    expect(status).toBe(1);
    expect(stderr).toContain("REFUSED");
  });

  it("REFUSES an agent whose cinatra.fieldRenderers is present but not a list", () => {
    const tree = makeTree([{ dir: "demo-agent", kind: "agent", fieldRenderers: { component: {} } }]);
    const { status, stderr } = runGate(tree);
    expect(status).toBe(1);
    expect(stderr).toContain("REFUSED");
    expect(stderr).toContain("fieldRenderers");
  });

  it("names a vendoring-manifest entry for an agent package as a finding", () => {
    const tree = makeTree([{ dir: "demo-agent", kind: "agent" }]);
    const census = gate.scanAgentBorder({ extRoot: tree.extRoot });
    expect(census.refusals).toEqual([]);
    const findings = gate.evaluateAgentBorder(
      census,
      new Set(["extensions/cinatra-ai/demo-agent"]),
    );
    expect(findings).toEqual([
      {
        kind: "vendoring-manifest-entry",
        package: "demo-agent",
        detail: "extensions/cinatra-ai/demo-agent",
      },
    ]);
    expect(gate.evaluateAgentBorder(census, new Set())).toEqual([]);
  });

  it("the border census reads the kinds it is given, and keeps its own default", () => {
    const tree = makeTree([
      { dir: "demo-agent", kind: "agent", files: { "src/components/ui/button.tsx": BUTTON_COPY } },
      { dir: "demo-connector", kind: "connector" },
    ]);
    const agents = scanBorder({ extRoot: tree.extRoot, kinds: gate.AGENT_KINDS });
    expect(agents.packages.map((p) => p.name)).toEqual(["demo-agent"]);
    expect(agents.copies).toEqual({ "demo-agent": ["src/components/ui/button.tsx"] });
    const selfRendering = scanBorder({ extRoot: tree.extRoot });
    expect(selfRendering.packages.map((p) => p.name)).toEqual(["demo-connector"]);
    expect(selfRendering.copies).toEqual({});
  });
});
