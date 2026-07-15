// #1193 run-token spine (W2) — context-route token-first run resolution.
//
// deriveContextRouteContext resolves "which run is calling" with a fail-closed
// precedence: (a) the dispatch-minted per-run token (x-cinatra-run-token) is the
// STRONGEST binding and admits NO body/context-id fallback when present; (b) the
// legacy a2a-context-id header; (c) the legacy body id. This suite pins the
// token branch's fail-closed cases (the security-critical ones) plus the
// which-path selection. The real verifyRunToken (a pure unique-index probe) runs
// against a mocked lookup; the rest of the IO chain is mocked so only the
// run-resolution precedence is under test.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const readAgentRunByTokenHash = vi.fn();
const readAgentRunById = vi.fn();
const readAgentRunByContextId = vi.fn();
const readAgentTemplateById = vi.fn();

vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunByTokenHash: (...a: unknown[]) => readAgentRunByTokenHash(...a),
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentRunByContextId: (...a: unknown[]) => readAgentRunByContextId(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
}));
vi.mock("@cinatra-ai/agents/agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => "/tmp/does-not-exist",
}));
vi.mock("@/lib/wayflow-bridge-auth", () => ({
  isAuthorizedBridgeRequest: () => true,
}));
vi.mock("@/lib/a2a-auth", () => ({
  verifyLangGraphBridgeToken: () => ({ ok: true }),
}));
const resolveAgentRunMcpActor = vi.fn();
vi.mock("@/lib/agent-run-actor-resolve", () => ({
  resolveAgentRunMcpActor: (...a: unknown[]) => resolveAgentRunMcpActor(...a),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readOrganizationNameForUser: vi.fn(async () => null),
  listOrganizationsForUser: vi.fn(async () => []),
  readTeamsForUser: async () => [],
  readProjectGrantsForUser: async () => [],
}));
vi.mock("@cinatra-ai/mcp-server/obo-ceiling", () => ({
  deriveOboCeilingChain: () => null,
  oboCeilingContains: () => false,
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  buildActorContextFromPrimitive: () => ({ sub: "user-1", organizationId: "org-1" }),
}));
vi.mock("../context-mcp", () => ({ getInstalledExtensionDescriptors: () => [] }));
vi.mock("../context-resolver", () => ({ resolveContextSlot: () => [] }));

const { deriveContextRouteContext } = await import("../context-route-io");
const { ContextRouteError } = await import("../context-route-support");

const PKG = "@cinatra-ai/blog-draft-writer-agent";

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/context-resolve", {
    method: "POST",
    headers,
  });
}

function fullRun(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    orgId: "org-1",
    runBy: "user-1",
    templateId: "tmpl-1",
    projectId: null,
    oboCeiling: null,
    ...over,
  } as unknown as Parameters<typeof readAgentRunById.mockResolvedValue>[0];
}

function leafBody(over: Record<string, unknown> = {}) {
  return {
    parentRunId: "run-1",
    parentPackageName: PKG, // == run package ⇒ no composed-child attestation
    slotId: "draftContext",
    ...over,
  };
}

async function expectStatus(p: Promise<unknown>, status: number, code?: string) {
  await p.then(
    () => {
      throw new Error("expected ContextRouteError, got success");
    },
    (e: unknown) => {
      expect(e).toBeInstanceOf(ContextRouteError);
      const err = e as InstanceType<typeof ContextRouteError>;
      expect(err.status).toBe(status);
      if (code) expect(err.code).toBe(code);
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  readAgentTemplateById.mockResolvedValue({
    packageName: PKG,
    ownerLevel: null,
    ownerId: null,
  });
  resolveAgentRunMcpActor.mockResolvedValue({ platformRole: "member" });
});

describe("deriveContextRouteContext — run-token precedence (#1193 W2)", () => {
  it("present-but-unresolvable token ⇒ 403 run_token_unresolvable, NO fallback", async () => {
    readAgentRunByTokenHash.mockResolvedValue(null);
    await expectStatus(
      deriveContextRouteContext(
        req({ "x-cinatra-run-token": "no-match", "x-cinatra-a2a-context-id": "ctx-1" }),
        leafBody(),
        "resolve",
      ),
      403,
      "run_token_unresolvable",
    );
    // Fail-closed: never consulted the context-id or the body id.
    expect(readAgentRunByContextId).not.toHaveBeenCalled();
    expect(readAgentRunById).not.toHaveBeenCalled();
  });

  it("empty token header ⇒ 403 (absent), NO fallback", async () => {
    await expectStatus(
      deriveContextRouteContext(req({ "x-cinatra-run-token": "" }), leafBody(), "resolve"),
      403,
      "run_token_unresolvable",
    );
    expect(readAgentRunByTokenHash).not.toHaveBeenCalled(); // verifier short-circuits on empty
  });

  it("token resolves but the full re-read is missing ⇒ 403 run_token_divergent", async () => {
    readAgentRunByTokenHash.mockResolvedValue({ id: "run-1", orgId: "org-1", runBy: "user-1" });
    readAgentRunById.mockResolvedValue(null);
    await expectStatus(
      deriveContextRouteContext(req({ "x-cinatra-run-token": "t" }), leafBody(), "resolve"),
      403,
      "run_token_divergent",
    );
  });

  it("token resolves but the re-read diverges on orgId ⇒ 403 run_token_divergent", async () => {
    readAgentRunByTokenHash.mockResolvedValue({ id: "run-1", orgId: "org-1", runBy: "user-1" });
    readAgentRunById.mockResolvedValue(fullRun({ orgId: "org-EVIL" }));
    await expectStatus(
      deriveContextRouteContext(req({ "x-cinatra-run-token": "t" }), leafBody(), "resolve"),
      403,
      "run_token_divergent",
    );
  });

  it("token run + a disagreeing context-id header ⇒ 403 run_mismatch", async () => {
    readAgentRunByTokenHash.mockResolvedValue({ id: "run-1", orgId: "org-1", runBy: "user-1" });
    readAgentRunById.mockResolvedValue(fullRun());
    readAgentRunByContextId.mockResolvedValue({ id: "run-OTHER" });
    await expectStatus(
      deriveContextRouteContext(
        req({ "x-cinatra-run-token": "t", "x-cinatra-a2a-context-id": "ctx-x" }),
        leafBody(),
        "resolve",
      ),
      403,
      "run_mismatch",
    );
  });

  it("token run + a disagreeing body parentRunId ⇒ 403 run_mismatch (body never selects)", async () => {
    readAgentRunByTokenHash.mockResolvedValue({ id: "run-1", orgId: "org-1", runBy: "user-1" });
    readAgentRunById.mockResolvedValue(fullRun());
    await expectStatus(
      deriveContextRouteContext(
        req({ "x-cinatra-run-token": "t" }),
        leafBody({ parentRunId: "victim-run" }),
        "resolve",
      ),
      403,
      "run_mismatch",
    );
  });

  it("leaf happy path: token resolves, re-read matches ⇒ returns the run (served via run_token)", async () => {
    readAgentRunByTokenHash.mockResolvedValue({ id: "run-1", orgId: "org-1", runBy: "user-1" });
    readAgentRunById.mockResolvedValue(fullRun());
    const res = await deriveContextRouteContext(
      req({ "x-cinatra-run-token": "t" }),
      leafBody(),
      "resolve",
    );
    expect(res.run.id).toBe("run-1");
    expect(res.trustedPackageName).toBe(PKG);
    expect(res.servedBy).toBe("run_token");
    // The run was selected from the token — the id was NEVER read from the body.
    expect(readAgentRunById).toHaveBeenCalledWith("run-1");
  });

  it("no token header ⇒ legacy context-id path still serves (additive, reversible)", async () => {
    readAgentRunByContextId.mockResolvedValue(fullRun());
    const res = await deriveContextRouteContext(
      req({ "x-cinatra-a2a-context-id": "ctx-1" }),
      leafBody(),
      "resolve",
    );
    expect(res.run.id).toBe("run-1");
    expect(res.servedBy).toBe("context_id");
    expect(readAgentRunByTokenHash).not.toHaveBeenCalled();
    expect(readAgentRunByContextId).toHaveBeenCalledWith("ctx-1");
  });

  // #1197: the which-path-served metric is now a per-(kind, via) COUNTER (the
  // W3 legacy-removal gate input), not only a log line.
  it("which-path metric: each served path bumps its per-(kind, via) counter", async () => {
    const { getContextRouteCounterSnapshot, resetContextRouteCountersForTest } =
      await import("../context-route-observability");
    resetContextRouteCountersForTest();

    // (a) token-served
    readAgentRunByTokenHash.mockResolvedValue({ id: "run-1", orgId: "org-1", runBy: "user-1" });
    readAgentRunById.mockResolvedValue(fullRun());
    await deriveContextRouteContext(req({ "x-cinatra-run-token": "t" }), leafBody(), "resolve");
    // (b) legacy context-id-served
    readAgentRunByContextId.mockResolvedValue(fullRun());
    await deriveContextRouteContext(
      req({ "x-cinatra-a2a-context-id": "ctx-1" }),
      leafBody(),
      "resolve",
    );
    // (c) legacy body-served (dev loopback)
    await deriveContextRouteContext(req({}), leafBody(), "resolve");

    expect(getContextRouteCounterSnapshot().resolutionPath).toEqual({
      "resolve.run_token": 1,
      "resolve.context_id": 1,
      "resolve.body": 1,
    });
  });
});
