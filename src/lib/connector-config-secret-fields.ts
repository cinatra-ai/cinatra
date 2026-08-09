// -----------------------------------------------------------------------------
// Connector-config secret-field transform layer.
//
// WHAT THIS DOES
//   Encrypts designated secret fields of a connector-config payload AT REST so
//   the value persisted into the `connector_config:<id>` metadata row holds a
//   SEALED ciphertext object instead of the raw secret. The host DB helpers
//   (`writeConnectorConfigToDatabase` / `readConnectorConfigFromDatabase`) call
//   `sealSecretFields` on write and `unsealSecretFields` on read, so the
//   connector package (`@cinatra-ai/nango-connector`) and every other reader see
//   the plaintext value transparently and remain UNCHANGED.
//
// FIELD ALLOW-MAP
//   Only fields explicitly listed in `SECRET_CONFIG_FIELDS` are ever encrypted.
//   Today: `nango → ["secretKey"]`. Non-secret keys (and non-secret fields of a
//   secret-bearing key, e.g. nango `serverUrl`) are persisted verbatim.
//
// CRYPTO / AAD
//   Uses the existing AES-256-GCM codec (`encryptSecret`/`decryptSecret`) keyed
//   by `CINATRA_ENCRYPTION_KEY`. Each field is bound to a field-scoped AAD
//   (`connector_config:<connectorId>.<field>`) so a row-swap of a sealed blob to
//   a different connector/field cannot decrypt — `decipher.final()` raises and
//   the field is dropped (fail-closed).
//
// SEALED SHAPE
//   `{ __enc: 1, ciphertext: <base64>, iv: <base64> }`. The `__enc` discriminant
//   lets the read path tell a sealed object from a legacy plaintext string or an
//   unrelated structured value.
//
// MIGRATION / ROTATION
//   - Existing PLAINTEXT secret rows are migrated LAZILY: a read that observes a
//     legacy plaintext secret returns it unchanged (read-compat) and signals
//     `sawLegacyPlaintext` so the DB layer can best-effort re-seal the row in a
//     guarded re-write. No DDL / data-migration file is required — the same
//     metadata KV column stores the JSON either way.
//   - A ROTATION of `CINATRA_ENCRYPTION_KEY` invalidates previously-sealed
//     `secretKey` blobs: decryption fails the auth tag, so the field is dropped
//     fail-closed (Nango reads back unconfigured). Recovery = re-enter the
//     secret via the setup wizard, or set the `NANGO_SECRET_KEY` env override
//     (the env override is applied by the connector AFTER this host read and is
//     never routed through the seal path, so it is unaffected by rotation).
// -----------------------------------------------------------------------------

import { encryptSecret, decryptSecret } from "@/lib/instance-secrets";

// -----------------------------------------------------------------------------
// Allow-map — the ONLY fields that are ever encrypted at rest.
// -----------------------------------------------------------------------------

const SECRET_CONFIG_FIELDS: Record<string, readonly string[]> = {
  nango: ["secretKey"],
};

/** True when the connectorId has any field designated as a secret. */
export function hasSecretFields(connectorId: string): boolean {
  const fields = SECRET_CONFIG_FIELDS[connectorId];
  return Array.isArray(fields) && fields.length > 0;
}

/** The designated secret field names for a connectorId (empty when none). */
export function secretFieldsFor(connectorId: string): readonly string[] {
  return SECRET_CONFIG_FIELDS[connectorId] ?? [];
}

/** Field-scoped AAD binding a sealed blob to its connector + field. */
function aadFor(connectorId: string, field: string): string {
  return `connector_config:${connectorId}.${field}`;
}

// -----------------------------------------------------------------------------
// Sealed-shape guard
// -----------------------------------------------------------------------------

/** The at-rest encrypted representation of a single secret field. */
export interface SealedSecretField {
  __enc: 1;
  ciphertext: string;
  iv: string;
}

/** Structural guard: a sealed-field object produced by {@link sealSecretFields}. */
export function isSealed(value: unknown): value is SealedSecretField {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SealedSecretField>;
  return (
    candidate.__enc === 1 &&
    typeof candidate.ciphertext === "string" &&
    typeof candidate.iv === "string"
  );
}

/**
 * Reduce a sealed-shaped object to EXACTLY the three canonical keys
 * (`__enc`, `ciphertext`, `iv`). A sealed-shaped value may carry extra
 * enumerable properties (e.g. an externally-crafted
 * `{ __enc:1, ciphertext, iv, plaintext: "<secret>" }`); preserving such an
 * object verbatim on seal/preserve would persist + cache that plaintext. We
 * therefore canonicalize at every point a sealed value is preserved at rest so
 * only the ciphertext object survives — the cryptographic value is unchanged
 * and any sidecar plaintext is stripped. Callers MUST have verified
 * {@link isSealed} first.
 */
function canonicalSealed(value: SealedSecretField): SealedSecretField {
  return { __enc: 1, ciphertext: value.ciphertext, iv: value.iv };
}

// -----------------------------------------------------------------------------
// Internal: a connector-config value is a plain object record. Anything that is
// not a (non-array) object has no fields to seal/unseal — passed through as-is.
// -----------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Return a clone of `value` reduced to the CACHE-SAFE at-rest form: every
 * designated secret field is either a CANONICAL sealed object
 * (`{__enc,ciphertext,iv}` — extras, incl. any sidecar plaintext, stripped) or
 * is DROPPED entirely. A designated secret field that is not sealed-shaped (a
 * legacy plaintext string, a malformed non-sealed object, a number, …) is
 * removed so the connector-config CACHE can never hold plaintext or a raw
 * malformed value for the TTL (MF#1).
 *
 * This is the guard applied to the at-rest VALUE before it is written into the
 * cache in the NON-legacy read branch. It is fail-closed-consistent with what
 * {@link unsealSecretFields} returns to the caller (which likewise drops a
 * non-decryptable secret field). The legacy-plaintext case is handled UPSTREAM
 * by a deferred-caching + seal-on-read migration and never reaches this helper,
 * so dropping a non-sealed designated field here is correct for the cache.
 *
 * It does NOT decrypt and is safe to run on a raw at-rest value. Non-secret
 * connectors and non-record values pass through unchanged.
 */
export function canonicalizeSealedFields(connectorId: string, value: unknown): unknown {
  const fields = SECRET_CONFIG_FIELDS[connectorId];
  if (!fields || fields.length === 0) return value;
  const record = asRecord(value);
  if (!record) return value;

  let mutated = false;
  const out: Record<string, unknown> = { ...record };
  for (const field of fields) {
    if (!(field in out)) continue;
    const fieldValue = out[field];
    if (isSealed(fieldValue)) {
      out[field] = canonicalSealed(fieldValue);
      mutated = true;
    } else if (fieldValue !== undefined) {
      // Not sealed-shaped (plaintext string, malformed object, number, …):
      // DROP it so neither plaintext nor a raw malformed value is ever cached.
      delete out[field];
      mutated = true;
    }
  }
  return mutated ? out : value;
}

// -----------------------------------------------------------------------------
// sealSecretFields — encrypt-on-write transform
// -----------------------------------------------------------------------------

/**
 * Return a clone of `value` with every designated secret field sealed at rest.
 *
 * Per field:
 *   - Non-empty plaintext string → replaced with the sealed object.
 *   - Already-sealed object → preserved unchanged (idempotent; never double-seal).
 *   - Empty string / undefined / missing → left as-is.
 *   - Any other value (malformed: an object that is not a sealed shape, a number,
 *     etc.) → the field is OMITTED and a redacted warning logged. We refuse to
 *     blindly encrypt a non-plaintext value (it might already be a partial or
 *     corrupted blob) — dropping fail-closed beats persisting a meaningless seal.
 *
 * @throws when `CINATRA_ENCRYPTION_KEY` is missing/invalid AND a plaintext secret
 *   needs sealing — propagated so the write fails closed (never persists the
 *   plaintext). Reads of unrelated keys never reach this path.
 */
export function sealSecretFields(connectorId: string, value: unknown): unknown {
  const fields = SECRET_CONFIG_FIELDS[connectorId];
  if (!fields || fields.length === 0) return value;

  const record = asRecord(value);
  if (!record) return value;

  const out: Record<string, unknown> = { ...record };

  for (const field of fields) {
    if (!(field in out)) continue;
    const fieldValue = out[field];

    if (isSealed(fieldValue)) {
      // Idempotent: already sealed at rest. CANONICALIZE to exactly
      // {__enc,ciphertext,iv} so a sealed-shaped value carrying extra
      // enumerable properties (e.g. an externally-crafted sidecar `plaintext`)
      // can never be persisted/cached verbatim. NOTE: `isSealed` is a SYNTACTIC
      // guard (shape only) — the CRYPTO validity of a sealed blob is
      // authenticated at READ time by `decryptSecret` (GCM auth tag + AAD). A
      // syntactically-sealed-but-cryptographically-bogus blob therefore
      // round-trips through write canonicalized and fails CLOSED on read (field
      // dropped). Any sealed blob this write path itself produced is always
      // crypto-valid, so the extra-property case is only reachable for an
      // externally-crafted value.
      out[field] = canonicalSealed(fieldValue);
      continue;
    }

    if (typeof fieldValue === "string") {
      if (fieldValue.length === 0) {
        // Empty plaintext is not a secret — leave as-is (preserve-on-blank is
        // handled by the DB layer merge, not here).
        continue;
      }
      const { ciphertext, iv } = encryptSecret(fieldValue, aadFor(connectorId, field));
      out[field] = { __enc: 1, ciphertext, iv } satisfies SealedSecretField;
      continue;
    }

    if (fieldValue === undefined || fieldValue === null) {
      // Nothing to seal.
      continue;
    }

    // Malformed: an object that is not a sealed shape, a number, etc. Refuse to
    // encrypt blindly — omit the field fail-closed with a redacted log.
    delete out[field];
    console.warn(
      `[connector-config-secret] dropping malformed secret field at write: ` +
        `key=connector_config:${connectorId} field=${field} ` +
        `type=${Array.isArray(fieldValue) ? "array" : typeof fieldValue} (not a plaintext string or sealed object)`,
    );
  }

  return out;
}

// -----------------------------------------------------------------------------
// prepareSealedWrite — the full at-rest write transform (merge + seal)
// -----------------------------------------------------------------------------

/**
 * Compute the value to PERSIST for a connector-config write, applying both the
 * preserve-on-blank-save merge (MF#3) and the encrypt-on-write seal (MF#1/#5).
 *
 * @param connectorId connector key being written.
 * @param incoming    the normalized incoming write value.
 * @param currentRaw  the RAW at-rest row (sealed blobs verbatim), or null when
 *                    there is no current row. Used only to fall back to an
 *                    existing sealed secret when the incoming write omits it.
 * @returns the value to persist (sealed at rest).
 * @throws fail-closed when a plaintext secret needs sealing but the encryption
 *   key is missing/invalid — the caller must NOT persist plaintext on throw.
 */
export function prepareSealedWrite(
  connectorId: string,
  incoming: unknown,
  currentRaw: unknown,
): unknown {
  if (!hasSecretFields(connectorId)) return incoming;
  const merged = mergePreservedSecretFields(connectorId, incoming, currentRaw);
  return sealSecretFields(connectorId, merged);
}

/**
 * Merge already-sealed secret fields from the raw at-rest row into `incoming`
 * when the incoming write provides no replacement plaintext/sealed value for
 * that field (MF#3). Operates on the RAW current row so the sealed blob is
 * preserved verbatim (never decrypted, never re-sealed).
 */
function mergePreservedSecretFields(
  connectorId: string,
  incoming: unknown,
  currentRaw: unknown,
): unknown {
  const record = asRecord(incoming);
  if (!record) return incoming;
  const currentRecord = asRecord(currentRaw);
  if (!currentRecord) return incoming;

  const out: Record<string, unknown> = { ...record };
  for (const field of secretFieldsFor(connectorId)) {
    const incomingField = out[field];
    const hasIncomingPlaintext =
      typeof incomingField === "string" && incomingField.length > 0;
    const hasIncomingSealed = isSealed(incomingField);
    // Only fall back to the existing sealed secret when the incoming write does
    // not itself provide a new plaintext or an explicit sealed value.
    const currentField = currentRecord[field];
    if (!hasIncomingPlaintext && !hasIncomingSealed && isSealed(currentField)) {
      // Canonicalize the preserved blob so a sealed-shaped at-rest row carrying
      // extra (potentially plaintext) properties is reduced to the ciphertext.
      out[field] = canonicalSealed(currentField);
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// unsealSecretFields — decrypt-on-read transform
// -----------------------------------------------------------------------------

export interface UnsealResult {
  /** The value with secret fields decrypted to plaintext (fail-closed fields removed). */
  value: unknown;
  /** A designated secret field held a legacy plaintext string (migration candidate). */
  sawLegacyPlaintext: boolean;
  /** A sealed field failed to decrypt and was dropped fail-closed. */
  decryptFailed: boolean;
}

/**
 * Return a clone of `value` with every designated secret field decrypted.
 *
 * Per field:
 *   - Sealed object → decrypted to plaintext string. On decrypt FAILURE the
 *     field is REMOVED (fail-closed) and a redacted warning logged (class +
 *     key/field only — never the plaintext or ciphertext). `decryptFailed` set.
 *   - Legacy plaintext string → left unchanged (read-compat). `sawLegacyPlaintext`
 *     set so the DB layer can lazily re-seal the row.
 *   - Empty / undefined / missing → left as-is.
 *   - Any other malformed value → removed fail-closed + redacted warning.
 */
export function unsealSecretFields(connectorId: string, value: unknown): UnsealResult {
  const fields = SECRET_CONFIG_FIELDS[connectorId];
  if (!fields || fields.length === 0) {
    return { value, sawLegacyPlaintext: false, decryptFailed: false };
  }

  const record = asRecord(value);
  if (!record) {
    return { value, sawLegacyPlaintext: false, decryptFailed: false };
  }

  const out: Record<string, unknown> = { ...record };
  let sawLegacyPlaintext = false;
  let decryptFailed = false;

  for (const field of fields) {
    if (!(field in out)) continue;
    const fieldValue = out[field];

    if (isSealed(fieldValue)) {
      try {
        out[field] = decryptSecret(
          { ciphertext: fieldValue.ciphertext, iv: fieldValue.iv },
          aadFor(connectorId, field),
        );
      } catch (error) {
        // Fail-closed: drop the field so the connector reads unconfigured.
        // Redacted log — class + location only, NO plaintext / ciphertext / iv.
        delete out[field];
        decryptFailed = true;
        console.warn(
          `[connector-config-secret] decrypt failed for sealed field at read — ` +
            `field dropped fail-closed: key=connector_config:${connectorId} field=${field} ` +
            `error=${error instanceof Error ? error.name : "unknown"}`,
        );
      }
      continue;
    }

    if (typeof fieldValue === "string") {
      if (fieldValue.length > 0) {
        // Legacy plaintext at rest — read-compat, flag for lazy migration.
        sawLegacyPlaintext = true;
      }
      continue;
    }

    if (fieldValue === undefined || fieldValue === null) {
      continue;
    }

    // Malformed at rest (neither sealed nor plaintext) — drop fail-closed.
    delete out[field];
    decryptFailed = true;
    console.warn(
      `[connector-config-secret] dropping malformed secret field at read: ` +
        `key=connector_config:${connectorId} field=${field} ` +
        `type=${Array.isArray(fieldValue) ? "array" : typeof fieldValue}`,
    );
  }

  return { value: out, sawLegacyPlaintext, decryptFailed };
}

// =============================================================================
// The `openai_connection` metadata row (cinatra#2581)
// =============================================================================
//
// The SAME at-rest discipline as the connector-config seal above, applied to the
// single-secret `openai_connection` row: identical AES-256-GCM codec, identical
// `{__enc,ciphertext,iv}` sealed shape, identical field-scoped AAD binding and
// identical fail-closed posture. It lives HERE, beside the shared `isSealed` /
// `canonicalSealed` / `asRecord` primitives it reuses, rather than in a module of
// its own: the locked dev-perf routes carry a route-graph ratchet, so a new
// first-party module on their reachable graph is a budget regression.
//
// The row differs from a connector-config row in two ways that keep it on its own
// functions rather than in `SECRET_CONFIG_FIELDS`: it is a plain metadata key
// (not `connector_config:<id>`), and it carries the body-logging policy below.
//
// TWO defects are closed here, both PLATFORM-side:
//
//  1. SECRET AT REST — `openai_connection.apiKey` was persisted as PLAINTEXT.
//
//  2. BODY-LOGGING DEFAULT — the platform hard-coded `loggingEnabled: true`
//     whenever the stored operator preference was UNSET.
//     `@cinatra-ai/openai-connector` resolves body logging as
//     `explicitPreference ?? developmentMode` (its `logging-policy.ts`: "full LLM
//     request/response bodies must NOT be written to disk by default in
//     production"), so the platform's `?? true` DESTROYED the unset signal and
//     forced prompt/completion bodies onto local disk in production. The platform
//     default now mirrors that connector policy exactly, and the unset preference
//     is PRESERVED at rest instead of being frozen by unrelated saves.
//
// MIGRATION — no migration file, and none is needed: the same metadata KV column
// stores the JSON either way. A legacy PLAINTEXT row still READS (read-both) and
// is UPGRADED by the next write of that row, plus a best-effort compare-and-swap
// seal-on-read in `@/lib/database-metadata`.
//
// KEY ROTATION — rotating `CINATRA_ENCRYPTION_KEY` invalidates previously sealed
// `apiKey` blobs: the GCM auth tag fails, the field is dropped fail-closed, and
// OpenAI reads back unconfigured. Recovery = re-enter the key in
// /configuration/llm (the same posture as the Nango `secretKey` seal).
//
// SECRETS: nothing below ever logs a key VALUE — warnings carry the row/field and
// the error CLASS only.

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

// ---------------------------------------------------------------------------
// The ONE at-rest accessor for the `openai_connection` metadata row (cinatra#2581).
//
// Every reader and writer of that row goes through here, so the seal can never be
// applied on one path and forgotten on another. Two callers exist:
//
//   - `@/lib/database#readOpenAIConnectionFromDatabase` — the RUNTIME path. It is
//     published to `@cinatra-ai/openai-connector` as `readRowFromDatabase` (see
//     register-host-connector-services.ts) and is what resolves the credential on
//     every LLM call.
//   - `@/lib/openai-connection-store` — the CONFIGURATION path (settings reads and
//     every mutation).
//
// Both must perform the lazy migration, not just the configuration path: an
// instance that uses OpenAI normally but never opens a settings surface would
// otherwise keep its key in plaintext indefinitely.
//
// The accessors take a `port` rather than calling Postgres directly, for two
// reasons. It keeps them PURE — they live here, beside the seal/unseal transforms
// they orchestrate, and are unit-tested over an in-memory port with no mocking at
// all. And it adds NO first-party module to the locked dev-perf routes' reachable
// graph, which carries a route-graph ratchet. `@/lib/database-metadata` binds the
// live Postgres port and re-exports the bound accessors.
// ---------------------------------------------------------------------------

/**
 * The metadata-KV operations the accessors below need. `@/lib/database-metadata`
 * binds the live Postgres implementations; a test binds an in-memory map, so the
 * accessors run as REAL code with no module mocking.
 */
export interface OpenAIConnectionMetadataPort {
  /** Parsed row value, or `fallback` when the row is absent. */
  readValue<T>(key: string, fallback: T): T;
  /** Byte-accurate stored JSON string, or null when the row is absent. */
  readRaw(key: string): string | null;
  /** INSERT ... ON CONFLICT DO NOTHING — never clobbers a racing creator. */
  insertIfAbsent(key: string, value: unknown): void;
  /** Swap to `newValue` ONLY while the stored value is byte-equal to `expectedRaw`. */
  compareAndSwap(key: string, newValue: string, expectedRaw: string): boolean;
}

function parseRow(raw: string): StoredOpenAIConnectionRow | null {
  try {
    return JSON.parse(raw) as StoredOpenAIConnectionRow;
  } catch {
    return null;
  }
}

/**
 * Read the row with the `apiKey` UNSEALED, upgrading a legacy plaintext row to a
 * sealed row on the way past. Returns null when the row has never been saved.
 *
 * The upgrade is best-effort and only ever runs for a row that actually holds
 * legacy plaintext, so a already-sealed row costs exactly ONE query — the same
 * as before cinatra#2581.
 */
export function readUnsealedOpenAIConnectionRowVia(
  port: OpenAIConnectionMetadataPort,
): StoredOpenAIConnectionRow | null {
  const stored = port.readValue<StoredOpenAIConnectionRow | null>(OPENAI_CONNECTION_METADATA_KEY, null);
  if (!stored) return null;
  const { value, sawLegacyPlaintext } = unsealOpenAIConnectionSecrets(stored);
  if (sawLegacyPlaintext) {
    upgradeLegacyOpenAIConnectionRowVia(port);
  }
  return value as StoredOpenAIConnectionRow;
}

/** The RAW row (sealed blob verbatim) — never hand this to a caller as config. */
export function readRawOpenAIConnectionRowVia(
  port: OpenAIConnectionMetadataPort,
): StoredOpenAIConnectionRow | null {
  return port.readValue<StoredOpenAIConnectionRow | null>(OPENAI_CONNECTION_METADATA_KEY, null);
}

/** Bounded retry budget for the merge-and-swap write below. */
const WRITE_ATTEMPTS = 5;

/**
 * Derives the row to persist from the row CURRENTLY stored. Pass one of these
 * (rather than a fixed value) for any read-modify-write, so the derivation is
 * re-run against fresh state on every merge-and-swap attempt.
 */
export type OpenAIConnectionRowUpdater = (
  current: StoredOpenAIConnectionRow | null,
) => unknown;

/**
 * Persist the row with the `apiKey` SEALED, ATOMICALLY.
 *
 * `preserveExistingSecret` (default true) carries the CURRENT stored key forward
 * when `value` supplies none. That merge is what makes an unrelated settings
 * save safe — but a plain read-then-write would still be a TOCTOU: another
 * request (or another replica) can disconnect or rotate the key between the two
 * statements, and the unconditional write would then resurrect the removed
 * credential.
 *
 * So the merge and the persist are bound together: the row is merged against the
 * BYTES observed in this attempt and swapped in only while the stored row is
 * still byte-equal to them (`port.compareAndSwap`). A concurrent
 * write makes the swap a no-op, and the next attempt re-merges against the NEWER
 * row — so a save can never move the stored secret backwards. Row creation uses
 * INSERT-IF-ABSENT, which likewise cannot clobber a racing creator.
 *
 * `next` SHOULD be an {@link OpenAIConnectionRowUpdater} for any read-modify-
 * write. CAS alone protects the secret, not the rest of the row: a caller that
 * snapshots the row, then derives a fixed value from that snapshot, would still
 * clobber a concurrent change to any OTHER field — including an explicit
 * `loggingEnabled: false` opt-out, which is exactly the body-logging setting this
 * work exists to protect. Deriving the value INSIDE each attempt re-reads that
 * newer state instead of overwriting it. A fixed value is accepted only for a
 * write that genuinely does not depend on current state.
 *
 * @throws fail-closed when `CINATRA_ENCRYPTION_KEY` is missing/invalid and a
 *   plaintext key needs sealing — nothing is persisted on throw.
 * @throws when the retry budget is exhausted under pathological contention. That
 *   is deliberate: surfacing "try again" to the operator beats silently dropping
 *   the save or clobbering whoever won.
 */
export function writeSealedOpenAIConnectionRowVia(
  port: OpenAIConnectionMetadataPort,
  next: unknown | OpenAIConnectionRowUpdater,
  options?: { preserveExistingSecret?: boolean },
): void {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const observedRaw = port.readRaw(OPENAI_CONNECTION_METADATA_KEY);
    const currentRaw =
      observedRaw === null
        ? null
        : parseRow(observedRaw);
    const value =
      typeof next === "function" ? (next as OpenAIConnectionRowUpdater)(currentRaw) : next;
    const nextRaw = JSON.stringify(
      prepareSealedOpenAIConnectionWrite(value, currentRaw, options),
    );

    if (observedRaw === null) {
      // No row yet. INSERT-IF-ABSENT is a no-op if a racing writer created one
      // first, in which case the next attempt merges against THEIR row.
      port.insertIfAbsent(OPENAI_CONNECTION_METADATA_KEY, JSON.parse(nextRaw) as unknown);
      if (port.readRaw(OPENAI_CONNECTION_METADATA_KEY) === nextRaw) {
        return;
      }
      continue;
    }

    if (
      port.compareAndSwap(OPENAI_CONNECTION_METADATA_KEY, nextRaw, observedRaw)
    ) {
      return;
    }
  }
  // Message carries the row key only — NEVER key material.
  throw new Error(
    `[openai-connection-secret] could not persist ${OPENAI_CONNECTION_METADATA_KEY}: ` +
      `the row changed under ${WRITE_ATTEMPTS} merge-and-swap attempts. Retry the save.`,
  );
}

/**
 * Best-effort lazy upgrade of a LEGACY plaintext row to a sealed row. No
 * migration file is involved — the same metadata KV column holds the JSON
 * either way.
 *
 * ATOMIC via a single conditional UPDATE: the sealed value lands ONLY while the
 * stored row is still byte-equal to the snapshot read here, so a concurrent
 * newer write (an operator rotating or disconnecting the key) is never clobbered
 * by a stale re-sealed snapshot. NON-THROWING by contract — a failed upgrade
 * must never break a read; the row simply stays legacy and the next write seals
 * it.
 */
export function upgradeLegacyOpenAIConnectionRowVia(port: OpenAIConnectionMetadataPort): void {
  try {
    const observedRaw = port.readRaw(OPENAI_CONNECTION_METADATA_KEY);
    if (observedRaw === null) return;
    const parsed = JSON.parse(observedRaw) as StoredOpenAIConnectionRow;
    const { value, sawLegacyPlaintext } = unsealOpenAIConnectionSecrets(parsed);
    if (!sawLegacyPlaintext) return;
    port.compareAndSwap(
      OPENAI_CONNECTION_METADATA_KEY,
      JSON.stringify(prepareSealedOpenAIConnectionWrite(value, parsed)),
      observedRaw,
    );
  } catch (error) {
    // Redacted: row + error CLASS only, NEVER key material.
    console.warn(
      `[openai-connection-secret] seal-on-read upgrade skipped for ` +
        `key=${OPENAI_CONNECTION_METADATA_KEY} — ` +
        `error=${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}
