// Bootstrap DDL for connector_instance_native_injection_policy (cinatra#2019
// S4). The persisted per-`(connector_key, instance_id)` OPT-IN row for
// trusted-site native read-injection: absent row = OFF; `mode` is the only
// caller-chosen field; the consent stamps (`disclosure_version`,
// `descriptor_set_version`, `descriptor_set_hash`) are HOST-STAMPED at
// enable/re-acknowledge time from the shipped constants (see
// connector-instance-trusted-read-descriptors.ts) — a `trusted_site` row without all
// three stamps is unrepresentable (the `trusted_site_stamps` CHECK), so a
// consent acknowledgement can never be partially recorded.
//
// CONSENT IS ORG-BOUND: `consented_org_id` records the org whose admin
// performed the ceremony. Readers require it to equal the instance's CURRENT
// owning org (a transferred/rebound/recreated instance id can never carry a
// prior org's consent into a new owner — the new owner re-acknowledges), and
// a `trusted_site` row without the org stamp + enable attribution is
// unrepresentable alongside the consent stamps.
//
// PURELY ADDITIVE new table → it ships in the idempotent bootstrap DDL
// (buildCreateStoreSchemaQueries / createStoreTables, src/lib/drizzle-store.ts),
// NOT a numbered core migration. Per migrations/README.md the bootstrap owns
// ADDITIVE evolution (`CREATE TABLE IF NOT EXISTS`, re-run every boot/setup);
// node-pg-migrate is only for TRANSFORMATIONAL change to tables that already
// hold user data. This mirrors connector_instance_tool_policy (cinatra#2017 S2),
// connector_instance_server (cinatra#2018 S3), extension_update_read_model
// (cinatra#1041) and widget_stream_tokens (cinatra#220) — new tables added via
// the bootstrap with no migration. The DDL is pure and deterministic; row
// POPULATION is exclusively the org-admin-gated opt-in writer in
// connector-instance-native-injection-store.ts (an explicit human ceremony),
// never in-DDL enumeration and never a reconcile/backfill default (OFF needs no
// row).
//
// A pure string builder with ZERO imports — a synchronous leaf, safe for
// drizzle-store.ts's synchronous require() composition (same contract as
// connector-instance-tool-policy-schema.ts; the postgres-sync-leaf-imports test
// walks this edge from the drizzle-store entrypoint and fails closed if this
// leaf ever reaches an async-root import).
//
// KEY: PRIMARY KEY (connector_key, instance_id) — the store only ever does the
// per-instance point read (connector_key = $1 AND instance_id = $2) and the
// matching upsert, so no extra index is needed.
export function connectorInstanceNativeInjectionSchemaQueries(
  schemaName: string,
): { text: string }[] {
  const q = schemaName.replaceAll('"', '""');
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."connector_instance_native_injection_policy" (
      connector_key text NOT NULL,
      instance_id text NOT NULL,
      mode text NOT NULL CHECK (mode IN ('off','trusted_site')),
      disclosure_version text,
      descriptor_set_version integer,
      descriptor_set_hash text,
      consented_org_id text,
      enabled_by text,
      enabled_at timestamptz,
      updated_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT trusted_site_stamps CHECK (
        mode <> 'trusted_site'
        OR (disclosure_version IS NOT NULL AND descriptor_set_version IS NOT NULL AND descriptor_set_hash IS NOT NULL
            AND consented_org_id IS NOT NULL AND enabled_by IS NOT NULL AND enabled_at IS NOT NULL)
      ),
      PRIMARY KEY (connector_key, instance_id)
    )`,
    },
  ];
}
