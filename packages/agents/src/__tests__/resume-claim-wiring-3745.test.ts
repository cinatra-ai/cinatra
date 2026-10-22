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

const SRC = join(__dirname, "..");
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
