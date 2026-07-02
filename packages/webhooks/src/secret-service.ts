// Per-webhook / per-site secret-service CONTRACT (cinatra#340).
//
// The INTERFACE lives in the package (the host wires the concrete impl over the
// `webhook_secret_bindings` table + the host secretsCodec in
// src/lib/webhook-secret-service.ts). A binding is minted per
// (vendor, slug, hook, site); the route resolves it by the server-issued opaque
// `bindingId` and NEVER from the request payload.
//
// Rotation is a BOUNDED dual-secret window: `rotate` makes the current secret
// the `previous` (valid until `previousExpiresAt`) and installs a fresh current,
// so a webhook in flight signed under the old secret still verifies until the
// window closes. The active-row partial-unique index (vendor,slug,hook,site)
// WHERE revoked_at IS NULL guarantees at most one active binding per tuple.
//
// #340 SCOPE: there is NO `legacySecret` here — the legacy single-shared-secret
// bridge + its storage are #343. `resolveByBindingId` returns `legacyEnabled`
// (always false in #340) but never a legacy secret.

import { randomBytes } from "node:crypto";

/** What the route needs to verify an inbound webhook for a binding. */
export interface ResolvedBinding {
  readonly bindingId: string;
  readonly vendor: string;
  readonly slug: string;
  readonly hook: string;
  readonly siteId: string;
  /**
   * Candidate secrets in priority order: the current secret, then a non-expired
   * previous secret during a rotation window. Already filtered for expiry.
   * EMPTY for a `legacyEnabled` binding (a legacy binding carries no Standard-
   * Webhooks secret — the route verifies it via {@link legacySecret} instead).
   */
  readonly secrets: string[];
  /**
   * The #343 legacy-bridge flag. When true the in-field sender signs with the
   * bespoke `sha256=<hex>` HMAC over {@link legacySecret} (NOT Standard-Webhooks),
   * and the route requires a caller-supplied idempotency-key header.
   */
  readonly legacyEnabled: boolean;
  /**
   * The single shared HMAC secret for a legacy-bridge binding — populated ONLY
   * when `legacyEnabled` (undefined for a Standard-Webhooks binding). The route
   * passes this to `verifyLegacyHmac`.
   */
  readonly legacySecret?: string;
}

export interface MintBindingInput {
  readonly vendor: string;
  readonly slug: string;
  readonly hook: string;
  readonly siteId: string;
  /**
   * Mint a #343 legacy-bridge binding (the in-field sender keeps its bespoke
   * `sha256=<hex>` HMAC). When true, {@link legacySecret} MUST be supplied; the
   * binding stores the encrypted legacy secret + `legacy_enabled=true` and the
   * route verifies via `verifyLegacyHmac` rather than Standard-Webhooks. The
   * returned `MintedBinding.secret` is the same legacy secret (no new Standard-
   * Webhooks secret is generated for a legacy binding).
   */
  readonly legacyEnabled?: boolean;
  /** The shared HMAC secret to bridge (required when `legacyEnabled`). */
  readonly legacySecret?: string;
}

/**
 * The narrow tuple-scoped legacy-binding upsert used at PROVISIONING time.
 *
 * Provisioning has only the (vendor, slug, hook, site) tuple — never an existing
 * `bindingId` — so a reconnect / credential-rotation cannot address an existing
 * binding by id to `rotate` it. `upsertLegacy` is idempotent over the active
 * tuple: it INSERTs a fresh legacy binding when none is active, or UPDATEs the
 * active one's legacy secret in place (preserving its `bindingId` so the plugin's
 * stored inbound URL stays valid across reconnects).
 */
export interface UpsertLegacyBindingInput {
  readonly vendor: string;
  readonly slug: string;
  readonly hook: string;
  readonly siteId: string;
  /** The shared HMAC secret to (re)store for the active binding. */
  readonly legacySecret: string;
}

export interface MintedBinding {
  readonly bindingId: string;
  /** The plaintext secret to hand to the connected site at provisioning time. */
  readonly secret: string;
}

/**
 * The host-owned secret service contract.
 *
 * `mint`   — create a fresh binding for a tuple; rejects when an active binding
 *            already exists (rotate instead). After `revoke`, `mint` inserts a
 *            fresh binding_id.
 * `resolveByBindingId` — the route's ONLY lookup; null = unknown/revoked.
 * `rotate` — single-txn dual-window rotation (current→previous, new current),
 *            guarded against concurrent rotation.
 * `revoke` — sets revoked_at (the binding stops resolving).
 */
export interface WebhookSecretService {
  mint(input: MintBindingInput): Promise<MintedBinding>;
  resolveByBindingId(bindingId: string): Promise<ResolvedBinding | null>;
  rotate(bindingId: string): Promise<MintedBinding>;
  revoke(bindingId: string): Promise<void>;
  /**
   * Tuple-scoped idempotent upsert of a LEGACY-bridge binding (cinatra#343).
   * INSERTs a fresh legacy binding for the active tuple, or UPDATEs the active
   * one's legacy secret in place (stable `bindingId`). Provisioning calls THIS
   * (it has only the tuple, never an existing binding id). Returns the
   * (stable-or-new) `bindingId` + the stored legacy secret.
   */
  upsertLegacy(input: UpsertLegacyBindingInput): Promise<MintedBinding>;
}

// Standard-Webhooks secrets are base64; the `whsec_` prefix is the convention
// the library strips on construction. 32 random bytes → a 256-bit secret.
const WHSEC_PREFIX = "whsec_";

/** Mint a fresh `whsec_`-prefixed Standard-Webhooks base64 secret. */
export function mintWebhookSecret(): string {
  return WHSEC_PREFIX + randomBytes(32).toString("base64");
}

/** Mint an opaque, URL-safe binding id (the value the inbound URL carries). */
export function mintBindingId(): string {
  return randomBytes(24).toString("base64url");
}
