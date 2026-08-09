// -----------------------------------------------------------------------------
// At-rest hardening for the `openai_connection` metadata row (cinatra#2581).
//
// TWO platform-side defects are closed here. Both are pure transforms/policy so
// this module stays a DEPENDENCY-FREE LEAF (crypto + the shared sealed-shape
// guard only) and is unit-testable directly — `@/lib/database` is an ASYNC
// module (its graph reaches `import()`-loaded externals via drizzle-store → pg)
// and can never be imported from a unit test, exactly as
// `connector-config-secret-fields` documents.
//
//  1. SECRET AT REST — `openai_connection.apiKey` was persisted as PLAINTEXT in
//     `cinatra.metadata`. It is now SEALED with the repo's canonical AES-256-GCM
//     codec (`@/lib/instance-secrets`, keyed by `CINATRA_ENCRYPTION_KEY`), in the
//     same `{ __enc: 1, ciphertext, iv }` shape and under the same field-scoped
//     AAD discipline as the connector-config seal
//     (`@/lib/connector-config-secret-fields`). The AAD is
//     `openai_connection.apiKey`, so a sealed blob lifted from another row or
//     field cannot decrypt here — `decipher.final()` raises and the field is
//     dropped fail-closed.
//
//  2. BODY-LOGGING DEFAULT — the platform hard-coded `loggingEnabled: true`
//     whenever the stored operator preference was UNSET.
//     `@cinatra-ai/openai-connector` resolves body logging as
//     `explicitPreference ?? developmentMode` (its `logging-policy.ts`: "full LLM
//     request/response bodies must NOT be written to disk by default in
//     production"), so the platform's `?? true` DESTROYED the unset signal and
//     forced prompt/completion bodies onto local disk in production. The
//     platform default now mirrors that connector policy exactly, and the unset
//     preference is PRESERVED at rest instead of being frozen to a boolean by
//     unrelated saves.
//
// MIGRATION — no migration file, and none is needed: the same metadata KV column
// stores the JSON either way. A legacy PLAINTEXT row still READS unchanged
// (read-both) and is UPGRADED to a sealed row by the next write of that row
// (upgrade-on-write), plus a best-effort compare-and-swap seal-on-read in
// `@/lib/openai-connection-store`.
//
// KEY ROTATION — rotating `CINATRA_ENCRYPTION_KEY` invalidates previously sealed
// `apiKey` blobs: the GCM auth tag fails, the field is dropped fail-closed, and
// OpenAI reads back unconfigured. Recovery = re-enter the key in
// /configuration/llm (same posture as the Nango `secretKey` seal).
//
// SECRETS: nothing in this module ever logs, returns, or serializes a key VALUE
// outside the caller's own plaintext round-trip — warnings carry the row/field
// and the error CLASS only.
// -----------------------------------------------------------------------------

import { isSealed, type SealedSecretField } from "@/lib/connector-config-secret-fields";
import { decryptSecret, encryptSecret } from "@/lib/instance-secrets";

// -----------------------------------------------------------------------------
// Row identity
// -----------------------------------------------------------------------------

/** The single `cinatra.metadata` key this module guards. */
export const OPENAI_CONNECTION_METADATA_KEY = "openai_connection";

/** The ONLY field of that row that is ever encrypted at rest. */
export const OPENAI_CONNECTION_SECRET_FIELD = "apiKey";

/**
 * Field-scoped AAD binding a sealed blob to this row + field, so a sealed blob
 * moved here from a different row/field fails its auth tag on read.
 */
const SECRET_AAD = `${OPENAI_CONNECTION_METADATA_KEY}.${OPENAI_CONNECTION_SECRET_FIELD}`;

/**
 * The RAW at-rest shape of the row. `apiKey` is a sealed object on a
 * post-cinatra#2581 row and a plaintext string on a legacy row; every other
 * field is persisted verbatim.
 */
export type StoredOpenAIConnectionRow = {
  apiKey?: string | SealedSecretField;
  projectId?: string;
  organizationId?: string;
  defaultModel?: string;
  serviceTier?: string;
  loggingEnabled?: boolean;
  promptCachingEnabled?: boolean;
  lastValidatedAt?: string;
  availableModels?: string[];
};

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Reduce a sealed-shaped object to EXACTLY `{ __enc, ciphertext, iv }`.
 *
 * A sealed-shaped value may carry extra enumerable properties (e.g. an
 * externally-crafted `{ __enc:1, ciphertext, iv, plaintext: "<key>" }`);
 * preserving such an object verbatim would persist that sidecar plaintext. We
 * canonicalize at every point a sealed value is preserved at rest, so only the
 * ciphertext survives. Callers MUST have verified {@link isSealed} first.
 */
function canonicalSealed(value: SealedSecretField): SealedSecretField {
  return { __enc: 1, ciphertext: value.ciphertext, iv: value.iv };
}

// -----------------------------------------------------------------------------
// Body-logging default policy
// -----------------------------------------------------------------------------

/**
 * Resolve whether OpenAI request/response BODIES (prompts + completions) may be
 * written to the local server log.
 *
 * This is the platform-side mirror of `@cinatra-ai/openai-connector`'s
 * `resolveLoggingEnabled`: an explicit stored operator preference always wins;
 * when UNSET the default follows the runtime mode — ON in development (local
 * debugging), OFF in production. Before cinatra#2581 the platform substituted a
 * hard `true` here, which is what put prompt/completion bodies on disk by
 * default on every production instance.
 *
 * @param explicitPreference the STORED `loggingEnabled` value (`undefined` when
 *   the operator has never chosen).
 * @param developmentMode whether this instance runs in app-development mode.
 */
export function resolveOpenAIBodyLoggingDefault(
  explicitPreference: boolean | undefined,
  developmentMode: boolean,
): boolean {
  return explicitPreference ?? developmentMode;
}

// -----------------------------------------------------------------------------
// sealOpenAIConnectionSecrets — encrypt-on-write transform
// -----------------------------------------------------------------------------

/**
 * Return a clone of `value` with `apiKey` sealed at rest.
 *
 *   - Non-empty plaintext string → replaced with the sealed object.
 *   - Already-sealed object → CANONICALIZED and preserved (idempotent; never
 *     double-sealed, and any sidecar property is stripped).
 *   - Empty string / null / undefined / missing → left as-is (nothing to seal).
 *   - Any other value (a non-sealed object, a number, …) → the field is DROPPED
 *     with a redacted warning. Blindly encrypting a non-plaintext value could
 *     seal a corrupted or partial blob; dropping fail-closed is strictly better.
 *
 * @throws when `CINATRA_ENCRYPTION_KEY` is missing/invalid AND a plaintext key
 *   needs sealing. Propagated deliberately so the write FAILS CLOSED and never
 *   persists the plaintext. `CINATRA_ENCRYPTION_KEY` is a required-env preflight
 *   variable (auto-generated in dev), so a booted instance always has it.
 */
export function sealOpenAIConnectionSecrets(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  if (!(OPENAI_CONNECTION_SECRET_FIELD in record)) return value;

  const out: Record<string, unknown> = { ...record };
  const fieldValue = out[OPENAI_CONNECTION_SECRET_FIELD];

  if (isSealed(fieldValue)) {
    out[OPENAI_CONNECTION_SECRET_FIELD] = canonicalSealed(fieldValue);
    return out;
  }

  if (typeof fieldValue === "string") {
    if (fieldValue.length === 0) {
      // Blank is not a secret — the preserve-on-blank merge is handled by
      // `prepareSealedOpenAIConnectionWrite`, not here.
      return out;
    }
    const { ciphertext, iv } = encryptSecret(fieldValue, SECRET_AAD);
    out[OPENAI_CONNECTION_SECRET_FIELD] = { __enc: 1, ciphertext, iv } satisfies SealedSecretField;
    return out;
  }

  if (fieldValue === undefined || fieldValue === null) {
    return out;
  }

  delete out[OPENAI_CONNECTION_SECRET_FIELD];
  console.warn(
    `[openai-connection-secret] dropping malformed secret field at write: ` +
      `key=${OPENAI_CONNECTION_METADATA_KEY} field=${OPENAI_CONNECTION_SECRET_FIELD} ` +
      `type=${Array.isArray(fieldValue) ? "array" : typeof fieldValue} (not a plaintext string or sealed object)`,
  );
  return out;
}

// -----------------------------------------------------------------------------
// prepareSealedOpenAIConnectionWrite — the full at-rest write transform
// -----------------------------------------------------------------------------

/**
 * Compute the value to PERSIST for an `openai_connection` write: preserve the
 * existing sealed key when this write carries none, then seal.
 *
 * The preserve step operates on the RAW at-rest row so an existing sealed blob
 * is carried over VERBATIM — never decrypted and never re-sealed (a needless
 * re-encrypt would churn the ciphertext on every unrelated settings save).
 *
 * Preserve-on-absent is what keeps an unrelated settings save (a logging or
 * prompt-caching toggle) from destroying a stored key that this process could
 * not decrypt — e.g. after a `CINATRA_ENCRYPTION_KEY` rotation, where the read
 * path drops the field fail-closed. A write that MEANS to clear the key must
 * say so with `preserveExistingSecret: false`.
 *
 * @param incoming   the value the store wants to persist (plaintext `apiKey`).
 * @param currentRaw the RAW at-rest row (sealed blob verbatim), or null.
 * @param options    `preserveExistingSecret` (default true) — set false for an
 *                   explicit disconnect/factory-reset so the stored key is
 *                   actually dropped instead of carried forward.
 * @throws fail-closed when a plaintext key needs sealing but the encryption key
 *   is missing/invalid — the caller must NOT persist on throw.
 */
export function prepareSealedOpenAIConnectionWrite(
  incoming: unknown,
  currentRaw: unknown,
  options?: { preserveExistingSecret?: boolean },
): unknown {
  if (options?.preserveExistingSecret === false) {
    return sealOpenAIConnectionSecrets(dropSecret(incoming));
  }
  return sealOpenAIConnectionSecrets(mergePreservedSecret(incoming, currentRaw));
}

/** Strip the secret field entirely so an explicit clear cannot be undone by preserve. */
function dropSecret(incoming: unknown): unknown {
  const record = asRecord(incoming);
  if (!record) return incoming;
  const out = { ...record };
  delete out[OPENAI_CONNECTION_SECRET_FIELD];
  return out;
}

function mergePreservedSecret(incoming: unknown, currentRaw: unknown): unknown {
  const record = asRecord(incoming);
  if (!record) return incoming;
  const currentRecord = asRecord(currentRaw);
  if (!currentRecord) return incoming;

  const incomingField = record[OPENAI_CONNECTION_SECRET_FIELD];
  const hasIncomingPlaintext =
    typeof incomingField === "string" && incomingField.length > 0;
  const hasIncomingSealed = isSealed(incomingField);
  // Only fall back to the stored key when this write provides neither a new
  // plaintext nor an explicit sealed value.
  if (hasIncomingPlaintext || hasIncomingSealed) return record;

  const currentField = currentRecord[OPENAI_CONNECTION_SECRET_FIELD];
  if (isSealed(currentField)) {
    return { ...record, [OPENAI_CONNECTION_SECRET_FIELD]: canonicalSealed(currentField) };
  }
  // A LEGACY plaintext row must be carried forward too, not dropped: an
  // unrelated settings save on a not-yet-migrated instance would otherwise
  // DELETE the operator's key. Carrying it here also makes that save the
  // upgrade-on-write — `sealOpenAIConnectionSecrets` seals it on the way out.
  if (typeof currentField === "string" && currentField.length > 0) {
    return { ...record, [OPENAI_CONNECTION_SECRET_FIELD]: currentField };
  }
  return record;
}

// -----------------------------------------------------------------------------
// unsealOpenAIConnectionSecrets — decrypt-on-read transform
// -----------------------------------------------------------------------------

export interface OpenAIConnectionUnsealResult {
  /** The row with `apiKey` decrypted to plaintext (fail-closed field removed). */
  value: unknown;
  /** The row held a LEGACY plaintext key — an upgrade-on-write candidate. */
  sawLegacyPlaintext: boolean;
  /** A sealed key failed to decrypt and was dropped fail-closed. */
  decryptFailed: boolean;
}

/**
 * Return a clone of `value` with `apiKey` decrypted.
 *
 *   - Sealed object → decrypted to the plaintext string. On decrypt FAILURE
 *     (tamper, AAD mismatch, rotated key) the field is REMOVED fail-closed and a
 *     REDACTED warning is logged — row/field + error class only, never the
 *     plaintext, ciphertext or IV. `decryptFailed` is set.
 *   - Legacy plaintext string → returned unchanged (read-both compat) and
 *     `sawLegacyPlaintext` is set so the caller can upgrade the row.
 *   - Empty / null / undefined / missing → left as-is.
 *   - Any other malformed value → removed fail-closed + redacted warning.
 */
export function unsealOpenAIConnectionSecrets(value: unknown): OpenAIConnectionUnsealResult {
  const record = asRecord(value);
  if (!record) {
    return { value, sawLegacyPlaintext: false, decryptFailed: false };
  }
  if (!(OPENAI_CONNECTION_SECRET_FIELD in record)) {
    return { value: record, sawLegacyPlaintext: false, decryptFailed: false };
  }

  const out: Record<string, unknown> = { ...record };
  const fieldValue = out[OPENAI_CONNECTION_SECRET_FIELD];

  if (isSealed(fieldValue)) {
    try {
      out[OPENAI_CONNECTION_SECRET_FIELD] = decryptSecret(
        { ciphertext: fieldValue.ciphertext, iv: fieldValue.iv },
        SECRET_AAD,
      );
      return { value: out, sawLegacyPlaintext: false, decryptFailed: false };
    } catch (error) {
      delete out[OPENAI_CONNECTION_SECRET_FIELD];
      console.warn(
        `[openai-connection-secret] decrypt failed for the sealed key at read — ` +
          `field dropped fail-closed: key=${OPENAI_CONNECTION_METADATA_KEY} ` +
          `field=${OPENAI_CONNECTION_SECRET_FIELD} ` +
          `error=${error instanceof Error ? error.name : "unknown"}`,
      );
      return { value: out, sawLegacyPlaintext: false, decryptFailed: true };
    }
  }

  if (typeof fieldValue === "string") {
    // Legacy plaintext at rest — read-compat; flag for the lazy upgrade.
    return { value: out, sawLegacyPlaintext: fieldValue.length > 0, decryptFailed: false };
  }

  if (fieldValue === undefined || fieldValue === null) {
    return { value: out, sawLegacyPlaintext: false, decryptFailed: false };
  }

  delete out[OPENAI_CONNECTION_SECRET_FIELD];
  console.warn(
    `[openai-connection-secret] dropping malformed secret field at read: ` +
      `key=${OPENAI_CONNECTION_METADATA_KEY} field=${OPENAI_CONNECTION_SECRET_FIELD} ` +
      `type=${Array.isArray(fieldValue) ? "array" : typeof fieldValue}`,
  );
  return { value: out, sawLegacyPlaintext: false, decryptFailed: true };
}

/**
 * Read-side convenience: the plaintext `apiKey` of a raw at-rest row, or
 * `undefined` when absent/unreadable (fail-closed).
 */
export function readOpenAIApiKeyFromRow(rawRow: unknown): string | undefined {
  const { value } = unsealOpenAIConnectionSecrets(rawRow);
  const record = asRecord(value);
  const key = record?.[OPENAI_CONNECTION_SECRET_FIELD];
  return typeof key === "string" && key.length > 0 ? key : undefined;
}
