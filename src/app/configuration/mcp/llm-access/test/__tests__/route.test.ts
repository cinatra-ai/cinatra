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
// ---------------------------------------------------------------------------

const getAuthSession = vi.fn();
const getLlmMcpCredentials = vi.fn();
const getPublicMcpServerUrl = vi.fn();
const canProviderSatisfyCapability = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
}));
vi.mock("@/lib/auth", () => ({
  auth: { handler: vi.fn() },
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
  getLlmProviderSurface: () => undefined,
}));
vi.mock("@cinatra-ai/agents", () => ({
  canProviderSatisfyCapability: (p: string, c: string) => canProviderSatisfyCapability(p, c),
}));

import { POST } from "../route";

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
