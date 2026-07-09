// cinatra#1056 — agent runtime-dependency projection backfill.
//
// Covers the PURE projection (merge-not-clear, kind filtering, required-only
// agent edges, idempotence) and the DI-injected runner (updates only changed
// rows, preserves a legacy-only template's install-seeded agentDependencies —
// the dual-read regression the acceptance names, and soft-fails per row).
import { describe, expect, it, vi } from "vitest";
import {
  projectCanonicalEdgesOntoRuntimeDeps,
  runAgentRuntimeDepProjectionBackfill,
  type BackfillTemplate,
  type RuntimeDepBackfillDeps,
} from "@/lib/agent-runtime-dep-projection-backfill";

type Edge = Parameters<typeof projectCanonicalEdgesOntoRuntimeDeps>[0][number];

const connectorEdge = (packageName: string, requirement: "required" | "optional"): Edge => ({
  packageName,
  kind: "connector",
  edgeType: "runtime",
  versionConstraint: { kind: "semver-range", range: "^1.0.0" },
  requirement,
});
const agentEdge = (packageName: string, requirement: "required" | "optional"): Edge => ({
  packageName,
  kind: "agent",
  edgeType: "runtime",
  versionConstraint: { kind: "exact", version: "2.3.4" },
  requirement,
});

describe("projectCanonicalEdgesOntoRuntimeDeps — pure projection", () => {
  it("projects connector edges (with requirement) and REQUIRED agent edges (as a range)", () => {
    const { next, changed } = projectCanonicalEdgesOntoRuntimeDeps(
      [
        connectorEdge("@cinatra-ai/wordpress-mcp-connector", "required"),
        connectorEdge("@cinatra-ai/apollo-connector", "optional"),
        agentEdge("@cinatra-ai/blog-agent", "required"),
      ],
      {},
    );
    expect(changed).toBe(true);
    expect(next.connectorDependencies).toEqual({
      "@cinatra-ai/wordpress-mcp-connector": { range: "^1.0.0", requirement: "required" },
      "@cinatra-ai/apollo-connector": { range: "^1.0.0", requirement: "optional" },
    });
    // exact constraint flattens to the bare version; optional agent edge dropped.
    expect(next.agentDependencies).toEqual({ "@cinatra-ai/blog-agent": "2.3.4" });
  });

  it("drops OPTIONAL agent edges (the readiness map is requirement-less and hard-fails every entry)", () => {
    const { next } = projectCanonicalEdgesOntoRuntimeDeps([agentEdge("@cinatra-ai/opt-agent", "optional")], {});
    expect(next.agentDependencies).toEqual({});
  });

  it("ignores kind-LESS edges (a legacy-projected manifest keeps its legacy map only)", () => {
    const kindless: Edge = {
      packageName: "@cinatra-ai/legacy-dep",
      edgeType: "runtime",
      versionConstraint: { kind: "semver-range", range: "*" },
      requirement: "required",
    };
    const { next, changed } = projectCanonicalEdgesOntoRuntimeDeps([kindless], {
      agentDependencies: { "@cinatra-ai/legacy-dep": "^0.1.0" },
    });
    expect(changed).toBe(false);
    expect(next.agentDependencies).toEqual({ "@cinatra-ai/legacy-dep": "^0.1.0" });
    expect(next.connectorDependencies).toEqual({});
  });

  it("MERGES onto existing maps and NEVER clears an install-seeded agentDependency (dual-read preserved)", () => {
    const { next } = projectCanonicalEdgesOntoRuntimeDeps(
      [agentEdge("@cinatra-ai/canonical-sub", "required")],
      { agentDependencies: { "@cinatra-ai/legacy-sub": "^1.2.3" } },
    );
    // legacy entry survives; canonical entry added.
    expect(next.agentDependencies).toEqual({
      "@cinatra-ai/legacy-sub": "^1.2.3",
      "@cinatra-ai/canonical-sub": "2.3.4",
    });
  });

  it("is idempotent: re-projecting an already-projected template reports no change", () => {
    const edges = [connectorEdge("@cinatra-ai/c", "required"), agentEdge("@cinatra-ai/a", "required")];
    const first = projectCanonicalEdgesOntoRuntimeDeps(edges, {});
    const second = projectCanonicalEdgesOntoRuntimeDeps(edges, first.next);
    expect(second.changed).toBe(false);
  });
});

describe("runAgentRuntimeDepProjectionBackfill — DI runner", () => {
  const makeDeps = (
    templates: BackfillTemplate[],
    edgesByPkg: Record<string, Edge[]>,
    updateSpy = vi.fn(async () => {}),
  ): RuntimeDepBackfillDeps => ({
    listTemplates: async () => templates,
    readCanonicalEdges: async (pkg) => edgesByPkg[pkg] ?? [],
    updateTemplateDeps: updateSpy,
    log: () => {},
  });

  it("updates a template whose canonical row now carries connector + agent edges", async () => {
    const update = vi.fn(async () => {});
    const res = await runAgentRuntimeDepProjectionBackfill(
      makeDeps(
        [{ id: "tpl-1", packageName: "@cinatra-ai/pkg" }],
        { "@cinatra-ai/pkg": [connectorEdge("@cinatra-ai/wp", "required"), agentEdge("@cinatra-ai/sub", "required")] },
        update,
      ),
    );
    expect(res).toMatchObject({ scanned: 1, updated: 1, unchanged: 0, failed: 0 });
    expect(update).toHaveBeenCalledWith("tpl-1", {
      agentDependencies: { "@cinatra-ai/sub": "2.3.4" },
      connectorDependencies: { "@cinatra-ai/wp": { range: "^1.0.0", requirement: "required" } },
    });
  });

  it("leaves a legacy-only template (no canonical edges) untouched — its seeded agentDependencies still gate", async () => {
    const update = vi.fn(async () => {});
    const res = await runAgentRuntimeDepProjectionBackfill(
      makeDeps(
        [{ id: "tpl-legacy", packageName: "@cinatra-ai/legacy", agentDependencies: { "@cinatra-ai/sub": "^1.0.0" } }],
        { "@cinatra-ai/legacy": [] },
        update,
      ),
    );
    expect(res).toMatchObject({ scanned: 1, updated: 0, unchanged: 1, failed: 0 });
    expect(update).not.toHaveBeenCalled();
  });

  it("does not re-write an already-projected template (idempotent across boots)", async () => {
    const update = vi.fn(async () => {});
    const res = await runAgentRuntimeDepProjectionBackfill(
      makeDeps(
        [
          {
            id: "tpl-done",
            packageName: "@cinatra-ai/pkg",
            connectorDependencies: { "@cinatra-ai/wp": { range: "^1.0.0", requirement: "required" } },
          },
        ],
        { "@cinatra-ai/pkg": [connectorEdge("@cinatra-ai/wp", "required")] },
        update,
      ),
    );
    expect(res).toMatchObject({ updated: 0, unchanged: 1 });
    expect(update).not.toHaveBeenCalled();
  });

  it("soft-fails per template: one bad row is counted failed, the rest still project", async () => {
    const update = vi.fn(async (id: string) => {
      if (id === "bad") throw new Error("db down");
    });
    const res = await runAgentRuntimeDepProjectionBackfill({
      listTemplates: async () => [
        { id: "bad", packageName: "@cinatra-ai/bad" },
        { id: "good", packageName: "@cinatra-ai/good" },
      ],
      readCanonicalEdges: async (pkg) =>
        pkg === "@cinatra-ai/bad"
          ? [agentEdge("@cinatra-ai/x", "required")]
          : [agentEdge("@cinatra-ai/y", "required")],
      updateTemplateDeps: update,
      log: () => {},
    });
    expect(res).toMatchObject({ scanned: 2, updated: 1, failed: 1 });
  });

  it("honors the kill switch", async () => {
    const prev = process.env.CINATRA_AGENT_RUNTIME_DEP_BACKFILL;
    process.env.CINATRA_AGENT_RUNTIME_DEP_BACKFILL = "off";
    try {
      const res = await runAgentRuntimeDepProjectionBackfill(makeDeps([], {}));
      expect(res.skippedReason).toBe("kill-switch");
    } finally {
      if (prev === undefined) delete process.env.CINATRA_AGENT_RUNTIME_DEP_BACKFILL;
      else process.env.CINATRA_AGENT_RUNTIME_DEP_BACKFILL = prev;
    }
  });
});
