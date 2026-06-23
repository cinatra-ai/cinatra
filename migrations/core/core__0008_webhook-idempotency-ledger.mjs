// core__0008 — inbound-webhook idempotency ledger (cinatra#340).
//
// Adds `webhook_idempotency`: the LEASED dedupe state machine for the generic
// inbound-webhook route. One row per (scope, site_id, message_id) where
// `scope` is "<vendor>/<slug>/<hook>" and `message_id` is the Standard-Webhooks
// webhook-id. The route CLAIMS a row (a single atomic UPSERT) before dispatch
// and FINALIZES it (attempt-fenced) after:
//   - processing : a holder owns the lease (lease_until in the future);
//   - done       : terminal success/refusal (a replay returns deduped);
//   - failed     : retryable/threw — the next arrival re-claims and retries.
// A crashed holder's lease expires and a later arrival re-claims it;
// attempt_count is the finalize fence (a stale holder cannot overwrite a newer
// attempt's verdict). All three key columns are NOT NULL — a nullable column in
// the unique key would admit duplicate NULL rows and break idempotency.
//
// site_id is `uuid` (the connect_sites.site_id identity space, cinatra#340 D1b):
// a webhook arrives from a connected site, so its site identity lives in the
// same space as the rest of the connect/widget surface.
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
  pgm.sql(`CREATE TABLE IF NOT EXISTS webhook_idempotency (
    id            bigserial PRIMARY KEY,
    scope         text NOT NULL,
    site_id       uuid NOT NULL,
    message_id    text NOT NULL,
    status        text NOT NULL DEFAULT 'processing',
    lease_until   timestamptz,
    attempt_count integer NOT NULL DEFAULT 1,
    received_at   timestamptz NOT NULL DEFAULT now(),
    finalized_at  timestamptz
  );`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS webhook_idempotency_key_uniq
    ON webhook_idempotency (scope, site_id, message_id);`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: drop the index then the table. The table is a fresh #340
  // addition, so down() restores the exact pre-0008 shape on any lineage.
  pgm.sql(`DROP INDEX IF EXISTS webhook_idempotency_key_uniq;`);
  pgm.sql(`DROP TABLE IF EXISTS webhook_idempotency;`);
}
