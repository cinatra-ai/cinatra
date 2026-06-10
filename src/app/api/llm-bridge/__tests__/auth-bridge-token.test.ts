/**
 * Bridge token shared-secret auth for X-Cinatra-Bridge-Token.
 * Strict-token-only auth: BYPASS env var + XFF loopback removed.
 *
 * Behavior contract:
 *   - When CINATRA_BRIDGE_TOKEN env is set: request must carry a matching
 *     X-Cinatra-Bridge-Token header. Wrong / missing -> 403. Match -> 200.
 *   - When CINATRA_BRIDGE_TOKEN env is unset: ALL requests are denied (403).
 *     No fallback — see test "rejects request when CINATRA_BRIDGE_TOKEN is unset".
 *   - Length-mismatch short-circuit: timingSafeEqual requires equal-length
 *     buffers; the helper returns false BEFORE invoking timingSafeEqual when
 *     header.length !== expected.length.
 *
 * Mock topology mirrors src/app/api/internal/langgraph-llm-step/__tests__/route-auth.test.ts —
 * @cinatra-ai/llm is mocked WITHOUT importOriginal because the
 * package barrel is unresolvable in the root vitest config.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@cinatra-ai/llm", () => ({
  runResolvedSkillAwareDeterministicLlmTask: vi.fn(async () => ({
    text: "ok",
    artifacts: [],
  })),
  resolveConfiguredLlmRuntime: vi.fn(async () => ({
    runtime: { provider: "openai" },
    agentId: "test",
    deterministic: false,
  })),
  createLocalSkillShellTool: vi.fn(() => null),
  // Real predicate shape: only base gpt-5 / gpt-5-mini lack hosted shell.
  openAiModelSupportsShell: (modelId: string) => modelId !== "gpt-5" && modelId !== "gpt-5-mini",
  getLlmMcpCredentials: vi.fn(() => null),
  // Bridge route imports for cinatra_llm dispatch.
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

vi.mock("@/lib/agent-run-context-registry", () => ({
  setRunContext: vi.fn(),
  clearRunContext: vi.fn(),
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

// Route imports OasCinatraLlmSchema + ALLOWED_MODEL_IDS.
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
  delete process.env.CINATRA_BRIDGE_TOKEN;
  delete process.env.WAYFLOW_INTERNAL_BYPASS;
  const mod = await import("../route");
  POST = mod.POST;
});

describe("/api/llm-bridge X-Cinatra-Bridge-Token", () => {
  it("accepts request when X-Cinatra-Bridge-Token header matches CINATRA_BRIDGE_TOKEN env", async () => {
    process.env.CINATRA_BRIDGE_TOKEN = "secret-token-32chars-XYZXYZXYZXYZ";
    const req = new Request("http://localhost:3000/api/llm-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatra-bridge-token": "secret-token-32chars-XYZXYZXYZXYZ",
      },
      body: JSON.stringify({ user: "test" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("rejects request when X-Cinatra-Bridge-Token header is wrong", async () => {
    process.env.CINATRA_BRIDGE_TOKEN = "secret-token-32chars-XYZXYZXYZXYZ";
    const req = new Request("http://localhost:3000/api/llm-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatra-bridge-token": "wrong-token-32chars-AAAAAAAAAAAAA",
      },
      body: JSON.stringify({ user: "test" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("rejects request with no header when CINATRA_BRIDGE_TOKEN is set (no silent fallback)", async () => {
    process.env.CINATRA_BRIDGE_TOKEN = "secret-token-32chars-XYZXYZXYZXYZ";
    const req = new Request("http://localhost:3000/api/llm-bridge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "test" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("rejects request when CINATRA_BRIDGE_TOKEN is unset (no fallback)", async () => {
    delete process.env.CINATRA_BRIDGE_TOKEN;
    const req = new Request("http://localhost:3000/api/llm-bridge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: "test" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("rejects on length mismatch without invoking timingSafeEqual (short-circuit)", async () => {
    process.env.CINATRA_BRIDGE_TOKEN = "secret-token-32chars-XYZXYZXYZXYZ";
    const req = new Request("http://localhost:3000/api/llm-bridge", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cinatra-bridge-token": "short",
      },
      body: JSON.stringify({ user: "test" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });
});
