/**
 * Schema regression coverage for custom_skill_assignments.
 *
 * Locks down the SQL schema strings emitted by buildCreateStoreSchemaQueries
 * for the custom_skill_assignments table + custom_skill_owner_type enum.
 *
 * These assertions require the custom_skill_assignments schema SQL to be
 * emitted by src/lib/drizzle-store.ts.
 */
import { describe, it, expect } from "vitest";

// buildCreateStoreSchemaQueries emits schema SQL from src/lib/drizzle-store.ts.
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

function joined(): string {
  const queries = buildCreateStoreSchemaQueries("cinatra") as unknown as Array<
    string | { text?: string }
  >;
  if (!Array.isArray(queries)) return String(queries);
  return queries
    .map((q) => (typeof q === "string" ? q : (q && q.text) || ""))
    .join("\n");
}

describe("custom_skill_assignments schema", () => {
  it("emits a CREATE TYPE custom_skill_owner_type ENUM with all five values", () => {
    const sql = joined();
    expect(sql).toMatch(
      /CREATE TYPE[\s\S]*custom_skill_owner_type[\s\S]*ENUM[^;]*'user'[^;]*'team'[^;]*'project'[^;]*'organization'[^;]*'workspace'/,
    );
  });

  it("emits CREATE TABLE custom_skill_assignments in the cinatra schema", () => {
    const sql = joined();
    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS\s+"cinatra"\."custom_skill_assignments"/,
    );
  });

  it("declares composite PRIMARY KEY (skill_id, agent_id)", () => {
    const sql = joined();
    expect(sql).toMatch(/PRIMARY KEY\s*\(\s*skill_id\s*,\s*agent_id\s*\)/);
  });

  it("creates the two btree indexes (owner_type, owner_id) and (agent_id)", () => {
    const sql = joined();
    expect(sql).toMatch(
      /CREATE INDEX[^;]*custom_skill_assignments[^;]*\(\s*owner_type\s*,\s*owner_id\s*\)/,
    );
    expect(sql).toMatch(
      /CREATE INDEX[^;]*custom_skill_assignments[^;]*\(\s*agent_id\s*\)/,
    );
  });

  it("guards enum creation idempotently with DO $$ ... duplicate_object", () => {
    const sql = joined();
    expect(sql).toMatch(/DO \$\$[\s\S]*duplicate_object[\s\S]*\$\$/);
  });
});
