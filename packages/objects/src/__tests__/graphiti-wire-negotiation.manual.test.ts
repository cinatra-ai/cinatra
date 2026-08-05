// Wire-level negotiation proof for the graphiti MCP client (cinatra#2218 L2a).
//
// This is the RE-RUNNABLE probe behind the `{ mode: "legacy" }` decision in
// graphiti-client.ts. It is not a stub: it drives the real exported functions
// against a real graphiti container and reads the frames off the wire through
// an in-process recording proxy, so the negotiated era is OBSERVED rather than
// asserted from a package version.
//
// It is gated behind RUN_GRAPHITI_WIRE_PROOF=1 because it needs the pinned
// container running. Bring it up and run it with:
//
//   docker compose up -d neo4j graphiti
//   RUN_GRAPHITI_WIRE_PROOF=1 GRAPHITI_UPSTREAM_URL=http://127.0.0.1:8000 \
//     pnpm --filter @cinatra-ai/objects exec vitest run \
//     src/__tests__/graphiti-wire-negotiation.manual.test.ts
//
// RE-RUN THIS WHEN THE GRAPHITI IMAGE PIN MOVES. If a future image answers
// `server/discover`, the "auto reaches the same legacy era" expectation below
// fails — and that failure is the signal to flip graphiti-client.ts to
// `{ mode: "auto" }` and move the contract row in
// docs/internals/contracts/mcp-supported-revisions.md.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// graphiti-client.ts imports `server-only`, which throws outside a Server
// Component. It uses none of its exports, so stubbing it is behaviour-neutral.
vi.mock("server-only", () => ({}));

const SHOULD_RUN = process.env.RUN_GRAPHITI_WIRE_PROOF === "1";
const UPSTREAM = process.env.GRAPHITI_UPSTREAM_URL ?? "http://127.0.0.1:8000";

type Frame = {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  body: string;
  status: number;
};

const frames: Frame[] = [];
let proxy: http.Server;

/**
 * Records every request the client puts on the wire and forwards it verbatim
 * to the real graphiti container. Streams the response body through untouched
 * so SSE framing is preserved.
 */
async function startRecordingProxy(): Promise<string> {
  proxy = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");

    const requestHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") requestHeaders[k.toLowerCase()] = v;
    }

    const forwarded = { ...req.headers } as Record<string, string>;
    delete forwarded.host;
    delete forwarded["content-length"];

    let upstream: Response;
    try {
      upstream = await fetch(`${UPSTREAM}${req.url}`, {
        method: req.method,
        headers: forwarded,
        body: body.length ? body : undefined,
        redirect: "manual",
      });
    } catch (err) {
      frames.push({ method: req.method ?? "", url: req.url ?? "", requestHeaders, body, status: 0 });
      res.writeHead(502).end(String(err));
      return;
    }

    frames.push({
      method: req.method ?? "",
      url: req.url ?? "",
      requestHeaders,
      body,
      status: upstream.status,
    });

    const outHeaders: Record<string, string> = {};
    for (const [k, v] of upstream.headers.entries()) {
      if (["content-encoding", "content-length", "transfer-encoding"].includes(k)) continue;
      outHeaders[k] = v;
    }
    res.writeHead(upstream.status, outHeaders);
    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  });

  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const methodsOf = (f: Frame[]) =>
  f
    .filter((x) => x.body)
    .map((x) => {
      try {
        return (JSON.parse(x.body) as { method?: string }).method ?? "";
      } catch {
        return "";
      }
    })
    .filter(Boolean);

describe.runIf(SHOULD_RUN)("graphiti outbound revision negotiation (live wire)", () => {
  beforeAll(async () => {
    process.env.GRAPHITI_URL = await startRecordingProxy();
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  it("completes a real round trip and negotiates the 2025-era handshake, with no server/discover", async () => {
    frames.length = 0;
    const { getStatus } = await import("../graphiti-client");
    const result = await getStatus();

    // A real request/response round trip against the pinned image.
    expect(result.status).toBe("connected");

    const methods = methodsOf(frames);
    // The legacy sequence, and only the legacy sequence.
    expect(methods).toContain("initialize");
    expect(methods).toContain("notifications/initialized");
    expect(methods).toContain("tools/call");
    // `{ mode: "legacy" }` must NOT probe. If this ever fails, the mode
    // regressed to `auto` (or a pin) without the contract row moving.
    expect(methods).not.toContain("server/discover");

    const initialize = frames.find((f) => f.body.includes('"method":"initialize"'));
    expect(initialize).toBeDefined();
    // The offered revision comes from the SDK, not from a cinatra constant.
    expect(initialize?.body).toContain('"protocolVersion":"2025-11-25"');

    // No modern-era `_meta` envelope is attached on a legacy connection.
    expect(initialize?.body).not.toContain("io.modelcontextprotocol/protocolVersion");
  }, 60_000);

  it("proves the peer REQUIRES the session handshake — a bare tools/list is refused", async () => {
    const res = await fetch(`${UPSTREAM}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    // This is why the surface is legacy: the pinned image is a sessionful
    // 2025-era peer. The session id it mints stays SDK-managed and
    // transport-private — cinatra never reads or authorizes on it (AC4).
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error?: { code?: number } };
    expect(payload.error?.code).toBe(-32600);
  }, 30_000);

  it("records that the pinned image does NOT support 2026-07-28 — auto falls back to legacy", async () => {
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    frames.length = 0;

    const transport = new StreamableHTTPClientTransport(
      new URL(`${process.env.GRAPHITI_URL}/mcp`),
      { requestInit: { signal: AbortSignal.timeout(30_000) } },
    );
    const client = new Client(
      { name: "cinatra-objects", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    try {
      await client.connect(transport);
      // THE MEASUREMENT behind the explicit-legacy decision: `auto` reaches
      // the SAME era, so it buys nothing here.
      expect(client.getProtocolEra()).toBe("legacy");
      expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");

      // ...and it costs a rejected probe. When a future image pin answers
      // this probe, THIS assertion is the one that flips.
      const probe = frames.find((f) => f.body.includes('"method":"server/discover"'));
      expect(probe).toBeDefined();
      expect(probe?.status).toBe(400);
      expect(probe?.requestHeaders["mcp-protocol-version"]).toBe("2026-07-28");
    } finally {
      await client.close().catch(() => {});
    }
  }, 60_000);
});
