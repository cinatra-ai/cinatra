/**
 * The transport a sync run calls `objects_*` through.
 *
 * Sync writes from OUTSIDE any agent run, so it reaches the primitives over
 * the AUTHENTICATED MCP transport (`/api/mcp`) — not the in-process
 * deterministic client, which is a same-process convenience for host code and
 * is unreachable from a coding agent's shell. Identity comes entirely from the
 * bearer credential the transport carries; nothing in this file can name an
 * organization, a user, or a run.
 *
 * The interface is the seam. `runMemorySync` takes a
 * {@link MemorySyncTransport}, so a test drives the real classification and
 * write sequencing against a recording double, and the HTTP implementation
 * below is one interchangeable instance of it.
 *
 * The HTTP client speaks MCP Streamable HTTP with `fetch` and node builtins
 * only. Pulling the MCP client SDK in would make this package — a pure
 * filesystem leaf — carry a protocol dependency, which the package purity test
 * forbids and the package description promises against.
 */
import { MemorySyncError } from "./types.ts";

/** A single MCP tool invocation. */
export interface MemorySyncTransport {
  /**
   * Call an MCP tool and return its structured result.
   *
   * MUST throw on a tool error (an MCP `isError` result or a JSON-RPC error).
   * A sync run turns a throw into a per-concept `server-refused` diagnostic
   * and keeps going; it never reads a thrown call as a success.
   */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Options for {@link createHttpMemorySyncTransport}. */
export interface HttpMemorySyncTransportOptions {
  /** Absolute URL of the MCP endpoint, e.g. `https://host/api/mcp`. */
  url: string;
  /**
   * Bearer credential. Read from the environment by the CLI and held in memory
   * for the run only: it is never written to the ledger, the bundle, or any
   * diagnostic.
   */
  token?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Parse an MCP Streamable-HTTP response body.
 *
 * The endpoint may answer a POST with `application/json` (one response) or
 * `text/event-stream` (the same response framed as SSE). Both carry the same
 * JSON-RPC envelope; this returns the one matching `id`.
 */
function parseRpcBody(body: string, contentType: string, id: number): JsonRpcResponse {
  const candidates: string[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith("data:")) candidates.push(line.slice(5).trim());
    }
  } else {
    candidates.push(body.trim());
  }
  for (const candidate of candidates) {
    if (candidate === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const frames = Array.isArray(parsed) ? parsed : [parsed];
    for (const frame of frames) {
      if (frame !== null && typeof frame === "object" && (frame as JsonRpcResponse).id === id) {
        return frame as JsonRpcResponse;
      }
    }
  }
  throw new MemorySyncError(
    `MCP endpoint returned no JSON-RPC response for request ${id}`,
  );
}

/**
 * Read the tool result out of an MCP `tools/call` result.
 *
 * `isError: true` THROWS with the server's own text. The refusal codes this
 * path produces (`OBJECTS_COLLISION_SCOPE_CHANGE_REJECTED`,
 * `OBJECTS_COLLISION_PROJECT_MOVE_REQUIRED`, the memory ingest gates, the
 * project authorization errors) are terminal and cause-neutral by contract —
 * so this never retries and never re-interprets them, it carries the message
 * through to the author verbatim.
 */
function unwrapToolResult(result: unknown, toolName: string): unknown {
  if (result === null || typeof result !== "object") {
    throw new MemorySyncError(`${toolName}: malformed MCP tool result`);
  }
  const r = result as Record<string, unknown>;
  if (r["isError"] === true) {
    const content = Array.isArray(r["content"]) ? r["content"] : [];
    const text = content
      .map((entry) =>
        entry !== null && typeof entry === "object" && typeof (entry as Record<string, unknown>)["text"] === "string"
          ? ((entry as Record<string, unknown>)["text"] as string)
          : "",
      )
      .filter((t) => t !== "")
      .join(" ");
    throw new MemorySyncError(text === "" ? `${toolName} failed` : text);
  }
  if (r["structuredContent"] !== undefined) return r["structuredContent"];
  const content = Array.isArray(r["content"]) ? r["content"] : [];
  for (const entry of content) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>)["text"] === "string"
    ) {
      try {
        return JSON.parse((entry as Record<string, unknown>)["text"] as string);
      } catch {
        // fall through: a non-JSON text block is not a structured result
      }
    }
  }
  throw new MemorySyncError(`${toolName}: MCP tool result carried no structured content`);
}

/**
 * An MCP Streamable-HTTP transport over `fetch`.
 *
 * Lazily performs the `initialize` handshake on the first call and reuses the
 * negotiated `Mcp-Session-Id` for the rest of the run.
 */
export function createHttpMemorySyncTransport(
  options: HttpMemorySyncTransportOptions,
): MemorySyncTransport {
  const timeoutMs = options.timeoutMs ?? 30_000;
  let nextId = 1;
  let sessionId: string | undefined;
  let handshake: Promise<void> | undefined;

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(options.token === undefined || options.token === ""
      ? {}
      : { authorization: `Bearer ${options.token}` }),
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
  });

  const post = async (
    payload: Record<string, unknown>,
  ): Promise<{ body: string; contentType: string; session?: string; status: number }> => {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(options.url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
      signal,
    });
    const session = response.headers.get("mcp-session-id") ?? undefined;
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    return {
      body,
      contentType,
      status: response.status,
      ...(session === undefined ? {} : { session }),
    };
  };

  const rpc = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = nextId++;
    const { body, contentType, session, status } = await post({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    if (session !== undefined) sessionId = session;
    if (status >= 400) {
      // The status line alone is what the author needs; the body may carry the
      // endpoint's own error page, which is not worth pasting into a terminal.
      throw new MemorySyncError(
        `MCP endpoint ${options.url} answered ${method} with HTTP ${status}`,
      );
    }
    const frame = parseRpcBody(body, contentType, id);
    if (frame.error) {
      throw new MemorySyncError(`${method} failed: ${frame.error.message}`);
    }
    return frame.result;
  };

  const ensureHandshake = async (): Promise<void> => {
    handshake ??= (async () => {
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cinatra-memory-cli", version: "0.1.0" },
      });
      await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    })();
    await handshake;
  };

  return {
    async callTool(name, args) {
      await ensureHandshake();
      const result = await rpc("tools/call", { name, arguments: args });
      return unwrapToolResult(result, name);
    },
  };
}
