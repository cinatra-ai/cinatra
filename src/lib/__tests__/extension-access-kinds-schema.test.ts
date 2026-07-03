// Byte-shape guard for the broadened extension-access CHECK constraints.
//
// Asserts that buildCreateStoreSchemaQueries emits the 8-kind `_kind_check_v3`
// (cinatra#951: + 'connection') for BOTH polymorphic tables and drops the
// legacy 4-kind `_kind_check` AND the 7-kind `_kind_check_v2`.
// Matches against the joined query batch (NOT a snapshot file).

import { describe, expect, it } from "vitest";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

function batchText(): string {
  return buildCreateStoreSchemaQueries("cinatra_test")
    .map((q) => q.text)
    .join("\n");
}

const EIGHT_KINDS =
  /resource_kind IN \('agent_run', 'agent_template', 'skill_package', 'skill', 'connector', 'artifact', 'workflow', 'connection'\)/;

describe("extension-access CHECK broadening", () => {
  const sql = batchText();

  for (const table of ["extension_co_owners", "extension_access_policy"] as const) {
    it(`${table}: drops the legacy 4-kind check`, () => {
      expect(sql).toMatch(
        new RegExp(`DROP CONSTRAINT IF EXISTS ${table}_kind_check\\b`),
      );
    });

    it(`${table}: drops the superseded 7-kind _kind_check_v2 (cinatra#951)`, () => {
      expect(sql).toMatch(
        new RegExp(`DROP CONSTRAINT IF EXISTS ${table}_kind_check_v2\\b`),
      );
    });

    it(`${table}: adds the 8-kind _kind_check_v3`, () => {
      expect(sql).toContain(`${table}_kind_check_v3`);
    });
  }

  it("the v3 check enumerates all eight kinds incl. connection (cinatra#951)", () => {
    const matches = sql.match(new RegExp(EIGHT_KINDS, "g")) ?? [];
    // One occurrence per table.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("no longer hard-codes the legacy 4-kind-only ADD CONSTRAINT list for these tables", () => {
    // The old form added exactly ('agent_run','agent_template','skill_package','skill').
    // After broadening, any IN-list for these tables must include connector.
    const legacyOnly =
      /ADD CONSTRAINT extension_(co_owners|access_policy)_kind_check\b[\s\S]*?CHECK \(resource_kind IN \('agent_run', 'agent_template', 'skill_package', 'skill'\)\)/;
    expect(sql).not.toMatch(legacyOnly);
  });
});
