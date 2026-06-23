import "server-only";

import { createHash } from "node:crypto";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, postgresSchema } from "@/lib/database";

// The connection string carries NO search_path (it is the raw Supabase URL), so
// every statement here MUST schema-qualify against `postgresSchema` (default
// "cinatra") — exactly like @/lib/database's metadata/json-row helpers. The
// migration (core__0010) and the bootstrap DDL (buildCreateStoreSchemaQueries)
// both create this table in `postgresSchema`; an unqualified write would land
// in (or fail against) the default `public`/`$user` schema and the intended DLQ
// would stay empty. (cinatra#341 codex round-1 HIGH.)
function qualified(): string {
  return `"${postgresSchema.replaceAll('"', '""')}"`;
}

// ---------------------------------------------------------------------------
// Outbound-webhook dead-letter writer (cinatra#341).
//
// The host-owned BullMQ WEBHOOK_OUTBOUND_DELIVERY dispatcher arm calls
// `recordOutboundDeadLetter` to persist a delivery it could not complete — the
// durable record the pre-#341 fire-and-forget assistant-webhook path lacked.
//
// SECRET / PAYLOAD HYGIENE (F5):
//   - The raw payload is NEVER stored; only `digestPayload(payload)` (sha256
//     hex) is written, for correlation.
//   - `target_url` is reduced to origin+pathname (query string + userinfo
//     stripped) so a token embedded in the URL can't leak into the table.
//   - `last_error` is truncated and scrubbed of secret-shaped tokens.
//
// IDEMPOTENT (F4): the insert uses ON CONFLICT (event_kind, message_id) DO
// NOTHING against the UNIQUE index from core__0010, so a `permanent` row and a
// later last-attempt-`retryable` row for the SAME delivery collapse to one and
// the writer is safely re-runnable.
// ---------------------------------------------------------------------------

const MAX_ERROR_LEN = 500;

export interface OutboundDeadLetterInput {
  /** Delivery event kind, e.g. "assistant.mention". */
  eventKind: string;
  /** Standard-Webhooks webhook-id / receiver idempotency key. */
  messageId: string;
  /** The target URL (sanitized to origin+pathname before store). */
  targetUrl: string;
  /** sha256 hex of the serialized payload (NEVER the raw payload). */
  payloadDigest: string;
  /** Number of delivery attempts made. */
  attempts: number;
  /** Last HTTP status seen, or null (network/timeout/missing-target). */
  lastStatus?: number | null;
  /** Last error string (truncated + scrubbed before store). */
  lastError?: string | null;
}

/** sha256 hex of a JSON-serialized payload. Stable for a given value. */
export function digestPayload(payload: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload) ?? "null";
  } catch {
    // Circular / non-serializable — still produce a stable, non-leaking digest.
    serialized = String(payload);
  }
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/**
 * Reduce a URL to origin + pathname (drop query string, fragment, and any
 * userinfo) so secret-bearing query params / basic-auth creds never reach the
 * DLQ table. Falls back to a coarse host-only string for an unparseable URL.
 */
export function sanitizeTargetUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    // URL.origin already excludes userinfo; append the path only.
    return `${u.origin}${u.pathname}`;
  } catch {
    // Best-effort: strip everything from the first '?' and any embedded creds.
    const noQuery = rawUrl.split("?")[0] ?? rawUrl;
    return noQuery.replace(/\/\/[^/@]*@/, "//");
  }
}

/**
 * Truncate + scrub an error message before persisting. Removes long
 * high-entropy / secret-shaped tokens, reduces any embedded URL to its
 * origin+pathname (stripping userinfo creds + query secrets), and caps length
 * so the DLQ row cannot become a secret sink or grow unbounded.
 *
 * The URL reduction is essential: Node's `fetch`/undici surfaces the FULL
 * target URL inside its thrown message (it echoes the whole URL, including any
 * userinfo basic-auth credentials and query string, when it rejects a
 * credentialed URL), and a delivery error string is persisted as `last_error`
 * — so a basic-auth password or a short `?token=` query secret would otherwise
 * leak past the `whsec_`/40+char redactions into the DLQ table (cinatra#341
 * codex round-1 HIGH — DLQ never stores secrets, F5/acceptance #3).
 */
export function sanitizeError(rawError: string | null | undefined): string | null {
  if (!rawError) return null;
  // Reduce any embedded absolute URL to origin+pathname FIRST (drops userinfo
  // credentials + query string + fragment), then redact `whsec_...` secrets and
  // bearer-token-shaped blobs.
  let scrubbed = rawError
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (m) => sanitizeTargetUrl(m))
    .replace(/whsec_[A-Za-z0-9+/=_-]+/g, "whsec_[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted-token]");
  if (scrubbed.length > MAX_ERROR_LEN) {
    scrubbed = `${scrubbed.slice(0, MAX_ERROR_LEN)}…`;
  }
  return scrubbed;
}

let _schemaEnsured = false;

function ensureDeadLetterTable(): void {
  if (_schemaEnsured) return;
  // Parity with core__0010 / buildCreateStoreSchemaQueries. Pure CREATE … IF
  // NOT EXISTS — a no-op on a migrated/bootstrapped schema. Mirrors the
  // assistant_profiles self-bootstrap pattern so a fresh test DB has the table
  // even before the migration runner executes.
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `CREATE TABLE IF NOT EXISTS ${qualified()}."webhook_outbound_dead_letter" (
          id             bigserial PRIMARY KEY,
          event_kind     text NOT NULL,
          message_id     text NOT NULL,
          target_url     text NOT NULL,
          payload_digest text NOT NULL,
          attempts       integer NOT NULL DEFAULT 1,
          last_status    integer,
          last_error     text,
          failed_at      timestamptz NOT NULL DEFAULT now(),
          created_at     timestamptz NOT NULL DEFAULT now()
        )`,
      },
      {
        text: `CREATE UNIQUE INDEX IF NOT EXISTS webhook_outbound_dead_letter_key_uniq
          ON ${qualified()}."webhook_outbound_dead_letter" (event_kind, message_id)`,
      },
    ],
  });
  _schemaEnsured = true;
}

/**
 * Persist a dead-letter row for an undeliverable outbound webhook. Idempotent
 * on (event_kind, message_id). Never throws past its own boundary in normal
 * operation — but the dispatcher still wraps the call so a DB hiccup can't
 * crash the worker.
 */
export function recordOutboundDeadLetter(input: OutboundDeadLetterInput): void {
  ensureDeadLetterTable();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `INSERT INTO ${qualified()}."webhook_outbound_dead_letter"
                 (event_kind, message_id, target_url, payload_digest, attempts, last_status, last_error)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (event_kind, message_id) DO NOTHING`,
        values: [
          input.eventKind,
          input.messageId,
          sanitizeTargetUrl(input.targetUrl),
          input.payloadDigest,
          input.attempts,
          input.lastStatus ?? null,
          sanitizeError(input.lastError),
        ],
      },
    ],
  });
}
