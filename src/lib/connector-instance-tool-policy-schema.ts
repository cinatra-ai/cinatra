// Bootstrap DDL for connector_instance_tool_policy (cinatra#2017 S2 slice K4 /
// design §2.6 / D4). The persisted per-`(connector_key, instance_id)` tool
// policy the governed invoker reads at step 2 and the `tools_list` per-row
// `policyStatus` reflects.
//
// PURELY ADDITIVE new table → it ships in the idempotent bootstrap DDL
// (buildCreateStoreSchemaQueries / createStoreTables, src/lib/drizzle-store.ts),
// NOT a numbered core migration. Per migrations/README.md the bootstrap owns
// ADDITIVE evolution (`CREATE TABLE IF NOT EXISTS`, re-run every boot/setup);
// node-pg-migrate is only for TRANSFORMATIONAL change to tables that already hold
// user data. This mirrors extension_update_read_model (cinatra#1041) and
// widget_stream_tokens (cinatra#220) — new tables added via the bootstrap with no
// migration. This satisfies the design's "DDL-only, deterministic, no runtime
// enumeration" intent (R2-B2): the DDL is pure and deterministic; row POPULATION
// is the deploy-gated reconcile + creation-hook writer + lazy first-touch
// backstop in connector-instance-tool-policy-store.ts, never in-DDL enumeration.
//
// A pure string builder with ZERO imports — a synchronous leaf, safe for
// drizzle-store.ts's synchronous require() composition (same contract as
// extension-update-read-model-schema.ts; the postgres-sync-leaf-imports test
// walks this edge).
//
// KEY: PRIMARY KEY (connector_key, instance_id) — covers both the per-instance
// point read (connector_key = $1 AND instance_id = $2) and the reconcile's
// per-connector enumeration (leading column connector_key = $1), so no extra
// index is needed. allow_refs / deny_refs are jsonb arrays of the server-
// qualified {serverId, name} refs (R2-M3); NULL means "none".
export function connectorInstanceToolPolicySchemaQueries(
  schemaName: string,
): { text: string }[] {
  const q = schemaName.replaceAll('"', '""');
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."connector_instance_tool_policy" (
      connector_key text NOT NULL,
      instance_id text NOT NULL,
      mode text NOT NULL,
      allow_refs jsonb,
      deny_refs jsonb,
      updated_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (connector_key, instance_id)
    )`,
    },
  ];
}
