/**
 * Run-context precedence for one MCP request (#1195) —
 * resolveRequestRunContext in request-context.ts.
 *
 * The pure contract the transport handler (index.tsx) delegates to:
 *   obo > durable-resolved > registry > header, with a durable "invalid"
 * outcome suppressing BOTH legacy channels entirely (run id AND provenance)
 * while the signed OBO channel survives it.
 *
 * Plus the fail-closed cutover posture (`failClosed`, dormant until the flip
 * slice): a run id that ONLY a legacy/forgeable channel could supply is
 * REFUSED (`denied` + `deniedChannel`) rather than tagged, while verified
 * channels (obo/durable) are never denied. Denial is orthogonal to the
 * durable-"invalid" suppression.
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

  it("denied defaults to false on every non-failClosed path", () => {
    for (const r of [
      resolveRequestRunContext({ delegatedRunId: "run-obo" }),
      resolveRequestRunContext({ durable: DURABLE_RESOLVED }),
      resolveRequestRunContext({ durable: { outcome: "absent" }, registryCtx: REGISTRY }),
      resolveRequestRunContext({ durable: { outcome: "invalid" }, registryCtx: REGISTRY }),
      resolveRequestRunContext({}),
    ]) {
      expect(r.denied).toBe(false);
      expect(r.deniedChannel).toBeUndefined();
    }
  });
});

describe("resolveRequestRunContext fail-closed cutover denial", () => {
  it("failClosed=false is byte-identical to the transition default (registry serves)", () => {
    const r = resolveRequestRunContext({
      failClosed: false,
      durable: { outcome: "absent" },
      registryCtx: REGISTRY,
      headerRunId: "run-header",
    });
    expect(r.runId).toBe("run-registry");
    expect(r.servedBy).toBe("registry");
    expect(r.denied).toBe(false);
    expect(r.deniedChannel).toBeUndefined();
  });

  it("REFUSES a registry-only run id — run id AND provenance dropped as a unit", () => {
    const r = resolveRequestRunContext({
      failClosed: true,
      durable: { outcome: "absent" },
      registryCtx: REGISTRY,
    });
    expect(r.runId).toBeUndefined();
    expect(r.agentId).toBeUndefined();
    expect(r.packageVersion).toBeUndefined();
    expect(r.agentSpecVersion).toBeUndefined();
    expect(r.servedBy).toBe("none");
    expect(r.denied).toBe(true);
    expect(r.deniedChannel).toBe("registry");
  });

  it("REFUSES a header-only run id (deniedChannel=header)", () => {
    const r = resolveRequestRunContext({
      failClosed: true,
      durable: { outcome: "absent" },
      headerRunId: "run-header",
      headerAgentId: "agent-header",
      headerPackageVersion: "0.9.0",
      headerAgentSpecVersion: "1",
    });
    expect(r.runId).toBeUndefined();
    expect(r.agentId).toBeUndefined();
    expect(r.servedBy).toBe("none");
    expect(r.denied).toBe(true);
    expect(r.deniedChannel).toBe("header");
  });

  it("registry outranks header for the denied channel when both are present", () => {
    const r = resolveRequestRunContext({
      failClosed: true,
      registryCtx: REGISTRY,
      headerRunId: "run-header",
    });
    expect(r.denied).toBe(true);
    expect(r.deniedChannel).toBe("registry");
    expect(r.servedBy).toBe("none");
  });

  it("NEVER denies the verified OBO channel (survives failClosed, legacy present)", () => {
    const r = resolveRequestRunContext({
      failClosed: true,
      delegatedRunId: "run-obo",
      durable: { outcome: "absent" },
      registryCtx: REGISTRY,
      headerRunId: "run-header",
    });
    expect(r.runId).toBe("run-obo");
    expect(r.servedBy).toBe("obo");
    expect(r.denied).toBe(false);
    expect(r.deniedChannel).toBeUndefined();
  });

  it("NEVER denies the verified durable channel (legacy provenance still falls through since not denied)", () => {
    const r = resolveRequestRunContext({
      failClosed: true,
      durable: { outcome: "resolved", ctx: { runId: "run-durable" } },
      registryCtx: REGISTRY,
      headerRunId: "run-header",
    });
    expect(r.runId).toBe("run-durable");
    expect(r.servedBy).toBe("durable");
    expect(r.denied).toBe(false);
    // Not denied ⇒ untrusted provenance still fills per-field from registry.
    expect(r.agentId).toBe("agent-registry");
    expect(r.packageVersion).toBe("1.0.0");
  });

  it("ORTHOGONAL to suppression: durable INVALID already dropped legacy ⇒ suppressed, NOT denied", () => {
    const r = resolveRequestRunContext({
      failClosed: true,
      durable: { outcome: "invalid" },
      registryCtx: REGISTRY,
      headerRunId: "run-header",
    });
    expect(r.runId).toBeUndefined();
    expect(r.servedBy).toBe("none");
    expect(r.suppressed).toBe(true);
    // Suppression, not denial: there was no legacy channel left to refuse.
    expect(r.denied).toBe(false);
    expect(r.deniedChannel).toBeUndefined();
  });

  it("failClosed with no run id anywhere ⇒ none, not denied (nothing to refuse)", () => {
    const r = resolveRequestRunContext({ failClosed: true });
    expect(r.runId).toBeUndefined();
    expect(r.servedBy).toBe("none");
    expect(r.denied).toBe(false);
  });

  it("an EMPTY-string verified id is not a verified identity — it cannot shield a legacy channel from denial", () => {
    // A degenerate delegatedRunId "" must NOT read as a present OBO id and let
    // the registry run id ride through under failClosed.
    const r = resolveRequestRunContext({
      failClosed: true,
      delegatedRunId: "",
      registryCtx: REGISTRY,
    });
    expect(r.runId).toBeUndefined();
    expect(r.servedBy).toBe("none");
    expect(r.denied).toBe(true);
    expect(r.deniedChannel).toBe("registry");
  });

  it("an EMPTY durable resolved run id is treated as absent (denies the legacy channel under failClosed)", () => {
    const r = resolveRequestRunContext({
      failClosed: true,
      durable: { outcome: "resolved", ctx: { runId: "" } },
      headerRunId: "run-header",
    });
    expect(r.runId).toBeUndefined();
    expect(r.denied).toBe(true);
    expect(r.deniedChannel).toBe("header");
  });
});

describe("resolveRequestRunContext empty-verified-id normalization (default path)", () => {
  it("empty delegated id does not become the run id; legacy still serves when not failClosed", () => {
    const r = resolveRequestRunContext({
      delegatedRunId: "",
      durable: { outcome: "absent" },
      registryCtx: REGISTRY,
    });
    expect(r.runId).toBe("run-registry");
    expect(r.servedBy).toBe("registry");
    expect(r.denied).toBe(false);
  });
});
