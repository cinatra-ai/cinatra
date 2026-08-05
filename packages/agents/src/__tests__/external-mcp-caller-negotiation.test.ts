// Wire-level negotiation proof for the external MCP caller (cinatra#2218 L2c).
//
// PROOF CLASS: real-library loopback. Not a stub and not a recorded fixture —
// the module under test drives the real `@modelcontextprotocol/client@2.0.0`
// over real HTTP against a real `@modelcontextprotocol/server@2.0.0` peer, and
// every frame is read off the wire through an in-process recording proxy. The
// negotiated era is OBSERVED, never asserted from a package version.
//
// WHAT THIS PROOF CANNOT COVER, stated rather than implied. This surface calls
// ARBITRARY third-party MCP servers, so there is no pinned peer to probe the
// way cinatra#2218 L2a probed the graphiti image. Both ends here are the
// reference TypeScript implementation, so a peer built on a different SDK — or
// a non-conformant one — could still behave differently. A live probe against a
// real registered server would add exactly that: evidence about
// implementations cinatra did not write. It is not cheaply available, because
// the peer set is whatever an administrator has registered at run time and is
// different in every deployment; there is no fixed third-party endpoint this
// repo may call from CI. The two peer classes below are therefore the honest
// ceiling: they pin cinatra's SIDE of the negotiation against a conformant peer
// in each era.
//
// The peers run the REAL server package, loaded through Node's resolver at run
// time. `packages/agents/vitest.config.ts` aliases `@modelcontextprotocol/server`
// to a hand-written stub (its `./_shims` self-import defeats vite's
// import-analysis through a bare-package alias), so a plain import here would
// silently get the stub and the whole proof would be vacuous.
// `@modelcontextprotocol/client` — the package actually under test — is NOT
// aliased and is imported normally by the module under test.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { z } from "zod";

const listEnabledGlobalExternalMcpServers = vi.fn<() => Array<Record<string, unknown>>>();
const resolveExternalMcpServerBearer = vi.fn<() => Promise<string | undefined>>();

vi.mock("@/lib/external-mcp-registry", () => ({
  listEnabledGlobalExternalMcpServers: () => listEnabledGlobalExternalMcpServers(),
  resolveExternalMcpServerBearer: () => resolveExternalMcpServerBearer(),
}));

// ---------------------------------------------------------------------------
// Real server package, past the vitest stub alias.
// ---------------------------------------------------------------------------

type ServerModule = {
  McpServer: new (info: { name: string; version: string }) => {
    registerTool: (
      name: string,
      config: Record<string, unknown>,
      handler: () => Promise<unknown>,
    ) => void;
    connect: (transport: unknown) => Promise<void>;
  };
  WebStandardStreamableHTTPServerTransport: new (options: Record<string, unknown>) => {
    handleRequest: (request: Request, options?: { parsedBody?: unknown }) => Promise<Response>;
  };
  createMcpHandler: (
    factory: () => unknown,
    options: Record<string, unknown>,
  ) => {
    fetch: (request: Request, options?: { parsedBody?: unknown }) => Promise<Response>;
    close: () => Promise<void>;
  };
  isLegacyRequest: (request: Request, parsedBody: unknown) => Promise<boolean>;
};

let sdkServer: ServerModule;

async function loadRealServerPackage(): Promise<ServerModule> {
  const req = createRequire(import.meta.url);
  const cjsEntry = req.resolve("@modelcontextprotocol/server");
  const esmEntry = cjsEntry.replace(/\.cjs$/, ".mjs");
  return (await import(/* @vite-ignore */ pathToFileURL(esmEntry).href)) as ServerModule;
}

const PEER_TOOLS = ["peer_alpha", "peer_beta"] as const;

// NOTE: the local is named `srv`, never `server` — the authz-inventory scanner
// (scripts/build-authz-inventory.mjs) inventories REAL MCP primitives by
// matching a `registerTool` call on a variable literally named `server`, and a
// test fixture must never enter that inventory. Same guard as
// packages/mcp-server/src/__tests__/supported-revisions-inbound.test.ts.
function buildPeerServer() {
  const srv = new sdkServer.McpServer({ name: "external-peer", version: "0.0.1" });
  for (const name of PEER_TOOLS) {
    srv.registerTool(
      name,
      { title: name, description: name, inputSchema: z.object({}) },
      async () => ({ content: [{ type: "text", text: "ok" }] }),
    );
  }
  return srv;
}

/** A peer that implements 2026-07-28 and keeps the 2025-era leg available. */
async function modernPeerHandler(request: Request): Promise<Response> {
  const handler = sdkServer.createMcpHandler(() => buildPeerServer(), { legacy: "stateless" });
  const parsedBody =
    request.method === "POST" ? await request.clone().json().catch(() => undefined) : undefined;
  const response = await handler.fetch(request, { parsedBody });
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    await handler.close().catch(() => undefined);
  }
  return response;
}

/**
 * A peer that speaks the 2025 era ONLY: modern-classified traffic — including
 * the `server/discover` probe — is refused, which is what forces the client's
 * legacy fallback. Modelled on the observed behaviour of a real 2025-era peer
 * (the graphiti image answers the probe `400 / -32600`, recorded on cinatra#2218
 * L2a).
 */
async function legacyOnlyPeerHandler(request: Request): Promise<Response> {
  const srv = buildPeerServer();
  const transport = new sdkServer.WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await srv.connect(transport);

  const parsedBody =
    request.method === "POST" ? await request.clone().json().catch(() => undefined) : undefined;

  let legacy = false;
  try {
    legacy = await sdkServer.isLegacyRequest(request, parsedBody);
  } catch {
    legacy = false;
  }
  if (!legacy) {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Bad Request: 2025-era only" } },
      { status: 400 },
    );
  }
  if (request.method.toUpperCase() !== "POST") {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
      { status: 405 },
    );
  }
  return transport.handleRequest(request, { parsedBody });
}

/**
 * A hand-rolled peer that is NOT conformant, used to pin the two peer classes
 * the migration gives up. `mode` selects which non-conformance:
 *
 *  - `"no-initialize"` — answers a bare `tools/list` (with either Accept) but
 *    refuses `initialize`, so there is no era for the client to land on;
 *  - `"loose-tools"` — completes the 2025 handshake, then returns a
 *    `tools/list` result whose tools carry only `name`.
 */
function nonConformantPeerHandler(mode: "no-initialize" | "loose-tools") {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = (await request.json().catch(() => ({}))) as { method?: string; id?: unknown };

    if (message.method === "server/discover") {
      return Response.json(
        { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: "no discover" } },
        { status: 400 },
      );
    }
    if (message.method === "initialize") {
      if (mode === "no-initialize") {
        return Response.json(
          { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: "no initialize" } },
          { status: 400 },
        );
      }
      return Response.json({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "permissive", version: "1" },
        },
      });
    }
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (message.method === "tools/list") {
      // Only `name` — no `inputSchema`. The hand-rolled caller read this fine.
      return Response.json({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: { tools: [{ name: "loose_tool" }] },
      });
    }
    return Response.json(
      { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32601, message: "unknown" } },
      { status: 400 },
    );
  };
}

// ---------------------------------------------------------------------------
// Recording HTTP front end. Every frame the module puts on the wire is captured
// here before being handed to the peer.
// ---------------------------------------------------------------------------

type Frame = {
  method: string;
  status: number;
  requestHeaders: Record<string, string>;
  body: string;
  /** The JSON-RPC method in the request body, when there is one. */
  rpcMethod: string;
};

const frames: Frame[] = [];
let listener: http.Server;
let peerUrl = "";
let handleAsPeer: (request: Request) => Promise<Response> = modernPeerHandler;

async function startRecordingPeer(): Promise<string> {
  listener = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const bodyText = body.toString("utf8");

    const requestHeaders: Record<string, string> = {};
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value !== "string") continue;
      requestHeaders[key.toLowerCase()] = value;
      headers.set(key, value);
    }

    let rpcMethod = "";
    try {
      rpcMethod = (JSON.parse(bodyText) as { method?: string }).method ?? "";
    } catch {
      rpcMethod = "";
    }

    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers,
      ...(body.length ? { body } : {}),
    });

    let response: Response;
    try {
      response = await handleAsPeer(request);
    } catch (err) {
      response = new Response(String(err), { status: 500 });
    }

    frames.push({
      method: req.method ?? "",
      status: response.status,
      requestHeaders,
      body: bodyText,
      rpcMethod,
    });

    const outHeaders: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) outHeaders[key] = value;
    res.writeHead(response.status, outHeaders);
    if (!response.body) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  });

  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as AddressInfo;
  return `http://127.0.0.1:${port}/mcp`;
}

beforeAll(async () => {
  sdkServer = await loadRealServerPackage();
  peerUrl = await startRecordingPeer();
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});

beforeEach(() => {
  frames.length = 0;
  resolveExternalMcpServerBearer.mockReset().mockResolvedValue("wire-proof-token");
  listEnabledGlobalExternalMcpServers.mockReset().mockReturnValue([
    {
      id: "wire",
      label: "Wire Peer",
      serverUrl: peerUrl,
      nangoConnectionId: null,
      scope: "global",
      enabled: true,
    },
  ]);
});

const rpcMethods = () => frames.map((f) => f.rpcMethod).filter(Boolean);

describe("external MCP caller — negotiated revision, observed on the wire", () => {
  it("reaches 2026-07-28 against a modern peer, with server/discover and NO initialize", async () => {
    handleAsPeer = modernPeerHandler;

    const { fetchExternalMcpToolNames } = await import("../external-mcp-caller");
    const names = await fetchExternalMcpToolNames();

    // A real round trip: the peer's tools came back over the negotiated era.
    expect(names).toEqual([...PEER_TOOLS]);

    // The modern era is header-routed: `Mcp-Method` carries the RPC method and
    // `MCP-Protocol-Version` carries the revision, on EVERY modern request.
    const probe = frames.find((f) => f.requestHeaders["mcp-method"] === "server/discover");
    expect(probe).toBeDefined();
    expect(probe?.status).toBe(200);
    expect(probe?.requestHeaders["mcp-protocol-version"]).toBe("2026-07-28");

    const list = frames.find((f) => f.requestHeaders["mcp-method"] === "tools/list");
    expect(list).toBeDefined();
    expect(list?.status).toBe(200);
    expect(list?.requestHeaders["mcp-protocol-version"]).toBe("2026-07-28");

    // The retired exchange must not appear anywhere on a modern connection.
    expect(rpcMethods()).not.toContain("initialize");
    expect(rpcMethods()).not.toContain("notifications/initialized");

    // Two frames, no legacy fallback, no session id anywhere.
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame.requestHeaders["mcp-session-id"]).toBeUndefined();
    }
  }, 30_000);

  it("falls back to the 2025-era handshake against a legacy-only peer", async () => {
    handleAsPeer = legacyOnlyPeerHandler;

    const { fetchExternalMcpToolNames } = await import("../external-mcp-caller");
    const names = await fetchExternalMcpToolNames();

    expect(names).toEqual([...PEER_TOOLS]);

    // The probe IS issued — `{ mode: 'auto' }` always asks first — and the peer
    // refuses it. That refusal is what selects the legacy era.
    const probe = frames.find((f) => f.requestHeaders["mcp-method"] === "server/discover");
    expect(probe).toBeDefined();
    expect(probe?.status).toBe(400);

    // ...and then the plain 2025 sequence runs, offering the SDK's revision
    // rather than any cinatra-authored constant.
    const methods = rpcMethods();
    expect(methods).toContain("initialize");
    expect(methods).toContain("notifications/initialized");
    expect(methods).toContain("tools/list");

    const initialize = frames.find((f) => f.rpcMethod === "initialize");
    expect(initialize?.body).toContain('"protocolVersion":"2025-11-25"');
    // No modern `_meta` envelope may leak onto a legacy exchange.
    expect(initialize?.body).not.toContain("io.modelcontextprotocol/protocolVersion");
  }, 30_000);

  it("carries the resolved bearer on EVERY frame, including the negotiation probe", async () => {
    handleAsPeer = modernPeerHandler;

    const { fetchExternalMcpToolNames } = await import("../external-mcp-caller");
    await fetchExternalMcpToolNames();

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.requestHeaders.authorization).toBe("Bearer wire-proof-token");
    }
    // ONE use-gated mint for the whole connection, not one per HTTP request.
    expect(resolveExternalMcpServerBearer).toHaveBeenCalledTimes(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// THE BARE-STRING TRAP, observed rather than read from the source. This is the
// version of the trap that actually loses something: the peer here DOES speak
// 2026-07-28, and a bare string still lands the connection on the 2025 era —
// a fully working client that silently never negotiated.
// ---------------------------------------------------------------------------
describe("versionNegotiation must be an object", () => {
  it("a bare string silently selects legacy AGAINST A PEER THAT SUPPORTS 2026-07-28", async () => {
    handleAsPeer = modernPeerHandler;
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");

    const withObject = new Client(
      { name: "trap-probe", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    try {
      await withObject.connect(new StreamableHTTPClientTransport(new URL(peerUrl)));
      expect(withObject.getProtocolEra()).toBe("modern");
      expect(withObject.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    } finally {
      await withObject.close().catch(() => undefined);
    }

    frames.length = 0;

    const withBareString = new Client(
      { name: "trap-probe", version: "1.0.0" },
      // Deliberately wrong, and only expressible through a cast — which is the
      // guard: the module's constant is typed `VersionNegotiationOptions`, so
      // this line would not compile at the real call site.
      { versionNegotiation: "auto" as unknown as { mode: "auto" } },
    );
    try {
      await withBareString.connect(new StreamableHTTPClientTransport(new URL(peerUrl)));
      expect(withBareString.getProtocolEra()).toBe("legacy");
      expect(withBareString.getNegotiatedProtocolVersion()).toBe("2025-11-25");
      // Not one probe went out.
      expect(frames.find((f) => f.requestHeaders["mcp-method"] === "server/discover")).toBeUndefined();
    } finally {
      await withBareString.close().catch(() => undefined);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The pre-migration surface, measured — grounds "strict improvement" rather
// than asserting it. The hand-rolled caller POSTed a bare `tools/list` with
// `Accept: application/json` and no handshake.
// ---------------------------------------------------------------------------
describe("what the hand-rolled caller could and could not reach", () => {
  it("is refused 406 by a conformant 2025-era peer on the Accept header alone", async () => {
    handleAsPeer = legacyOnlyPeerHandler;

    const response = await fetch(peerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(406);
    const payload = (await response.json()) as { error?: { message?: string } };
    expect(payload.error?.message).toContain("Not Acceptable");
  }, 30_000);

  it("harvested names from a peer whose tools/list result is NOT schema-conformant", async () => {
    handleAsPeer = nonConformantPeerHandler("loose-tools");

    // Exactly what the pre-migration code did, and it worked.
    const response = await fetch(peerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const payload = (await response.json()) as { result?: { tools?: Array<{ name: string }> } };
    expect(payload.result?.tools?.map((t) => t.name)).toEqual(["loose_tool"]);
  }, 30_000);

  it("REGRESSION CLASS: that same peer now yields nothing — per-row, logged, walk continues", async () => {
    handleAsPeer = nonConformantPeerHandler("loose-tools");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const { fetchExternalMcpToolNames } = await import("../external-mcp-caller");
    await expect(fetchExternalMcpToolNames()).resolves.toEqual([]);

    // The SDK validates the RESULT against the spec schema; a tool without
    // `inputSchema` fails it and takes the whole row with it.
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("[external-mcp-caller] skipping Wire Peer:"),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("tools/list"));
    log.mockRestore();
  }, 30_000);

  it("REGRESSION CLASS: a peer that refuses `initialize` is skipped rather than silently mishandled", async () => {
    handleAsPeer = nonConformantPeerHandler("no-initialize");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const { fetchExternalMcpToolNames } = await import("../external-mcp-caller");
    await expect(fetchExternalMcpToolNames()).resolves.toEqual([]);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("[external-mcp-caller] skipping Wire Peer:"),
    );
    // The probe went out first — the surface now HAS a revision posture and a
    // diagnostic, which is the property the hand-rolled POST could not offer.
    expect(frames.find((f) => f.requestHeaders["mcp-method"] === "server/discover")).toBeDefined();
    log.mockRestore();
  }, 30_000);

  it("is refused by a modern-only-classified request path, with no negotiation error to explain it", async () => {
    handleAsPeer = legacyOnlyPeerHandler;

    // Even with the Accept header corrected, a claim-less POST can only ever be
    // classified as legacy traffic; against a peer that requires the modern
    // envelope there is nothing for the caller to fall back to, because it
    // never negotiated in the first place.
    const response = await fetch(peerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(400);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The budget, proven by wall clock against a peer that accepts the connection
// and never answers. `requestInit: { signal }` alone does NOT bound this —
// measured at ~20s (the protocol timeout) versus ~1.2s when the deadline rides
// the custom fetch. The module puts it on the custom fetch AND on the
// protocol-level `timeout`.
// ---------------------------------------------------------------------------
describe("per-server budget against an unresponsive peer", () => {
  it("gives up within the 5s budget instead of the SDK's 60s default", async () => {
    const blackHole = http.createServer(() => {
      /* accept the connection, never answer */
    });
    await new Promise<void>((resolve) => blackHole.listen(0, "127.0.0.1", resolve));
    const { port } = blackHole.address() as AddressInfo;

    listEnabledGlobalExternalMcpServers.mockReturnValue([
      {
        id: "blackhole",
        label: "Black Hole",
        serverUrl: `http://127.0.0.1:${port}/mcp`,
        nangoConnectionId: null,
        scope: "global",
        enabled: true,
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const started = Date.now();
    const { fetchExternalMcpToolNames } = await import("../external-mcp-caller");
    const names = await fetchExternalMcpToolNames();
    const elapsed = Date.now() - started;

    blackHole.close();
    log.mockRestore();

    // Contract preserved: never throws, degrades to an empty list.
    expect(names).toEqual([]);
    // Budget honoured. Generous upper bound so this measures the budget rather
    // than runner contention, but far below the 60s SDK default the inert
    // `requestInit.signal` would have left in place.
    expect(elapsed).toBeLessThan(15_000);
  }, 40_000);
});
