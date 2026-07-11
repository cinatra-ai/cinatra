/**
 * Run-context precedence for one MCP request (#1195, first slice) —
 * resolveRequestRunContext in request-context.ts.
 *
 * The pure contract the transport handler (index.tsx) delegates to:
 *   obo > durable-resolved > registry > header, with a durable "invalid"
 * outcome suppressing BOTH legacy channels entirely (run id AND provenance)
 * while the signed OBO channel survives it.
 */
import { describe, it, expect } from "vitest";

import { resolveRequestRunContext } from "../request-context";

const DURABLE_RESOLVED = {
  outcome: "resolved" as const,
  ctx: {
    runId: "run-durable",
    agentId: "agent-durable",
    packageVersion: "2.0.0",
    agentSpecVersion: "9",
  },
};
const REGISTRY = {
  runId: "run-registry",
  agentId: "agent-registry",
  packageVersion: "1.0.0",
  agentSpecVersion: "3",
};

describe("resolveRequestRunContext precedence", () => {
  it("delegated agent-run OBO wins over every other channel", () => {
    const r = resolveRequestRunContext({
      delegatedRunId: "run-obo",
      durable: DURABLE_RESOLVED,
      registryCtx: REGISTRY,
      headerRunId: "run-header",
    });
    expect(r.runId).toBe("run-obo");
    expect(r.servedBy).toBe("obo");
    expect(r.suppressed).toBe(false);
  });

  it("durable resolved beats registry and header", () => {
    const r = resolveRequestRunContext({
      durable: DURABLE_RESOLVED,
      registryCtx: REGISTRY,
      headerRunId: "run-header",
    });
    expect(r.runId).toBe("run-durable");
    expect(r.agentId).toBe("agent-durable");
    expect(r.packageVersion).toBe("2.0.0");
    expect(r.agentSpecVersion).toBe("9");
    expect(r.servedBy).toBe("durable");
  });

  it("durable resolved with missing provenance falls through per-field to registry", () => {
    const r = resolveRequestRunContext({
      durable: { outcome: "resolved", ctx: { runId: "run-durable" } },
      registryCtx: REGISTRY,
    });
    expect(r.runId).toBe("run-durable");
    expect(r.servedBy).toBe("durable");
    // Provenance is untrusted tagging metadata on every channel.
    expect(r.agentId).toBe("agent-registry");
    expect(r.packageVersion).toBe("1.0.0");
  });

  it("durable absent falls back to the registry (transition path)", () => {
    const r = resolveRequestRunContext({
      durable: { outcome: "absent" },
      registryCtx: REGISTRY,
      headerRunId: "run-header",
    });
    expect(r.runId).toBe("run-registry");
    expect(r.servedBy).toBe("registry");
    expect(r.suppressed).toBe(false);
  });

  it("no durable consult at all (delegated request / no bearer) behaves like absent", () => {
    const r = resolveRequestRunContext({ registryCtx: REGISTRY });
    expect(r.runId).toBe("run-registry");
    expect(r.servedBy).toBe("registry");
  });

  it("registry empty falls back to the x-cinatra-* headers", () => {
    const r = resolveRequestRunContext({
      durable: { outcome: "absent" },
      headerRunId: "run-header",
      headerAgentId: "agent-header",
      headerPackageVersion: "0.9.0",
      headerAgentSpecVersion: "1",
    });
    expect(r.runId).toBe("run-header");
    expect(r.agentId).toBe("agent-header");
    expect(r.servedBy).toBe("header");
  });

  it("FAIL CLOSED: durable INVALID suppresses registry AND header — run id and ALL provenance", () => {
    const r = resolveRequestRunContext({
      durable: { outcome: "invalid" },
      registryCtx: REGISTRY,
      headerRunId: "run-header",
      headerAgentId: "agent-header",
      headerPackageVersion: "0.9.0",
      headerAgentSpecVersion: "1",
    });
    expect(r.runId).toBeUndefined();
    expect(r.agentId).toBeUndefined();
    expect(r.packageVersion).toBeUndefined();
    expect(r.agentSpecVersion).toBeUndefined();
    expect(r.servedBy).toBe("none");
    expect(r.suppressed).toBe(true);
  });

  it("durable INVALID does not dethrone the signed OBO channel (but still suppresses legacy provenance)", () => {
    const r = resolveRequestRunContext({
      delegatedRunId: "run-obo",
      durable: { outcome: "invalid" },
      registryCtx: REGISTRY,
      headerAgentId: "agent-header",
    });
    expect(r.runId).toBe("run-obo");
    expect(r.servedBy).toBe("obo");
    expect(r.suppressed).toBe(true);
    expect(r.agentId).toBeUndefined();
  });

  it("nothing anywhere ⇒ none", () => {
    const r = resolveRequestRunContext({});
    expect(r.runId).toBeUndefined();
    expect(r.servedBy).toBe("none");
    expect(r.suppressed).toBe(false);
  });
});
