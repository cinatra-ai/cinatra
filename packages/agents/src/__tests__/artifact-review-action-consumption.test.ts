/**
 * The one-time consumption of a person's approval (cinatra#3745): the table
 * that burns a review gate before an outward effect, as the schema declares it
 * and as the core migration creates it.
 *
 * The gate's id is the table's primary key, so a second consumption of the
 * same gate cannot be written; nothing references a run or a gate, so deleting
 * either never removes a burned gate; and the migration refuses an automatic
 * downgrade, because dropping the burned gates would admit them again.
 */
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";

import { agentRunOutwardActionPolicies, artifactReviewActionConsumptions } from "../schema";
import { core0115SessionMarkSql, down, outwardActionPolicyDdlSql, up } from "../../../../migrations/core/core__0115_agent-run-outward-action-policy.mjs";

const core0115 = { outwardActionPolicyDdlSql, core0115SessionMarkSql, up, down };

function columnsOf(table: Parameters<typeof getTableConfig>[0]) {
  const config = getTableConfig(table);
  return {
    name: config.name,
    primary: config.columns.filter((c) => c.primary).map((c) => c.name),
    notNull: config.columns.filter((c) => c.notNull).map((c) => c.name).sort(),
    all: config.columns.map((c) => c.name).sort(),
    foreignKeys: config.foreignKeys.length,
  };
}

/** The column lines of one `CREATE TABLE IF NOT EXISTS <name> (...)` of the migration. */
function ddlColumns(name: string): string[] {
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([^;]*?)\\n\\s*\\);`).exec(core0115.outwardActionPolicyDdlSql);
  if (!match) throw new Error(`the migration creates no table ${name}`);
  return match[1]!.split(",").map((c) => c.trim().replace(/\s+/g, " ")).filter(Boolean).sort();
}

describe("the one-time consumption of a person's approval", () => {
  it("keys the consumption by the gate, so one gate is burned at most once", () => {
    const table = columnsOf(artifactReviewActionConsumptions);
    expect(table.name).toBe("artifact_review_action_consumptions");
    expect(table.primary).toEqual(["gate_id"]);
    expect(table.all).toEqual(
      ["consumed_at", "executed_source_sha256", "gate_id", "org_id", "run_id", "step_id", "tool_identity"],
    );
    expect(table.notNull).toEqual(table.all);
  });

  it("references neither the run nor the gate, so deleting either never removes a burned gate", () => {
    expect(columnsOf(artifactReviewActionConsumptions).foreignKeys).toBe(0);
    expect(core0115.outwardActionPolicyDdlSql).not.toMatch(/REFERENCES|CASCADE/i);
  });

  it("keys the run's outward-action policy by the run", () => {
    const table = columnsOf(agentRunOutwardActionPolicies);
    expect(table.name).toBe("agent_run_outward_action_policies");
    expect(table.primary).toEqual(["run_id"]);
    expect(table.notNull).toEqual(table.all);
  });

  it("creates both tables in the core migration with the schema's columns and keys", () => {
    expect(ddlColumns("artifact_review_action_consumptions")).toEqual([
      "consumed_at timestamptz NOT NULL DEFAULT now()",
      "executed_source_sha256 text NOT NULL",
      "gate_id text PRIMARY KEY",
      "org_id text NOT NULL",
      "run_id text NOT NULL",
      "step_id text NOT NULL",
      "tool_identity jsonb NOT NULL",
    ]);
    expect(ddlColumns("agent_run_outward_action_policies")).toEqual([
      "created_at timestamptz NOT NULL DEFAULT now()",
      "execution_attempt_id text NOT NULL",
      "org_id text NOT NULL",
      "policy jsonb NOT NULL",
      "run_id text PRIMARY KEY",
    ]);
  });

  it("applies its statements once through the migration runner, and refuses an automatic downgrade", () => {
    const applied: string[] = [];
    core0115.up({ sql: (text: string) => applied.push(text) });
    // Then the session mark core__0116's rollout guard reads; it writes no row.
    expect(applied).toEqual([core0115.outwardActionPolicyDdlSql, core0115.core0115SessionMarkSql]);
    expect(core0115.core0115SessionMarkSql).toBe("SELECT set_config('cinatra.core_0115_this_session', 'on', false);");
    expect(() => core0115.down()).toThrow("outward_action_policy_downgrade_requires_preserved_consumptions");
  });
});
