/**
 * /api/llm-bridge cinatra_llm provider-aware dispatch.
 *
 * Covers 10 provider-routing scenarios:
 *
 *   1. BACK-COMPAT                         — byte-for-byte path.
 *   2. HONOR-PROVIDER                      — first choice path.
 *   3. SOFT-FALLBACK                       — no capability → default.
 *   4. HARD-503                            — capability set → 503.
 *   5. CAP-MISMATCH-503                    — no compatible adapter.
 *   6. NATIVE_MCP_UNSATISFIABLE           — gemini cannot satisfy native_mcp.
 *   7. MODEL-MISMATCH-400                  — preferredModel ∉ allowlist.
 *   8. POSITIVE-FUNCTION-TOOLS-DEFAULT     — capability-only routing, all three available.
 *   9. POSITIVE_NATIVE_MCP_DEFAULT        — capability-only routing, only OpenAI available.
 *  10. POSITIVE-MEDIA-INPUT-DEFAULT        — capability-only routing, only Gemini available.
 *
 * Mock topology mirrors the four existing llm-bridge tests:
 *   - @cinatra-ai/agents → real Zod schema, stub policy constants (heavy barrel
 *     deps not available in vitest sandbox).
 *   - @cinatra-ai/llm → mocked entry points so we can assert what
 *     arguments the route passes downstream.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type LlmProviderId = "openai" | "anthropic" | "gemini";
type AdapterStub = { provider: LlmProviderId } | null;

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
    async (
      _input: { preferredProvider?: "openai" | "anthropic" | "gemini"; preferredModel?: string; [key: string]: unknown },
    ) => ({
      text: "ok",
      artifacts: [],
    }),
  ),
  // Default: every provider is available. Individual tests override.
  // Return type is intentionally union-with-null so per-test impls can
  // signal adapter unavailability without retyping the mock.
  resolveProviderAdapterMock: vi.fn(
    async (provider: "openai" | "anthropic" | "gemini"): Promise<{ provider: "openai" | "anthropic" | "gemini" } | null> => ({
      provider,
    }),
  ),
  resolveConfiguredLlmRuntimeMock: vi.fn(async () => ({
    runtime: { provider: "openai" },
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

function resolveProviderAdapterImpl(
  available: Record<"openai" | "anthropic" | "gemini", boolean>,
): (provider: "openai" | "anthropic" | "gemini") => Promise<AdapterStub> {
  return async (provider: "openai" | "anthropic" | "gemini") =>
    available[provider] ? { provider } : null;
}

function firstDispatchCallArg(): {
  preferredProvider?: LlmProviderId;
  preferredModel?: string;
  [key: string]: unknown;
} {
  const call = runResolvedSkillAwareDeterministicLlmTaskMock.mock.calls[0];
  if (!call) {
    throw new Error("expected runResolvedSkillAwareDeterministicLlmTask to have been called once");
  }
  return call[0] as {
    preferredProvider?: LlmProviderId;
    preferredModel?: string;
    [key: string]: unknown;
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  consoleWarnSpy.mockClear();
  process.env.CINATRA_BRIDGE_TOKEN = BRIDGE_TOKEN;
  // Restore default — vi.clearAllMocks resets implementations.
  runResolvedSkillAwareDeterministicLlmTaskMock.mockResolvedValue({
    text: "ok",
    artifacts: [],
  });
  resolveProviderAdapterMock.mockImplementation(
    resolveProviderAdapterImpl({ openai: true, anthropic: true, gemini: true }),
  );
  resolveConfiguredLlmRuntimeMock.mockResolvedValue({
    runtime: { provider: "openai" },
    agentId: "test",
    deterministic: false,
  });
  const mod = await import("../route");
  POST = mod.POST;
});

describe("/api/llm-bridge cinatra_llm routing", () => {
  // -------------------------------------------------------------------------
  // 1. BACK-COMPAT
  // -------------------------------------------------------------------------
  it("BACK-COMPAT: body without cinatra_llm dispatches without preferredProvider", async () => {
    const res = await POST(makeReq({ user: "hello" }));
    expect(res.status).toBe(200);
    expect(runResolvedSkillAwareDeterministicLlmTaskMock).toHaveBeenCalledTimes(1);
    const call = firstDispatchCallArg();
    expect(call.preferredProvider).toBeUndefined();
    expect(call.preferredModel).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 2. HONOR-PROVIDER — honors preferredProvider when adapter is available
  // -------------------------------------------------------------------------
  it("HONOR-PROVIDER: preferredProvider=gemini with adapter available routes to gemini", async () => {
    const res = await POST(
      makeReq({ user: "hello", cinatra_llm: { preferredProvider: "gemini" } }),
    );
    expect(res.status).toBe(200);
    const call = firstDispatchCallArg();
    expect(call.preferredProvider).toBe("gemini");
  });

  // -------------------------------------------------------------------------
  // 3. SOFT-FALLBACK — preferred unavailable + no capability = default + warn
  // -------------------------------------------------------------------------
  it("SOFT-FALLBACK: gemini unavailable AND no capabilityRequired → default + single warn", async () => {
    resolveProviderAdapterMock.mockImplementation(
      resolveProviderAdapterImpl({ openai: true, anthropic: true, gemini: false }),
    );
    const res = await POST(
      makeReq({ user: "hello", cinatra_llm: { preferredProvider: "gemini" } }),
    );
    expect(res.status).toBe(200);
    // Soft fallback → caller passes NO preferredProvider; orchestration helper
    // takes the legacy default path.
    const call = firstDispatchCallArg();
    expect(call.preferredProvider).toBeUndefined();
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    const warnCall = consoleWarnSpy.mock.calls[0];
    expect(warnCall).toBeDefined();
    expect(warnCall?.[0]).toMatch(/preferredProvider/);
    expect(warnCall?.[1]).toBe("gemini");
  });

  // -------------------------------------------------------------------------
  // 4. HARD-503 — preferred unavailable + capability set = 503
  // -------------------------------------------------------------------------
  it("HARD-503: gemini unavailable AND capabilityRequired=media_input → 503 capability_unsatisfiable", async () => {
    resolveProviderAdapterMock.mockImplementation(
      resolveProviderAdapterImpl({ openai: true, anthropic: true, gemini: false }),
    );
    const res = await POST(
      makeReq({
        user: "hello",
        cinatra_llm: {
          preferredProvider: "gemini",
          capabilityRequired: "media_input",
        },
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("capability_unsatisfiable");
    expect(body.code).toBe("CAPABILITY_UNSATISFIABLE");
    expect(runResolvedSkillAwareDeterministicLlmTaskMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. CAP-MISMATCH-503 — only OpenAI available, capability requires Gemini
  // -------------------------------------------------------------------------
  it("CAP-MISMATCH-503: capabilityRequired=media_input AND only openai available → 503", async () => {
    resolveProviderAdapterMock.mockImplementation(
      resolveProviderAdapterImpl({ openai: true, anthropic: false, gemini: false }),
    );
    const res = await POST(
      makeReq({
        user: "hello",
        cinatra_llm: { capabilityRequired: "media_input" },
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("capability_unsatisfiable");
    expect(body.capability).toBe("media_input");
  });

  // -------------------------------------------------------------------------
  // 6. NATIVE_MCP_UNSATISFIABLE — Gemini cannot satisfy native_mcp
  // -------------------------------------------------------------------------
  it("NATIVE_MCP_UNSATISFIABLE: preferredProvider=gemini AND capabilityRequired=native_mcp → 503", async () => {
    // gemini IS available; capability gate still rejects because gemini
    // does NOT qualify for native_mcp per the capability matrix.
    resolveProviderAdapterMock.mockImplementation(
      resolveProviderAdapterImpl({ openai: false, anthropic: false, gemini: true }),
    );
    const res = await POST(
      makeReq({
        user: "hello",
        cinatra_llm: {
          preferredProvider: "gemini",
          capabilityRequired: "native_mcp",
        },
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("capability_unsatisfiable");
    expect(body.capability).toBe("native_mcp");
  });

  // -------------------------------------------------------------------------
  // 7. MODEL-MISMATCH-400 — Anthropic model on OpenAI provider
  // -------------------------------------------------------------------------
  it("MODEL-MISMATCH-400: preferredProvider=openai with claude-sonnet-4-6 → 400", async () => {
    const res = await POST(
      makeReq({
        user: "hello",
        cinatra_llm: {
          preferredProvider: "openai",
          preferredModel: "claude-sonnet-4-6",
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("model_provider_mismatch");
    expect(body.code).toBe("MODEL_PROVIDER_MISMATCH");
    expect(body.preferredModel).toBe("claude-sonnet-4-6");
    expect(body.effectiveProvider).toBe("openai");
  });

  // -------------------------------------------------------------------------
  // 8. POSITIVE-FUNCTION-TOOLS-DEFAULT
  //    capability-only routing where ALL three providers qualify.
  // -------------------------------------------------------------------------
  it("POSITIVE-FUNCTION-TOOLS-DEFAULT: capabilityRequired=function_tools picks any compatible", async () => {
    // All three providers available; capability is broad. Route picks the
    // first one in LLM_PROVIDERS declaration order that satisfies it.
    const res = await POST(
      makeReq({
        user: "hello",
        cinatra_llm: { capabilityRequired: "function_tools" },
      }),
    );
    expect(res.status).toBe(200);
    const call = firstDispatchCallArg();
    // Must be one of the three; the route's iteration order is openai first
    // per LLM_PROVIDERS, but the test asserts the union to keep the contract
    // implementation-flexible.
    expect(["openai", "anthropic", "gemini"]).toContain(call.preferredProvider);
  });

  // -------------------------------------------------------------------------
  // 9. POSITIVE_NATIVE_MCP_DEFAULT
  //    capability-only routing; native_mcp is narrow — gemini doesn't qualify.
  // -------------------------------------------------------------------------
  it("POSITIVE_NATIVE_MCP_DEFAULT: capabilityRequired=native_mcp picks openai or anthropic", async () => {
    // gemini is available but does NOT satisfy native_mcp. Route must
    // skip it and pick openai or anthropic.
    const res = await POST(
      makeReq({
        user: "hello",
        cinatra_llm: { capabilityRequired: "native_mcp" },
      }),
    );
    expect(res.status).toBe(200);
    const call = firstDispatchCallArg();
    expect(["openai", "anthropic"]).toContain(call.preferredProvider);
    expect(call.preferredProvider).not.toBe("gemini");
  });

  // -------------------------------------------------------------------------
  // 10. POSITIVE-MEDIA-INPUT-DEFAULT
  //     capability-only routing; media_input ONLY by Gemini.
  // -------------------------------------------------------------------------
  it("POSITIVE-MEDIA-INPUT-DEFAULT: capabilityRequired=media_input picks gemini", async () => {
    // Only Gemini qualifies. Route must skip openai/anthropic even though
    // they are configured-available — they cannot satisfy media_input.
    const res = await POST(
      makeReq({
        user: "hello",
        cinatra_llm: { capabilityRequired: "media_input" },
      }),
    );
    expect(res.status).toBe(200);
    const call = firstDispatchCallArg();
    expect(call.preferredProvider).toBe("gemini");
  });
});
