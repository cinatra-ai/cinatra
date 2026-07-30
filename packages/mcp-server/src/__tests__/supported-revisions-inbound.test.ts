import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import { resolveInboundEra, serveLegacyEra } from "../inbound-era";

// cinatra#2218 L1 — INBOUND REVISION POSTURE, row A of
// docs/internals/contracts/mcp-supported-revisions.md (recorded product ruling,
// 2026-07-29): the accepted inbound set is `2026-07-28` PLUS all five
// previously-accepted revisions.
//
// These tests drive the SAME two legs `createMcpServerMount`'s transportHandler
// wires — a JSON-framed stateless WebStandardStreamableHTTPServerTransport for
// legacy traffic and a `legacy: 'reject'` createMcpHandler for modern traffic,
// split on the SDK's own `isLegacyRequest` predicate — WITHOUT the app's auth /
// ALS / Next.js surface, so the revision behaviour is pinned in isolation.
// The end-to-end proof over the real route is the live-wire capture on the PR.

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";

/** The per-request `_meta` envelope a modern (2026-07-28) request must carry. */
const MODERN_ENVELOPE = {
  [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
  [CLIENT_CAPABILITIES_META_KEY]: {},
  [CLIENT_INFO_META_KEY]: { name: "cinatra-revision-test", version: "1" },
} as const;

const LEGACY_REVISIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

// NOTE: the local is named `srv`, never `server` — the authz-inventory scanner
// (scripts/build-authz-inventory.mjs) inventories REAL MCP primitives by
// matching a `registerTool` call on a variable literally named `server`, and a
// test fixture must never enter that inventory.
function buildServer() {
  const srv = new McpServer({ name: "cinatra-revision-test", version: "0.0.1" });
  srv.registerTool(
    "revision_echo",
    { title: "Echo", description: "echo", inputSchema: z.object({ text: z.string() }) },
    async (input) => ({
      content: [{ type: "text", text: String(input.text) }],
      structuredContent: { echoed: input.text },
    }),
  );
  return srv;
}

/**
 * The two legs, wired exactly as `transportHandler` wires them (minus auth/ALS).
 * `legacyPosture` mirrors `MCP_INBOUND_LEGACY_POSTURE`.
 */
async function serve(
  request: Request,
  options: { legacyPosture?: "stateless" | "reject" } = {},
) {
  const legacyPosture = options.legacyPosture ?? "stateless";
  const srv = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await srv.connect(transport);
  const modernHandler = createMcpHandler(() => srv, { legacy: "reject" });

  const parsedBody =
    request.method === "POST" ? await request.clone().json().catch(() => undefined) : undefined;
  // Row A goes through the REAL `resolveInboundEra`; row B is simulated by
  // forcing the modern leg (the shape `MCP_INBOUND_LEGACY_POSTURE === "reject"`
  // produces inside that same function).
  const servedByModernEra =
    legacyPosture === "reject" || (await resolveInboundEra(request, parsedBody)) === "modern";

  const response = servedByModernEra
    ? await modernHandler.fetch(request, { parsedBody })
    : await serveLegacyEra(transport, request, parsedBody);
  const contentType = response.headers.get("content-type");
  const body =
    contentType?.includes("text/event-stream") === true
      ? await response.text()
      : await response.clone().text();
  if (!contentType?.includes("text/event-stream")) await modernHandler.close();
  return {
    status: response.status,
    contentType,
    text: body,
    json: (() => {
      try {
        return JSON.parse(body) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })(),
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://cinatra.test/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The transport handler normalises Accept before either leg sees it.
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("inbound revision posture — row A (2026-07-28 + all five legacy revisions)", () => {
  it("serves a 2025-11-25 initialize round-trip and echoes the requested revision", async () => {
    const res = await serve(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "today", version: "1" },
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.json?.result).toMatchObject({ protocolVersion: "2025-11-25" });
  });

  it.each(LEGACY_REVISIONS)("accepts legacy revision %s on both the handshake and the header", async (revision) => {
    const handshake = await serve(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: revision, capabilities: {}, clientInfo: { name: "old", version: "1" } },
      }),
    );
    expect(handshake.status).toBe(200);
    expect((handshake.json?.result as { protocolVersion?: string } | undefined)?.protocolVersion).toBe(revision);

    const listed = await serve(
      post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-protocol-version": revision }),
    );
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.json)).toContain("revision_echo");
  });

  it("keeps the legacy leg on application/json framing (the wire format today's callers parse)", async () => {
    const res = await serve(
      post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { "mcp-protocol-version": "2025-11-25" }),
    );
    // Regression guard for the reason row A is NOT wired as the SDK's built-in
    // `legacy: 'stateless'` fallback: that fallback constructs its transport
    // without `enableJsonResponse`, which would answer text/event-stream here
    // and break every caller that calls `.json()` on the result.
    expect(res.contentType).toContain("application/json");
    expect(res.contentType).not.toContain("text/event-stream");
  });

  it("rejects an unsupported revision named in the MCP-Protocol-Version header (400 / -32000)", async () => {
    const res = await serve(
      post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { "mcp-protocol-version": "1999-01-01" }),
    );
    expect(res.status).toBe(400);
    expect((res.json?.error as { code?: number } | undefined)?.code).toBe(-32000);
    // The five legacy revisions are the set the legacy leg names as supported.
    for (const revision of LEGACY_REVISIONS) expect(res.text).toContain(revision);
  });

  it("down-negotiates an unknown revision requested in initialize instead of failing (lenient handshake)", async () => {
    const res = await serve(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2030-01-01", capabilities: {}, clientInfo: { name: "future", version: "1" } },
      }),
    );
    expect(res.status).toBe(200);
    expect((res.json?.result as { protocolVersion?: string } | undefined)?.protocolVersion).toBe("2025-11-25");
  });

  it("answers GET and DELETE (2025 session operations) with 405 under stateless serving", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const res = await serve(
        new Request("https://cinatra.test/api/mcp", {
          method,
          headers: { accept: "application/json, text/event-stream" },
        }),
      );
      expect(res.status).toBe(405);
    }
  });
});

describe("inbound revision posture — the 2026-07-28 modern path", () => {
  it("serves server/discover behind the _meta envelope and advertises 2026-07-28", async () => {
    const res = await serve(
      post(
        { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: MODERN_ENVELOPE } },
        { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
      ),
    );
    expect(res.status).toBe(200);
    expect((res.json?.result as { supportedVersions?: string[] } | undefined)?.supportedVersions).toEqual([
      "2026-07-28",
    ]);
  });

  it("serves tools/list and tools/call on the modern path", async () => {
    const listed = await serve(
      post(
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: MODERN_ENVELOPE } },
        { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
      ),
    );
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.json)).toContain("revision_echo");

    const called = await serve(
      post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "revision_echo", arguments: { text: "hi" }, _meta: MODERN_ENVELOPE },
        },
        {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "revision_echo",
        },
      ),
    );
    expect(called.status).toBe(200);
    expect((called.json?.result as { structuredContent?: { echoed?: string } } | undefined)?.structuredContent)
      .toEqual({ echoed: "hi" });
  });

  it("answers a modern MCP-Protocol-Version header WITHOUT the envelope with -32602", async () => {
    // Restating cinatra#2218 AC2: the header alone is NOT the negotiation.
    const res = await serve(
      post(
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
      ),
    );
    expect(res.status).toBe(400);
    expect((res.json?.error as { code?: number } | undefined)?.code).toBe(-32602);
    expect(res.text).toContain("_meta");
  });

  it("answers a header/body revision mismatch with -32020", async () => {
    const res = await serve(
      post(
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: MODERN_ENVELOPE } },
        { "mcp-protocol-version": "2025-11-25", "mcp-method": "tools/list" },
      ),
    );
    expect(res.status).toBe(400);
    expect((res.json?.error as { code?: number } | undefined)?.code).toBe(-32020);
  });

  it("requires the Mcp-Method header on a modern request (-32020)", async () => {
    const res = await serve(
      post(
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: MODERN_ENVELOPE } },
        { "mcp-protocol-version": "2026-07-28" },
      ),
    );
    expect(res.status).toBe(400);
    expect((res.json?.error as { code?: number } | undefined)?.code).toBe(-32020);
    expect(res.text).toContain("Mcp-Method");
  });

  it("rejects an INCOMPLETE _meta envelope (clientCapabilities missing) with -32602", async () => {
    const res = await serve(
      post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28" } },
        },
        { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
      ),
    );
    expect(res.status).toBe(400);
    expect((res.json?.error as { code?: number } | undefined)?.code).toBe(-32602);
    expect(res.text).toContain(CLIENT_CAPABILITIES_META_KEY);
  });

  it("rejects an envelope naming a modern revision the endpoint does not serve", async () => {
    const res = await serve(
      post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: { ...MODERN_ENVELOPE, [PROTOCOL_VERSION_META_KEY]: "2099-01-01" },
          },
        },
        { "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" },
      ),
    );
    expect(res.status).toBe(400);
    expect(res.text).toContain("2026-07-28");
  });

  it("rejects a MISMATCHED Mcp-Name on a modern tools/call (-32020)", async () => {
    const res = await serve(
      post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "revision_echo", arguments: { text: "hi" }, _meta: MODERN_ENVELOPE },
        },
        {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "some_other_tool",
        },
      ),
    );
    expect(res.status).toBe(400);
    expect((res.json?.error as { code?: number } | undefined)?.code).toBe(-32020);
  });

  it("rejects an invalid Base64 Mcp-Name sentinel (-32020)", async () => {
    const res = await serve(
      post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "revision_echo", arguments: { text: "hi" }, _meta: MODERN_ENVELOPE },
        },
        {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "=?base64?not-valid-base64!!?=",
        },
      ),
    );
    expect(res.status).toBe(400);
    expect((res.json?.error as { code?: number } | undefined)?.code).toBe(-32020);
  });

  it("does NOT require Mcp-Method on a modern NOTIFICATION (requests only)", async () => {
    const res = await serve(
      post(
        { jsonrpc: "2.0", method: "notifications/initialized", params: { _meta: MODERN_ENVELOPE } },
        { "mcp-protocol-version": "2026-07-28" },
      ),
    );
    expect(res.status).toBe(202);
  });

  it("requires the Mcp-Name header on a modern tools/call (-32020)", async () => {
    const res = await serve(
      post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "revision_echo", arguments: { text: "hi" }, _meta: MODERN_ENVELOPE },
        },
        { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call" },
      ),
    );
    expect(res.status).toBe(400);
    expect((res.json?.error as { code?: number } | undefined)?.code).toBe(-32020);
    expect(res.text).toContain("Mcp-Name");
  });
});

describe("inbound revision posture — the era split cannot disagree with the SDK", () => {
  it("classifies the traffic the two legs must each own", async () => {
    const legacyInitialize = post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const modernRequest = post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: MODERN_ENVELOPE } });
    const modernHeaderNoEnvelope = post(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { "mcp-protocol-version": "2026-07-28" },
    );

    expect(await isLegacyRequest(legacyInitialize)).toBe(true);
    expect(await resolveInboundEra(legacyInitialize.clone(), undefined)).toBe("legacy");
    expect(await isLegacyRequest(modernRequest)).toBe(false);
    expect(await resolveInboundEra(modernRequest.clone(), undefined)).toBe("modern");
    // A modern-header-without-envelope request is NOT legacy: the modern path
    // owns its -32602 answer. Routing it to the legacy leg would answer the
    // wrong error.
    expect(await isLegacyRequest(modernHeaderNoEnvelope)).toBe(false);
    expect(await isLegacyRequest(new Request("https://cinatra.test/api/mcp", { method: "GET" }))).toBe(true);
  });

  it("classifies a claim-less modern-header NOTIFICATION as modern (202, dropped) — not legacy", async () => {
    // The modern leg accepts a legacy-shaped notification carrying only a modern
    // MCP-Protocol-Version header: no `_meta`, no `Mcp-Method` required, `202`,
    // dropped. Routing it to the legacy leg would answer the wrong thing.
    const notification = post(
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { "mcp-protocol-version": "2026-07-28" },
    );
    expect(await resolveInboundEra(notification.clone(), undefined)).toBe("modern");
    const res = await serve(notification);
    expect(res.status).toBe(202);
  });

  it("row B (legacyPosture 'reject') would drop the legacy era — proving row A is a choice, not a default", async () => {
    const res = await serve(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "old", version: "1" } },
      }),
      { legacyPosture: "reject" },
    );
    expect(res.status).toBe(400);
    expect(res.text).toContain("2026-07-28");
  });
});
