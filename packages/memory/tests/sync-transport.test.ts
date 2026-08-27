/**
 * The MCP Streamable-HTTP transport (cinatra#1378), against a real HTTP
 * server rather than a fetch double — the framing (SSE vs JSON, the session
 * header, the handshake ordering) is exactly the part a double would assume
 * away.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpMemorySyncTransport } from "../src/sync-transport.ts";
import { MemorySyncError } from "../src/types.ts";

interface Recorded {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
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
          ? rpcResult(body.id!, {})
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
        return { contentType: "application/json", payload: rpcResult(body.id!, {}) };
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
      return { contentType: "application/json", payload: rpcResult(body.id!, {}) };
    });
    const transport = createHttpMemorySyncTransport({ url });
    await transport.callTool("objects_list", {}).catch(() => undefined);
    expect(recorded.every((r) => r.headers.authorization === undefined)).toBe(true);
  });
});
