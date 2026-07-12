import { describe, it, expect } from "vitest";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

// Schema-drift guard for extension_update_read_model (cinatra#1041 outcome 3),
// mirroring widget-stream-tokens-schema-drift.test.ts. The SINGLE source of
// truth for the table is buildCreateStoreSchemaQueries() (run at every boot via
// ensurePostgresSchema()) — this is a PURELY ADDITIVE new table shipped in the
// idempotent bootstrap, NOT a numbered migration (migrations/README.md: the
// bootstrap owns additive evolution). The DB-backed store adapter
// (src/lib/extension-update-read-model-store.ts) does raw SELECT/INSERT against
// this table, so its columns MUST exist in every DB. This locks the contract so
// a column rename/drop in the SSOT fails here, not silently at runtime.

function ddlFor(table: string): string {
  const queries = buildCreateStoreSchemaQueries("drift_test");
  const create = queries.find((q) =>
    String(q.text).includes(`CREATE TABLE IF NOT EXISTS "drift_test"."${table}"`),
  );
  return create ? String(create.text) : "";
}

describe("extension_update_read_model schema-drift guard", () => {
  const ddl = ddlFor("extension_update_read_model");

  it("the table is created by the boot SSOT", () => {
    expect(ddl).not.toBe("");
  });

  it("declares every column the read-model store reads/writes", () => {
    // package_name is the PK (the per-package upsert key + the ANY(...) read
    // predicate — no extra index needed).
    expect(ddl).toMatch(/package_name text PRIMARY KEY/);
    // latest_version / latest_sdk_abi_range are NULLABLE (null = "no resolvable
    // latest" / "no declared range", distinct from a missing row).
    expect(ddl).toMatch(/latest_version text/);
    expect(ddl).toMatch(/latest_sdk_abi_range text/);
    // refreshedAt drives read-time staleness; timestamptz, NOT NULL.
    expect(ddl).toMatch(/refreshed_at timestamptz NOT NULL/);
  });
});
