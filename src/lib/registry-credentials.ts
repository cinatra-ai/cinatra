import "server-only";

// -----------------------------------------------------------------------------
// Request-scoped Nango facade for the public-registry credential lifecycle.
//
// Credential lifecycle:
//   - The cinatra app DB stores ONLY non-secret metadata for the remote
//     registry slot. The temporary `requestSecret` (during pending) and the
//     long-lived npm token (after approval) live in Nango credentials, keyed
//     per namespace + kind + requestId:
//     `cinatra-registry-{kind}-{namespace}-{requestId}`.
//   - Two kinds: "request-secret" (created on POST /api/register success;
//     deleted on terminal transitions or cancel) and "token" (created on
//     approved-response; deleted on disconnect).
//   - Request-scoping (cinatra#899): including the `requestId` in the key means a
//     stale teardown/worker for one access request can NEVER read, overwrite, or
//     delete the credential belonging to a DIFFERENT (e.g. concurrently
//     re-submitted) request for the same namespace. Cross-request isolation is
//     fail-closed by construction — the key itself encodes the request identity,
//     so a stale actor is physically unable to address another request's
//     credential. (The DB-row lost update was closed separately in cinatra#850.)
//   - Callers NEVER assemble credential IDs by hand — only `(namespace, kind,
//     requestId)` is exposed. `getRegistryCredentialRef` derives the persisted
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
// Logging contract: this helper NEVER logs a credential value or a readback
// value. On write-verification failure, only a generic message is thrown. On a
// real delete failure it logs the connectionId + a redacted error (both
// non-secret; the credential value is not even in scope for a delete) — secret
// content is never reachable from any log sink.
// -----------------------------------------------------------------------------

import {
  deleteNangoConnection,
  ensureNangoIntegration,
  getNangoCredentials,
  importNangoConnection,
  isNangoConfigured,
} from "@/lib/nango-system";
import { redactSensitive } from "@/lib/redact-sensitive";

export type RegistryCredentialKind = "request-secret" | "token";

const REGISTRY_PROVIDER_CONFIG_KEY = "cinatra-registry";

/**
 * Internal credential-id assembly. Centralized here so callers cannot drift by
 * handcrafting `cinatra-registry-${kind}-${namespace}-${requestId}` template
 * literals. The exported `getRegistryCredentialRef` helper returns the same
 * value for call sites that need to persist the ref.
 *
 * Fail-closed: `namespace` and `requestId` MUST be non-empty strings. A blank or
 * non-string component would collapse the key toward a namespace/request-agnostic
 * form (e.g. `...-undefined`) and re-open the exact cross-request aliasing this
 * scoping closes, so we throw rather than address an ambiguous credential.
 */
function buildCredentialId(
  namespace: string,
  kind: RegistryCredentialKind,
  requestId: string,
): string {
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new Error("registry credential id requires a non-empty namespace.");
  }
  if (typeof requestId !== "string" || requestId.length === 0) {
    throw new Error("registry credential id requires a non-empty requestId.");
  }
  return `cinatra-registry-${kind}-${namespace}-${requestId}`;
}

/**
 * Returns the Nango connectionId for the given namespace + kind + requestId,
 * suitable for persisting to `RemoteRegistryConnection.nangoCredentialRef` in the
 * instance-identity store. Always equal to the `connectionId` actually used by
 * `writeRegistryCredential` for the same request.
 */
export function getRegistryCredentialRef(
  namespace: string,
  kind: RegistryCredentialKind,
  requestId: string,
): string {
  return buildCredentialId(namespace, kind, requestId);
}

/**
 * Reads the credential value (stripping the Nango envelope) for the given
 * namespace + kind + requestId. Returns null when:
 *   - Nango is not configured (`isNangoConfigured()` === false)
 *   - Nango returns null (no such credential, or credential lookup failed)
 *   - The credential exists but does not carry an `apiKey` field
 *
 * Mirrors the existing `getNangoCredentials` no-op-on-error contract.
 */
export async function readRegistryCredential(
  namespace: string,
  kind: RegistryCredentialKind,
  requestId: string,
): Promise<string | null> {
  if (!isNangoConfigured()) return null;
  const credentials = await getNangoCredentials(
    REGISTRY_PROVIDER_CONFIG_KEY,
    buildCredentialId(namespace, kind, requestId),
  );
  if (!credentials || typeof credentials !== "object") return null;
  const apiKey = (credentials as { apiKey?: unknown }).apiKey;
  return typeof apiKey === "string" ? apiKey : null;
}

/**
 * Writes (creates or replaces) the credential value for the given namespace
 * + kind + requestId, then VERIFIES the write took by reading it back and
 * asserting string equality with the input. Throws on any of:
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
  requestId: string,
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

  const connectionId = buildCredentialId(namespace, kind, requestId);
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
 * True ONLY for a STRUCTURED HTTP 404 — the sole reliable, unambiguous signal
 * that the connection is already absent (so an idempotent double-delete succeeds
 * silently). Everything else — including message-only errors — is treated as a
 * REAL delete failure and logged by the caller, so no config/auth/5xx failure
 * can be misclassified as a benign missing connection.
 *
 * Deliberately NOT message/substring based: matching the word "connection" near
 * a "not found" token repeatedly proved too broad (it swallowed real failures
 * like "delete connection failed: provider config not found"). A structured 404
 * cannot be spoofed by operation-context prose, so this is the safe predicate
 * for a security-sensitive credential delete. (cinatra#899)
 */
function isMissingConnectionError(err: unknown): boolean {
  if (err == null) return false;
  const status = err as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  return (
    status.status === 404 ||
    status.statusCode === 404 ||
    status.response?.status === 404
  );
}

/**
 * Deletes the credential for the given namespace + kind + requestId. Idempotent
 * for an ALREADY-ABSENT credential — a second call when the credential is gone
 * does not throw.
 *
 * NEVER throws on a Nango-side failure: unwrapped one-shot callers (the
 * poll-job's terminal branches — the queue enqueues with the default
 * `attempts: 1`) rely on this helper resolving so they can still persist their
 * terminal state; a throw here would fail the job BEFORE the terminal write and
 * strand the slot at `pending`. A genuinely-absent credential (404/not-found) is
 * swallowed silently; any OTHER failure (network/auth/5xx) leaves the credential
 * IN PLACE, so it is LOGGED — connectionId + redacted error only, never the
 * credential value — so a masked credential-delete failure (e.g. a failed
 * orphaned-token reclaim) stays observable instead of silently swallowed
 * (cinatra#899).
 */
export async function deleteRegistryCredential(
  namespace: string,
  kind: RegistryCredentialKind,
  requestId: string,
): Promise<void> {
  if (!isNangoConfigured()) return;
  // Build (and validate) the id OUTSIDE the idempotency catch: a fail-closed key
  // validation error is a programming bug that must surface, whereas a
  // Nango-side delete failure is handled below.
  const connectionId = buildCredentialId(namespace, kind, requestId);
  try {
    await deleteNangoConnection(REGISTRY_PROVIDER_CONFIG_KEY, connectionId);
  } catch (err) {
    if (!isMissingConnectionError(err)) {
      console.warn(
        "[registry-credentials] delete failed; credential may still be present",
        redactSensitive({ connectionId, error: err }),
      );
    }
  }
}
