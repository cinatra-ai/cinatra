// Bootstrap DDL for the host-owned multi-server enrollment tables (cinatra#2018
// S3 / design §3 / D2). Two tables:
//   - `connector_instance_server`        — one row per enrolled/present/retired
//     server per `(connector_key, instance_id, server_id)`; the enumeration,
//     identity, per-server endpoint, exposure mode and health matrix the S3
//     reconciler/invoker read (never a connector-config blob field — §3 / D2).
//   - `connector_instance_site_inventory` — one companion row per
//     `(connector_key, instance_id)` holding the last-accepted site inventory
//     `(credential_version, inventory_seq)` epoch + `site` block; the atomic
//     anti-replay/ordering gate advances it (§4.1 step 5).
//
// PURELY ADDITIVE new tables → they ship in the idempotent bootstrap DDL
// (buildCreateStoreSchemaQueries / createStoreTables, src/lib/drizzle-store.ts),
// NOT a numbered core migration. Per migrations/README.md the bootstrap owns
// ADDITIVE evolution (`CREATE TABLE IF NOT EXISTS`, re-run every boot/setup);
// node-pg-migrate is only for TRANSFORMATIONAL change to tables that already
// hold user data. This mirrors connector_instance_tool_policy (cinatra#2017 S2),
// extension_update_read_model (cinatra#1041) and widget_stream_tokens
// (cinatra#220) — new tables added via the bootstrap with no migration. The DDL
// is pure and deterministic; row POPULATION is the reconciler + first-touch
// default-enrollment backstop + probe/catalog health writers in
// connector-instance-server-store.ts, never in-DDL enumeration.
//
// A pure string builder with ZERO imports — a synchronous leaf, safe for
// drizzle-store.ts's synchronous require() composition (same contract as
// connector-instance-tool-policy-schema.ts; the postgres-sync-leaf-imports test
// walks this edge from the drizzle-store entrypoint and fails closed if this
// leaf ever reaches an async-root import).
//
// KEYS:
//   - connector_instance_server         PRIMARY KEY (connector_key, instance_id,
//     server_id) — covers the per-instance enumeration (leading columns
//     connector_key, instance_id) and the point read by full key, so no extra
//     index is needed. `transports` is a jsonb array of the normalized transport
//     list; NULL means "unknown/none".
//   - connector_instance_site_inventory PRIMARY KEY (connector_key, instance_id)
//     — the non-deferrable arbiter the conditional-advance upsert serializes on.
export function connectorInstanceServerSchemaQueries(
  schemaName: string,
): { text: string }[] {
  const q = schemaName.replaceAll('"', '""');
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."connector_instance_server" (
      connector_key text NOT NULL,
      instance_id text NOT NULL,
      server_id text NOT NULL,
      source text NOT NULL,
      status text NOT NULL,
      adapter_server_id text,
      namespace text,
      route text,
      rest_path text NOT NULL,
      label text,
      server_version text,
      transports jsonb,
      exposure_mode text,
      unenrolled_reason text,
      enrolled_at timestamptz,
      retired_at timestamptz,
      verified_at timestamptz,
      last_status text,
      last_status_at timestamptz,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (connector_key, instance_id, server_id)
    )`,
    },
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."connector_instance_site_inventory" (
      connector_key text NOT NULL,
      instance_id text NOT NULL,
      contract_version text NOT NULL,
      site_id text NOT NULL,
      origin text NOT NULL,
      credential_version integer NOT NULL,
      inventory_seq bigint NOT NULL,
      site_meta jsonb NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (connector_key, instance_id)
    )`,
    },
  ];
}
