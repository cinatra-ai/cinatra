/**
 * cinatra#4150 part 5a (A6) — the model bridge refuses a call that the publish
 * decision does not let through, before any provider is reached.
 *
 * The route asks `publishCallAllowed` (its decision matrix is pinned in
 * packages/agents/src/__tests__/publish-call-guard.test.ts) with the run the
 * call proved and the verified step of the calling model step, or with no step
 * when the call carries no valid signed pair. A refused call answers 403 with
 * code `publish_not_released` and a text that names no run or step.
 * The module doubles follow run-step-attestation-bridge.test.ts; the route, the
 * run token verifier and the step verifier are real.
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
  publishCallAllowedMock,
} = vi.hoisted(() => ({
  publishCallAllowedMock: vi.fn<(run: unknown, step: unknown) => Promise<boolean>>(async () => true),
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
    async (): Promise<{ type: string; headers: { Authorization: string } } | null> => ({
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
    publishCallAllowed: publishCallAllowedMock,
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
  publishCallAllowedMock.mockResolvedValue(true);
  const mod = await import("../route");
  POST = mod.POST;
});

afterEach(() => {
  restoreEnv("CINATRA_BRIDGE_TOKEN", ENV_BEFORE.bridge);
  restoreEnv("BETTER_AUTH_SECRET", ENV_BEFORE.auth);
  restoreEnv("CINATRA_CONTEXT_ATTEST_KEY", ENV_BEFORE.attest);
});

describe("the model bridge refuses a publish the decision does not let through", () => {
  const headers = (extra: Record<string, string> = {}) => ({
    "x-cinatra-run-token": RUN_TOKEN,
    "x-cinatra-a2a-context-id": CTX,
    ...extra,
  });

  it("asks with the proved run and the verified step, and refuses before any provider is reached", async () => {
    publishCallAllowedMock.mockResolvedValue(false);
    const res = await POST(makeReq({ user: "hi" }, headers(stepHeaders())));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("publish_not_released");
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${RUN.id}|${NODE}|${CTX}`));
    expect(publishCallAllowedMock).toHaveBeenCalledTimes(1);
    const [run, step] = publishCallAllowedMock.mock.calls[0] as unknown as [{ id: string; templateId: string }, unknown];
    expect(run).toMatchObject({ id: RUN.id, templateId: RUN.templateId });
    expect(step).toBe(NODE);
    expect(runResolvedSkillAwareDeterministicLlmTaskMock).not.toHaveBeenCalled();
    expect(resolveProviderAdapterMock).not.toHaveBeenCalled();
  });

  it("a call with no valid step pair asks with no step, and is refused the same way", async () => {
    publishCallAllowedMock.mockResolvedValue(false);
    const forged = { ...stepHeaders(), "x-cinatra-step-node": "other-node" };
    for (const extra of [{}, forged, stepHeaders({ key: "another-key-under-test" })]) {
      vi.clearAllMocks();
      publishCallAllowedMock.mockResolvedValue(false);
      const res = await POST(makeReq({ user: "hi", stepId: NODE }, headers(extra)));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("publish_not_released");
      expect(publishCallAllowedMock.mock.calls[0]![1]).toBeUndefined();
      expect(runResolvedSkillAwareDeterministicLlmTaskMock).not.toHaveBeenCalled();
    }
  });

  it("a call the decision lets through is served as before", async () => {
    const res = await POST(makeReq({ user: "hi" }, headers(stepHeaders())));
    expect(res.status).toBe(200);
    expect(publishCallAllowedMock).toHaveBeenCalledTimes(1);
    expect(runResolvedSkillAwareDeterministicLlmTaskMock).toHaveBeenCalledTimes(1);
  });

  it("a call that the context id alone selects is asked about that run, with no step", async () => {
    publishCallAllowedMock.mockResolvedValue(false);
    const res = await POST(makeReq({ user: "hi" }, { "x-cinatra-a2a-context-id": CTX, ...stepHeaders() }));
    expect(res.status).toBe(403);
    const [run, step] = publishCallAllowedMock.mock.calls[0] as unknown as [{ id: string }, unknown];
    expect(run.id).toBe(RUN.id);
    expect(step).toBeUndefined();
    expect(runResolvedSkillAwareDeterministicLlmTaskMock).not.toHaveBeenCalled();
  });

  it("a call that only a context id names is refused when that run cannot be read, before the check and any provider", async () => {
    readAgentRunByContextIdMock.mockRejectedValue(new Error("db down: ctx-run-1"));
    const res = await POST(makeReq({ user: "hi" }, { "x-cinatra-a2a-context-id": CTX }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body).toEqual({ error: "Run identity could not be verified", code: "run_mismatch" });
    expect(publishCallAllowedMock).not.toHaveBeenCalled();
    expect(runResolvedSkillAwareDeterministicLlmTaskMock).not.toHaveBeenCalled();
    expect(resolveProviderAdapterMock).not.toHaveBeenCalled();
  });

  it("a bearer call with a foreign context id gets the same answer as with none: the header is not looked up", async () => {
    const { verifyLangGraphBridgeToken } = await import("@/lib/a2a-auth");
    publishCallAllowedMock.mockResolvedValue(false);
    const bearer = (headers: Record<string, string>) =>
      new Request("http://localhost:3000/api/llm-bridge", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer client-jwt", ...headers },
        body: JSON.stringify({ user: "hi" }),
      });
    vi.mocked(verifyLangGraphBridgeToken)
      .mockResolvedValueOnce({ ok: true, subject: "client-1" } as never)
      .mockResolvedValueOnce({ ok: true, subject: "client-1" } as never);
    const withForeign = await POST(bearer({ "x-cinatra-a2a-context-id": "ctx-run-2" }));
    const withNone = await POST(bearer({}));
    expect(withForeign.status).toBe(withNone.status);
    expect(await withForeign.text()).toBe(await withNone.text());
    expect(readAgentRunByContextIdMock).not.toHaveBeenCalled();
    expect(publishCallAllowedMock).not.toHaveBeenCalled();
  });

  it("a call of no run is not asked about a publish", async () => {
    const res = await POST(makeReq({ user: "hi" }, {}));
    expect(res.status).toBe(200);
    expect(publishCallAllowedMock).not.toHaveBeenCalled();
  });
});

// Leave the module registry as this file found it.
afterAll(() => {
  vi.doUnmock("server-only");
  vi.doUnmock("@cinatra-ai/llm");
  vi.doUnmock("@/lib/agent-run-context-durable");
  vi.doUnmock("@/lib/a2a-auth");
  vi.doUnmock("@cinatra-ai/skills");
  vi.doUnmock("@/lib/agents-store");
  vi.doUnmock("@/lib/agent-run-mcp-actor-token");
  vi.doUnmock("@/lib/agent-run-actor-resolve");
  vi.doUnmock("@cinatra-ai/agents");
  vi.resetModules();
});
