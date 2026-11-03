// Bootstrap DDL for `page_capture_leases` (cinatra#4223), the page capture
// budget's shared store (src/lib/artifacts/page-capture-budget.ts). One row is
// one capture the budget admitted; `released_at` is set when it ends; a lease
// never released stops counting as in flight at `expires_at` but always counts
// toward the run's total. A PURELY ADDITIVE table, so it ships in the idempotent
// bootstrap DDL (buildCreateStoreSchemaQueries), not a numbered migration, like
// connector_instance_pending_call. A zero-import string builder, safe for
// drizzle-store.ts's synchronous composition (postgres-sync-leaf-imports test).

/** The table name, shared by the schema builder, the store and the tests. */
export const PAGE_CAPTURE_LEASES_TABLE = "page_capture_leases";

export function pageCaptureLeasesSchemaQueries(schemaName: string): { text: string }[] {
  const q = schemaName.replaceAll('"', '""');
  return [
    {
      text: `CREATE TABLE IF NOT EXISTS "${q}"."page_capture_leases" (
      id text PRIMARY KEY,
      org_id text NOT NULL,
      run_id text NOT NULL,
      acquired_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      released_at timestamptz,
      CHECK (expires_at > acquired_at)
    )`,
    },
    {
      text: `CREATE INDEX IF NOT EXISTS page_capture_leases_run_idx ON "${q}"."page_capture_leases" (org_id, run_id)`,
    },
  ];
}
