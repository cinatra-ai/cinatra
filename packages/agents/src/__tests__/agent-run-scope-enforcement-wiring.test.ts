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

/**
 * Index of `needle`, ASSERTED to exist.
 *
 * A bare `indexOf` returns -1 when an anchor is reworded, and -1 silently
 * degrades every window built from it — `slice(0, -1)` becomes "the whole rest
 * of the file", `slice(at - N, …)` counts from the END of the string. A window
 * that quietly grows to the file tail turns the NEGATIVE assertions below
 * (`not.toContain`) into failures with an unrelated cause, or worse, turns a
 * positive assertion into a false pass. Anchoring is therefore always checked.
 */
function at(haystack: string, needle: string): number {
  const i = haystack.indexOf(needle);
  expect(i, `anchor not found in source: ${JSON.stringify(needle)}`).toBeGreaterThan(-1);
  return i;
}

/** A window around `center`, clamped at 0 so a near-file-start anchor cannot
 *  wrap into a negative (= from-the-end) slice. */
function windowAround(src: string, center: number, radius: number): string {
  return src.slice(Math.max(0, center - radius), center + radius);
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

  it("reaches the guard by DYNAMIC import — store.ts is on every locked route", () => {
    // A static edge would pull the guard (and its own graph) into every locked
    // route's first-party module budget for something only a run WRITE needs.
    expect(store).not.toMatch(/^import .*agent-run-serde/m);
    expect(
      (store.match(/await import\(\s*"\.\/agent-run-serde"\s*\)/g) ?? [])
        .length,
    ).toBe(2);
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

  it("stamps a determinate scope at TEMPLATE-WRITE time, never guesses one at read time", () => {
    // The rule must stay fail-closed on a scope-less row, so the org-anchored
    // default belongs at the WRITER. An org-anchored template with no narrower
    // owner is org-scoped; one with no org anchor at all stays scope-less and
    // is refused at run start.
    const body = store.slice(store.indexOf("async function _createAgentTemplateImpl("));
    expect(body).toContain("withDeterminateInstallScope(input)");
    const policy = read("packages/agents/src/auth-policy.ts");
    const helper = policy.slice(policy.indexOf("export function withDeterminateInstallScope"));
    expect(helper).toMatch(/if \(!input\.orgId\) return input;/);
    expect(helper).toMatch(/ownerLevel: "organization", ownerId: input\.orgId/);
    // …and the rule still refuses an unknown level (no read-time coercion).
    expect(policy).toMatch(/reason: "unknown_scope"/);
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

  it("FAILS the run on denial rather than leaving it queued with no job — at the CALLER that holds an authority", () => {
    // A transition-then-enqueue caller moves the run armed→queued and THEN
    // enqueues, so a guard that only throws would strand the run `queued`
    // forever with nothing left to run it. A denial is terminal (the PR
    // contract), never a park.
    //
    // The compensation lives in the CALLER, not in the enqueue chokepoint: the
    // caller already holds a member session authority for this run, whereas the
    // chokepoint would have to mint an org-wide run authority that
    // `org-write-boundary-gate` (R2/R5, RUN_DISPATCH_MINT_CONSUMER_ALLOWLIST)
    // deliberately withholds from it. This test pins BOTH halves of that
    // decision, so a future edit cannot quietly relocate the mint.
    // Assert on the IMPORT and the CALL, not the bare identifier — the
    // chokepoint's comment names the mint to explain why it must not hold it.
    const enqueue = read("src/lib/agent-run-enqueue.ts");
    expect(enqueue).not.toMatch(
      /(?:from|import\()\s*["']@\/lib\/org-write\/agent-run-authority-mint["']/,
    );
    expect(enqueue).not.toMatch(/\bmintAgentRunExecutionAuthority\s*\(/);

    // THE INTERACTIVE SITE THIS HALF PINNED IS GONE (cinatra#2972).
    // `releaseTriggerNowForActor` — Run now — was the transition-then-enqueue
    // caller in `trigger-service.ts`, and plan (A) §7.2 as amended 2026-08-25
    // withdrew the control and its whole action path ("there is no Run now").
    // The property is NOT dropped: the next test below pins it on the site that
    // still has this shape, the trigger release job. What is removed here is an
    // assertion over a function that no longer exists — which `at()` would fail
    // on loudly, and which must not be re-pointed at a lookalike.
    expect(read("packages/agents/src/trigger-service.ts")).not.toContain(
      "releaseTriggerNowForActor",
    );
    expect(read("packages/agents/src/run-actions.ts")).not.toContain(
      "releaseTriggerNow",
    );
  });

  it("compensates on EVERY transition-then-enqueue site, not just the interactive one", () => {
    // The strandable shape is "move the run to `queued`, THEN enqueue": the two
    // guards are separate reads, so a scope change between them leaves a queued
    // run whose enqueue is refused. Each such site must compensate with the
    // authority it already holds — the enqueue chokepoint cannot (R2/R5).
    const releaseJob = read("packages/agents/src/trigger-release-job.ts");
    const at0 = at(releaseJob, "enqueueAgentRun(");
    const block = releaseJob.slice(at0);
    expect(block).toContain("isScopeDenial(err)");
    expect(block).toMatch(/transitionRunStatus\(\s*data\.runId,\s*"queued",\s*"failed"/);
    expect(block).toContain("releaseAuthority");
  });

  it("unwinds the DURABLE trigger gate, not just its row, when a trigger arm is refused", () => {
    // `deleteRunTriggerByRunId` clears only `released_at`. `isTriggerReleased`
    // reads REDIS first, and that flag outlives the row for up to its 7-day TTL
    // — so a later re-trigger on the same run would skip its wait and fire
    // immediately instead of on schedule.
    const gate = read("packages/agents/src/trigger-gate.ts");
    expect(gate).toContain("export async function clearTriggerReleased(");
    const svc = read("packages/agents/src/trigger-service.ts");
    // cinatra#2523 factored the unwind into ONE helper the immediate dispatch
    // calls from every refusal arm (the scope denial and the refused enqueue),
    // so the scan follows it there — the row AND the Redis flag must still be
    // cleared together, which is the actual invariant.
    const at0 = at(svc, "const unwindTrigger = async () => {");
    const unwind = svc.slice(at0, at0 + 1200);
    expect(unwind).toContain("deleteRunTriggerByRunId(runId)");
    expect(unwind).toContain("clearTriggerReleased");
  });

  it("is NOT relaxed by softPreflight — that flag softens configuration, never authorization", () => {
    const enqueue = read("src/lib/agent-run-enqueue.ts");
    const guardBlock = windowAround(
      enqueue,
      at(enqueue, "assertAgentRunDispatchAuthorized"),
      400,
    );
    expect(guardBlock).not.toMatch(/if\s*\(\s*!?\s*softPreflight/);
  });

  it("runs on the →queued transition edge, and NOT on terminal edges", () => {
    const transition = read("packages/agents/src/run-transition.ts");
    const body = transition.slice(
      transition.indexOf("export async function transitionRunStatus("),
    );
    expect(body).toMatch(/if\s*\(to === "queued"\)/);
    // The guard receives the DISPATCHING human when the caller has one. Without
    // it the guard checks only `run_by`, so an interactive caller that admits a
    // non-owner (a co-owner, a platform admin) could drive a dispatch from
    // outside the agent's team/project.
    expect(body).toMatch(/actingUserId: opts\?\.actingUserId/);
    const guardAt = body.indexOf("assertAgentRunDispatchAuthorized");
    const capabilityAt = body.indexOf("const capability:");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(capabilityAt);
    // The guard must be inside the →queued branch only.
    const branchStart = body.indexOf('if (to === "queued")');
    expect(guardAt).toBeGreaterThan(branchStart);
    expect(guardAt - branchStart).toBeLessThan(600);
  });

  it("threads the RESUMING human into the guard on the interactive stopped→queued resume", () => {
    // `resumeStoppedOrchestratorAction` clears `canActOnRun`, which admits a
    // CO-OWNER or a platform admin — actors who are not the run's owner. The
    // `→queued` guard would otherwise evaluate only `run_by` and let an actor
    // outside the agent's team/project resume the run. Same rule as the two HITL
    // gates: both the ACTOR and the run OWNER must be inside the agent's scope.
    const src = read("packages/agents/src/orchestrator-actions.ts");
    const body = src.slice(at(src, "export async function resumeStoppedOrchestratorAction("));
    expect(body).toMatch(
      /transitionRunStatus\(\s*runId,\s*"stopped",\s*"queued",[\s\S]{0,400}?actingUserId: actorUserId/,
    );
    // The sweeper stays owner-bound on purpose — it has no human initiator.
    const sweeper = read("packages/agents/src/artifact-review-resume-delivery.ts");
    expect(sweeper).not.toContain("actingUserId");

    // Threading the actor makes a denial newly REACHABLE at this transition, so
    // it must land as this action's documented opaque result rather than
    // escaping as a raw AgentTemplateScopeError (whose message names the
    // template id, the reason and the level).
    expect(body).toContain("isScopeDenial(err)");
    expect(body).toMatch(/return \{ ok: false, error: "Forbidden" \}/);
  });

  it("maps a scope denial to the typed result AND compensates the durable trigger state", () => {
    // `setRunTriggerForActor` has ALREADY persisted the trigger row and opened
    // its schedule gate by the time the `→queued` guard runs, so a denial that
    // merely threw would leave a refused run holding an armed immediate trigger
    // that no dispatch will ever consume.
    const src = read("packages/agents/src/trigger-service.ts");
    const at0 = at(src, "actingUserId: actor.userId");
    const block = src.slice(at0, at0 + 1600);
    expect(block).toContain("isScopeDenial(err)");
    // Compensation BEFORE the return, mirroring the schedule-failure path.
    // cinatra#2523 named it `unwindTrigger` — the helper asserted above to clear
    // BOTH the row and the Redis flag.
    expect(block).toContain("await unwindTrigger()");
    expect(block.indexOf("await unwindTrigger()")).toBeLessThan(
      block.indexOf('return { ok: false, error: "forbidden" }'),
    );
  });

  it("threads the DISPATCHING admin into the guard on the immediate-trigger arm", () => {
    // `setRunTriggerForActor` admits `role === "admin"` via `isOwnerOrAdmin`, so
    // like the orchestrator resume it can drive a dispatch for a run it does not
    // own. cinatra#2523 turned its single pending_input→queued call into a LADDER
    // of legal `from` states, so the scan checks that EVERY rung is a documented
    // dispatch source and that the one `→queued` call threads the acting human.
    const src = read("packages/agents/src/trigger-service.ts");
    expect(src).toMatch(
      /const IMMEDIATE_DISPATCH_FROM_STATUSES = \[\s*"pending_trigger",\s*"pending_input",\s*"armed",\s*\] as const;/,
    );
    expect(src).toMatch(
      /transitionRunStatus\(runId, from, "queued",[\s\S]{0,200}?actingUserId: actor\.userId/,
    );
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
    // BOTH branches route through the SHARED translation helper: the raw
    // AgentTemplateScopeError message names the template id, the refusal reason
    // and the scope level, so a caller rendering it would leak scope internals
    // AND the template's existence. One helper keeps the two branches in lockstep.
    const translated = [...actions.matchAll(/assertRunScopeOrDeny\(/g)];
    expect(translated.length).toBe(3); // the helper's definition + both call sites
    expect(actions).toContain('throw new Error("Run access denied.")');
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
    const guardAt = at(src, "assertAgentRunDispatchAuthorized");
    expect(guardAt).toBeLessThan(at(src, "client.sendTask("));
    // A refusal closes the intent (it will not become authorized on the next
    // tick); an unreadable check leaves it pending for a later cycle. The block
    // is delimited by CODE tokens, not a fixed byte radius — a radius silently
    // stops covering the branch as soon as the branch grows.
    expect(src).toContain('"refused-out-of-scope"');
    const branch = src.slice(guardAt, at(src, "createExternalA2AClient"));
    expect(branch).toContain("markResumeIntentDelivered");
    expect(branch).toContain('return "retryable"');
    // A refusal must also land the RUN terminally. Closing only the intent would
    // strand the run in `pending_approval` forever: the intent is the only thing
    // that would ever resume it, and the refusal is terminal for that intent.
    // Mirrors the fire-time denial in execution.ts.
    expect(branch).toMatch(
      /transitionRunStatus\(\s*run\.id,\s*"pending_approval",\s*"failed"/,
    );
    // …and it must fail the run BEFORE closing the intent, so a crash between
    // the two re-claims and retries rather than losing the terminal signal.
    expect(branch.indexOf("transitionRunStatus(")).toBeLessThan(
      branch.indexOf("markResumeIntentDelivered"),
    );
    // A TRANSIENT transition failure must NOT close the intent — the intent is
    // the only thing that would ever resume this run, so closing it after a DB
    // blip would strand the run in pending_approval with nothing left to retry.
    // Only the benign lost-CAS (`stale_from_status` = already advanced) closes.
    expect(branch).toContain('"stale_from_status"');
    expect(branch.indexOf('return "retryable"')).toBeLessThan(
      branch.indexOf("markResumeIntentDelivered"),
    );
  });

  it("guards the MCP agent_run_resume WayFlow branch, which enqueues NOTHING", () => {
    // That handler resumes a paused run with a direct `sendTask`: it neither
    // transitions nor enqueues, so both layer-2 chokepoints miss it. Being
    // authorized ON the run (org admin, co-owner) is not being inside the
    // agent's scope.
    const src = read("packages/agents/src/mcp/handlers.ts");
    const guardAt = src.indexOf("assertAgentRunDispatchAuthorized");
    expect(guardAt).toBeGreaterThan(-1);
    expect(windowAround(src, guardAt, 900)).toContain("actingUserId: actor.userId");
    // Before writeHitlPrompt / sendTask — the first irreversible resume steps.
    expect(guardAt).toBeLessThan(src.indexOf("client.sendTask("));
    // The refusal must not distinguish itself from the run-access denial.
    expect(src.slice(guardAt, guardAt + 1200)).toContain('"Run access denied."');
    // Recognized by CODE, not `instanceof` — a refusal must survive a bundle /
    // module-mock boundary.
    expect(src).toContain('AGENT_TEMPLATE_SCOPE_DENIED');
  });

  // WAS: "requires the DISPATCHING admin — not just the run owner — on
  // releaseTriggerNow". That guard existed because Run now was the one
  // interactive dispatch that started SOMEONE ELSE's run early. cinatra#2972
  // removed the control, the server action and the service function together —
  // plan (A) §7.2 as amended 2026-08-25, "there is no Run now" — so the
  // strongest true statement left is that no surface can reach that dispatch at
  // all. Pinned as an ABSENCE, deliberately: an admin-gated dispatch that is
  // gone is safer than one that is guarded, and a re-introduction has to face
  // this test.
  it("no surface can force a schedule's gate open early — Run now is gone entirely", () => {
    for (const rel of [
      "packages/agents/src/trigger-service.ts",
      "packages/agents/src/run-actions.ts",
      "packages/agents/src/run-schedule-tab.tsx",
      "packages/agents/src/schedule-proposal-card.tsx",
      "src/lib/lifecycle/trigger-schedule-proposal-card.ts",
    ]) {
      const src = read(rel);
      expect(src, `${rel} still reaches the withdrawn Run now`).not.toMatch(
        /releaseTriggerNow(?:ForActor)?\s*\(/,
      );
    }
    // The decide endpoint no longer even accepts the op.
    expect(read("src/app/api/lifecycle-views/decide/route.ts")).not.toContain(
      '"release"',
    );
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

  /**
   * The fire-time recheck block: from the recheck call to the first side effect
   * that follows it (`snapshotSkillsAtRunStart`). Both ends are CODE tokens —
   * the previous end anchor was a prose comment ("Version pinning"), which a
   * reword would silently turn into -1 and stretch this window to the file tail.
   */
  const recheckBlock = (): string =>
    body.slice(at(body, 'stage: "execute"'), at(body, "snapshotSkillsAtRunStart"));

  it("rechecks before any side effect and before every dispatch branch", () => {
    const recheckAt = at(body, 'stage: "execute"');
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
    const refusal = recheckBlock();
    expect(refusal).toContain("isScopeDenial(err)");
    expect(refusal).toMatch(/transitionRunStatus\(runId, "queued", "failed"/);
    expect(refusal).not.toContain("OrgArchivedFreezeError");
  });

  it("distinguishes a DENIAL from an UNREADABLE check — the latter parks, never fails", () => {
    // A denial is a decision; an unreadable check is a DB blip. Failing the run
    // on a blip would mean adding an authorization read to the worker prologue
    // made runs less likely to survive — and BullMQ's default `attempts: 1`
    // means a rethrow strands the row `queued` with no job left to retry it.
    const refusal = recheckBlock();
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
    const refusal = recheckBlock();
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
    const guard = read("packages/agents/src/agent-run-serde.ts");
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
    // Two carrier-creating call sites; the actorOverride one is never enqueued,
    // which is exactly why an enqueue-only guard would miss it. Since
    // cinatra#2929 both reach the creation perimeter THROUGH the coordinator's
    // launch entry — the guard is unmoved (it lives inside the creator the
    // coordinator calls), only the road to it is.
    expect((src.match(/await launchAgentRun\(/g) ?? []).length).toBe(2);
    expect(src).not.toContain("createAgentRun(");
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
    expect(gate).toMatch(/shared run-scope guard/);
  });

  it.each([
    [".well-known AgentCard", "src/app/.well-known/agent.json/route.ts"],
    ["A2A mount + AgentCard", "src/lib/a2a-server.ts"],
    ["A2A agent resolver", "packages/a2a/src/agent-resolver.ts"],
    ["A2A skill/server card", "packages/a2a/src/server.ts"],
    ["MCP tool registration", "packages/agents/src/mcp/agent-tools-registry.ts"],
    // cinatra#2935 (lifecycle-b W5d): the chat explicit-dispatch input
    // extraction was a published reader and is GONE with the sentence-matcher
    // it served. The row is struck rather than retargeted because its
    // replacement reads no published templates at all: the widget's one narrow
    // start hands a package NAME to `agent_run` and lets the primitive resolve
    // it, which is the stronger property. The audit below pins that.
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

  it("the widget's named start reads NO published templates and creates NO run itself", () => {
    // cinatra#2935 (lifecycle-b W5d) — the replacement for the struck row above,
    // asserted as the stronger property it actually has. The start resolves
    // nothing and inserts nothing: it hands a package name to `agent_run`, whose
    // own resolver, execute gate and coordinator launch do the work. So there is
    // no published reader to audit here, and the run-creation fence still sees
    // one producer.
    const src = read("src/lib/lifecycle/named-agent-start-mcp.ts");
    expect(src).not.toContain("readPublishedAgentTemplates");
    expect(src).not.toMatch(/insert\(agentRuns\)/);
    expect(src).not.toMatch(/AGENT_BUILDER_EXECUTION/);
    expect(src).toMatch(/primitiveName: "agent_run"/);
  });

  it("built-in assistants are draft + private, so no published reader can reach them", () => {
    const builtin = read("packages/agents/src/builtin-assistant-template.ts");
    expect(builtin).toMatch(/'draft'/);
    expect(builtin).toMatch(/"visibility":\s*"private"|visibility: "private"/);
    // and they are excluded from the published readers by the publication guard.
    const guard = read("packages/agents/src/a2a-publication-guard.ts");
    expect(guard).toContain("readPublishedAgentTemplates");
  });

  /** The install-scope RULE's own source region inside the agent auth-policy
   *  module (the file also owns the unrelated per-run policy evaluation). */
  function scopeRuleSource(): string {
    const src = read("packages/agents/src/auth-policy.ts");
    const start = src.indexOf("export const AGENT_TEMPLATE_SCOPE_LEVELS");
    expect(start).toBeGreaterThan(-1);
    return src
      .slice(start)
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
  }

  it("the rule never reads publication status — publication is not authority", () => {
    const code = scopeRuleSource();
    expect(code).not.toMatch(/\bstatus\b\s*===\s*"published"/);
    expect(code).not.toMatch(/record\.status|template\.status/);
  });

  it("the rule is purpose-built, not a reuse of the extension-access evaluator", () => {
    const code = scopeRuleSource();
    expect(code).not.toMatch(/from\s+"[^"]*enforce-extension-access"/);
    expect(code).not.toContain("evaluateExtensionAccess(");
    // No universal platform-admin grant anywhere in the rule.
    expect(code).not.toMatch(/platformRole\s*===\s*"platform_admin"/);
    expect(code).not.toContain("isPlatformAdmin");
  });
});

// ---------------------------------------------------------------------------
// THE FOURTH STRANDABLE SHAPE — created `queued`, dispatched by the caller
// (cinatra#3033)
// ---------------------------------------------------------------------------
describe("create-queued-then-enqueue sites compensate too", () => {
  // THE SHAPE. `launchAgentRun` with `create.kind: "full"` and
  // `dispatch.kind: "caller_dispatches"` inserts the row ALREADY `queued` and
  // hands the dispatch back; the caller's enqueue is a LATER statement. So
  // between them the run IS a durable `queued` row the chokepoint can refuse —
  // and the chokepoint may not fail it (it holds no org-write authority,
  // org-write-boundary-gate R2/R5). Unfixed, a refused enqueue there left the
  // run `queued` with `started_at` null, `error` null, no trigger and no job,
  // and nothing could ever move it. That is the run state the fourth and fifth
  // proof rounds recorded on this branch.
  //
  // Read as SOURCE for the same reason the rest of this suite does: the
  // guarantee is structural, so a future edit that drops a compensation must
  // fail here rather than silently reopen the strand.

  it("the coordinator owns a compensation for the runs it creates `queued`", () => {
    const coordinator = read("packages/agents/src/lifecycle-coordinator.ts");
    const at0 = at(coordinator, "export async function failRunOnCallerDispatchFailure(");
    const body = coordinator.slice(at0, at0 + 2000);
    // Terminal, not a revert: a run created `queued` never held a waiting state
    // to be returned to, so inventing one would be a lie about its history.
    expect(body).toMatch(/transitionRunStatus\(\s*input\.runId,\s*"queued",\s*"failed"/);
    // And it carries the ONE LINE that says why — the failure floor.
    expect(body).toContain("This run could not be started:");
    // A run a worker already picked up is not this call's to move.
    expect(body).toContain("stale_from_status");
  });

  it("the published-agent-as-tool dispatch compensates its enqueue", () => {
    const registry = read("packages/agents/src/mcp/agent-tools-registry.ts");
    const at0 = at(registry, "await enqueueAgentRun({ runId });");
    const block = registry.slice(at0, at0 + 900);
    expect(block).toContain("failRunOnCallerDispatchFailure");
    // The tool answers with the reason instead of a bare throw the caller
    // cannot act on.
    expect(block).toContain("This run could not be started");
  });

  it("the in-process A2A dispatch compensates its enqueue", () => {
    const a2a = read("packages/agents/src/a2a-actions.ts");
    const at0 = at(a2a, "await enqueueAgentRun({ runId: payload.runId });");
    const block = a2a.slice(at0, at0 + 700);
    expect(block).toContain("failRunOnCallerDispatchFailure");
    // THE AUTHORITY IS PER-RUN, not the action's outer one: the creation
    // callback re-resolves for a run in another org, and compensating with the
    // outer authority would be refused — leaving the strand intact.
    expect(block).toContain("authorityByCreatedRunId.get(payload.runId)");
    expect(block).not.toMatch(/authority:\s*runAuthority\b/);
  });

  it("the external A2A dispatch compensates its enqueue with the run's own authority", () => {
    const server = read("src/lib/a2a-server.ts");
    const at0 = at(server, "createAndEnqueueAgentRun: async (record, options) => {");
    const block = server.slice(at0, at0 + 700);
    expect(block).toContain("compensateDispatch(record.runId");
    const helper = server.slice(at(server, "const compensateDispatch ="), at(server, "const compensateDispatch =") + 700);
    expect(helper).toContain("failRunOnCallerDispatchFailure");
    expect(helper).toContain("takeCreationAuthority(runId)");
  });

  it("the external A2A ledger is TAKEN, never merely read — the mount outlives every run", () => {
    // The mount is process-cached for the life of its generation, so an entry
    // left behind after the dispatch settles retains that run id and its
    // authority for as long as the process lives (convergence review). Every
    // terminal path goes through the take.
    const server = read("src/lib/a2a-server.ts");
    const taker = server.slice(
      at(server, "const takeCreationAuthority ="),
      at(server, "const takeCreationAuthority =") + 400,
    );
    expect(taker).toContain("authorityByCreatedRunId.delete(runId)");
    // The success arms take it too, not just the compensation.
    expect(server).toContain("takeCreationAuthority(record.runId);");
    expect(server).toContain("takeCreationAuthority(payload.runId);");
  });

  it("the coordinator's OWN headless enqueue branch compensates too", () => {
    const coordinator = read("packages/agents/src/lifecycle-coordinator.ts");
    // The headless branch creates the run `queued` (`create.kind: \"full\"`), so
    // a refused enqueue strands it exactly as a caller-dispatched one would.
    const at0 = at(coordinator, "} else {\n      // THE HEADLESS BRANCH STRANDS TOO");
    const block = coordinator.slice(at0, at0 + 1200);
    expect(block).toContain("failRunOnCallerDispatchFailure");
  });

  it("the chokepoint no longer claims same-frame creators cannot strand a run", () => {
    const enqueue = read("src/lib/agent-run-enqueue.ts");
    // The old (false) claim, removed: it was true only of the PRE-DISPATCH
    // creators, and reading it was how the fourth shape stayed unnoticed.
    expect(enqueue).not.toContain("hold no pre-existing `queued` row to strand.");
    expect(enqueue).toContain("failRunOnCallerDispatchFailure");
  });
});

// ---------------------------------------------------------------------------
// A REFUSED RUN-START IS A NAMED REFUSAL, NOT A BLANK (cinatra#3033)
// ---------------------------------------------------------------------------
describe("the run-start road answers a scope refusal with its reason", () => {
  it("createAndTriggerRunCore returns the refusal instead of re-raising it", () => {
    const actions = read("packages/agents/src/run-actions.ts");
    expect(actions).toContain("AGENT_TEMPLATE_SCOPE_DENIED");
    const at0 = at(actions, "const actionable = asActionablePreflightError(enqueueErr);");
    const block = actions.slice(at0, at0 + 1600);
    // MEASURED before the fix on a development boot of this branch: the
    // creation perimeter's refusal was re-raised out of the server component
    // and the person was shown a blank not-found page with no reason on it.
    expect(block).toContain("isScopeDenial(enqueueErr)");
    expect(block).toMatch(/ok:\s*false/);
    expect(block).toContain("scope does not include your organization");
  });
});
