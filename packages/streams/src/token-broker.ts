import { createHash, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

// ---------------------------------------------------------------------------
// Neutral short-lived opaque token broker (cinatra#344).
//
// The vocabulary-free generalization of src/lib/widget-token-broker.ts. Mints a
// SHORT-LIVED, origin/aud/scope/sub-bound OPAQUE token (NOT a signed JWT) for a
// single-issuer / single-verifier handshake (the same instance mints AND
// validates). Opaque wins here: instant revocation (a row delete / fingerprint
// mismatch), intrinsic replay handling, hash-at-rest (only SHA-256(token) is
// stored), and a LIVE consume-time origin re-check (a JWT's claims are frozen
// at mint).
//
// Wire form: `<prefix>` + 32 random bytes, base64url, no padding. The token
// string is the lookup SECRET; the storage primary key is SHA-256(token) hex.
//
// KEY DESIGN RULE: the package carries NO host DB coupling. The caller INJECTS a
// `TokenBrokerStore` (insert / lookup-by-hash / delete-by-hash / sweep-expired)
// and config accessors (the live long-lived key for the rotation fingerprint;
// the configured-origin re-check) plus options (prefix / ttl / HKDF salt+info).
// So a widget relay, a connect handshake, or any short-lived-token surface can
// reuse the same mechanics with its own storage and config.
// ---------------------------------------------------------------------------

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

/** SHA-256 hex of a HIGH-ENTROPY value (token / lookup key). Not a password hash. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The persisted token row, keyed by `tokenHash`. The store treats these as
 * opaque columns; the broker owns their semantics. `expiresAtIso` is the
 * authoritative expiry — a store backed by a DB clock SHOULD compute it server-
 * side (the broker passes `ttlSeconds` so the store can do `now() + interval`).
 */
export type TokenRow = {
  tokenHash: string;
  jti: string;
  aud: string;
  scope: string;
  origin: string;
  sub: string | null;
  keyFingerprint: string;
  /** The id this token authorizes (e.g. an agent slug / handshake subject). */
  subject: string;
  /** Issuer base URL (advisory audit column). */
  iss: string;
};

/** The persisted row as read back at consume time, with a server-evaluated expiry flag. */
export type StoredTokenRow = Omit<TokenRow, "tokenHash"> & {
  /** Server-side `expires_at > now()` evaluation. False ⇒ expired (the broker deletes + rejects). */
  notExpired: boolean;
};

/**
 * Injected persistence. The broker NEVER touches a DB directly — every storage
 * op routes through here. A test passes an in-memory implementation; the host
 * passes a Postgres-backed one. `insert` receives `ttlSeconds` so a DB-backed
 * store computes the authoritative expiry from its OWN clock (no app/DB skew).
 */
export type TokenBrokerStore = {
  insert: (row: TokenRow, ttlSeconds: number) => void;
  lookupByHash: (tokenHash: string) => StoredTokenRow | null;
  deleteByHash: (tokenHash: string) => void;
  sweepExpired: () => void;
};

/**
 * Injected config accessors. Both are read LIVE (uncached) by the broker —
 * rotation / instance-removal must take effect immediately, not after a cache
 * TTL. `readLongLivedKey` returns the configured high-entropy machine credential
 * for the rotation fingerprint (or "" when unconfigured). `isConfiguredOrigin`
 * is the live "is this origin still a configured instance" re-check.
 */
export type TokenBrokerConfig = {
  readLongLivedKey: () => string;
  isConfiguredOrigin: (origin: string) => boolean;
};

export type TokenBrokerOptions = {
  store: TokenBrokerStore;
  config: TokenBrokerConfig;
  /** Opaque-token wire prefix, e.g. "cit_". */
  prefix: string;
  /** Token lifetime in seconds. */
  ttlSeconds: number;
  /** HKDF salt for the rotation fingerprint (caller-namespaced, e.g. "<surface>:key-fingerprint:v1"). */
  keyFingerprintSalt: string;
  /** HKDF info label for the rotation fingerprint, e.g. "rotation-fingerprint". */
  keyFingerprintInfo: string;
  /** Max length of the `sub` claim. Default 128. */
  subMaxLength?: number;
  /** Max length of the `scope` claim. Default 128. */
  scopeMaxLength?: number;
};

export type MintInput = {
  /** The id this token authorizes (e.g. an agent slug). */
  subject: string;
  /** Required `aud` binding — the exact route path the token may be presented to. */
  aud: string;
  /** Required `scope` binding. */
  scope: string;
  /** The site origin to bind. Must normalize to a non-empty origin. */
  origin: string;
  /** Optional caller-supplied subject claim (e.g. an end-user id). */
  sub?: string;
  /** Issuer base URL (advisory audit column). */
  issuerBaseUrl: string;
};

export type MintResult = {
  token: string;
  tokenType: "Bearer";
  expiresIn: number;
  expiresAtIso: string;
  scope: string;
};

export type ConsumeInput = {
  token: string;
  subject: string;
  /** The route path the token is being presented to (must equal the bound `aud`). */
  routePath: string;
  /** The expected `scope` (must equal the bound `scope`). */
  expectedScope: string;
  /** The request's Origin header (or null). */
  requestOrigin: string | null;
};

export type ConsumeRejectReason =
  | "not_broker_token"
  | "not_found"
  | "expired"
  | "subject_mismatch"
  | "aud_mismatch"
  | "scope_mismatch"
  | "origin_mismatch"
  | "origin_unconfigured"
  | "key_rotated";

export type ConsumeResult =
  | { ok: true; sub: string | null; jti: string; origin: string }
  | { ok: false; reason: ConsumeRejectReason };

export type TokenBroker = {
  mint: (input: MintInput) => MintResult | null;
  consume: (input: ConsumeInput) => ConsumeResult;
  /**
   * Constant-time equality of a presented long-lived key against the configured
   * one (the ONLY caller authenticating with the long-lived key is the
   * token-exchange endpoint). Equal-length-only timingSafeEqual.
   */
  isAuthorizedLongLivedKey: (presented: string) => boolean;
  /** Exposed for callers/tests that need the same fingerprint derivation. */
  keyFingerprintHex: (apiKey: string) => string;
};

const DEFAULT_SUB_MAX_LENGTH = 128;
const DEFAULT_SCOPE_MAX_LENGTH = 128;
const TOKEN_RANDOM_BYTES = 32;

/**
 * Create a token broker bound to an injected store + config + options. The
 * rotation fingerprint is derived with HKDF-SHA256 (the correct primitive for a
 * fixed-length marker of an existing HIGH-ENTROPY machine credential — fast,
 * recomputed per request; a slow KDF would be WRONG, there is no low-entropy
 * human secret here).
 */
export function createTokenBroker(opts: TokenBrokerOptions): TokenBroker {
  const subMaxLength = opts.subMaxLength ?? DEFAULT_SUB_MAX_LENGTH;
  const scopeMaxLength = opts.scopeMaxLength ?? DEFAULT_SCOPE_MAX_LENGTH;
  const { store, config, prefix, ttlSeconds } = opts;

  function keyFingerprintHex(apiKey: string): string {
    const derived = hkdfSync(
      "sha256",
      Buffer.from(apiKey, "utf8"),
      Buffer.from(opts.keyFingerprintSalt, "utf8"),
      Buffer.from(opts.keyFingerprintInfo, "utf8"),
      32,
    );
    return Buffer.from(derived).toString("hex");
  }

  function isAuthorizedLongLivedKey(presented: string): boolean {
    if (!presented) return false;
    const apiKey = config.readLongLivedKey();
    if (!apiKey) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(apiKey);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  function mint(input: MintInput): MintResult | null {
    const boundOrigin = normalizeOriginStrict(input.origin);
    if (!boundOrigin) return null;

    const apiKey = config.readLongLivedKey();
    if (!apiKey) return null; // no configured key → cannot bind a fingerprint

    const rawToken = prefix + randomBytes(TOKEN_RANDOM_BYTES).toString("base64url");
    const tokenHash = sha256Hex(rawToken);
    const jti = randomUUID();
    const scope = input.scope.slice(0, scopeMaxLength);
    const keyFingerprint = keyFingerprintHex(apiKey);
    const sub =
      typeof input.sub === "string" && input.sub.length > 0
        ? input.sub.slice(0, subMaxLength)
        : null;

    // Sweep on mint (cheap, indexed) then insert.
    store.sweepExpired();
    store.insert(
      {
        tokenHash,
        jti,
        aud: input.aud,
        scope,
        origin: boundOrigin,
        sub,
        keyFingerprint,
        subject: input.subject,
        iss: input.issuerBaseUrl,
      },
      ttlSeconds,
    );

    // The client-facing `expiresAtIso` is app-computed and advisory (display
    // only); the AUTHORITATIVE expiry is the store's DB-clock-computed value.
    const expiresAtIso = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    return {
      token: rawToken,
      tokenType: "Bearer",
      expiresIn: ttlSeconds,
      expiresAtIso,
      scope,
    };
  }

  function consume(input: ConsumeInput): ConsumeResult {
    if (!input.token || !input.token.startsWith(prefix)) {
      return { ok: false, reason: "not_broker_token" };
    }
    const tokenHash = sha256Hex(input.token);

    // Look this token up FIRST (carrying a server-evaluated not_expired flag) so
    // an expired-but-present row yields a precise "expired" reason. The
    // opportunistic GC sweep of OTHER expired rows runs afterward (it must not
    // race-delete this row before we can read it).
    const row = store.lookupByHash(tokenHash);

    // Bounded growth, no external cron: GC expired rows on consume too.
    store.sweepExpired();

    if (!row) {
      return { ok: false, reason: "not_found" };
    }

    if (row.notExpired !== true) {
      store.deleteByHash(tokenHash);
      return { ok: false, reason: "expired" };
    }

    if (row.subject !== input.subject) {
      return { ok: false, reason: "subject_mismatch" };
    }
    if (row.aud !== input.routePath) {
      return { ok: false, reason: "aud_mismatch" };
    }
    if (row.scope !== input.expectedScope) {
      return { ok: false, reason: "scope_mismatch" };
    }

    // Origin binding: the request Origin MUST normalize-match the stored bound
    // origin, AND that origin MUST still be a configured instance.
    const storedOrigin = String(row.origin ?? "");
    const requestOriginNorm = normalizeOriginStrict(input.requestOrigin);
    if (!requestOriginNorm || requestOriginNorm !== normalizeOriginStrict(storedOrigin)) {
      return { ok: false, reason: "origin_mismatch" };
    }
    if (!config.isConfiguredOrigin(storedOrigin)) {
      return { ok: false, reason: "origin_unconfigured" };
    }

    // Rotation: the long-lived key fingerprint at mint MUST equal the current
    // configured key's fingerprint. Regenerating the key invalidates ALL
    // outstanding short-lived tokens immediately.
    const currentKey = config.readLongLivedKey();
    if (!currentKey || row.keyFingerprint !== keyFingerprintHex(currentKey)) {
      return { ok: false, reason: "key_rotated" };
    }

    return {
      ok: true,
      sub: row.sub ?? null,
      jti: String(row.jti ?? ""),
      origin: storedOrigin,
    };
  }

  return { mint, consume, isAuthorizedLongLivedKey, keyFingerprintHex };
}
