// -----------------------------------------------------------------------------
// Partitioned marketplace credential resolvers.
//
// The cinatra app now has THREE distinct kinds of marketplace bearer:
//
//   1. Consumer attachment bearer (minted by `instance_attach_self`; this
//      resolver returns it):
//      stored encrypted under AAD "consumer.marketplace.token" inside
//      `instance_identity.consumerAttachment.marketplaceTokenCiphertext`.
//      Used for install (PRINCIPAL_INSTANCE). Browse uses the anonymous public
//      REST catalog and does not resolve a bearer.
//
//   2. Vendor bearer (this resolver also returns it for
//      back-compat): stored encrypted under AAD "vendor.token" in the
//      legacy top-level `tokenCiphertext` slot. Used for vendor publish +
//      submission lifecycle (PRINCIPAL_VENDOR).
//
//   3. Sync-worker bearer: environment-only, NEVER stored in the identity
//      row. Used by the catalog-sync BullMQ worker (PRINCIPAL_SYNC_WORKER).
//      STRICTLY PARTITIONED — `resolveMarketplaceSyncWorkerToken` will
//      never read from consumerAttachment or tokenCiphertext, even as a
//      fallback. This is the catalog-poisoning guard: a leaked consumer
//      or vendor token must never authenticate the sync worker.
//
// Resolution order for the consumer-or-vendor resolver:
//   env MARKETPLACE_INSTANCE_TOKEN (operator override)
//     → identity.consumerAttachment.marketplaceTokenCiphertext (decrypted)
//     → identity.tokenCiphertext (decrypted, vendor back-compat)
//     → throws VendorCredentialsMissingError
//
// CRYPTO FAILURES (auth-tag mismatch, wrong key, malformed ciphertext) are
// NOT collapsed into VendorCredentialsMissingError — they propagate as
// loud config/corruption errors so the operator notices.
// -----------------------------------------------------------------------------

import {
  CONSUMER_MARKETPLACE_TOKEN_AAD,
  type InstanceIdentity,
} from "@/lib/instance-identity-store";
import { decryptSecret } from "@/lib/instance-secrets";

/**
 * Raised when no marketplace bearer is available via any resolution path.
 * Callers that distinguish "consumer not yet attached" from "publish-time
 * vendor credentials missing" should catch this error and branch on it.
 */
export class VendorCredentialsMissingError extends Error {
  public readonly code: string;

  constructor(message: string, code = "VENDOR_CREDENTIALS_MISSING") {
    super(message);
    this.name = "VendorCredentialsMissingError";
    this.code = code;
  }
}

/**
 * Resolve the marketplace MCP bearer for install / vendor-side read endpoints.
 * See file header for resolution order. Throws
 * {@link VendorCredentialsMissingError} when no source is available.
 *
 * NEVER returns the sync-worker token. NEVER falls through to env vars
 * other than `MARKETPLACE_INSTANCE_TOKEN`.
 *
 * Crypto failures (auth-tag, wrong key, malformed ciphertext) propagate
 * uncaught.
 */
export function resolveConsumerOrVendorMarketplaceToken(identity: InstanceIdentity | null): string {
  // (1) Env override always wins. Operator-supplied legacy path; trimmed
  // because copy-paste from .env files often leaves trailing newline/space.
  const envToken = process.env.MARKETPLACE_INSTANCE_TOKEN?.trim();
  if (envToken && envToken.length > 0) {
    return envToken;
  }

  if (identity) {
    // (2) Consumer attachment — preferred when present (post-attach state).
    //
    // When `consumerAttachment` is PRESENT we are committed to the consumer-
    // tier resolution path. A malformed attachment (missing IV, empty
    // ciphertext, wrong algo) is operator-visible corruption and MUST throw
    // — falling through to the legacy vendor token would be a confused-
    // deputy promotion of a corrupted consumer principal to vendor scope.
    const attachment = identity.consumerAttachment;
    if (attachment !== undefined) {
      if (
        typeof attachment.marketplaceTokenCiphertext !== "string" ||
        attachment.marketplaceTokenCiphertext.length === 0 ||
        typeof attachment.marketplaceTokenIv !== "string" ||
        attachment.marketplaceTokenIv.length === 0 ||
        attachment.marketplaceTokenAlgo !== "aes-256-gcm"
      ) {
        throw new VendorCredentialsMissingError(
          "consumerAttachment is present but malformed (missing ciphertext / IV " +
            "/ wrong algo). Refusing to silently fall through to the legacy " +
            "vendor token — operator must inspect the instance_identity row " +
            "and repair the consumerAttachment payload.",
          "CONSUMER_ATTACHMENT_CORRUPTED",
        );
      }
      return decryptSecret(
        {
          ciphertext: attachment.marketplaceTokenCiphertext,
          iv: attachment.marketplaceTokenIv,
        },
        CONSUMER_MARKETPLACE_TOKEN_AAD,
      );
    }

    // (3) Vendor token (back-compat). Reached ONLY when
    // consumerAttachment is fully absent (legacy vendor instance never
    // attached as a consumer). AAD = "vendor.token".
    if (
      typeof identity.tokenCiphertext === "string" &&
      identity.tokenCiphertext.length > 0 &&
      typeof identity.tokenIv === "string"
    ) {
      return decryptSecret(
        { ciphertext: identity.tokenCiphertext, iv: identity.tokenIv },
        "vendor.token",
      );
    }
  }

  throw new VendorCredentialsMissingError(
    "No marketplace MCP bearer is available. Configure MARKETPLACE_INSTANCE_TOKEN " +
      "or wait for the boot-time consumer-attach hook (`instance_attach_self`) to mint one.",
  );
}

/**
 * Resolve the marketplace MCP bearer used EXCLUSIVELY by admin/moderator
 * call sites (the vendor-application moderation queue, vendor-application
 * approve/reject/reset abilities, and any other PRINCIPAL_ADMIN-bound MCP
 * tool).
 *
 * Resolution order:
 *   1. `MARKETPLACE_ADMIN_TOKEN` env override (operator-supplied).
 *
 * There is NO DB-stored fallback and NO auto-attach for this resolver —
 * an admin bearer must always be
 * operator-supplied and admin-capable. The bearer is expected to be the
 * WP Application Password of a `cinatra_marketplace_admin`-capable user
 * on the marketplace WP install.
 *
 * Required in production for any admin operation. If unset, admin call
 * sites throw `MARKETPLACE_ADMIN_TOKEN_MISSING` so the missing
 * configuration is operator-visible rather than silently falling back to
 * a wrong-privilege bearer (catalog-poisoning / confused-deputy guard,
 * mirroring the sync-worker partition).
 *
 * @throws {VendorCredentialsMissingError} when the env var is absent.
 */
export function resolveMarketplaceAdminToken(): string {
  const token = process.env.MARKETPLACE_ADMIN_TOKEN?.trim();
  if (!token || token.length === 0) {
    throw new VendorCredentialsMissingError(
      "MARKETPLACE_ADMIN_TOKEN env var is not set. Admin-side marketplace " +
        "operations (vendor-application moderation: approve/reject/reset, " +
        "list_admin) require an operator-supplied bearer for a WP user with " +
        "the cinatra_marketplace_admin cap. There is NO DB fallback and NO " +
        "auto-attach for this resolver (confused-deputy guard).",
      "MARKETPLACE_ADMIN_TOKEN_MISSING",
    );
  }
  return token;
}

/**
 * Resolve the marketplace MCP bearer used by the catalog-sync BullMQ
 * worker. ENV-ONLY. Never reads from the identity row.
 *
 * @throws {VendorCredentialsMissingError} when the env var is absent.
 */
export function resolveMarketplaceSyncWorkerToken(): string {
  const token = process.env.MARKETPLACE_SYNC_WORKER_TOKEN?.trim();
  if (!token || token.length === 0) {
    throw new VendorCredentialsMissingError(
      "MARKETPLACE_SYNC_WORKER_TOKEN env var is not set. The catalog-sync " +
        "worker requires its own bearer — it MUST NOT fall back to the " +
        "consumer or vendor token (catalog-poisoning guard).",
      "SYNC_WORKER_TOKEN_MISSING",
    );
  }
  return token;
}

/**
 * Resolves the npm-scope view a caller is privileged to see across visibility
 * filters (catalog browse, local template lists, `cinatra.origin` gates).
 *
 * Returns `undefined` (== public-only view) for: no identity, a not-yet-
 * approved vendor application (`none`/`applied`/`rejected`), or a missing
 * canonical `vendorScope`. Returns the canonical vendor scope only when the
 * caller is an APPROVED vendor.
 *
 * The legacy back-compat path: an instance with no `vendorState`
 * field yet AND a stored vendor publish token (`tokenCiphertext`) AND a
 * non-empty `instanceNamespace` was an approved vendor under the
 * pre-consumer-split data model — surface its scope so its own private
 * packages stay visible. This back-compat surface is read-only here; the
 * boot-time reconcile persists `vendorState: "approved"` onto the row.
 *
 * NEVER derive viewer scope from `identity.instanceNamespace` directly:
 * that field is freely editable pre-vendor-approval and would let a
 * consumer rename to `@some-vendor-name` to impersonate that vendor's
 * privileged view of their `cinatra.origin: { visibility: "private" }`
 * packages.
 */
export function getEffectiveViewerScope(
  identity: InstanceIdentity | null,
): string | undefined {
  if (!identity) return undefined;

  if (identity.vendorState === "approved" && identity.vendorScope) {
    return identity.vendorScope;
  }

  if (
    identity.vendorState === undefined &&
    typeof identity.tokenCiphertext === "string" &&
    identity.tokenCiphertext.length > 0 &&
    identity.instanceNamespace
  ) {
    return `@${identity.instanceNamespace}`;
  }

  return undefined;
}
