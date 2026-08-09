import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Route-handler regression test for POST /configuration/mcp/llm-access/test
// (llm-providers S2 truth cleanup, cinatra#1713 AC4, epic #1711).
//
// Asserts the declared-capability gate that replaced the fake Gemini
// `call_cinatra_mcp` function-declaration "MCP" diagnostic:
//   - a provider whose declared matrix does not satisfy native_mcp (gemini)
//     is refused with an honest 400 BEFORE any credential lookup — never a
//     fabricated non-MCP request presented as an MCP test;
//   - a declared-native provider (openai) passes the gate and proceeds to the
//     existing credential preflight;
//   - non-admin sessions stay 401; unknown providers stay "Invalid provider".
//
// `canProviderSatisfyCapability` is mocked to the build-known matrix shape
// (gemini → false, openai/anthropic → true); the matrix data itself is covered
// by the packages/agents policy-leaf tests.
//
// PLUS (cinatra#2579): the key-validation probe itself — valid key, invalid
// key, transport failure. Each case asserts the user-facing result AND that
// the probe cannot schedule an agent run: no provider COMPLETION endpoint is
// ever called, and no outbound request carries `tools` / `mcp_servers` /
// `require_approval` (the remote-MCP loop that made every "Test" click cost
// real, uncounted money).
// ---------------------------------------------------------------------------

const getAuthSession = vi.fn();
const getLlmMcpCredentials = vi.fn();
const getPublicMcpServerUrl = vi.fn();
const canProviderSatisfyCapability = vi.fn();
const getLlmProviderSurface = vi.fn();
const authHandler = vi.fn();
const emitUsageEvent = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
}));
vi.mock("@/lib/auth", () => ({
  auth: { handler: (req: Request) => authHandler(req) },
}));
vi.mock("@cinatra-ai/llm", () => ({
  getLlmMcpCredentials: (p: string) => getLlmMcpCredentials(p),
  getPublicMcpServerUrl: () => getPublicMcpServerUrl(),
}));
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getLocalTokenEndpointUrl: () => "http://local.test/api/auth/token",
  getLocalMcpServerUrl: () => "http://local.test/api/mcp",
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn(() => null),
  getLlmProviderSurface: (p: string) => getLlmProviderSurface(p),
}));
vi.mock("@cinatra-ai/agents", () => ({
  canProviderSatisfyCapability: (p: string, c: string) => canProviderSatisfyCapability(p, c),
}));
vi.mock("@cinatra-ai/metric-usage-api", () => ({
  emitUsageEvent: (e: unknown) => emitUsageEvent(e),
}));

import { POST } from "../route";

// Obviously-fake placeholders — never a real credential shape anyone could use.
const FAKE_OPENAI_KEY = "sk-FAKE-TEST-KEY-not-a-real-secret";
const FAKE_ANTHROPIC_KEY = "sk-ant-FAKE-TEST-KEY-not-a-real-secret";

function adminSession() {
  return { user: { id: "admin-1", role: "admin" } };
}
function testReq(body: unknown): Request {
  return new Request("https://app.test/configuration/mcp/llm-access/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /configuration/mcp/llm-access/test — native-MCP capability gate", () => {
  beforeEach(() => {
    getAuthSession.mockResolvedValue(adminSession());
    // Build-known matrix shape: gemini does not satisfy native_mcp.
    canProviderSatisfyCapability.mockImplementation(
      (provider: string, capability: string) => capability === "native_mcp" && provider !== "gemini",
    );
    getLlmMcpCredentials.mockReturnValue(null);
    getPublicMcpServerUrl.mockReturnValue(null);
    getLlmProviderSurface.mockReturnValue(null);
  });
  afterEach(() => vi.clearAllMocks());

  it("401s without an admin session", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "u1", role: "member" } });
    const res = await POST(testReq({ provider: "openai" }));
    expect(res.status).toBe(401);
  });

  it("400s an unknown provider", async () => {
    const res = await POST(testReq({ provider: "mystery" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Invalid provider");
  });

  it("refuses gemini honestly on the declared matrix, before any credential lookup", async () => {
    const res = await POST(testReq({ provider: "gemini" }));
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("does not support native MCP");
    expect(error).toContain("declared");
    // The gate fires before the credential preflight — no lookup happened.
    expect(getLlmMcpCredentials).not.toHaveBeenCalled();
    // And the refusal consulted the declared capability matrix.
    expect(canProviderSatisfyCapability).toHaveBeenCalledWith("gemini", "native_mcp");
  });

  it("admits a declared-native provider (openai) through to the credential preflight", async () => {
    const res = await POST(testReq({ provider: "openai" }));
    // Gate passed; the pre-existing credential check answers instead.
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("No MCP credentials stored");
    expect(getLlmMcpCredentials).toHaveBeenCalledWith("openai");
  });
});

// ---------------------------------------------------------------------------
// cinatra#2579 — the validation probe is cheap, direct and counted.
// ---------------------------------------------------------------------------

describe("POST /configuration/mcp/llm-access/test — key validation probe (cinatra#2579)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let listAvailableModels: ReturnType<typeof vi.fn>;
  let getDefaultModel: ReturnType<typeof vi.fn>;

  /** Every outbound HTTP call the route made, in order. */
  function fetchCalls(): Array<{ url: string; init: RequestInit }> {
    return fetchSpy.mock.calls.map(([url, init]) => ({
      url: String(url),
      init: (init ?? {}) as RequestInit,
    }));
  }

  /**
   * The structural "no agent run was created" assertion.
   *
   * An agent run here is scheduled PROVIDER-SIDE: the old probe posted a chat
   * request carrying a remote-MCP tool with `require_approval: "never"`, which
   * licenses the provider to run a multi-step tool-calling loop against the
   * Cinatra MCP server. A probe that never posts to a completion endpoint and
   * never carries a tool/MCP-server field cannot start one.
   */
  function expectNoAgentRunScheduled() {
    // The probe never SELECTS a model. `conn.defaultModel ?? "gpt-4o"` was the
    // first line of the old agentic path, so a validation that reads no model
    // at all cannot regress into one. (The connector's catalog reader ships in
    // its own repo; what this suite pins is the ROUTE's half of the ABI: one
    // `listAvailableModels({})` call — a `Promise<string[]>` catalog member —
    // and no model, message or tool ever handed to the connector.)
    expect(getDefaultModel).not.toHaveBeenCalled();
    for (const { url, init } of fetchCalls()) {
      expect(url).not.toMatch(/\/v1\/(responses|messages|chat\/completions)/);
      expect(String(init.method ?? "GET").toUpperCase()).toBe("GET");
      const body = init.body === undefined || init.body === null ? "" : String(init.body);
      expect(body).toBe("");
      expect(body).not.toContain("require_approval");
      expect(body).not.toContain("mcp_servers");
      expect(body).not.toContain("tools");
    }
  }

  /** The probe is recorded through the usage seam — zero tokens, zero cost. */
  function expectCountedOnce(provider: string) {
    expect(emitUsageEvent).toHaveBeenCalledTimes(1);
    const event = emitUsageEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(event).toMatchObject({
      source: "llm",
      provider,
      operation: "generate",
      agentLabel: "llm-access-key-validation",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    });
    expect(typeof event.idempotencyKey).toBe("string");
    expect(typeof event.occurredAt).toBe("string");
  }

  beforeEach(() => {
    getAuthSession.mockResolvedValue(adminSession());
    canProviderSatisfyCapability.mockImplementation(
      (provider: string, capability: string) => capability === "native_mcp" && provider !== "gemini",
    );
    getLlmMcpCredentials.mockReturnValue({
      clientId: "mcp-client-id",
      clientSecret: "mcp-client-secret-FAKE",
      scope: "mcp:read",
    });
    getPublicMcpServerUrl.mockReturnValue("https://public.test/api/mcp");
    authHandler.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "FAKE-TEST-ACCESS-TOKEN" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    listAvailableModels = vi.fn();
    getDefaultModel = vi.fn(() => "gpt-4o");
    getLlmProviderSurface.mockImplementation((provider: string) =>
      provider === "openai"
        ? {
            providerId: "openai",
            getConfiguredConnection: async () => ({ apiKey: FAKE_OPENAI_KEY, defaultModel: "gpt-4o" }),
            listAvailableModels,
            getDefaultModel,
          }
        : {
            // The installed Anthropic connector exposes no catalog reader.
            providerId: "anthropic",
            getConfiguredConnection: async () => ({ apiKey: FAKE_ANTHROPIC_KEY }),
            getDefaultModel,
          },
    );
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("valid key → 200 with the catalog result, counted once, no agent run scheduled", async () => {
    listAvailableModels.mockResolvedValue(["gpt-4o-mini", "gpt-4o", "o3"]);

    const res = await POST(testReq({ provider: "openai" }));

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      request: Record<string, unknown>;
      response: { ok: boolean; keyValidation: { ok: boolean; modelCount: number; sampleModels: string[] } };
    };
    expect(payload.response.ok).toBe(true);
    expect(payload.response.keyValidation).toMatchObject({ ok: true, modelCount: 3 });
    expect(payload.response.keyValidation.sampleModels).toContain("gpt-4o");
    expect(payload.request.method).toBe("GET");

    // The connector's own cheap catalog reader did the work — one call, no
    // model, no tools, no MCP server anywhere in the diagnostic.
    expect(listAvailableModels).toHaveBeenCalledTimes(1);
    expect(listAvailableModels).toHaveBeenCalledWith({});
    expect(JSON.stringify(payload)).not.toMatch(/require_approval|mcp_servers|"tools"/);
    // ...and the live bearer token is never echoed back to the admin modal.
    expect(JSON.stringify(payload)).not.toContain("FAKE-TEST-ACCESS-TOKEN");
    expect(fetchSpy).not.toHaveBeenCalled();
    expectNoAgentRunScheduled();
    expectCountedOnce("openai");
  });

  it("invalid key → 502 carrying the provider's own rejection, counted, no agent run scheduled", async () => {
    listAvailableModels.mockRejectedValue(new Error("Incorrect API key provided."));

    const res = await POST(testReq({ provider: "openai" }));

    expect(res.status).toBe(502);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("OpenAI API key could not be validated");
    expect(error).toContain("Incorrect API key provided.");
    expectNoAgentRunScheduled();
    expectCountedOnce("openai");
  });

  it("network failure → 502 naming the transport error, no agent run scheduled", async () => {
    listAvailableModels.mockRejectedValue(new TypeError("fetch failed"));

    const res = await POST(testReq({ provider: "openai" }));

    expect(res.status).toBe(502);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("could not be validated");
    expect(error).toContain("fetch failed");
    expectNoAgentRunScheduled();
    expectCountedOnce("openai");
  });

  it("an EMPTY catalog is not a pass — it proves nothing about the key", async () => {
    listAvailableModels.mockResolvedValue([]);

    const res = await POST(testReq({ provider: "openai" }));

    expect(res.status).toBe(502);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("no models are available to this key");
    expectNoAgentRunScheduled();
    expectCountedOnce("openai");
  });

  it("a connector without a catalog reader falls back to the same cheap models endpoint (GET, no body)", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-5" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await POST(testReq({ provider: "anthropic" }));

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      response: { keyValidation: { modelCount: number } };
    };
    expect(payload.response.keyValidation.modelCount).toBe(1);

    const calls = fetchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/v1/models");
    expect(calls[0].init.method).toBe("GET");
    // Key presence is asserted by SHAPE only — never its value.
    const headers = calls[0].init.headers as Record<string, string>;
    expect(Object.keys(headers)).toContain("x-api-key");
    expect(headers["x-api-key"].length).toBeGreaterThan(0);
    expectNoAgentRunScheduled();
    expectCountedOnce("anthropic");
  });

  it("a provider-side rejection on the fallback probe surfaces as a 502, still counted", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await POST(testReq({ provider: "anthropic" }));

    expect(res.status).toBe(502);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("Anthropic API key could not be validated");
    expect(error).toContain("invalid x-api-key");
    expectNoAgentRunScheduled();
    expectCountedOnce("anthropic");
  });
});
