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

// ---------------------------------------------------------------------------
// #3109 - one 2.5s probe with no retry decided the whole turn. A single slow
// answer (cold name lookup, first connection after an idle period, one dropped
// packet) refused the turn and then poisoned the next 15 seconds of turns with
// a cached verdict. These pin the behaviours that fix it: the probe retries a
// TIMEOUT with a fresh budget, the failure classes are recorded apart, and a
// timeout verdict does not keep the next turns from asking again.
// ---------------------------------------------------------------------------

function timeoutError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

function refusedError(detail = "connect ECONNREFUSED mcp.example.test port 443"): Error {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = new Error(detail);
  return err;
}

describe("checkPublicMcpReachability retries a timeout (#3109)", () => {
  it("one timeout then a live answer is REACHABLE - a single slow moment does not cost the turn", async () => {
    fetchMock.mockRejectedValueOnce(timeoutError()).mockResolvedValueOnce(new Response(null, { status: 405 }));
    const result = await checkPublicMcpReachability();
    expect(result).toEqual({ status: "reachable", url: "https://mcp.example.test/api/mcp" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives the retry a FRESH budget - not the remains of the attempt that timed out", async () => {
    fetchMock.mockRejectedValueOnce(timeoutError()).mockResolvedValueOnce(new Response(null, { status: 200 }));
    await checkPublicMcpReachability();
    const first = fetchMock.mock.calls[0]?.[1] as { signal?: unknown } | undefined;
    const second = fetchMock.mock.calls[1]?.[1] as { signal?: unknown } | undefined;
    expect(first?.signal).toBeDefined();
    expect(second?.signal).toBeDefined();
    expect(second?.signal).not.toBe(first?.signal);
  });

  it("repeated timeouts still refuse, loudly, after the whole attempt budget is spent", async () => {
    fetchMock.mockRejectedValue(timeoutError());
    const result = await checkPublicMcpReachability();
    expect(result.status).toBe("unreachable");
    if (result.status === "unreachable") expect(result.kind).toBe("timeout");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an immediate connection refusal refuses at once - a retry cannot un-refuse a closed port", async () => {
    fetchMock.mockRejectedValue(refusedError());
    const result = await checkPublicMcpReachability();
    expect(result.status).toBe("unreachable");
    if (result.status === "unreachable") expect(result.kind).toBe("refused");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a timeout followed by a refusal records the REFUSAL - the conclusive answer wins", async () => {
    fetchMock.mockRejectedValueOnce(timeoutError()).mockRejectedValueOnce(refusedError());
    const result = await checkPublicMcpReachability();
    expect(result.status).toBe("unreachable");
    if (result.status === "unreachable") {
      expect(result.kind).toBe("refused");
      expect(result.reason).toContain("ECONNREFUSED");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a healthy address still costs exactly one probe", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    expect((await checkPublicMcpReachability()).status).toBe("reachable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("the failure classes are recorded apart (#3109)", () => {
  it("records a different kind AND a different reason for a timeout than for a refusal", async () => {
    fetchMock.mockRejectedValue(timeoutError());
    const timedOut = await checkPublicMcpReachability();

    _resetPublicMcpReachabilityCacheForTests();
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(refusedError("getaddrinfo ENOTFOUND mcp.example.test"));
    const refused = await checkPublicMcpReachability();

    expect(timedOut.status).toBe("unreachable");
    expect(refused.status).toBe("unreachable");
    if (timedOut.status !== "unreachable" || refused.status !== "unreachable") return;
    expect(timedOut.kind).toBe("timeout");
    expect(refused.kind).toBe("refused");
    expect(timedOut.reason).not.toBe(refused.reason);
    expect(timedOut.reason).toMatch(/no response within \d+ms/);
    expect(refused.reason).toContain("ENOTFOUND");
  });

  it("a transport failure that is NEITHER is not written down as a refusal", async () => {
    // A TLS failure is not a closed port and not a slow moment. Recording it
    // as "connection refused or name not resolved" would put a false sentence
    // in the log an operator reads afterwards.
    const tls = new TypeError("fetch failed");
    (tls as { cause?: unknown }).cause = new Error("unable to verify the first certificate");
    fetchMock.mockRejectedValue(tls);

    const result = await checkPublicMcpReachability();
    expect(result.status).toBe("unreachable");
    if (result.status !== "unreachable") return;
    expect(result.kind).toBe("error");
    expect(result.reason).toContain("certificate");
    expect(result.reason).not.toContain("refused");
    // Not a timeout either, so it is not retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("a timeout verdict does not poison the next turns (#3109)", () => {
  it("expires in seconds, where a refusal is still held - the classes do not age alike", async () => {
    fetchMock.mockRejectedValue(timeoutError());
    expect((await checkPublicMcpReachability()).status).toBe("unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Under the old flat 15s negative cache the whole of this window served
    // the stale verdict; nothing re-checked the address for 15 seconds.
    vi.advanceTimersByTime(6_000);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await checkPublicMcpReachability()).status).toBe("reachable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("costs a black-holed address ONE probe pair per short window, not one per turn", async () => {
    fetchMock.mockRejectedValue(timeoutError());
    expect((await checkPublicMcpReachability()).status).toBe("unreachable");
    const afterFirstTurn = fetchMock.mock.calls.length;

    // Three more turns arrive back to back inside the short window: they are
    // answered from the cache rather than each paying the whole attempt budget.
    vi.advanceTimersByTime(500);
    await checkPublicMcpReachability();
    await checkPublicMcpReachability();
    await checkPublicMcpReachability();
    expect(fetchMock).toHaveBeenCalledTimes(afterFirstTurn);
  });

  it("still caches a REFUSED verdict for 15s - a dead port is not re-probed every turn", async () => {
    fetchMock.mockRejectedValue(refusedError());
    expect((await checkPublicMcpReachability()).status).toBe("unreachable");
    vi.advanceTimersByTime(10_000);
    expect((await checkPublicMcpReachability()).status).toBe("unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
