// Contract test for the binding write-path migration
// (migrations/core/core__0040_binding-write-path.mjs, cinatra#1429, epic #1424).
//
// Pure unit test (no DB): pins the shape of up()/down() — the asserted_by CHECK
// widening to include 'system', the two support tables (quarantine + backfill
// checkpoint) with their constraints/indexes, idempotency, and a clean reversal
// — plus bootstrap-DDL parity: the migration and buildCreateStoreSchemaQueries
// must agree, or fresh-install and operator-upgrade paths diverge. Live-DB
// behavior is proven by binding-write-path.integration.test.ts.

import { describe, expect, it } from "vitest";

import { up, down } from "../../../migrations/core/core__0040_binding-write-path.mjs";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

function collectSql(fn: (b: { sql: (s: string) => void }) => void): string {
  const out: string[] = [];
  fn({ sql: (s: string) => out.push(s) });
  return out.join("\n");
}

const upSql = collectSql(up as (b: { sql: (s: string) => void }) => void);
const downSql = collectSql(down as (b: { sql: (s: string) => void }) => void);
const bootstrapSql = buildCreateStoreSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

describe("core__0040 up()", () => {
  it("widens sa_assertedby_chk to admit 'system' (guarded reconcile, only when absent or lacking 'system')", () => {
    expect(upSql).toContain("sa_assertedby_chk");
    expect(upSql).toContain("CHECK (asserted_by IN ('user','authoring_skill','agent','matcher','system'))");
    expect(upSql).toMatch(/position\('system' IN def\) = 0/);
  });

  it("adds object_binding_quarantine (org_id, object_id PK) + type index", () => {
    expect(upSql).toMatch(/CREATE TABLE IF NOT EXISTS object_binding_quarantine/);
    expect(upSql).toContain("CONSTRAINT object_binding_quarantine_pk PRIMARY KEY (org_id, object_id)");
    expect(upSql).toMatch(/CREATE INDEX IF NOT EXISTS object_binding_quarantine_type_idx/);
  });

  it("adds artifact_binding_backfill_checkpoint (scope,type,generation UNIQUE) with status/scope CHECKs", () => {
    expect(upSql).toMatch(/CREATE TABLE IF NOT EXISTS artifact_binding_backfill_checkpoint/);
    expect(upSql).toContain("CONSTRAINT abbc_status_chk CHECK (status IN ('running','done'))");
    expect(upSql).toContain("CONSTRAINT abbc_scope_chk CHECK (scope = 'platform' OR scope LIKE 'org:_%')");
    expect(upSql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS abbc_one_per_key\s+ON artifact_binding_backfill_checkpoint \(scope, object_type_id, generation\)/);
  });

  it("all table adds are idempotent (IF NOT EXISTS)", () => {
    expect(upSql).toMatch(/CREATE TABLE IF NOT EXISTS object_binding_quarantine/);
    expect(upSql).toMatch(/CREATE TABLE IF NOT EXISTS artifact_binding_backfill_checkpoint/);
  });
});

describe("bootstrap-DDL parity (fresh install == operator upgrade)", () => {
  it("the migration and buildCreateStoreSchemaQueries agree on the CHECK + tables + constraints", () => {
    const mustMatch = [
      "sa_assertedby_chk",
      "CHECK (asserted_by IN ('user','authoring_skill','agent','matcher','system'))",
      "object_binding_quarantine",
      "object_binding_quarantine_pk",
      "object_binding_quarantine_type_idx",
      "artifact_binding_backfill_checkpoint",
      "abbc_status_chk",
      "abbc_scope_chk",
      "abbc_one_per_key",
      "CONSTRAINT abbc_status_chk CHECK (status IN ('running','done'))",
    ];
    for (const token of mustMatch) {
      expect(upSql, `migration up() should contain: ${token}`).toContain(token);
      expect(bootstrapSql, `bootstrap should contain: ${token}`).toContain(token);
    }
  });
});

describe("core__0040 down()", () => {
  it("drops both support tables and narrows the CHECK ONLY when no 'system' rows exist (no destructive delete of pinned bindings)", () => {
    // No blanket DELETE of binding rows (they may be pinned by run_context_selections).
    expect(downSql).not.toMatch(/DELETE FROM semantic_assertion/);
    // The narrow is guarded on the absence of 'system' rows.
    expect(downSql).toMatch(/IF EXISTS \(SELECT 1 FROM semantic_assertion WHERE asserted_by = 'system'\)/);
    expect(downSql).toContain("CHECK (asserted_by IN ('user','authoring_skill','agent','matcher'))");
    expect(downSql).toMatch(/DROP TABLE IF EXISTS artifact_binding_backfill_checkpoint/);
    expect(downSql).toMatch(/DROP TABLE IF EXISTS object_binding_quarantine/);
  });
});
