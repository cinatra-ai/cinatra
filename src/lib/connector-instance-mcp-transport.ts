import "server-only";

// Governed connector-instance MCP transport (cinatra#2017 S2 slice K5, design
// §1.3). Plane C's wire layer: reach a connector instance's own MCP catalog
// through the MCP SDK `Client` + Streamable HTTP, with a single host-side auth
// source, structuredContent-preferring unwrap, and TYPED errors.
//
// Follows the proven marketplace MCP HTTP-client (`callMarketplaceTool`) shape:
// connect → callTool → unwrap → close-in-finally.
//
// PROTOCOL REVISION (cinatra#2218 L2d). This surface runs
// `@modelcontextprotocol/client@2.0.0` with EXPLICIT
// `versionNegotiation: { mode: 'auto' }` — see
// `CONNECTOR_INSTANCE_VERSION_NEGOTIATION` below for why per-peer negotiation is
// the only correct posture here, and for the bare-string trap the object form
// guards against. The old hand-rolled revision constant is gone: the client
// negotiates, so no source file may claim a revision.
//
// The SESSION HANDSHAKE remains a hard requirement of TODAY'S pinned peer (S1
// §B2, re-verified live against mcp-adapter 0.5.0 on 2026-08-05): a bare
// tools/list returns HTTP 400 `-32600 "Invalid Request: Missing Mcp-Session-Id
// header"`, and a modern `server/discover` probe is refused the SAME way, so the
// peer is a sessionful 2025-era server. Under `{ mode: 'auto' }` that refusal is
// a legacy VERDICT, not a failure: the client falls back to the `initialize`
// handshake and the peer mints an `Mcp-Session-Id`.
//
// That session id is minted and held BY THE CLIENT LIBRARY and stays
// TRANSPORT-PRIVATE. cinatra never reads, persists, routes, or authorizes on it;
// this module holds no reference to it and exposes no accessor for it, and it
// reaches no application value, log line, or error this module composes —
// cinatra#2218 acceptance criterion 4 as restated by maintainer approval
// 2026-08-05, locked by the AC4 suite in
// `src/lib/__tests__/connector-instance-mcp-negotiation.test.ts`.
//
// Stated precisely, because one channel is outside cinatra's control: a
// `tool_error` message is PEER-AUTHORED passthrough, so a peer that chose to
// write its own session id into a tool-result payload would surface that text.
// That is the peer disclosing a value it owns, not cinatra taking a protocol
// session id as application or authorization state, which is what AC4 forbids.
// The credential — a value cinatra DOES hold — is redacted from that same
// passthrough (see `redactCredential`).
//
// Typed errors DISTINGUISH 400-no-session and network/timeout (absent stack)
// from a tool error (§1.3 test contract).
//
// BOUNDED SESSION-RETRY: the pinned third-party WordPress mcp-adapter plugin's
// SessionManager does an unprotected read-modify-write when persisting its
// session list, so concurrent session creations can race and silently drop a
// just-established session. The next call against that session gets a clean
// HTTP 404 `-32005 "session not found"` — classified here as its own
// `session_not_found` code (distinct from `session_required`, which is "never
// had a session"). On that error EXACTLY, `callConnectorInstanceMcpTool` /
// `listConnectorInstanceMcpTools` drop the dead client, re-establish a FRESH
// session via a brand-new client from the factory, and retry the original call
// ONCE. A second consecutive `session_not_found` is not retried again — it
// surfaces as-is. No other error class is ever retried.
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

import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { VersionNegotiationOptions } from "@modelcontextprotocol/client";

/** Wire-name constants for the always-enrolled triad-only default server (§3.1 /
 * Appendix). The invoker maps a caller `toolName` onto `execute-ability`. */
export const TRIAD_DISCOVER_ABILITIES = "mcp-adapter-discover-abilities";
export const TRIAD_GET_ABILITY_INFO = "mcp-adapter-get-ability-info";
export const TRIAD_EXECUTE_ABILITY = "mcp-adapter-execute-ability";

// ---------------------------------------------------------------------------
// Protocol-era negotiation (cinatra#2218 L2d).
//
// `{ mode: 'auto' }` — probe `server/discover` for the modern revision, fall
// back to the 2025-era `initialize` handshake when the peer refuses it.
//
// WHY AUTO, and not the pinned-peer `{ mode: 'legacy' }` the graphiti surface
// (L2a) ships: this surface's peers are INDEPENDENTLY-OPERATED WordPress and
// Drupal adapter instances at CUSTOMER URLs. cinatra neither controls nor pins
// them, they differ per instance row, and each can gain `2026-07-28` — or drop
// the 2025-era `initialize` — with no change in this repo and no signal that
// would prompt one. The supported-revisions contract scopes its explicit-legacy
// exception to a peer that is KNOWN 2025-era AND PINNED; that exception cannot
// reach a customer-operated endpoint. Per-peer negotiation is the only posture
// that can be correct for every row at once.
//
// The price today is one refused round trip per connect against a peer still on
// the 2025 era, measured live against the pinned mcp-adapter 0.5.0 fixture:
// the probe is answered HTTP 400 `-32600 "Invalid Request: Missing
// Mcp-Session-Id header"`, which `classifyHttpError` -> `classifyRpcError`
// resolves to a LEGACY verdict (not an error), and the handshake proceeds.
//
// THE BARE-STRING TRAP. `versionNegotiation` is an OPTIONS OBJECT whose default
// mode is `'legacy'`: written as a bare string (`versionNegotiation: 'auto'`)
// the client reads `options?.mode` as `undefined` and silently selects legacy,
// producing a fully working client that never issued a probe. Two independent
// guards: typing this constant as `VersionNegotiationOptions` makes the bare
// string a COMPILE ERROR at the call site, and the tests assert the OBJECT
// reaches the `Client` constructor with `mode === 'auto'`.
//
// `connector-instance-mcp-wire-negotiation.manual.test.ts` is the re-runnable
// live probe behind every number above. When the pinned adapter starts
// answering `server/discover`, its auto-falls-back-to-legacy assertion FAILS —
// and that failure is the signal to move this row to the modern revision, with
// no code change needed for the negotiation itself.
// ---------------------------------------------------------------------------
export const CONNECTOR_INSTANCE_VERSION_NEGOTIATION: VersionNegotiationOptions = { mode: "auto" };

export type InvokerErrorCode =
  // ── transport-level (this module) ────────────────────────────────────────
  | "network_error" // fetch failure / connection refused (absent stack)
  | "timeout" // aborted / timed out (absent stack)
  | "session_required" // HTTP 400 `-32600 Missing Mcp-Session-Id` (reachable but no session)
  | "session_not_found" // HTTP 404 `-32005 session not found` — a previously-live session was dropped server-side (WP mcp-adapter SessionManager race). The transport retries ONCE with a freshly re-established session before ever surfacing this; seeing it means the retry ALSO hit a dropped session.
  | "transport_error" // the peer ANSWERED (or the client library failed locally) in a way this transport cannot attribute to unreachability — the FAIL-CLOSED default of `classifyTransportError` (cinatra#2218 L2d). Carries `httpStatus` whenever an HTTP status was received, so the invoker's health mapper can still reach `auth_error` on 401/403.
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
  /**
   * Did the peer deliver ANY HTTP response during this client's lifetime?
   *
   * The real factory wires this to the same latch that gates the connect
   * brand, so `classifyTransportError` can refuse the two RELAXING codes once
   * the peer has demonstrably answered — a request timeout on `tools/call`
   * AFTER a completed handshake is a hung peer, not an unreachable one, and
   * must not clear the `unreachable` health state (codex round-1 blocker 1).
   *
   * OPTIONAL so the type stays additive for existing injected fakes; a client
   * that does not report it is treated as "cannot prove the peer answered",
   * which is the conservative reading for the SESSION codes and the honest one
   * for a fake that never touched a socket.
   */
  peerAnswered?(): boolean;
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
/**
 * Brand stamped on a rejection PROVEN to have happened before any HTTP response
 * was received on this connect-call-close cycle. It is the ONLY evidence
 * `classifyTransportError` accepts for `network_error` — no error CLASS is
 * treated as proof, because undici raises `TypeError` both for a connect failure
 * (`fetch failed`) and for a response that arrived and then died mid-body
 * (`terminated`). Module-private: nothing outside this transport consumes it.
 */
const CONNECT_FAILURE_BRAND = Symbol.for("cinatra.connector-instance-mcp.connect-failure");

/** Read a property without letting a throwing getter or a Proxy trap escape into
 * the classifier (codex round-1 finding 3). */
function safeGet(obj: object, key: PropertyKey): unknown {
  try {
    return (obj as Record<PropertyKey, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** OWN-property brand test. An own-property check (rather than a plain `in` /
 * member read) closes the prototype-pollution path: writing
 * `Object.prototype[CONNECT_FAILURE_BRAND] = true` would otherwise make EVERY
 * rejection look like a proven connect failure, i.e. flip the whole allowlist
 * fail-open (codex round-1 finding 3). */
function hasConnectFailureBrand(err: object): boolean {
  try {
    return Object.getOwnPropertyDescriptor(err, CONNECT_FAILURE_BRAND)?.value === true;
  } catch {
    return false;
  }
}

/**
 * Wrap a `fetch` so a rejection of the `fetch()` call ITSELF — and only such a
 * rejection — carries {@link CONNECT_FAILURE_BRAND}.
 *
 * Two conditions, both necessary:
 *
 *  1. The rejection is of the `fetch()` call itself. Once the promise resolves,
 *     a status and headers arrived, so a later body-stream failure is outside
 *     the `try` and stays unbranded.
 *  2. NO response has been seen yet on this transport. The wrapper is created
 *     per client, so the latch spans exactly one connect-call-close cycle — and
 *     that cycle issues several requests (the `{ mode: 'auto' }`
 *     `server/discover` probe, `initialize`, the initialized notification, the
 *     standalone `GET` stream, the call, the closing `DELETE`). If ANY of them
 *     came back the peer demonstrably answered, so a later socket loss is not
 *     evidence of an unreachable peer.
 *
 * Behaviour-neutral otherwise: the identical `Response` is returned untouched
 * and the identical rejection rethrown. Branding is best-effort — a frozen or
 * primitive rejection value cannot carry the mark and therefore classifies
 * `transport_error`, which fails CLOSED.
 */
function brandConnectFailures(inner: typeof fetch): {
  fetch: typeof fetch;
  /** True once ANY response has been delivered on this transport. */
  peerAnswered: () => boolean;
} {
  let responseSeen = false;
  return {
    peerAnswered: () => responseSeen,
    fetch: async function brandedFetch(input, init) {
      try {
        const response = await inner(input, init);
        responseSeen = true;
        return response;
      } catch (err) {
        if (!responseSeen && err !== null && typeof err === "object") {
          try {
            Object.defineProperty(err, CONNECT_FAILURE_BRAND, {
              value: true,
              enumerable: false,
              configurable: true,
            });
          } catch {
            // Frozen/sealed rejection value — leave it unbranded (fails CLOSED).
          }
        }
        throw err;
      }
    },
  };
}

export const defaultConnectorInstanceMcpClientFactory: ConnectorInstanceMcpListClientFactory = ({
  endpoint,
  authHeader,
}) => {
  // `requestInit.headers` IS merged into every request (the transport folds it
  // over its own via `normalizeHeaders(this._requestInit?.headers)`), so the
  // host-resolved auth header rides each frame. `requestInit.signal` is NOT —
  // both this transport and the v1 one build each request as
  // `{ ...requestInit, method, headers, signal }`, so a caller-supplied signal
  // is overwritten and bounds nothing (measured on cinatra#2218 L2c against a
  // black-hole peer: a 1200 ms `requestInit.signal` returned only after the
  // protocol timeout). This surface carries no per-call deadline today and did
  // not carry one before the migration; a future deadline must ride the
  // transport's `fetch` option and `connect(transport, { timeout })`, which ARE
  // honoured — never `requestInit`.
  const seam = brandConnectFailures(fetch);
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: authHeader } },
    fetch: seam.fetch,
  });
  const client = new Client(
    {
      name: "cinatra-connector-instance-invoker",
      version: "1.0.0",
    },
    { versionNegotiation: CONNECTOR_INSTANCE_VERSION_NEGOTIATION },
  );
  return {
    connect: () => client.connect(transport),
    callTool: (input) => client.callTool(input) as Promise<unknown>,
    listTools: () => client.listTools() as Promise<unknown>,
    close: () => client.close(),
    peerAnswered: seam.peerAnswered,
  };
};

function extractText(result: unknown): string | null {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  if (!Array.isArray(content)) return null;
  const textItem = content.find((c) => c.type === "text");
  return textItem && typeof textItem.text === "string" ? textItem.text : null;
}

/**
 * Remove the host-resolved auth header — whole, and its bare token half — from
 * PEER-AUTHORED text before it becomes an `InvokerError` message.
 *
 * The scheme is split off because a peer echoing the credential is most likely
 * to echo the value it was sent (`Basic dXNlcjpwdw==`) but may log only the
 * token. Nothing else in this module needs redaction: every other message is a
 * fixed string composed here.
 */
function redactCredential(text: string | undefined, authHeader: string): string | undefined {
  if (!text) return text;
  let out = text;
  for (const secret of credentialForms(authHeader)) {
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

/**
 * Every form of the credential a peer could echo back, longest first.
 *
 * The wire form is `Basic base64(username:applicationPassword)` (built in
 * `register-host-connector-services.ts`), and the peer MUST decode it to
 * authenticate — so redacting only the header and its Base64 token leaves the
 * DECODED pair and the bare application password free to travel back through a
 * peer-authored tool-error message (codex round-3 blocker, reproduced live).
 *
 * The username alone is deliberately NOT redacted: it is an identifier rather
 * than a secret, and scrubbing it would shred ordinary error prose.
 *
 * Longest-first ordering matters — replacing the bare password before the full
 * pair would leave a `user:[redacted]` fragment instead of one clean marker.
 *
 * NO minimum-length exemption: a WordPress application password may be short, so
 * a length floor would leave a real credential in the text (codex round-2). Only
 * the empty string is skipped, because `split("")` would shred the message.
 */
function credentialForms(authHeader: string): string[] {
  const forms = new Set<string>();
  const add = (v: string | undefined) => {
    if (v && v.length > 0) forms.add(v);
  };
  add(authHeader);

  const spaceAt = authHeader.indexOf(" ");
  const scheme = spaceAt >= 0 ? authHeader.slice(0, spaceAt) : "";
  const token = spaceAt >= 0 ? authHeader.slice(spaceAt + 1) : "";
  add(token);

  if (scheme.toLowerCase() === "basic" && token) {
    try {
      const decoded = Buffer.from(token, "base64").toString("utf8");
      // Only trust a ROUND-TRIPPABLE decode. `Buffer.from(x, "base64")` never
      // throws — it silently drops invalid characters — so without this check a
      // non-Base64 token would yield mojibake and add a junk redaction term.
      const reencoded = Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "");
      if (decoded && reencoded === token.replace(/=+$/, "")) {
        add(decoded); // username:applicationPassword
        const colon = decoded.indexOf(":");
        if (colon >= 0) add(decoded.slice(colon + 1)); // the password alone
      }
    } catch {
      // Not decodable — the header and token forms above still apply.
    }
  }

  return [...forms].sort((a, b) => b.length - a.length);
}

/**
 * Best-effort WP_Error / structured error code + message from an `isError`
 * result (structuredContent preferred, then a JSON text block). Never throws.
 *
 * Takes `authHeader` so redaction happens BEFORE the non-JSON fallback's 500-char
 * truncation. Truncating first would slice through a credential and emit the
 * surviving prefix un-redacted (codex round-2 finding 3).
 */
function extractToolError(result: unknown, authHeader: string): { code?: string; message?: string } {
  const scrub = (v: string | undefined) => redactCredential(v, authHeader);
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  const readErr = (obj: unknown): { code?: string; message?: string } => {
    if (!obj || typeof obj !== "object") return {};
    const o = obj as Record<string, unknown>;
    const err = (o.error && typeof o.error === "object" ? (o.error as Record<string, unknown>) : o);
    const code = typeof err.code === "string" ? scrub(err.code) : undefined;
    const message = typeof err.message === "string" ? scrub(err.message) : undefined;
    return { code, message };
  };
  const fromStructured = readErr(structured);
  if (fromStructured.code || fromStructured.message) return fromStructured;
  const text = extractText(result);
  if (text != null) {
    try {
      return readErr(JSON.parse(text));
    } catch {
      // Redact, THEN truncate.
      return { message: scrub(text)!.slice(0, 500) };
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Transport-error classification (reworked for `@modelcontextprotocol/client@2.0.0`,
// cinatra#2218 L2d).
//
// It is an ALLOWLIST and it fails CLOSED. Only two codes relax anything
// downstream — `network_error` and `timeout` are the pair
// `mapCatalogLoadErrorToServerHealth` (connector-instance-invoker.ts) maps to
// the `unreachable` server-health state; every other code maps to
// `catalog_unavailable`, which is also a TOCTOU denial code in the pending-call
// executor. So `unreachable` is the RELAXED outcome, and this function now
// requires POSITIVE PROOF before reaching it. Everything it cannot prove becomes
// `transport_error`.
//
// That inverts the pre-migration default and TIGHTENS the classifier. The old
// body was a message-prefix matcher whose FINAL statement was an unconditional
// `return new InvokerError("network_error", ...)`: every shape it did not
// enumerate — a peer's HTTP 500, an HTTP 401/403, a schema-validation failure, a
// JSON-RPC error response — fell through to `network_error` and reported a
// demonstrably REACHABLE, ANSWERING peer as unreachable. Two consequences,
// both fixed here:
//
//   * an auth wall (401/403) reached `unreachable` rather than `auth_error`,
//     because the old classifier attached `httpStatus` to the two session codes
//     ONLY, so the health mapper's 401/403 branch could never fire;
//   * a peer that answered every request with an error still cleared the
//     `unreachable` health state.
//
// Measured v1 -> v2 error-class map for this surface (v1 =
// `@modelcontextprotocol/sdk@1.29.0`):
//
//   failure mode                      v1                      v2
//   --------------------------------  ----------------------  ----------------------
//   peer unreachable (ECONNREFUSED,   TypeError               SdkError(EraNegotiation
//     DNS, TLS) under `auto`          "fetch failed"           Failed), original on
//                                                              `.data.cause`
//   peer answers non-OK HTTP          StreamableHTTPError     SdkHttpError
//                                     (name "Error", message  (name "SdkHttpError",
//                                      prefixed "Streamable    `.status`, `.data.text`
//                                      HTTP error: ")          = the raw body)
//   peer answers a JSON-RPC error     McpError                ProtocolError
//                                     ("MCP error <code>: ")  (`.code` = the code)
//   request timeout                   McpError(-32001)        SdkError(RequestTimeout)
//
// THE PREFIX MATCHERS ARE GONE IN v2, which is why the session split is now read
// STRUCTURALLY — the HTTP status off `SdkHttpError.status` and the JSON-RPC code
// parsed out of `SdkHttpError.data.text` (the pinned WordPress mcp-adapter
// answers `tools/list` without a session HTTP 400 with a JSON-RPC `-32600` body,
// and a dropped session HTTP 404 with `-32005`). A text tail is retained for
// BOTH session codes only, and it is safe there precisely because neither code
// relaxes anything: it cannot move a failure into `unreachable`.
//
// The `timeout` text tail is DELETED. `timeout` relaxes, and the old
// `msg.includes("timeout")` read a string a PEER controls — a 500 body reading
// "gateway timed out" classified the answering peer as unreachable. Timeout is
// now proven from `SdkErrorCode.RequestTimeout` or from the `AbortSignal`
// contract (`err.name`), neither of which a response body can forge, and it is
// unreachable at all once the peer has demonstrably answered.
// ---------------------------------------------------------------------------

/** True when `err` carries the pre-response connect brand — directly, or through
 * the `{ mode: 'auto' }` negotiator's wrapper, which records the original error
 * on `.data.cause` when the `server/discover` probe fails before a response. */
function isPreResponseNetworkFailure(err: unknown, depth = 0): boolean {
  if (err === null || typeof err !== "object") return false;
  // OWN-property only, and read through a guarded descriptor lookup: a plain
  // member read would accept an inherited brand from a polluted prototype, and
  // a Proxy trap or throwing getter would escape into the classifier.
  if (hasConnectFailureBrand(err)) return true;
  // An HTTP status was received — even when the negotiator labels the failure
  // with the same `EraNegotiationFailed` code a network failure carries. Tested
  // BEFORE the SdkError branch below, because SdkHttpError is a SUBCLASS of it.
  if (err instanceof SdkHttpError) return false;
  if (depth >= 4) return false;
  if (err instanceof SdkError) {
    const data = safeGet(err, "data");
    const cause = data !== null && typeof data === "object" ? safeGet(data, "cause") : undefined;
    if (cause !== undefined) return isPreResponseNetworkFailure(cause, depth + 1);
  }
  const cause = safeGet(err, "cause");
  return cause !== undefined ? isPreResponseNetworkFailure(cause, depth + 1) : false;
}

/** The JSON-RPC error code the peer answered with, read STRUCTURALLY: off a
 * `ProtocolError` (where v2 puts it directly) or parsed out of the raw body an
 * `SdkHttpError` carries on `.data.text`. `undefined` when no JSON-RPC error
 * body is present. Never throws. */
function jsonRpcErrorCode(err: unknown): number | undefined {
  if (err instanceof ProtocolError && typeof err.code === "number") return err.code;
  if (!(err instanceof SdkHttpError)) return undefined;
  const data = safeGet(err, "data");
  const text = data !== null && typeof data === "object" ? safeGet(data, "text") : undefined;
  if (typeof text !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const code = (parsed as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === "number" ? code : undefined;
  } catch {
    return undefined;
  }
}

/** The HTTP status, when one was received. Doubles as the "the peer answered"
 * predicate for the fail-closed branches below. */
function httpStatusOf(err: unknown): number | undefined {
  if (!(err instanceof SdkHttpError)) return undefined;
  const status = safeGet(err, "status");
  return typeof status === "number" ? status : undefined;
}

/**
 * Classify a thrown connect/call error into the typed absent-stack split:
 * `session_required` (reachable but no session) vs `session_not_found`
 * (reachable — a session THAT EXISTED got dropped server-side) vs `timeout` vs
 * `network_error`, with `transport_error` as the FAIL-CLOSED default.
 *
 * `context.peerAnswered` reports whether the peer delivered ANY HTTP response
 * during this connect-call-close cycle. It is what makes the allowlist actually
 * closed: a request timeout raised AFTER a completed handshake carries no HTTP
 * status of its own, so without this signal it would read as `timeout` and clear
 * the `unreachable` health state for a peer that is demonstrably reachable and
 * merely hung (codex round-1 blocker 1). Omitted (an injected fake with no
 * socket) means "cannot prove the peer answered".
 *
 * Never includes the credential: every message is composed here, and the raw
 * error's own text is never echoed.
 */
export function classifyTransportError(err: unknown, context?: { peerAnswered?: boolean }): InvokerError {
  try {
    return classifyTransportErrorInner(err, context);
  } catch {
    // TOTAL BY CONSTRUCTION. A rejection value is arbitrary — a Proxy, an object
    // with throwing `message`/`name` getters, an exotic `Symbol.hasInstance`.
    // Any of those could make a read or an `instanceof` throw, which would
    // replace the typed `InvokerError` every consumer branches on with a raw
    // error escaping the transport (codex round-2 finding 4). Failing to the
    // fail-CLOSED code keeps the contract and never reaches `unreachable`.
    return new InvokerError("transport_error", "connector instance MCP call failed");
  }
}

function classifyTransportErrorInner(err: unknown, context?: { peerAnswered?: boolean }): InvokerError {
  const raw = err instanceof Error ? String(safeGet(err, "message") ?? "") : String(err ?? "");
  const msg = raw.toLowerCase();
  const status = httpStatusOf(err);
  const rpcCode = jsonRpcErrorCode(err);
  // `answered` = the peer demonstrably responded — either on THIS error (it
  // carries an HTTP status / is a JSON-RPC error response) or earlier in the
  // same cycle (the transport's own response latch). Once true, neither
  // relaxing code is reachable, whatever the message text says.
  const answered = status !== undefined || err instanceof ProtocolError || context?.peerAnswered === true;

  // --- session split. `session_not_found` is the ONE code that costs a retry,
  // and a replayed `tools/call` can RE-EXECUTE A MUTATING ABILITY. So it
  // requires the pinned adapter's documented contract EXACTLY and in full:
  // HTTP 404 **and** JSON-RPC `-32005`. Neither half alone qualifies
  // (codex rounds 1-2):
  //   * a mistyped endpoint also answers 404;
  //   * a 500 — or a stateless/modern `ProtocolError` — can carry `-32005`
  //     without there being a dropped 2025-era session to re-establish.
  // Everything session-shaped that misses this contract falls through to
  // `session_required`, which is non-relaxing AND never retries.
  const saysSessionGone = msg.includes("-32005") || msg.includes("session not found");
  if (status === 404 && rpcCode === -32005) {
    return new InvokerError(
      "session_not_found",
      "connector instance MCP session no longer exists (session not found)",
      { httpStatus: status ?? 404 },
    );
  }
  // `session_required` does NOT retry, so its text tail is safe: the worst it
  // can do is relabel one non-relaxing code as another non-relaxing code.
  if (
    rpcCode === -32600 ||
    msg.includes("mcp-session-id") ||
    msg.includes("-32600") ||
    msg.includes("missing session") ||
    saysSessionGone
  ) {
    return new InvokerError("session_required", "MCP session handshake required (missing Mcp-Session-Id)", {
      httpStatus: status ?? 400,
    });
  }

  // --- timeout: proven from the SDK code or the AbortSignal contract only.
  const name = err instanceof Error ? String(safeGet(err, "name") ?? "") : "";
  const isTimeout =
    (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) ||
    name === "AbortError" ||
    name === "TimeoutError";
  if (isTimeout && !answered) {
    return new InvokerError("timeout", "connector instance MCP call timed out");
  }

  // --- network_error: the BRAND is the only accepted proof, and only while the
  // peer has answered nothing at all. What the brand proves is precisely "no
  // HTTP response was received" — which is exactly what the `unreachable` health
  // state asserts. It does NOT prove no packet reached the peer: a peer that
  // accepts the request and resets before sending headers is indistinguishable
  // from a connect failure at the `fetch` API, for any caller (codex round-1
  // finding 4). That is a stated ceiling, not an unnoticed gap.
  if (!answered && isPreResponseNetworkFailure(err)) {
    return new InvokerError("network_error", "connector instance MCP stack unreachable");
  }

  // --- fail CLOSED. Carry the HTTP status so the invoker's health mapper can
  // still reach `auth_error` on 401/403 instead of burying it here.
  return new InvokerError("transport_error", "connector instance MCP call failed", {
    ...(status !== undefined ? { httpStatus: status } : {}),
  });
}

/** ONE connect → callTool → unwrap → close-in-finally attempt, on a FRESH
 * client from `factory` (a fresh client means a fresh `initialize` handshake,
 * i.e. a brand-new server-side session — this is what "re-establish the
 * session" means for the retry in `callConnectorInstanceMcpTool` below). Every
 * attempt closes its own client regardless of outcome, so a retried attempt
 * never reuses a dead session or leaks the superseded client. */
async function attemptConnectAndCallTool(
  factory: ConnectorInstanceMcpClientFactory,
  input: { endpoint: string; authHeader: string; name: string; arguments: Record<string, unknown> },
): Promise<unknown> {
  const client = factory({ endpoint: input.endpoint, authHeader: input.authHeader });
  let connected = false;
  try {
    try {
      await client.connect();
      connected = true;
    } catch (err) {
      throw classifyTransportError(err, { peerAnswered: client.peerAnswered?.() === true });
    }

    let result: unknown;
    try {
      result = await client.callTool({ name: input.name, arguments: input.arguments });
    } catch (err) {
      // A per-call failure after a successful connect is still an absent-stack /
      // session-class signal (the SDK surfaces the same shapes here). `connect()`
      // ALREADY SUCCEEDED here, which is itself positive evidence the peer
      // answered — so this path asserts it rather than consulting the optional
      // latch, closing the fail-open an injected client without `peerAnswered`
      // would otherwise leave (codex round-2 finding 2).
      throw classifyTransportError(err, { peerAnswered: true });
    }

    if ((result as { isError?: boolean }).isError) {
      // `tool_error` is the ONE code whose message is PEER-AUTHORED (the WP_Error
      // passthrough is the point of it). The peer already holds the credential —
      // cinatra sends it — so echoing it back is not a disclosure TO the peer,
      // but it would carry it into cinatra's logs and UI, where the module
      // header promises it never appears. `extractToolError` redacts on the way
      // through, before any truncation (codex rounds 1-2). Applied to the
      // passthrough only; every other code's message is composed by this module
      // and cannot contain it.
      const { code, message } = extractToolError(result, input.authHeader);
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
 * Connect, call ONE wire tool, unwrap, close. `structuredContent` is preferred
 * (clean JSON object); falls back to the first text content parsed as JSON.
 * `isError` → typed `tool_error` (WP_Error code+message passthrough). A connect
 * failure → the typed absent-stack split (`session_required` / `session_not_found`
 * / `timeout` / `network_error`). Empty → `empty_response`; non-JSON text →
 * `invalid_response`.
 *
 * BOUNDED RETRY: a `session_not_found` (the dropped-session race, see the
 * module header) triggers exactly ONE retry — a brand-new client/session via
 * `factory`, replaying the same `name`/`arguments`. Any other error, or a
 * SECOND consecutive `session_not_found`, propagates immediately; there is no
 * retry loop.
 */
export async function callConnectorInstanceMcpTool(input: {
  endpoint: string;
  authHeader: string;
  name: string;
  arguments: Record<string, unknown>;
  clientFactory?: ConnectorInstanceMcpClientFactory;
}): Promise<unknown> {
  const factory = input.clientFactory ?? defaultConnectorInstanceMcpClientFactory;
  try {
    return await attemptConnectAndCallTool(factory, input);
  } catch (err) {
    if (err instanceof InvokerError && err.code === "session_not_found") {
      return await attemptConnectAndCallTool(factory, input);
    }
    throw err;
  }
}

/** ONE connect → listTools → unwrap → close-in-finally attempt, on a FRESH
 * client from `factory` — see `attemptConnectAndCallTool` above for why a
 * fresh client is what "re-establish the session" means for the retry. */
async function attemptConnectAndListTools(
  factory: ConnectorInstanceMcpListClientFactory,
  input: { endpoint: string; authHeader: string },
): Promise<Array<Record<string, unknown>>> {
  const client = factory({ endpoint: input.endpoint, authHeader: input.authHeader });
  let connected = false;
  try {
    try {
      await client.connect();
      connected = true;
    } catch (err) {
      throw classifyTransportError(err, { peerAnswered: client.peerAnswered?.() === true });
    }

    let result: unknown;
    try {
      result = await client.listTools();
    } catch (err) {
      // A list failure after a successful connect is still an absent-stack /
      // session-class signal. As on the call path, `connect()` already
      // succeeded, so the peer demonstrably answered (codex round-2 finding 2).
      throw classifyTransportError(err, { peerAnswered: true });
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
 * (`session_required` / `session_not_found` / `timeout` / `network_error`).
 * NEVER carries the auth header in an error (the classifier composes its own
 * message).
 *
 * BOUNDED RETRY: same ONE-retry contract as `callConnectorInstanceMcpTool` —
 * a `session_not_found` re-establishes a fresh session and retries the
 * `tools/list` once; any other error, or a second consecutive
 * `session_not_found`, propagates immediately.
 */
export async function listConnectorInstanceMcpTools(input: {
  endpoint: string;
  authHeader: string;
  clientFactory?: ConnectorInstanceMcpListClientFactory;
}): Promise<Array<Record<string, unknown>>> {
  const factory = input.clientFactory ?? defaultConnectorInstanceMcpClientFactory;
  try {
    return await attemptConnectAndListTools(factory, input);
  } catch (err) {
    if (err instanceof InvokerError && err.code === "session_not_found") {
      return await attemptConnectAndListTools(factory, input);
    }
    throw err;
  }
}
