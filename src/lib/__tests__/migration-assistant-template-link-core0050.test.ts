// Contract test for the template<->principal link migration
// (migrations/core/core__0050_assistant-template-principal-link.mjs, cinatra#1037 P1.3).
//
// The migration module is imported by RELATIVE PATH so the real SQL is
// exercised. Pure unit test (no DB): it pins up()/down() — the additive column,
// the PARTIAL unique index (1:1 over non-null principal links), and a clean
// reversal. The real-Postgres execution against a populated schema is covered by
// scripts/ci/upgrade-proof.sh; the live 1:1 behaviour by the DB-guarded
// agent-templates schema suite.

import { describe, expect, it } from "vitest";

import { up, down } from "../../../migrations/core/core__0050_assistant-template-principal-link.mjs";

function collectSql(fn: (b: { sql: (s: string) => void }) => void): string[] {
  const out: string[] = [];
  fn({ sql: (s: string) => out.push(s) });
  return out;
}

describe("core__0050 up()", () => {
  const stmts = collectSql(up as (b: { sql: (s: string) => void }) => void);
  const joined = stmts.join("\n").toLowerCase();

  it("adds the assistant_user_id column idempotently", () => {
    expect(joined).toContain("add column if not exists assistant_user_id text");
  });

  it("creates the PARTIAL UNIQUE index enforcing the 1:1 over non-null links only", () => {
    expect(joined).toContain("create unique index if not exists agent_templates_assistant_user_id_uniq");
    expect(joined).toContain("on agent_templates (assistant_user_id)");
    expect(joined).toContain("where assistant_user_id is not null");
  });

  it("is purely additive — no CHECK tightening, no NOT NULL on existing data, no backfill", () => {
    expect(joined).not.toContain("not null default");
    expect(joined).not.toContain("add constraint");
    expect(joined).not.toContain("update agent_templates");
  });
});

describe("core__0050 down()", () => {
  const stmts = collectSql(down as (b: { sql: (s: string) => void }) => void);
  const joined = stmts.join("\n").toLowerCase();

  it("is a true reverse — drop the index, then the column, both guarded", () => {
    expect(joined).toContain("drop index if exists agent_templates_assistant_user_id_uniq");
    expect(joined).toContain("drop column if exists assistant_user_id");
    // Index dropped BEFORE the column it indexes.
    expect(joined.indexOf("drop index")).toBeLessThan(joined.indexOf("drop column"));
  });
});
