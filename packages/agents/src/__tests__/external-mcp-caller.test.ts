// Consumer-contract + negotiation-option lock for the external MCP caller
// (cinatra#2218 L2c).
//
// This file pins what CALLERS depend on and what the SDK is HANDED. The proof
// that the handed options actually reach the intended revision on the wire is
// the sibling `external-mcp-caller-negotiation.test.ts`, which drives the same
// exported function against a real `@modelcontextprotocol/server@2.0.0` peer
// over real HTTP — these two are complementary and neither replaces the other.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type ClientCtorArgs = [
  { name: string; version: string },
  { versionNegotiation?: unknown } | undefined,
];
type TransportCtorArgs = [URL, Record<string, unknown> | undefined];

const clientCtorCalls: ClientCtorArgs[] = [];
const transportCtorCalls: TransportCtorArgs[] = [];
const connectCalls: unknown[] = [];
const listToolsCalls: unknown[] = [];
let closeCount = 0;

/** Per-test script: what each constructed client does on connect / listTools. */
let script: Array<{ tools?: Array<{ name: string }>; connectError?: Error; listError?: Error }> = [];
let clientIndex = 0;

vi.mock("@modelcontextprotocol/client", () => {
  class StreamableHTTPClientTransport {
    constructor(url: URL, options?: Record<string, unknown>) {
      transportCtorCalls.push([url, options]);
    }
  }
  class Client {
    private readonly _index: number;
    constructor(info: { name: string; version: string }, options?: { versionNegotiation?: unknown }) {
      clientCtorCalls.push([info, options]);
      this._index = clientIndex++;
    }
    async connect(_transport: unknown, options?: unknown) {
      connectCalls.push(options);
      const step = script[this._index];
      if (step?.connectError) throw step.connectError;
    }
    async listTools(_params?: unknown, options?: unknown) {
      listToolsCalls.push(options);
      const step = script[this._index];
      if (step?.listError) throw step.listError;
      return { tools: step?.tools ?? [] };
    }
    async close() {
      closeCount++;
    }
  }
  return { Client, StreamableHTTPClientTransport };
});

/** The module deliberately uses undici's fetch, not `globalThis.fetch`. */
const undiciFetchArgs: Array<[unknown, RequestInit | undefined]> = [];
const undiciFetchSpy = vi.fn(async (url: unknown, init?: RequestInit) => {
  undiciFetchArgs.push([url, init]);
  return new Response("{}");
});
vi.mock("undici", () => ({ fetch: (url: unknown, init?: RequestInit) => undiciFetchSpy(url, init) }));

const listEnabledGlobalExternalMcpServers = vi.fn();
const resolveExternalMcpServerBearer = vi.fn();

vi.mock("@/lib/external-mcp-registry", () => ({
  listEnabledGlobalExternalMcpServers: () => listEnabledGlobalExternalMcpServers(),
  resolveExternalMcpServerBearer: (row: unknown) => resolveExternalMcpServerBearer(row),
}));

function row(id: string, label: string, serverUrl = `https://peer-${id}.example/mcp`) {
  return { id, label, serverUrl, nangoConnectionId: null, scope: "global", enabled: true };
}

async function load() {
  return import("../external-mcp-caller");
}

/**
 * `import()` must be resolved BEFORE the fake clock is driven, or the dynamic
 * import itself never settles.
 */
async function fetchNamesUnderFakeTimers(): Promise<string[]> {
  const { fetchExternalMcpToolNames } = await load();
  return fetchExternalMcpToolNames();
}

beforeEach(() => {
  clientCtorCalls.length = 0;
  transportCtorCalls.length = 0;
  connectCalls.length = 0;
  listToolsCalls.length = 0;
  closeCount = 0;
  clientIndex = 0;
  script = [];
  listEnabledGlobalExternalMcpServers.mockReset().mockReturnValue([]);
  resolveExternalMcpServerBearer.mockReset().mockResolvedValue(undefined);
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// THE TRAP: versionNegotiation must be an OBJECT. A bare string leaves
// `options?.mode` undefined and the client silently selects its legacy default,
// producing a fully working client that never negotiated.
// ---------------------------------------------------------------------------
describe("versionNegotiation is an object in { mode: 'auto' } form", () => {
  it("hands the Client an options OBJECT whose mode is exactly 'auto'", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([row("a", "Peer A")]);
    script = [{ tools: [{ name: "alpha" }] }];

    const { fetchExternalMcpToolNames } = await load();
    await fetchExternalMcpToolNames();

    expect(clientCtorCalls).toHaveLength(1);
    const negotiation = clientCtorCalls[0][1]?.versionNegotiation as { mode?: unknown };

    // Not a bare string — the whole point.
    expect(typeof negotiation).toBe("object");
    expect(negotiation).not.toBeNull();
    expect(typeof negotiation).not.toBe("string");
    // The mode itself, read off the object the constructor received.
    expect(negotiation.mode).toBe("auto");
    // ...and specifically NOT the SDK default a bare string would have selected.
    expect(negotiation.mode).not.toBe("legacy");
    expect(negotiation).toEqual({ mode: "auto" });
  });

  it("passes the SAME negotiation object to every peer in the walk", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([
      row("a", "Peer A"),
      row("b", "Peer B"),
      row("c", "Peer C"),
    ]);
    script = [{ tools: [] }, { tools: [] }, { tools: [] }];

    const { fetchExternalMcpToolNames } = await load();
    await fetchExternalMcpToolNames();

    expect(clientCtorCalls).toHaveLength(3);
    for (const [, options] of clientCtorCalls) {
      expect(options?.versionNegotiation).toEqual({ mode: "auto" });
    }
  });
});

// ---------------------------------------------------------------------------
// Credential handling — the use-gated mint must stay at exactly one per row.
// ---------------------------------------------------------------------------
describe("credential wiring", () => {
  it("resolves the bearer ONCE per row and carries it as a static header", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([row("a", "Peer A")]);
    resolveExternalMcpServerBearer.mockResolvedValue("tok-123");
    script = [{ tools: [{ name: "alpha" }] }];

    const { fetchExternalMcpToolNames } = await load();
    await fetchExternalMcpToolNames();

    // Exactly one audited, use-gated mint for the whole connection.
    expect(resolveExternalMcpServerBearer).toHaveBeenCalledTimes(1);

    const options = transportCtorCalls[0][1] as {
      requestInit?: { headers?: Record<string, string> };
      authProvider?: unknown;
    };
    expect(options.requestInit?.headers).toEqual({ Authorization: "Bearer tok-123" });
    // NOT through `authProvider`: its `token()` runs before EVERY HTTP request,
    // which would multiply the audited mints per row.
    expect(options.authProvider).toBeUndefined();
  });

  it("omits requestInit entirely when the row has no bearer", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([row("a", "Peer A")]);
    resolveExternalMcpServerBearer.mockResolvedValue(undefined);
    script = [{ tools: [] }];

    const { fetchExternalMcpToolNames } = await load();
    await fetchExternalMcpToolNames();

    const options = transportCtorCalls[0][1] as { requestInit?: unknown };
    expect(options.requestInit).toBeUndefined();
  });

  it("proceeds without auth when the identity store throws", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([row("a", "Peer A")]);
    resolveExternalMcpServerBearer.mockRejectedValue(new Error("nango down"));
    script = [{ tools: [{ name: "alpha" }] }];

    const { fetchExternalMcpToolNames } = await load();
    await expect(fetchExternalMcpToolNames()).resolves.toEqual(["alpha"]);

    const options = transportCtorCalls[0][1] as { requestInit?: unknown };
    expect(options.requestInit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The per-server budget. `requestInit.signal` is INERT on this transport (the
// transport overwrites it), so the budget must ride the custom `fetch` and the
// protocol-level timeout. Wall-clock proof against a black-hole peer is in the
// negotiation test; this pins the wiring.
// ---------------------------------------------------------------------------
describe("per-server timeout budget", () => {
  it("does NOT rely on requestInit.signal, and merges the deadline through the custom fetch", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([row("a", "Peer A")]);
    resolveExternalMcpServerBearer.mockResolvedValue("tok-123");
    script = [{ tools: [] }];

    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    undiciFetchSpy.mockClear();

    const { fetchExternalMcpToolNames } = await load();
    await fetchExternalMcpToolNames();

    expect(timeoutSpy).toHaveBeenCalledWith(5_000);

    const options = transportCtorCalls[0][1] as {
      fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
      requestInit?: { signal?: unknown };
    };

    // The INERT channel is deliberately NOT used for the budget: the transport
    // builds its init as `{ ...requestInit, method, headers, signal }`, so a
    // signal placed here is overwritten and bounds nothing.
    expect(options.requestInit?.signal).toBeUndefined();

    // The HONOURED channel: drive the transport's fetch and confirm a deadline
    // reaches the underlying request even when the transport supplies none.
    expect(typeof options.fetch).toBe("function");
    await options.fetch!("https://peer-a.example/mcp", { method: "POST" });
    const bare = undiciFetchSpy.mock.calls.at(-1)?.[1];
    expect(bare?.signal).toBeInstanceOf(AbortSignal);
    expect(bare?.method).toBe("POST");
  });

  it("COMBINES the deadline with a transport-supplied signal rather than dropping either", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([row("a", "Peer A")]);
    script = [{ tools: [] }];
    undiciFetchSpy.mockClear();

    const { fetchExternalMcpToolNames } = await load();
    await fetchExternalMcpToolNames();

    const options = transportCtorCalls[0][1] as {
      fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>;
    };

    // The transport always supplies its own abort signal; the wrapper must not
    // discard it (that would leak connections past `client.close()`).
    const transportAbort = new AbortController();
    await options.fetch!("https://peer-a.example/mcp", {
      method: "GET",
      signal: transportAbort.signal,
    });
    const merged = undiciFetchSpy.mock.calls.at(-1)?.[1]?.signal as AbortSignal;
    expect(merged).toBeInstanceOf(AbortSignal);
    expect(merged).not.toBe(transportAbort.signal);
    expect(merged.aborted).toBe(false);

    transportAbort.abort();
    expect(merged.aborted).toBe(true);
  });

  it("bounds CREDENTIAL RESOLUTION too — a stalled identity store does not hold the walk open", async () => {
    vi.useFakeTimers();
    try {
      listEnabledGlobalExternalMcpServers.mockReturnValue([row("a", "Peer A"), row("b", "Peer B")]);
      // Row A's use-gate never settles. It takes no abort signal, so without an
      // explicit race the per-server budget would not start until it returned.
      resolveExternalMcpServerBearer
        .mockImplementationOnce(() => new Promise<string>(() => {}))
        .mockResolvedValue("tok-b");
      script = [{ tools: [{ name: "beta" }] }];
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      const walk = fetchNamesUnderFakeTimers();
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(walk).resolves.toEqual(["beta"]);

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("[external-mcp-caller] skipping Peer A:"),
      );
      expect(log).toHaveBeenCalledWith(expect.stringContaining("per-server budget"));
      // The stalled row never reached the transport; the next row still ran.
      expect(clientCtorCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the protocol-level timeout to both connect and listTools", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([row("a", "Peer A")]);
    script = [{ tools: [] }];

    const { fetchExternalMcpToolNames } = await load();
    await fetchExternalMcpToolNames();

    expect(connectCalls[0]).toEqual({ timeout: 5_000 });
    expect(listToolsCalls[0]).toEqual({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// The consumer contract: handleAgentBuilderCompile depends on exactly these
// three properties. They are unchanged across the migration.
// ---------------------------------------------------------------------------
describe("consumer contract (handleAgentBuilderCompile)", () => {
  it("returns [] when no rows are registered, without constructing a client", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([]);

    const { fetchExternalMcpToolNames } = await load();
    await expect(fetchExternalMcpToolNames()).resolves.toEqual([]);
    expect(clientCtorCalls).toHaveLength(0);
  });

  it("returns [] rather than throwing when ENUMERATING the rows fails", async () => {
    // The registry read is a synchronous Postgres query and can throw. Left
    // uncaught it escapes to handleAgentBuilderCompile's catch, which reports
    // `Compile failed: …` — i.e. an unrelated registry outage would fail the
    // compile, contradicting the "never block compilation" intent at that site.
    listEnabledGlobalExternalMcpServers.mockImplementation(() => {
      throw new Error("could not connect to database");
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const { fetchExternalMcpToolNames } = await load();
    await expect(fetchExternalMcpToolNames()).resolves.toEqual([]);

    expect(log).toHaveBeenCalledWith(
      "[external-mcp-caller] skipping all external servers: could not connect to database",
    );
    expect(clientCtorCalls).toHaveLength(0);
  });

  it("deduplicates across servers and preserves first-seen order", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([row("a", "Peer A"), row("b", "Peer B")]);
    script = [
      { tools: [{ name: "alpha" }, { name: "beta" }] },
      { tools: [{ name: "beta" }, { name: "gamma" }] },
    ];

    const { fetchExternalMcpToolNames } = await load();
    await expect(fetchExternalMcpToolNames()).resolves.toEqual(["alpha", "beta", "gamma"]);
  });

  it("filters falsy tool names", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([row("a", "Peer A")]);
    script = [{ tools: [{ name: "alpha" }, { name: "" }, { name: "beta" }] }];

    const { fetchExternalMcpToolNames } = await load();
    await expect(fetchExternalMcpToolNames()).resolves.toEqual(["alpha", "beta"]);
  });

  it("NEVER throws: a failing server is logged and skipped, and the walk continues", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([
      row("a", "Peer A"),
      row("b", "Peer B"),
      row("c", "Peer C"),
    ]);
    script = [
      { connectError: new Error("Version negotiation probe timed out after 5000ms") },
      { tools: [{ name: "beta" }] },
      { listError: new Error("Error POSTing to endpoint: 503") },
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const { fetchExternalMcpToolNames } = await load();
    await expect(fetchExternalMcpToolNames()).resolves.toEqual(["beta"]);

    expect(log).toHaveBeenCalledWith(
      "[external-mcp-caller] skipping Peer A: Version negotiation probe timed out after 5000ms",
    );
    expect(log).toHaveBeenCalledWith(
      "[external-mcp-caller] skipping Peer C: Error POSTing to endpoint: 503",
    );
  });

  it("returns [] rather than throwing when every server fails", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([row("a", "Peer A"), row("b", "Peer B")]);
    script = [{ connectError: new Error("fetch failed") }, { connectError: new Error("fetch failed") }];
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { fetchExternalMcpToolNames } = await load();
    await expect(fetchExternalMcpToolNames()).resolves.toEqual([]);
  });

  it("stringifies a non-Error rejection into the same log shape", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([row("a", "Peer A")]);
    script = [{ connectError: "boom" as unknown as Error }];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const { fetchExternalMcpToolNames } = await load();
    await expect(fetchExternalMcpToolNames()).resolves.toEqual([]);
    expect(log).toHaveBeenCalledWith("[external-mcp-caller] skipping Peer A: boom");
  });

  it("closes the client on the success path AND on the failure path", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([row("a", "Peer A"), row("b", "Peer B")]);
    script = [{ tools: [{ name: "alpha" }] }, { listError: new Error("nope") }];
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { fetchExternalMcpToolNames } = await load();
    await fetchExternalMcpToolNames();

    expect(closeCount).toBe(2);
  });

  it("skips a row with an unparseable serverUrl without aborting the walk", async () => {
    listEnabledGlobalExternalMcpServers.mockReturnValue([
      row("a", "Peer A", "not a url"),
      row("b", "Peer B"),
    ]);
    script = [{ tools: [{ name: "beta" }] }];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const { fetchExternalMcpToolNames } = await load();
    await expect(fetchExternalMcpToolNames()).resolves.toEqual(["beta"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[external-mcp-caller] skipping Peer A:"));
  });
});

// ---------------------------------------------------------------------------
// Deletion lock — callExternalMcpTool was removed rather than migrated. It had
// no call site anywhere in the repo, is not re-exported from the package
// barrel, and is not reachable through @cinatra-ai/agents' `exports` map.
// ---------------------------------------------------------------------------
describe("callExternalMcpTool deletion", () => {
  it("is no longer part of this module's export surface", async () => {
    const mod = await load();
    expect(Object.keys(mod)).toEqual(["fetchExternalMcpToolNames"]);
    expect("callExternalMcpTool" in mod).toBe(false);
  });
});
