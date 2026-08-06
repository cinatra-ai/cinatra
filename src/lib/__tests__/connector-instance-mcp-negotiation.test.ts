import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  callConnectorInstanceMcpTool,
  defaultConnectorInstanceMcpClientFactory,
  listConnectorInstanceMcpTools,
} from "@/lib/connector-instance-mcp-transport";

/**
 * cinatra#2218 L2d — negotiation + session-privacy proof for the
 * connector-instance transport on `@modelcontextprotocol/client@2.0.0`.
 *
 * PROOF CLASS, stated per leg rather than implied:
 *
 *  * **Sessionful (2025-era) leg — RECORDED FRAMES over real HTTP.** The peer
 *    below is not a mock of our own client: it is a `node:http` server that
 *    replays the pinned WordPress mcp-adapter 0.5.0's ACTUAL frames, READ AT
 *    RUN TIME out of the committed CI capture
 *    `tests/e2e/wp-mcp-gateway/captures/annotations-a-raw-tools-list.json`
 *    (produced by `.github/workflows/wp-mcp-gateway-capture.yml` against the
 *    digest-pinned fixture). The REAL exported transport functions drive the
 *    REAL client library over a real socket against those frames.
 *  * **Modern (2026-07-28) leg — REAL-LIBRARY LOOPBACK.** A real
 *    `@modelcontextprotocol/server@2.0.0`, resolved through Node's own resolver
 *    from `packages/mcp-server` (it is not a root dependency), answers
 *    `server/discover`. Both ends are the reference TypeScript implementation —
 *    that is the honest ceiling for a peer class cinatra does not yet have.
 *  * **The live pinned adapter** is exercised by
 *    `connector-instance-mcp-wire-negotiation.manual.test.ts`, gated behind
 *    `RUN_CONNECTOR_WIRE_PROOF=1` because it needs the booted fixture. The
 *    always-on live leg rides the existing CI capture workflow.
 *
 * Everything below reads the negotiated era OFF THE WIRE — never from a package
 * version, and never from an assertion about our own source.
 */

// ---------------------------------------------------------------------------
// Frame recorder shared by both peers.
// ---------------------------------------------------------------------------

type Frame = {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: unknown;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

/** The JSON-RPC method(s) a recorded frame carried, flattened over batches. */
function methodsOf(frame: Frame): string[] {
  const body = frame.body;
  const list = Array.isArray(body) ? body : [body];
  return list
    .map((m) => (m && typeof m === "object" ? (m as { method?: unknown }).method : undefined))
    .filter((m): m is string => typeof m === "string");
}

// ---------------------------------------------------------------------------
// Peer A — the sessionful 2025-era WordPress mcp-adapter, replayed.
//
// Every response body below is the adapter's own, loaded from the committed
// capture rather than transcribed. The three behaviours that make it a SESSIONFUL 2025-era peer, and
// which the capture records:
//
//   * a session-less `tools/list` is answered HTTP 400 with JSON-RPC -32600
//     "Invalid Request: Missing Mcp-Session-Id header";
//   * `initialize` is answered HTTP 200 and MINTS an `Mcp-Session-Id`;
//   * every subsequent request must carry that header back.
//
// The `server/discover` probe the `{ mode: 'auto' }` negotiator sends is not a
// method this adapter knows, so it falls into the same session gate and is
// refused identically — which is exactly what the live fixture does (verified
// on 2026-08-05, quoted in the PR body).
// ---------------------------------------------------------------------------

type CaptureTranscript = {
  request: { method?: string };
  status: number;
  rawText: string;
  sessionId: string | null;
};

/**
 * The peer's frames are READ FROM the committed capture at run time rather than
 * transcribed into this file, so the replayed peer cannot drift from what the
 * pinned adapter actually answered — if a future capture cycle records different
 * frames, this suite replays the new ones.
 */
const CAPTURE = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "tests", "e2e", "wp-mcp-gateway", "captures", "annotations-a-raw-tools-list.json"),
    "utf8",
  ),
) as { defaultServer: { transcripts: CaptureTranscript[] } };

function capturedFrame(method: string, status: number): { body: Record<string, unknown>; sessionId: string | null } {
  const hit = CAPTURE.defaultServer.transcripts.find((t) => t.request?.method === method && t.status === status);
  if (!hit) throw new Error(`capture has no ${method} transcript with status ${status}`);
  return { body: JSON.parse(hit.rawText) as Record<string, unknown>, sessionId: hit.sessionId };
}

/** HTTP 400 / JSON-RPC -32600, as recorded for a session-less `tools/list`. */
const WP_MISSING_SESSION = capturedFrame("tools/list", 400).body;
/** The `initialize` result the adapter actually returned (it selects the
 * revision itself — the capture records `2025-06-18` for the offer the capture
 * producer made; the live re-verification on 2026-08-05 shows it echoing
 * `2025-11-25` when the client offers that instead). */
const WP_INITIALIZE_RESULT = (capturedFrame("initialize", 200).body as { result: Record<string, unknown> }).result;
/** The tool rows the adapter actually listed. */
const WP_TOOLS = (
  (capturedFrame("tools/list", 200).body as { result: { tools: Array<Record<string, unknown>> } }).result
).tools;

type LegacyPeer = {
  url: string;
  frames: Frame[];
  /** Session ids the peer MINTED. Never handed to the application under test. */
  mintedSessionIds: string[];
  close: () => Promise<void>;
};

async function startLegacyWordPressPeer(options?: { callResult?: unknown }): Promise<LegacyPeer> {
  const frames: Frame[] = [];
  const mintedSessionIds: string[] = [];
  let counter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const raw = await readBody(req);
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const frame: Frame = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: { ...(req.headers as Record<string, string | undefined>) },
        body,
      };
      frames.push(frame);

      // The 2025 session operations the adapter exposes on the same route.
      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }
      if (req.method === "GET") {
        // The adapter serves a standalone stream; answering 405 is inside the
        // transport's swallowed `onerror` path and keeps the socket free.
        res.writeHead(405, { Allow: "POST, GET, DELETE" }).end();
        return;
      }

      const messages = Array.isArray(body) ? body : [body];
      const first = messages[0] as { method?: string; id?: unknown } | undefined;
      const method = first?.method;
      const sessionHeader = req.headers["mcp-session-id"];

      const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res
          .writeHead(status, { "Content-Type": "application/json; charset=UTF-8", ...headers })
          .end(JSON.stringify(payload));
      };

      if (method === "initialize") {
        const sessionId = `wp-session-${++counter}-4f2a9c0d`;
        mintedSessionIds.push(sessionId);
        json(200, { jsonrpc: "2.0", id: first?.id, result: WP_INITIALIZE_RESULT }, { "Mcp-Session-Id": sessionId });
        return;
      }

      // THE SESSION GATE. Everything else — including the modern
      // `server/discover` probe — is refused without the header.
      if (!sessionHeader) {
        json(400, { ...WP_MISSING_SESSION, id: first?.id ?? null });
        return;
      }

      if (method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (method === "tools/list") {
        json(200, { jsonrpc: "2.0", id: first?.id, result: { tools: WP_TOOLS } });
        return;
      }
      if (method === "tools/call") {
        json(200, {
          jsonrpc: "2.0",
          id: first?.id,
          result: options?.callResult ?? {
            content: [],
            structuredContent: { success: true, data: { site: "https://example.test" } },
          },
        });
        return;
      }
      json(200, { jsonrpc: "2.0", id: first?.id, result: {} });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/wp-json/mcp/mcp-adapter-default-server`,
    frames,
    mintedSessionIds,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Peer B — a REAL @modelcontextprotocol/server@2.0.0 on the modern revision.
// ---------------------------------------------------------------------------

type ModernPeer = { url: string; frames: Frame[]; close: () => Promise<void> };

/**
 * `@modelcontextprotocol/server` is a dependency of `packages/mcp-server`, not
 * of the root, so a bare import would not resolve here. Resolving it through
 * Node's own resolver from that workspace gets the REAL package — importing a
 * stub instead would make the whole modern leg vacuous.
 */
async function loadRealMcpServer(): Promise<Record<string, unknown>> {
  const require_ = createRequire(path.join(process.cwd(), "packages", "mcp-server", "package.json"));
  const resolved = require_.resolve("@modelcontextprotocol/server");
  return (await import(/* @vite-ignore */ resolved)) as Record<string, unknown>;
}

async function startModernPeer(): Promise<ModernPeer> {
  const mod = await loadRealMcpServer();
  const McpServer = (mod.McpServer ?? (mod as { default?: Record<string, unknown> }).default?.McpServer) as
    | (new (info: unknown, options?: unknown) => {
        registerTool: (name: string, config: unknown, handler: (args: unknown) => unknown) => void;
        connect: (transport: unknown) => Promise<void>;
      })
    | undefined;
  // `createMcpHandler` returns `{ fetch, notify, bus, close }` — the request
  // entry point is `.fetch`, not the object itself.
  const createMcpHandler = (mod.createMcpHandler ??
    (mod as { default?: Record<string, unknown> }).default?.createMcpHandler) as
    | ((factory: () => unknown, options?: unknown) => { fetch: (request: Request) => Promise<Response> })
    | undefined;

  if (!McpServer || !createMcpHandler) {
    throw new Error(
      `the real @modelcontextprotocol/server did not expose McpServer/createMcpHandler — exports seen: ${Object.keys(
        mod,
      )
        .slice(0, 40)
        .join(", ")}`,
    );
  }

  const { fetch: handler } = createMcpHandler(() => {
    const server = new McpServer({ name: "modern-peer", version: "1.0.0" });
    server.registerTool(
      "mcp-adapter-execute-ability",
      { description: "modern peer echo", inputSchema: {} },
      () => ({ content: [], structuredContent: { success: true, data: { era: "modern" } } }),
    );
    return server;
  });

  const frames: Frame[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const raw = await readBody(req);
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      frames.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: { ...(req.headers as Record<string, string | undefined>) },
        body,
      });

      const { port } = server.address() as AddressInfo;
      const request = new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) =>
          typeof v === "string" ? ([[k, v]] as [string, string][]) : [],
        ),
        ...(raw ? { body: raw } : {}),
      });
      const response = await handler(request);
      const text = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => (headers[k] = v));
      res.writeHead(response.status, headers).end(text);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    frames,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------

describe("connector-instance transport — sessionful 2025-era leg (recorded WP adapter frames)", () => {
  let peer: LegacyPeer;

  beforeAll(async () => {
    peer = await startLegacyWordPressPeer();
  });
  afterAll(async () => {
    await peer.close();
  });

  it("issues the `server/discover` probe, is refused, and falls back to `initialize`", async () => {
    const tools = await listConnectorInstanceMcpTools({ endpoint: peer.url, authHeader: "Basic dGVzdDp0ZXN0" });
    expect(tools.map((t) => t.name)).toEqual([
      "mcp-adapter-discover-abilities",
      "mcp-adapter-get-ability-info",
      "mcp-adapter-execute-ability",
    ]);

    const methods = peer.frames.flatMap(methodsOf);
    // THE PROBE WAS ACTUALLY SENT — this is the bare-string trap's negative:
    // written as `versionNegotiation: 'auto'` no probe appears here at all.
    expect(methods).toContain("server/discover");
    // ...and the legacy handshake ran after it was refused.
    expect(methods).toContain("initialize");
    expect(methods).toContain("tools/list");
    // `server/discover` came FIRST — the probe precedes the fallback.
    expect(methods.indexOf("server/discover")).toBeLessThan(methods.indexOf("initialize"));
  });

  it("carries the host-resolved Authorization header on every frame (requestInit.headers is honoured)", async () => {
    const before = peer.frames.length;
    await listConnectorInstanceMcpTools({ endpoint: peer.url, authHeader: "Basic dGVzdDp0ZXN0" });
    const fresh = peer.frames.slice(before);
    expect(fresh.length).toBeGreaterThan(0);
    for (const frame of fresh) {
      expect(frame.headers.authorization).toBe("Basic dGVzdDp0ZXN0");
    }
  });

  it("the peer's session id is minted, replayed by the LIBRARY, and never asked for by cinatra", async () => {
    const before = peer.mintedSessionIds.length;
    await callConnectorInstanceMcpTool({
      endpoint: peer.url,
      authHeader: "Basic dGVzdDp0ZXN0",
      name: "mcp-adapter-execute-ability",
      arguments: { ability_name: "core/get-site-info", parameters: {} },
    });
    // A session WAS established — the peer requires one.
    expect(peer.mintedSessionIds.length).toBeGreaterThan(before);
    const sessionId = peer.mintedSessionIds.at(-1)!;
    // ...and the client library replayed it on the post-handshake frames,
    // which is what "SDK-managed" means.
    const replayed = peer.frames.filter((f) => f.headers["mcp-session-id"] === sessionId);
    expect(replayed.length).toBeGreaterThan(0);
  });
});

describe("connector-instance transport — modern (2026-07-28) leg (real server@2.0.0 loopback)", () => {
  let peer: ModernPeer;

  beforeAll(async () => {
    peer = await startModernPeer();
  });
  afterAll(async () => {
    await peer.close();
  });

  it("negotiates UP: `server/discover` succeeds, and NO `initialize` and NO session header appear", async () => {
    const result = await callConnectorInstanceMcpTool({
      endpoint: peer.url,
      authHeader: "Basic dGVzdDp0ZXN0",
      name: "mcp-adapter-execute-ability",
      arguments: {},
    });
    expect(result).toEqual({ success: true, data: { era: "modern" } });

    const methods = peer.frames.flatMap(methodsOf);
    expect(methods).toContain("server/discover");
    // The retired 2025 handshake never happens against a modern peer.
    expect(methods).not.toContain("initialize");
    expect(methods).not.toContain("notifications/initialized");
    // No protocol session exists on this era at all.
    for (const frame of peer.frames) {
      expect(frame.headers["mcp-session-id"]).toBeUndefined();
    }
    // The revision is read OFF THE WIRE, from the headers the client emitted.
    const versions = peer.frames.map((f) => f.headers["mcp-protocol-version"]).filter(Boolean);
    expect(versions).toContain("2026-07-28");
  });

  it("this is per-peer negotiation, not a global flip — the same module reached BOTH eras", async () => {
    // The legacy peer above settled on the 2025 handshake in the same process,
    // from the same `{ mode: 'auto' }` constant. That is the property
    // `{ mode: 'legacy' }` could not have and why this surface is on `auto`.
    const legacy = await startLegacyWordPressPeer();
    try {
      await listConnectorInstanceMcpTools({ endpoint: legacy.url, authHeader: "Basic dGVzdDp0ZXN0" });
      expect(legacy.frames.flatMap(methodsOf)).toContain("initialize");
      expect(peer.frames.flatMap(methodsOf)).not.toContain("initialize");
    } finally {
      await legacy.close();
    }
  });
});

describe("connector-instance transport — the one behaviour `{ mode: 'auto' }` changes", () => {
  it("a peer that answers the PROBE with 5xx fails to connect, and fails CLOSED", async () => {
    // Recorded rather than hidden. `classifyHttpError` in the negotiator treats
    // `status >= 500` on the probe as a typed connect error
    // (`EraNegotiationFailed`), NOT as a legacy verdict — so a peer that 500s on
    // every unknown method now fails to connect where `{ mode: 'legacy' }` would
    // have skipped the probe and handshaked.
    //
    // A 4xx does NOT behave this way: the pinned WordPress adapter's 400 is
    // parsed as a JSON-RPC error and resolves to a legacy verdict, which is the
    // case every test above exercises. The real-world exposure is therefore a
    // peer whose ingress answers 5xx to unknown methods, and the outcome is the
    // fail-CLOSED `transport_error` (-> `catalog_unavailable`), never the
    // relaxed `unreachable`.
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        await readBody(req);
        res.writeHead(500, { "Content-Type": "text/plain" }).end("upstream boom");
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        listConnectorInstanceMcpTools({
          endpoint: `http://127.0.0.1:${port}/mcp`,
          authHeader: "Basic dGVzdDp0ZXN0",
        }),
      ).rejects.toMatchObject({ code: "transport_error", httpStatus: 500 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 4 — the session id NEVER leaves the transport layer.
//
// "outbound calls to old-revision peers may use peer-required, SDK-managed
//  sessions (the client library holds the id; it stays transport-private and
//  never becomes application or authorization state)."
//
// Proven behaviourally against the sessionful peer: capture the id the peer
// actually minted, then assert it is absent from every channel by which it could
// escape — the returned value, the thrown error, and everything written to the
// console during the call.
// ---------------------------------------------------------------------------

describe("connector-instance transport — AC4: protocol session ids stay transport-private", () => {
  it("the minted session id reaches neither the RESULT nor any console output", async () => {
    const peer = await startLegacyWordPressPeer();
    const written: string[] = [];
    const console_ = globalThis.console;
    const capture =
      (): ((...args: unknown[]) => void) =>
      (...args: unknown[]) =>
        written.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    globalThis.console = {
      ...console_,
      log: capture(),
      info: capture(),
      warn: capture(),
      error: capture(),
      debug: capture(),
    } as Console;

    try {
      const result = await callConnectorInstanceMcpTool({
        endpoint: peer.url,
        authHeader: "Basic dGVzdDp0ZXN0",
        name: "mcp-adapter-execute-ability",
        arguments: { ability_name: "core/get-site-info", parameters: {} },
      });
      const tools = await listConnectorInstanceMcpTools({ endpoint: peer.url, authHeader: "Basic dGVzdDp0ZXN0" });

      expect(peer.mintedSessionIds.length).toBeGreaterThan(0);
      const haystack = JSON.stringify({ result, tools }) + "\n" + written.join("\n");
      for (const sessionId of peer.mintedSessionIds) {
        expect(haystack).not.toContain(sessionId);
      }
    } finally {
      globalThis.console = console_;
      await peer.close();
    }
  });

  it("the minted session id reaches no ERROR surfaced to the application", async () => {
    // A peer that hands out a session and then rejects every call with the
    // session id echoed in its own error text — the worst case for leakage,
    // because the id is in the material the classifier sees.
    const frames: Frame[] = [];
    const minted: string[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const raw = await readBody(req);
        const body = raw ? (JSON.parse(raw) as { method?: string; id?: unknown }) : undefined;
        frames.push({ method: req.method ?? "", url: req.url ?? "", headers: {}, body });
        if (req.method !== "POST") {
          res.writeHead(405, { Allow: "POST" }).end();
          return;
        }
        // Refuse the `{ mode: 'auto' }` probe the way a 2025-era peer does, so
        // the negotiator reaches its LEGACY verdict and the handshake runs.
        // (A 5xx here would instead be a hard `EraNegotiationFailed` connect
        // error — see the probe-5xx case below — and no session would exist.)
        if (body?.method === "server/discover") {
          res
            .writeHead(400, { "Content-Type": "application/json" })
            .end(JSON.stringify({ ...WP_MISSING_SESSION, id: body.id ?? null }));
          return;
        }
        if (body?.method === "initialize") {
          const sessionId = "leaky-session-9c1f77a2";
          minted.push(sessionId);
          res
            .writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": sessionId })
            .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: WP_INITIALIZE_RESULT }));
          return;
        }
        if (body?.method === "notifications/initialized") {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body?.id ?? null,
            error: { code: -32603, message: `internal error for session ${minted.at(-1) ?? "?"}` },
          }),
        );
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await expect(
        listConnectorInstanceMcpTools({
          endpoint: `http://127.0.0.1:${port}/mcp`,
          authHeader: "Basic dGVzdDp0ZXN0",
        }),
      ).rejects.toMatchObject({ code: "transport_error" });

      // Re-run to inspect the error object itself, in full.
      let caught: unknown;
      try {
        await listConnectorInstanceMcpTools({
          endpoint: `http://127.0.0.1:${port}/mcp`,
          authHeader: "Basic dGVzdDp0ZXN0",
        });
      } catch (e) {
        caught = e;
      }
      expect(minted.length).toBeGreaterThan(0);
      const serialised = JSON.stringify({
        message: (caught as Error)?.message,
        ...(caught as Record<string, unknown>),
        own: Object.getOwnPropertyNames(caught ?? {}).map((k) => (caught as Record<string, unknown>)[k]),
      });
      for (const sessionId of minted) {
        expect(serialised).not.toContain(sessionId);
      }
      // ...and the classifier composed its own message rather than echoing the
      // peer's, which is what keeps the id (and the credential) out.
      expect((caught as Error).message).toBe("connector instance MCP call failed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("the transport exposes NO accessor by which a session id could become app state", () => {
    const client = defaultConnectorInstanceMcpClientFactory({
      endpoint: "https://example.test/wp-json/mcp/x",
      authHeader: "Basic dGVzdDp0ZXN0",
    });
    // The injected client surface is exactly connect/callTool/listTools/close.
    // No `sessionId`, no transport handle, nothing an application layer could
    // read a protocol session off.
    expect(Object.keys(client).sort()).toEqual(["callTool", "close", "connect", "listTools", "peerAnswered"]);
    expect("sessionId" in client).toBe(false);
    // `peerAnswered` is the only reachability signal the transport publishes,
    // and it is a BOOLEAN — it reports THAT the peer answered, never anything
    // about the session it established.
    expect(typeof client.peerAnswered?.()).toBe("boolean");
    expect(client.peerAnswered?.()).toBe(false);
  });
});
