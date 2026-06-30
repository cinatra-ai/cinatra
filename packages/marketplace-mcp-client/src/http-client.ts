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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { MarketplaceMcpError, type MarketplaceMcpClient } from "./client";
import type {
  ExtensionVisibility,
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
    requestInit: { headers: authHeaders(opts.token) },
  });
  const client = new Client({ name: "cinatra-marketplace-client", version: "1.0.0" });
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
  };
}

/** Methods whose backing marketplace ability does not exist yet. */
function notServed(method: string): never {
  throw new MarketplaceMcpError(
    `Marketplace MCP method "${method}" has no backing ability yet (tracked for the extension catalog/submission phases). Use vendorGetSelf for self status.`,
    501,
    "",
  );
}

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
      ),
    extensionSubmissionReject: (input: MarketplaceExtensionSubmissionRejectInput) =>
      callMarketplaceTool<MarketplaceExtensionSubmissionRejectOutput>(
        "extension_submission_reject",
        input as unknown as Record<string, unknown>,
        opts,
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
      ),
    vendorApplicationReject: (input: MarketplaceVendorApplicationRejectInput) =>
      callMarketplaceTool<MarketplaceVendorApplicationRejectOutput>(
        "vendor_application_reject",
        input as unknown as Record<string, unknown>,
        opts,
      ),
    vendorApplicationCompleteRecovery: (input: MarketplaceVendorApplicationCompleteRecoveryInput) =>
      callMarketplaceTool<MarketplaceVendorApplicationCompleteRecoveryOutput>(
        "vendor_application_complete_recovery",
        input as unknown as Record<string, unknown>,
        opts,
      ),
  };
}
