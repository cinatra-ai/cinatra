// Wire-level negotiation proof for the marketplace MCP client (cinatra#2218 L2b).
//
// This is the RE-RUNNABLE probe behind the `{ mode: "auto" }` decision in
// `src/http-client.ts`. It is not a stub: it drives the real `Client` +
// `StreamableHTTPClientTransport` against the real hosted marketplace and reads
// the frames off the wire through an in-process recording `fetch`, so the
// negotiated era is OBSERVED rather than asserted from a package version.
//
// It is gated behind RUN_MARKETPLACE_WIRE_PROOF=1 because it makes real network
// calls. Every request it sends is ANONYMOUS and non-mutating — `server/discover`
// and `initialize` only, no bearer, no tool call. From THIS package's directory:
//
//   RUN_MARKETPLACE_WIRE_PROOF=1 pnpm exec vitest run \
//     tests/marketplace-wire-negotiation.manual.test.ts
//
// Point it at a local WordPress stack with MARKETPLACE_WIRE_PROOF_BASE_URL.
//
// RE-RUN THIS WHEN THE MARKETPLACE ADAPTER IS UPGRADED. The peer is an
// independently-operated hosted service, so its posture can move with no change
// in this repo — which is exactly why the client negotiates `auto` rather than
// pinning `legacy`. When the adapter starts answering `server/discover`, the
// "falls back to legacy" expectation below fails, and that failure is the signal
// to move the marketplace row in
// `docs/internals/contracts/mcp-supported-revisions.md` to the modern revision.
// No code change is required for the negotiation itself: `auto` picks it up.

import { describe, it, expect } from "vitest";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const SHOULD_RUN = process.env.RUN_MARKETPLACE_WIRE_PROOF === "1";
const BASE_URL = process.env.MARKETPLACE_WIRE_PROOF_BASE_URL ?? "https://marketplace.cinatra.ai";
const MCP_URL = `${BASE_URL}/wp-json/cinatra/mcp`;

type Frame = {
  rpcMethod: string;
  requestHeaders: Record<string, string>;
  status: number;
  body: string;
};

/**
 * Records every request the client puts on the wire and forwards it verbatim.
 * A recording `fetch` rather than a proxy server, because the peer is remote
 * HTTPS; the response is cloned so the transport still consumes it intact.
 */
function recordingFetch(frames: Frame[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    let rpcMethod = "";
    try {
      rpcMethod = (JSON.parse(body) as { method?: string }).method ?? "";
    } catch {
      // Not a JSON-RPC frame (e.g. the standalone GET stream open).
    }

    const requestHeaders: Record<string, string> = {};
    for (const [k, v] of new Headers(init?.headers as HeadersInit | undefined).entries()) {
      requestHeaders[k.toLowerCase()] = v;
    }

    const response = await fetch(input, init);
    let text = "";
    try {
      text = await response.clone().text();
    } catch {
      // Streaming body — the frame's status is still recorded.
    }
    frames.push({ rpcMethod, requestHeaders, status: response.status, body: text });
    return response;
  }) as typeof fetch;
}

async function connectAndRecord(versionNegotiation: {
  mode: "auto" | "legacy";
}): Promise<{ era: string | undefined; version: string | undefined; frames: Frame[] }> {
  const frames: Frame[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: recordingFetch(frames),
    requestInit: { signal: AbortSignal.timeout(30_000) },
  });
  const client = new Client(
    { name: "cinatra-marketplace-client", version: "1.0.0" },
    { versionNegotiation },
  );
  try {
    await client.connect(transport);
    return {
      era: client.getProtocolEra(),
      version: client.getNegotiatedProtocolVersion(),
      frames,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

const rpcMethodsOf = (frames: Frame[]) => frames.map((f) => f.rpcMethod).filter(Boolean);

describe.runIf(SHOULD_RUN)("marketplace outbound revision negotiation (live wire)", () => {
  it("proves the peer does NOT implement 2026-07-28 — server/discover is refused", async () => {
    // The probe the modern era is reached through, sent raw with the
    // 2026-07-28 `_meta` envelope. The wordpress/mcp-adapter does not implement
    // the modern era at all: it falls through to its session guard.
    const response = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "cinatra-probe", version: "1.0.0" },
          },
        },
      }),
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: { code?: number } };
    expect(payload.error?.code).toBe(-32600);
  }, 60_000);

  it("negotiates the 2025-era handshake under { mode: 'auto' }, falling back after the rejected probe", async () => {
    const { era, version, frames } = await connectAndRecord({ mode: "auto" });

    // THE MEASUREMENT behind the `auto` decision: the probe is issued (so the
    // day the adapter answers it, cinatra reaches the modern era with no code
    // change), and today it is refused and the client falls back cleanly.
    const methods = rpcMethodsOf(frames);
    expect(methods).toContain("server/discover");
    expect(methods).toContain("initialize");

    const probe = frames.find((f) => f.rpcMethod === "server/discover");
    expect(probe?.status).toBe(400);
    expect(probe?.requestHeaders["mcp-protocol-version"]).toBe("2026-07-28");

    // WHEN THIS FLIPS: the peer gained `2026-07-28`. Move the marketplace row in
    // docs/internals/contracts/mcp-supported-revisions.md; `auto` needs no edit.
    expect(era).toBe("legacy");
    // The SERVER selects the revision on the legacy path — the adapter answers
    // 2025-06-18 even though the client offers a later one.
    expect(version).toBe("2025-06-18");

    // The peer is sessionful: it mints an Mcp-Session-Id the client library holds
    // and cinatra never reads, persists, routes, or authorizes on (cinatra#2218
    // AC4). Observed as a response header, never as application state.
    const initialize = frames.find((f) => f.rpcMethod === "initialize");
    expect(initialize?.status).toBe(200);
  }, 60_000);

  it("reaches the SAME era under { mode: 'legacy' }, one frame cheaper — the cost `auto` buys the probe for", async () => {
    const auto = await connectAndRecord({ mode: "auto" });
    const legacy = await connectAndRecord({ mode: "legacy" });

    expect(legacy.era).toBe(auto.era);
    expect(legacy.version).toBe(auto.version);

    // `legacy` must NOT probe; `auto` must. The delta is exactly the probe, and
    // it is the price of picking up a peer upgrade automatically.
    expect(rpcMethodsOf(legacy.frames)).not.toContain("server/discover");
    expect(rpcMethodsOf(auto.frames)).toContain("server/discover");
    expect(rpcMethodsOf(auto.frames).length).toBe(rpcMethodsOf(legacy.frames).length + 1);
  }, 90_000);

  it("proves the peer REQUIRES the session handshake — a bare tools/list is refused", async () => {
    const response = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error?: { code?: number } };
    expect(payload.error?.code).toBe(-32600);
  }, 60_000);
});
