// Bootstrap DDL for connector_instance_confirmation_policy (cinatra#2020 S5 /
// design §3 / §7.2 / D7). The tiny per-`(connector_key, instance_id)` org
// override that turns the require-confirmation default OFF for one instance
// (`mode: 'default' | 'disabled'`). Kept as its OWN table — NOT a column on the
// S2 connector_instance_tool_policy row — so S2's three policy writers and S4
// stay untouched (D7). Absent row = defaults (require ON for chat/session).
//
// PURELY ADDITIVE new table → it ships in the idempotent bootstrap DDL
// (buildCreateStoreSchemaQueries / createStoreTables, src/lib/drizzle-store.ts),
// NOT a numbered core migration. Per migrations/README.md the bootstrap owns
// ADDITIVE evolution (`CREATE TABLE IF NOT EXISTS`, re-run every boot/setup);
// node-pg-migrate is only for TRANSFORMATIONAL change to tables that already
// hold user data. This mirrors connector_instance_tool_policy (cinatra#2017 S2)
// and connector_instance_server (cinatra#2018 S3) — new tables via the bootstrap
// with no migration. Row POPULATION is `setConfirmationPolicy` in
// connector-instance-pending-call-store.ts, never in-DDL enumeration.
//
// A pure string builder with ZERO imports — a synchronous leaf, safe for
// drizzle-store.ts's synchronous require() composition (same contract as
// connector-instance-tool-policy-schema.ts; the postgres-sync-leaf-imports test
// walks this edge).
//
// KEY: PRIMARY KEY (connector_key, instance_id) — the per-instance point read
// (connector_key = $1 AND instance_id = $2) the destructive hook consults. mode
// is stored as a raw string; an unknown value fail-SAFES to require (the reader
// only turns OFF on the exact literal 'disabled'), so no CHECK is needed —
// mirrors the S2 policy table's evaluator-validated `mode`.
export function connectorInstanceConfirmationPolicySchemaQueries(
  schemaName: string,
): { text: string }[] {
  const q = schemaName.replaceAll('"', '""');
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."connector_instance_confirmation_policy" (
      connector_key text NOT NULL,
      instance_id text NOT NULL,
      mode text NOT NULL,
      updated_by text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (connector_key, instance_id)
    )`,
    },
  ];
}
