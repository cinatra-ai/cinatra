import "server-only";

// -----------------------------------------------------------------------------
// Namespace-keyed Nango facade for the public-registry credential lifecycle.
//
// Credential lifecycle:
//   - The cinatra app DB stores ONLY non-secret metadata for the remote
//     registry slot. The temporary `requestSecret` (during pending) and the
//     long-lived npm token (after approval) live in Nango credentials, keyed
//     per namespace + kind: `cinatra-registry-{kind}-{namespace}`.
//   - Two kinds: "request-secret" (created on POST /api/register success;
//     deleted on terminal transitions or cancel) and "token" (created on
//     approved-response; deleted on disconnect).
//   - Callers NEVER assemble credential IDs by hand — only `(namespace, kind)`
//     is exposed. `getRegistryCredentialRef` derives the persisted
//     `nangoCredentialRef` without duplicating the format string.
//
// Divergence from the generic Nango connection pattern:
//   `ensureNangoIntegration` accepts `provider: string`, and
//   `importNangoConnection` allows omitting `connectorKey` (in which case
//   the wrapper SKIPS the connection-record save). Per-namespace credentials
//   are not the right shape for the connection-record store, so we use the
//   generic bearer-token provider and OMIT `connectorKey`. The
//   `NangoConnectorKey` union does not need to be amended.
//
// Readback verification:
//   `writeRegistryCredential` performs a readback verification AFTER
//   `importNangoConnection` resolves. If the readback returns a different
//   value (or null), the helper THROWS with a generic message. Callers catch
//   the throw and route to their respective terminal paths. The verification
//   is fully internal to this helper.
//
// Logging contract: this helper NEVER logs the value or the readback value.
// On verification failure, only a generic message is thrown — secret content
// is never reachable from any log sink.
// -----------------------------------------------------------------------------

import {
  deleteNangoConnection,
  ensureNangoIntegration,
  getNangoCredentials,
  importNangoConnection,
  isNangoConfigured,
} from "@/lib/nango-system";

export type RegistryCredentialKind = "request-secret" | "token";

const REGISTRY_PROVIDER_CONFIG_KEY = "cinatra-registry";

/**
 * Internal credential-id assembly. Centralized here so callers cannot drift
 * by handcrafting `cinatra-registry-${kind}-${namespace}` template literals.
 * The exported `getRegistryCredentialRef` helper returns the same value for
 * call sites that need to persist the ref.
 */
function buildCredentialId(namespace: string, kind: RegistryCredentialKind): string {
  return `cinatra-registry-${kind}-${namespace}`;
}

/**
 * Returns the Nango connectionId for the given namespace + kind, suitable for
 * persisting to `RemoteRegistryConnection.nangoCredentialRef` in the
 * instance-identity store. Always equal to the `connectionId` actually used
 * by `writeRegistryCredential`.
 */
export function getRegistryCredentialRef(
  namespace: string,
  kind: RegistryCredentialKind,
): string {
  return buildCredentialId(namespace, kind);
}

/**
 * Reads the credential value (stripping the Nango envelope) for the given
 * namespace + kind. Returns null when:
 *   - Nango is not configured (`isNangoConfigured()` === false)
 *   - Nango returns null (no such credential, or credential lookup failed)
 *   - The credential exists but does not carry an `apiKey` field
 *
 * Mirrors the existing `getNangoCredentials` no-op-on-error contract.
 */
export async function readRegistryCredential(
  namespace: string,
  kind: RegistryCredentialKind,
): Promise<string | null> {
  if (!isNangoConfigured()) return null;
  const credentials = await getNangoCredentials(
    REGISTRY_PROVIDER_CONFIG_KEY,
    buildCredentialId(namespace, kind),
  );
  if (!credentials || typeof credentials !== "object") return null;
  const apiKey = (credentials as { apiKey?: unknown }).apiKey;
  return typeof apiKey === "string" ? apiKey : null;
}

/**
 * Writes (creates or replaces) the credential value for the given namespace
 * + kind, then VERIFIES the write took by reading it back and asserting
 * string equality with the input. Throws on any of:
 *   - Nango not configured, so callers learn that persistence failed
 *   - The Nango import call rejecting
 *   - The readback returning a different value or null
 *
 * The thrown error message is generic ("verification failed") — neither the
 * input value nor the readback value is included so that any caller-side
 * log of the error cannot leak secret content.
 */
export async function writeRegistryCredential(
  namespace: string,
  kind: RegistryCredentialKind,
  value: string,
): Promise<void> {
  if (!isNangoConfigured()) {
    throw new Error("Nango is not configured; cannot persist registry credential.");
  }

  // Nango validates `provider` against its template catalog and rejects
  // arbitrary strings. `private-api-bearer` is the generic Bearer-token
  // template — matches how an npm token is sent to a private registry.
  // OMIT `connectorKey` so the wrapper skips the connection-record save
  // because per-namespace credentials are not the right shape for that store.
  await ensureNangoIntegration({
    provider: "private-api-bearer",
    providerConfigKey: REGISTRY_PROVIDER_CONFIG_KEY,
    displayName: "Cinatra Registry",
  });

  const connectionId = buildCredentialId(namespace, kind);
  await importNangoConnection({
    // connectorKey omitted — see the per-namespace credential note above.
    providerConfigKey: REGISTRY_PROVIDER_CONFIG_KEY,
    connectionId,
    credentials: { type: "API_KEY", apiKey: value },
  });

  // Treat `importNangoConnection` resolving without throw as necessary but not
  // sufficient. Read back what was just written, assert string equality.
  // forceRefresh:true bypasses any in-memory cache the Nango wrapper may keep
  // so the readback reflects what's actually persisted at the Nango API layer.
  const readback = await getNangoCredentials(
    REGISTRY_PROVIDER_CONFIG_KEY,
    connectionId,
    { forceRefresh: true },
  );
  const readbackValue =
    readback && typeof readback === "object" && "apiKey" in readback
      ? (readback as { apiKey?: unknown }).apiKey
      : null;
  if (readbackValue !== value) {
    // Generic message only — never include the input or readback value.
    throw new Error(
      "Nango credential write verification failed (readback did not match input).",
    );
  }
}

/**
 * Deletes the credential for the given namespace + kind. Idempotent — a
 * second call when the credential is already gone does not throw. The
 * underlying Nango wrapper already swallows missing-connection errors;
 * the extra try/catch here is defensive.
 */
export async function deleteRegistryCredential(
  namespace: string,
  kind: RegistryCredentialKind,
): Promise<void> {
  if (!isNangoConfigured()) return;
  try {
    await deleteNangoConnection(
      REGISTRY_PROVIDER_CONFIG_KEY,
      buildCredentialId(namespace, kind),
    );
  } catch {
    // Idempotent: missing-credential or 404-equivalent is fine.
  }
}
