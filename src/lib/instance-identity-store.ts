// -----------------------------------------------------------------------------
// Read/write helper for the `cinatra.metadata` row keyed "instance_identity".
// The row is the single source of truth for instance namespace plus encrypted
// Verdaccio credentials.
//
// Back-compat field mapping:
//   vendorName → instanceNamespace
//   oldVendorNames → oldInstanceNamespaces
//   instanceDisplayName stores the human-readable display name.
//
// Back-compat read shim: rows that still contain a "vendorName" key are
// transparently mapped to the current shape. Once a write happens, the row is
// persisted with the current keys.
//
// Pattern mirrors `openai-connection-store.ts` — single metadata key, JSON
// payload, in-process cache invalidation on every write.
//
// Cache split rationale: `invalidateInstanceIdentityCache` lives in a SEPARATE
// module (`@/lib/instance-identity-cache`) so vitest can
// `vi.mock("@/lib/instance-identity-cache", ...)` and reliably spy on the
// invalidation call. Same-module mocking is unreliable in vitest, hence the
// split. Consumers that need to invalidate the cache directly should import
// it from the cache module — this file does NOT re-export it.
// -----------------------------------------------------------------------------

import { randomBytes, randomUUID } from "node:crypto";
import {
  getPostgresConnectionString,
  postgresSchema,
  readMetadataValueFromDatabase,
  writeMetadataValueToDatabase,
} from "@/lib/database";
// Cache lives in a SEPARATE module so vi.mock can spy on the call without
// same-module mocking unreliability.
import { invalidateInstanceIdentityCache } from "@/lib/instance-identity-cache";
import { decryptSecret, encryptSecret } from "@/lib/instance-secrets";
import { withInstanceIdentityWriteLock } from "@/lib/instance-identity-write-lock";
import { quotePostgresIdentifier, runPostgresQueriesSync } from "@/lib/postgres-sync";

// -----------------------------------------------------------------------------
// Instance-attach proof-of-ownership secret.
//
// The plaintext is base64url(crypto.randomBytes(32)) — 256 bits of entropy
// expressed as a 43-character URL-safe string. Encrypted at rest under the
// existing AES-256-GCM helper with the AAD below; sent decrypted to the
// marketplace `instance_attach_self` ability only at attach/re-attach time.
// The marketplace stores ONLY sha256(secret) on
// `cinatra_instance_principals.attach_secret_hash`.
// -----------------------------------------------------------------------------
export const INSTANCE_ATTACH_SECRET_AAD = "consumer.instance-attach-secret";

// -----------------------------------------------------------------------------
// Partitioned-credential AADs. Each credential category uses its own AAD so a
// stored-field swap (e.g. someone renaming
// `consumerAttachment.marketplaceTokenCiphertext` to `tokenCiphertext`)
// cannot decrypt successfully into a wrong-context bearer.
// -----------------------------------------------------------------------------
export const CONSUMER_MARKETPLACE_TOKEN_AAD = "consumer.marketplace.token";
export const CONSUMER_VERDACCIO_TOKEN_AAD = "consumer.verdaccio.token";

/**
 * Derived vendor application state. Optional on the type for back-compat
 * with rows that pre-date the consumer/vendor split; mirrors
 * `cinatra_namespace_reservations.status` with this collapsing mapping:
 *
 *   "applied"   → "applied"   (locking — rename gate blocks)
 *   "approved"  → "approved"  (locking — rename gate blocks)
 *   "rejected"  → "rejected"  (NON-locking — operator can re-apply)
 *   "cancelled" → "none"
 *   "reset"     → "none"
 *
 * Rename-gate locking set = `{applied, approved}`. Rename-gate enforcement
 * lives in the vendor-application lifecycle work; this is a type-only
 * contract here.
 */
export type VendorState = "none" | "applied" | "approved" | "rejected";

/**
 * Marketplace consumer attachment state. Populated by a boot-time
 * `ensureMarketplaceAttachment` once the marketplace mints the consumer-tier
 * token via `instance_attach_self`. Both bearer ciphertexts use partitioned
 * AADs (see {@link CONSUMER_MARKETPLACE_TOKEN_AAD} +
 * {@link CONSUMER_VERDACCIO_TOKEN_AAD}).
 *
 * The Verdaccio read-token fields are OPTIONAL (staging). When gatekept install
 * is enabled, the marketplace no longer mints a deployment-wide Verdaccio read
 * token (install reads route through the broker via per-install grants), and the
 * one-shot scrub migration removes any previously-stored read-token fields. A
 * consumer attachment WITHOUT these fields is therefore a valid, intended shape
 * under the gatekept-install flag — not corruption. The marketplace consumer
 * bearer (`marketplaceToken*`) remains REQUIRED: it authenticates the
 * `extension_install_authorize` ability call that yields each grant.
 */
export type ConsumerAttachment = {
  /** Snapshot of the identity's instanceId at the time of first attach. */
  instanceIdAtAttach: string;
  attachedAt: string;
  lastRefreshedAt: string;
  marketplaceUsername: string;
  verdaccioUsername: string;
  marketplaceTokenCiphertext: string;
  marketplaceTokenIv: string;
  marketplaceTokenAlgo: "aes-256-gcm";
  /**
   * Encrypted deployment-wide Verdaccio read token. OPTIONAL: absent on
   * gatekept-install deployments (the broker holds the registry read credential;
   * the instance never receives a direct read token) and after the one-shot
   * scrub migration. Present on legacy direct-read deployments.
   */
  verdaccioReadTokenCiphertext?: string;
  verdaccioReadTokenIv?: string;
  verdaccioReadTokenAlgo?: "aes-256-gcm";
};

// UUIDv4 — the version nibble is pinned to `4` because `randomUUID()` always
// emits v4. Validation rejects v1/v3/v5 / non-UUID corruption hard.
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DURABLE_FIELD_NAMES = [
  "instanceId",
  "instanceAttachSecretCiphertext",
  "instanceAttachSecretIv",
  "instanceAttachSecretAlgo",
  // Consumer-attachment + derived vendor state — durable fields preserved by
  // the merge loop. Once the boot-time `ensureMarketplaceAttachment` hook
  // populates these, stale-snapshot writes from any caller must not clobber
  // them. The merge loop treats `undefined` as missing; a partial or empty
  // object from the caller is intentional and writes through.
  "consumerAttachment",
  "vendorState",
  "vendorScope",
  "vendorApplicationId",
  "vendorApplicationRepairStuckAt",
] as const;

// -----------------------------------------------------------------------------
// Public type for the persisted instance identity payload.
// -----------------------------------------------------------------------------

export type InstanceIdentity = {
  /** Machine-readable namespace ("vendor name" in registry/npm terms). */
  instanceNamespace: string;
  /** Human-readable display name shown wherever this Cinatra instance is referenced. */
  instanceDisplayName: string;
  /**
   * Stable machine identifier (UUIDv4) — generated once at identity creation
   * (setup wizard mode a/b/c) or backfilled at first post-upgrade boot via
   * {@link ensureInstanceId}. Survives `instanceNamespace` rename. The
   * marketplace `instance_attach_self` ability binds the consumer principal
   * to this UUID. NEVER exposed in UI.
   *
   * Optional in the type only for back-compat reads of legacy identity rows
   * predating the consumer/vendor split; once `ensureInstanceId()` resolves
   * it is guaranteed present. Use
   * {@link readInstanceIdentityRequiringInstanceId} for the narrowed type
   * that asserts presence.
   */
  instanceId?: string;
  /**
   * Encrypted instance-attach proof-of-ownership secret. Decrypted via
   * {@link decryptInstanceAttachSecret} only at attach/re-attach call sites;
   * never logged, never returned through any UI surface. The marketplace
   * stores only sha256(plaintext).
   */
  instanceAttachSecretCiphertext?: string;
  instanceAttachSecretIv?: string;
  instanceAttachSecretAlgo?: "aes-256-gcm";
  /**
   * Marketplace consumer attachment state. Populated by the boot hook AFTER
   * `instance_attach_self` runs. Absent on fresh installs pre-attach and on
   * pre-split legacy vendor identities (their bearer lives in the top-level
   * `tokenCiphertext` slot).
   */
  consumerAttachment?: ConsumerAttachment;
  /**
   * Vendor application state. See {@link VendorState}. Type-only contract
   * here; the rename gate (vendor-application lifecycle work) reads this.
   */
  vendorState?: VendorState;
  /**
   * Proposed vendor scope captured at application time. Canonical form:
   * npm-scope notation `"@scope"` (NOT raw "scope"). Set by the cinatra-side
   * vendor-application action; mirrored from the cm-side reservation row.
   */
  vendorScope?: string | null;
  /**
   * cm-side application id for cross-reference.
   */
  vendorApplicationId?: string | null;
  /**
   * ISO timestamp recorded when the marketplace reports this instance's
   * vendor application as terminally stuck in recovery (the recovery-attempt
   * cap was exhausted). While set, the reconcile worker stops driving
   * `vendor_application_complete_recovery` for this application — it would
   * only keep hammering a dead saga. The flag is tied to a specific
   * `vendorApplicationId`: it MUST be cleared whenever `vendorApplicationId`
   * changes (a fresh application must not inherit a stale stuck flag) or
   * `vendorState` becomes anything other than `"applied"` (an approved /
   * cancelled / reset application has no in-flight recovery to be stuck on).
   */
  vendorApplicationRepairStuckAt?: string | null;
  tokenCiphertext?: string;
  tokenIv?: string;
  tokenAlgo?: "aes-256-gcm";
  /** ISO timestamp of when the registry token was last set via setInstanceTokenAction.
   *  Null when the value is absent on back-compat rows. */
  tokenUpdatedAt?: string | null;
  passwordCiphertext?: string;
  passwordIv?: string;
  registryUrl?: string;
  firstPublishedAt: string | null;
  createdAt: string;
  /** Audit log of namespaces this instance has been published under. */
  oldInstanceNamespaces?: Array<{
    name: string;
    frozenAt: string;
    lastTokenCiphertext: string;
    lastTokenIv: string;
  }>;
  /** Cinatra Network connection state. Superseded by `registries.remote.status` — preserved for back-compat reads. */
  registryStatus?: "pending" | "connected" | null;
  /** Superseded by `registries.remote.contactEmail` — preserved for back-compat reads. */
  registryContactEmail?: string | null;
  /** Superseded by `registries.remote.requestedAt` — preserved for back-compat reads. */
  registryRequestedAt?: string | null;
  /**
   * Multi-registry connection slots. The operator can configure both a local
   * Verdaccio (e.g. http://127.0.0.1:4873) and the remote Cinatra Network
   * (registry.cinatra.ai) independently. Each slot is independently encrypted
   * with `aad="vendor.token"` via `encryptSecret`.
   *
   * On first read, if `registries` is undefined and the legacy top-level
   * `tokenCiphertext` / `registryUrl` are populated, the read shim seeds
   * either `local` or `remote` based on the registryUrl pattern (loopback →
   * local; everything else → remote).
   *
   * Some downstream consumers (publish/install) still read from the legacy
   * top-level fields, so those fields remain part of the payload contract.
   */
  registries?: {
    local?: RegistryConnection | null;
    remote?: RemoteRegistryConnection | null;
  };
};

export type RegistryConnection = {
  /** Registry base URL — e.g. http://127.0.0.1:4873 (local) or https://registry.cinatra.ai (remote). */
  url: string;
  tokenCiphertext: string;
  tokenIv: string;
  tokenAlgo: "aes-256-gcm";
  /** ISO timestamp when this slot's token was last set. */
  tokenUpdatedAt?: string | null;
  /** Remote-only access-request lifecycle. Local registries are paste-and-save (no request flow). */
  status?: "pending" | "connected";
  /** Remote-only — email collected on the access-request form. */
  contactEmail?: string;
  /** Remote-only — ISO timestamp when the access request was submitted. */
  requestedAt?: string;
};

/**
 * Remote registry connection metadata.
 *
 * The cinatra app DB stores ONLY non-secret metadata for the remote (Cinatra
 * Network) registry slot. The npm token and the temporary `requestSecret`
 * live in Nango credentials; this row never carries `tokenCiphertext` /
 * `tokenIv` / `tokenAlgo`. Legacy rows that still carry those fields are
 * degraded to `{ status: "not_connected" }` on read by `deriveRegistriesShim`
 * so a stale plaintext-cipher value never reaches downstream consumers.
 *
 * The `local` slot continues to use the `RegistryConnection` (paste-token)
 * shape.
 */
export type RemoteRegistryConnection = {
  /** Registry base URL — e.g. https://registry.cinatra.ai. */
  url: string;
  /** Mirrored from `instance_identity.instanceNamespace` for ergonomic reads. */
  namespace: string;
  /** Registry-issued request id; null when status is not_connected. */
  requestId?: string | null;
  /** ISO timestamp; mirrors the registry's `expiresAt`. */
  expiresAt?: string | null;
  status: "not_connected" | "pending" | "connected" | "denied" | "expired" | "error";
  contactEmail?: string | null;
  requestedAt?: string | null;
  approvedAt?: string | null;
  deniedAt?: string | null;
  denyReason?: string | null;
  /** Set when status flipped to connected (npm token persisted to Nango). */
  tokenUpdatedAt?: string | null;
  lastPolledAt?: string | null;
  nextPollAt?: string | null;
  /** Human-readable copy for the `error` state. */
  terminalReason?: string | null;
  /** Nango connection id for the npm token; present when status === "connected". */
  nangoCredentialRef?: string | null;

  // ---------------------------------------------------------------------------
  // Marketplace-governed reconcile cache (P6a-2b)
  //
  // After the repoint, this `remote` slot caches the marketplace's view of the
  // vendor record. `status` above is the coarser app-local connection state
  // mapped from `marketplaceState` (see `mapVendorStateToRemoteStatus`); the
  // raw marketplace state is preserved here for diagnostics + UI. A failed
  // reconcile NEVER overwrites `status` — it only records the error so a
  // currently-connected operator does not see a spurious disconnect.
  // ---------------------------------------------------------------------------
  /** Raw marketplace vendor.state (active|pending|suspended|rejected|unregistered|...). */
  marketplaceState?: string;
  /** Marketplace-side vendor id, for cross-reference + audit. */
  marketplaceVendorId?: number;
  /** ISO timestamp of the last successful OR failed reconcile attempt. */
  marketplaceLastReconciledAt?: string;
  /** Human-readable error from the most recent reconcile failure (or null on success). */
  marketplaceLastReconcileError?: string | null;
};

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const METADATA_KEY = "instance_identity";

// -----------------------------------------------------------------------------
// Read / write primitives
// -----------------------------------------------------------------------------

/**
 * Read the persisted instance identity, or `null` when the metadata row has
 * not yet been written (i.e. setup wizard step 1 has not completed).
 *
 * Back-compat read shim: transparently maps rows that still use the legacy
 * key names (vendorName, oldVendorNames) onto the current InstanceIdentity
 * shape. Once writeInstanceIdentity is called, the row is persisted with the
 * current keys.
 *
 * Unlike `openai-connection-store.readOpenAIConnection`, this function does
 * NOT default-merge missing optional fields — callers explicitly differentiate
 * between "never configured" and "configured" by checking the null sentinel.
 */
export function readInstanceIdentity(): InstanceIdentity | null {
  const raw = readMetadataValueFromDatabase<Record<string, unknown> | null>(METADATA_KEY, null);
  if (!raw) return null;

  // Back-compat shim: prefer new key, fall back to legacy key for deployed rows.
  const namespace = (raw.instanceNamespace ?? raw.vendorName) as string | undefined;
  if (!namespace) return null;

  const oldList =
    (raw.oldInstanceNamespaces as InstanceIdentity["oldInstanceNamespaces"]) ??
    (raw.oldVendorNames as InstanceIdentity["oldInstanceNamespaces"]) ??
    undefined;

  return {
    instanceNamespace: namespace,
    instanceDisplayName: ((raw.instanceDisplayName as string | undefined) ?? "").trim(),
    instanceId: (raw.instanceId as string | undefined) ?? undefined,
    instanceAttachSecretCiphertext:
      (raw.instanceAttachSecretCiphertext as string | undefined) ?? undefined,
    instanceAttachSecretIv: (raw.instanceAttachSecretIv as string | undefined) ?? undefined,
    instanceAttachSecretAlgo:
      (raw.instanceAttachSecretAlgo as "aes-256-gcm" | undefined) ?? undefined,
    // Passthrough for consumer-attachment + vendor-state fields. Persisted
    // `null` is preserved as a distinct durable value (semantically
    // "explicitly cleared" vs. absent). The merge loop in
    // writeInstanceIdentity treats only `undefined` as missing, so null
    // values write through and are preserved on stale-snapshot writes.
    consumerAttachment: (raw.consumerAttachment as ConsumerAttachment | undefined) ?? undefined,
    vendorState: (raw.vendorState as VendorState | undefined) ?? undefined,
    vendorScope:
      raw.vendorScope === undefined
        ? undefined
        : (raw.vendorScope as string | null),
    vendorApplicationId:
      raw.vendorApplicationId === undefined
        ? undefined
        : (raw.vendorApplicationId as string | null),
    vendorApplicationRepairStuckAt:
      raw.vendorApplicationRepairStuckAt === undefined
        ? undefined
        : (raw.vendorApplicationRepairStuckAt as string | null),
    tokenCiphertext: raw.tokenCiphertext as string,
    tokenIv: raw.tokenIv as string,
    tokenAlgo: "aes-256-gcm",
    tokenUpdatedAt: (raw.tokenUpdatedAt as string | null) ?? null,
    passwordCiphertext: raw.passwordCiphertext as string,
    passwordIv: raw.passwordIv as string,
    registryUrl: raw.registryUrl as string | undefined,
    firstPublishedAt: (raw.firstPublishedAt as string | null) ?? null,
    createdAt: raw.createdAt as string,
    oldInstanceNamespaces: oldList,
    registryStatus: (raw.registryStatus as "pending" | "connected" | null | undefined) ?? null,
    registryContactEmail: (raw.registryContactEmail as string | null | undefined) ?? null,
    registryRequestedAt: (raw.registryRequestedAt as string | null | undefined) ?? null,
    registries: deriveRegistriesShim(raw, namespace),
  };
}

/**
 * Read-shim for the multi-registry slot.
 *
 * - If the row has an explicit `registries` object, return it (with the
 *   remote-slot secret-field normalization applied — see below).
 * - Otherwise, if the legacy top-level token + registryUrl are populated,
 *   derive a single slot (local for loopback URLs, remote for everything
 *   else). Returns `undefined` when nothing is configured.
 *
 * Remote-slot secret-field normalization:
 *   When the persisted `registries.remote` slot carries any legacy secret
 *   fields (`tokenCiphertext`, `tokenIv`, `tokenAlgo`), the slot is degraded
 *   on read to `{ url, namespace, status: "not_connected" }`. The legacy
 *   plaintext-cipher fields never leave this function. The operator must
 *   re-request via the polling flow.
 *
 *   The `local` slot is unaffected — it still uses the paste-token shape.
 */
function deriveRegistriesShim(
  raw: Record<string, unknown>,
  instanceNamespace: string,
): InstanceIdentity["registries"] {
  const explicit = raw.registries as
    | { local?: unknown; remote?: unknown }
    | undefined;
  if (explicit && typeof explicit === "object") {
    const local = (explicit.local ?? undefined) as RegistryConnection | undefined;
    const rawRemote = (explicit.remote ?? undefined) as
      | (RemoteRegistryConnection & {
          tokenCiphertext?: unknown;
          tokenIv?: unknown;
          tokenAlgo?: unknown;
        })
      | undefined;

    let remote: RemoteRegistryConnection | undefined;
    if (rawRemote && typeof rawRemote === "object") {
      const hasLegacySecret =
        rawRemote.tokenCiphertext !== undefined ||
        rawRemote.tokenIv !== undefined ||
        rawRemote.tokenAlgo !== undefined;
      if (hasLegacySecret) {
        // Drop legacy secret fields and reset status to not_connected. The
        // operator must re-request via the polling flow.
        remote = {
          url: rawRemote.url,
          namespace: rawRemote.namespace ?? instanceNamespace,
          status: "not_connected",
        };
      } else {
        // New shape — pass through, but ensure namespace is mirrored from the
        // identity row when the persisted slot omits it (defensive default).
        remote = {
          ...rawRemote,
          namespace: rawRemote.namespace ?? instanceNamespace,
          tokenCiphertext: undefined,
          tokenIv: undefined,
          tokenAlgo: undefined,
        } as RemoteRegistryConnection;
        // Strip the (now-undefined) legacy keys so the returned object is
        // structurally clean.
        delete (remote as Record<string, unknown>).tokenCiphertext;
        delete (remote as Record<string, unknown>).tokenIv;
        delete (remote as Record<string, unknown>).tokenAlgo;
      }
    }

    const result: InstanceIdentity["registries"] = {};
    if (local !== undefined) result.local = local;
    if (remote !== undefined) result.remote = remote;
    return result;
  }

  const tokenCiphertext = raw.tokenCiphertext as string | undefined;
  const tokenIv = raw.tokenIv as string | undefined;
  const registryUrl = (raw.registryUrl as string | undefined)?.trim();

  if (!tokenCiphertext || !tokenIv || !registryUrl) return undefined;

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(
    registryUrl,
  );

  if (isLocal) {
    const localSlot: RegistryConnection = {
      url: registryUrl,
      tokenCiphertext,
      tokenIv,
      tokenAlgo: "aes-256-gcm",
      tokenUpdatedAt: (raw.tokenUpdatedAt as string | null | undefined) ?? null,
    };
    return { local: localSlot };
  }

  // Legacy top-level remote: plaintext-cipher remote tokens must not flow
  // forward. Degrade to not_connected and let the operator re-request via the
  // polling flow.
  const remote: RemoteRegistryConnection = {
    url: registryUrl,
    namespace: instanceNamespace,
    status: "not_connected",
  };
  return { remote };
}

/**
 * Persist the full instance identity payload to the `cinatra.metadata` row
 * keyed "instance_identity", then invalidate the in-process cache so the next
 * `readInstanceIdentity()` re-reads from the DB.
 *
 * Always writes current keys (instanceNamespace, instanceDisplayName,
 * oldInstanceNamespaces). After a write, the row is persisted away from the
 * legacy vendorName shape.
 *
 * Namespace-freeze invariant. Once `firstPublishedAt` is set the
 * `instanceNamespace` field becomes immutable. Callers that legitimately need
 * to rename a frozen namespace (e.g. `renameInstanceNamespaceAction`) MUST
 * pass `{ allowNamespaceRename: true }` and are then responsible for the
 * validation required before rename (orphaning old packages, appending to
 * `oldInstanceNamespaces`, resetting `firstPublishedAt`, etc.). Same-namespace
 * writes — display-name edits, registry slot updates, `firstPublishedAt`
 * flips, `oldInstanceNamespaces` append — are always allowed.
 *
 * The cache invalidation call lives in the separate `@/lib/instance-identity-cache`
 * module so tests can spy on it.
 */
export function writeInstanceIdentity(
  identity: InstanceIdentity,
  options?: { allowNamespaceRename?: boolean; allowMissingDurableFields?: boolean },
): void {
  // Re-read the persisted row once. We need it for the namespace-freeze check
  // AND for durable-field preservation; doing one combined read avoids a
  // double round-trip.
  const current = readInstanceIdentity();
  if (!options?.allowNamespaceRename) {
    if (
      current &&
      current.firstPublishedAt !== null &&
      current.instanceNamespace !== identity.instanceNamespace
    ) {
      throw new Error(
        `Instance namespace is frozen (firstPublishedAt = ${current.firstPublishedAt}); ` +
          `cannot rename "${current.instanceNamespace}" → "${identity.instanceNamespace}" without { allowNamespaceRename: true }.`,
      );
    }
  }

  // Durable-field preservation. A caller that spread a pre-ensureInstanceId
  // snapshot and then writes back AFTER ensureInstanceId populated the durable
  // fields would otherwise clobber them. Merge in any durable field present in
  // the persisted row but missing from the caller's input. The escape hatch
  // `allowMissingDurableFields` is for fixtures that intentionally exercise
  // pre-consumer-split row shapes.
  const merged: InstanceIdentity = { ...identity };
  let clobberDetected = false;
  // Preservation ALWAYS runs when a persisted row exists; the
  // `allowMissingDurableFields` option only suppresses the warn, NEVER the
  // merge — escaping the merge would let fixtures intentionally clobber
  // instanceId / attach-secret, which is the exact failure mode this guard
  // prevents.
  if (current) {
    for (const field of DURABLE_FIELD_NAMES) {
      const incoming = (merged as Record<string, unknown>)[field];
      const persisted = (current as Record<string, unknown>)[field];
      if (incoming === undefined && persisted !== undefined) {
        (merged as Record<string, unknown>)[field] = persisted;
        clobberDetected = true;
      }
    }
    if (clobberDetected && !options?.allowMissingDurableFields) {
      // Operator-visible warning: a caller spread a stale snapshot. The merge
      // auto-corrects, but the call site should re-read identity inside its
      // own write-lock to avoid the warning entirely.
      console.warn(
        "[writeInstanceIdentity] preserved durable instance-identity fields " +
          "from the persisted row — caller likely spread a pre-boot-hook " +
          "snapshot. Auto-corrected; consider re-reading identity inside the " +
          "caller's write-lock.",
      );
    }
  }

  writeMetadataValueToDatabase(METADATA_KEY, merged);
  invalidateInstanceIdentityCache();
}

/**
 * Freeze-on-publish primitive. Call this with the package name we just
 * successfully published. If the package lives under the current instance
 * namespace AND `firstPublishedAt` is still null, flip it to `now()`. No-op
 * when already frozen or when the published package belongs to a different
 * scope (e.g. re-publishing a shipped `@cinatra/...` agent on a non-cinatra
 * instance).
 *
 * Idempotent. Never resets `firstPublishedAt` to null. Safe to call from
 * either publish path (agent_source_publish or agent_registry_publish).
 */
export function markFirstPublishedIfCurrentScope(publishedPackageName: string): void {
  if (typeof publishedPackageName !== "string" || publishedPackageName.length === 0) return;
  let identity: InstanceIdentity | null = null;
  try {
    identity = readInstanceIdentity();
  } catch {
    return;
  }
  if (!identity) return;
  if (identity.firstPublishedAt !== null) return;
  const expectedScope = `@${identity.instanceNamespace}/`;
  if (!publishedPackageName.startsWith(expectedScope)) return;
  // Go through writeInstanceIdentity so the namespace-freeze invariant is
  // enforced at a single boundary. This call is namespace-preserving (only
  // firstPublishedAt flips), so the invariant passes without an override.
  writeInstanceIdentity({
    ...identity,
    firstPublishedAt: new Date().toISOString(),
  });
}

// -----------------------------------------------------------------------------
// instanceId + instanceAttachSecret boot-time backfill.
// -----------------------------------------------------------------------------

/**
 * Narrowed type that asserts the post-ensureInstanceId presence of
 * `instanceId` + the three attach-secret fields. Returned by
 * {@link readInstanceIdentityRequiringInstanceId} and
 * {@link ensureInstanceId}; consumed by the marketplace `instance_attach_self`
 * call sites, the credential resolver, and the namespace-rename gate.
 */
export type EnsuredInstanceIdentity = InstanceIdentity & {
  instanceId: string;
  instanceAttachSecretCiphertext: string;
  instanceAttachSecretIv: string;
  instanceAttachSecretAlgo: "aes-256-gcm";
};

function isEnsuredInstanceIdentity(
  identity: InstanceIdentity,
): identity is EnsuredInstanceIdentity {
  return (
    typeof identity.instanceId === "string" &&
    UUID_V4_REGEX.test(identity.instanceId) &&
    typeof identity.instanceAttachSecretCiphertext === "string" &&
    identity.instanceAttachSecretCiphertext.length > 0 &&
    typeof identity.instanceAttachSecretIv === "string" &&
    identity.instanceAttachSecretIv.length > 0 &&
    identity.instanceAttachSecretAlgo === "aes-256-gcm"
  );
}

/**
 * Hard-validating narrowed reader. Returns null when no identity row exists.
 * Throws when the row exists but `instanceId` / attach-secret fields are
 * absent (call ensureInstanceId() first) OR corrupted (operator must repair).
 *
 * Corruption is treated as a hard error, not an auto-repair signal, so the
 * operator notices.
 */
export function readInstanceIdentityRequiringInstanceId(): EnsuredInstanceIdentity | null {
  const identity = readInstanceIdentity();
  if (!identity) return null;
  if (isEnsuredInstanceIdentity(identity)) return identity;

  // Distinguish "missing" from "corrupt" for diagnostic clarity.
  const hasInstanceId = typeof identity.instanceId === "string" && identity.instanceId.length > 0;
  const hasSecretParts =
    typeof identity.instanceAttachSecretCiphertext === "string" &&
    typeof identity.instanceAttachSecretIv === "string";

  if (!hasInstanceId || !hasSecretParts) {
    throw new Error(
      "Instance identity is missing instanceId and/or instanceAttachSecret. " +
        "Call ensureInstanceId() during boot before any consumer attach call site reads identity.",
    );
  }

  // Both present but failed the narrow check — corrupted/legacy shape.
  if (typeof identity.instanceId === "string" && !UUID_V4_REGEX.test(identity.instanceId)) {
    throw new Error(
      "Instance identity contains a non-UUIDv4 instanceId. Refusing to silently overwrite. " +
        "Operator must inspect the cinatra.metadata row 'instance_identity' and repair manually.",
    );
  }
  if (identity.instanceAttachSecretAlgo !== "aes-256-gcm") {
    throw new Error(
      "Instance identity contains an unrecognised instanceAttachSecretAlgo. " +
        "Refusing to silently overwrite. Operator must inspect the cinatra.metadata row " +
        "'instance_identity' and repair manually.",
    );
  }
  // Fallback (shouldn't reach): some other corruption.
  throw new Error(
    "Instance identity failed EnsuredInstanceIdentity validation for an unknown reason.",
  );
}

/**
 * Decrypt the persisted instance-attach proof-of-ownership secret.
 *
 * Plaintext MUST be passed to the marketplace `instance_attach_self` ability
 * inline with the call; it is never logged and never returned to UI code.
 *
 * @throws when the persisted secret is missing OR when the ciphertext / AAD
 *   has been tampered with (GCM auth-tag failure).
 */
export function decryptInstanceAttachSecret(identity: InstanceIdentity): string {
  if (
    !identity.instanceAttachSecretCiphertext ||
    !identity.instanceAttachSecretIv ||
    identity.instanceAttachSecretAlgo !== "aes-256-gcm"
  ) {
    throw new Error(
      "instanceAttachSecret is not populated. Call ensureInstanceId() during boot first.",
    );
  }
  return decryptSecret(
    {
      ciphertext: identity.instanceAttachSecretCiphertext,
      iv: identity.instanceAttachSecretIv,
    },
    INSTANCE_ATTACH_SECRET_AAD,
  );
}

/**
 * Helper for setup-wizard call sites — produce the new-row durable fields
 * inline so first-time identity writes (mode a/b/c in
 * `src/app/setup/name/actions.ts`) persist instanceId + the encrypted attach
 * secret in the SAME row write. Boot-time ensureInstanceId() then becomes
 * a no-op for any fresh install.
 */
export function buildFreshInstanceIdentityDurableFields(): {
  instanceId: string;
  instanceAttachSecretCiphertext: string;
  instanceAttachSecretIv: string;
  instanceAttachSecretAlgo: "aes-256-gcm";
} {
  const instanceId = randomUUID();
  const plaintext = randomBytes(32).toString("base64url");
  const enc = encryptSecret(plaintext, INSTANCE_ATTACH_SECRET_AAD);
  return {
    instanceId,
    instanceAttachSecretCiphertext: enc.ciphertext,
    instanceAttachSecretIv: enc.iv,
    instanceAttachSecretAlgo: "aes-256-gcm",
  };
}

/**
 * Boot-time backfill. Idempotent; cross-process safe via SQL-level CAS gates
 * on the persisted `instance_identity` metadata row.
 *
 * Behavior:
 * - Returns null when no identity row exists yet (fresh install pre-setup).
 *   The setup wizard will populate durable fields inline on its first write.
 * - When the row exists and both durable fields are present + valid →
 *   returns the existing EnsuredInstanceIdentity (no DB write).
 * - When either field is missing → conditionally adds the missing field-group
 *   via JSONB CAS UPDATE (`WHERE NOT (value::jsonb ? '<field>')`). A
 *   concurrent process that already won the race leaves the gate failing;
 *   we re-read and surface the canonical value.
 * - Existing-but-invalid (corrupted) fields cause
 *   {@link readInstanceIdentityRequiringInstanceId} to throw on the final
 *   re-read — operator-visible incident, no silent rotation.
 *
 * The in-process `withInstanceIdentityWriteLock` mutex prevents same-process
 * duplicate encryption work; the SQL CAS gate is the cross-process truth.
 *
 * SQL identifiers use {@link quotePostgresIdentifier} so the configured
 * `postgresSchema` (e.g. `cinatra` or per-worktree `cinatra_worktree_*`)
 * is interpolated safely.
 */
export async function ensureInstanceId(): Promise<EnsuredInstanceIdentity | null> {
  return withInstanceIdentityWriteLock(async () => {
    const before = readInstanceIdentity();
    if (!before) return null;
    if (isEnsuredInstanceIdentity(before)) return before;

    const needsInstanceId = before.instanceId === undefined;
    const needsAttachSecret =
      before.instanceAttachSecretCiphertext === undefined ||
      before.instanceAttachSecretIv === undefined ||
      before.instanceAttachSecretAlgo !== "aes-256-gcm";

    const nextInstanceId = needsInstanceId ? randomUUID() : (before.instanceId as string);
    let nextSecretCiphertext = before.instanceAttachSecretCiphertext;
    let nextSecretIv = before.instanceAttachSecretIv;
    let nextSecretAlgo: "aes-256-gcm" | undefined = before.instanceAttachSecretAlgo;
    if (needsAttachSecret) {
      const plaintext = randomBytes(32).toString("base64url");
      const enc = encryptSecret(plaintext, INSTANCE_ATTACH_SECRET_AAD);
      nextSecretCiphertext = enc.ciphertext;
      nextSecretIv = enc.iv;
      nextSecretAlgo = "aes-256-gcm";
    }

    const schema = quotePostgresIdentifier(postgresSchema);
    const queries: Array<{ text: string; values: unknown[] }> = [];
    if (needsInstanceId) {
      queries.push({
        text: `
          UPDATE ${schema}.metadata
          SET value = (
            jsonb_set(value::jsonb, '{instanceId}', to_jsonb($1::text), true)
          )::text
          WHERE key = $2 AND NOT (value::jsonb ? 'instanceId')
        `,
        values: [nextInstanceId, METADATA_KEY],
      });
    }
    if (needsAttachSecret) {
      queries.push({
        text: `
          UPDATE ${schema}.metadata
          SET value = (
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  value::jsonb,
                  '{instanceAttachSecretCiphertext}',
                  to_jsonb($1::text),
                  true
                ),
                '{instanceAttachSecretIv}',
                to_jsonb($2::text),
                true
              ),
              '{instanceAttachSecretAlgo}',
              to_jsonb($3::text),
              true
            )
          )::text
          WHERE key = $4 AND NOT (value::jsonb ? 'instanceAttachSecretCiphertext')
        `,
        values: [
          nextSecretCiphertext as string,
          nextSecretIv as string,
          nextSecretAlgo as string,
          METADATA_KEY,
        ],
      });
    }

    if (queries.length > 0) {
      runPostgresQueriesSync({
        connectionString: getPostgresConnectionString(),
        transaction: true,
        queries,
      });
      invalidateInstanceIdentityCache();
    }

    // Re-read post-CAS. If another process won the race on one of the fields
    // we'll see the canonical value here.
    return readInstanceIdentityRequiringInstanceId();
  });
}
