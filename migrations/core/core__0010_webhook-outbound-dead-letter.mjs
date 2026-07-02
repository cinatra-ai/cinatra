// core__0010 — outbound-webhook dead-letter table (cinatra#341).
//
// Adds `webhook_outbound_dead_letter`: the DURABLE record of an outbound
// delivery that the host-owned BullMQ engine could NOT deliver. The dispatcher
// (src/lib/background-jobs.ts, WEBHOOK_OUTBOUND_DELIVERY arm) writes one row
// when EITHER (a) a `permanent` classification occurs (non-retryable 4xx,
// missing url/secret, or a non-decodable legacy secret that the
// standardwebhooks signer rejects), OR (b) all configured `attempts` are
// exhausted on a `retryable` result. This is the durability the pre-#341
// fire-and-forget assistant-webhook path lacked — exhausted BullMQ jobs only
// expired out of the `failed` set; nothing persisted.
//
// SECRET / PAYLOAD HYGIENE (cinatra#341 F5): the row NEVER stores the raw
// payload or the webhook secret. `payload_digest` is a sha256 hex of the
// serialized payload (correlation only); `target_url` is reduced to
// origin+pathname (query string + userinfo stripped, so a token in the URL
// can't leak); `last_error` is truncated + scrubbed by the writer.
//
// IDEMPOTENT DLQ INSERT (F4): the UNIQUE index (event_kind, message_id) lets
// the writer use ON CONFLICT DO NOTHING — a `permanent` row and a later
// last-attempt-`retryable` row for the SAME (event_kind, message_id) collapse
// to one record; the writer is naturally re-runnable.
//
// ADDITIVE change (a brand-new table, migrations/README.md "Additive"): it
// rides the idempotent bootstrap DDL (buildCreateStoreSchemaQueries adds the
// SAME CREATE TABLE / CREATE INDEX this PR), so an artifact is NOT required.
// This module ships anyway to keep the fresh-bootstrap and migration paths
// aligned and to give the table a ledgered row; it is a pure CREATE … IF NOT
// EXISTS, so it is a no-op on a bootstrap-seeded schema and ledger-faked on a
// fresh install. Unqualified names ride the runner's search_path.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`CREATE TABLE IF NOT EXISTS webhook_outbound_dead_letter (
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
  );`);
  // Idempotent DLQ insert key (F4): at most one row per delivery identity.
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS webhook_outbound_dead_letter_key_uniq
    ON webhook_outbound_dead_letter (event_kind, message_id);`);
  // Scan index for the operator "recent dead letters" view.
  pgm.sql(`CREATE INDEX IF NOT EXISTS webhook_outbound_dead_letter_failed_at_idx
    ON webhook_outbound_dead_letter (failed_at);`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: drop the indexes then the table. The table is a fresh #341
  // addition, so down() restores the exact pre-0010 shape on any lineage.
  pgm.sql(`DROP INDEX IF EXISTS webhook_outbound_dead_letter_failed_at_idx;`);
  pgm.sql(`DROP INDEX IF EXISTS webhook_outbound_dead_letter_key_uniq;`);
  pgm.sql(`DROP TABLE IF EXISTS webhook_outbound_dead_letter;`);
}
