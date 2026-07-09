// Contract test for the interaction-axis migration
// (migrations/core/core__0019_agent-kind-assistant-config.mjs, cinatra#1037 P1).
//
// The migration module is imported by RELATIVE PATH so the real SQL is
// exercised. Pure unit test (no DB): it pins the shape of up()/down() — the two
// columns, both invariant CHECK constraints, the kind index, and a clean
// reversal. The real-Postgres execution of the chain against a populated,
// non-fresh schema is covered by scripts/ci/upgrade-proof.sh; the live
// constraint BEHAVIOUR (accept/reject) is covered by the DB-guarded
// agent-templates-schema.test.ts.

import { describe, expect, it } from "vitest";

import { up, down } from "../../../migrations/core/core__0019_agent-kind-assistant-config.mjs";

function collectSql(fn: (b: { sql: (s: string) => void }) => void): string[] {
  const out: string[] = [];
  fn({ sql: (s: string) => out.push(s) });
  return out;
}

describe("core__0019 up()", () => {
  const stmts = collectSql(up as (b: { sql: (s: string) => void }) => void);
  const joined = stmts.join("\n").toLowerCase();

  it("adds agent_kind (NOT NULL DEFAULT 'task') and assistant_config columns, idempotently", () => {
    expect(joined).toContain("add column if not exists agent_kind text not null default 'task'");
    expect(joined).toContain("add column if not exists assistant_config text");
  });

  it("adds the kind-enum CHECK constraint", () => {
    expect(joined).toContain("agent_templates_agent_kind_check");
    expect(joined).toContain("agent_kind in ('assistant', 'task')");
  });

  it("adds the pairing invariant CHECK — assistant requires a config, task carries none", () => {
    expect(joined).toContain("agent_templates_agent_kind_config_check");
    const normalized = joined.replace(/\s+/g, " ");
    expect(normalized).toContain(
      "(agent_kind = 'assistant' and assistant_config is not null) or (agent_kind = 'task' and assistant_config is null)",
    );
  });

  it("guards every constraint add behind an existence check (idempotent re-run)", () => {
    // Each constraint is wrapped in a DO block gated on pg_constraint via
    // current_schema(), so re-applying against a migrated/fresh schema is a no-op.
    expect(joined).toContain("if not exists");
    expect(joined).toContain("current_schema()");
    expect(joined).toContain("pg_constraint");
  });

  it("creates the kind read-index idempotently", () => {
    expect(joined).toContain("create index if not exists agent_templates_agent_kind_idx");
  });

  it("uses unqualified table names (runner sets search_path to the app schema)", () => {
    // No hardcoded schema qualifier on the table — the runner's search_path
    // resolves it, which is what keeps worktree/branch schemas working.
    expect(joined).not.toContain('"public"."agent_templates"');
    expect(joined).not.toContain("public.agent_templates");
  });
});

describe("core__0019 down()", () => {
  const stmts = collectSql(down as (b: { sql: (s: string) => void }) => void);
  const joined = stmts.join("\n").toLowerCase();

  it("drops both constraints, the index, then both columns — all IF EXISTS", () => {
    expect(joined).toContain("drop constraint if exists agent_templates_agent_kind_config_check");
    expect(joined).toContain("drop constraint if exists agent_templates_agent_kind_check");
    expect(joined).toContain("drop index if exists agent_templates_agent_kind_idx");
    expect(joined).toContain("drop column if exists assistant_config");
    expect(joined).toContain("drop column if exists agent_kind");
  });

  it("drops the config constraint before the columns it references", () => {
    const cfgIdx = joined.indexOf("agent_templates_agent_kind_config_check");
    const colIdx = joined.indexOf("drop column if exists assistant_config");
    expect(cfgIdx).toBeGreaterThanOrEqual(0);
    expect(colIdx).toBeGreaterThan(cfgIdx);
  });
});
