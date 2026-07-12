// Contract test for the semantic_assertion binding-basis migration
// (migrations/core/core__0036_semantic-assertion-binding-basis.mjs,
// cinatra#1426, epic #1424).
//
// The migration module is imported by RELATIVE PATH so the real SQL is
// exercised. Pure unit test (no DB): it pins the shape of up()/down() — the
// two columns (with the 'classic' backfill DEFAULT), the constraint set, the
// ONE-ACTIVE-BINDING partial unique index, the (org, extension, artifact)
// lookup index, the frozen-trigger replacement, idempotency, and a clean
// reversal — plus the bootstrap-DDL parity: the migration and
// `buildCreateStoreSchemaQueries` must agree, or the fresh-install and
// operator-upgrade paths diverge. ACCEPTANCE-CRITERIA-bearing properties:
//   AC-2: a second ACTIVE binding for the same artifact (any extension) is
//         rejected by `sa_one_active_binding_idx` (the DDL half; the live-DB
//         half is the binding-basis integration test).
//   Vocabulary sync: the DDL CHECK value set equals ASSERTION_BASES in the
//         pure @cinatra-ai/objects/effective-identity leaf.

import { describe, expect, it } from "vitest";

import {
  ASSERTION_BASES,
  GENERIC_ARTIFACT_OBJECT_TYPE,
} from "@cinatra-ai/objects/effective-identity";
import { SEMANTIC_ARTIFACT_OBJECT_TYPE } from "@cinatra-ai/artifacts";

import { up, down } from "../../../migrations/core/core__0036_semantic-assertion-binding-basis.mjs";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

function collectSql(fn: (b: { sql: (s: string) => void }) => void): string[] {
  const out: string[] = [];
  fn({ sql: (s: string) => out.push(s) });
  return out;
}

const upSql = collectSql(up as (b: { sql: (s: string) => void }) => void).join("\n");
const downSql = collectSql(down as (b: { sql: (s: string) => void }) => void).join("\n");
const bootstrapSql = buildCreateStoreSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

describe("core__0036 up()", () => {
  it("adds assertion_basis (NOT NULL DEFAULT 'classic' — the backfill) and binding_generation, idempotently", () => {
    expect(upSql).toContain(
      "ALTER TABLE semantic_assertion ADD COLUMN IF NOT EXISTS assertion_basis text NOT NULL DEFAULT 'classic'",
    );
    expect(upSql).toContain(
      "ALTER TABLE semantic_assertion ADD COLUMN IF NOT EXISTS binding_claim_id text",
    );
    expect(upSql).toContain(
      "ALTER TABLE semantic_assertion ADD COLUMN IF NOT EXISTS binding_generation integer",
    );
  });

  it("AC-2 backing: partial unique index — ONE ACTIVE binding per artifact ACROSS ALL EXTENSIONS", () => {
    expect(upSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS sa_one_active_binding_idx ON semantic_assertion \(org_id, artifact_id\) WHERE assertion_basis = 'binding' AND eligibility <> 'archived'/,
    );
  });

  it("adds the (org, extension, artifact) lookup index", () => {
    expect(upSql).toMatch(
      /CREATE INDEX IF NOT EXISTS sa_extension_artifact_idx ON semantic_assertion \(org_id, extension, artifact_id\)/,
    );
  });

  it("keeps the basis vocabulary in sync with the pure effective-identity leaf", () => {
    expect(upSql).toContain(
      `CHECK (assertion_basis IN (${ASSERTION_BASES.map((b) => `'${b}'`).join(",")}))`,
    );
  });

  it("a binding ALWAYS carries its claim row + activation generation; a classic row NEVER does", () => {
    expect(upSql).toContain("CHECK ((assertion_basis = 'binding') = (binding_generation IS NOT NULL))");
    expect(upSql).toContain("CHECK ((assertion_basis = 'binding') = (binding_claim_id IS NOT NULL))");
  });

  it("matcher drafts never produce bindings (DB-enforced)", () => {
    expect(upSql).toContain("CHECK (assertion_basis <> 'binding' OR asserted_by <> 'matcher')");
  });

  it("constraint adds are guarded (idempotent re-run on a bootstrap-seeded schema)", () => {
    for (const constraint of ["sa_basis_chk", "sa_binding_generation_chk", "sa_binding_claim_chk", "sa_binding_never_matcher_chk"]) {
      expect(upSql).toMatch(new RegExp(`IF NOT EXISTS \\([\\s\\S]*?constraint_name = '${constraint}'`));
    }
  });

  it("REPLACES the frozen trigger fn to also freeze assertion_basis + binding_generation (binding mutations are new INSERTs, never UPDATEs)", () => {
    expect(upSql).toContain("CREATE OR REPLACE FUNCTION fn_semantic_assertion_frozen()");
    expect(upSql).toMatch(/NEW\.assertion_basis <> OLD\.assertion_basis/);
    expect(upSql).toMatch(/NEW\.binding_claim_id IS DISTINCT FROM OLD\.binding_claim_id/);
    expect(upSql).toMatch(/NEW\.binding_generation IS DISTINCT FROM OLD\.binding_generation/);
  });
});

describe("bootstrap-DDL parity (fresh install == operator upgrade)", () => {
  it("the migration and buildCreateStoreSchemaQueries agree on columns, constraints, indexes", () => {
    const mustMatch = [
      "assertion_basis",
      "binding_claim_id",
      "binding_generation",
      "sa_basis_chk",
      "sa_binding_generation_chk",
      "sa_binding_claim_chk",
      "sa_binding_never_matcher_chk",
      "sa_one_active_binding_idx",
      "sa_extension_artifact_idx",
      "CHECK (assertion_basis IN ('binding','classic'))",
      "CHECK ((assertion_basis = 'binding') = (binding_generation IS NOT NULL))",
      "CHECK ((assertion_basis = 'binding') = (binding_claim_id IS NOT NULL))",
      "CHECK (assertion_basis <> 'binding' OR asserted_by <> 'matcher')",
    ];
    for (const token of mustMatch) {
      expect(upSql).toContain(token);
      expect(bootstrapSql).toContain(token);
    }
    // The bootstrap frozen-fn freezes the new columns too (same body).
    expect(bootstrapSql).toMatch(/NEW\.assertion_basis <> OLD\.assertion_basis/);
    expect(bootstrapSql).toMatch(/NEW\.binding_claim_id IS DISTINCT FROM OLD\.binding_claim_id/);
    expect(bootstrapSql).toMatch(/NEW\.binding_generation IS DISTINCT FROM OLD\.binding_generation/);
    // The bootstrap ALSO carries the live-schema ALTER path (existing
    // deployments get the columns before the migration chain runs).
    expect(bootstrapSql).toContain("ADD COLUMN IF NOT EXISTS assertion_basis text NOT NULL DEFAULT 'classic'");
    expect(bootstrapSql).toContain("ADD COLUMN IF NOT EXISTS binding_claim_id text");
    expect(bootstrapSql).toContain("ADD COLUMN IF NOT EXISTS binding_generation integer");
  });

  it("the pure leaf's generic-artifact literal equals the canonical @cinatra-ai/artifacts constant", () => {
    // @cinatra-ai/objects cannot depend on @cinatra-ai/artifacts, so the leaf
    // mirrors the literal — this pins the two constants equal.
    expect(GENERIC_ARTIFACT_OBJECT_TYPE).toBe(SEMANTIC_ARTIFACT_OBJECT_TYPE);
  });
});

describe("core__0036 down()", () => {
  it("restores the pre-0036 trigger body BEFORE dropping the columns it references", () => {
    expect(downSql).toContain("CREATE OR REPLACE FUNCTION fn_semantic_assertion_frozen()");
    const fnIdx = downSql.indexOf("CREATE OR REPLACE FUNCTION fn_semantic_assertion_frozen()");
    const dropIdx = downSql.indexOf("DROP COLUMN IF EXISTS assertion_basis");
    expect(fnIdx).toBeGreaterThan(-1);
    expect(dropIdx).toBeGreaterThan(fnIdx);
    // The restored body must NOT reference the dropped columns.
    const restoredBody = downSql.slice(fnIdx, downSql.indexOf("$body$;", fnIdx));
    expect(restoredBody).not.toContain("assertion_basis");
    expect(restoredBody).not.toContain("binding_claim_id");
    expect(restoredBody).not.toContain("binding_generation");
  });

  it("drops the indexes, constraints, and columns — nothing else", () => {
    expect(downSql).toContain("DROP INDEX IF EXISTS sa_one_active_binding_idx");
    expect(downSql).toContain("DROP INDEX IF EXISTS sa_extension_artifact_idx");
    for (const constraint of ["sa_basis_chk", "sa_binding_generation_chk", "sa_binding_claim_chk", "sa_binding_never_matcher_chk"]) {
      expect(downSql).toContain(`DROP CONSTRAINT IF EXISTS ${constraint}`);
    }
    expect(downSql).toContain("DROP COLUMN IF EXISTS assertion_basis");
    expect(downSql).toContain("DROP COLUMN IF EXISTS binding_claim_id");
    expect(downSql).toContain("DROP COLUMN IF EXISTS binding_generation");
    expect(downSql).not.toMatch(/DROP TABLE/);
  });
});
