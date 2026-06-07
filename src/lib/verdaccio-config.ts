// -----------------------------------------------------------------------------
// Host-app convenience wrapper for the @cinatra-ai/registries async Verdaccio
// config loader.
//
// The registries package cannot import @/lib/* aliases because that would cross
// the package boundary and create a host-app circular dependency.
// `loadVerdaccioConfigAsync` uses dependency injection: callers pass a
// `readIdentity` getter and a `decryptToken` helper. This file is the single
// host-app composition point; every server-context call site
// (publish/install/admin probe/MCP handler) imports
// `loadVerdaccioConfigForServer` from here.
//
// Publish/install paths resolve the config at the host boundary and pass it
// explicitly downstream; this wrapper is the outermost host-side entry callers
// await once.
// -----------------------------------------------------------------------------

import "server-only";
import {
  loadVerdaccioConfigAsync,
  type InstanceIdentitySnapshot,
  type VerdaccioConfig,
} from "@cinatra-ai/registries";
import { readInstanceIdentity, type InstanceIdentity } from "@/lib/instance-identity-store";
import { decryptSecret } from "@/lib/instance-secrets";
import { isGatekeptInstallEnabled } from "@/lib/gatekept-install";
import { VendorCredentialsMissingError } from "@/lib/marketplace-credentials";

function readPublishRegistryIdentitySnapshot(): InstanceIdentitySnapshot | null {
  const identity = readInstanceIdentity();
  if (!identity) return null;
  if (!identity.tokenCiphertext || !identity.tokenIv) {
    throw new VendorCredentialsMissingError(
      "Registry publish credentials are not configured for this instance. " +
        "Apply for vendor status from Configuration → Environment → Registries, " +
        "or configure CINATRA_AGENT_REGISTRY_TOKEN / URL / SCOPE.",
    );
  }
  return {
    instanceNamespace: identity.instanceNamespace,
    tokenCiphertext: identity.tokenCiphertext,
    tokenIv: identity.tokenIv,
    registryUrl: identity.registryUrl,
  };
}

/**
 * Returns a fully-resolved Verdaccio config wired with the host-app's
 * identity reader and secret decryptor.
 *
 * Throws `InstanceNamespaceNotConfiguredError` when no identity row exists AND no
 * env override is set. Callers either let that propagate (publish guard
 * surfaces it as a structured failure to the UI) or wrap in `.catch(() => null)`
 * for best-effort registry probes (e.g. administration page list display).
 *
 * `loadVerdaccioConfigAsync` decrypts the token field (not the password). Bind
 * the decryption to the matching aad string `"vendor.token"` used at
 * encrypt-time. If the metadata row was tampered with (token↔password swap),
 * `decipher.final()` raises before reaching the registry HTTP path.
 */
export async function loadVerdaccioConfigForServer(): Promise<VerdaccioConfig> {
  const usesEnvOverride =
    !!process.env.CINATRA_AGENT_REGISTRY_URL?.trim() ||
    !!process.env.CINATRA_AGENT_REGISTRY_TOKEN?.trim();

  if (usesEnvOverride) {
    return loadVerdaccioConfigAsync(() => null, (input) =>
      decryptSecret(input, "vendor.token"),
    );
  }

  return loadVerdaccioConfigAsync(readPublishRegistryIdentitySnapshot, (input) =>
    decryptSecret(input, "vendor.token"),
  );
}

// -----------------------------------------------------------------------------
// READ-side Verdaccio config wrapper.
//
// When a `consumerAttachment` is present on the identity row (post
// consumer auto-attach), the read path commits to the consumer Verdaccio
// read-only token (AAD "consumer.verdaccio.token"). A malformed attachment
// is treated as corruption and throws — matches the
// `resolveConsumerOrVendorMarketplaceToken` partitioning rule.
//
// When `consumerAttachment` is absent, falls through to the legacy
// vendor-side loader. This is the back-compat path for vendor
// instances that have not yet been upgraded to a consumer attachment.
//
// Use this wrapper for browse / install / catalog / detail-display call
// sites. Vendor-write paths (publish, registry token rotation, dist-tag
// set) MUST keep using `loadVerdaccioConfigForServer` directly.
// -----------------------------------------------------------------------------

const CONSUMER_VERDACCIO_AAD = "consumer.verdaccio.token";

/**
 * Choose the registry base URL for the synthesised consumer snapshot.
 *
 * Order: explicit `registries.remote.url` (post-marketplace-pivot canonical
 * location for the remote slot) → top-level `registryUrl` (legacy field) →
 * `https://registry.cinatra.ai` (the production default in
 * `@cinatra-ai/registries`'s loader). Never sends a consumer read token
 * to a stale loopback URL.
 */
function pickConsumerRegistryUrl(identity: InstanceIdentity): string {
  const fromRegistries = identity.registries?.remote?.url;
  if (typeof fromRegistries === "string" && fromRegistries.length > 0) {
    return fromRegistries;
  }
  if (typeof identity.registryUrl === "string" && identity.registryUrl.length > 0) {
    return identity.registryUrl;
  }
  return "https://registry.cinatra.ai";
}

/**
 * True when the attachment carries a fully-formed encrypted Verdaccio read
 * token (all three fields present + the expected algo). A consumer attachment
 * whose read-token fields are ALL absent is the intended gatekept-install /
 * post-scrub shape (see {@link loadVerdaccioConfigForReads}); a PARTIALLY
 * present payload is corruption and is rejected regardless of the flag.
 */
function hasConsumerVerdaccioReadToken(
  attachment: NonNullable<InstanceIdentity["consumerAttachment"]>,
): boolean {
  return (
    typeof attachment.verdaccioReadTokenCiphertext === "string" &&
    attachment.verdaccioReadTokenCiphertext.length > 0 &&
    typeof attachment.verdaccioReadTokenIv === "string" &&
    attachment.verdaccioReadTokenIv.length > 0 &&
    attachment.verdaccioReadTokenAlgo === "aes-256-gcm"
  );
}

/**
 * True when EVERY Verdaccio read-token field is absent — the sanitized /
 * gatekept-install attachment shape. Distinguished from a partially-populated
 * (corrupt) payload, which has some-but-not-all fields set.
 */
function consumerVerdaccioReadTokenAbsent(
  attachment: NonNullable<InstanceIdentity["consumerAttachment"]>,
): boolean {
  return (
    attachment.verdaccioReadTokenCiphertext === undefined &&
    attachment.verdaccioReadTokenIv === undefined &&
    attachment.verdaccioReadTokenAlgo === undefined
  );
}

function buildConsumerVerdaccioIdentitySnapshot(
  identity: InstanceIdentity,
): InstanceIdentitySnapshot {
  const attachment = identity.consumerAttachment;
  if (!attachment || !hasConsumerVerdaccioReadToken(attachment)) {
    throw new VendorCredentialsMissingError(
      "consumerAttachment is present but its Verdaccio read-token fields are " +
        "missing / malformed. Refusing to silently fall through to the legacy " +
        "vendor token — operator must inspect the instance_identity row and " +
        "repair the consumerAttachment payload.",
      "CONSUMER_VERDACCIO_ATTACHMENT_CORRUPTED",
    );
  }
  return {
    instanceNamespace: identity.instanceNamespace,
    tokenCiphertext: attachment.verdaccioReadTokenCiphertext as string,
    tokenIv: attachment.verdaccioReadTokenIv as string,
    registryUrl: pickConsumerRegistryUrl(identity),
  };
}

/**
 * Read-side Verdaccio config loader. See the file-level block above.
 *
 * Throws `VendorCredentialsMissingError` (code
 * `CONSUMER_VERDACCIO_ATTACHMENT_CORRUPTED`) when `consumerAttachment` is
 * present but malformed. Falls through to the vendor-side loader when
 * `consumerAttachment` is absent (back-compat).
 *
 * Gatekept-install staging: when `CINATRA_GATEKEPT_INSTALL` is ON and the
 * consumer attachment carries NO Verdaccio read-token fields (the sanitized /
 * post-scrub shape), this is a valid state — install reads route through the
 * broker via per-install grants, not this loader — so it falls through to the
 * legacy vendor-side loader rather than throwing. A PARTIALLY-populated
 * read-token payload is still corruption and throws regardless of the flag.
 * When the flag is OFF, behavior is unchanged: an attachment present without a
 * well-formed read token throws.
 */
export async function loadVerdaccioConfigForReads(): Promise<VerdaccioConfig> {
  const identity = readInstanceIdentity();
  if (identity?.consumerAttachment !== undefined) {
    // Gatekept-install staging: a consumer attachment whose read-token fields
    // are ALL absent is the sanitized post-scrub shape. Under the flag, do not
    // throw — the gatekept resolver owns install reads; fall through to the
    // legacy server loader for any non-install read this path still serves.
    if (
      isGatekeptInstallEnabled() &&
      consumerVerdaccioReadTokenAbsent(identity.consumerAttachment)
    ) {
      return loadVerdaccioConfigForServer();
    }
    const snapshot = buildConsumerVerdaccioIdentitySnapshot(identity);
    return loadVerdaccioConfigAsync(
      () => snapshot,
      (input) => decryptSecret(input, CONSUMER_VERDACCIO_AAD),
    );
  }
  return loadVerdaccioConfigForServer();
}
