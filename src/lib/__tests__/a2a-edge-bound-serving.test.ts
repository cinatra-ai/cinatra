import { describe, it, expect, vi } from "vitest";
import { resolveEdgeBoundServingDecision } from "@/lib/a2a-edge-bound-serving";
import {
  EdgeBoundAgentServingError,
  type EdgeBoundAgentResolution,
} from "@/lib/extension-edge-bound-agent";

// cinatra#1392 Gap 2 — the edge-bound serving BINDING (pure over injected deps).
// Proves it reads the TRUSTED dependent id (never client metadata), maps the S5
// resolver's outcomes EXHAUSTIVELY, and FAILS CLOSED on every anomalous/corrupt
// shape — it never silently falls through to a default serve.

const TARGET = "@cinatra-ai/agent-d";

function bind(
  dependentInstallId: string | undefined,
  resolveImpl: () => Promise<EdgeBoundAgentResolution>,
) {
  return resolveEdgeBoundServingDecision(
    { targetPackageName: TARGET },
    { getDependentInstallId: () => dependentInstallId, resolve: vi.fn(resolveImpl) },
  );
}

describe("resolveEdgeBoundServingDecision", () => {
  it("returns none when there is no trusted dependent id (never consults the resolver)", async () => {
    const resolve = vi.fn();
    const out = await resolveEdgeBoundServingDecision(
      { targetPackageName: TARGET },
      { getDependentInstallId: () => undefined, resolve },
    );
    expect(out).toEqual({ kind: "none" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns none when the dependent has no applicable edge", async () => {
    const out = await bind("iext_dep", async () => ({ resolved: false }));
    expect(out).toEqual({ kind: "none" });
  });

  it("serves the DEFAULT with the resolved install id and no snapshot", async () => {
    const out = await bind("iext_dep", async () => ({
      resolved: true,
      version: "0.2.0",
      isDefault: true,
      resolvedInstallId: "iext_def",
    }));
    expect(out).toEqual({ kind: "serve", targetInstallId: "iext_def" });
  });

  it("serves a NON-DEFAULT resolved version by pinning its snapshot + version", async () => {
    const out = await bind("iext_dep", async () => ({
      resolved: true,
      version: "0.1.4",
      isDefault: false,
      resolvedInstallId: "iext_sib",
      snapshotId: "snap-1",
    }));
    expect(out).toEqual({
      kind: "serve",
      targetInstallId: "iext_sib",
      snapshotId: "snap-1",
      version: "0.1.4",
    });
  });

  it("REFUSES with evidence when the resolver throws (unreachable non-default pin)", async () => {
    const err = new EdgeBoundAgentServingError({
      dependentInstallId: "iext_dep",
      targetPackageName: TARGET,
      resolvedInstallId: "iext_sib",
      resolvedVersion: "0.1.4",
    });
    const out = await bind("iext_dep", async () => {
      throw err;
    });
    expect(out).toEqual({
      kind: "refuse",
      code: "EDGE_BOUND_AGENT_UNREACHABLE",
      message: err.message,
    });
  });

  it("REFUSES (never serves default) when a resolved result is missing its install id", async () => {
    const out = await bind(
      "iext_dep",
      async () =>
        ({ resolved: true, version: "0.2.0", isDefault: true }) as unknown as EdgeBoundAgentResolution,
    );
    expect(out).toMatchObject({ kind: "refuse", code: "EDGE_BOUND_IDENTITY_MISSING" });
  });

  it("REFUSES (never serves default) for a non-default result with no snapshot", async () => {
    const out = await bind(
      "iext_dep",
      async () =>
        ({
          resolved: true,
          version: "0.1.4",
          isDefault: false,
          resolvedInstallId: "iext_sib",
        }) as EdgeBoundAgentResolution,
    );
    expect(out).toMatchObject({ kind: "refuse", code: "EDGE_BOUND_AGENT_UNREACHABLE" });
  });

  it("RETHROWS an unexpected resolver error (fail closed — the executor refuses the run)", async () => {
    await expect(
      bind("iext_dep", async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");
  });
});
