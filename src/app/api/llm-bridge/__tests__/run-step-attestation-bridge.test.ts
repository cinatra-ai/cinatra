/**
 * cinatra#3745 — the model bridge carries the verified step of the calling
 * model step into the run's on-behalf-of token (`verifiedStepId`) and into the
 * durable binding (`stepId`).
 *
 * The step comes only from the runtime's signed pair (`X-Cinatra-Step-Node` +
 * `X-Cinatra-Step-Attestation`), verified with the runtime's key over the
 * context id that the run token and the context-id header agree on. A call
 * without source headers and without a valid `s1` pair is served exactly as
 * before and carries no step.
 *
 * A call whose run token resolved a run and that carries any source header must
 * carry a source-bound `s2` pair that verifies over the step, the execution
 * attempt its task was sent under and the three source digests, with the
 * context-id header naming that run, and the run store must prove the run is
 * bound to that source under that attempt, its running one; the
 * step is then the proof's. Otherwise the call is refused (403
 * `run_source_mismatch`, a fixed sentence) before any model call. A call with
 * source headers and no resolved run (no run token, or a run token that resolves
 * no run) is refused the same way, as on the passthrough road.
 * The module doubles follow run-token-mcp-actor.test.ts; the route, the run
 * token verifier and the step verifiers are real; the run store's source check
 * is a double (its refusals are pinned in packages/agents).
 *
 * A source-bound call gets the cinatra tool only through the on-behalf-of
 * token, which carries the proof itself. It never gets a machine bearer: that
 * bearer outlives its durable binding, and once the binding is cleared or
 * expires the tool server reads the bearer as an ordinary caller without the
 * proof. So when the on-behalf-of road is unavailable the tool is withheld,
 * and no machine bearer is minted or bound. A call without a verified source
 * keeps the best-effort machine fallback.
 */
import { afterAll, describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

type LlmProviderId = "openai" | "anthropic" | "gemini";

const {
  runResolvedSkillAwareDeterministicLlmTaskMock,
  resolveProviderAdapterMock,
  resolveConfiguredLlmRuntimeMock,
  getLlmMcpCredentialsMock,
  buildLlmMcpServerToolForAgentRunMock,
  buildLlmMcpServerToolMock,
  readAgentRunTokenHashByIdMock,
  writeDurableRunContextBindingMock,
  clearDurableRunContextBindingsMock,
  readAgentRunByContextIdMock,
  readAgentRunByTokenHashMock,
  readAgentRunByIdMock,
  readAgentTemplateByIdMock,
  resolveAgentRunMcpActorMock,
  issueAgentRunMcpActorTokenMock,
  verifyRunExecutedSourceMock,
} = vi.hoisted(() => ({
  runResolvedSkillAwareDeterministicLlmTaskMock: vi.fn<
    (input: Record<string, unknown>) => Promise<{ text: string; artifacts: unknown[] }>
  >(async () => ({ text: "ok", artifacts: [] })),
  resolveProviderAdapterMock: vi.fn(
    async (provider: LlmProviderId): Promise<{ provider: LlmProviderId } | null> => ({
      provider,
    }),
  ),
  resolveConfiguredLlmRuntimeMock: vi.fn(async () => ({
    provider: "openai" as LlmProviderId,
  })),
  getLlmMcpCredentialsMock: vi.fn(
    (): { clientId: string; clientSecret: string } | null => null,
  ),
  buildLlmMcpServerToolForAgentRunMock: vi.fn(() => ({ type: "mcp-tool" })),
  buildLlmMcpServerToolMock: vi.fn(
    async (): Promise<{ type: string; headers?: { Authorization?: string } } | null> => ({
      type: "mcp",
      headers: { Authorization: "Bearer machine-token-abc" },
    }),
  ),
  readAgentRunTokenHashByIdMock: vi.fn(async (): Promise<string | null> => null),
  writeDurableRunContextBindingMock: vi.fn(
    async (): Promise<string | null> => "cinatra:run-ctx:v1:test-key",
  ),
  clearDurableRunContextBindingsMock: vi.fn(async () => {}),
  readAgentRunByContextIdMock: vi.fn(),
  readAgentRunByTokenHashMock: vi.fn(
    async (): Promise<{
      id: string;
      orgId: string;
      runBy: string | null;
    } | null> => null,
  ),
  readAgentRunByIdMock: vi.fn(),
  readAgentTemplateByIdMock: vi.fn(),
  resolveAgentRunMcpActorMock: vi.fn(),
  issueAgentRunMcpActorTokenMock: vi.fn(() => "obo-token"),
  verifyRunExecutedSourceMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/llm", () => ({
  runResolvedSkillAwareDeterministicLlmTask:
    runResolvedSkillAwareDeterministicLlmTaskMock,
  resolveProviderAdapter: resolveProviderAdapterMock,
  resolveConfiguredLlmRuntime: resolveConfiguredLlmRuntimeMock,
  getLlmMcpCredentials: getLlmMcpCredentialsMock,
  buildLlmMcpServerToolForAgentRun: buildLlmMcpServerToolForAgentRunMock,
  buildLlmMcpServerTool: buildLlmMcpServerToolMock,
  createLocalSkillShellTool: vi.fn(() => null),
  openAiModelSupportsShell: (modelId: string) =>
    modelId !== "gpt-5" && modelId !== "gpt-5-mini",
  PreferredProviderUnavailableError: class extends Error {},
  uploadFile: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  verifyRunExecutedSource: verifyRunExecutedSourceMock,
}));
vi.mock("@/lib/agent-run-context-durable", () => ({
  writeDurableRunContextBinding: writeDurableRunContextBindingMock,
  clearDurableRunContextBindings: clearDurableRunContextBindingsMock,
}));
vi.mock("@/lib/a2a-auth", () => ({
  verifyLangGraphBridgeToken: vi.fn(async () => ({
    ok: false,
    response: new Response("forbidden", { status: 403 }),
  })),
}));
vi.mock("@cinatra-ai/skills", () => ({
  resolveDeclaredSkillEdgeForExtensionDir: vi.fn(async () => null),
  getCustomSkillForCurrentUserAndAgent: vi.fn(async () => null),
}));
vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: vi.fn(async () => []),
}));
vi.mock("@/lib/agent-run-mcp-actor-token", () => ({
  issueAgentRunMcpActorToken: issueAgentRunMcpActorTokenMock,
}));
vi.mock("@/lib/agent-run-actor-resolve", () => ({
  resolveAgentRunMcpActor: resolveAgentRunMcpActorMock,
}));
vi.mock("@cinatra-ai/agents", async () => {
  const { z } = await import("zod");
  return {
    publishCallAllowed: async () => true, // cinatra#4150: no publish decision holds this run
    readAgentRunByContextId: readAgentRunByContextIdMock,
    readAgentRunById: readAgentRunByIdMock,
    readAgentRunByTokenHash: readAgentRunByTokenHashMock,
    readAgentRunTokenHashById: readAgentRunTokenHashByIdMock,
    readAgentTemplateById: readAgentTemplateByIdMock,
    resolveRunExecutionEnvironment: () => ({ kind: "none" }),
    resolvePinnedRunSnapshot: async () => null,
    readAgentTemplateVersionById: async () => null,
    readAgentTemplateVersionBySemver: async () => null,
    PinnedRunSnapshotUnreachableError: class extends Error {},
    canProviderSatisfyCapability: (provider: string, capability: string): boolean => {
      switch (capability) {
        case "media_input":
          return provider === "gemini";
        case "function_tools":
          return provider === "openai" || provider === "anthropic" || provider === "gemini";
        case "native_mcp":
          return provider === "openai" || provider === "anthropic";
        default:
          return false;
      }
    },
    describeCapabilityRequirement: (
      capability: string,
      opts?: { incompatibleProvider?: string },
    ): string => {
      const providers = (["openai", "anthropic", "gemini"] as const).filter((p) => {
        switch (capability) {
          case "media_input":
            return p === "gemini";
          case "function_tools":
            return true;
          case "native_mcp":
            return p === "openai" || p === "anthropic";
          default:
            return false;
        }
      });
      const options = providers.join(", ");
      if (opts?.incompatibleProvider) {
        return (
          `This agent requires the "${capability}" LLM capability, but the active ` +
          `provider "${opts.incompatibleProvider}" cannot satisfy it. Install and ` +
          `configure an LLM connector for one of these providers instead: ${options}.`
        );
      }
      return (
        `This agent requires the "${capability}" LLM capability, but no installed ` +
        `and configured LLM provider supports it. Install and configure an LLM ` +
        `connector for one of these providers: ${options}.`
      );
    },
    OasCinatraLlmSchema: z
      .object({
        preferredProvider: z.enum(["openai", "anthropic", "gemini"]).optional(),
        preferredModel: z.string().min(1).optional(),
        capabilityRequired: z
          .enum(["media_input", "function_tools", "native_mcp"])
          .optional(),
      })
      .strict()
      .optional(),
    LLM_PROVIDERS: ["openai", "anthropic", "gemini"] as const,
    LLM_CAPABILITIES: ["media_input", "function_tools", "native_mcp"] as const,
  };
});

let POST: (req: Request) => Promise<Response>;
const BRIDGE_TOKEN = "test-token-32chars-XYZXYZXYZXYZ";
const AUTH_SECRET = "test-better-auth-secret-for-step-unit";
const ATTEST_KEY = "step-attest-key-under-test";
const CTX = "ctx-run-1";
const NODE = "model-step-node-1";
const RUN_TOKEN = "raw-run-token-xyz";

const RUN = {
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  sourceType: null,
  templateId: "tpl-1",
  projectId: null,
  oboCeiling: [{ tier: "organization", id: "org-1" }],
};
const OTHER_RUN = { ...RUN, id: "run-2" };
const SOURCE = {
  sourceSha256: "b".repeat(64),
  executedSourceSha256: "c".repeat(64),
  declarationSourceSha256: "d".repeat(64),
};
const ATTEMPT = "attempt-1";
const VERIFIED_SOURCE = Object.freeze({ contextId: CTX, stepId: NODE, executionAttemptId: ATTEMPT, ...SOURCE });
const REFUSED = { error: "Executing source could not be verified", code: "run_source_mismatch" };
const PROBE = { id: RUN.id, orgId: RUN.orgId, runBy: RUN.runBy };

const ENV_BEFORE = {
  bridge: process.env.CINATRA_BRIDGE_TOKEN,
  auth: process.env.BETTER_AUTH_SECRET,
  attest: process.env.CINATRA_CONTEXT_ATTEST_KEY,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function stepHeaders(opts: { ctx?: string; node?: string; key?: string; expiry?: number } = {}) {
  const ctx = opts.ctx ?? CTX;
  const node = opts.node ?? NODE;
  const key = opts.key ?? ATTEST_KEY;
  const expiry = opts.expiry ?? Math.floor(Date.now() / 1000) + 300;
  const sig = createHmac("sha256", key).update(`s1\n${ctx}\n${node}\n${expiry}`).digest("hex");
  return {
    "x-cinatra-step-node": node,
    "x-cinatra-step-attestation": `s1:${expiry}:${sig}`,
  };
}

/** The source-bound pair the runtime signs over the step, its task's attempt and the executing source. */
function sourceHeaders(opts: { ctx?: string; node?: string; key?: string; attempt?: string } = {}) {
  const ctx = opts.ctx ?? CTX;
  const node = opts.node ?? NODE;
  const key = opts.key ?? ATTEST_KEY;
  const attempt = opts.attempt ?? ATTEMPT;
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const { sourceSha256, executedSourceSha256, declarationSourceSha256 } = SOURCE;
  const sig = createHmac("sha256", key)
    .update(`s2\n${ctx}\n${node}\n${attempt}\n${sourceSha256}\n${executedSourceSha256}\n${declarationSourceSha256}\n${expiry}`)
    .digest("hex");
  return {
    "x-cinatra-step-node": node,
    "x-cinatra-execution-attempt": attempt,
    "x-cinatra-step-attestation": `s2:${expiry}:${sig}`,
    "x-cinatra-raw-source": sourceSha256,
    "x-cinatra-executed-source": executedSourceSha256,
    "x-cinatra-declaration-source": declarationSourceSha256,
  };
}

function makeReq(body: Record<string, unknown>, headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/llm-bridge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatra-bridge-token": BRIDGE_TOKEN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.CINATRA_BRIDGE_TOKEN = BRIDGE_TOKEN;
  process.env.BETTER_AUTH_SECRET = AUTH_SECRET;
  process.env.CINATRA_CONTEXT_ATTEST_KEY = ATTEST_KEY;
  readAgentRunByTokenHashMock.mockResolvedValue(PROBE);
  readAgentRunByIdMock.mockResolvedValue(RUN);
  readAgentRunByContextIdMock.mockImplementation(async (ctx: string) =>
    ctx === CTX ? RUN : ctx === "ctx-run-2" ? OTHER_RUN : null,
  );
  readAgentTemplateByIdMock.mockResolvedValue({
    ownerLevel: "organization",
    ownerId: "org-1",
  });
  resolveAgentRunMcpActorMock.mockResolvedValue({
    delegation: "agent_run",
    userId: RUN.runBy,
    orgId: RUN.orgId,
    runId: RUN.id,
    platformRole: "member",
  });
  runResolvedSkillAwareDeterministicLlmTaskMock.mockResolvedValue({ text: "ok", artifacts: [] });
  buildLlmMcpServerToolMock.mockResolvedValue({
    type: "mcp",
    headers: { Authorization: "Bearer machine-token-abc" },
  });
  readAgentRunTokenHashByIdMock.mockResolvedValue(null);
  writeDurableRunContextBindingMock.mockResolvedValue("cinatra:run-ctx:v1:test-key");
  verifyRunExecutedSourceMock.mockResolvedValue(VERIFIED_SOURCE);
  const mod = await import("../route");
  POST = mod.POST;
});

afterEach(() => {
  restoreEnv("CINATRA_BRIDGE_TOKEN", ENV_BEFORE.bridge);
  restoreEnv("BETTER_AUTH_SECRET", ENV_BEFORE.auth);
  restoreEnv("CINATRA_CONTEXT_ATTEST_KEY", ENV_BEFORE.attest);
});

async function invokeOverride(): Promise<unknown> {
  const call = runResolvedSkillAwareDeterministicLlmTaskMock.mock.calls[0];
  if (!call) throw new Error("expected dispatch to have been called");
  const arg = call[0] as { cinatraMcpToolOverride?: () => Promise<unknown> };
  if (!arg.cinatraMcpToolOverride) return undefined;
  return arg.cinatraMcpToolOverride();
}

function mintedActor(): Record<string, unknown> {
  expect(buildLlmMcpServerToolForAgentRunMock).toHaveBeenCalledTimes(1);
  return (buildLlmMcpServerToolForAgentRunMock.mock.calls[0] as unknown[])[1] as Record<
    string,
    unknown
  >;
}

describe("the model bridge carries the verified step", () => {
  // (b1)
  it("a valid step pair over the agreed context reaches the on-behalf-of token's actor", async () => {
    const res = await POST(
      makeReq(
        { user: "hi" },
        { "x-cinatra-run-token": RUN_TOKEN, "x-cinatra-a2a-context-id": CTX, ...stepHeaders() },
      ),
    );
    expect(res.status).toBe(200);
    await invokeOverride();
    const actor = mintedActor();
    expect(actor.verifiedStepId).toBe(NODE);
    expect(actor.runId).toBe(RUN.id);
  });

  // (b2)
  it("an invalid pair, a pair over another context or no pair serves the call as before with no step", async () => {
    const valid = stepHeaders();
    const variants: Array<Record<string, string>> = [
      { ...valid, "x-cinatra-step-attestation": valid["x-cinatra-step-attestation"].replace(/.$/, (c) => (c === "0" ? "1" : "0")) },
      stepHeaders({ ctx: "ctx-run-2" }),
      stepHeaders({ key: "another-key-under-test" }),
      { ...valid, "x-cinatra-step-node": "other-node" },
      stepHeaders({ expiry: Math.floor(Date.now() / 1000) - 3600 }),
      {},
    ];
    for (const headers of variants) {
      vi.clearAllMocks();
      const res = await POST(
        makeReq(
          { user: "hi" },
          { "x-cinatra-run-token": RUN_TOKEN, "x-cinatra-a2a-context-id": CTX, ...headers },
        ),
      );
      expect(res.status).toBe(200);
      await invokeOverride();
      expect(resolveAgentRunMcpActorMock).toHaveBeenCalledTimes(1);
      const actor = mintedActor();
      expect(actor).not.toHaveProperty("verifiedStepId");
      expect(actor.runId).toBe(RUN.id);
    }
    // A pair without a context-id header: the run token alone gives no step.
    vi.clearAllMocks();
    const res = await POST(makeReq({ user: "hi" }, { "x-cinatra-run-token": RUN_TOKEN, ...valid }));
    expect(res.status).toBe(200);
    await invokeOverride();
    expect(mintedActor()).not.toHaveProperty("verifiedStepId");
  });

  // (b3)
  it("a step named in the body or in another header without a valid pair gives no step", async () => {
    const res = await POST(
      makeReq(
        { user: "hi", stepId: NODE, step_id: NODE, verifiedStepId: NODE },
        {
          "x-cinatra-run-token": RUN_TOKEN,
          "x-cinatra-a2a-context-id": CTX,
          "x-cinatra-step-id": NODE,
          "x-cinatra-step-node": NODE,
        },
      ),
    );
    expect(res.status).toBe(200);
    await invokeOverride();
    expect(mintedActor()).not.toHaveProperty("verifiedStepId");
  });

  // (b4)
  it("on the machine-token road a valid pair puts the step on the durable binding", async () => {
    resolveAgentRunMcpActorMock.mockResolvedValue(null);
    readAgentRunTokenHashByIdMock.mockResolvedValue("a".repeat(64));
    const res = await POST(
      makeReq(
        { user: "hi" },
        { "x-cinatra-run-token": RUN_TOKEN, "x-cinatra-a2a-context-id": CTX, ...stepHeaders() },
      ),
    );
    expect(res.status).toBe(200);
    await invokeOverride();
    expect(buildLlmMcpServerToolForAgentRunMock).not.toHaveBeenCalled();
    expect(writeDurableRunContextBindingMock).toHaveBeenCalledWith(
      "machine-token-abc",
      expect.objectContaining({ tokenHash: "a".repeat(64), stepId: NODE }),
    );
  });
});

describe("the model bridge verifies the executing source of a run-bound call", () => {
  const RUN_BOUND = { "x-cinatra-run-token": RUN_TOKEN, "x-cinatra-a2a-context-id": CTX };

  // (b5)
  it("a valid source-bound pair on a bound run is served, and the step is the run store's proof", async () => {
    const res = await POST(makeReq({ user: "hi" }, { ...RUN_BOUND, ...sourceHeaders() }));
    expect(res.status).toBe(200);
    expect(verifyRunExecutedSourceMock).toHaveBeenCalledTimes(1);
    expect(verifyRunExecutedSourceMock).toHaveBeenCalledWith(RUN.id, RUN.orgId,
      { stepId: NODE, contextId: CTX, executionAttemptId: ATTEMPT, ...SOURCE });
    await invokeOverride();
    const actor = mintedActor();
    expect(actor.verifiedStepId).toBe(NODE);
    expect(actor.runId).toBe(RUN.id);
  });

  // (b6)
  it("a source header with a pair that does not verify is refused before any model call", async () => {
    const valid = sourceHeaders();
    const variants: Array<Record<string, string>> = [
      { ...RUN_BOUND, ...valid, "x-cinatra-step-attestation": valid["x-cinatra-step-attestation"].replace(/.$/, (c) => (c === "0" ? "1" : "0")) },
      { ...RUN_BOUND, ...sourceHeaders({ ctx: "ctx-run-2" }) },
      { ...RUN_BOUND, ...sourceHeaders({ key: "another-key-under-test" }) },
      { ...RUN_BOUND, ...valid, "x-cinatra-step-node": "other-node" },
      { ...RUN_BOUND, ...valid, "x-cinatra-declaration-source": "e".repeat(64) },
      // Attempt A's pair presented as attempt B's, B's pair presented as A's, and no attempt.
      { ...RUN_BOUND, ...valid, "x-cinatra-execution-attempt": "attempt-2" },
      { ...RUN_BOUND, ...sourceHeaders({ attempt: "attempt-2" }), "x-cinatra-execution-attempt": ATTEMPT },
      (() => { const { "x-cinatra-execution-attempt": _a, ...rest } = valid; void _a; return { ...RUN_BOUND, ...rest }; })(),
      { ...RUN_BOUND, ...stepHeaders(), "x-cinatra-executed-source": SOURCE.executedSourceSha256 },
      { ...RUN_BOUND, "x-cinatra-raw-source": SOURCE.sourceSha256 },
      // The run token alone: no context-id header names the run the source is signed for.
      { "x-cinatra-run-token": RUN_TOKEN, ...valid },
    ];
    for (const headers of variants) {
      vi.clearAllMocks();
      const res = await POST(makeReq({ user: "hi" }, headers));
      expect(res.status, JSON.stringify(Object.keys(headers))).toBe(403);
      expect(await res.json()).toEqual(REFUSED);
      expect(runResolvedSkillAwareDeterministicLlmTaskMock).not.toHaveBeenCalled();
      expect(verifyRunExecutedSourceMock).not.toHaveBeenCalled();
    }
  });

  // (b7)
  it("a valid pair whose run is not bound to that source under its running attempt is refused the same way", async () => {
    for (const code of ["step_tool_run_source_inactive", "step_tool_executed_source_mismatch", "step_tool_binding_missing"]) {
      vi.clearAllMocks();
      verifyRunExecutedSourceMock.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      const res = await POST(makeReq({ user: "hi" }, { ...RUN_BOUND, ...sourceHeaders() }));
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toEqual(REFUSED);
      expect(JSON.stringify(body)).not.toContain(code);
      expect(runResolvedSkillAwareDeterministicLlmTaskMock).not.toHaveBeenCalled();
    }
  });

  // (b8)
  it("a call with source headers and without a resolved run is refused the same way before any model call", async () => {
    const valid = sourceHeaders();
    const cases: Array<{ name: string; headers: Record<string, string>; probe: typeof PROBE | null }> = [
      { name: "no run token, a context id that names a run", headers: { "x-cinatra-a2a-context-id": CTX, ...valid }, probe: PROBE },
      { name: "no run token, no context id", headers: { ...valid }, probe: PROBE },
      { name: "no run token, the attempt header alone", headers: { "x-cinatra-a2a-context-id": CTX, "x-cinatra-execution-attempt": ATTEMPT }, probe: PROBE },
      { name: "a run token that resolves no run", headers: { ...RUN_BOUND, ...valid }, probe: null },
    ];
    for (const c of cases) {
      vi.clearAllMocks();
      readAgentRunByTokenHashMock.mockResolvedValue(c.probe);
      const res = await POST(makeReq({ user: "hi" }, c.headers));
      expect(res.status, c.name).toBe(403);
      expect(await res.json(), c.name).toEqual(REFUSED);
      expect(runResolvedSkillAwareDeterministicLlmTaskMock, c.name).not.toHaveBeenCalled();
      expect(verifyRunExecutedSourceMock, c.name).not.toHaveBeenCalled();
    }
  });

  // (b10) cinatra#4154: a blank key is no key, on the bridge as on the passthrough road.
  it("a pair signed under a blank or whitespace key proves nothing: the source-bound call is refused, the s1 pair gives no step", async () => {
    for (const blank of [" ", "   ", "\t"]) {
      vi.clearAllMocks();
      process.env.CINATRA_CONTEXT_ATTEST_KEY = blank;
      const refused = await POST(makeReq({ user: "hi" }, { ...RUN_BOUND, ...sourceHeaders({ key: blank }) }));
      expect(refused.status, JSON.stringify(blank)).toBe(403);
      expect(await refused.json()).toEqual(REFUSED);
      expect(verifyRunExecutedSourceMock).not.toHaveBeenCalled();
      expect(runResolvedSkillAwareDeterministicLlmTaskMock).not.toHaveBeenCalled();

      vi.clearAllMocks();
      const served = await POST(makeReq({ user: "hi" }, { ...RUN_BOUND, ...stepHeaders({ key: blank }) }));
      expect(served.status, JSON.stringify(blank)).toBe(200);
      await invokeOverride();
      expect(mintedActor(), JSON.stringify(blank)).not.toHaveProperty("verifiedStepId");
    }
  });

  // (b9)
  it("a run-bound call without source headers takes the s1 road and never reads the source check", async () => {
    const res = await POST(makeReq({ user: "hi" }, { ...RUN_BOUND, ...stepHeaders() }));
    expect(res.status).toBe(200);
    await invokeOverride();
    expect(mintedActor().verifiedStepId).toBe(NODE);
    expect(verifyRunExecutedSourceMock).not.toHaveBeenCalled();
  });
});

describe("a source-bound call never gets a machine bearer", () => {
  const RUN_BOUND = { "x-cinatra-run-token": RUN_TOKEN, "x-cinatra-a2a-context-id": CTX };

  // (b10) At the parent the bridge minted the machine bearer, bound it with the
  // proof and offered it; the bearer then outlived its binding.
  it.each(["no on-behalf-of actor", "no on-behalf-of tool"])(
    "withholds the cinatra tool and mints no machine bearer when there is %s",
    async (reason) => {
      if (reason === "no on-behalf-of actor") resolveAgentRunMcpActorMock.mockResolvedValue(null);
      else buildLlmMcpServerToolForAgentRunMock.mockReturnValueOnce(null as never);
      readAgentRunTokenHashByIdMock.mockResolvedValue("a".repeat(64));
      const res = await POST(makeReq({ user: "hi" }, { ...RUN_BOUND, ...sourceHeaders() }));
      expect(res.status).toBe(200);
      expect(verifyRunExecutedSourceMock).toHaveBeenCalledTimes(1);
      expect(await invokeOverride()).toBeNull();
      expect(buildLlmMcpServerToolMock).not.toHaveBeenCalled();
      expect(readAgentRunTokenHashByIdMock).not.toHaveBeenCalled();
      expect(writeDurableRunContextBindingMock).not.toHaveBeenCalled();
    },
  );

  // (b15)
  it("carries the proof in the on-behalf-of token and writes no machine binding", async () => {
    const res = await POST(makeReq({ user: "hi" }, { ...RUN_BOUND, ...sourceHeaders() }));
    expect(res.status).toBe(200);
    expect(await invokeOverride()).toEqual({ type: "mcp-tool" });
    expect(mintedActor()).toMatchObject({ runId: RUN.id, verifiedStepId: NODE, verifiedExecutedSource: VERIFIED_SOURCE });
    expect(buildLlmMcpServerToolMock).not.toHaveBeenCalled();
    expect(writeDurableRunContextBindingMock).not.toHaveBeenCalled();
  });

  // (b16)
  it.each(["missing hash", "missing bearer", "binding refusal"])(
    "keeps the best-effort machine fallback of a call without a verified source (%s)",
    async (missing) => {
      resolveAgentRunMcpActorMock.mockResolvedValue(null);
      if (missing !== "missing hash") readAgentRunTokenHashByIdMock.mockResolvedValue("a".repeat(64));
      if (missing === "missing bearer") buildLlmMcpServerToolMock.mockResolvedValue({ type: "mcp", headers: {} });
      if (missing === "binding refusal") writeDurableRunContextBindingMock.mockResolvedValue(null);
      const res = await POST(makeReq({ user: "hi" }, RUN_BOUND));
      expect(res.status).toBe(200);
      expect(await invokeOverride()).toEqual(await buildLlmMcpServerToolMock.mock.results[0]!.value);
      expect(verifyRunExecutedSourceMock).not.toHaveBeenCalled();
    },
  );
});

// Leave the module registry as this file found it.
afterAll(() => {
  vi.doUnmock("server-only");
  vi.doUnmock("@cinatra-ai/llm");
  vi.doUnmock("@cinatra-ai/agents/store");
  vi.doUnmock("@/lib/agent-run-context-durable");
  vi.doUnmock("@/lib/a2a-auth");
  vi.doUnmock("@cinatra-ai/skills");
  vi.doUnmock("@/lib/agents-store");
  vi.doUnmock("@/lib/agent-run-mcp-actor-token");
  vi.doUnmock("@/lib/agent-run-actor-resolve");
  vi.doUnmock("@cinatra-ai/agents");
  vi.resetModules();
});
