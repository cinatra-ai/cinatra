import "server-only";

// Core provisioning logic for cinatra#221 "Connect with Cinatra".
//
// This module composes the atomic store primitives (connect-sites-store.ts)
// into the authorize/exchange/revoke/rotate/install-code flows and owns all the
// security-critical PURE validators (redirect_uri + widget_origin allowlisting,
// PKCE S256 verification, consent CSRF). It mints the per-site server-to-server
// credential (cnx_<siteId>_<secret>) whose plaintext is returned EXACTLY ONCE
// and never persisted — only sha256(credential) is stored.
//
// Composition boundary (does NOT duplicate wp#4 / cinatra#220): this is the
// PROVISIONING half. It writes the long-lived per-site credential into the
// CMS server-side store. #220 owns the runtime browser token path. This module
// adds no browser-facing token logic.

import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { ensureInstanceId } from "@/lib/instance-identity-store";
import { webhookSecretService } from "@/lib/webhook-secret-service";
import {
  consumeAuthorizationCode,
  insertAuthorizationCode,
  listConnectSitesForOrg,
  revokeConnectSiteRow,
  sweepExpiredAuthorizationCodes,
  upsertConnectSiteCredential,
  type ConnectAuthorizationCodeRow,
  type ConnectSiteRow,
} from "@/lib/connect-sites-store";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONNECT_SCOPE = "connector:provision";
export const CONNECT_CONTRACT_VERSION = "v1";
export const SUPPORTED_CONTRACT_VERSIONS = ["v1"] as const;
export const CONNECT_CODE_CHALLENGE_METHOD = "S256";

export type ConnectClient = "wordpress" | "drupal";
const CONNECT_CLIENTS: readonly ConnectClient[] = ["wordpress", "drupal"];

// Authorization code TTL: 120s. Install code TTL: 10 minutes.
const AUTH_CODE_TTL_MS = 120_000;
const INSTALL_CODE_TTL_MS = 10 * 60_000;

// Per-client callback contract (codex Critical-1 mitigation): redirect_uri PATH
// is pinned to a known per-client value, NOT an arbitrary path, and for
// WordPress the query MUST also carry the connect-callback action.
const CLIENT_CALLBACK_CONTRACT: Record<
  ConnectClient,
  { path: string; requiredAction?: string }
> = {
  wordpress: {
    path: "/wp-admin/admin-post.php",
    requiredAction: "cinatra_connect_callback",
  },
  drupal: {
    path: "/admin/config/services/cinatra/connect/callback",
  },
};

// ---------------------------------------------------------------------------
// Hash / crypto helpers (no plaintext secret ever logged or persisted)
// ---------------------------------------------------------------------------

/** sha256 -> base64url. Used for code hashes, credential hashes, S256. */
export function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

/** sha256 -> lowercase hex. Used where a hex column is convenient. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Constant-time string equality over UTF-8 bytes (length-safe). */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
// RFC 7636 §4.1: code_verifier is 43–128 chars from the unreserved set
// [A-Za-z0-9-._~]. Enforcing this rejects a degenerate verifier (e.g. "x")
// from a buggy/hostile CMS that would be trivially brute-forced if an attacker
// observed the code + challenge (codex adversarial Low).
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** A valid S256 code_challenge is base64url, 43 chars (sha256 of a verifier). */
export function isValidCodeChallenge(value: string): boolean {
  return BASE64URL_43.test(value);
}

/** A valid RFC 7636 code_verifier (43–128 unreserved chars). */
export function isValidCodeVerifier(value: string): boolean {
  return typeof value === "string" && PKCE_VERIFIER_RE.test(value);
}

/**
 * Verify a PKCE S256 challenge: base64url(sha256(code_verifier)) === challenge.
 * Rejects a code_verifier that is not RFC-7636-conformant (43–128 unreserved
 * chars) BEFORE hashing. Constant-time comparison so a partial-match timing
 * oracle cannot probe the stored challenge.
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false;
  if (!isValidCodeVerifier(codeVerifier)) return false;
  const computed = sha256Base64Url(codeVerifier);
  return constantTimeEquals(computed, codeChallenge);
}

// ---------------------------------------------------------------------------
// Client enum
// ---------------------------------------------------------------------------

export function isConnectClient(value: unknown): value is ConnectClient {
  return typeof value === "string" && CONNECT_CLIENTS.includes(value as ConnectClient);
}

// ---------------------------------------------------------------------------
// URL validation helpers (anti open-redirect — codex Critical-1)
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopbackHost(hostname: string): boolean {
  // URL.hostname strips the brackets from IPv6, so "[::1]" becomes "::1".
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function allowsHttp(): boolean {
  return process.env.NODE_ENV !== "production";
}

function hasControlOrCrlf(value: string): boolean {
  // Reject CR, LF, and any C0/C1 control characters (header/redirect smuggling).
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/**
 * Validate a redirect_uri for a given client and return the canonical
 * callbackOrigin on success, or null on any rejection. Layered controls
 * (there is intentionally NO static registry — the human admin on the consent
 * screen is the allowlist; this just blocks structurally dangerous values):
 *   - absolute URL; https (http loopback in non-prod only)
 *   - no userinfo; no fragment; no CR/LF/control chars
 *   - PATH must equal the per-client callback contract path; for WordPress the
 *     query must also contain action=cinatra_connect_callback (codex: check the
 *     action, not just the path)
 */
export function validateRedirectUri(
  client: ConnectClient,
  uri: string,
): { ok: true; callbackOrigin: string } | { ok: false } {
  if (typeof uri !== "string" || !uri || hasControlOrCrlf(uri)) return { ok: false };
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { ok: false };
  }
  // Scheme: https always; http only for loopback in non-prod.
  if (url.protocol === "https:") {
    // ok
  } else if (url.protocol === "http:") {
    if (!(allowsHttp() && isLoopbackHost(url.hostname))) return { ok: false };
  } else {
    return { ok: false };
  }
  // No userinfo (https://user:pass@host can disguise the real origin).
  if (url.username || url.password) return { ok: false };
  // No fragment.
  if (url.hash) return { ok: false };
  // Reject empty host.
  if (!url.hostname) return { ok: false };

  const contract = CLIENT_CALLBACK_CONTRACT[client];
  // URL normalizes percent-encoding and resolves dot-segments in pathname, so a
  // strict equality check against the contract path is safe.
  if (url.pathname !== contract.path) return { ok: false };
  if (contract.requiredAction) {
    // codex High: WordPress/PHP resolves a DUPLICATED scalar query param
    // last-wins, so `?action=cinatra_connect_callback&action=evil` would pass a
    // first-value check yet route to a different WP action. Require EXACTLY ONE
    // `action` whose sole value is the contract action — reject duplicates.
    const actions = url.searchParams.getAll("action");
    if (actions.length !== 1 || actions[0] !== contract.requiredAction) {
      return { ok: false };
    }
    // Defense-in-depth: the only query param the WP callback contract expects
    // is `action`. Reject ANY other query key so a smuggled param cannot alter
    // server-side routing/handling at the callback.
    for (const key of url.searchParams.keys()) {
      if (key !== "action") return { ok: false };
    }
  } else {
    // Drupal contract carries no required query — reject any query entirely so
    // the callback URL is exactly the known path.
    if (url.search) return { ok: false };
  }
  return { ok: true, callbackOrigin: url.origin };
}

/**
 * Validate a widget_origin: an absolute ORIGIN only (scheme+host+optional
 * port; no path/query/fragment/userinfo), https in prod (loopback-http in
 * dev), reject the literal "null". Returns the normalized origin or null.
 */
export function validateWidgetOrigin(
  origin: string,
): { ok: true; widgetOrigin: string } | { ok: false } {
  if (typeof origin !== "string" || !origin || hasControlOrCrlf(origin)) return { ok: false };
  const trimmed = origin.trim();
  if (trimmed.toLowerCase() === "null") return { ok: false };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false };
  }
  if (url.protocol === "https:") {
    // ok
  } else if (url.protocol === "http:") {
    if (!(allowsHttp() && isLoopbackHost(url.hostname))) return { ok: false };
  } else {
    return { ok: false };
  }
  if (url.username || url.password) return { ok: false };
  if (!url.hostname) return { ok: false };
  // Origin only: reject anything beyond scheme://host[:port]. URL.pathname is
  // "/" for an origin-only input; any other path, any query, or any hash means
  // the caller supplied more than an origin.
  if (url.pathname !== "/" && url.pathname !== "") return { ok: false };
  if (url.search) return { ok: false };
  if (url.hash) return { ok: false };
  // url.origin is the punycode-normalized, port-normalized canonical origin
  // ("https://example.com", "https://example.com:8443"). Default ports are
  // dropped by URL, giving stable equality with the widget Origin header.
  return { ok: true, widgetOrigin: url.origin };
}

// ---------------------------------------------------------------------------
// Consent CSRF token (§1.4)
// ---------------------------------------------------------------------------

function consentCsrfKey(): string {
  // Reuse the instance encryption key material as the HMAC secret so no new
  // secret is introduced; the key is required for the instance to boot. The
  // token is only meaningful within this instance and is single-use + short
  // lived, so deriving from CINATRA_ENCRYPTION_KEY is sufficient.
  const raw = process.env.CINATRA_ENCRYPTION_KEY;
  if (!raw) throw new Error("CINATRA_ENCRYPTION_KEY is required for connect consent CSRF tokens");
  return raw;
}

/**
 * Issue a consent CSRF token bound to the session and the validated request
 * parameter set (request_id). HMAC(sessionId + requestId + expiry). The token
 * is `<expiryMs>.<hmac>` so the verifier can reject expired tokens without
 * server-side storage. Single-use enforcement is structural: the request_id is
 * derived from the exact validated param set shown, and the auth code is bound
 * to those exact params, so a replayed token cannot smuggle different params.
 */
export function issueConsentCsrfToken(input: {
  sessionId: string;
  requestId: string;
  ttlMs?: number;
}): string {
  const expiry = Date.now() + (input.ttlMs ?? 10 * 60_000);
  // A per-issuance random nonce makes every token unique (two tokens issued in
  // the same millisecond for the same session+request must NOT collide — that
  // would defeat single-use tracking). The nonce is part of the signed payload.
  const nonce = randomBytes(16).toString("base64url");
  const mac = createHmac("sha256", consentCsrfKey())
    .update(`${input.sessionId}\n${input.requestId}\n${expiry}\n${nonce}`)
    .digest("base64url");
  return `${expiry}.${nonce}.${mac}`;
}

export function verifyConsentCsrfToken(input: {
  token: string;
  sessionId: string;
  requestId: string;
}): boolean {
  if (typeof input.token !== "string") return false;
  const parts = input.token.split(".");
  if (parts.length !== 3) return false;
  const [expiryStr, nonce, presented] = parts;
  if (!expiryStr || !nonce || !presented) return false;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  const expected = createHmac("sha256", consentCsrfKey())
    .update(`${input.sessionId}\n${input.requestId}\n${expiry}\n${nonce}`)
    .digest("base64url");
  return constantTimeEquals(presented, expected);
}

// Best-effort single-use registry for consent CSRF tokens (codex adversarial
// Medium). Each minted code is already independently single-use + short-TTL +
// PKCE-bound, so a replay only lets an ALREADY-CONSENTING org-admin mint extra
// codes for THEIR OWN connection — no privilege escalation, no cross-org reach.
// We still enforce single-use to honor the §1.4 contract: a token's HMAC is
// recorded as consumed in-process on first successful consume, so an in-process
// replay is rejected. State lives on globalThis (survives HMR) and self-prunes
// by expiry.
//
// RESIDUAL (codex re-review Medium, accepted for v1): this registry is
// PROCESS-LOCAL. On a multi-process / serverless deployment a replay routed to a
// different worker within the token TTL could still mint another code. cinatra
// runs as a single standalone Next.js process (next.config output:"standalone"),
// so this is not currently reachable; if the deployment ever fans out to
// multiple instances, promote this to a DB/Redis atomic single-use nonce. The
// blast radius even then is bounded to the consenting admin's own connection.
declare global {
  var __cinatraConsentCsrfConsumed: Map<string, number> | undefined;
}
function consentConsumedMap(): Map<string, number> {
  if (!globalThis.__cinatraConsentCsrfConsumed) {
    globalThis.__cinatraConsentCsrfConsumed = new Map();
  }
  return globalThis.__cinatraConsentCsrfConsumed;
}

/**
 * Verify a consent CSRF token AND mark it consumed (single-use). Returns true
 * only on the FIRST valid use; subsequent uses of the same token (same process)
 * return false. Use this in the Approve action (which mints a code). Deny may
 * use the plain verify (no code minted).
 */
export function consumeConsentCsrfToken(input: {
  token: string;
  sessionId: string;
  requestId: string;
}): boolean {
  if (!verifyConsentCsrfToken(input)) return false;
  const map = consentConsumedMap();
  const now = Date.now();
  // Opportunistic prune of expired entries.
  if (map.size > 1024) {
    for (const [k, exp] of map) if (exp <= now) map.delete(k);
  }
  // Key on the full token (HMAC included) so distinct tokens are distinct.
  if (map.has(input.token)) return false;
  // Record consumed until the token's own expiry.
  const dot = input.token.indexOf(".");
  const expiry = Number(input.token.slice(0, dot)) || now + 10 * 60_000;
  map.set(input.token, expiry);
  return true;
}

/** Test seam: clear the consumed-token registry. */
export function __resetConsentCsrfConsumedForTests(): void {
  consentConsumedMap().clear();
}

/**
 * Derive a stable opaque request_id from the validated parameter set so a
 * consent POST cannot smuggle different params than were shown on the GET. Any
 * mutation of client/redirect_uri/widget_origin/code_challenge/scope/state
 * changes the request_id, invalidating the bound CSRF token (codex: bind ALL
 * shown params, including `state`, so the redirect's state cannot be altered
 * relative to the consent view).
 */
export function deriveConsentRequestId(input: {
  client: ConnectClient;
  redirectUri: string;
  widgetOrigin: string;
  codeChallenge: string;
  scope: string;
  state: string;
}): string {
  return sha256Base64Url(
    [
      input.client,
      input.redirectUri,
      input.widgetOrigin,
      input.codeChallenge,
      input.scope,
      input.state,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Authorize request validation (shared GET + POST)
// ---------------------------------------------------------------------------

export type ValidatedAuthorizeParams = {
  client: ConnectClient;
  redirectUri: string;
  widgetOrigin: string;
  callbackOrigin: string;
  state: string;
  scope: string;
  codeChallenge: string;
  requestId: string;
};

/**
 * Validate the full authorize parameter set. Returns the canonicalized params
 * (callbackOrigin derived, widgetOrigin normalized) plus a request_id, or a
 * typed error. Pure — no DB, no session.
 */
export function validateAuthorizeParams(raw: {
  client?: string | null;
  redirect_uri?: string | null;
  widget_origin?: string | null;
  state?: string | null;
  scope?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
}):
  | { ok: true; params: ValidatedAuthorizeParams }
  | { ok: false; reason: string } {
  // DESIGN NOTE (codex adversarial High, accepted by spec §1.2/§1.3):
  // redirect_uri (callback origin) and widget_origin are validated structurally
  // but NOT cross-bound to each other — they MAY legitimately differ (the CMS
  // server callback can live on a different origin than the public widget). The
  // anti-confusion control is the human org-admin on the consent screen, who is
  // shown BOTH the callback origin and the widget origin prominently with the
  // anti-phishing warning. There is intentionally no static origin registry
  // (the admin connects arbitrary new sites), so the consent ceremony — gated
  // to org_owner/org_admin/platform_admin on their OWN session, single-use CSRF
  // token bound to these exact params — is the allowlist. The minted credential
  // is scoped to the approving admin's org + this widget_origin, so a tricked
  // pairing cannot reach another org's sites.
  if (!isConnectClient(raw.client)) return { ok: false, reason: "invalid_client" };
  const client = raw.client;

  if (raw.scope !== CONNECT_SCOPE) return { ok: false, reason: "invalid_scope" };
  if (raw.code_challenge_method !== CONNECT_CODE_CHALLENGE_METHOD) {
    return { ok: false, reason: "invalid_code_challenge_method" };
  }
  if (typeof raw.code_challenge !== "string" || !isValidCodeChallenge(raw.code_challenge)) {
    return { ok: false, reason: "invalid_code_challenge" };
  }
  if (typeof raw.state !== "string" || raw.state.length === 0 || raw.state.length > 256) {
    return { ok: false, reason: "invalid_state" };
  }
  if (typeof raw.redirect_uri !== "string") return { ok: false, reason: "invalid_redirect_uri" };
  const redirectCheck = validateRedirectUri(client, raw.redirect_uri);
  if (!redirectCheck.ok) return { ok: false, reason: "invalid_redirect_uri" };
  if (typeof raw.widget_origin !== "string") return { ok: false, reason: "invalid_widget_origin" };
  const widgetCheck = validateWidgetOrigin(raw.widget_origin);
  if (!widgetCheck.ok) return { ok: false, reason: "invalid_widget_origin" };

  const params: ValidatedAuthorizeParams = {
    client,
    redirectUri: raw.redirect_uri,
    widgetOrigin: widgetCheck.widgetOrigin,
    callbackOrigin: redirectCheck.callbackOrigin,
    state: raw.state,
    scope: raw.scope,
    codeChallenge: raw.code_challenge,
    requestId: deriveConsentRequestId({
      client,
      redirectUri: raw.redirect_uri,
      widgetOrigin: widgetCheck.widgetOrigin,
      codeChallenge: raw.code_challenge,
      scope: raw.scope,
      state: raw.state,
    }),
  };
  return { ok: true, params };
}

// ---------------------------------------------------------------------------
// Code generation + issuance (§1.5)
// ---------------------------------------------------------------------------

/** Generate a fresh authorization code (plaintext + its sha256 hash). */
export function generateAuthorizationCode(): { code: string; codeHash: string } {
  const code = randomBytes(32).toString("base64url");
  return { code, codeHash: sha256Base64Url(code) };
}

/** Generate a fresh install code: "cci_" + base64url(randomBytes(24)). */
export function generateInstallCode(): { installCode: string; codeHash: string } {
  const installCode = `cci_${randomBytes(24).toString("base64url")}`;
  return { installCode, codeHash: sha256Base64Url(installCode) };
}

/**
 * Issue an authorization code for the Approve path. Persists ONLY the sha256
 * hash. Returns the plaintext code (to be appended to the redirect once).
 */
export function issueAuthorizationCode(input: {
  params: ValidatedAuthorizeParams;
  adminUserId: string;
  orgId: string | null;
}): { code: string; codeHash: string } {
  // Lazy sweep keeps the table bounded without a separate cron.
  try {
    sweepExpiredAuthorizationCodes();
  } catch {
    /* best-effort */
  }
  const { code, codeHash } = generateAuthorizationCode();
  const inserted = insertAuthorizationCode({
    codeHash,
    grantType: "auth_code",
    client: input.params.client,
    redirectUri: input.params.redirectUri,
    widgetOrigin: input.params.widgetOrigin,
    callbackOrigin: input.params.callbackOrigin,
    codeChallenge: input.params.codeChallenge,
    adminUserId: input.adminUserId,
    orgId: input.orgId,
    scope: input.params.scope,
    expiresAtIso: new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(),
  });
  if (!inserted) {
    // Astronomically improbable sha256 collision — caller surfaces a 500.
    throw new Error("Failed to persist authorization code (hash collision)");
  }
  return { code, codeHash };
}

/**
 * Mint an install code (fallback path §4). Operator supplies a validated
 * widget_origin + client; we persist ONLY the hash. Returns the plaintext code
 * (shown once).
 */
export function mintInstallCode(input: {
  client: ConnectClient;
  widgetOrigin: string;
  adminUserId: string;
  orgId: string | null;
}):
  | { ok: true; installCode: string }
  | { ok: false; reason: string } {
  const widgetCheck = validateWidgetOrigin(input.widgetOrigin);
  if (!widgetCheck.ok) return { ok: false, reason: "invalid_widget_origin" };
  try {
    sweepExpiredAuthorizationCodes();
  } catch {
    /* best-effort */
  }
  const { installCode, codeHash } = generateInstallCode();
  const inserted = insertAuthorizationCode({
    codeHash,
    grantType: "install_code",
    client: input.client,
    redirectUri: null,
    widgetOrigin: widgetCheck.widgetOrigin,
    callbackOrigin: null,
    codeChallenge: null,
    adminUserId: input.adminUserId,
    orgId: input.orgId,
    scope: CONNECT_SCOPE,
    expiresAtIso: new Date(Date.now() + INSTALL_CODE_TTL_MS).toISOString(),
  });
  if (!inserted) {
    throw new Error("Failed to persist install code (hash collision)");
  }
  return { ok: true, installCode };
}

// ---------------------------------------------------------------------------
// Per-site credential (§2.3, §2.5)
// ---------------------------------------------------------------------------

const CNX_PREFIX_RE = /^cnx_([0-9a-f-]{36})_/;

/** Parse the siteId embedded in a presented cnx_ credential, or null. */
export function parseConnectCredentialSiteId(credential: string): string | null {
  if (typeof credential !== "string") return null;
  const m = CNX_PREFIX_RE.exec(credential);
  return m ? m[1] : null;
}

/**
 * Upsert the connect-site row and mint its per-site credential. The credential
 * is `cnx_<siteId>_<secret>` and its sha256-hex hash is computed IN SQL over
 * the FINAL site_id (see upsertConnectSiteCredential), so insert and rotate
 * paths are both a single atomic statement with no read-modify-write window and
 * no version double-bump. The caller passes only the random secret (never
 * logged/persisted); the plaintext credential is reconstructed here from the
 * RETURNING site_id + the same secret and is guaranteed to match the stored
 * hash. The plaintext is returned exactly once.
 */
export function upsertConnectSiteAndMintCredential(input: {
  client: ConnectClient;
  widgetOrigin: string;
  callbackOrigin: string | null;
  webhookSecretHash: string | null;
  adminUserId: string | null;
  orgId: string | null;
}): { credential: string; site: ConnectSiteRow } {
  const candidateSiteId = randomUUID();
  const secret = randomBytes(32).toString("base64url");

  const site = upsertConnectSiteCredential({
    candidateSiteId,
    client: input.client,
    widgetOrigin: input.widgetOrigin,
    callbackOrigin: input.callbackOrigin,
    credentialSecret: secret,
    webhookSecretHash: input.webhookSecretHash,
    adminUserId: input.adminUserId,
    orgId: input.orgId,
  });

  // The stored hash is sha256-hex of `cnx_<finalSiteId>_<secret>`; reconstruct
  // the plaintext over the authoritative (possibly preserved) site_id.
  const credential = `cnx_${site.siteId}_${secret}`;
  return { credential, site };
}

// ---------------------------------------------------------------------------
// Exchange (§2)
// ---------------------------------------------------------------------------

export type ConnectTokenResponse = {
  url: string;
  siteId: string;
  cinatraInstanceId: string;
  credential: string;
  credentialVersion: number;
  webhookSecret: string;
  contractVersion: string;
  capabilities: { tokenBroker: boolean; supportedContractVersions: string[] };
  // cinatra#343: the per-site inbound-webhook binding id, present ONLY for the
  // WordPress client (the connector that declares cinatra.webhooks). The plugin
  // POSTs publish events to
  // /webhook/cinatra-ai/wordpress-mcp-connector/post-published/<webhookBindingId>
  // signed with the bespoke `X-Cinatra-Sig-256: sha256=<hmac>` over webhookSecret
  // (the #343 legacy bridge). Absent for clients with no webhook declaration.
  webhookBindingId?: string;
};

// cinatra#343: the WordPress connector's inbound-webhook tuple (it declares
// cinatra.webhooks with the post-published hook). vendor/slug must match the
// connector package name (cinatra-ai/wordpress-mcp-connector).
const WORDPRESS_WEBHOOK_BINDING = {
  vendor: "cinatra-ai",
  slug: "wordpress-mcp-connector",
  hook: "post-published",
} as const;

/**
 * Consume an authorization_code grant and provision the site. All checks that
 * follow the atomic consume are folded into the generic invalid_grant error so
 * no oracle leaks which check failed (codex). Returns the token response on
 * success or a typed failure.
 */
export async function exchangeAuthorizationCode(input: {
  code: string;
  client: string;
  redirectUri: string;
  codeVerifier: string;
  webhookSecret: string;
  tokenBrokerAvailable: boolean;
}): Promise<{ ok: true; response: ConnectTokenResponse } | { ok: false }> {
  if (typeof input.code !== "string" || !input.code) return { ok: false };
  const codeHash = sha256Base64Url(input.code);
  // Atomic single-use consume. A second concurrent POST for the same code
  // returns null here.
  const row = consumeAuthorizationCode({ codeHash, grantType: "auth_code" });
  if (!row) return { ok: false };
  // Bound-parameter checks (generic failure on any mismatch).
  if (!isConnectClient(input.client) || row.client !== input.client) return { ok: false };
  if (typeof input.redirectUri !== "string" || row.redirectUri !== input.redirectUri) {
    return { ok: false };
  }
  if (!row.codeChallenge || !verifyPkceS256(input.codeVerifier, row.codeChallenge)) {
    return { ok: false };
  }
  return provisionFromGrant({
    row,
    webhookSecret: input.webhookSecret,
    tokenBrokerAvailable: input.tokenBrokerAvailable,
  });
}

/**
 * Consume an install_code grant and provision the site (fallback §4). No PKCE
 * (the install code is the bearer). client/widgetOrigin come from the stored
 * row.
 */
export async function exchangeInstallCode(input: {
  installCode: string;
  client: string;
  webhookSecret: string;
  tokenBrokerAvailable: boolean;
}): Promise<{ ok: true; response: ConnectTokenResponse } | { ok: false }> {
  if (typeof input.installCode !== "string" || !input.installCode) return { ok: false };
  const codeHash = sha256Base64Url(input.installCode);
  const row = consumeAuthorizationCode({ codeHash, grantType: "install_code" });
  if (!row) return { ok: false };
  if (!isConnectClient(input.client) || row.client !== input.client) return { ok: false };
  return provisionFromGrant({
    row,
    webhookSecret: input.webhookSecret,
    tokenBrokerAvailable: input.tokenBrokerAvailable,
  });
}

async function provisionFromGrant(input: {
  row: ConnectAuthorizationCodeRow;
  webhookSecret: string;
  tokenBrokerAvailable: boolean;
}): Promise<{ ok: true; response: ConnectTokenResponse } | { ok: false }> {
  if (!isConnectClient(input.row.client)) return { ok: false };
  const ensured = await ensureInstanceId();
  if (!ensured || !ensured.instanceId) return { ok: false };

  const { credential, site } = upsertConnectSiteAndMintCredential({
    client: input.row.client,
    widgetOrigin: input.row.widgetOrigin,
    callbackOrigin: input.row.callbackOrigin,
    webhookSecretHash: sha256Hex(input.webhookSecret),
    adminUserId: input.row.adminUserId,
    orgId: input.row.orgId,
  });

  // cinatra#343: mint (or rotate-in-place) the per-site inbound-webhook binding
  // ONLY for the WordPress client (the connector that declares cinatra.webhooks).
  // The shared webhookSecret is bridged as the legacy HMAC secret (D3c option A)
  // so the in-field plugin keeps its `X-Cinatra-Sig-256` signing. upsertLegacy is
  // tuple-scoped + idempotent across reconnects / credential rotations (a
  // reconnect re-issues a fresh webhookSecret here; the binding's stored secret
  // is updated in place, preserving its bindingId so the plugin's inbound URL
  // stays valid). No binding is minted for any other client.
  //
  // BEST-EFFORT, non-fatal: the connect-site credential above is
  // already committed in its own transaction. A binding-mint failure (transient
  // DB error / concurrent-insert race) must NOT fail the whole exchange and
  // strand the client with a rotated-but-unreturned credential — the auth code
  // is single-use and already consumed. On failure we log and return WITHOUT a
  // webhookBindingId; the binding is re-minted IDEMPOTENTLY (upsertLegacy
  // preserves/re-creates the tuple's active binding) on the next reconnect, and
  // until the generic /webhook path is live the in-field plugin still posts to
  // the existing /api/webhooks/wordpress route, so no delivery is lost.
  let webhookBindingId: string | undefined;
  if (input.row.client === "wordpress") {
    try {
      const binding = await webhookSecretService.upsertLegacy({
        vendor: WORDPRESS_WEBHOOK_BINDING.vendor,
        slug: WORDPRESS_WEBHOOK_BINDING.slug,
        hook: WORDPRESS_WEBHOOK_BINDING.hook,
        siteId: site.siteId,
        legacySecret: input.webhookSecret,
      });
      webhookBindingId = binding.bindingId;
    } catch (err) {
      // NEVER log the secret or the binding material — only the failure reason.
      console.error(
        "[connect/provisioning] WordPress webhook binding upsert failed (credential still issued; binding re-minted on next reconnect):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const url = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return {
    ok: true,
    response: {
      url,
      siteId: site.siteId,
      cinatraInstanceId: ensured.instanceId,
      credential,
      credentialVersion: site.credentialVersion,
      webhookSecret: input.webhookSecret,
      contractVersion: CONNECT_CONTRACT_VERSION,
      capabilities: {
        tokenBroker: input.tokenBrokerAvailable,
        supportedContractVersions: [...SUPPORTED_CONTRACT_VERSIONS],
      },
      ...(webhookBindingId ? { webhookBindingId } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Settings-surface helpers (revoke / list / rotate)
// ---------------------------------------------------------------------------

export function listConnectSites(orgId: string): ConnectSiteRow[] {
  return listConnectSitesForOrg(orgId);
}

export function revokeConnectSite(input: {
  siteId: string;
  orgId: string;
  actor: string;
}): boolean {
  return revokeConnectSiteRow(input);
}

export type { ConnectSiteRow } from "@/lib/connect-sites-store";
