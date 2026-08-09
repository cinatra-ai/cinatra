// -----------------------------------------------------------------------------
// The ONE at-rest accessor for the `openai_connection` metadata row (cinatra#2581).
//
// Every reader and writer of that row goes through here, so the seal can never
// be applied on one path and forgotten on another. Two callers exist:
//
//   - `@/lib/database#readOpenAIConnectionFromDatabase` — the RUNTIME path. It
//     is published to `@cinatra-ai/openai-connector` as `readRowFromDatabase`
//     (see register-host-connector-services.ts) and is what resolves the
//     credential on every LLM call.
//   - `@/lib/openai-connection-store` — the CONFIGURATION path (settings reads
//     and every mutation).
//
// Both must perform the lazy migration, not just the configuration path: an
// instance that uses OpenAI normally but never opens a settings surface would
// otherwise keep its key in plaintext indefinitely.
//
// It sits on the SYNC metadata leaf (`@/lib/database-metadata`) rather than the
// `@/lib/database` facade — the same shape as the sibling
// `anthropic-setup-consent-store` — so `database.ts` can import it without a
// cycle. The pure crypto/policy transforms live in `@/lib/openai-connection-at-rest`
// and stay unit-testable there; this module is only the DB wiring.
// -----------------------------------------------------------------------------

import {
  compareAndSwapMetadataValueInternal,
  readMetadataValueInternal,
  readRawMetadataStringInternal,
  safeParseJson,
  writeMetadataValueIfAbsentInternal,
} from "@/lib/database-metadata";
import {
  OPENAI_CONNECTION_METADATA_KEY,
  prepareSealedOpenAIConnectionWrite,
  unsealOpenAIConnectionSecrets,
  type StoredOpenAIConnectionRow,
} from "@/lib/openai-connection-at-rest";

/**
 * Read the row with the `apiKey` UNSEALED, upgrading a legacy plaintext row to a
 * sealed row on the way past. Returns null when the row has never been saved.
 *
 * The upgrade is best-effort and only ever runs for a row that actually holds
 * legacy plaintext, so a already-sealed row costs exactly ONE query — the same
 * as before cinatra#2581.
 */
export function readUnsealedOpenAIConnectionRow(): StoredOpenAIConnectionRow | null {
  const stored = readMetadataValueInternal<StoredOpenAIConnectionRow | null>(
    OPENAI_CONNECTION_METADATA_KEY,
    null,
  );
  if (!stored) return null;
  const { value, sawLegacyPlaintext } = unsealOpenAIConnectionSecrets(stored);
  if (sawLegacyPlaintext) {
    upgradeLegacyOpenAIConnectionRow();
  }
  return value as StoredOpenAIConnectionRow;
}

/** The RAW row (sealed blob verbatim) — never hand this to a caller as config. */
export function readRawOpenAIConnectionRow(): StoredOpenAIConnectionRow | null {
  return readMetadataValueInternal<StoredOpenAIConnectionRow | null>(
    OPENAI_CONNECTION_METADATA_KEY,
    null,
  );
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
 * still byte-equal to them (`compareAndSwapMetadataValueInternal`). A concurrent
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
export function writeSealedOpenAIConnectionRow(
  next: unknown | OpenAIConnectionRowUpdater,
  options?: { preserveExistingSecret?: boolean },
): void {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const observedRaw = readRawMetadataStringInternal(OPENAI_CONNECTION_METADATA_KEY);
    const currentRaw =
      observedRaw === null
        ? null
        : safeParseJson<StoredOpenAIConnectionRow | null>(observedRaw, null);
    const value =
      typeof next === "function" ? (next as OpenAIConnectionRowUpdater)(currentRaw) : next;
    const nextRaw = JSON.stringify(
      prepareSealedOpenAIConnectionWrite(value, currentRaw, options),
    );

    if (observedRaw === null) {
      // No row yet. INSERT-IF-ABSENT is a no-op if a racing writer created one
      // first, in which case the next attempt merges against THEIR row.
      writeMetadataValueIfAbsentInternal(
        OPENAI_CONNECTION_METADATA_KEY,
        JSON.parse(nextRaw) as unknown,
      );
      if (readRawMetadataStringInternal(OPENAI_CONNECTION_METADATA_KEY) === nextRaw) {
        return;
      }
      continue;
    }

    if (
      compareAndSwapMetadataValueInternal(
        OPENAI_CONNECTION_METADATA_KEY,
        nextRaw,
        observedRaw,
      )
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
export function upgradeLegacyOpenAIConnectionRow(): void {
  try {
    const observedRaw = readRawMetadataStringInternal(OPENAI_CONNECTION_METADATA_KEY);
    if (observedRaw === null) return;
    const parsed = JSON.parse(observedRaw) as StoredOpenAIConnectionRow;
    const { value, sawLegacyPlaintext } = unsealOpenAIConnectionSecrets(parsed);
    if (!sawLegacyPlaintext) return;
    compareAndSwapMetadataValueInternal(
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
