// core__0062 — partial expression indexes on the email correlation keys in the
// objects.data JSONB column (cinatra#1456): objects_data_thread_idx,
// objects_data_campaign_idx, objects_data_contact_idx.
//
// WHY. The email thread / campaign / contact views (the #1456 indexed query
// seam, src/lib/email-correlation-queries.ts) filter the email transport records
// by data.threadId / data.campaignId / (data.connectorId, data.contactId).
// Those correlation ids live in the JSONB `data` column, which had no index —
// so without these the views would sequential-scan the whole objects table. The
// query seam's `dataEquals` filter (listObjectsByFilter) compiles to
// `data->>'<key>' = $n`, which these expression indexes serve.
//
// PARTIAL (WHERE key IS NOT NULL) so only correlation-carrying rows (a small
// fraction of all objects) enter each index — tiny + selective. `jsonb ->> text`
// is IMMUTABLE, so it is index-expression-eligible. The contact index leads with
// (org_id, connectorId, contactId) because a provider-native contactId is only
// meaningful within its connector, so the view always filters the PAIR.
//
// WHY A MIGRATION. The indexes are additive — the bootstrap DDL
// (buildEmailCorrelationIndexQueries, spliced into buildCreateStoreSchemaQueries
// in src/lib/drizzle-store.ts in the SAME PR) creates them via
// `CREATE INDEX IF NOT EXISTS`, so a fresh install is born at the target shape
// and ledger-fakes this chain. This module carries the SAME creates onto the
// operator upgrade path (core__0050 convention). Idempotent both ways;
// unqualified names resolve to the runner's search_path schema.
//
// down() drops the three indexes (IF EXISTS) — a pure performance revert, no
// data loss.
//
// SEQ PROVISIONAL: assigned at MERGE (the gate requires new seq > max SHIPPED;
// max shipped on origin/main at build time is core__0060). A concurrent lane may
// claim 0061 first, in which case renumber-at-merge is normal (rename-only, zero
// SQL change; the runner tolerates gaps).

// BACKFILL. Existing @cinatra-ai/email:sent-email rows written before this PR
// carry connectorId + providerThreadId but NO derived threadId (the writer only
// started emitting it in this PR; received-reply already had it). Without the
// backfill the thread view would miss historical sends. This additive,
// idempotent UPDATE derives `data.threadId = connectorId || ':' ||
// providerThreadId` (the SAME key the writer + seam use) for every sent-email
// that has a providerThreadId and no threadId yet. Guarded by the WHERE so a
// second run / a fresh install (no such rows) is a no-op. Only sent-email needs
// it; received-reply already carries threadId.
const SENT_EMAIL_TYPE = "@cinatra-ai/email:sent-email";

const EMAIL_CORRELATION_INDEXES = [
  "objects_data_thread_idx",
  "objects_data_campaign_idx",
  "objects_data_contact_idx",
];

/**
 * The three CREATE INDEX statements, byte-identical to the bootstrap DDL in
 * src/lib/drizzle-store.ts#buildEmailCorrelationIndexQueries (unqualified here so
 * they resolve to the runner's search_path schema).
 * @returns {string[]}
 */
export function buildUpSql() {
  return [
    `CREATE INDEX IF NOT EXISTS objects_data_thread_idx ON objects (org_id, (data->>'threadId')) WHERE data->>'threadId' IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS objects_data_campaign_idx ON objects (org_id, (data->>'campaignId')) WHERE data->>'campaignId' IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS objects_data_contact_idx ON objects (org_id, (data->>'connectorId'), (data->>'contactId')) WHERE data->>'contactId' IS NOT NULL`,
  ];
}

/**
 * The idempotent forward-only backfill of `data.threadId` on historical
 * sent-email rows (unqualified name resolves via search_path). jsonb_set writes
 * the derived key; the WHERE makes it a no-op on re-run / fresh install.
 * @returns {string}
 */
export function buildBackfillSql() {
  return `UPDATE objects
             SET data = jsonb_set(
                   data,
                   '{threadId}',
                   to_jsonb((data->>'connectorId') || ':' || (data->>'providerThreadId')),
                   true)
           WHERE type = '${SENT_EMAIL_TYPE}'
             AND data->>'connectorId' IS NOT NULL
             AND data->>'providerThreadId' IS NOT NULL
             AND (data->>'threadId') IS NULL`;
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  for (const sql of buildUpSql()) {
    pgm.sql(`${sql};`);
  }
  // Backfill AFTER the indexes exist so the write is index-consistent.
  pgm.sql(`${buildBackfillSql()};`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  for (const idx of EMAIL_CORRELATION_INDEXES) {
    pgm.sql(`DROP INDEX IF EXISTS ${idx};`);
  }
}
