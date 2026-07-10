// Bootstrap DDL for the capability-ownership grant table — a pure string builder
// with ZERO imports (a synchronous leaf, safe for `drizzle-store.ts`'s
// synchronous `require()` composition; see the postgres-sync-leaf-imports test).
//
// The DDL is spread into `buildCreateStoreSchemaQueries` so a fresh DB provisions
// the table (per migrations/README.md); it lives here rather than inline because
// drizzle-store.ts is a baselined file-size-ratchet bottleneck at its ceiling.
// This is a NET-NEW table (additive), so no migration artifact is required — the
// schema-migration gate only demands one for DESTRUCTIVE changes to existing
// tables. The SIBLING host-port grant DDL deliberately stays inline in
// drizzle-store.ts (moving pre-existing table DDL out would read as a destructive
// drop to that gate).

/** DDL for the admin-approved `extension_capability_ownership_grant` table +
 * its anti-squat partial unique indexes. Spread into
 * `buildCreateStoreSchemaQueries`. */
export function capabilityOwnershipGrantSchemaQueries(schemaName: string): { text: string }[] {
  return [
    // Runtime installer — admin-approved CAPABILITY-OWNERSHIP grants (the
    // capability-ownership grant, S0). Decides WHICH runtime-installed package
    // OWNS a credential-store token key (`connector_config:<token_config_key>`,
    // e.g. the widget-auth store). A package self-declaring
    // `cinatra.widgetStream.auth.tokenConfigKey` does NOT, by that declaration
    // alone, become the trusted owner — ownership is an admin-approved grant
    // (auto-approved ONLY for a `trusted-signed` install, the same capability
    // split as host ports / host DDL). manifest_binding_hash resets an approval
    // to pending when the declared claim changes; status gates resolution.
    // Modeled on `extension_host_port_grant` — no net-new crypto.
    { text: `CREATE TABLE IF NOT EXISTS "${schemaName.replaceAll('"', '""')}"."extension_capability_ownership_grant" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      package_name text NOT NULL,
      org_id text,
      token_config_key text NOT NULL,
      manifest_binding_hash text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      approved_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (package_name, org_id, token_config_key)
    )` },
    { text: `CREATE INDEX IF NOT EXISTS extension_capability_ownership_grant_token_idx ON "${schemaName.replaceAll('"', '""')}"."extension_capability_ownership_grant" (token_config_key, org_id)` },
    // Global-scope (org_id IS NULL) uniqueness of a package's grant per token
    // key: the table UNIQUE(package_name, org_id, token_config_key) does NOT
    // dedupe NULL org_id (SQL NULLs are distinct), so a partial index enforces one
    // global row per (package, token key).
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS extension_capability_ownership_grant_pkg_token_global_uniq ON "${schemaName.replaceAll('"', '""')}"."extension_capability_ownership_grant" (package_name, token_config_key) WHERE org_id IS NULL` },
    // ANTI-SQUATTING (the capability-ownership grant design headline): at most
    // ONE approved owner per (token key, org). Two approved owners for the same
    // token store is a write-time impossibility — a squatting approval fails with
    // a unique violation, never a silent second owner. A plain partial index does
    // NOT constrain org_id IS NULL (NULLs are distinct), so the global scope has
    // its own approved-uniqueness index below.
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS extension_capability_ownership_grant_approved_token_uniq ON "${schemaName.replaceAll('"', '""')}"."extension_capability_ownership_grant" (token_config_key, org_id) WHERE status = 'approved' AND org_id IS NOT NULL` },
    { text: `CREATE UNIQUE INDEX IF NOT EXISTS extension_capability_ownership_grant_approved_token_global_uniq ON "${schemaName.replaceAll('"', '""')}"."extension_capability_ownership_grant" (token_config_key) WHERE status = 'approved' AND org_id IS NULL` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'extension_capability_ownership_grant'
            AND constraint_name = 'extension_capability_ownership_grant_status_check'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."extension_capability_ownership_grant"
            ADD CONSTRAINT extension_capability_ownership_grant_status_check
            CHECK (status IN ('pending', 'approved', 'revoked'));
        END IF;
      END $$;` },
  ];
}
