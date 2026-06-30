/**
 * Tests for run-context registry wiring.
 *
 * The /api/llm-bridge route receives WayFlow ApiNode requests with body.agent_run_id.
 * Before invoking the LLM task it calls setRunContext(mcpCreds.clientId, { runId, agentId })
 * and after the task (in finally) it calls clearRunContext(mcpCreds.clientId). The MCP
 * transport handler reads this registry to attach run_id to objects_save calls
 * (packages/mcp-server/src/index.tsx:953-967).
 *
 * The route must call setRunContext / clearRunContext for requests with an agent_run_id;
 * otherwise every assertion fails with `expect(...).toHaveBeenCalled()` mismatch.
 *
 * When getLlmMcpCredentials returns null (tunnel down), the route must still serve the
 * request but skip registry wiring; this is the "graceful no-op" case.
 *
 * Mock topology: vi.hoisted handles must be created BEFORE the vi.mock factory
 * closes over them; @cinatra-ai/llm is mocked WITHOUT importOriginal
 * (the package barrel is unresolvable in the root vitest config — see existing
 * src/app/api/internal/langgraph-llm-step/__tests__/route-auth.test.ts:18-25 for
 * the convention).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  setRunContextMock,
  clearRunContextMock,
  runResolvedSkillAwareDeterministicLlmTaskMock,
  getLlmMcpCredentialsMock,
} = vi.hoisted(() => ({
  setRunContextMock: vi.fn(),
  clearRunContextMock: vi.fn(),
  runResolvedSkillAwareDeterministicLlmTaskMock: vi.fn(async () => ({
    text: "ok",
    artifacts: [],
  })),
  // Typed to mirror production getLlmMcpCredentials return signature
  // (LlmMcpProviderCredentials | null) so mockReturnValueOnce(null) typechecks.
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
  // The bridge route imports these for cinatra_llm dispatch. These tests do not
  // exercise the cinatra_llm path; default to "every provider available" so the
  // dispatch helper's adapter-availability probe doesn't 503 spuriously when a
  // test sneaks in cinatra_llm later.
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

// The bridge route imports OasCinatraLlmSchema + ALLOWED_MODEL_IDS +
// LlmProvider from @cinatra-ai/agents. The Zod schema is constructed via the
// real `zod` runtime here so route schema parsing still works; the rest of
// @cinatra-ai/agents (heavy transitive deps via mcp-server) stays mocked.
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

let POST: (req: Request) => Promise<Response>;

beforeEach(async () => {
  vi.clearAllMocks();
  // Bridge-token fixture.
  process.env.CINATRA_BRIDGE_TOKEN = "test-token-32chars-XYZXYZXYZXYZ";
  delete process.env.WAYFLOW_INTERNAL_BYPASS; // env hygiene
  const mod = await import("../route");
  POST = mod.POST;
  // Restore default — vi.clearAllMocks resets implementation to undefined.
  getLlmMcpCredentialsMock.mockReturnValue({
    clientId: "mock-client-id-1",
    clientSecret: "secret",
  });
  runResolvedSkillAwareDeterministicLlmTaskMock.mockResolvedValue({
    text: "ok",
    artifacts: [],
  });
});

describe("/api/llm-bridge run-context registry wiring", () => {
  it("calls setRunContext with mcpCreds.clientId when body.agent_run_id is present", async () => {
    const req = new Request("http://localhost:3000/api/llm-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ",
      },
      body: JSON.stringify({
        agent_run_id: "run-X",
        agent_id: "email-recipient-selection",
        user: "test",
        system: "sys",
      }),
    });
    await POST(req);
    expect(setRunContextMock).toHaveBeenCalledTimes(1);
    expect(setRunContextMock).toHaveBeenCalledWith(
      "mock-client-id-1",
      expect.objectContaining({ runId: "run-X", agentId: "email-recipient-selection" }),
    );
  });

  it("calls clearRunContext in finally after the LLM task completes", async () => {
    const req = new Request("http://localhost:3000/api/llm-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ",
      },
      body: JSON.stringify({ agent_run_id: "run-X", user: "test" }),
    });
    await POST(req);
    expect(clearRunContextMock).toHaveBeenCalledWith("mock-client-id-1");
  });

  it("does not call setRunContext when body.agent_run_id is absent", async () => {
    const req = new Request("http://localhost:3000/api/llm-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ",
      },
      body: JSON.stringify({ user: "test" }),
    });
    await POST(req);
    expect(setRunContextMock).not.toHaveBeenCalled();
    expect(clearRunContextMock).not.toHaveBeenCalled();
  });

  it("gracefully no-ops when getLlmMcpCredentials returns null", async () => {
    getLlmMcpCredentialsMock.mockReturnValueOnce(null);
    const req = new Request("http://localhost:3000/api/llm-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ",
      },
      body: JSON.stringify({ agent_run_id: "run-X", user: "test" }),
    });
    await POST(req);
    expect(setRunContextMock).not.toHaveBeenCalled();
    expect(clearRunContextMock).not.toHaveBeenCalled();
  });
});
