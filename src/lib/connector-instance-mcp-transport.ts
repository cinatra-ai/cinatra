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
  | "catalog_revision_changed" // a stale cursor was paged against a bumped snapshot (§3.5)
  | "catalog_unavailable" // an explicitly-targeted enrolled server has no obtainable snapshot (cinatra#2018 S3)
  // ── destructive-confirmation (cinatra#2020 S5, invoker step 3) ───────────
  | "pending_confirmation" // destructive call PARKED pending the user's explicit confirmation — NOT executed; the message text is the model-facing rendering (§2.1)
  | "confirmation_unavailable" // confirmation subsystem/store failure or pending-cap hit — REFUSED fail-closed rather than executing unconfirmed (§2.3)
  | "confirmation_args_too_large" // args exceed the 256 KB canonical-JSON confirmation cap — an uninspectable blob must not be one-click-approved (§2.3)
  // ── content-review (cinatra#2022 S7 PR-σ, invoker step 3b — sibling to
  // the destructive-confirmation hook above, same fail-closed doctrine) ────
  | "content_review_hold" // a content-classified write was HELD pending review — NOT executed; message is the model-facing rendering, same contract shape as pending_confirmation
  | "content_review_rejected" // a content-classified write was REJECTED by the review gate — NOT executed and will not silently be retried without rework
  | "content_review_unavailable"; // the content-review subsystem failed inside the hook — REFUSED fail-closed rather than executing unreviewed (mirrors confirmation_unavailable)

/**
 * STABLE machine prefix of the `pending_confirmation` InvokerError message
 * (cinatra#2020 §2.1), exported beside the error code. Today's chat panel uses
 * a client-side match on THIS constant as its poll trigger after a parked tool
 * result, and a future #1216 first-class approval view keys on it without
 * re-parsing prose — never re-word it. The full message contract lives in
 * `buildPendingConfirmationMessage` (connector-instance-destructive-hook.ts).
 */
export const PENDING_CONFIRMATION_MESSAGE_PREFIX = "pending_confirmation:";

/** A typed transport / invocation error. NEVER carries the auth header or any
 * credential; `message` is safe to surface. `wpErrorCode` carries a WP_Error /
 * structured error code passthrough when the tool returned `isError`.
 * `reviewHoldId` (cinatra#2022 S7 PR-σ) carries the content-review hook's own
 * `holdId` for `content_review_hold` / `content_review_rejected` — structured
 * correlation for a caller that needs it programmatically, mirroring how the
 * destructive-confirmation hook's `pendingCallId` is (today) message-text-only;
 * this gives the newer content-review path a structured field instead. */
export class InvokerError extends Error {
  readonly code: InvokerErrorCode;
  readonly wpErrorCode?: string;
  readonly httpStatus?: number;
  readonly reviewHoldId?: string;
  constructor(
    code: InvokerErrorCode,
    message?: string,
    extra?: { wpErrorCode?: string; httpStatus?: number; reviewHoldId?: string },
  ) {
    super(message ?? `connector instance invoker: ${code}`);
    this.name = "InvokerError";
    this.code = code;
    if (extra?.wpErrorCode) this.wpErrorCode = extra.wpErrorCode;
    if (extra?.httpStatus !== undefined) this.httpStatus = extra.httpStatus;
    if (extra?.reviewHoldId) this.reviewHoldId = extra.reviewHoldId;
  }
}

/** The minimal client surface the transport uses — an injection seam so tests
 * exercise the unwrap/classification paths with a fake client (no live stack). */
export type ConnectorInstanceMcpClient = {
  connect(): Promise<void>;
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
};

/** The list-capable client surface (`tools/list`) consumed by
 * `listConnectorInstanceMcpTools` (cinatra#2018 S3 §2). A SEPARATE extension of
 * the call surface so `ConnectorInstanceMcpClient` stays additive for existing
 * call-only implementors (codex round-1 Medium); the real SDK `Client`
 * implements both. */
export type ConnectorInstanceMcpListClient = ConnectorInstanceMcpClient & {
  listTools(): Promise<unknown>;
};

export type ConnectorInstanceMcpClientFactory = (input: {
  endpoint: string;
  authHeader: string;
}) => ConnectorInstanceMcpClient;

export type ConnectorInstanceMcpListClientFactory = (input: {
  endpoint: string;
  authHeader: string;
}) => ConnectorInstanceMcpListClient;

/** The real SDK-backed client factory (default). Typed as the LIST-capable
 * factory (a subtype of `ConnectorInstanceMcpClientFactory` by return-type
 * covariance), so it serves both the call path and the list path. */
export const defaultConnectorInstanceMcpClientFactory: ConnectorInstanceMcpListClientFactory = ({
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
    listTools: () => client.listTools() as Promise<unknown>,
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

/**
 * Connect, call the wire `tools/list` ONCE, unwrap the `tools[]` rows, close.
 * The additive per-server catalog primitive (§2): the snapshot loader calls this
 * once per (instance, server) to BOTH (a) classify exposure mode by inspecting
 * the returned wire tool names for the triad trio and (b) build the first-class
 * snapshot from the same rows — one wire round-trip serves both.
 *
 * Returns the raw `tools[]` records (may be EMPTY — a server can legitimately
 * expose zero tools; that is not an error, it classifies as a first-class server
 * with no tools). A well-formed response missing its `tools` array is
 * `invalid_response`. A connect / list failure maps through the SAME typed
 * absent-stack split as `callConnectorInstanceMcpTool`
 * (`session_required` / `timeout` / `network_error`). NEVER carries the auth
 * header in an error (the classifier composes its own message).
 */
export async function listConnectorInstanceMcpTools(input: {
  endpoint: string;
  authHeader: string;
  clientFactory?: ConnectorInstanceMcpListClientFactory;
}): Promise<Array<Record<string, unknown>>> {
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
      result = await client.listTools();
    } catch (err) {
      // A list failure after a successful connect is still an absent-stack /
      // session-class signal (the SDK surfaces the same shapes here).
      throw classifyTransportError(err);
    }

    // Guard before property access: a null/undefined result must map to the
    // typed `invalid_response`, never a raw TypeError (codex round-0 Low).
    const tools =
      result && typeof result === "object" ? (result as { tools?: unknown }).tools : undefined;
    if (!Array.isArray(tools)) {
      throw new InvokerError("invalid_response", "connector instance tools/list returned no tools array");
    }
    // Keep only object rows so the return type is honest; non-object wire
    // entries are not valid MCP tool descriptors and are dropped defensively.
    return tools.filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null);
  } finally {
    if (connected) await client.close().catch(() => {});
  }
}
