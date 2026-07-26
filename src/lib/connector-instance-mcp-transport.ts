import "server-only";

// Governed connector-instance MCP transport (cinatra#2017 S2 slice K5, design
// §1.3). Plane C's wire layer: reach a connector instance's own MCP catalog
// through the MCP SDK `Client` + Streamable HTTP, with a single host-side auth
// source, structuredContent-preferring unwrap, and TYPED errors.
//
// Follows the proven marketplace MCP HTTP-client (`callMarketplaceTool`) shape:
// connect → callTool → unwrap → close-in-finally.
// The SESSION HANDSHAKE is a hard requirement (S1 §B2): a bare tools/list returns
// HTTP 400 `-32600 "Missing Mcp-Session-Id header"`; `Client.connect` performs
// the `initialize` handshake (protocolVersion 2025-06-18) and carries
// `Mcp-Session-Id` on every call. Typed errors DISTINGUISH 400-no-session and
// network/timeout (absent stack) from a tool error (§1.3 test contract).
//
// This module is GENERIC over the wire tool name + wire args — the invoker
// (connector-instance-invoker.ts) decides triad translation (toolName →
// `mcp-adapter-execute-ability{ability_name,parameters}`) vs direct call and
// passes the resolved wire coordinates here. The auth header is resolved
// host-side by the caller (Nango → Basic — never the connector toolbox's raw
// `username:applicationPassword` shortcut, §1.3); the token NEVER appears in
// error text.
//
// TESTABILITY: the SDK client is created through an injectable factory so unit
// tests exercise the unwrap/error-classification paths with a fake client and no
// live stack (the live end-to-end proofs ride the S1 capture workflow, §6.2).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Wire-name constants for the always-enrolled triad-only default server (§3.1 /
 * Appendix). The invoker maps a caller `toolName` onto `execute-ability`. */
export const TRIAD_DISCOVER_ABILITIES = "mcp-adapter-discover-abilities";
export const TRIAD_GET_ABILITY_INFO = "mcp-adapter-get-ability-info";
export const TRIAD_EXECUTE_ABILITY = "mcp-adapter-execute-ability";

/** MCP protocol version the mcp-adapter stack pins (S1 §B2 / Appendix). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export type InvokerErrorCode =
  // ── transport-level (this module) ────────────────────────────────────────
  | "network_error" // fetch failure / connection refused (absent stack)
  | "timeout" // aborted / timed out (absent stack)
  | "session_required" // HTTP 400 `-32600 Missing Mcp-Session-Id` (reachable but no session)
  | "tool_error" // isError result — WP_Error passthrough (code + message)
  | "empty_response" // no structuredContent and no text content
  | "invalid_response" // text content that is not JSON
  // ── invoker-level (connector-instance-invoker.ts) ────────────────────────
  | "tool_not_found" // presence-check miss against the cached catalog (§1.4)
  | "instance_pin_mismatch" // connectorKey or instanceId disagrees with the signed pin (§1.2 step 0)
  | "instance_id_required" // no pin + no explicit instanceId on the org-scope path (§1.2 step 0)
  | "connector_key_underivable" // no host-authoritative connectorKey source (guard fail-closed, §1.6)
  | "tool_policy_denied" // per-instance policy denied the resolved tool (§2.6 step 2)
  | "ambiguous_tool" // toolName non-unique across servers; serverId required (§3.6)
  | "catalog_revision_changed"; // a stale cursor was paged against a bumped snapshot (§3.5)

/** A typed transport / invocation error. NEVER carries the auth header or any
 * credential; `message` is safe to surface. `wpErrorCode` carries a WP_Error /
 * structured error code passthrough when the tool returned `isError`. */
export class InvokerError extends Error {
  readonly code: InvokerErrorCode;
  readonly wpErrorCode?: string;
  readonly httpStatus?: number;
  constructor(
    code: InvokerErrorCode,
    message?: string,
    extra?: { wpErrorCode?: string; httpStatus?: number },
  ) {
    super(message ?? `connector instance invoker: ${code}`);
    this.name = "InvokerError";
    this.code = code;
    if (extra?.wpErrorCode) this.wpErrorCode = extra.wpErrorCode;
    if (extra?.httpStatus !== undefined) this.httpStatus = extra.httpStatus;
  }
}

/** The minimal client surface the transport uses — an injection seam so tests
 * exercise the unwrap/classification paths with a fake client (no live stack). */
export type ConnectorInstanceMcpClient = {
  connect(): Promise<void>;
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
};

export type ConnectorInstanceMcpClientFactory = (input: {
  endpoint: string;
  authHeader: string;
}) => ConnectorInstanceMcpClient;

/** The real SDK-backed client factory (default). */
export const defaultConnectorInstanceMcpClientFactory: ConnectorInstanceMcpClientFactory = ({
  endpoint,
  authHeader,
}) => {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: authHeader } },
  });
  const client = new Client({
    name: "cinatra-connector-instance-invoker",
    version: "1.0.0",
  });
  return {
    connect: () => client.connect(transport),
    callTool: (input) => client.callTool(input) as Promise<unknown>,
    close: () => client.close(),
  };
};

function extractText(result: unknown): string | null {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  if (!Array.isArray(content)) return null;
  const textItem = content.find((c) => c.type === "text");
  return textItem && typeof textItem.text === "string" ? textItem.text : null;
}

/** Best-effort WP_Error / structured error code + message from an `isError`
 * result (structuredContent preferred, then a JSON text block). Never throws. */
function extractToolError(result: unknown): { code?: string; message?: string } {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  const readErr = (obj: unknown): { code?: string; message?: string } => {
    if (!obj || typeof obj !== "object") return {};
    const o = obj as Record<string, unknown>;
    const err = (o.error && typeof o.error === "object" ? (o.error as Record<string, unknown>) : o);
    const code = typeof err.code === "string" ? err.code : undefined;
    const message = typeof err.message === "string" ? err.message : undefined;
    return { code, message };
  };
  const fromStructured = readErr(structured);
  if (fromStructured.code || fromStructured.message) return fromStructured;
  const text = extractText(result);
  if (text != null) {
    try {
      return readErr(JSON.parse(text));
    } catch {
      return { message: text.slice(0, 500) };
    }
  }
  return {};
}

/** Classify a thrown connect/call error into the typed absent-stack split:
 * `session_required` (reachable but 400 no-session) vs `timeout` vs
 * `network_error`. Message-based (the SDK surfaces the upstream HTTP/JSON-RPC
 * shape in the error message); never includes the credential. */
export function classifyTransportError(err: unknown): InvokerError {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const msg = raw.toLowerCase();
  if (msg.includes("mcp-session-id") || msg.includes("-32600") || msg.includes("missing session")) {
    return new InvokerError("session_required", "MCP session handshake required (missing Mcp-Session-Id)", {
      httpStatus: 400,
    });
  }
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || msg.includes("timeout") || msg.includes("timed out") || msg.includes("aborted")) {
    return new InvokerError("timeout", "connector instance MCP call timed out");
  }
  return new InvokerError("network_error", "connector instance MCP stack unreachable");
}

/**
 * Connect, call ONE wire tool, unwrap, close. `structuredContent` is preferred
 * (clean JSON object); falls back to the first text content parsed as JSON.
 * `isError` → typed `tool_error` (WP_Error code+message passthrough). A connect
 * failure → the typed absent-stack split (`session_required` / `timeout` /
 * `network_error`). Empty → `empty_response`; non-JSON text → `invalid_response`.
 */
export async function callConnectorInstanceMcpTool(input: {
  endpoint: string;
  authHeader: string;
  name: string;
  arguments: Record<string, unknown>;
  clientFactory?: ConnectorInstanceMcpClientFactory;
}): Promise<unknown> {
  const factory = input.clientFactory ?? defaultConnectorInstanceMcpClientFactory;
  const client = factory({ endpoint: input.endpoint, authHeader: input.authHeader });
  let connected = false;
  try {
    try {
      await client.connect();
      connected = true;
    } catch (err) {
      throw classifyTransportError(err);
    }

    let result: unknown;
    try {
      result = await client.callTool({ name: input.name, arguments: input.arguments });
    } catch (err) {
      // A per-call failure after a successful connect is still an absent-stack /
      // session-class signal (the SDK surfaces the same shapes here).
      throw classifyTransportError(err);
    }

    if ((result as { isError?: boolean }).isError) {
      const { code, message } = extractToolError(result);
      throw new InvokerError("tool_error", message ?? `tool returned an error`, {
        ...(code ? { wpErrorCode: code } : {}),
      });
    }

    const structured = (result as { structuredContent?: unknown }).structuredContent;
    if (structured && typeof structured === "object") {
      return structured;
    }

    const text = extractText(result);
    if (text != null) {
      try {
        return JSON.parse(text);
      } catch {
        throw new InvokerError("invalid_response", "connector instance tool response was not JSON");
      }
    }
    throw new InvokerError("empty_response", "connector instance tool returned an empty response");
  } finally {
    if (connected) await client.close().catch(() => {});
  }
}
