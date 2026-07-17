// core__0052 — persisted MCP wire transport on external_mcp_servers
// (llm-providers S2, cinatra#1713, epic #1711).
//
// The external-MCP contract carried no transport metadata anywhere (DB row,
// record type, registry-row ABI, toolbox contract, LlmMcpServerTool). S2 makes
// transport first-class DATA so the injection layer never INFERS transport from
// an HTTP URL. This migration adds the storage column on the operator upgrade
// path; legacy rows land on the 'unknown' default and are classified 'unknown'
// end-to-end (the record mapper coerces any unexpected value to 'unknown').
//
// WHY A MIGRATION. The column is additive — the bootstrap DDL
// (buildCreateStoreSchemaQueries in src/lib/drizzle-store.ts, same PR) creates
// it via `ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'unknown'`,
// so a fresh install is born at the target shape and ledger-fakes this chain.
// This module carries the SAME additive column onto the operator upgrade path.
// Idempotent both ways; unqualified names resolve to the runner's search_path
// schema.
//
// down() drops the column (IF EXISTS) — a pure metadata revert. No user-land
// data is destroyed beyond the transport classification itself, which
// re-defaults to 'unknown' on a re-up.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(
    `ALTER TABLE external_mcp_servers ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'unknown'`,
  );
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  pgm.sql(`ALTER TABLE external_mcp_servers DROP COLUMN IF EXISTS transport`);
}
