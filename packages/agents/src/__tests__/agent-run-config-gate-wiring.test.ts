// cinatra #1057 ruling (b) — wiring guards for the packages/agents dispatch
// surfaces of the configuration-needs run gate. Both the MCP `agent_run`
// EXECUTION path and the scheduling/trigger FIRE path must route through the
// shared predicate (`assertAgentRunReadyByPackage`) so an agent whose REQUIRED
// connectors are unconfigured cannot be run — dispatched OR fired. The behavioral
// semantics of the predicate live in the root
// `src/lib/__tests__/agent-run-readiness.test.ts`; these SOURCE assertions (same
// convention as `runtime-discovery-surface-wiring.test.ts`) catch a refactor
// silently dropping the gate.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("agent_run (MCP execution) routes through the config-needs run gate", () => {
  const handlers = read("mcp/handlers.ts");

  it("handleAgentBuilderRun calls assertAgentRunReadyByPackage and returns its refusal", () => {
    expect(handlers).toMatch(/assertAgentRunReadyByPackage/);
    expect(handlers).toMatch(/agent-run-readiness/);
    // fail-closed early return on a refusal
    expect(handlers).toMatch(/const notConfigured = await assertAgentRunReadyByPackage/);
    expect(handlers).toMatch(/if \(notConfigured\) return notConfigured/);
  });

  it("gates AFTER the runtime-lifecycle gate (additive), scoped to the caller", () => {
    const lifecycleIdx = handlers.indexOf("assertAgentPackageRunnable");
    const configIdx = handlers.indexOf("assertAgentRunReadyByPackage");
    expect(lifecycleIdx).toBeGreaterThan(-1);
    expect(configIdx).toBeGreaterThan(lifecycleIdx);
    // caller-scoped readiness ctx
    expect(handlers).toMatch(/userId: actor\.userId \?\? null/);
  });
});

describe("scheduling/trigger FIRE path routes through the config-needs run gate", () => {
  const job = read("trigger-release-job.ts");

  it("re-checks readiness at fire time and does NOT release/enqueue when blocked", () => {
    expect(job).toMatch(/agentRunConfigBlockForTrigger/);
    expect(job).toMatch(/assertAgentRunReadyByPackage/);
    // the fire gate runs BEFORE the recurring/scheduled release logic, and
    // returns (skips markTriggerReleased + enqueueAgentRun) on a block.
    const gateIdx = job.indexOf("const fireBlock = await agentRunConfigBlockForTrigger");
    const recurringIdx = job.indexOf("// ---------- Recurring branch ----------");
    const releaseIdx = job.indexOf("await markTriggerReleased(data.runId)");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(recurringIdx);
    expect(gateIdx).toBeLessThan(releaseIdx);
    expect(job).toMatch(/if \(fireBlock\) \{[\s\S]*return;/);
  });

  it("audits WHY the fire was skipped (denied decision, scoped to the run owner)", () => {
    expect(job).toMatch(/logAuditEvent/);
    expect(job).toMatch(/decision:\s*"denied"/);
    expect(job).toMatch(/via:\s*"trigger-fire"/);
    expect(job).toMatch(/userId: run\.runBy \?\? null/);
  });

  it("fails OPEN on a thrown infra error (a glitch never strands the run)", () => {
    expect(job).toMatch(/firing anyway \(fail-open\)/);
  });
});

describe("immediate-trigger surface routes through the config-needs run gate", () => {
  const svc = read("trigger-service.ts");

  it("gates the IMMEDIATE trigger through assertAgentRunReadyByPackage", () => {
    // The immediate trigger transitions the run straight to `queued`, bypassing
    // the fire-time gate — it must have its OWN readiness check.
    expect(svc).toMatch(/immediateTriggerConfigBlock/);
    expect(svc).toMatch(/assertAgentRunReadyByPackage/);
    expect(svc).toMatch(/agent-run-readiness/);
  });

  it("refuses BEFORE any trigger row or schedule is created (fail-closed)", () => {
    const gateIdx = svc.indexOf(
      'const notReady = await immediateTriggerConfigBlock(run.templateId, actor.userId)',
    );
    const upsertIdx = svc.indexOf("await createOrUpdateRunTrigger(");
    const scheduleIdx = svc.indexOf("scheduleResult = await scheduleTrigger(");
    const queuedIdx = svc.indexOf('transitionRunStatus(args.runId, "pending_input", "queued")');
    expect(gateIdx).toBeGreaterThan(-1);
    // the gate runs before the first mutation, the scheduling call, and the
    // immediate→queued transition
    expect(gateIdx).toBeLessThan(upsertIdx);
    expect(gateIdx).toBeLessThan(scheduleIdx);
    expect(gateIdx).toBeLessThan(queuedIdx);
    expect(svc).toMatch(/if \(notReady\) return \{ ok: false, error: notReady \}/);
  });

  it("gates ONLY the immediate type — scheduled/recurring arm without an arm-time config gate", () => {
    expect(svc).toMatch(/if \(args\.triggerType === "immediate"\) \{\s*\n\s*const notReady = await immediateTriggerConfigBlock/);
  });
});
