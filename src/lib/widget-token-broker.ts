import "server-only";
import {
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { Buffer } from "node:buffer";

import type { GeneratedWidgetStreamAuth } from "@/lib/generated/extensions.server";
import { readMetadataValueFromDatabase } from "@/lib/database";
import { getActiveConnectSiteById } from "@/lib/connect-sites-store";
import { isConfiguredOrigin } from "@/lib/widget-stream-auth";
import {
  getPostgresConnectionString,
  postgresSchema,
} from "@/lib/postgres-config";
import { ensurePostgresSchema } from "@/lib/postgres-schema-init";
import {
  runPostgresQueriesSync,
  quotePostgresIdentifier,
} from "@/lib/postgres-sync";

// ---------------------------------------------------------------------------
// Short-lived widget-stream token broker (cinatra#220 / wp#4 Option A).
//
// The plugin/module BACKEND (holding the long-lived integration key) calls the
// token-exchange endpoint to mint a SHORT-LIVED, origin/aud/scope-bound token
// that the browser then presents to the SSE stream endpoint directly. The
// long-lived key never reaches the browser.
//
// DECISION — OPAQUE server-side-tracked token (NOT a signed JWT). Core already
// hand-rolls signed tokens (a2a-auth.ts, agent-run-mcp-actor-token.ts), so
// "avoid a JWT dependency" is NOT the argument. For this single-issuer /
// single-verifier case (the same instance mints AND validates; no third party
// verifies) opaque wins on operational grounds: (1) instant revocation (a row
// delete / fingerprint mismatch) without a denylist; (2) intrinsic jti/replay
// handling; (3) hash-at-rest — only SHA-256(token) is stored, so a DB/log leak
// never yields a live credential; (4) live consume-time origin re-check
// (a JWT's claims are frozen at mint); (5) queryable audit columns.
//
// Wire form: `cit_` + 32 random bytes, base64url, no padding (43 chars). The
// token string is the lookup SECRET; the DB primary key is SHA-256(token) hex.
// Constant-time compare is unnecessary on the consume path because lookup is by
// hash of the FULL presented string (no secret-dependent branch).
//
// Storage: a dedicated `widget_stream_tokens` column-table (declared in
// drizzle-store.ts), NOT a connector_config blob (which is a full-blob rewrite
// with a cached TTL and would grow unbounded). Expired rows are swept on every
// mint and every consume (cheap, indexed on expires_at).
// ---------------------------------------------------------------------------

const TOKEN_TTL_SECONDS = 300; // 5 minutes
const TOKEN_PREFIX = "cit_";
const TOKEN_RANDOM_BYTES = 32;
const SUB_MAX_LENGTH = 128;
const TABLE = "widget_stream_tokens";

// Fixed salt + info label for the long-lived-key ROTATION FINGERPRINT.
//
// The fingerprint is NOT a password hash: it is a deterministic marker of the
// configured HIGH-ENTROPY machine credential (apiKey = `${uuid}-${uuid}`,
// ~256 bits) used only to detect that the key changed (mint-vs-consume
// equality) — never to authenticate, never reversed. It is derived with HKDF
// (RFC 5869), the correct primitive for deriving a fixed-length value from
// existing key material: it is fast (a couple of HMACs — safe to recompute on
// every stream request) and is a recognized key-derivation construction, not a
// password-storage hash. A slow KDF (bcrypt/scrypt) would be WRONG here: there
// is no low-entropy human secret to brute-force-protect.
const KEY_FINGERPRINT_SALT = "cinatra:widget-stream-token:key-fingerprint:v1";
const KEY_FINGERPRINT_INFO = "rotation-fingerprint";

// cinatra#410 — connect-site (`cnx_`) cit_ minting.
//
// The token-exchange endpoint also accepts a per-site `cnx_` connect-site
// credential (server-to-server, exactly like the legacy long-lived key — see
// the token route's `cnx_` branch). A `cit_` minted from a `cnx_` carries the
// SAME authority as a legacy-minted `cit_`: site/origin/aud/scope transport
// proof, NO user identity (the per-user `cwu_` on the stream remains the sole
// user/org authority). Such a token is bound to its connect-site row by storing
// the RESERVED discriminator `connect_site:<siteId>` in `token_config_key`
// (write-only today; this introduces its first read) and, in the rotation
// fingerprint, a marker over `cnx:<siteId>:<credentialVersion>` rather than the
// legacy machine key. A reconnect bumps `credential_version` (or a revoke drops
// the active row), so the consume-time live re-read invalidates outstanding
// `cit_` tokens immediately — mirroring the legacy key-rotation fingerprint
// re-check. Legacy `tokenConfigKey`s are forbidden from using this reserved
// prefix (asserted at mint) so the discriminator can never be spoofed.
const CONNECT_SITE_CONFIG_PREFIX = "connect_site:";

// SHA-256 hex of a HIGH-ENTROPY value. Used for token_hash = SHA-256(rawToken)
// where rawToken is 32 cryptographically-random bytes, and for the
// request-token lookup. Not a password hash — the input is never a
// human-chosen low-entropy secret.
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Deterministic rotation fingerprint of the configured long-lived key, derived
// with HKDF-SHA256 (32-byte output, hex). Same key → same fingerprint, so a
// rotated key produces a different fingerprint and invalidates outstanding
// tokens at consume time.
function keyFingerprintHex(apiKey: string): string {
  const derived = hkdfSync(
    "sha256",
    Buffer.from(apiKey, "utf8"),
    Buffer.from(KEY_FINGERPRINT_SALT, "utf8"),
    Buffer.from(KEY_FINGERPRINT_INFO, "utf8"),
    32,
  );
  return Buffer.from(derived).toString("hex");
}

// cinatra#410 — connect-site rotation marker for a `cnx_`-minted `cit_`. NOT a
// secret-derived fingerprint (the connect-site row's plaintext credential is
// deliberately never read into the token table): a deterministic SHA-256 over
// the immutable (siteId, credentialVersion) pair. A reconnect bumps
// credentialVersion → a different marker → outstanding `cit_` tokens fail the
// consume-time re-check against the live row's credentialVersion, exactly as the
// legacy key-fingerprint mismatch invalidates legacy tokens on key rotation. The
// authority granted is identical to a legacy `cit_` (site/origin transport
// only); the marker is solely the rotate/revoke invalidation lever, so the
// DB-write-only forgery surface here is no broader than the legacy column.
function connectSiteFingerprintHex(siteId: string, credentialVersion: number): string {
  return sha256Hex(`cnx:${siteId}:${credentialVersion}`);
}

/** `scheme://host[:port]` only — no path/query/hash. Returns "" if invalid. */
export function normalizeOriginStrict(value: unknown): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    // url.origin is already `scheme://host[:port]` with no path/query/hash.
    if (!url.origin || url.origin === "null") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function qSchemaTable(): string {
  return `${quotePostgresIdentifier(postgresSchema)}.${quotePostgresIdentifier(TABLE)}`;
}

function streamRoutePath(agentSlug: string): string {
  return `/api/agents/${agentSlug}/stream`;
}

// Security-critical reads (key-fingerprint rotation check, kill-switch, the
// consume-time configured-origin re-check) MUST bypass the 10s connector_config
// in-process cache (codex finding): otherwise key rotation / instance removal /
// disabling the legacy path could be bypassed for up to 10s across processes.
// connector_config is stored under the metadata key `connector_config:<id>`, so
// readMetadataValueFromDatabase reads the SAME row UNCACHED.
function readTokenConfigFresh(auth: GeneratedWidgetStreamAuth): {
  apiKey?: unknown;
  widgetLongLivedTokenEnabled?: unknown;
} | null {
  return readMetadataValueFromDatabase<{
    apiKey?: unknown;
    widgetLongLivedTokenEnabled?: unknown;
  } | null>(`connector_config:${auth.tokenConfigKey}`, null);
}

/** The long-lived integration key currently configured for this agent (or ""). */
function readLongLivedApiKey(auth: GeneratedWidgetStreamAuth): string {
  const config = readTokenConfigFresh(auth);
  return typeof config?.apiKey === "string" ? config.apiKey : "";
}

/**
 * Is the LEGACY long-lived-key stream path enabled for this integration?
 *
 * Phase-1 default is `true` (both paths accepted). An operator can set
 * `widgetLongLivedTokenEnabled: false` on the integration's token-config blob
 * to disable the legacy path (Phase 2); only an explicit `false` disables it,
 * so absent/garbage values stay back-compatible (default-enabled).
 */
export function isLongLivedTokenPathEnabled(auth: GeneratedWidgetStreamAuth): boolean {
  // Fresh (uncached) read so disabling the legacy path takes effect immediately.
  const config = readTokenConfigFresh(auth);
  return config?.widgetLongLivedTokenEnabled !== false;
}

/**
 * Constant-time equality of a presented long-lived Bearer key against the
 * configured `apiKey`. Equal-length-only timingSafeEqual (mirrors
 * validateWidgetStreamToken). Used by the token-exchange endpoint, which is the
 * ONLY caller that authenticates with the long-lived key.
 */
export function isAuthorizedLongLivedKey(
  presented: string,
  auth: GeneratedWidgetStreamAuth,
): boolean {
  if (!presented) return false;
  const apiKey = readLongLivedApiKey(auth);
  if (!apiKey) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(apiKey);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Best-effort sweep of expired rows (indexed on expires_at). */
function sweepExpired(): void {
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      { text: `DELETE FROM ${qSchemaTable()} WHERE expires_at < now()` },
    ],
  });
}

export type MintWidgetTokenResult = {
  token: string;
  tokenType: "Bearer";
  expiresIn: number;
  expiresAt: string;
  scope: string;
};

/**
 * Mint a short-lived token bound to the EXACT configured site origin. The
 * caller (token-exchange endpoint) MUST have already verified the long-lived
 * key AND that `origin` is a configured instance — but mint re-derives the
 * bound origin and its key fingerprint so the persisted row is self-consistent.
 *
 * Returns null when `origin` does not normalize to a non-empty origin (the
 * endpoint maps that to a 400; the configured-instance check is the endpoint's
 * 403).
 */
export function mintWidgetStreamToken(input: {
  agentSlug: string;
  auth: GeneratedWidgetStreamAuth;
  origin: string;
  sub?: string;
  scope?: string;
  issuerBaseUrl: string;
  /**
   * cinatra#410 — when present, mint a `cit_` bound to this verified connect-site
   * (the `cnx_` server-to-server path) instead of the legacy long-lived key. The
   * caller (token route) MUST have already verified the `cnx_` credential and
   * that `origin` equals the site's verified origin. Mutually exclusive with the
   * legacy key path: the connect-site path needs no configured `apiKey`.
   */
  connectSite?: { siteId: string; credentialVersion: number };
}): MintWidgetTokenResult | null {
  ensurePostgresSchema();

  const boundOrigin = normalizeOriginStrict(input.origin);
  if (!boundOrigin) return null;

  // Discriminate the rotation fingerprint + config-key marker by auth class.
  // Connect-site (`cnx_`): bind to (siteId, credentialVersion) via the reserved
  // `connect_site:<siteId>` config-key. Legacy: bind to the configured key's
  // fingerprint under the agent's real tokenConfigKey.
  let tokenConfigKeyValue: string;
  let keyFingerprint: string;
  if (input.connectSite) {
    const siteId = String(input.connectSite.siteId ?? "").trim();
    if (!siteId) return null;
    tokenConfigKeyValue = `${CONNECT_SITE_CONFIG_PREFIX}${siteId}`;
    keyFingerprint = connectSiteFingerprintHex(siteId, input.connectSite.credentialVersion);
  } else {
    // A legacy tokenConfigKey may NEVER collide with the reserved connect-site
    // namespace (else a forged `connect_site:` config-key could route consume to
    // the cnx branch). Fail closed rather than mint an ambiguous token.
    if (String(input.auth.tokenConfigKey ?? "").startsWith(CONNECT_SITE_CONFIG_PREFIX)) {
      return null;
    }
    const apiKey = readLongLivedApiKey(input.auth);
    if (!apiKey) return null; // no configured key → cannot bind a fingerprint
    tokenConfigKeyValue = input.auth.tokenConfigKey;
    keyFingerprint = keyFingerprintHex(apiKey);
  }

  const rawToken =
    TOKEN_PREFIX + randomBytes(TOKEN_RANDOM_BYTES).toString("base64url");
  const tokenHash = sha256Hex(rawToken);
  const jti = randomUUID();
  const scope = (input.scope ?? `${input.agentSlug}.stream`).slice(0, 128);
  const aud = streamRoutePath(input.agentSlug);
  const sub =
    typeof input.sub === "string" && input.sub.length > 0
      ? input.sub.slice(0, SUB_MAX_LENGTH)
      : null;

  // AUTHORITATIVE expiry is computed by the DB clock (now() + interval) so it is
  // consistent with the consume-time `expires_at > now()` check — app/DB clock
  // skew can never extend a token's life (codex finding). The client-facing
  // `expiresAt` below is app-computed and advisory (display only).
  const expiresAtIso = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();

  // Sweep on mint (cheap, indexed) then insert. Both in one transactional batch
  // so a failed insert doesn't leave the sweep half-applied semantics ambiguous.
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      { text: `DELETE FROM ${qSchemaTable()} WHERE expires_at < now()` },
      {
        text:
          `INSERT INTO ${qSchemaTable()} (` +
          `token_hash, jti, agent_slug, aud, iss, origin, scope, sub, ` +
          `token_config_key, token_key_fingerprint, expires_at, created_at` +
          `) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + make_interval(secs => $11), now())`,
        values: [
          tokenHash,
          jti,
          input.agentSlug,
          aud,
          input.issuerBaseUrl,
          boundOrigin,
          scope,
          sub,
          tokenConfigKeyValue,
          keyFingerprint,
          TOKEN_TTL_SECONDS,
        ],
      },
    ],
  });

  return {
    token: rawToken,
    tokenType: "Bearer",
    expiresIn: TOKEN_TTL_SECONDS,
    expiresAt: expiresAtIso,
    scope,
  };
}

export type ConsumeResult =
  | { ok: true; sub: string | null; jti: string; origin: string }
  | { ok: false; reason: ConsumeRejectReason };

export type ConsumeRejectReason =
  | "not_cit_token"
  | "not_found"
  | "expired"
  | "agent_mismatch"
  | "aud_mismatch"
  | "scope_mismatch"
  | "origin_mismatch"
  | "origin_unconfigured"
  | "key_rotated";

/**
 * Validate + (multi-use within TTL) consume a short-lived token presented to
 * the stream route. This is the AUTHORITATIVE authorization for the `cit_`
 * path — CORS plays no part. Every binding is re-checked against the STORED
 * row and live config, not the request's CORS header alone.
 */
export function consumeWidgetStreamToken(input: {
  token: string;
  agentSlug: string;
  auth: GeneratedWidgetStreamAuth;
  routePath: string;
  requestOrigin: string | null;
}): ConsumeResult {
  if (!input.token || !input.token.startsWith(TOKEN_PREFIX)) {
    return { ok: false, reason: "not_cit_token" };
  }

  ensurePostgresSchema();
  const tokenHash = sha256Hex(input.token);

  // Look this token up FIRST (carrying a server-evaluated not_expired flag) so
  // an expired-but-present row yields a precise "expired" reason. The
  // opportunistic GC sweep of OTHER expired rows runs afterward (it must not
  // race-delete this row before we can read it).
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text:
          `SELECT jti, agent_slug, aud, origin, scope, sub, ` +
          `token_config_key, token_key_fingerprint, ` +
          `(expires_at > now()) AS not_expired ` +
          `FROM ${qSchemaTable()} WHERE token_hash = $1 LIMIT 1`,
        values: [tokenHash],
      },
    ],
  });

  // Bounded growth, no external cron: GC expired rows on consume too.
  sweepExpired();

  const row = result?.rows?.[0] as
    | {
        jti?: string;
        agent_slug?: string;
        aud?: string;
        origin?: string;
        scope?: string;
        sub?: string | null;
        token_config_key?: string;
        token_key_fingerprint?: string;
        not_expired?: boolean;
      }
    | undefined;

  if (!row) {
    return { ok: false, reason: "not_found" };
  }

  // Expired (the sweep above may have raced with TTL; also defends if the sweep
  // no-op'd during build phase) → delete + reject.
  if (row.not_expired !== true) {
    runPostgresQueriesSync({
      connectionString: getPostgresConnectionString(),
      queries: [
        { text: `DELETE FROM ${qSchemaTable()} WHERE token_hash = $1`, values: [tokenHash] },
      ],
    });
    return { ok: false, reason: "expired" };
  }

  if (row.agent_slug !== input.agentSlug) {
    return { ok: false, reason: "agent_mismatch" };
  }
  if (row.aud !== input.routePath) {
    return { ok: false, reason: "aud_mismatch" };
  }
  if (row.scope !== `${input.agentSlug}.stream`) {
    return { ok: false, reason: "scope_mismatch" };
  }

  // Origin binding: the request Origin MUST normalize-match the stored bound
  // origin, AND that origin MUST still be a configured instance. A token minted
  // for a now-removed instance is dead.
  const storedOrigin = String(row.origin ?? "");
  const requestOriginNorm = normalizeOriginStrict(input.requestOrigin);
  if (!requestOriginNorm || requestOriginNorm !== normalizeOriginStrict(storedOrigin)) {
    return { ok: false, reason: "origin_mismatch" };
  }
  // Fresh (uncached) configured-instance re-check: a token minted for a
  // now-removed instance is dead immediately, not after the 10s cache TTL.
  if (!isConfiguredOrigin(storedOrigin, input.auth, { forceFresh: true })) {
    return { ok: false, reason: "origin_unconfigured" };
  }

  // Rotation re-check, discriminated by the stored config-key marker.
  const storedConfigKey = String(row.token_config_key ?? "");
  if (storedConfigKey.startsWith(CONNECT_SITE_CONFIG_PREFIX)) {
    // cinatra#410 — connect-site (`cnx_`) path. Re-read the LIVE connect-site
    // row; a revoke (no active row) or a reconnect (credential_version bump)
    // invalidates the token immediately. We ALSO re-assert the live row's
    // origin == the stored bound origin and the live client == this agent's
    // instances-config key, so a token can never survive a site being re-bound
    // to a different origin/client. The stored fingerprint must equal the marker
    // recomputed over the LIVE credential_version.
    const siteId = storedConfigKey.slice(CONNECT_SITE_CONFIG_PREFIX.length);
    const live = getActiveConnectSiteById(siteId);
    if (
      !live ||
      live.client !== input.auth.instancesConfigKey ||
      normalizeOriginStrict(live.widgetOrigin) !== normalizeOriginStrict(storedOrigin) ||
      row.token_key_fingerprint !== connectSiteFingerprintHex(siteId, live.credentialVersion)
    ) {
      return { ok: false, reason: "key_rotated" };
    }
  } else {
    // Legacy long-lived-key path: the key fingerprint at mint MUST equal the
    // current configured key's fingerprint. Regenerating the long-lived key
    // therefore invalidates ALL outstanding short-lived tokens immediately.
    const currentKey = readLongLivedApiKey(input.auth);
    if (!currentKey || row.token_key_fingerprint !== keyFingerprintHex(currentKey)) {
      return { ok: false, reason: "key_rotated" };
    }
  }

  return {
    ok: true,
    sub: row.sub ?? null,
    jti: String(row.jti ?? ""),
    origin: storedOrigin,
  };
}

export const __testing = {
  sha256Hex,
  TOKEN_PREFIX,
  TOKEN_TTL_SECONDS,
};
