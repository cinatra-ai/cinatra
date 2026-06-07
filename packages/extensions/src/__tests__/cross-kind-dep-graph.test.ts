// Cross-kind dependency lifecycle coverage for install resolution, uninstall safety, cycle detection, and authoring-chain budget guards.
import { describe, it, expect } from "vitest";
import {
  buildCrossKindGraph,
  resolveInstall,
  decideUninstall,
  detectCycles,
  checkAuthoringRecursionBudget,
  type CrossKindNode,
} from "../cross-kind-dep-graph";

const A = (over: Partial<CrossKindNode> = {}): CrossKindNode => ({
  packageName: "@cinatra-ai/marketing-icp-artifact",
  kind: "artifact",
  agentDependencies: ["@cinatra-ai/marketing-strategy-draft-agent"],
  ...over,
});
const AG = (over: Partial<CrossKindNode> = {}): CrossKindNode => ({
  packageName: "@cinatra-ai/marketing-strategy-draft-agent",
  kind: "agent",
  produces: ["@cinatra-ai/marketing-icp-artifact"],
  ...over,
});

describe("resolveInstall — registry-aware SOFT with strict mode available", () => {
  it("SOFT: unresolved deps do not fail install (seed packs land later)", () => {
    const g = buildCrossKindGraph([A()]);
    const r = resolveInstall(g, A());
    expect(r.ok).toBe(true);
    expect(r.unresolved).toEqual(["@cinatra-ai/marketing-strategy-draft-agent"]);
    expect(r.mode).toBe("soft");
  });
  it("resolves a dep that exists in the graph or the installed set", () => {
    const g = buildCrossKindGraph([A(), AG()]);
    expect(resolveInstall(g, A()).resolved).toContain("@cinatra-ai/marketing-strategy-draft-agent");
    const g2 = buildCrossKindGraph([A()]);
    const r = resolveInstall(g2, A(), { installed: new Set(["@cinatra-ai/marketing-strategy-draft-agent"]) });
    expect(r.unresolved).toEqual([]);
  });
  it("STRICT: unresolved dependencies produce ok=false", () => {
    const g = buildCrossKindGraph([A()]);
    expect(resolveInstall(g, A(), { mode: "strict" }).ok).toBe(false);
  });
});

describe("decideUninstall — block-or-archive", () => {
  it("BLOCKS when an installed cross-kind dependent exists", () => {
    const g = buildCrossKindGraph([A(), AG()]);
    // uninstalling the agent: the artifact declares agentDependencies on it
    const d = decideUninstall(g, "@cinatra-ai/marketing-strategy-draft-agent");
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.dependents).toContain("@cinatra-ai/marketing-icp-artifact");
  });
  it("does NOT block on a dependent that is not installed", () => {
    const g = buildCrossKindGraph([A(), AG()]);
    const d = decideUninstall(g, "@cinatra-ai/marketing-strategy-draft-agent", {
      installed: new Set(["@cinatra-ai/marketing-strategy-draft-agent"]), // artifact NOT installed
    });
    expect(d.action).not.toBe("block");
  });
  it("ARCHIVES an artifact ext with live rows (replay-safe) instead of removing", () => {
    const g = buildCrossKindGraph([A({ agentDependencies: [] })]);
    const d = decideUninstall(g, "@cinatra-ai/marketing-icp-artifact", {
      installed: new Set(["@cinatra-ai/marketing-icp-artifact"]),
      hasLiveArtifactRows: true,
    });
    expect(d.action).toBe("archive");
  });
  it("REMOVES when no installed dependents and no live rows", () => {
    const g = buildCrossKindGraph([A({ agentDependencies: [] })]);
    const d = decideUninstall(g, "@cinatra-ai/marketing-icp-artifact", {
      installed: new Set(["@cinatra-ai/marketing-icp-artifact"]),
    });
    expect(d.action).toBe("remove");
  });
});

describe("detectCycles — cross-kind cycle detection", () => {
  it("finds the artifact↔agent produce/depend cycle", () => {
    const g = buildCrossKindGraph([A(), AG()]); // icp→agent, agent→icp
    const cycles = detectCycles(g);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toContain("@cinatra-ai/marketing-icp-artifact");
  });
  it("no false cycle on a DAG", () => {
    const g = buildCrossKindGraph([
      A({ agentDependencies: ["@cinatra-ai/x-agent"] }),
      AG({ packageName: "@cinatra-ai/x-agent", produces: [] }),
    ]);
    expect(detectCycles(g)).toEqual([]);
  });
  it("ignores unresolved (soft) refs — not a cycle", () => {
    const g = buildCrossKindGraph([A()]); // dep on a non-present agent
    expect(detectCycles(g)).toEqual([]);
  });
});

describe("checkAuthoringRecursionBudget — authoring-chain guard", () => {
  it("a tight cycle stays depth-capped (never infinite)", () => {
    const g = buildCrossKindGraph([A(), AG()]);
    const r = checkAuthoringRecursionBudget(g, "@cinatra-ai/marketing-icp-artifact", 8);
    expect(Number.isFinite(r.maxDepthReached)).toBe(true);
    expect(r.maxDepthReached).toBeLessThanOrEqual(8);
  });
  it("flags a chain that would exceed the budget", () => {
    // linear chain p0→p1→…→p10, budget 5
    const nodes: CrossKindNode[] = [];
    for (let i = 0; i < 11; i++) {
      nodes.push({
        packageName: `p${i}`,
        kind: "artifact",
        agentDependencies: i < 10 ? [`p${i + 1}`] : [],
      });
    }
    const r = checkAuthoringRecursionBudget(buildCrossKindGraph(nodes), "p0", 5);
    expect(r.withinBudget).toBe(false);
  });

  it("INCLUSIVE boundary: a chain ending exactly at depth==budget is WITHIN budget", () => {
    // p0→…→p5 is depth 5 (5 edges from p0). budget 5 → within.
    const nodes: CrossKindNode[] = [];
    for (let i = 0; i < 6; i++) {
      nodes.push({
        packageName: `q${i}`,
        kind: "artifact",
        agentDependencies: i < 5 ? [`q${i + 1}`] : [],
      });
    }
    const r = checkAuthoringRecursionBudget(buildCrossKindGraph(nodes), "q0", 5);
    expect(r.maxDepthReached).toBe(5);
    expect(r.withinBudget).toBe(true);
    // one level deeper than budget → over
    const over = checkAuthoringRecursionBudget(buildCrossKindGraph(nodes), "q0", 4);
    expect(over.withinBudget).toBe(false);
  });
});
