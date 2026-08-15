// DDL parity for `agent_run_hitl_gates` (cinatra#2748).
//
// The table has TWO homes that must agree: the fresh-install bootstrap DDL
// (`agentRunHitlGatesSchemaQueries`, spread into
// `buildCreateStoreSchemaQueries`) and the operator-upgrade migration
// (`migrations/core/core__0093`). A fresh install that gets the table while an
// upgraded instance does not — or the reverse — is a silent split-brain: every
// paused run on the instance without the table keeps the exact Redis-expiry
// defect this change removes.
//
// This suite pins the SHAPE so a drift is caught without a database. The
// behavioural two-arm proof against a real Postgres is out of this suite's
// scope; the store's own SQL contract is pinned in
// `packages/agents/src/__tests__/durable-hitl-gate-store.test.ts`.
import { describe, expect, it } from "vitest";

import {
  AGENT_RUN_HITL_GATES_LATEST_INDEX,
  AGENT_RUN_HITL_GATES_TABLE,
  agentRunHitlGatesSchemaQueries,
} from "@/lib/artifacts/artifact-review-gate-schema";
import { agentRunHitlGatesDdlSql } from "../../../migrations/core/core__0093_agent-run-hitl-gate-artifacts.mjs";

const bootstrap = agentRunHitlGatesSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

const BOTH: Array<[string, string]> = [
  ["fresh-install bootstrap", bootstrap],
  ["operator-upgrade migration", agentRunHitlGatesDdlSql],
];

describe("agent_run_hitl_gates — DDL parity between the two homes", () => {
  it.each(BOTH)("%s creates the table idempotently", (_name, sql) => {
    expect(sql).toMatch(
      new RegExp(`CREATE TABLE IF NOT EXISTS[^(]*${AGENT_RUN_HITL_GATES_TABLE}`),
    );
  });

  it.each(BOTH)("%s carries everything a surface needs to render the gate", (_name, sql) => {
    expect(sql).toMatch(/x_renderer\s+text NOT NULL/);
    expect(sql).toMatch(/input_schema\s+jsonb NOT NULL/);
    expect(sql).toMatch(/gate_values\s+jsonb NOT NULL/);
    // Setup-loop gates only, so nullable.
    expect(sql).toMatch(/field_name\s+text,/);
    expect(sql).toMatch(/materialized_at timestamptz NOT NULL DEFAULT now\(\)/);
    expect(sql).toMatch(/created_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it.each(BOTH)("%s keys the row on the gate identity", (_name, sql) => {
    // The PK is what makes a re-park an UPSERT instead of a duplicate row.
    expect(sql).toMatch(/PRIMARY KEY \(run_id, review_task_id\)/);
  });

  it.each(BOTH)("%s cascades from the run so the row needs no retention job", (_name, sql) => {
    expect(sql).toMatch(/run_id\s+text NOT NULL REFERENCES[\s\S]*agent_runs.*\(id\) ON DELETE CASCADE/);
  });

  it.each(BOTH)("%s indexes the newest-gate lookup the fallback reader drives", (_name, sql) => {
    expect(sql).toMatch(
      new RegExp(
        `CREATE INDEX IF NOT EXISTS ${AGENT_RUN_HITL_GATES_LATEST_INDEX}[\\s\\S]*\\(run_id, materialized_at DESC\\)`,
      ),
    );
  });

  it("qualifies the bootstrap form with the app schema and leaves the migration bare", () => {
    expect(agentRunHitlGatesSchemaQueries("cinatra")[0]!.text).toContain(
      `"cinatra"."${AGENT_RUN_HITL_GATES_TABLE}"`,
    );
    // The runner sets search_path, so the migration must NOT hard-code a schema.
    expect(agentRunHitlGatesDdlSql).not.toContain('"cinatra"');
  });

  it("escapes a quote in the schema identifier", () => {
    expect(agentRunHitlGatesSchemaQueries('we"ird')[0]!.text).toContain('"we""ird"');
  });
});
