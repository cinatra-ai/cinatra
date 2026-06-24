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
