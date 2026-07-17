/**
 * checkPublicMcpReachability (#1699) — the dead-ingress guard for the public
 * MCP URL. Pins the semantics the chat attach path relies on:
 *   - ANY HTTP response (401/405/3xx included) = reachable — liveness only,
 *     the MCP endpoint auth-gates real calls;
 *   - network-level failure / timeout = unreachable, with a human-readable
 *     reason (undici buries the useful message in error.cause);
 *   - no configured URL = unconfigured (the pre-existing loud path);
 *   - results are TTL-cached (60s live / 15s dead) and keyed to the URL, so
 *     an operator fixing the tunnel or changing the URL is picked up quickly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// Isolate mcp-access from its heavy @/ + external-MCP module graph — none of
// it is exercised by the reachability probe.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: [],
}));
vi.mock("@/lib/external-mcp-toolbox-loader.server", () => ({
  loadExternalMcpToolboxBySlug: vi.fn(),
  sanitizeExternalMcpToolboxTools: vi.fn(),
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildSingleExternalMcpTool: vi.fn(),
}));
vi.mock("@/lib/llm-toolbox-providers", () => ({
  buildAllToolboxProviderTools: vi.fn(),
}));

const { getPublicMcpServerUrlMock } = vi.hoisted(() => ({
  getPublicMcpServerUrlMock: vi.fn<() => string | null>(() => "https://mcp.example.test/api/mcp"),
}));

vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getPublicMcpServerUrl: getPublicMcpServerUrlMock,
  getLlmMcpCredentials: () => null,
  getLocalTokenEndpointUrl: () => "https://local.example.test/api/auth/token",
  getLocalMcpServerUrl: () => "https://local.example.test/api/mcp",
  hasLlmMcpAccess: () => true,
  getLlmMcpAccessStatus: () => "ok",
}));

import { checkPublicMcpReachability, _resetPublicMcpReachabilityCacheForTests } from "../mcp-access";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-16T20:00:00Z"));
  _resetPublicMcpReachabilityCacheForTests();
  getPublicMcpServerUrlMock.mockReturnValue("https://mcp.example.test/api/mcp");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("checkPublicMcpReachability", () => {
  it("treats ANY HTTP response as reachable — even a 405 from a POST-only route", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 405 }));
    const result = await checkPublicMcpReachability();
    expect(result).toEqual({ status: "reachable", url: "https://mcp.example.test/api/mcp" });
  });

  it("reports unreachable with the underlying cause on network failure", async () => {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = new Error("getaddrinfo ENOTFOUND cinatra-main.tail8a34f1.ts.net");
    fetchMock.mockRejectedValue(err);
    const result = await checkPublicMcpReachability();
    expect(result.status).toBe("unreachable");
    if (result.status === "unreachable") {
      expect(result.reason).toContain("ENOTFOUND");
      expect(result.url).toBe("https://mcp.example.test/api/mcp");
    }
  });

  it("maps a probe timeout to a clear reason", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeout);
    const result = await checkPublicMcpReachability();
    expect(result.status).toBe("unreachable");
    if (result.status === "unreachable") expect(result.reason).toMatch(/no response within \d+ms/);
  });

  it("returns unconfigured (and does not probe) when no URL is set", async () => {
    getPublicMcpServerUrlMock.mockReturnValue(null);
    const result = await checkPublicMcpReachability();
    expect(result).toEqual({ status: "unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches a live answer for 60s, then re-probes", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await checkPublicMcpReachability();
    await checkPublicMcpReachability();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    await checkPublicMcpReachability();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-probes a dead answer after 15s so tunnel recovery is picked up quickly", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect((await checkPublicMcpReachability()).status).toBe("unreachable");

    vi.advanceTimersByTime(10_000);
    expect((await checkPublicMcpReachability()).status).toBe("unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6_000);
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await checkPublicMcpReachability()).status).toBe("reachable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates the cache when the configured URL changes", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await checkPublicMcpReachability();
    getPublicMcpServerUrlMock.mockReturnValue("https://other.example.test/api/mcp");
    const result = await checkPublicMcpReachability();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    if (result.status === "reachable") expect(result.url).toBe("https://other.example.test/api/mcp");
  });
});
