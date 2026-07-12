// Bootstrap DDL for extension_update_read_model (cinatra#1041 outcome 3) — the
// cached per-package update read model (latest registry version + declared
// sdkAbiRange) the hourly catalog-sync loop refreshes and the §III installed
// screen reads. Purely ADDITIVE new table → bootstrap DDL, no numbered
// migration (migrations/README.md: the idempotent bootstrap owns additive
// evolution; node-pg-migrate is for transformational change to populated
// tables). Written via src/lib/extension-update-read-model-store.ts; the PK on
// package_name covers the `package_name = ANY(...)` read, so no extra index.
//
// A pure string builder with ZERO imports — a synchronous leaf, safe for
// drizzle-store.ts's synchronous require() composition (same contract as
// co-owner-constraint-schema.ts / skill-lifecycle-schema.ts; the
// postgres-sync-leaf-imports test walks this edge). Extracted from
// buildCreateStoreSchemaQueries to hold the drizzle-store file-size ratchet
// (the #1317 / #1405 extract-leaf pattern); the schema-drift guard
// (extension-update-read-model-schema-drift.test.ts) still reads the spread
// result through buildCreateStoreSchemaQueries, so the boot SSOT contract is
// unchanged.
export function extensionUpdateReadModelSchemaQueries(
  schemaName: string,
): { text: string }[] {
  const q = schemaName.replaceAll('"', '""');
  return [
    { text: `CREATE TABLE IF NOT EXISTS "${q}"."extension_update_read_model" (
      package_name text PRIMARY KEY,
      latest_version text,
      latest_sdk_abi_range text,
      refreshed_at timestamptz NOT NULL
    )` },
  ];
}
