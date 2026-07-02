/**
 * Tests customSkillContent + assigned skillIds plumbing through the WayFlow
 * llm-bridge route.
 *
 * Includes a clearRunContext-in-finally regression-lock test. When the
 * personal-skill lookup throws, the route's finally block must still call
 * clearRunContext.
 *
 * Tests assert that firstCallArg().skillIds equals the assigned skill IDs
 * resolved from agent_id via getAssignedSkillIdsForAgent.
 *
 * This route has related tests in this directory
 * (auth-bridge-token.test.ts, run-context-wiring.test.ts); this file covers
 * personal skill resolution alongside them.
 *
 * Mock topology mirrors run-context-wiring.test.ts: vi.hoisted handles,
 * vi.mock without importOriginal, dynamic import("../route") in beforeEach,
 * and CINATRA_BRIDGE_TOKEN test fixture for auth.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  runResolvedSkillAwareDeterministicLlmTaskMock,
  getCustomSkillForCurrentUserAndAgentMock,
  getAssignedSkillIdsForAgentMock,
  clearRunContextMock,
  setRunContextMock,
  getLlmMcpCredentialsMock,
} = vi.hoisted(() => ({
  runResolvedSkillAwareDeterministicLlmTaskMock: vi.fn(async () => ({
    text: "ok",
    artifacts: [],
  })),
  getCustomSkillForCurrentUserAndAgentMock: vi.fn<
    (agentId: string) => Promise<{ id: string; name: string; description: string; content: string; level: "personal"; scope: string } | null>
  >(async (_agentId: string) => ({
    id: "p1",
    name: "P",
    description: "D",
    content: "PERSONAL-DELTA-WAYFLOW-XYZ",
    level: "personal" as const,
    scope: "user",
  })),
  getAssignedSkillIdsForAgentMock: vi.fn(async (_agentId: string) => [
    "@cinatra-ai/asset-blog:generate-blog-ideas",
  ]),
  clearRunContextMock: vi.fn(),
  setRunContextMock: vi.fn(),
  getLlmMcpCredentialsMock: vi.fn(
    (): { clientId: string; clientSecret: string } | null => ({
      clientId: "mock-client-id-1",
      clientSecret: "secret",
    }),
  ),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/agent-run-context-registry", () => ({
  setRunContext: setRunContextMock,
  clearRunContext: clearRunContextMock,
}));

vi.mock("@cinatra-ai/llm", () => ({
  runResolvedSkillAwareDeterministicLlmTask: runResolvedSkillAwareDeterministicLlmTaskMock,
  getLlmMcpCredentials: getLlmMcpCredentialsMock,
  resolveConfiguredLlmRuntime: vi.fn(async () => ({
    runtime: { provider: "openai" },
    agentId: "test",
    deterministic: false,
  })),
  createLocalSkillShellTool: vi.fn(() => null),
  // Real predicate shape: only base gpt-5 / gpt-5-mini lack hosted shell.
  openAiModelSupportsShell: (modelId: string) => modelId !== "gpt-5" && modelId !== "gpt-5-mini",
  // Bridge route imports this for cinatra_llm dispatch.
  resolveProviderAdapter: vi.fn(async () => ({})),
  PreferredProviderUnavailableError: class PreferredProviderUnavailableError extends Error {
    requestedProvider: string;
    reason: string;
    constructor(requestedProvider: string, reason: string) {
      super(`Preferred provider ${requestedProvider} unavailable (${reason})`);
      this.requestedProvider = requestedProvider;
      this.reason = reason;
    }
  },
}));

vi.mock("@cinatra-ai/skills", () => ({
  getCustomSkillForCurrentUserAndAgent: getCustomSkillForCurrentUserAndAgentMock,
}));

vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: getAssignedSkillIdsForAgentMock,
}));

// Route imports OasCinatraLlmSchema + ALLOWED_MODEL_IDS.
vi.mock("@cinatra-ai/agents", async () => {
  const { z } = await import("zod");
  return {
    readAgentRunByContextId: vi.fn(async () => null),
    // Capability-matrix helpers consumed by _llm-dispatch.ts (engineering#417).
    // Pure mirrors of llm-provider-policy.ts so the dispatch capability gate +
    // actionable 503 message resolve without the heavy real barrel.
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
    ALLOWED_MODEL_IDS: {
      openai: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"],
      anthropic: [
        "claude-sonnet-4-6",
        "claude-opus-4-7",
        "claude-3-7-sonnet-latest",
        "claude-3-5-haiku-latest",
      ],
      gemini: [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.5-flash-lite",
        "gemini-1.5-pro",
      ],
    },
  };
});

vi.mock("@/lib/a2a-auth", () => ({
  verifyLangGraphBridgeToken: vi.fn(async () => ({
    ok: false,
    response: new Response("forbidden", { status: 403 }),
  })),
}));

let POST: (req: Request) => Promise<Response>;

afterEach(() => {
  // env hygiene — cleared so other test files start from a known state
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Bridge-token fixture for authenticated bridge requests.
  process.env.CINATRA_BRIDGE_TOKEN = "test-token-32chars-XYZXYZXYZXYZ";
  const mod = await import("../route");
  POST = mod.POST;
  // Restore defaults after vi.clearAllMocks resets implementations.
  getLlmMcpCredentialsMock.mockReturnValue({
    clientId: "mock-client-id-1",
    clientSecret: "secret",
  });
  runResolvedSkillAwareDeterministicLlmTaskMock.mockResolvedValue({
    text: "ok",
    artifacts: [],
  });
  getCustomSkillForCurrentUserAndAgentMock.mockResolvedValue({
    id: "p1",
    name: "P",
    description: "D",
    content: "PERSONAL-DELTA-WAYFLOW-XYZ",
    level: "personal" as const,
    scope: "user",
  });
  getAssignedSkillIdsForAgentMock.mockResolvedValue([
    "@cinatra-ai/asset-blog:generate-blog-ideas",
  ]);
});

/** Read the first argument of the first call to the LLM task mock. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstCallArg(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls = runResolvedSkillAwareDeterministicLlmTaskMock.mock.calls as any[][];
  if (calls.length === 0) {
    throw new Error("runResolvedSkillAwareDeterministicLlmTask was not called");
  }
  return calls[0]?.[0];
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/llm-bridge", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ",
    },
    body: JSON.stringify(body),
  });
}

describe("/api/llm-bridge personal skill resolution", () => {
  it("forwards customSkillContent when agent_id is in body", async () => {
    // Route must call getCustomSkillForCurrentUserAndAgent when agent_id is present.
    const req = makeRequest({ user: "hi", agent_id: "agent-x" });
    await POST(req);
    expect(getCustomSkillForCurrentUserAndAgentMock).toHaveBeenCalledOnce();
    expect(getCustomSkillForCurrentUserAndAgentMock).toHaveBeenCalledWith("agent-x");
    expect(firstCallArg().customSkillContent).toBe("PERSONAL-DELTA-WAYFLOW-XYZ");
  });

  it("forwards assigned skillIds resolved from agent_id", async () => {
    // Route must resolve skillIds via getAssignedSkillIdsForAgent(agent_id),
    // not hardcode an empty list.
    const req = makeRequest({ user: "hi", agent_id: "agent-x" });
    await POST(req);
    expect(getAssignedSkillIdsForAgentMock).toHaveBeenCalledOnce();
    expect(getAssignedSkillIdsForAgentMock).toHaveBeenCalledWith("agent-x");
    expect(firstCallArg().skillIds).toEqual(["@cinatra-ai/asset-blog:generate-blog-ideas"]);
  });

  it("does NOT call personal-skill or skill-id resolvers when agent_id is omitted", async () => {
    // The companion tests above prove resolver use when agent_id IS present.
    const req = makeRequest({ user: "hi" });
    await POST(req);
    expect(getCustomSkillForCurrentUserAndAgentMock).not.toHaveBeenCalled();
    expect(getAssignedSkillIdsForAgentMock).not.toHaveBeenCalled();
    expect(firstCallArg().skillIds).toEqual([]);
    expect(firstCallArg().customSkillContent).toBeUndefined();
  });

  it("forwards customSkillContent === undefined when getCustomSkillForCurrentUserAndAgent returns null", async () => {
    // Route must omit customSkillContent when no personal skill exists.
    getCustomSkillForCurrentUserAndAgentMock.mockResolvedValueOnce(null);
    const req = makeRequest({ user: "hi", agent_id: "agent-x" });
    await POST(req);
    expect(firstCallArg().customSkillContent).toBeUndefined();
  });

  it("clearRunContext still runs in finally even if personal-skill lookup throws", async () => {
    // Regression lock: the personal-skill lookup must be INSIDE the
    // try block (with the LLM task) so the finally always calls clearRunContext.
    // Cleanup is required even when the lookup fails before the LLM task runs.
    getCustomSkillForCurrentUserAndAgentMock.mockRejectedValueOnce(
      new Error("personal-skill lookup failed"),
    );
    const req = makeRequest({
      user: "hi",
      agent_run_id: "run-X",
      agent_id: "agent-x",
    });
    await POST(req);
    // clearRunContext must have been called in the finally block
    expect(clearRunContextMock).toHaveBeenCalledOnce();
  });
});
