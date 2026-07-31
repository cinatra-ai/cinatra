/**
 * Run-context precedence for one MCP request (#1195) —
 * resolveRequestRunContext in request-context.ts.
 *
 * POST-RETIREMENT CONTRACT. The in-process registry channel is DELETED (module,
 * shared-clientId fallback key, and the `getRunContext` transport wiring), so
 * the precedence is now:
 *
 *   obo > durable-resolved > header
 *
 * with a durable "invalid" outcome suppressing the header channel entirely (run
 * id AND provenance) while the signed OBO channel survives it.
 *
 * Plus the fail-closed cutover posture (`failClosed`), which production wiring
 * now passes as TRUE: a run id that ONLY the legacy/forgeable header channel
 * could supply is REFUSED (`denied` + `deniedChannel`) rather than tagged, while
 * verified channels (obo/durable) are never denied. Suppression and denial
 * COMPOSE — a header claim that durable-"invalid" already dropped is still a
 * claim and is still refused, because serving it with the id merely dropped
 * would persist an unattributed run-scoped write. The transport's paired
 * ENFORCEMENT of `denied` (refusing the request outright) is covered in
 * run-context-denied-response.test.ts — this suite pins the pure decision.
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
const HEADERS = {
  headerRunId: "run-header",
  headerAgentId: "agent-header",
  headerPackageVersion: "0.9.0",
  headerAgentSpecVersion: "1",
};

describe("resolveRequestRunContext precedence", () => {
  it("delegated agent-run OBO wins over every other channel", () => {
    const r = resolveRequestRunContext({
      delegatedRunId: "run-obo",
      durable: DURABLE_RESOLVED,
      ...HEADERS,
    });
    expect(r.runId).toBe("run-obo");
    expect(r.servedBy).toBe("obo");
    expect(r.suppressed).toBe(false);
  });

  it("durable resolved beats the header channel", () => {
    const r = resolveRequestRunContext({
      durable: DURABLE_RESOLVED,
      ...HEADERS,
    });
    expect(r.runId).toBe("run-durable");
    expect(r.agentId).toBe("agent-durable");
    expect(r.packageVersion).toBe("2.0.0");
    expect(r.agentSpecVersion).toBe("9");
    expect(r.servedBy).toBe("durable");
  });

  it("durable resolved with missing provenance falls through per-field to the headers", () => {
    const r = resolveRequestRunContext({
      durable: { outcome: "resolved", ctx: { runId: "run-durable" } },
      ...HEADERS,
    });
    expect(r.runId).toBe("run-durable");
    expect(r.servedBy).toBe("durable");
    // Provenance is untrusted tagging metadata on every channel.
    expect(r.agentId).toBe("agent-header");
    expect(r.packageVersion).toBe("0.9.0");
  });

  it("durable absent falls back to the x-cinatra-* headers (when not failClosed)", () => {
    const r = resolveRequestRunContext({
      durable: { outcome: "absent" },
      ...HEADERS,
    });
    expect(r.runId).toBe("run-header");
    expect(r.agentId).toBe("agent-header");
    expect(r.servedBy).toBe("header");
    expect(r.suppressed).toBe(false);
  });

  it("no durable consult at all (delegated request / no bearer) behaves like absent", () => {
    const r = resolveRequestRunContext({ ...HEADERS });
    expect(r.runId).toBe("run-header");
    expect(r.servedBy).toBe("header");
  });

  it("FAIL CLOSED: durable INVALID suppresses the header channel — run id and ALL provenance", () => {
    const r = resolveRequestRunContext({
      durable: { outcome: "invalid" },
      ...HEADERS,
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
      resolveRequestRunContext({ durable: { outcome: "absent" }, ...HEADERS }),
      resolveRequestRunContext({ durable: { outcome: "invalid" }, ...HEADERS }),
      resolveRequestRunContext({}),
    ]) {
      expect(r.denied).toBe(false);
      expect(r.deniedChannel).toBeUndefined();
    }
  });

  it("RETIRED CHANNEL: `registry` is not a servedBy value on any input shape", () => {
    // The in-process registry is deleted; nothing can produce it any more.
    for (const r of [
      resolveRequestRunContext({ delegatedRunId: "run-obo" }),
      resolveRequestRunContext({ durable: DURABLE_RESOLVED }),
      resolveRequestRunContext({ durable: { outcome: "absent" }, ...HEADERS }),
      resolveRequestRunContext({ durable: { outcome: "invalid" }, ...HEADERS }),
      resolveRequestRunContext({ failClosed: true, ...HEADERS }),
      resolveRequestRunContext({}),
    ]) {
      // Cast through string: "registry" is no longer in either union, so a
      // direct comparison would not even typecheck — which is itself the point.
      expect(r.servedBy as string).not.toBe("registry");
      expect(r.deniedChannel as string | undefined).not.toBe("registry");
    }
  });
});

describe("resolveRequestRunContext fail-closed cutover denial", () => {
  it("failClosed=false keeps the transitional behavior (the header channel serves)", () => {
    const r = resolveRequestRunContext({
      failClosed: false,
      durable: { outcome: "absent" },
      ...HEADERS,
    });
    expect(r.runId).toBe("run-header");
    expect(r.servedBy).toBe("header");
    expect(r.denied).toBe(false);
    expect(r.deniedChannel).toBeUndefined();
  });

  it("REFUSES a header-only run id — run id AND provenance dropped as a unit", () => {
    const r = resolveRequestRunContext({
      failClosed: true,
      durable: { outcome: "absent" },
      ...HEADERS,
    });
    expect(r.runId).toBeUndefined();
    expect(r.agentId).toBeUndefined();
    expect(r.packageVersion).toBeUndefined();
    expect(r.agentSpecVersion).toBeUndefined();
    expect(r.servedBy).toBe("none");
    expect(r.denied).toBe(true);
    expect(r.deniedChannel).toBe("header");
  });

  it("REFUSES a header-only run id even with no durable consult at all", () => {
    const r = resolveRequestRunContext({ failClosed: true, ...HEADERS });
    expect(r.runId).toBeUndefined();
    expect(r.servedBy).toBe("none");
    expect(r.denied).toBe(true);
    expect(r.deniedChannel).toBe("header");
  });

  it("NEVER denies the verified OBO channel (survives failClosed, legacy header present)", () => {
    const r = resolveRequestRunContext({
      failClosed: true,
      delegatedRunId: "run-obo",
      durable: { outcome: "absent" },
      ...HEADERS,
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
      ...HEADERS,
    });
    expect(r.runId).toBe("run-durable");
    expect(r.servedBy).toBe("durable");
    expect(r.denied).toBe(false);
    // Not denied ⇒ untrusted provenance still fills per-field from the headers.
    expect(r.agentId).toBe("agent-header");
    expect(r.packageVersion).toBe("0.9.0");
  });

  it("SUPPRESSION AND DENIAL COMPOSE: a durable-INVALID request that ALSO claimed a header run id is BOTH suppressed and denied", () => {
    // Regression lock for the codex round-1 fail-OPEN finding. Computing the
    // legacy claim from the POST-suppression value made this case
    // suppressed-but-not-denied, so the transport served it with the run id
    // merely dropped — an UNATTRIBUTED run-scoped write off a request that did
    // claim run identity through the retired channel. A suppressed claim is
    // still a claim and must be REFUSED.
    const r = resolveRequestRunContext({
      failClosed: true,
      durable: { outcome: "invalid" },
      ...HEADERS,
    });
    expect(r.runId).toBeUndefined();
    expect(r.servedBy).toBe("none");
    expect(r.suppressed).toBe(true);
    expect(r.denied).toBe(true);
    expect(r.deniedChannel).toBe("header");
  });

  it("durable INVALID with NO legacy claim is suppressed but NOT denied — the request is served without run attribution", () => {
    // The availability boundary of the posture, stated explicitly: a request
    // that never claimed a run id is not refused just because its durable
    // binding went stale. An unattributed write is never a misattributed one.
    const r = resolveRequestRunContext({
      failClosed: true,
      durable: { outcome: "invalid" },
    });
    expect(r.runId).toBeUndefined();
    expect(r.suppressed).toBe(true);
    expect(r.denied).toBe(false);
  });

  it("durable INVALID + a header claim does NOT deny a verified OBO caller", () => {
    const r = resolveRequestRunContext({
      failClosed: true,
      delegatedRunId: "run-obo",
      durable: { outcome: "invalid" },
      ...HEADERS,
    });
    expect(r.runId).toBe("run-obo");
    expect(r.servedBy).toBe("obo");
    expect(r.suppressed).toBe(true);
    expect(r.denied).toBe(false);
  });

  it("failClosed with no run id anywhere ⇒ none, not denied (nothing to refuse)", () => {
    const r = resolveRequestRunContext({ failClosed: true });
    expect(r.runId).toBeUndefined();
    expect(r.servedBy).toBe("none");
    expect(r.denied).toBe(false);
  });

  it("an EMPTY-string verified id is not a verified identity — it cannot shield the legacy channel from denial", () => {
    // A degenerate delegatedRunId "" must NOT read as a present OBO id and let
    // the header run id ride through under failClosed.
    const r = resolveRequestRunContext({
      failClosed: true,
      delegatedRunId: "",
      ...HEADERS,
    });
    expect(r.runId).toBeUndefined();
    expect(r.servedBy).toBe("none");
    expect(r.denied).toBe(true);
    expect(r.deniedChannel).toBe("header");
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

  it("a request carrying only legacy PROVENANCE headers (no run id) is not denied — there is no run id to refuse", () => {
    const r = resolveRequestRunContext({
      failClosed: true,
      headerAgentId: "agent-header",
      headerPackageVersion: "0.9.0",
    });
    expect(r.runId).toBeUndefined();
    expect(r.denied).toBe(false);
    expect(r.servedBy).toBe("none");
    // Provenance without a run id is inert tagging metadata, never authz input.
    expect(r.agentId).toBe("agent-header");
  });
});

describe("resolveRequestRunContext empty-verified-id normalization (default path)", () => {
  it("empty delegated id does not become the run id; the header still serves when not failClosed", () => {
    const r = resolveRequestRunContext({
      delegatedRunId: "",
      durable: { outcome: "absent" },
      ...HEADERS,
    });
    expect(r.runId).toBe("run-header");
    expect(r.servedBy).toBe("header");
    expect(r.denied).toBe(false);
  });
});
