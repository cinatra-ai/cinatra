import "server-only";

/**
 * Real network implementation of {@see MarketplaceMcpClient}. Server-only — it
 * speaks the MCP protocol (wordpress/mcp-adapter, StreamableHTTP) against the
 * marketplace's single MCP endpoint `/wp-json/cinatra/mcp`, mirroring the
 * deterministic-MCP-call pattern in `src/lib/drupal-mcp-client.ts`.
 *
 * The published browse/detail catalog is the exception: exported public REST
 * helpers below read `/wp-json/cinatra/v1/extensions` anonymously and never
 * attach a bearer.
 *
 * Tool names are the WP ability ids with the `cinatra/<kebab>` namespace
 * separator flattened to a dash — `cinatra-<kebab>` — because MCP tool names
 * cannot contain `/` and the wordpress/mcp-adapter's McpNameSanitizer rewrites
 * `/` to `-` when it exposes each ability over the wire (see cinatra-mcp-harness
 * AbilityNameMap). The dash form is confirmed against the live adapter's
 * tools/list (all marketplace tools use `cinatra-<kebab>`); if the adapter ever
 * changes its tool-naming scheme, {@see mcpToolName} is the single place to adjust.
 */

import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { VersionNegotiationOptions } from "@modelcontextprotocol/client";

import {
  MARKETPLACE_CONNECT_FAILURE,
  MarketplaceMcpError,
  type MarketplaceFailureOrigin,
  type MarketplaceMcpClient,
} from "./client";
import type {
  ExtensionKind,
  ExtensionVisibility,
  MarketplaceChangelogEntry,
  MarketplaceDetailBadge,
  MarketplaceExtensionDependency,
  MarketplaceRatingSummary,
  MarketplaceReview,
  MarketplaceVendorRef,
  MarketplaceExtensionGetInput,
  MarketplaceExtensionGetOutput,
  MarketplaceExtensionGetWire,
  MarketplaceExtensionInstallAuthorizeInput,
  MarketplaceExtensionInstallAuthorizeOutput,
  MarketplaceExtensionInstallGrantRefreshInput,
  MarketplaceExtensionInstallGrantRefreshOutput,
  MarketplaceExtensionListInput,
  MarketplaceExtensionListOutput,
  MarketplaceExtensionSubmissionApproveInput,
  MarketplaceExtensionSubmissionApproveOutput,
  MarketplaceExtensionSubmissionListAdminInput,
  MarketplaceExtensionSubmissionListAdminOutput,
  MarketplaceExtensionSubmissionListSelfOutput,
  MarketplaceExtensionSubmissionPromotionRetryInput,
  MarketplaceExtensionSubmissionPromotionRetryOutput,
  MarketplaceExtensionSubmissionRejectInput,
  MarketplaceExtensionSubmissionRejectOutput,
  MarketplaceExtensionSubmissionWithdrawInput,
  MarketplaceExtensionSubmissionWithdrawOutput,
  MarketplaceExtensionSubmitForReviewInput,
  MarketplaceExtensionSubmitForReviewOutput,
  MarketplaceInstanceAttachSelfInput,
  MarketplaceInstanceAttachSelfOutput,
  MarketplacePackageSyncFromRegistryInput,
  MarketplacePackageSyncFromRegistryOutput,
  MarketplaceVendorApplicationApplyInput,
  MarketplaceVendorApplicationApplyOutput,
  MarketplaceVendorApplicationApproveInput,
  MarketplaceVendorApplicationApproveOutput,
  MarketplaceVendorApplicationCancelInput,
  MarketplaceVendorApplicationCancelOutput,
  MarketplaceVendorApplicationCompleteRecoveryInput,
  MarketplaceVendorApplicationCompleteRecoveryOutput,
  MarketplaceVendorApplicationListAdminInput,
  MarketplaceVendorApplicationListAdminOutput,
  MarketplaceVendorApplicationRejectInput,
  MarketplaceVendorApplicationRejectOutput,
  MarketplaceVendorApplicationResetInput,
  MarketplaceVendorApplicationResetOutput,
  MarketplaceVendorApplicationStatusOutput,
  MarketplaceVendorApplyInput,
  MarketplaceVendorApplyOutput,
  MarketplaceVendorGetSelfOutput,
  MarketplaceVendorProfileVisibilitySetInput,
  MarketplaceVendorProfileVisibilitySetOutput,
  MarketplaceVendorRegisterSelfInput,
  MarketplaceVendorRegisterSelfOutput,
  MarketplaceVendorRegistryTokenRotateSelfOutput,
} from "./types";

/** The one + only marketplace. Hardcoded; not operator-configurable. */
export const MARKETPLACE_BASE_URL = "https://marketplace.cinatra.ai";

/** MCP endpoint path on the marketplace WP install (wordpress/mcp-adapter). */
const MCP_ROUTE = "/wp-json/cinatra/mcp";

/** Anonymous public catalog endpoint for published/listed extensions. */
const PUBLIC_EXTENSIONS_ROUTE = "/wp-json/cinatra/v1/extensions";

/**
 * Resolve the marketplace base URL. Production ALWAYS uses the hardcoded URL —
 * neither the `MARKETPLACE_BASE_URL` env var NOR a caller-supplied `override`
 * can redirect a production instance away from the single Cinatra Marketplace.
 * Outside production (local dev + CI/tests), an explicit override wins, then
 * the env var.
 */
export function resolveMarketplaceBaseUrl(override?: string): string {
  if (process.env.NODE_ENV !== "production") {
    const candidate = (override ?? process.env.MARKETPLACE_BASE_URL)?.trim();
    if (candidate) {
      return candidate.replace(/\/+$/, "");
    }
  }
  return MARKETPLACE_BASE_URL;
}

export interface HttpMarketplaceClientOptions {
  /**
   * Bearer/Basic credential for the instance's marketplace account. A raw
   * token is sent as `Bearer <token>`; a value already carrying a scheme
   * (`Basic ...` / `Bearer ...`) is passed through unchanged (WP Application
   * Passwords are Basic).
   */
  token?: string;
  /**
   * Override the base URL — honored ONLY outside production (dev/test pointing
   * at a local stack). In production this is ignored and the hardcoded
   * marketplace URL is always used.
   */
  baseUrl?: string;
}

export interface PublicMarketplaceCatalogOptions {
  /**
   * Override the base URL — honored ONLY outside production, matching the MCP
   * client. Production always uses the single hardcoded marketplace.
   */
  baseUrl?: string;
}

/**
 * Build the MCP tool name from a snake_case ability key (== WP ability id).
 * MCP tool names cannot contain `/`, so the wordpress/mcp-adapter exposes the
 * `cinatra/<kebab>` abilities with the namespace separator flattened to a dash.
 * The wire name is therefore `cinatra-<kebab>`, not `cinatra/<kebab>`.
 */
function mcpToolName(abilityKey: string): string {
  return `cinatra-${abilityKey.replace(/_/g, "-")}`;
}

function authHeaders(token?: string): Record<string, string> {
  if (!token) {
    return {};
  }
  const value = /^(Bearer|Basic)\s/i.test(token) ? token : `Bearer ${token}`;
  return { Authorization: value };
}

/**
 * Fetch one anonymous public catalog page. This is intentionally REST, not MCP:
 * published extension browse must work without a bearer and without MCP session
 * creation. The response shape is the same as `extension_list`.
 */
export async function fetchPublicMarketplaceExtensionList(
  input: MarketplaceExtensionListInput = {},
  opts: PublicMarketplaceCatalogOptions = {},
): Promise<MarketplaceExtensionListOutput> {
  const baseUrl = resolveMarketplaceBaseUrl(opts.baseUrl);
  const url = new URL(baseUrl + PUBLIC_EXTENSIONS_ROUTE);
  for (const key of ["kind", "query", "limit", "offset"] as const) {
    const value = input[key];
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new MarketplaceMcpError(
      `Marketplace public extension catalog returned HTTP ${response.status}`,
      response.status,
      body.slice(0, 500),
    );
  }

  try {
    return JSON.parse(body) as MarketplaceExtensionListOutput;
  } catch {
    throw new MarketplaceMcpError(
      "Marketplace public extension catalog: response was not JSON",
      502,
      body.slice(0, 500),
    );
  }
}

/**
 * Fetch one anonymous public extension detail. This is intentionally REST, not
 * MCP: reading a published/listed extension's detail preflight must work
 * without a bearer and without MCP session creation. Unknown/private/unlisted
 * packages are surfaced as MarketplaceMcpError.httpStatus === 404 so callers
 * can render notFound() without falling back to authenticated MCP.
 */
export async function fetchPublicMarketplaceExtensionDetail(
  input: MarketplaceExtensionGetInput,
  opts: PublicMarketplaceCatalogOptions = {},
): Promise<MarketplaceExtensionGetOutput> {
  const packageName = input.packageName.trim();
  const parts = /^@([^/]+)\/([^/]+)$/.exec(packageName);
  if (!parts) {
    throw new MarketplaceMcpError(
      "Marketplace public extension detail: packageName must be a scoped npm-style name.",
      400,
      "",
    );
  }

  const [, scope, name] = parts;
  const baseUrl = resolveMarketplaceBaseUrl(opts.baseUrl);
  const url = new URL(
    `${baseUrl}${PUBLIC_EXTENSIONS_ROUTE}/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`,
  );

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new MarketplaceMcpError(
      `Marketplace public extension detail returned HTTP ${response.status}`,
      response.status,
      body.slice(0, 500),
    );
  }

  let wire: MarketplaceExtensionGetWire & Partial<MarketplaceExtensionGetOutput>;
  try {
    wire = JSON.parse(body) as MarketplaceExtensionGetWire & Partial<MarketplaceExtensionGetOutput>;
  } catch {
    throw new MarketplaceMcpError(
      "Marketplace public extension detail: response was not JSON",
      502,
      body.slice(0, 500),
    );
  }

  return mapExtensionGetWire({
    ...wire,
    package_name: wire.package_name ?? wire.packageName ?? packageName,
  });
}

// ---------------------------------------------------------------------------
// Protocol-revision negotiation — EXPLICIT auto, not defaulted legacy.
//
// The peer on this surface is the LIVE hosted marketplace: the
// wordpress/mcp-adapter at `https://marketplace.cinatra.ai/wp-json/cinatra/mcp`
// (serverInfo `Cinatra Marketplace`). It was PROBED on the wire, anonymously,
// and it does NOT implement `2026-07-28` today:
//
//   POST server/discover (2026-07-28 `_meta` envelope)
//     -> HTTP 400 {"error":{"code":-32600,
//                  "message":"Invalid Request: Missing Mcp-Session-Id header"}}
//   POST initialize (offering 2025-11-25)
//     -> HTTP 200, the server SELECTS "2025-06-18" and mints an Mcp-Session-Id
//
// Driven through this client, per connect-and-call cycle:
//
//   { mode: "auto" }   -> era "legacy", negotiated 2025-06-18, 3 frames
//                         (server/discover rejected 400, then initialize +
//                          notifications/initialized)
//   { mode: "legacy" } -> era "legacy", negotiated 2025-06-18, 2 frames
//
// So `auto` reaches the identical era today at the cost of one rejected round
// trip, and this client opens a fresh connection PER CALL, so that cost is per
// call. `auto` is still the right setting here, and the reason is the PEER, not
// the price:
//
//   * This peer is an independently-operated hosted service. It can gain
//     `2026-07-28` — or drop the 2025-era `initialize` — with no change in this
//     repo and no signal that would prompt one. Pinning `legacy` would leave the
//     whole marketplace surface (vendor lifecycle, submissions, gatekept
//     install) with no negotiation path and no diagnostic on the day that
//     happens, and nothing in cinatra would trigger the flip.
//   * That is exactly the condition the supported-revisions contract names for
//     `{ mode: 'auto' }`. The contract's explicit-`legacy` exception is scoped to
//     a peer that is *known* 2025-era AND PINNED — `packages/objects`' graphiti
//     client, whose peer is a digest-pinned image in `docker-compose.yml`, so
//     its posture cannot move without a visible pin bump. This peer is not
//     pinned, so that exception does not apply.
//   * `auto` degrades to one wasted round trip if the peer never moves;
//     `legacy` breaks outright if it does. The measured probe proves `auto`
//     interoperates with the peer as it is today.
//
// The peer's session id is peer-required and stays SDK-managed and
// transport-private: cinatra never reads, persists, routes, or authorizes on it
// (cinatra#2218 AC4).
//
// The mode is written out rather than left to the default because
// `versionNegotiation` is an OPTIONS OBJECT whose default mode is `legacy`:
// written as a bare string (`versionNegotiation: "auto"`) the client reads
// `options?.mode` as `undefined` and silently selects legacy, producing a
// working client whose era was never chosen. Typing this constant as
// `VersionNegotiationOptions` makes the bare string a compile error, and a test
// asserts the object reaches the `Client` constructor with `mode === "auto"`.
//
// `marketplace-wire-negotiation.manual.test.ts` is the re-runnable live probe
// behind every number above.
// ---------------------------------------------------------------------------
const MARKETPLACE_VERSION_NEGOTIATION: VersionNegotiationOptions = { mode: "auto" };

// ---------------------------------------------------------------------------
// Failure-origin classification (cinatra#2218 L2b).
//
// The offline-rename gate in `src/app/configuration/instance/actions.ts` must
// decide whether a failed marketplace probe is a genuine "this box cannot reach
// the marketplace" situation (safe to fail OPEN on a local instance with no
// reservation — cinatra#396) or anything else (fail CLOSED). That decision needs
// to know which errors this module can raise, which is THIS module's knowledge —
// so the classification lives here and the POLICY stays in the gate.
//
// It is an ALLOWLIST, and the allowed evidence is a BRAND rather than a class.
// Only a failure proven to have happened BEFORE any HTTP response was received —
// recorded at the moment the `fetch()` promise rejects, see
// `brandConnectFailures` — is reported `unreachable`; everything else is
// `peer-response` (a response demonstrably arrived) or `indeterminate` (cannot
// be shown either way). The gate may fail open on `unreachable` alone.
//
// The class cannot carry that fact. `TypeError` is undici's connect-failure
// contract, but it is ALSO what surfaces when a response arrives and its body
// stream then dies (`TypeError: terminated`) — measured, after a real HTTP 200
// with headers on the wire — so an `instanceof TypeError` rule would report a
// REACHABLE marketplace as unreachable and fail the gate OPEN.
//
// That inversion is deliberate and it TIGHTENS the gate. The pre-migration gate
// was a denylist — `err instanceof MarketplaceMcpError || StreamableHTTPError ||
// McpError` — so every error class it did not enumerate fell through to
// fail-OPEN. Three such classes were measured escaping a real connect/callTool
// cycle from a REACHABLE peer, and all three failed open before this change:
//
//   HTTP 200 with a malformed JSON body      -> SyntaxError
//   HTTP 403 + WWW-Authenticate
//     `error="insufficient_scope"`           -> InsufficientScopeError
//   an initialize result naming a revision
//     this client does not support           -> plain Error
//
// None of them is in either SDK error tree, in v1 or in v2. Under the allowlist
// all three are `indeterminate` and the gate fails CLOSED.
//
// Measured v1 -> v2 error-class map for this surface (both SDKs run against real
// peers; the v1 column is `@modelcontextprotocol/sdk@1.29.0`):
//
//   failure mode                       v1                     v2
//   ---------------------------------  ---------------------  ---------------------
//   peer unreachable (ECONNREFUSED,    TypeError              TypeError
//     DNS, TLS)                        "fetch failed"         "fetch failed"
//   response received, body stream     TypeError              TypeError
//     dies mid-read                    "terminated"           "terminated"
//   peer answers HTTP 4xx/5xx          StreamableHTTPError    SdkHttpError
//                                      (name "Error", .code   (name "SdkHttpError",
//                                       = status, message      .status = status,
//                                       prefixed "Streamable   message WITHOUT the
//                                       HTTP error: ")         prefix)
//   peer answers a JSON-RPC error      McpError               ProtocolError
//                                      (message prefixed      (.code = the JSON-RPC
//                                       "MCP error <code>: ")  code, message WITHOUT
//                                                              the prefix)
//   request timeout / connection       McpError(-32001/       SdkError(RequestTimeout
//     closed / not connected           -32000)                 / ConnectionClosed)
//
// The two message PREFIXES are gone in v2. That matters to one text-matching
// consumer — `isTerminalAuthFailure` in
// `src/app/configuration/environment/vendor-application-cm-errors.ts` read the
// JSON-RPC code out of v1's message text — which is migrated in the same change.
//
// One more measured v2 behaviour, load-bearing for the mode above: under
// `{ mode: "auto" }` an unreachable peer surfaces as
// `SdkError(EraNegotiationFailed)` rather than a bare `TypeError`, because the
// `server/discover` probe fails first and the negotiator wraps it. The original
// `TypeError` is preserved on `.data.cause`, so the pre-response fact survives —
// which is what lets this classifier stay correct under BOTH modes, and what
// keeps the negotiation mode and the security gate independent of each other.
// A probe answered with an HTTP status carries the SAME code on an `SdkHttpError`
// SUBCLASS, so the subclass is tested first.
// ---------------------------------------------------------------------------

/**
 * Wrap a `fetch` so that a rejection proving the MARKETPLACE was never reached
 * — and only such a rejection — is branded {@link MARKETPLACE_CONNECT_FAILURE}.
 *
 * Two conditions, both necessary:
 *
 *  1. The rejection is of the `fetch()` call ITSELF. Once the promise resolves a
 *     status and headers arrived, so a later body-stream failure (undici raises
 *     `TypeError: terminated`, measured against a real HTTP 200) is outside the
 *     `try` and stays unbranded. Local faults before the call — a malformed
 *     `Headers`, a bad URL — are outside it too.
 *
 *  2. NO response has been seen yet on this transport. The wrapper is created
 *     per `callMarketplaceTool` invocation, so the latch spans exactly one
 *     connect-call-close cycle, and that cycle issues several requests: the
 *     `{ mode: 'auto' }` `server/discover` probe, `initialize`, the initialized
 *     notification, the standalone `GET` stream, `tools/call`, the closing
 *     `DELETE`. If ANY of them came back, the marketplace demonstrably answered
 *     during this call — a later socket loss is then `"indeterminate"`, not
 *     evidence of an unreachable marketplace.
 *
 * Behaviour-neutral otherwise: it returns the identical `Response` without
 * touching its body and rethrows the identical rejection. Branding is
 * best-effort — a frozen or primitive rejection value cannot carry the mark and
 * therefore classifies `"indeterminate"`, which fails CLOSED.
 */
function brandConnectFailures(inner: typeof fetch): typeof fetch {
  let responseSeen = false;
  return async function brandedFetch(input, init) {
    try {
      const response = await inner(input, init);
      responseSeen = true;
      return response;
    } catch (err) {
      if (!responseSeen && err !== null && typeof err === "object") {
        try {
          Object.defineProperty(err, MARKETPLACE_CONNECT_FAILURE, {
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
  };
}

/**
 * True when `err` carries the connect-failure brand — directly, or through the
 * `{ mode: 'auto' }` negotiator's wrapper, which records the original error on
 * `.data.cause` when the `server/discover` probe fails before a response.
 *
 * The brand is the ONLY accepted evidence; no error class is treated as proof.
 */
function isPreResponseNetworkFailure(err: unknown, depth = 0): boolean {
  if (err === null || typeof err !== "object") {
    return false;
  }
  if ((err as Record<PropertyKey, unknown>)[MARKETPLACE_CONNECT_FAILURE] === true) {
    return true;
  }
  // An HTTP status was received — even when the negotiator labels it with the
  // same EraNegotiationFailed code as a network failure. Tested BEFORE the
  // SdkError branch below, because SdkHttpError is a subclass of it.
  if (err instanceof SdkHttpError) {
    return false;
  }
  if (
    depth < 4 &&
    err instanceof SdkError &&
    err.code === SdkErrorCode.EraNegotiationFailed
  ) {
    const cause = (err.data as { cause?: unknown } | undefined)?.cause;
    return isPreResponseNetworkFailure(cause, depth + 1);
  }
  return false;
}

/**
 * Classify why a call through {@link createHttpMarketplaceMcpClient} (or the
 * public REST helpers) failed, in terms of what it proves about the MARKETPLACE
 * rather than in terms of SDK classes.
 *
 * - `"unreachable"` — no HTTP response was ever received.
 * - `"peer-response"` — the marketplace answered: an HTTP status, a JSON-RPC
 *   error, or a structured ability error this module turned into a
 *   `MarketplaceMcpError`.
 * - `"indeterminate"` — anything else. NOT a synonym for unreachable: a
 *   timeout, a closed connection, a malformed body, and an auth-scope refusal
 *   all land here, and a caller that may only relax on a proven unreachable
 *   peer must treat this exactly like `"peer-response"`.
 *
 * Callers must switch on the outcome, never on `!== "unreachable"`-style
 * negation of a class list — the whole point is that unknown failures are not
 * silently treated as "the marketplace is down".
 */
export function classifyMarketplaceFailure(err: unknown): MarketplaceFailureOrigin {
  if (isPreResponseNetworkFailure(err)) {
    return "unreachable";
  }
  if (err instanceof MarketplaceMcpError || err instanceof SdkHttpError) {
    return "peer-response";
  }
  // A JSON-RPC error response is a response. `ProtocolError` is a SEPARATE class
  // tree from `SdkError` (it does not extend it), so it needs its own test; its
  // `instanceof` is brand-matched by the SDK, so this holds across separately
  // bundled copies of the package.
  if (err instanceof ProtocolError) {
    return "peer-response";
  }
  return "indeterminate";
}

/**
 * Connect, call one tool, parse the result, close. Prefers `structuredContent`
 * (clean JSON) and falls back to the first text content parsed as JSON — the
 * same envelope handling as the Drupal MCP client.
 */
async function callMarketplaceTool<TOutput>(
  abilityKey: string,
  args: Record<string, unknown>,
  opts: HttpMarketplaceClientOptions,
  /**
   * Extra HTTP statuses (beyond the default 404 not-found signal) that this
   * tool wants PRESERVED on the thrown `MarketplaceMcpError.httpStatus` when the
   * ability returns a structured error. Without this, every non-404 tool error
   * collapses to 502 — which is correct for the catalog/detail surfaces but
   * loses the refusal class (409 closure_changed / 429 rate_limited / 403
   * op_deadline / 503 internal) the gatekept grant-refresh seam must distinguish
   * to abort-and-compensate auditably. Per-method (NOT a shared widen), so the
   * conservative 502 default — and the `extensionGet` 403→502 regression guard —
   * is untouched.
   */
  preserveErrorStatuses: readonly number[] = [],
): Promise<TOutput> {
  const baseUrl = resolveMarketplaceBaseUrl(opts.baseUrl);
  const endpoint = new URL(baseUrl + MCP_ROUTE);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    // Behaviour-neutral wrapper around the platform fetch: it only marks a
    // rejection of the call itself, so `classifyMarketplaceFailure()` can tell a
    // connect failure from a response that arrived and then went wrong.
    fetch: brandConnectFailures(fetch),
    requestInit: { headers: authHeaders(opts.token) },
  });
  const client = new Client(
    { name: "cinatra-marketplace-client", version: "1.0.0" },
    { versionNegotiation: MARKETPLACE_VERSION_NEGOTIATION },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: mcpToolName(abilityKey), arguments: args });

    if ((result as { isError?: boolean }).isError) {
      // Preserve a genuine not-found signal as httpStatus 404 (the detail page
      // relies on MarketplaceMcpError.httpStatus === 404 to call notFound() for
      // an unlisted/private/missing package). Beyond 404, a method MAY opt-in
      // (via `preserveErrorStatuses`) to keep specific structured statuses; every
      // other tool error stays 502. Conservative: only a structured status /
      // explicit not-found marker is honored — ambiguous errors are NOT mapped.
      const detail = extractText(result) ?? "";
      const allowed = new Set([404, ...preserveErrorStatuses]);
      const structuredStatus = extractStructuredStatus(result);
      const httpStatus =
        structuredStatus != null && allowed.has(structuredStatus)
          ? structuredStatus
          : isNotFoundError(result)
            ? 404
            : 502;
      throw new MarketplaceMcpError(
        `Marketplace ${abilityKey} returned an error: ${detail || "unknown"}`,
        httpStatus,
        detail,
      );
    }

    const structured = (result as { structuredContent?: unknown }).structuredContent;
    if (structured && typeof structured === "object") {
      return structured as TOutput;
    }

    const text = extractText(result);
    if (text != null) {
      try {
        return JSON.parse(text) as TOutput;
      } catch {
        throw new MarketplaceMcpError(
          `Marketplace ${abilityKey}: response was not JSON`,
          502,
          text.slice(0, 500),
        );
      }
    }
    throw new MarketplaceMcpError(`Marketplace ${abilityKey}: empty response`, 502, "");
  } finally {
    await client.close().catch(() => {});
  }
}

function extractText(result: unknown): string | null {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  if (!Array.isArray(content)) {
    return null;
  }
  const textItem = content.find((c) => c.type === "text");
  return textItem && typeof textItem.text === "string" ? textItem.text : null;
}

/**
 * Conservatively detect a genuine not-found signal in an `isError` MCP result.
 *
 * The wordpress/mcp-adapter surfaces an ability failure as `isError: true` with
 * the error payload in `structuredContent` and/or a text content block. The
 * detail page treats a missing/unlisted/private marketplace package as a 404
 * (→ notFound()); to keep that behavior across the MCP transport, we map ONLY a
 * genuine not-found marker to httpStatus 404 here. Everything else keeps the
 * existing 502 so transport/denial/validation errors are not silently masked as
 * "package does not exist".
 *
 * Recognized signals (any one is sufficient):
 *  - a structured numeric status/http_status/statusCode/code === 404,
 *  - a structured/error code string matching the not-found convention
 *    (`E404`, `not_found`, `rest_not_found`, `rest_post_invalid_id`, …),
 *  - a not-found phrase in the JSON-parsed structured `code`/`error_code`/`error`.
 *
 * The plain text block is parsed as JSON when possible; we do NOT do a loose
 * substring scan of free-form prose (too easy to false-positive on e.g. "could
 * not find a valid token"). The match is anchored to structured error metadata.
 */
function isNotFoundError(result: unknown): boolean {
  // 1) Structured error metadata on the result envelope itself.
  if (matchesNotFoundShape((result as { structuredContent?: unknown }).structuredContent)) {
    return true;
  }
  // 2) Some adapters place status fields directly on the result.
  if (matchesNotFoundShape(result)) {
    return true;
  }
  // 3) Text content — only when it parses as a JSON object carrying structured
  //    error metadata. Non-JSON / prose text is intentionally NOT scanned.
  const text = extractText(result);
  if (text != null) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (matchesNotFoundShape(parsed)) {
        return true;
      }
    } catch {
      // Not JSON — fall through; no loose prose scan.
    }
  }
  return false;
}

/** Numeric-404 or not-found-code match over a candidate object's error fields. */
function matchesNotFoundShape(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  const obj = candidate as Record<string, unknown>;

  // Numeric status fields equal to 404.
  for (const key of ["status", "statusCode", "httpStatus", "http_status", "code"]) {
    const value = obj[key];
    if (typeof value === "number" && value === 404) {
      return true;
    }
  }

  // String code fields matching the not-found convention.
  const NOT_FOUND_CODES = new Set([
    "e404",
    "not_found",
    "notfound",
    "rest_not_found",
    "rest_no_route",
    "rest_post_invalid_id",
    "extension_not_found",
    "package_not_found",
  ]);
  for (const key of ["code", "error_code", "errorCode"]) {
    const value = obj[key];
    if (typeof value === "string" && NOT_FOUND_CODES.has(value.trim().toLowerCase())) {
      return true;
    }
  }

  // Some payloads nest the WP error under `data` / `error`.
  if (matchesNotFoundShape(obj.data)) {
    return true;
  }
  if (matchesNotFoundShape(obj.error)) {
    return true;
  }

  return false;
}

/**
 * Extract a numeric HTTP status from an `isError` MCP result's STRUCTURED error
 * metadata — the same conservative traversal as {@link isNotFoundError} (the
 * result envelope, its `structuredContent`, and a JSON-parsed text block; the
 * WP `data`/`error` nestings), but returning the status value rather than a
 * boolean. Used to PRESERVE a method's opted-in refusal statuses (e.g. the
 * grant-refresh seam's 409/429/403/503). Prose text is intentionally NOT
 * scanned — only structured `status`/`http_status`/`statusCode` fields count
 * (WP_Error places the HTTP status under `data.status`).
 */
function extractStructuredStatus(result: unknown): number | null {
  const direct =
    structuredStatusOf((result as { structuredContent?: unknown }).structuredContent) ??
    structuredStatusOf(result);
  if (direct != null) {
    return direct;
  }
  const text = extractText(result);
  if (text != null) {
    try {
      return structuredStatusOf(JSON.parse(text) as unknown);
    } catch {
      // Not JSON — no prose scan.
    }
  }
  return null;
}

/** First numeric `status`/`statusCode`/`http_status` over a candidate + its `data`/`error` nestings. */
function structuredStatusOf(candidate: unknown): number | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const obj = candidate as Record<string, unknown>;
  for (const key of ["status", "statusCode", "httpStatus", "http_status"]) {
    const value = obj[key];
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
  }
  return structuredStatusOf(obj.data) ?? structuredStatusOf(obj.error);
}

/**
 * Map the snake_case `extension_get` ability wire output to the camelCase
 * {@link MarketplaceExtensionGetOutput} the cinatra-side consumers read (the
 * detail page reads `kind` / `latestVersion` / `currentVisibility`; gatekept-
 * install reads `latestVersion`).
 *
 * The `extension_get` ability returns 200 (NOT a 404 throw) for a missing /
 * unlisted package, with `current_visibility: "unknown"` and null kind/version.
 * We preserve that here so the page can treat any non-"public" visibility as
 * not-found, rather than relying on a 404 that the ability never raises.
 *
 * Tolerant of an already-camelCase payload (the mock client + tests supply the
 * typed `ExtensionDetail` shape directly): each field falls back to the camel
 * key when the snake key is absent, so a typed fixture round-trips unchanged.
 */
function mapExtensionGetWire(
  wire: MarketplaceExtensionGetWire & Partial<MarketplaceExtensionGetOutput>,
): MarketplaceExtensionGetOutput {
  const visibilityRaw = wire.current_visibility ?? wire.currentVisibility ?? "unknown";
  const currentVisibility: ExtensionVisibility =
    visibilityRaw === "public" || visibilityRaw === "private" ? visibilityRaw : "unknown";

  const versionHistory = (wire.version_history ?? wire.versionHistory ?? []).map((entry) => ({
    version: entry.version,
    releasedAt:
      (entry as { released_at?: string; releasedAt?: string }).released_at ??
      (entry as { releasedAt?: string }).releasedAt ??
      "",
    state: entry.state,
  }));

  return {
    packageName: wire.package_name ?? wire.packageName ?? "",
    name: wire.name ?? "",
    description: wire.description ?? null,
    // `kind` is single-word — identical in snake/camel; null (unlisted) coalesces
    // to "agent" only at the page (legacy "no kind" default), never here.
    kind: (wire.kind ?? "agent") as MarketplaceExtensionGetOutput["kind"],
    category: (wire.category ?? "agent") as MarketplaceExtensionGetOutput["category"],
    latestVersion: wire.latest_version ?? wire.latestVersion ?? null,
    vendorSlug: wire.vendor_slug ?? wire.vendorSlug ?? "",
    iconAssetUrl: wire.icon_asset_url ?? wire.iconAssetUrl ?? null,
    publicationState: (wire.publication_state ??
      wire.publicationState ??
      "draft") as MarketplaceExtensionGetOutput["publicationState"],
    currentVisibility,
    longDescription: wire.long_description ?? wire.longDescription ?? null,
    readmeMarkdown: wire.readme_markdown ?? wire.readmeMarkdown ?? null,
    marketplaceAssets: wire.marketplace_assets ?? wire.marketplaceAssets ?? [],
    license: wire.license ?? null,
    versionHistory,
    sdkAbiRange: wire.sdk_abi_range ?? wire.sdkAbiRange ?? null,
    bannerUrl: wire.banner_url ?? wire.bannerUrl ?? null,
    // In-app extension-detail modal contract. Every field defaults safely so an
    // older payload (which omits them) still maps to a valid ExtensionDetail.
    displayName: normDetailString(wire.display_name) ?? normDetailString(wire.name),
    kindLabel: normDetailString(wire.kind_label),
    commerceBadge: mapDetailBadge(wire.badge),
    freshnessAt: normDetailString(wire.freshness_at),
    installCount: normDetailCount(wire.install_count),
    permalink: normDetailString(wire.permalink),
    iconUrl: safeDetailHttpUrl(wire.icon_url?.url),
    compatibleUpTo:
      normDetailString(wire.compatible_up_to) ?? normDetailString(wire.compatibleUpTo),
    ratingSummary: mapDetailRatingSummary(wire.rating_summary),
    reviews: mapDetailReviews(wire.reviews),
    vendor: mapDetailVendor(wire.vendor),
    changelog: mapDetailChangelog(wire.changelog),
    dependencies: mapDetailDependencies(wire.dependencies),
  };
}

// --- In-app detail-modal wire normalizers (pure, defensive) ------------------
// The public REST detail is our own endpoint, but the mapper stays defensive so
// a malformed/partial payload degrades to safe defaults rather than crashing the
// modal. NONE of these ever surface a field the contract redacts.

function normDetailString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function normDetailCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

function safeDetailHttpUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  try {
    const protocol = new URL(v).protocol;
    return protocol === "http:" || protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

function mapDetailBadge(b: MarketplaceExtensionGetWire["badge"]): MarketplaceDetailBadge | null {
  if (!b || typeof b !== "object") return null;
  const text = normDetailString(b.text);
  if (text === null) return null;
  return { text, variant: normDetailString(b.variant) ?? "", license: normDetailString(b.license) };
}

function mapDetailRatingSummary(
  s: MarketplaceExtensionGetWire["rating_summary"],
): MarketplaceRatingSummary | null {
  if (!s || typeof s !== "object") return null;
  const rawCounts = s.counts && typeof s.counts === "object" ? s.counts : {};
  const counts = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } as MarketplaceRatingSummary["counts"];
  for (const star of ["1", "2", "3", "4", "5"] as const) {
    const n = (rawCounts as Record<string, number>)[star];
    counts[star] = typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }
  const averageRaw =
    typeof s.average === "number" && Number.isFinite(s.average) && s.average >= 0 ? s.average : 0;
  // Cap to the 0..5 star scale so a malformed payload can never paint a garbage
  // average (the star row clamps too, but the numeric label reads this directly).
  const average = Math.min(5, averageRaw);
  const total = typeof s.total === "number" && Number.isFinite(s.total) && s.total >= 0 ? Math.floor(s.total) : 0;
  return { average, total, counts };
}

function mapDetailReviews(list: MarketplaceExtensionGetWire["reviews"]): MarketplaceReview[] {
  if (!Array.isArray(list)) return [];
  const out: MarketplaceReview[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const rating =
      typeof r.rating === "number" && Number.isFinite(r.rating)
        ? Math.min(5, Math.max(0, Math.floor(r.rating)))
        : 0;
    if (rating < 1 || rating > 5) continue;
    out.push({
      author: normDetailString(r.author) ?? "Anonymous",
      verifiedOwner: r.verified_owner === true,
      date: normDetailString(r.date),
      rating,
      text: typeof r.text === "string" ? r.text : "",
    });
  }
  return out;
}

function mapDetailVendor(v: MarketplaceExtensionGetWire["vendor"]): MarketplaceVendorRef | null {
  if (!v || typeof v !== "object") return null;
  const name = normDetailString(v.name) ?? "";
  const slug = normDetailString(v.slug) ?? "";
  const storeUrl = safeDetailHttpUrl(v.store_url);
  if (name === "" && slug === "" && storeUrl === null) return null;
  return { name, slug, storeUrl };
}

const DETAIL_DEPENDENCY_KINDS = new Set<ExtensionKind>([
  "agent",
  "skill",
  "connector",
  "artifact",
  "workflow",
]);

/**
 * Normalize the wire `changelog` (marketplace#190 workstream C). A raw
 * CHANGELOG string passes through verbatim (the app-side view projection owns
 * the parse); an entry array is normalized entry-by-entry (version required —
 * versionless rows are dropped; `notes` accepts string[] or a single string).
 */
function mapDetailChangelog(
  raw: MarketplaceExtensionGetWire["changelog"],
): MarketplaceChangelogEntry[] | string | null {
  if (typeof raw === "string") {
    return raw.trim() === "" ? null : raw;
  }
  if (!Array.isArray(raw)) return null;
  const out: MarketplaceChangelogEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const version = normDetailString(e.version);
    if (version === null) continue;
    const date = normDetailString(e.date) ?? normDetailString(e.released_at);
    const notesRaw = (e as { notes?: unknown }).notes;
    const notes = (
      Array.isArray(notesRaw) ? notesRaw : typeof notesRaw === "string" ? [notesRaw] : []
    ).filter((n): n is string => typeof n === "string" && n.trim() !== "");
    out.push({ version: version.trim(), date, notes });
  }
  return out;
}

/**
 * Normalize the wire `dependencies` — the manifest `cinatra.dependencies`
 * (marketplace#190 workstream C), NEVER npm deps. Accepts the enriched entry
 * array or the raw manifest name→range map (map entries carry no kind/display
 * name; the modal degrades to the generic emblem + package name).
 */
function mapDetailDependencies(
  raw: MarketplaceExtensionGetWire["dependencies"],
): MarketplaceExtensionDependency[] | null {
  if (!raw || typeof raw !== "object") return null;
  const out: MarketplaceExtensionDependency[] = [];
  if (Array.isArray(raw)) {
    for (const d of raw) {
      if (!d || typeof d !== "object") continue;
      const packageName = normDetailString(d.package_name) ?? normDetailString(d.packageName);
      if (packageName === null) continue;
      const kindRaw = normDetailString(d.kind);
      out.push({
        packageName: packageName.trim(),
        name:
          normDetailString(d.display_name) ?? normDetailString(d.name) ?? packageName.trim(),
        kind: DETAIL_DEPENDENCY_KINDS.has(kindRaw as ExtensionKind)
          ? (kindRaw as ExtensionKind)
          : null,
        versionRange:
          normDetailString(d.version_range) ??
          normDetailString(d.versionRange) ??
          normDependencyConstraint(d.version_constraint ?? d.versionConstraint) ??
          "",
      });
    }
    return out;
  }
  for (const [packageName, range] of Object.entries(raw)) {
    if (packageName.trim() === "") continue;
    out.push({
      packageName: packageName.trim(),
      name: packageName.trim(),
      kind: null,
      versionRange: typeof range === "string" ? range.trim() : "",
    });
  }
  return out;
}

/**
 * The canonical sdk-extensions dependency edge carries a discriminated
 * `versionConstraint` OBJECT ({range} | {version} | {ref}); a plain string
 * passes through. Anything else → null.
 */
function normDependencyConstraint(v: unknown): string | null {
  if (typeof v === "string") return normDetailString(v);
  if (v && typeof v === "object") {
    const c = v as { range?: unknown; version?: unknown; ref?: unknown };
    return normDetailString(c.range) ?? normDetailString(c.version) ?? normDetailString(c.ref);
  }
  return null;
}

/** Methods whose backing marketplace ability does not exist yet. */
function notServed(method: string): never {
  throw new MarketplaceMcpError(
    `Marketplace MCP method "${method}" has no backing ability yet (tracked for the extension catalog/submission phases). Use vendorGetSelf for self status.`,
    501,
    "",
  );
}

/**
 * Refusal-class HTTP statuses PRESERVED on `MarketplaceMcpError.httpStatus` for
 * the moderation DECISION methods (extension-submission + vendor-application
 * approve/reject). Without this opt-in every non-404 decision error collapses to
 * a generic 502, so a DETERMINISTIC refusal — most importantly a 409
 * `cinatra.approver_separation_violation` separation-of-duties rejection (the
 * submitter / submission-vendor owner / namespace owner may NOT approve their
 * own request) — is indistinguishable from a transient transport failure. The
 * decide abilities return a `WP_Error(code, message, ['status' => N])` whose
 * shape is identical to the grant-refresh refusal seam and travels the same MCP
 * envelope path, so the same conservative structured-status preservation applies
 * verbatim. Preserving the status lets the caller (the non-redirecting decision
 * helpers, then the unified approvals inbox) render a readable SoD explanation
 * (409) / not-authorized (403) / gone (404) and retry only the genuinely
 * transient classes (429 rate-limited, 503 internal). The marketplace's
 * machine-readable error code + message ride in
 * `MarketplaceMcpError.responseBody` / `.message` — the same seam the
 * grant-refresh gatekept path and the vendor-application cm-error classifier
 * already read. Per-method (NOT a shared widen of `callMarketplaceTool`), so the
 * conservative 502 default and the `extensionGet` 403→502 regression guard are
 * untouched.
 */
const DECISION_REFUSAL_STATUSES = [403, 404, 409, 429, 503] as const;

export function createHttpMarketplaceMcpClient(
  opts: HttpMarketplaceClientOptions = {},
): MarketplaceMcpClient {
  return {
    // Extension detail. Tool `cinatra-extension-get`. The ability wire
    // shape is snake_case (current_visibility / latest_version / …) and returns
    // 200 with current_visibility:"unknown" for a missing/unlisted package — it
    // does NOT throw 404. We map the wire to the camelCase ExtensionDetail the
    // page + gatekept-install consume (consistent with how those callers read it).
    extensionGet: async (input: MarketplaceExtensionGetInput) => {
      const wire = await callMarketplaceTool<
        MarketplaceExtensionGetWire & Partial<MarketplaceExtensionGetOutput>
      >("extension_get", input as unknown as Record<string, unknown>, opts);
      return mapExtensionGetWire(wire);
    },

    // No backing ability yet — see notServed(). `async` so the rejection is a
    // Promise (matches the interface) rather than a synchronous throw.
    vendorGet: async () => notServed("vendorGet"),

    // Authenticated MCP extension-list ability. App-side browse uses
    // fetchPublicMarketplaceExtensionList() instead so no bearer is sent.
    extensionList: (input: MarketplaceExtensionListInput = {}) =>
      callMarketplaceTool<MarketplaceExtensionListOutput>(
        "extension_list",
        input as unknown as Record<string, unknown>,
        opts,
      ),

    // Marketplace-gatekept install authorize. Tool
    // `cinatra-extension-install-authorize`. The returned `grant` is an opaque
    // bearer — never parsed here, only forwarded to the broker read-proxy.
    extensionInstallAuthorize: (input: MarketplaceExtensionInstallAuthorizeInput) =>
      callMarketplaceTool<MarketplaceExtensionInstallAuthorizeOutput>(
        "extension_install_authorize",
        input as unknown as Record<string, unknown>,
        opts,
      ),

    // Marketplace-gatekept install grant REFRESH. Tool
    // `cinatra-extension-install-grant-refresh`. Returns a re-minted opaque
    // grant. The refusal classes are PRESERVED on `MarketplaceMcpError.httpStatus`
    // (409 closure_changed / 429 rate_limited / 403 op_deadline / 503 internal)
    // so gatekept-install can distinguish a REFUSAL (auditable) from transport
    // UNAVAILABILITY — both abort+compensate the batch.
    extensionInstallGrantRefresh: (input: MarketplaceExtensionInstallGrantRefreshInput) =>
      callMarketplaceTool<MarketplaceExtensionInstallGrantRefreshOutput>(
        "extension_install_grant_refresh",
        input as unknown as Record<string, unknown>,
        opts,
        [403, 404, 409, 429, 503],
      ),

    vendorApply: (input: MarketplaceVendorApplyInput) =>
      callMarketplaceTool<MarketplaceVendorApplyOutput>("vendor_apply", input as unknown as Record<string, unknown>, opts),
    packageSyncFromRegistry: (input: MarketplacePackageSyncFromRegistryInput) =>
      callMarketplaceTool<MarketplacePackageSyncFromRegistryOutput>(
        "registry_sync_package",
        input as unknown as Record<string, unknown>,
        opts,
      ),

    vendorRegisterSelf: (input: MarketplaceVendorRegisterSelfInput) =>
      callMarketplaceTool<MarketplaceVendorRegisterSelfOutput>(
        "vendor_register_self",
        input as unknown as Record<string, unknown>,
        opts,
      ),
    vendorGetSelf: () =>
      callMarketplaceTool<MarketplaceVendorGetSelfOutput>("vendor_get_self", {}, opts),
    vendorProfileVisibilitySet: (input: MarketplaceVendorProfileVisibilitySetInput) =>
      callMarketplaceTool<MarketplaceVendorProfileVisibilitySetOutput>(
        "vendor_profile_visibility_set",
        input as unknown as Record<string, unknown>,
        opts,
      ),
    vendorRegistryTokenRotateSelf: () =>
      callMarketplaceTool<MarketplaceVendorRegistryTokenRotateSelfOutput>(
        "vendor_registry_token_rotate_self",
        {},
        opts,
      ),

    extensionSubmitForReview: (input: MarketplaceExtensionSubmitForReviewInput) =>
      callMarketplaceTool<MarketplaceExtensionSubmitForReviewOutput>(
        "extension_submit_for_review",
        input as unknown as Record<string, unknown>,
        opts,
      ),
    extensionSubmissionListSelf: () =>
      callMarketplaceTool<MarketplaceExtensionSubmissionListSelfOutput>(
        "extension_submission_list_self",
        {},
        opts,
      ),
    extensionSubmissionListAdmin: (input: MarketplaceExtensionSubmissionListAdminInput = {}) =>
      callMarketplaceTool<MarketplaceExtensionSubmissionListAdminOutput>(
        "extension_submission_list_admin",
        input as unknown as Record<string, unknown>,
        opts,
      ),
    extensionSubmissionWithdraw: (input: MarketplaceExtensionSubmissionWithdrawInput) =>
      callMarketplaceTool<MarketplaceExtensionSubmissionWithdrawOutput>(
        "extension_submission_withdraw",
        input as unknown as Record<string, unknown>,
        opts,
      ),
    extensionSubmissionApprove: (input: MarketplaceExtensionSubmissionApproveInput) =>
      callMarketplaceTool<MarketplaceExtensionSubmissionApproveOutput>(
        "extension_submission_approve",
        input as unknown as Record<string, unknown>,
        opts,
        DECISION_REFUSAL_STATUSES,
      ),
    extensionSubmissionReject: (input: MarketplaceExtensionSubmissionRejectInput) =>
      callMarketplaceTool<MarketplaceExtensionSubmissionRejectOutput>(
        "extension_submission_reject",
        input as unknown as Record<string, unknown>,
        opts,
        DECISION_REFUSAL_STATUSES,
      ),
    extensionSubmissionPromotionRetry: (input: MarketplaceExtensionSubmissionPromotionRetryInput) =>
      callMarketplaceTool<MarketplaceExtensionSubmissionPromotionRetryOutput>(
        "extension_submission_promotion_retry",
        input as unknown as Record<string, unknown>,
        opts,
      ),

    // Instance-attach — PRINCIPAL_PUBLIC; the marketplace mints the
    // consumer-tier WP user + Verdaccio htpasswd entry + Application Password.
    instanceAttachSelf: (input: MarketplaceInstanceAttachSelfInput) =>
      callMarketplaceTool<MarketplaceInstanceAttachSelfOutput>(
        "instance_attach_self",
        input as unknown as Record<string, unknown>,
        opts,
      ),

    // Vendor application lifecycle.
    vendorApplicationApply: (input: MarketplaceVendorApplicationApplyInput) =>
      callMarketplaceTool<MarketplaceVendorApplicationApplyOutput>(
        "vendor_application_apply",
        input as unknown as Record<string, unknown>,
        opts,
      ),
    vendorApplicationStatus: () =>
      callMarketplaceTool<MarketplaceVendorApplicationStatusOutput>(
        "vendor_application_status",
        {},
        opts,
      ),
    vendorApplicationCancel: (input: MarketplaceVendorApplicationCancelInput) =>
      callMarketplaceTool<MarketplaceVendorApplicationCancelOutput>(
        "vendor_application_cancel",
        input as unknown as Record<string, unknown>,
        opts,
      ),
    vendorApplicationReset: (input: MarketplaceVendorApplicationResetInput) =>
      callMarketplaceTool<MarketplaceVendorApplicationResetOutput>(
        "vendor_application_reset",
        input as unknown as Record<string, unknown>,
        opts,
      ),
    vendorApplicationListAdmin: (input: MarketplaceVendorApplicationListAdminInput = {}) =>
      callMarketplaceTool<MarketplaceVendorApplicationListAdminOutput>(
        "vendor_application_list_admin",
        input as unknown as Record<string, unknown>,
        opts,
      ),
    vendorApplicationApprove: (input: MarketplaceVendorApplicationApproveInput) =>
      callMarketplaceTool<MarketplaceVendorApplicationApproveOutput>(
        "vendor_application_approve",
        input as unknown as Record<string, unknown>,
        opts,
        DECISION_REFUSAL_STATUSES,
      ),
    vendorApplicationReject: (input: MarketplaceVendorApplicationRejectInput) =>
      callMarketplaceTool<MarketplaceVendorApplicationRejectOutput>(
        "vendor_application_reject",
        input as unknown as Record<string, unknown>,
        opts,
        DECISION_REFUSAL_STATUSES,
      ),
    vendorApplicationCompleteRecovery: (input: MarketplaceVendorApplicationCompleteRecoveryInput) =>
      callMarketplaceTool<MarketplaceVendorApplicationCompleteRecoveryOutput>(
        "vendor_application_complete_recovery",
        input as unknown as Record<string, unknown>,
        opts,
      ),
  };
}
