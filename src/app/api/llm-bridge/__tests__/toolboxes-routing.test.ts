/**
 * Bridge route partitions `body.toolbox_ids` into MCP toolbox IDs vs built-in
 * provider tool names. Built-in names route to `extraTools` as provider-native
 * tools; MCP IDs route to `declaredToolboxIds` for
 * resolveMcpToolsForDeclaredIds.
 *
 * Regression coverage proves the runtime gets the intended tool, not just that
 * the metadata propagates.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type LlmProviderId = "openai" | "anthropic" | "gemini";

const {
  runResolvedSkillAwareDeterministicLlmTaskMock,
  resolveProviderAdapterMock,
  resolveConfiguredLlmRuntimeMock,
  getLlmMcpCredentialsMock,
  setRunContextMock,
  clearRunContextMock,
  consoleWarnSpy,
} = vi.hoisted(() => ({
  runResolvedSkillAwareDeterministicLlmTaskMock: vi.fn(
    async (_input: { [key: string]: unknown }) => ({ text: "ok", artifacts: [] }),
  ),
  resolveProviderAdapterMock: vi.fn(
    async (provider: LlmProviderId): Promise<{ provider: LlmProviderId } | null> => ({ provider }),
  ),
  resolveConfiguredLlmRuntimeMock: vi.fn(async () => ({
    runtime: { provider: "openai" as LlmProviderId },
    agentId: "test",
    deterministic: false,
  })),
  getLlmMcpCredentialsMock: vi.fn((): { clientId: string; clientSecret: string } | null => null),
  setRunContextMock: vi.fn(),
  clearRunContextMock: vi.fn(),
  consoleWarnSpy: vi.spyOn(console, "warn").mockImplementation(() => {}),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/llm", () => ({
  runResolvedSkillAwareDeterministicLlmTask: runResolvedSkillAwareDeterministicLlmTaskMock,
  resolveProviderAdapter: resolveProviderAdapterMock,
  resolveConfiguredLlmRuntime: resolveConfiguredLlmRuntimeMock,
  getLlmMcpCredentials: getLlmMcpCredentialsMock,
  createLocalSkillShellTool: vi.fn(() => null),
  // Real predicate shape: only base gpt-5 / gpt-5-mini lack hosted shell.
  openAiModelSupportsShell: (modelId: string) => modelId !== "gpt-5" && modelId !== "gpt-5-mini",
  PreferredProviderUnavailableError: class extends Error {},
}));
vi.mock("@/lib/agent-run-context-registry", () => ({
  setRunContext: setRunContextMock,
  clearRunContext: clearRunContextMock,
}));
vi.mock("@/lib/a2a-auth", () => ({
  verifyLangGraphBridgeToken: vi.fn(async () => ({
    ok: false,
    response: new Response("forbidden", { status: 403 }),
  })),
}));
vi.mock("@cinatra-ai/skills", () => ({
  getCustomSkillForCurrentUserAndAgent: vi.fn(async () => null),
}));
vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/agents", async () => {
  const { z } = await import("zod");
  return {
    readAgentRunByContextId: vi.fn(async () => null),
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
    ALLOWED_MODEL_IDS: {
      openai: ["gpt-5"],
      anthropic: ["claude-sonnet-4-6"],
      gemini: ["gemini-2.5-flash"],
    },
  };
});

let POST: (req: Request) => Promise<Response>;

const BRIDGE_TOKEN = "test-token-32chars-XYZXYZXYZXYZ";

function makeReq(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/llm-bridge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatra-bridge-token": BRIDGE_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

function dispatchCallArg(): {
  declaredToolboxIds?: string[];
  extraTools?: Array<{ type?: string }>;
  [key: string]: unknown;
} {
  const call = runResolvedSkillAwareDeterministicLlmTaskMock.mock.calls[0];
  if (!call) throw new Error("expected dispatch to have been called");
  return call[0] as {
    declaredToolboxIds?: string[];
    extraTools?: Array<{ type?: string }>;
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  consoleWarnSpy.mockClear();
  process.env.CINATRA_BRIDGE_TOKEN = BRIDGE_TOKEN;
  runResolvedSkillAwareDeterministicLlmTaskMock.mockResolvedValue({
    text: "ok",
    artifacts: [],
  });
  const mod = await import("../route");
  POST = mod.POST;
});

describe("toolbox_ids partition", () => {
  it("toolbox_ids: ['web_search'] → extraTools has web_search; declaredToolboxIds=[]", async () => {
    const res = await POST(
      makeReq({ user: "hello", toolbox_ids: ["web_search"] }),
    );
    expect(res.status).toBe(200);
    const call = dispatchCallArg();
    expect(call.declaredToolboxIds).toEqual([]);
    const wsTools = call.extraTools?.filter((t) => t.type === "web_search") ?? [];
    expect(wsTools.length).toBe(1);
  });

  it("toolbox_ids: ['cinatra-mcp', 'web_search'] → both routed", async () => {
    const res = await POST(
      makeReq({
        user: "hello",
        toolbox_ids: ["cinatra-mcp", "web_search"],
      }),
    );
    expect(res.status).toBe(200);
    const call = dispatchCallArg();
    expect(call.declaredToolboxIds).toEqual(["cinatra-mcp"]);
    const wsTools = call.extraTools?.filter((t) => t.type === "web_search") ?? [];
    expect(wsTools.length).toBe(1);
  });

  it("toolbox_ids: ['cinatra-mcp'] → no web_search in extraTools", async () => {
    const res = await POST(
      makeReq({ user: "hello", toolbox_ids: ["cinatra-mcp"] }),
    );
    expect(res.status).toBe(200);
    const call = dispatchCallArg();
    expect(call.declaredToolboxIds).toEqual(["cinatra-mcp"]);
    const wsTools = call.extraTools?.filter((t) => t.type === "web_search") ?? [];
    expect(wsTools.length).toBe(0);
  });

  it("BACK-COMPAT: no toolbox_ids → defaults to ['cinatra-mcp']", async () => {
    const res = await POST(makeReq({ user: "hello" }));
    expect(res.status).toBe(200);
    const call = dispatchCallArg();
    expect(call.declaredToolboxIds).toEqual(["cinatra-mcp"]);
  });

  it("toolbox_ids: ['external-mcp-id'] (unknown MCP) → routes to declaredToolboxIds, NOT extraTools", async () => {
    const res = await POST(
      makeReq({ user: "hello", toolbox_ids: ["some-external-mcp"] }),
    );
    expect(res.status).toBe(200);
    const call = dispatchCallArg();
    expect(call.declaredToolboxIds).toEqual(["some-external-mcp"]);
    const wsTools = call.extraTools?.filter((t) => t.type === "web_search") ?? [];
    expect(wsTools.length).toBe(0);
  });
});
