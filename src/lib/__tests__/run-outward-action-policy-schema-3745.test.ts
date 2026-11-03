// cinatra#3745 — core__0120's DDL, the bootstrap twins and the Drizzle tables
// describe the same two tables and two outbox columns; the migration never
// backfills authority and never rolls burned gates back. Its guard reads the
// draft migration names, both legacy claim states and the exact operator
// statement. The guard's behaviour on a database is proved by
// run-outward-action-policy-migration-3745.integration.test.ts.
import { describe, it, expect, vi } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
vi.mock("server-only", () => ({}));
import {
  agentRunOutwardActionPolicies,
  artifactReviewActionConsumptions,
  artifactReviewResumeOutbox,
} from "@cinatra-ai/agents/schema";
import { outwardActionPolicySchemaQueries, lifecycleInterceptionsSchemaQueries } from "../artifacts/artifact-review-gate-schema";
import {
  outwardActionPolicyDdlSql,
  resumeIntentRunClaimDdlSql,
  draftDatabaseGuardSql,
  up,
  down,
} from "../../../migrations/core/core__0120_run-outward-action-policy-and-resume-claim.mjs";

const normalize = (s: string) =>
  s.replaceAll('"tenant".', "").replaceAll('"', "").replace(/\s+/g, " ").trim().replace(/;$/, "");

describe("core__0120: migration, bootstrap and schema parity", () => {
  it("the two tables have the same contract on the migration and the fresh bootstrap road", () => {
    const migration = outwardActionPolicyDdlSql.trim().split(";").filter((s: string) => s.trim()).map(normalize);
    expect(outwardActionPolicySchemaQueries("tenant").map((x: { text: string }) => normalize(x.text))).toEqual(migration);
    for (const table of [agentRunOutwardActionPolicies, artifactReviewActionConsumptions]) {
      const config = getTableConfig(table);
      const ddl = migration.find((s: string) => s.includes(` ${config.name} `));
      expect(ddl).toBeTruthy();
      for (const col of config.columns) {
        expect(ddl).toContain(`${col.name} `);
        if (col.primary) expect(ddl).toContain(`${col.name} text PRIMARY KEY`);
      }
    }
  });

  it("the two outbox columns are in the migration, the bootstrap and the Drizzle table", () => {
    const columns = getTableConfig(artifactReviewResumeOutbox).columns.map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["run_claimed_at", "resume_task_result"]));
    const bootstrap = lifecycleInterceptionsSchemaQueries("tenant").map((x: { text: string }) => normalize(x.text)).join("\n");
    for (const col of ["run_claimed_at timestamptz", "resume_task_result jsonb"]) {
      expect(normalize(resumeIntentRunClaimDdlSql)).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
      expect(bootstrap).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
  });

  it("one durable gate key, no cascade, no stored argument approval", () => {
    const table = getTableConfig(artifactReviewActionConsumptions);
    expect(table.columns.filter((c) => c.primary).map((c) => c.name)).toEqual(["gate_id"]);
    expect(table.foreignKeys).toHaveLength(0);
    expect(outwardActionPolicyDdlSql).not.toMatch(/CASCADE|expires_at|approved_args|decider_owner/i);
  });

  it("up runs the DDL before the guard, writes no row, and down refuses", () => {
    const saved = process.env.CINATRA_3745_DRAFT_DB_ACK;
    delete process.env.CINATRA_3745_DRAFT_DB_ACK;
    try {
      const sql: string[] = [];
      up({ sql: (s: string) => sql.push(s) });
      expect(sql).toEqual([outwardActionPolicyDdlSql, resumeIntentRunClaimDdlSql, draftDatabaseGuardSql(false)]);
      expect([outwardActionPolicyDdlSql, resumeIntentRunClaimDdlSql].join("")).not.toMatch(/INSERT|UPDATE|DELETE/);
    } finally {
      if (saved === undefined) delete process.env.CINATRA_3745_DRAFT_DB_ACK;
      else process.env.CINATRA_3745_DRAFT_DB_ACK = saved;
    }
    expect(() => down()).toThrow("outward_action_policy_downgrade_requires_preserved_consumptions");
  });

  it("the guard keys on both draft names, counts delivering and dead-lettered unmarked claims, and needs the exact statement", () => {
    const guard = draftDatabaseGuardSql(false);
    expect(guard).toContain("'core__0115_agent-run-outward-action-policy'");
    expect(guard).toContain("'core__0116_resume-intent-run-claim'");
    expect(guard).toMatch(/o\.status = 'delivering' OR o\.dead_lettered_at IS NOT NULL/);
    expect(guard).toMatch(/o\.run_claimed_at IS NULL/);
    expect(guard).toContain("ack boolean := false");
    expect(draftDatabaseGuardSql(true)).toContain("ack boolean := true");
  });
});
