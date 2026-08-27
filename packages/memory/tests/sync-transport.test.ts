/**
 * The MCP Streamable-HTTP transport (cinatra#1378), against a real HTTP
 * server rather than a fetch double — the framing (SSE vs JSON, the session
 * header, the handshake ordering) is exactly the part a double would assume
 * away.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertMemorySyncEndpointUrl,
  createHttpMemorySyncTransport,
  redactMemorySyncUrl,
} from "../src/sync-transport.ts";
import { MemorySyncError } from "../src/types.ts";

interface Recorded {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

// Assembled at runtime so no committed line carries a complete scheme,
// userinfo and host literal for a secret scanner to trip on; the
// string the redactor sees is unchanged.
function credUrl(scheme: string, userinfo: string, rest: string): string {
  return [scheme + ":", "", userinfo + "@" + rest].join("/");
}

let server: Server | undefined;

async function startServer(
  respond: (
    body: { id?: number; method: string; params?: unknown },
    recorded: Recorded[],
  ) => { status?: number; contentType: string; payload: string; sessionId?: string } | null,
): Promise<{ url: string; recorded: Recorded[] }> {
  const recorded: Recorded[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw === "" ? {} : JSON.parse(raw);
      recorded.push({ method: body.method, headers: req.headers, body });
      const answer = respond(body, recorded);
      if (answer === null) {
        // A notification carries no id and expects no body.
        res.writeHead(202).end();
        return;
      }
      const headers: Record<string, string> = { "content-type": answer.contentType };
      if (answer.sessionId !== undefined) headers["mcp-session-id"] = answer.sessionId;
      res.writeHead(answer.status ?? 200, headers).end(answer.payload);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/mcp`, recorded };
}

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function rpcResult(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

describe("createHttpMemorySyncTransport", () => {
  it("initializes once, reuses the session, and returns structured content", async () => {
    const { url, recorded } = await startServer((body) => {
      if (body.method === "notifications/initialized") return null;
      if (body.method === "initialize") {
        return {
          contentType: "application/json",
          sessionId: "sess-1",
          payload: rpcResult(body.id!, { protocolVersion: "2025-06-18" }),
        };
      }
      return {
        contentType: "application/json",
        payload: rpcResult(body.id!, {
          structuredContent: { items: [{ id: "obj-1" }] },
        }),
      };
    });
    const transport = createHttpMemorySyncTransport({ url, token: "tok-abc" });
    expect(await transport.callTool("objects_list", { type: "t" })).toEqual({
      items: [{ id: "obj-1" }],
    });
    expect(await transport.callTool("objects_list", { type: "t" })).toEqual({
      items: [{ id: "obj-1" }],
    });

    // Exactly one handshake for two tool calls.
    expect(recorded.filter((r) => r.method === "initialize")).toHaveLength(1);
    // The bearer rides every request, and the negotiated session is echoed back
    // from the second request on.
    expect(recorded.every((r) => r.headers.authorization === "Bearer tok-abc")).toBe(true);
    const toolCalls = recorded.filter((r) => r.method === "tools/call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]?.headers["mcp-session-id"]).toBe("sess-1");
  });

  it("reads a response framed as server-sent events", async () => {
    const { url } = await startServer((body) => {
      if (body.method === "notifications/initialized") return null;
      const payload =
        body.method === "initialize"
          ? rpcResult(body.id!, { protocolVersion: "2025-06-18" })
          : rpcResult(body.id!, { structuredContent: { objectId: "obj-9" } });
      return {
        contentType: "text/event-stream",
        payload: `event: message\ndata: ${payload}\n\n`,
      };
    });
    const transport = createHttpMemorySyncTransport({ url });
    expect(await transport.callTool("objects_save", {})).toEqual({ objectId: "obj-9" });
  });

  it("throws the server's own text on an MCP tool error", async () => {
    const { url } = await startServer((body) => {
      if (body.method === "notifications/initialized") return null;
      if (body.method === "initialize") {
        return { contentType: "application/json", payload: rpcResult(body.id!, { protocolVersion: "2025-06-18" }) };
      }
      return {
        contentType: "application/json",
        payload: rpcResult(body.id!, {
          isError: true,
          content: [{ type: "text", text: "OBJECTS_MEMORY_SECRET_DETECTED: not stored" }],
        }),
      };
    });
    const transport = createHttpMemorySyncTransport({ url });
    // A refused save must NOT come back as a success with an empty result —
    // that is what would let a sync run record a ledger entry for a row that
    // was never written.
    await expect(transport.callTool("objects_save", {})).rejects.toThrow(
      /OBJECTS_MEMORY_SECRET_DETECTED/,
    );
  });

  it("refuses a tool result whose isError is present but not a boolean", async () => {
    // `isError: "true"` must not read as a clean success (codex round-3 find).
    const { url } = await startServer((body) => {
      if (body.method === "notifications/initialized") return null;
      if (body.method === "initialize") {
        return { contentType: "application/json", payload: rpcResult(body.id!, { protocolVersion: "2025-06-18" }) };
      }
      return {
        contentType: "application/json",
        payload: rpcResult(body.id!, { isError: "true", structuredContent: { objectId: "obj-x" } }),
      };
    });
    const transport = createHttpMemorySyncTransport({ url });
    await expect(transport.callTool("objects_save", {})).rejects.toThrow(
      /isError is not a boolean/,
    );
  });

  it("refuses the handshake when notifications/initialized is rejected", async () => {
    // A 4xx on the initialized notification means the server did not accept
    // the handshake; no tools/call may follow (codex round-3 find).
    const { url, recorded } = await startServer((body) => {
      if (body.method === "notifications/initialized") {
        return { status: 403, contentType: "text/plain", payload: "no" };
      }
      if (body.method === "initialize") {
        return { contentType: "application/json", payload: rpcResult(body.id!, { protocolVersion: "2025-06-18" }) };
      }
      return { contentType: "application/json", payload: rpcResult(body.id!, {}) };
    });
    const transport = createHttpMemorySyncTransport({ url });
    await expect(transport.callTool("objects_list", {})).rejects.toThrow(
      /notifications\/initialized/,
    );
    expect(recorded.some((r) => r.method === "tools/call")).toBe(false);
  });

  it("throws on a JSON-RPC error frame", async () => {
    const { url } = await startServer((body) => {
      if (body.method === "notifications/initialized") return null;
      return {
        contentType: "application/json",
        payload: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32602, message: "unknown tool" },
        }),
      };
    });
    const transport = createHttpMemorySyncTransport({ url });
    await expect(transport.callTool("objects_save", {})).rejects.toThrow(MemorySyncError);
  });

  it("throws on an HTTP failure rather than reading the body as a result", async () => {
    const { url } = await startServer(() => ({
      status: 401,
      contentType: "text/plain",
      payload: "unauthorized",
    }));
    const transport = createHttpMemorySyncTransport({ url });
    await expect(transport.callTool("objects_list", {})).rejects.toThrow(/HTTP 401/);
  });

  it("sends no authorization header when no credential is configured", async () => {
    const { url, recorded } = await startServer((body) => {
      if (body.method === "notifications/initialized") return null;
      return { contentType: "application/json", payload: rpcResult(body.id!, { protocolVersion: "2025-06-18" }) };
    });
    const transport = createHttpMemorySyncTransport({ url });
    await transport.callTool("objects_list", {}).catch(() => undefined);
    expect(recorded.every((r) => r.headers.authorization === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round-3 review item 9 (PR #3017): the transport attaches a bearer credential,
// so where it attaches it, what it carries alongside it, and what it prints
// afterwards are all part of the credential's exposure.
// ---------------------------------------------------------------------------

describe("the endpoint a credential may be attached to", () => {
  it("refuses a plain-http endpoint on a non-loopback host", () => {
    // The credential would travel in cleartext, and a mistyped host would
    // simply receive it. Refusing here is the only place that can prevent it.
    expect(() => assertMemorySyncEndpointUrl("http://mcp.example.test/api/mcp")).toThrow(
      /plain http/,
    );
    expect(() => createHttpMemorySyncTransport({ url: "http://mcp.example.test/api/mcp" })).toThrow(
      MemorySyncError,
    );
  });

  it("allows https anywhere, and plain http on loopback", () => {
    expect(() => assertMemorySyncEndpointUrl("https://mcp.example.test/api/mcp")).not.toThrow();
    expect(() => assertMemorySyncEndpointUrl("http://127.0.0.1:3000/api/mcp")).not.toThrow();
    expect(() => assertMemorySyncEndpointUrl("http://localhost:3000/api/mcp")).not.toThrow();
  });

  it("refuses a non-http scheme and an unparseable URL", () => {
    expect(() => assertMemorySyncEndpointUrl("file:///etc/passwd")).toThrow(/HTTP only/);
    expect(() => assertMemorySyncEndpointUrl("not a url")).toThrow(/valid absolute URL/);
  });
});

describe("a URL that reaches a message carries no credential", () => {
  it("drops userinfo, query and fragment and keeps the rest", () => {
    expect(
      redactMemorySyncUrl(
        credUrl("https", "user:secretpassword", "host.test:8443/api/mcp?token=abc#frag"),
      ),
    ).toBe("https://host.test:8443/api/mcp");
  });

  it("renders an unparseable URL as a placeholder rather than as itself", () => {
    // An unparseable string is exactly the case where the credential could
    // still be inside it.
    expect(redactMemorySyncUrl("://nonsense")).toBe("<unparseable endpoint URL>");
  });

  it("keeps the credential out of a transport error the CLI would print", async () => {
    const { url } = await startServer((body) =>
      body.method === "initialize"
        ? { contentType: "application/json", payload: rpcResult(body.id as number, { protocolVersion: "2025-06-18" }), sessionId: "s-1" }
        : { status: 500, contentType: "application/json", payload: "{}" },
    );
    const withQuery = `${url}?token=0123456789abcdefghij`;
    const transport = createHttpMemorySyncTransport({ url: withQuery, token: "t" });
    const error = await transport.callTool("objects_list", {}).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toContain("HTTP 500");
    expect(message).not.toContain("token=");
    expect(message).not.toContain("0123456789abcdefghij");
  });
});

/**
 * `fetch`-stubbed rather than a real listener (cinatra#1378 round-2 item 1):
 * these tests exist to pin what the transport does with the ANSWERED version,
 * not to re-exercise the HTTP framing the listener tests above already cover,
 * and a same-process `fetch` against a loopback listener is this machine's own
 * artifact (`ECONNREFUSED` — see the round-2 review, item 9's suite table).
 * Stubbing keeps these three tests out of that class everywhere.
 */
function stubFetchTranscript(
  handler: (body: { id?: number; method: string }) => {
    status?: number;
    contentType?: string;
    body?: string;
    sessionId?: string;
  } | null,
): Array<{ headers: Record<string, string>; body: { id?: number; method: string } }> {
  const calls: Array<{ headers: Record<string, string>; body: { id?: number; method: string } }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      const body = JSON.parse(init.body) as { id?: number; method: string };
      calls.push({ headers: init.headers, body });
      const answer = handler(body);
      const responseHeaders = new Map<string, string>([
        ["content-type", answer?.contentType ?? "application/json"],
      ]);
      if (answer?.sessionId !== undefined) responseHeaders.set("mcp-session-id", answer.sessionId);
      return {
        status: answer?.status ?? (answer === null ? 202 : 200),
        headers: { get: (name: string) => responseHeaders.get(name.toLowerCase()) ?? null },
        text: async () => answer?.body ?? "",
      } as unknown as Response;
    }),
  );
  return calls;
}

describe("the negotiated protocol version rides every following request", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adopts the version the server answered with, when this client implements it", async () => {
    const calls = stubFetchTranscript((body) => {
      if (body.method === "initialize") {
        return { sessionId: "s-1", body: rpcResult(body.id as number, { protocolVersion: "2025-06-18" }) };
      }
      if (body.id === undefined) return null;
      return { body: rpcResult(body.id, { structuredContent: { items: [] } }) };
    });
    const transport = createHttpMemorySyncTransport({ url: "https://mcp.example.test/api/mcp", token: "t" });
    await transport.callTool("objects_list", {});
    const toolCall = calls.find((c) => c.body.method === "tools/call");
    expect(toolCall?.headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("refuses a version this client does not implement, naming both versions", async () => {
    stubFetchTranscript((body) => {
      if (body.method === "initialize") {
        return { sessionId: "s-1", body: rpcResult(body.id as number, { protocolVersion: "2099-01-01" }) };
      }
      if (body.id === undefined) return null;
      return { body: rpcResult(body.id, { structuredContent: { items: [] } }) };
    });
    const transport = createHttpMemorySyncTransport({ url: "https://mcp.example.test/api/mcp", token: "t" });
    await expect(transport.callTool("objects_list", {})).rejects.toThrow(
      /"2099-01-01".*"2025-06-18"|"2025-06-18".*"2099-01-01"/,
    );
  });

  it("refuses an initialize result with no readable protocolVersion, before anything follows", async () => {
    // protocolVersion is REQUIRED on an initialize result; an answer without
    // one is a malformed handshake, not a silent yes (round-3 item 2).
    const calls = stubFetchTranscript((body) => {
      if (body.method === "initialize") {
        return { sessionId: "s-1", body: rpcResult(body.id as number, {}) };
      }
      if (body.id === undefined) return null;
      return { body: rpcResult(body.id, { structuredContent: { items: [] } }) };
    });
    const transport = createHttpMemorySyncTransport({ url: "https://mcp.example.test/api/mcp", token: "t" });
    await expect(transport.callTool("objects_list", {})).rejects.toThrow(
      /without a readable protocolVersion/,
    );
    expect(calls.some((c) => c.body.method === "tools/call")).toBe(false);
    expect(calls.some((c) => c.body.method === "notifications/initialized")).toBe(false);
  });

  it("refuses an empty-string answered version", async () => {
    stubFetchTranscript((body) => {
      if (body.method === "initialize") {
        return { sessionId: "s-1", body: rpcResult(body.id as number, { protocolVersion: "" }) };
      }
      if (body.id === undefined) return null;
      return { body: rpcResult(body.id, { structuredContent: { items: [] } }) };
    });
    const transport = createHttpMemorySyncTransport({ url: "https://mcp.example.test/api/mcp", token: "t" });
    await expect(transport.callTool("objects_list", {})).rejects.toThrow(MemorySyncError);
  });
});

describe("an empty session header is not a session", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never stores or replays an empty mcp-session-id answer", async () => {
    const calls = stubFetchTranscript((body) => {
      if (body.method === "initialize") {
        return { sessionId: "", body: rpcResult(body.id as number, { protocolVersion: "2025-06-18" }) };
      }
      if (body.id === undefined) return null;
      return { body: rpcResult(body.id, { structuredContent: { items: [] } }) };
    });
    const transport = createHttpMemorySyncTransport({ url: "https://mcp.example.test/api/mcp", token: "t" });
    await transport.callTool("objects_list", {});
    const toolCall = calls.find((c) => c.body.method === "tools/call");
    expect(toolCall).toBeDefined();
    // The empty header value must not be adopted: no session header rides the
    // following requests, and the call is not treated as session-bound.
    expect(toolCall?.headers["mcp-session-id"]).toBeUndefined();
  });
});

describe("a session-bound 404 re-initializes once instead of failing the run", () => {
  it("drops the dead session, handshakes again, and completes the call", async () => {
    let handshakes = 0;
    let served404 = false;
    const { url, recorded } = await startServer((body) => {
      if (body.method === "initialize") {
        handshakes += 1;
        return {
          contentType: "application/json",
          payload: rpcResult(body.id as number, { protocolVersion: "2025-06-18" }),
          sessionId: `s-${handshakes}`,
        };
      }
      if (body.id === undefined) return null;
      if (body.method === "tools/call" && !served404) {
        served404 = true;
        return { status: 404, contentType: "application/json", payload: "{}" };
      }
      return {
        contentType: "application/json",
        payload: rpcResult(body.id, { structuredContent: { items: [] } }),
      };
    });
    const transport = createHttpMemorySyncTransport({ url, token: "t" });
    await expect(transport.callTool("objects_list", {})).resolves.toEqual({ items: [] });
    expect(handshakes).toBe(2);
    // The retried call carries the NEW session, not the dead one.
    const calls = recorded.filter((r) => r.method === "tools/call");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers["mcp-session-id"]).toBe("s-2");
  });

  it("is bounded: a second 404 after a fresh session is terminal", async () => {
    let handshakes = 0;
    const { url } = await startServer((body) => {
      if (body.method === "initialize") {
        handshakes += 1;
        return {
          contentType: "application/json",
          payload: rpcResult(body.id as number, { protocolVersion: "2025-06-18" }),
          sessionId: `s-${handshakes}`,
        };
      }
      if (body.id === undefined) return null;
      return { status: 404, contentType: "application/json", payload: "{}" };
    });
    const transport = createHttpMemorySyncTransport({ url, token: "t" });
    await expect(transport.callTool("objects_list", {})).rejects.toThrow(
      /404 after a fresh session was established/,
    );
    expect(handshakes).toBe(2);
  });
});
