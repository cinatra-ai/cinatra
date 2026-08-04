// -----------------------------------------------------------------------------
// Pending-provision credential stash for namespace-changing provisioning
// writes (`provisionAndPersist` in src/app/configuration/instance/actions.ts).
//
// Why this exists: in self-registration mode the action mints a Verdaccio npm
// user (`createNpmUser`) for the NEW namespace BEFORE the identity-row CAS
// write. When that CAS write does not land (outcome != "swapped"), the minted
// token/password were previously discarded with the request — and the
// operator's retry called `createNpmUser` again for the SAME namespace, which
// Verdaccio answers with 409 (VerdaccioUserAlreadyRegisteredError), misreported
// as "namespace-taken". A transient write conflict thereby became a permanent
// dead end for that namespace.
//
// The stash closes that gap: the ENCRYPTED minted credentials are persisted
// under a separate metadata key immediately after the mint, keyed by the
// target namespace. A retry targeting the same namespace reuses the stashed
// ciphertexts and skips the duplicate `createNpmUser` call; a successful CAS
// commit clears the stash.
//
// Encryption discipline: this module stores ONLY ciphertext/iv pairs produced
// by `encryptSecret` under the same per-field AADs the identity row itself
// uses ("vendor.token" / "vendor.password") — the exact values the eventual
// identity write persists. Plaintext never touches this module.
//
// Single-slot by design: `provisionAndPersist` serialises per instance (one
// identity row), so at most one provisioning attempt's credentials are ever
// pending. A mint for a DIFFERENT namespace simply overwrites the slot.
//
// Same metadata KV mechanism as `instance-identity-store.ts`; no schema
// migration. Lives in its own module (not the identity store) so existing
// `vi.mock("@/lib/instance-identity-store", ...)` factories are unaffected.
// -----------------------------------------------------------------------------

import {
  readMetadataValueFromDatabase,
  writeMetadataValueToDatabase,
} from "@/lib/database";

const METADATA_KEY = "instance_identity_pending_provision";

/** Encrypted minted registry credentials awaiting a landed identity write. */
export type PendingProvisionedCredentials = {
  /** The target namespace `createNpmUser` was called for. */
  instanceNamespace: string;
  tokenCiphertext: string;
  tokenIv: string;
  tokenAlgo: "aes-256-gcm";
  passwordCiphertext: string;
  passwordIv: string;
  /** ISO timestamp of the mint, for operator diagnostics. */
  mintedAt: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Read the stashed credentials for `instanceNamespace`, or null when no stash
 * exists, the stash targets a different namespace (the operator retried with
 * a new name — the stale mint is superseded), or the stored shape is not
 * usable (fail towards a fresh mint rather than a broken write).
 */
export function readPendingProvisionedCredentials(
  instanceNamespace: string,
): PendingProvisionedCredentials | null {
  const raw = readMetadataValueFromDatabase<Record<string, unknown> | null>(
    METADATA_KEY,
    null,
  );
  if (!raw || typeof raw !== "object") return null;
  if (raw.instanceNamespace !== instanceNamespace) return null;
  if (
    !isNonEmptyString(raw.tokenCiphertext) ||
    !isNonEmptyString(raw.tokenIv) ||
    raw.tokenAlgo !== "aes-256-gcm" ||
    !isNonEmptyString(raw.passwordCiphertext) ||
    !isNonEmptyString(raw.passwordIv)
  ) {
    return null;
  }
  return raw as PendingProvisionedCredentials;
}

/** Persist the stash. Overwrites any previous slot (single-slot by design). */
export function writePendingProvisionedCredentials(
  record: PendingProvisionedCredentials,
): void {
  writeMetadataValueToDatabase(METADATA_KEY, record);
}

/** Clear the stash after the identity write landed ("swapped"). */
export function clearPendingProvisionedCredentials(): void {
  writeMetadataValueToDatabase(METADATA_KEY, null);
}
