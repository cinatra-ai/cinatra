// core__0009 — per-webhook / per-site secret bindings (cinatra#340).
//
// Adds `webhook_secret_bindings`: one active row per (vendor, slug, hook, site)
// holding the Standard-Webhooks secret material the generic route verifies
// against. The route resolves a binding by the server-issued OPAQUE binding_id
// carried in the URL — never from the request payload (a payload-trusted site
// identity is a tenant-confusion vector).
//
// The secret material is stored ENCRYPTED via the host secretsCodec (AES-256-GCM
// over the instance key) as ciphertext+iv columns — the binding row holds the
// codec BLOB itself, not a "ref" to a separate store (cinatra#340 D3). Field-
// scoped AAD (`webhook-binding.<binding_id>.current` / `.previous`) is applied
// by the host service so the current/previous blobs cannot be swapped (D3b).
//
// Rotation is a BOUNDED dual-secret window: the host's rotate() makes the
// current secret the `previous` (valid until previous_expires_at) and installs a
// fresh current, so a webhook in flight signed under the old secret still
// verifies until the window closes. The partial-unique index
// (vendor, slug, hook, site_id) WHERE revoked_at IS NULL guarantees AT MOST ONE
// active binding per tuple (cinatra#340 design).
//
// site_id is `uuid` (connect_sites.site_id space, D1b). legacy_enabled is the
// structural hook for the #343 legacy single-shared-secret bridge; the
// legacy-secret STORAGE columns are deferred to #343 (D3c option A), so this
// stays false in #340 (no binding sets it).
//
// ADDITIVE (a brand-new table): rides the idempotent bootstrap DDL, no-op on a
// bootstrap-seeded schema, ledger-faked on a fresh install. Unqualified names
// ride the runner's search_path.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`CREATE TABLE IF NOT EXISTS webhook_secret_bindings (
    binding_id                 text PRIMARY KEY,
    vendor                     text NOT NULL,
    slug                       text NOT NULL,
    hook                       text NOT NULL,
    site_id                    uuid NOT NULL,
    current_secret_ciphertext  text NOT NULL,
    current_secret_iv          text NOT NULL,
    previous_secret_ciphertext text,
    previous_secret_iv         text,
    previous_expires_at        timestamptz,
    rotated_at                 timestamptz,
    legacy_enabled             boolean NOT NULL DEFAULT false,
    revoked_at                 timestamptz,
    created_at                 timestamptz NOT NULL DEFAULT now()
  );`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS webhook_secret_bindings_site_idx
    ON webhook_secret_bindings (site_id);`);
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS webhook_secret_bindings_active_uniq
    ON webhook_secret_bindings (vendor, slug, hook, site_id) WHERE revoked_at IS NULL;`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Reversible: drop the indexes then the table. The table is a fresh #340
  // addition, so down() restores the exact pre-0009 shape on any lineage.
  pgm.sql(`DROP INDEX IF EXISTS webhook_secret_bindings_active_uniq;`);
  pgm.sql(`DROP INDEX IF EXISTS webhook_secret_bindings_site_idx;`);
  pgm.sql(`DROP TABLE IF EXISTS webhook_secret_bindings;`);
}
