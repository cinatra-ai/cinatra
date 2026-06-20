import "server-only";
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";

import type { GeneratedWidgetStreamAuth } from "@/lib/generated/extensions.server";
import {
  readConnectorConfigFromDatabase,
  readMetadataValueFromDatabase,
} from "@/lib/database";
import {
  getActiveConnectSiteById,
  listActiveConnectSiteOrigins,
  touchConnectSiteLastUsed,
} from "@/lib/connect-sites-store";

// ---------------------------------------------------------------------------
// cinatra#221 — per-site credential + connect-site allowlist union.
//
// The cnx_ per-site credential is a SERVER-TO-SERVER-ONLY bearer (codex finding
// c). It is accepted ONLY when the caller context is "server-to-server" (the
// /api/connect/token self-check and the #220 broker mint check). The
// browser-facing widget-stream route passes "browser", so a long-lived cnx_
// secret can never become a browser bearer. The legacy shared apiKey browser
// path stays behind a kill switch until #220 lands.
// ---------------------------------------------------------------------------

export type WidgetStreamCallerContext = "browser" | "server-to-server";

const CNX_PREFIX_RE = /^cnx_([0-9a-f-]{36})_/;

// Legacy shared-apiKey browser path kill switch (§2.5/§6). Default ON so
// already-provisioned/manual installs keep working until the broker fully
// replaces the long-lived shared bearer; an operator flips it OFF to
// force-migrate. Fail OPEN to enabled (back-compat) — only a stored primitive
// `false` disables.
const LEGACY_SHARED_KEY_KILL_SWITCH_KEY = "connect_legacy_shared_key_enabled";
function isLegacySharedKeyEnabled(): boolean {
  const stored = readConnectorConfigFromDatabase<unknown>(
    LEGACY_SHARED_KEY_KILL_SWITCH_KEY,
    true,
  );
  return stored !== false;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// Generic widget-stream auth/CORS for the /api/agents/[agentSlug]/stream route.
//
// Replaces the per-CMS trios (resolveDrupalWidgetOrigin/validateDrupalWidgetToken/
// buildDrupalCorsHeaders and the WordPress equivalents) with ONE implementation
// parameterized by the extension's `cinatra.widgetStream.auth` declaration
// (carried in the generated manifest):
//   - `instancesConfigKey`      — the connector_config key whose `instances[]`
//                                 rows carry the admin-configured `siteUrl`s
//                                 that form the CORS Origin allowlist
//   - `requiredInstanceFields`  — instance fields that must be non-empty for a
//                                 row to count (mirrors each CMS's settings
//                                 validity filter, so the allowlist never
//                                 broadens to half-configured instances)
//   - `tokenConfigKey`          — the connector_config key whose `apiKey` is
//                                 the widget's Bearer token
// The host never names a CMS here; policy differences are declaration data.

/**
 * Normalize a stored instance siteUrl for Origin comparison. Superset of the
 * per-CMS read-side normalizers (drupal: trim + strip trailing slashes;
 * wordpress: default https:// + strip hash/search + strip trailing slash) —
 * equivalent in effect for Origin matching, since an Origin header is always
 * `scheme://host[:port]` (no path/hash/search).
 */
function normalizeStoredSiteUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return withProtocol.replace(/\/+$/, "");
  }
}

const forCompare = (v: string) => v.replace(/\/+$/, "").toLowerCase();

/**
 * Does a server-verified request `origin` (always `scheme://host[:port]`) match
 * a stored instance `siteUrl`? Uses the SAME normalization the configured-origin
 * authorization primitive (`isConfiguredOrigin`) applies, so per-install identity
 * resolution (cinatra#274) and origin authorization never diverge. Empty/invalid
 * inputs never match.
 */
export function originMatchesSiteUrl(
  origin: string | null | undefined,
  siteUrl: string | null | undefined,
): boolean {
  const want = forCompare(String(origin ?? "").trim());
  const have = forCompare(normalizeStoredSiteUrl(String(siteUrl ?? "").trim()));
  return want.length > 0 && have.length > 0 && want === have;
}

/**
 * Is `origin` the site origin of a VALID configured instance under the
 * declared `instancesConfigKey` (all `requiredInstanceFields` non-empty)?
 *
 * This is the AUTHORIZATION primitive both the token broker (mint-time
 * `403` gate + consume-time live re-check) and the stream-route CORS
 * allowlist build on. It derives authz from configured-instance state — NOT
 * from a request CORS Origin header. The token broker passes the
 * client-asserted bound origin; the stream consume path re-checks the stored
 * bound origin is STILL configured (a token minted for a now-removed instance
 * is dead). Matching mirrors `resolveWidgetStreamOrigin`: stored siteUrl is
 * normalized (default https:// + strip path/hash/search + trailing slash) and
 * compared case-insensitively against the trailing-slash-trimmed candidate,
 * which is always a `scheme://host[:port]` origin.
 */
export function isConfiguredOrigin(
  origin: string | null | undefined,
  auth: GeneratedWidgetStreamAuth,
  // The CORS allowlist path tolerates the 10s connector_config cache; the
  // token CONSUME path passes { forceFresh: true } so removing an instance
  // kills its outstanding tokens immediately (codex finding), not after ≤10s.
  opts: { forceFresh?: boolean } = {},
): boolean {
  const want = forCompare(String(origin ?? "").trim());
  if (!want) return false;
  const config = opts.forceFresh
    ? readMetadataValueFromDatabase<{ instances?: unknown }>(
        `connector_config:${auth.instancesConfigKey}`,
        { instances: [] },
      )
    : readConnectorConfigFromDatabase<{ instances?: unknown }>(
        auth.instancesConfigKey,
        { instances: [] },
      );
  const instances = Array.isArray(config?.instances) ? config.instances : [];
  for (const raw of instances) {
    if (!raw || typeof raw !== "object") continue;
    const instance = raw as Record<string, unknown>;
    const siteUrl = String(instance.siteUrl ?? "").trim();
    if (!siteUrl) continue;
    const valid = auth.requiredInstanceFields.every(
      (field) => String(instance[field] ?? "").trim().length > 0,
    );
    if (!valid) continue;
    if (forCompare(normalizeStoredSiteUrl(siteUrl)) === want) return true;
  }
  return false;
}

/**
 * CORS origin allowlist for a widget-stream agent. Reflects the exact Origin
 * header value when it matches the normalized siteUrl of a VALID configured
 * instance (all `requiredInstanceFields` non-empty). Returns null otherwise.
 * Never a wildcard: responses are scoped to a configured CMS site origin.
 *
 * CORS is RESPONSE-HEADER POLICY only — never the authorization mechanism.
 * The authoritative gate is the Bearer token (short-lived `cit_` path: the
 * token-bound origin re-checked via `isConfiguredOrigin`; legacy path: the
 * long-lived key). This function exists to source the reflected
 * `Access-Control-Allow-Origin` header (and to gate the OPTIONS preflight).
 *
 * cinatra#221: the allowlist is the UNION of the legacy configured-instance
 * origins (via `isConfiguredOrigin`) and the non-revoked
 * connect_sites.widgetOrigin allowlist.
 */
export function resolveWidgetStreamOrigin(
  originHeader: string | null,
  auth: GeneratedWidgetStreamAuth,
): string | null {
  if (!originHeader) return null;
  if (isConfiguredOrigin(originHeader.trim(), auth)) return originHeader;
  // cinatra#221: UNION the legacy instances[].siteUrl allowlist (checked above
  // via isConfiguredOrigin) with the non-revoked connect_sites.widgetOrigin
  // allowlist. Same normalization. A revoked site's origin is absent from this
  // list, so revoke drops CORS immediately. NOTE: origin-in-union alone does
  // NOT authorize a cnx_ token — validateConnectServerCredential additionally
  // enforces the paired Origin===site.widgetOrigin binding so one valid origin
  // can never be a confused deputy for another site's token.
  const want = forCompare(originHeader.trim());
  if (!want) return null;
  try {
    // SCOPE the connect-site origin union to THIS agent's client (codex
    // adversarial Medium): `instancesConfigKey` is the client name
    // ("wordpress" | "drupal"), so a Drupal-connected origin never broadens the
    // WordPress widget-stream CORS allowlist (or vice-versa).
    for (const origin of listActiveConnectSiteOrigins(auth.instancesConfigKey)) {
      if (forCompare(normalizeStoredSiteUrl(origin)) === want) return originHeader;
    }
  } catch {
    // Connect-sites table not yet provisioned (fresh DB) — fall through.
  }
  return null;
}

/**
 * Validate a presented per-site `cnx_` credential against the connect_sites
 * allowlist (Table B). SERVER-TO-SERVER ONLY. Parses the embedded siteId, looks
 * up the non-revoked row, and constant-time-compares sha256-hex(presented)
 * against the stored credential_hash.
 *
 * PAIRED-BINDING (codex): the row's widgetOrigin MUST equal the requesting
 * origin. Origin-in-union alone is insufficient — one valid origin must not be
 * a confused deputy for another site's token. This is FAIL-CLOSED by default:
 * `enforcePairedOrigin` defaults to true, so a missing/blank `requestOrigin`
 * REJECTS rather than skips the binding. A caller that genuinely has no request
 * origin (e.g. a server-internal self-check) must pass
 * `enforcePairedOrigin: false` EXPLICITLY. On success, bumps lastUsedAt.
 *
 * Returns the matched siteId on success or null on any failure (unknown site,
 * revoked, hash mismatch, origin mismatch/missing). Never accepts the legacy
 * shared apiKey and never accepts a non-cnx_ bearer.
 */
export function validateConnectServerCredential(input: {
  credential: string;
  requestOrigin?: string | null;
  enforcePairedOrigin?: boolean;
  // The client the CALLER expects this credential to belong to (e.g. the
  // widget-stream agent's client). When supplied, the row's client MUST match
  // (codex adversarial High): a valid Drupal cnx_ must NEVER authorize a
  // WordPress agent and vice-versa. Omit only for client-agnostic callers.
  expectedClient?: string | null;
}): { siteId: string; client: string } | null {
  const credential = input.credential;
  if (!credential) return null;
  const m = CNX_PREFIX_RE.exec(credential);
  if (!m) return null;
  const siteId = m[1];
  let site;
  try {
    site = getActiveConnectSiteById(siteId);
  } catch {
    return null;
  }
  if (!site) return null;
  // Client binding (codex adversarial High): reject when the credential's site
  // belongs to a different client than the caller expects.
  if (input.expectedClient !== undefined && input.expectedClient !== null) {
    if (site.client !== input.expectedClient) return null;
  }
  // Paired Origin↔siteId binding — fail-closed by default.
  const enforcePaired = input.enforcePairedOrigin !== false;
  if (enforcePaired) {
    const want = forCompare(normalizeStoredSiteUrl(String(input.requestOrigin ?? "").trim()));
    const have = forCompare(normalizeStoredSiteUrl(site.widgetOrigin));
    // A blank/missing origin yields an empty `want` → reject (no confused-deputy
    // hole, no origin-less acceptance).
    if (!want || want !== have) return null;
  }
  const presented = Buffer.from(sha256Hex(credential));
  const stored = Buffer.from(site.credentialHash);
  if (presented.length !== stored.length) return null;
  if (!timingSafeEqual(presented, stored)) return null;
  try {
    touchConnectSiteLastUsed(siteId);
  } catch {
    /* best-effort */
  }
  return { siteId, client: site.client };
}

/**
 * Bearer token validator for a widget-stream agent.
 *
 * cinatra#221: the per-site `cnx_` credential branch is SERVER-TO-SERVER ONLY
 * (codex finding c). When `callerContext === "server-to-server"` and the bearer
 * is a `cnx_` credential, it is validated against the connect_sites allowlist
 * (with the paired Origin↔siteId binding via `requestOrigin`). The BROWSER path
 * (`callerContext === "browser"`, the default — preserving the existing
 * stream-route call) NEVER reaches the cnx_ branch: a `cnx_` bearer on the
 * browser path is rejected outright so a long-lived secret can never be a
 * browser bearer.
 *
 * The legacy shared `apiKey` browser path (the connector_config UUID-pair)
 * remains, gated behind the `connect_legacy_shared_key_enabled` kill switch
 * (default ON), until #220's broker replaces it. Constant-time comparison.
 *
 * cinatra#220: the legacy `apiKey` is read UNCACHED so rotating the long-lived
 * integration key takes effect immediately — not after the 10s connector_config
 * cache TTL (adversarial finding; matches the short-lived path's fresh
 * fingerprint check + the kill-switch's fresh read).
 */
export function validateWidgetStreamToken(
  token: string,
  auth: GeneratedWidgetStreamAuth,
  options?: {
    callerContext?: WidgetStreamCallerContext;
    requestOrigin?: string | null;
    // The expected client for the server-to-server cnx_ branch (codex
    // adversarial High). Threaded through so a Drupal credential cannot
    // authorize a WordPress agent. Omit only for client-agnostic callers.
    expectedClient?: string | null;
  },
): boolean {
  if (!token) return false;
  const callerContext = options?.callerContext ?? "browser";

  // Per-site cnx_ branch — server-to-server ONLY. Reject a cnx_ bearer on the
  // browser path explicitly (never fall through to the legacy shared key).
  if (CNX_PREFIX_RE.test(token)) {
    if (callerContext !== "server-to-server") return false;
    // Client binding is MANDATORY on this wrapper path (codex re-review High):
    // default expectedClient to the agent's client (auth.instancesConfigKey is
    // the client name, "wordpress" | "drupal") so a caller cannot omit it and
    // accept a cross-client cnx_. An explicit override is honored only if it
    // matches; a caller passing a different value is its own choice, but the
    // default closes the omission hole.
    const expectedClient = options?.expectedClient ?? auth.instancesConfigKey;
    return (
      validateConnectServerCredential({
        credential: token,
        requestOrigin: options?.requestOrigin,
        expectedClient,
      }) !== null
    );
  }

  // Legacy shared apiKey path (browser back-compat behind the kill switch).
  if (!isLegacySharedKeyEnabled()) return false;
  // cinatra#220: read the legacy apiKey UNCACHED (via readMetadataValueFromDatabase
  // on the `connector_config:` key) so key rotation takes effect immediately,
  // not after the 10s connector_config cache TTL.
  const config = readMetadataValueFromDatabase<{ apiKey?: unknown } | null>(
    `connector_config:${auth.tokenConfigKey}`,
    null,
  );
  const apiKey = typeof config?.apiKey === "string" ? config.apiKey : "";
  if (!apiKey) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(apiKey);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * CORS headers reflecting the validated origin. Use only after
 * resolveWidgetStreamOrigin returns non-null. (The former per-CMS builders
 * emitted this exact header set.)
 */
export function buildWidgetStreamCorsHeaders(allowedOrigin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "false",
    // The local widget reads `Deprecation`/`Sunset` (emitted on the legacy
    // long-lived path) to surface a one-line admin notice — a cross-origin
    // browser fetch can only read response headers named here (cinatra#220).
    "Access-Control-Expose-Headers": "Deprecation, Sunset",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
