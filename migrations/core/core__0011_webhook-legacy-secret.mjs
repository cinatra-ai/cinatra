// core__0011 — legacy single-shared-secret storage for the webhook bridge
// (cinatra#343).
//
// core__0009 added `webhook_secret_bindings` with a structural `legacy_enabled`
// flag but deferred the legacy-secret STORAGE columns to #343 (D3c option A).
// This migration adds them: a binding flagged legacy_enabled keeps its in-field
// sender's bespoke `sha256=<hex>` HMAC (the deployed WordPress plugin) while
// still routing through the generic /webhook facility. The shared HMAC secret is
// stored ENCRYPTED via the host secretsCodec (AES-256-GCM over the instance key)
// as ciphertext+iv columns — the binding row holds the codec BLOB itself, not a
// "ref" — under a field-scoped AAD (`webhook-binding.<binding_id>.legacy`) so a
// legacy blob can never be decrypted in the current/previous columns (mirrors
// the core__0009 D3b posture). Both columns are nullable: a Standard-Webhooks
// binding (the forward default) leaves them null.
//
// ADDITIVE + idempotent: `ADD COLUMN IF NOT EXISTS` on the existing table, no-op
// on a bootstrap-seeded schema (the bootstrap DDL in src/lib/drizzle-store.ts
// adds the same columns), ledger-faked on a fresh install. Unqualified names
// ride the runner's search_path. Reversible: down() drops the two columns.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`ALTER TABLE webhook_secret_bindings
    ADD COLUMN IF NOT EXISTS legacy_secret_ciphertext text,
    ADD COLUMN IF NOT EXISTS legacy_secret_iv text;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: drop the two additive columns (restores the post-0009 shape).
  pgm.sql(`ALTER TABLE webhook_secret_bindings
    DROP COLUMN IF EXISTS legacy_secret_iv,
    DROP COLUMN IF EXISTS legacy_secret_ciphertext;`);
}
