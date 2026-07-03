// Contract test for the agent_templates.org_id backfill migration
// (migrations/core/core__0013_backfill-agent-template-org-id.mjs, cinatra#847).
//
// The migration module is imported by RELATIVE PATH so the real SQL is
// exercised. This is a pure unit test (no DB): it pins the security-critical
// shape of the backfill — the single-org guard that prevents a cross-tenant
// template from being claimed by one org, the NULL-only guard that keeps it
// idempotent and non-destructive to already-owned rows, and the fact that it
// writes ONLY org_id (so the owner-move trigger never fires). The real-Postgres
// execution of the chain is covered by the repo's upgrade-proof
// (scripts/ci/upgrade-proof.sh), which runs the candidate migration chain
// against a populated, non-fresh schema.

import { describe, expect, it, vi } from "vitest";

import {
  backfillAgentTemplateOrgIdSql,
  up,
  down,
} from "../../../migrations/core/core__0013_backfill-agent-template-org-id.mjs";

describe("core__0013 agent_templates.org_id backfill", () => {
  it("up() issues exactly one pgm.sql with the backfill statement", () => {
    // Minimal MigrationBuilder stand-in: up() only calls pgm.sql.
    const pgm = { sql: vi.fn() };
    (up as (b: { sql: (s: string) => void }) => void)(pgm);
    expect(pgm.sql).toHaveBeenCalledTimes(1);
    expect(pgm.sql).toHaveBeenCalledWith(backfillAgentTemplateOrgIdSql);
  });

  it("backfills agent_templates.org_id from agent_runs", () => {
    const sql = backfillAgentTemplateOrgIdSql.toLowerCase();
    expect(sql).toContain("update agent_templates");
    expect(sql).toContain("from agent_runs");
    expect(sql).toContain("set org_id = sub.org_id");
  });

  it("guards on a SINGLE distinct org — multi-org (cross-tenant) templates are left NULL", () => {
    // The HAVING count(DISTINCT org_id) = 1 clause is the tenant-isolation
    // guard: a NULL-org template whose runs span multiple orgs must NOT be
    // collapsed onto one org. Removing this clause would leak a shared template
    // to whichever org's runs sort first.
    const normalized = backfillAgentTemplateOrgIdSql.toLowerCase().replace(/\s+/g, " ");
    expect(normalized).toContain("having count(distinct org_id) = 1");
  });

  it("only fills rows whose org_id IS NULL (idempotent, never overwrites an owned row)", () => {
    const normalized = backfillAgentTemplateOrgIdSql.toLowerCase().replace(/\s+/g, " ");
    expect(normalized).toContain("t.org_id is null");
  });

  it("writes ONLY org_id — never owner_level / owner_id (so agent_owner_move_trg never fires)", () => {
    const sql = backfillAgentTemplateOrgIdSql.toLowerCase();
    expect(sql).not.toContain("owner_level");
    expect(sql).not.toContain("owner_id");
  });

  it("down() is a no-op and does not throw", () => {
    expect(down).toBeTypeOf("function");
    expect(() => down()).not.toThrow();
    expect(down()).toBeUndefined();
  });
});
