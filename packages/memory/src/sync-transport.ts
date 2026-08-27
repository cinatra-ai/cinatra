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

/**
 * The MCP protocol version this client speaks on `initialize`.
 *
 * Streamable HTTP requires the NEGOTIATED version to ride every subsequent
 * request as `mcp-protocol-version` (cinatra#1378 review item 9). The client
 * used to send this on the handshake, discard the server's answer, and then
 * send no version header at all.
 */
const MCP_CLIENT_PROTOCOL_VERSION = "2025-06-18";

/** Hosts for which a plain-`http` endpoint is acceptable. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

/**
 * Render a URL for a message a human or `--json` will read, WITHOUT its
 * credential-bearing parts (cinatra#1378 review item 9).
 *
 * The CLI's help text promises the bearer credential "is never written
 * anywhere". An endpoint URL can carry one in its userinfo or its query
 * (`?token=…`), and every transport error used to paste `options.url`
 * verbatim into a `MemorySyncError` that the CLI prints and `--json`
 * serializes. Userinfo, query and fragment are dropped; scheme, host, port and
 * path are kept, because those are what the author needs to see.
 *
 * A URL that cannot be parsed renders as a fixed placeholder rather than as
 * itself: an unparseable string is exactly the case where the credential could
 * still be in it.
 */
export function redactMemorySyncUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "<unparseable endpoint URL>";
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/**
 * Validate the endpoint the bearer credential is about to be attached to
 * (cinatra#1378 review item 9).
 *
 * The URL comes from `--url` or `CINATRA_MCP_URL` and used to reach `fetch`
 * with no scheme or host check at all, so a plain `http://` endpoint carried
 * the credential in cleartext and a mistyped host simply received it. Refusing
 * here is the only place that can prevent it: once the request is sent, the
 * credential is gone.
 *
 * Plain `http` is allowed for a loopback host, which is how the endpoint is
 * reached in local development and in this package's own tests, and where the
 * request never leaves the machine.
 *
 * THROWS {@link MemorySyncError}. The message names the redacted URL, never
 * the original.
 */
export function assertMemorySyncEndpointUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MemorySyncError(
      "the MCP endpoint is not a valid absolute URL; pass --url or set CINATRA_MCP_URL to something like https://host/api/mcp",
    );
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) return;
  if (parsed.protocol !== "http:") {
    throw new MemorySyncError(
      `the MCP endpoint ${redactMemorySyncUrl(url)} does not speak http(s); the sync transport is HTTP only`,
    );
  }
  throw new MemorySyncError(
    `the MCP endpoint ${redactMemorySyncUrl(url)} is plain http, and the bearer credential would travel in cleartext. Use https, or a loopback host for local development.`,
  );
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
  assertMemorySyncEndpointUrl(options.url);
  const safeUrl = redactMemorySyncUrl(options.url);
  const timeoutMs = options.timeoutMs ?? 30_000;
  let nextId = 1;
  let sessionId: string | undefined;
  let handshake: Promise<void> | undefined;
  let protocolVersion: string | undefined;

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(options.token === undefined || options.token === ""
      ? {}
      : { authorization: `Bearer ${options.token}` }),
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
    // The NEGOTIATED version, once the handshake has one, else the version
    // this client offered. Streamable HTTP requires it on every request after
    // initialize (cinatra#1378 review item 9).
    ...(protocolVersion === undefined
      ? {}
      : { "mcp-protocol-version": protocolVersion }),
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

  /** A session-bound 404: the server forgot our session, not a hard failure. */
  class SessionExpiredError extends Error {}

  const rpc = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = nextId++;
    const { body, contentType, session, status } = await post({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    if (session !== undefined) sessionId = session;
    if (status === 404 && sessionId !== undefined) {
      // A 404 on a request that carried a session id is the Streamable-HTTP
      // signal that the session is gone — the server restarted, or expired it.
      // Turning it into a terminal error failed a run that a fresh handshake
      // would have completed (cinatra#1378 review item 9). Bounded: the caller
      // re-initializes ONCE and a second 404 is terminal, so a server that
      // answers 404 for everything cannot become a retry loop.
      throw new SessionExpiredError(`${method} answered 404 for the current session`);
    }
    if (status >= 400) {
      // The status line alone is what the author needs; the body may carry the
      // endpoint's own error page, which is not worth pasting into a terminal.
      // The URL is redacted — it may carry the credential in its query.
      throw new MemorySyncError(
        `MCP endpoint ${safeUrl} answered ${method} with HTTP ${status}`,
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
      const result = await rpc("initialize", {
        protocolVersion: MCP_CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "cinatra-memory-cli", version: "0.1.0" },
      });
      // Carry the version the server NEGOTIATED, not the one we offered. A
      // server that answers with a version it prefers gets that version back on
      // every following request; a server that answers with nothing readable
      // gets the offered one, which is what it saw on initialize.
      const negotiated =
        result !== null &&
        typeof result === "object" &&
        typeof (result as Record<string, unknown>)["protocolVersion"] === "string"
          ? ((result as Record<string, unknown>)["protocolVersion"] as string)
          : MCP_CLIENT_PROTOCOL_VERSION;
      protocolVersion = negotiated;
      await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    })();
    await handshake;
  };

  /** Drop the dead session and force the next call to handshake again. */
  const resetSession = (): void => {
    sessionId = undefined;
    protocolVersion = undefined;
    handshake = undefined;
  };

  return {
    async callTool(name, args) {
      for (let attempt = 0; ; attempt++) {
        try {
          await ensureHandshake();
          const result = await rpc("tools/call", { name, arguments: args });
          return unwrapToolResult(result, name);
        } catch (error) {
          // Exactly one re-initialize, and only for a session-bound 404.
          if (error instanceof SessionExpiredError && attempt === 0) {
            resetSession();
            continue;
          }
          if (error instanceof SessionExpiredError) {
            throw new MemorySyncError(
              `MCP endpoint ${safeUrl} answered ${name} with HTTP 404 after a fresh session was established`,
            );
          }
          throw error;
        }
      }
    },
  };
}
