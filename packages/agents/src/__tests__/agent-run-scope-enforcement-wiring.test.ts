/**
 * cinatra#2485 C — the ENFORCEMENT-WIRING ratchet.
 *
 * The behavioral matrices live in `agent-template-scope.test.ts` (the pure
 * rule) and `agent-run-scope-guard.test.ts` (the shared guard). This suite
 * locks the part a behavioral test cannot see: that the guard is actually
 * INVOKED at all three layers, and that every enumerated run-creation /
 * dispatch path reaches one of those layers instead of a private shortcut.
 *
 * It reads source text on purpose. The whole guarantee of item C is structural
 * — "no path bypasses the gate" — so a future edit that deletes a call, adds a
 * fourth run-INSERT site, or re-introduces a direct BullMQ enqueue must fail
 * here rather than silently reopen the hole.
 *
 * Also carries the PUBLISHED-READER AUDIT: discovery may stay public, but no
 * published-template reader may be treated as run authority.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PKG = join(__dirname, "..");
const REPO = join(PKG, "..", "..", "..");

function read(relFromRepo: string): string {
  return readFileSync(join(REPO, relFromRepo), "utf-8");
}

// ---------------------------------------------------------------------------
// Layer 1 — the canonical creation perimeter
// ---------------------------------------------------------------------------
describe("layer 1: creation perimeter", () => {
  const store = read("packages/agents/src/store.ts");

  it("guards createAgentRun before any derivation or insert", () => {
    const body = store.slice(store.indexOf("export async function createAgentRun("));
    const guardAt = body.indexOf("assertAgentRunScopeAuthorized");
    const deriveAt = body.indexOf("deriveRunOboCeilingJson");
    const insertAt = body.indexOf("guardedRunWrite");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(deriveAt);
    expect(guardAt).toBeLessThan(insertAt);
  });

  it("guards createAgentRunPendingInput before its insert", () => {
    const body = store.slice(
      store.indexOf("export async function createAgentRunPendingInput("),
    );
    const guardAt = body.indexOf("assertAgentRunScopeAuthorized");
    const insertAt = body.indexOf("guardedRunWrite");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(insertAt);
  });

  it("every agent_runs INSERT is downstream of a scope assertion — no third, unguarded writer", () => {
    // Two guarded functions; createAgentRun's idempotent branch inserts twice.
    const guardPositions = [...store.matchAll(/assertAgentRunScopeAuthorized\(/g)].map(
      (m) => m.index ?? -1,
    );
    expect(guardPositions.length).toBe(2);
    const insertPositions = [...store.matchAll(/insert\(agentRuns\)/g)].map(
      (m) => m.index ?? -1,
    );
    expect(insertPositions.length).toBeGreaterThan(0);
    for (const insertAt of insertPositions) {
      expect(guardPositions.some((g) => g < insertAt)).toBe(true);
    }
  });

  it("keeps the scope actor a SERVER-ONLY input, never parsed from a tool payload", () => {
    // No zod request schema anywhere may accept a field of that name, and no
    // run-creation call may read it off the untrusted tool arguments.
    for (const file of [
      "packages/agents/src/mcp/handlers.ts",
      "packages/agents/src/mcp/agent-tools-registry.ts",
      "packages/agents/src/mcp/schemas.ts",
    ]) {
      const src = read(file);
      expect(src).not.toMatch(/scopeActor:\s*z\./);
      expect(src).not.toMatch(/scopeActor:\s*(args|params|inputParams|body|payload)\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the one shared dispatch guard
// ---------------------------------------------------------------------------
describe("layer 2: shared dispatch guard", () => {
  it("runs inside the single BullMQ enqueue chokepoint, before the preflight and the enqueue", () => {
    const enqueue = read("src/lib/agent-run-enqueue.ts");
    const body = enqueue.slice(enqueue.indexOf("export async function enqueueAgentRun("));
    const guardAt = body.indexOf("assertAgentRunDispatchAuthorized");
    const preflightAt = body.indexOf("runConnectorPreflight");
    const enqueueAt = body.indexOf("enqueueBackgroundJob(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(preflightAt);
    expect(guardAt).toBeLessThan(enqueueAt);
  });

  it("is NOT relaxed by softPreflight — that flag softens configuration, never authorization", () => {
    const enqueue = read("src/lib/agent-run-enqueue.ts");
    const guardBlock = enqueue.slice(
      enqueue.indexOf("assertAgentRunDispatchAuthorized") - 400,
      enqueue.indexOf("assertAgentRunDispatchAuthorized") + 400,
    );
    expect(guardBlock).not.toMatch(/if\s*\(\s*!?\s*softPreflight/);
  });

  it("runs on the →queued transition edge, and NOT on terminal edges", () => {
    const transition = read("packages/agents/src/run-transition.ts");
    const body = transition.slice(
      transition.indexOf("export async function transitionRunStatus("),
    );
    expect(body).toMatch(/if\s*\(to === "queued"\)/);
    const guardAt = body.indexOf("assertAgentRunDispatchAuthorized");
    const capabilityAt = body.indexOf("const capability:");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(capabilityAt);
    // The guard must be inside the →queued branch only.
    const branchStart = body.indexOf('if (to === "queued")');
    expect(guardAt).toBeGreaterThan(branchStart);
    expect(guardAt - branchStart).toBeLessThan(600);
  });

  it("keeps enqueueAgentRun the only BullMQ producer (the allowlist is same-run resume only)", () => {
    const enqueue = read("src/lib/agent-run-enqueue.ts");
    // The chokepoint's own doc-comment enumerates the allowlist; every entry is
    // a SAME-RUN re-enqueue or the consumer side.
    for (const allowed of [
      "src/lib/background-jobs.ts",
      "packages/agents/src/orchestrator-execution.ts",
      "packages/agents/src/review-task-actions.ts",
      "packages/agents/src/execution.ts",
    ]) {
      expect(enqueue).toContain(allowed);
    }
  });

  it("guards the HITL resume, which reaches NEITHER layer-2 chokepoint", () => {
    // `resumeRunFromSetupApproval` flips pending_approval→queued with its OWN
    // guarded CAS (not transitionRunStatus), and the re-enqueue uses the
    // allowlisted raw enqueueBackgroundJob (not enqueueAgentRun). The WayFlow
    // branch resumes via a direct sendTask and never enqueues at all. Both
    // branches must therefore assert the gate themselves.
    const resume = read("packages/agents/src/resume-run-from-setup-approval.ts");
    expect(resume).toMatch(/update\(agentRuns\)/);
    // It writes the status itself; it never CALLS transitionRunStatus (only
    // mentions it in prose), so the `→queued` guard cannot see this edge.
    expect(resume).not.toMatch(/\btransitionRunStatus\s*\(/);

    const actions = read("packages/agents/src/review-task-actions.ts");
    const asserts = [...actions.matchAll(/assertAgentRunDispatchAuthorized\(\{/g)];
    expect(asserts.length).toBe(2); // setup- branch + wayflow- branch
    expect(actions).toMatch(/actingUserId: actorId/);
    // Each assertion must precede its branch's first irreversible write.
    const setupAt = actions.indexOf("assertAgentRunDispatchAuthorized");
    expect(setupAt).toBeLessThan(actions.indexOf("resumeRunFromSetupApproval("));
    expect(setupAt).toBeLessThan(actions.indexOf("enqueueBackgroundJob("));
  });

  it("guards the artifact-review resume SWEEPER, whose authorization is as old as its intent", () => {
    // The intent is persisted at gate time and drained later, so its creation-
    // time check is stale by construction. The delivery resumes the paused run
    // with a direct sendTask — no enqueue, no transition — so it too reaches
    // neither layer-2 chokepoint.
    const src = read("packages/agents/src/artifact-review-resume-delivery.ts");
    const guardAt = src.indexOf("assertAgentRunDispatchAuthorized");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(src.indexOf("client.sendTask("));
    // A refusal closes the intent (it will not become authorized on the next
    // tick); an unreadable check leaves it pending for a later cycle.
    expect(src).toContain('"refused-out-of-scope"');
    const branch = src.slice(guardAt, guardAt + 1400);
    expect(branch).toContain("markResumeIntentDelivered");
    expect(branch).toContain('return "retryable"');
  });

  it("guards the MCP agent_run_resume WayFlow branch, which enqueues NOTHING", () => {
    // That handler resumes a paused run with a direct `sendTask`: it neither
    // transitions nor enqueues, so both layer-2 chokepoints miss it. Being
    // authorized ON the run (org admin, co-owner) is not being inside the
    // agent's scope.
    const src = read("packages/agents/src/mcp/handlers.ts");
    const guardAt = src.indexOf("assertAgentRunDispatchAuthorized");
    expect(guardAt).toBeGreaterThan(-1);
    expect(src.slice(guardAt - 900, guardAt + 900)).toContain("actingUserId: actor.userId");
    // Before writeHitlPrompt / sendTask — the first irreversible resume steps.
    expect(guardAt).toBeLessThan(src.indexOf("client.sendTask("));
    // The refusal must not distinguish itself from the run-access denial.
    expect(src.slice(guardAt, guardAt + 1200)).toContain('"Run access denied."');
  });

  it("requires the DISPATCHING admin — not just the run owner — on releaseTriggerNow", () => {
    const src = read("packages/agents/src/run-actions.ts");
    const body = src.slice(src.indexOf("export async function releaseTriggerNow("));
    const guardAt = body.indexOf("assertAgentRunDispatchAuthorized");
    expect(guardAt).toBeGreaterThan(-1);
    expect(body.slice(guardAt, guardAt + 400)).toContain("actingUserId: userId");
    // Before markTriggerReleased: the gate flag is monotonic, so a later
    // refusal could not undo it.
    expect(guardAt).toBeLessThan(body.indexOf("markTriggerReleased("));
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — the worker fire-time recheck
// ---------------------------------------------------------------------------
describe("layer 3: worker fire-time recheck", () => {
  const execution = read("packages/agents/src/execution.ts");
  const body = execution.slice(
    execution.indexOf("async function runAgentBuilderExecutionJobInner("),
  );

  it("rechecks before any side effect and before every dispatch branch", () => {
    const recheckAt = body.indexOf('stage: "execute"');
    expect(recheckAt).toBeGreaterThan(-1);
    for (const sideEffect of [
      "autoApplyHeadlessRecommendation",
      "snapshotSkillsAtRunStart",
      'template.sourceType === "external"',
      "resolveWayflowUrl(",
    ]) {
      expect(body.indexOf(sideEffect)).toBeGreaterThan(recheckAt);
    }
  });

  it("lands a refusal terminally rather than re-delaying the job forever", () => {
    const window = body.slice(body.indexOf('stage: "execute"'));
    const refusal = window.slice(0, window.indexOf("Version pinning"));
    expect(refusal).toContain("AgentTemplateScopeError");
    expect(refusal).toMatch(/transitionRunStatus\(runId, "queued", "failed"/);
    expect(refusal).not.toContain("OrgArchivedFreezeError");
  });

  it("distinguishes a DENIAL from an UNREADABLE check — the latter parks, never fails", () => {
    // A denial is a decision; an unreadable check is a DB blip. Failing the run
    // on a blip would mean adding an authorization read to the worker prologue
    // made runs less likely to survive — and BullMQ's default `attempts: 1`
    // means a rethrow strands the row `queued` with no job left to retry it.
    const window = body.slice(body.indexOf('stage: "execute"'));
    const refusal = window.slice(0, window.indexOf("Version pinning"));
    expect(refusal).toContain("ScopeRecheckUnavailableError");
    // and the unreadable branch must NOT fall through into the dispatch body.
    expect(refusal).toMatch(/throw new ScopeRecheckUnavailableError\(/);

    // The dispatcher must translate it into flow control (no retry consumed),
    // exactly like the archived-org park.
    const registry = read("src/lib/background-jobs-registry.ts");
    expect(registry).toContain("ScopeRecheckUnavailableError");
    const at = registry.indexOf("err instanceof ScopeRecheckUnavailableError");
    expect(at).toBeGreaterThan(-1);
    const branch = registry.slice(at, at + 700);
    expect(branch).toContain("moveToDelayed");
    expect(branch).toContain("DelayedError");
    // …and persist the park ordinal so the worker's cap survives the re-delay.
    expect(branch).toContain("scopeRecheckPark: err.nextAttempt");
  });

  it("BOUNDS the unreadable-check park so a PERMANENT fault still terminates", () => {
    // An archived org is a real state a run waits out; "the check would not
    // read" is either a blip or a permanent fault. Uncapped, the latter loops
    // every 30s forever with no terminal disposition.
    expect(execution).toContain("MAX_SCOPE_RECHECK_PARKS");
    const window = body.slice(body.indexOf('stage: "execute"'));
    const refusal = window.slice(0, window.indexOf("Version pinning"));
    expect(refusal).toMatch(
      /currentScopeRecheckPark >= MAX_SCOPE_RECHECK_PARKS[\s\S]{0,400}transitionRunStatus\(runId, "queued", "failed"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Per-path reachability: every enumerated path funnels into a guarded seam
// ---------------------------------------------------------------------------
const GUARDED_SEAMS = [
  "createAgentRun",
  "createAgentRunPendingInput",
  "enqueueAgentRun",
  "transitionRunStatus",
];

describe.each([
  ["interactive: Run button / chip release", "packages/agents/src/run-actions.ts"],
  ["interactive: registry run action", "packages/agents/src/actions.ts"],
  ["MCP/chat: agent_run handler", "packages/agents/src/mcp/handlers.ts"],
  ["MCP: published-agent-as-tool", "packages/agents/src/mcp/agent-tools-registry.ts"],
  ["A2A: public executor mount", "src/lib/a2a-server.ts"],
  ["A2A: UI action (external + in-process)", "packages/agents/src/a2a-actions.ts"],
  ["delegation: project / PM worker dispatch", "src/lib/project-dispatch.ts"],
  ["host content-editor dispatch", "src/lib/host-content-editor-dispatch.ts"],
  ["scheduled + recurring fires", "packages/agents/src/trigger-release-job.ts"],
  ["lifecycle repair dispatch", "packages/agents/src/lifecycle-repair-dispatch-store.ts"],
])("enumerated path — %s", (_label, file) => {
  it("creates or dispatches ONLY through a guarded seam", () => {
    const src = read(file);
    expect(GUARDED_SEAMS.some((seam) => src.includes(`${seam}(`))).toBe(true);
    // No path may enqueue the execution job behind the chokepoint's back
    // (the same dual pattern `scripts/audit/agent-builder-enqueue-gate.mjs`
    // blocks: the constant reference and the raw literal).
    expect(src).not.toMatch(/BACKGROUND_JOB_NAMES\.AGENT_BUILDER_EXECUTION/);
    expect(src).not.toMatch(/"AGENT_BUILDER_EXECUTION"/);
    // No path may write agent_runs.status directly.
    expect(src).not.toMatch(/update\(agentRuns\)/);
  });
});

describe("paths that carry an explicit actor thread it into the perimeter", () => {
  it.each([
    ["published-agent-as-MCP-tool", "packages/agents/src/mcp/agent-tools-registry.ts"],
    ["public A2A executor", "src/lib/a2a-server.ts"],
    ["UI A2A in-process action", "packages/agents/src/a2a-actions.ts"],
    ["MCP agent_run handler", "packages/agents/src/mcp/handlers.ts"],
    ["project / PM delegation", "src/lib/project-dispatch.ts"],
  ])("%s passes scopeActor", (_label, file) => {
    expect(read(file)).toMatch(/scopeActor/);
  });

  it("the published-agent MCP tool PERSISTS its human requester as runBy", () => {
    // Without a persisted principal the later layers (dispatch, fire time) have
    // no requester to re-check and would fall back to the installation
    // principal — silently substituting a different, possibly still-in-scope
    // human for one who has since lost the scope.
    const src = read("packages/agents/src/mcp/agent-tools-registry.ts");
    expect(src).toMatch(
      /runBy:\s*ctx\?\.principalType === "HumanUser" \? ctx\.principalId : undefined/,
    );
  });

  it("re-resolves every HUMAN principal live instead of trusting the supplied axes", () => {
    const guard = read("packages/agents/src/agent-template-scope-guard.ts");
    expect(guard).toContain("resolveOrgRoleForUser");
    expect(guard).toMatch(/principalType === "HumanUser"[\s\S]{0,120}pushHuman/);
  });

  it("project delegation carries the ORIGINAL seat-run actor, never a manufactured one", () => {
    const src = read("src/lib/project-dispatch.ts");
    expect(src).toMatch(/buildActorContextFromRun\(\{[\s\S]{0,160}parentRun\.id/);
    expect(src).toMatch(/scopeActor: delegatingActor/);
  });

  it("the non-BullMQ content-editor carrier run is covered by the CREATION layer", () => {
    const src = read("src/lib/host-content-editor-dispatch.ts");
    // Two createAgentRun call sites; the actorOverride one is never enqueued,
    // which is exactly why an enqueue-only guard would miss it.
    expect((src.match(/await createAgentRun\(/g) ?? []).length).toBe(2);
    expect(src).not.toContain("enqueueAgentRun");
  });
});

// ---------------------------------------------------------------------------
// PUBLISHED-READER AUDIT — discoverable is never runnable
// ---------------------------------------------------------------------------
describe("published-reader audit", () => {
  it("the slug/id/package-name visibility gate documents itself as DISCOVERY only", () => {
    const store = read("packages/agents/src/store.ts");
    const gate = store.slice(
      store.indexOf("function applyAgentTemplateVisibility("),
      store.indexOf("export async function updateAgentTemplate("),
    );
    expect(gate).toMatch(/DISCOVERY gate ONLY/);
    expect(gate).toMatch(/agent-template-scope-guard/);
  });

  it.each([
    [".well-known AgentCard", "src/app/.well-known/agent.json/route.ts"],
    ["A2A mount + AgentCard", "src/lib/a2a-server.ts"],
    ["A2A agent resolver", "packages/a2a/src/agent-resolver.ts"],
    ["A2A skill/server card", "packages/a2a/src/server.ts"],
    ["MCP tool registration", "packages/agents/src/mcp/agent-tools-registry.ts"],
    ["chat explicit-dispatch input extraction", "src/app/api/chat/explicit-dispatch-server.ts"],
  ])(
    "%s reads published templates but never creates a run outside the guarded perimeter",
    (_label, file) => {
      const src = read(file);
      expect(src).toContain("readPublishedAgentTemplates");
      // The only run-creating symbol any published reader may use is the
      // guarded perimeter itself; a direct agent_runs insert is forbidden.
      expect(src).not.toMatch(/insert\(agentRuns\)/);
      expect(src).not.toMatch(/AGENT_BUILDER_EXECUTION/);
    },
  );

  it("built-in assistants are draft + private, so no published reader can reach them", () => {
    const builtin = read("packages/agents/src/builtin-assistant-template.ts");
    expect(builtin).toMatch(/'draft'/);
    expect(builtin).toMatch(/"visibility":\s*"private"|visibility: "private"/);
    // and they are excluded from the published readers by the publication guard.
    const guard = read("packages/agents/src/a2a-publication-guard.ts");
    expect(guard).toContain("readPublishedAgentTemplates");
  });

  it("the evaluator never reads publication status — publication is not authority", () => {
    const evaluator = read("packages/agents/src/agent-template-scope.ts");
    expect(evaluator).not.toMatch(/\bstatus\b\s*===\s*"published"/);
    expect(evaluator).not.toMatch(/record\.status|template\.status/);
  });

  it("the evaluator is purpose-built, not a reuse of the extension-access evaluator", () => {
    const evaluator = read("packages/agents/src/agent-template-scope.ts");
    const code = evaluator
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/from\s+"[^"]*enforce-extension-access"/);
    expect(code).not.toContain("evaluateExtensionAccess(");
    // No universal platform-admin grant anywhere in the rule.
    expect(code).not.toMatch(/platformRole\s*===\s*"platform_admin"/);
    expect(code).not.toContain("isPlatformAdmin");
  });
});
