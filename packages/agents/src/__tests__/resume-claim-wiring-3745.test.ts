/**
 * cinatra#3745 (unit 4097-resume2) — source pins for the resume claim repair.
 *
 * NOTE 6: the stopped-orchestrator resume carries its bound step-tool graph inside
 * the dispatch transaction, from the LOCKED run row's attempt. No caller-supplied
 * prior attempt and no separate rebind export may come back.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";

import { artifactReviewResumeOutbox } from "../schema";
import {
  down as down0116,
  resumeIntentRunClaimDdlSql,
  resumeIntentRunClaimGuardSql,
  up as up0116,
} from "../../../../migrations/core/core__0116_resume-intent-run-claim.mjs";

const SRC = join(__dirname, "..");
const ROOT = join(SRC, "..", "..", "..");
const read = (file: string) => readFileSync(join(SRC, file), "utf8");

describe("NOTE 6: no caller-supplied prior attempt survives", () => {
  it("the old rebind export is gone from serde and from every re-export", () => {
    for (const file of ["agent-run-serde.ts", "store.ts", "run-step-tool-policy-store.ts", "orchestrator-actions.ts"]) {
      expect(read(file), file).not.toContain("rebindRunStepToolPolicyForResume");
    }
  });

  it("the orchestrator resume passes no prior attempt and carries in its one dispatch call", () => {
    const body = read("orchestrator-actions.ts");
    expect(body).not.toContain("priorExecutionAttemptId");
    expect(body).not.toContain("priorAttemptId");
    expect(body).toMatch(/transitionRunStatus\(runId, "queued", "running", \{\s*dispatch: \{ attemptId, carryBoundStepToolPolicy: true \},/);
  });

  it("the carry reads its prior from the run row it locks, inside the guarded dispatch transaction", () => {
    const serde = read("agent-run-serde.ts");
    const carry = serde.slice(serde.indexOf("export async function carryRunStepToolPolicyInTx("));
    expect(carry).toMatch(/\.from\(agentRuns\)[\s\S]{0,120}\.for\("update"\)/);
    expect(carry).toContain("const prior = run.executionAttemptId ?? null;");
    expect(carry.slice(0, carry.indexOf("\n}\n"))).not.toMatch(/input\.prior/);
    const transition = read("run-transition.ts");
    const cas = transition.indexOf("const won = await updateAgentRunStatusConditional(runId, from, to, meta?.dispatch, orgId, guardedTx);");
    const carryCall = transition.indexOf("await carryRunStepToolPolicyInTx(guardedTx,");
    expect(carryCall).toBeGreaterThan(0);
    expect(carryCall).toBeLessThan(cas);
  });
});

describe("D7: the claim mark and send witness, on every schema road", () => {
  const CLAIM_COLUMNS = { run_claimed_at: "timestamptz", resume_task_result: "jsonb" } as const;

  it("Drizzle, the bootstrap twin and core__0116 declare the same two nullable columns", () => {
    const config = getTableConfig(artifactReviewResumeOutbox);
    const twin = readFileSync(join(ROOT, "src/lib/artifacts/artifact-review-gate-schema.ts"), "utf8");
    for (const [name, type] of Object.entries(CLAIM_COLUMNS)) {
      const column = config.columns.find((c) => c.name === name);
      expect(column, name).toBeTruthy();
      expect(column!.notNull, name).toBe(false);
      expect(column!.hasDefault, name).toBe(false);
      const ddl = `ALTER TABLE artifact_review_resume_outbox ADD COLUMN IF NOT EXISTS ${name} ${type};`;
      expect(resumeIntentRunClaimDdlSql).toContain(ddl);
      expect(twin).toContain(
        `ALTER TABLE "\${q}"."artifact_review_resume_outbox" ADD COLUMN IF NOT EXISTS ${name} ${type}\``,
      );
    }
    expect(resumeIntentRunClaimDdlSql).not.toMatch(/UPDATE|INSERT|DELETE|DEFAULT|NOT NULL/i);
  });

  it("up() adds the columns, then runs the rollout guard; down() refuses", () => {
    const applied: string[] = [];
    up0116({ sql: (text: string) => applied.push(text) });
    expect(applied).toEqual([resumeIntentRunClaimDdlSql, resumeIntentRunClaimGuardSql]);
    expect(resumeIntentRunClaimGuardSql).toContain("core__0115_agent-run-outward-action-policy");
    // The same-session test reads the mark 0115 sets, never a clock.
    expect(resumeIntentRunClaimGuardSql).toContain("current_setting('cinatra.core_0115_this_session', true)");
    expect(resumeIntentRunClaimGuardSql).not.toMatch(/run_on|backend_start|now\(\)/);
    expect(resumeIntentRunClaimGuardSql).toMatch(/RAISE EXCEPTION '[^']*agent_run_stop/);
    expect(resumeIntentRunClaimGuardSql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
    expect(() => down0116()).toThrow("resume_intent_run_claim_downgrade_strands_claimed_runs");
  });

  it("the manifest fragment names 0116, its module and its one table, as additive", () => {
    const fragment = JSON.parse(
      readFileSync(join(ROOT, "migrations/manifest.d/core__0116_resume-intent-run-claim.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(fragment).sort()).toEqual(["destructive", "file", "seq", "summary", "tables"]);
    expect(fragment).toMatchObject({
      seq: "0116",
      file: "core/core__0116_resume-intent-run-claim.mjs",
      destructive: false,
      tables: ["artifact_review_resume_outbox"],
    });
  });
});
