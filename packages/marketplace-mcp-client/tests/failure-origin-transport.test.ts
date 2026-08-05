// REAL-TRANSPORT proof that `classifyMarketplaceFailure` separates "the
// marketplace was never reached" from "a response arrived and then went wrong"
// (cinatra#2218 L2b).
//
// The sibling suite (`http-client.test.ts`) mocks the MCP client so it can assert
// wiring; that makes it unable to prove the one distinction the offline-rename
// gate's fail-OPEN branch actually turns on, because BOTH sides of it surface as
// a bare `TypeError`:
//
//   nothing listening                         -> TypeError "fetch failed"
//   HTTP 200 + headers, body dies mid-read    -> TypeError "terminated"
//
// Measured, both of them, against a real socket. An `instanceof TypeError` rule
// would call the second one unreachable and let a REACHABLE marketplace relax
// the rename gate. So this suite drives the REAL `Client` +
// `StreamableHTTPClientTransport` against a local server — no module mock, no
// network — and asserts the classification the transport actually produces.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { classifyMarketplaceFailure, createHttpMarketplaceMcpClient } from "../src/http-client";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * A base URL nothing is listening on — an ephemeral port bound and then closed,
 * so the connection is genuinely REFUSED (`cause.code === "ECONNREFUSED"`).
 *
 * Not a low fixed port: Node's fetch rejects port 1 with `cause: "bad port"`
 * BEFORE attempting a connection, which is a local input fault dressed up as a
 * network error and would make this test pass without exercising a real socket.
 */
async function closedPortBaseUrl(): Promise<string> {
  const server = http.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/** Read one JSON-RPC frame off the request. */
async function readMessage(req: http.IncomingMessage): Promise<{ id?: unknown; method?: string }> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: unknown; method?: string };
  } catch {
    return {};
  }
}

/** Run one real client call against `baseUrl` and classify whatever it throws. */
async function classifyRealCall(baseUrl: string): Promise<string> {
  try {
    await createHttpMarketplaceMcpClient({ baseUrl }).vendorApplicationStatus();
    return "no-throw";
  } catch (err) {
    return classifyMarketplaceFailure(err);
  }
}

describe("classifyMarketplaceFailure — against the real transport", () => {
  it("classifies a genuine connect failure as unreachable", async () => {
    // A real refused socket (ECONNREFUSED): the fetch() call itself rejects and
    // no response was ever seen, which is the ONLY thing the classifier accepts
    // as proof. This is the cinatra#396 offline-instance case the rename gate is
    // allowed to fail OPEN on.
    expect(await classifyRealCall(await closedPortBaseUrl())).toBe("unreachable");
  }, 30_000);

  it("does NOT classify a socket loss as unreachable once an EARLIER request in the same call was answered", async () => {
    // The negotiation probe gets a real HTTP 400 answer, then the connection is
    // refused for everything after it. The marketplace demonstrably answered
    // during this call, so the later loss proves nothing about reachability — a
    // per-request brand with no memory would report "unreachable" here and fail
    // the rename gate OPEN.
    let answeredProbe = false;
    const server = http.createServer(async (req, res) => {
      const msg = await readMessage(req);
      if (msg.method === "server/discover") {
        answeredProbe = true;
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32600, message: "Invalid Request: Missing Mcp-Session-Id header" },
          }),
        );
        // Everything after the probe finds the port closed.
        setImmediate(() => server.close());
        return;
      }
      res.writeHead(500).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const origin = await classifyRealCall(baseUrl);

    expect(answeredProbe).toBe(true);
    expect(origin).not.toBe("unreachable");
  }, 30_000);

  it("does NOT classify a mid-body stream failure as unreachable — HTTP 200 was received", async () => {
    // THE FAIL-OPEN HAZARD. The server answers the negotiation probe, then
    // returns a real 200 with headers and a declared content-length, and dies
    // part-way through the body. undici raises `TypeError: terminated` — the same
    // CLASS as a connect failure, from a demonstrably reachable marketplace.
    const baseUrl = await listen(async (req, res) => {
      const msg = await readMessage(req);
      if (msg.method === "server/discover") {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32600, message: "Invalid Request: Missing Mcp-Session-Id header" },
          }),
        );
        return;
      }
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "sid-1",
        "content-length": "4096",
      });
      res.write('{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-06-18"');
      setTimeout(() => res.socket?.destroy(), 20);
    });

    expect(await classifyRealCall(baseUrl)).toBe("indeterminate");
  }, 30_000);

  it("classifies a reachable HTTP 503 as peer-response", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" }).end("service unavailable");
    });

    expect(await classifyRealCall(baseUrl)).toBe("peer-response");
  }, 30_000);

  it("classifies a reachable JSON-RPC error as peer-response", async () => {
    const baseUrl = await listen(async (req, res) => {
      const msg = await readMessage(req);
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sid-1" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "probe", version: "1" },
              capabilities: { tools: {} },
            },
          }),
        );
        return;
      }
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32603, message: "internal error" },
        }),
      );
    });

    expect(await classifyRealCall(baseUrl)).toBe("peer-response");
  }, 30_000);

  it("does NOT classify a malformed 200 body as unreachable", async () => {
    const baseUrl = await listen(async (req, res) => {
      const msg = await readMessage(req);
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" }).end("{not json");
    });

    expect(await classifyRealCall(baseUrl)).toBe("indeterminate");
  }, 30_000);
});
