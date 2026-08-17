/**
 * cinatra#2835 — a recommendation HOLD is a human wait, so it notifies.
 *
 * You start an agent from the chat, the skills-recommendation card asks you to
 * confirm or skip, and you walk away. The run waits, not started — and before
 * this change nobody was told: the bell stayed empty, while the very same
 * "needs your input" notification the #2729 ruling gives an unanswered input
 * field existed all along one seam over.
 *
 * The hold could not ride the existing path by construction. `onEnterHumanWait`
 * is driven by `dispatchRunWaitTransition`, which only fires on a STATUS
 * TRANSITION classified as a human wait — and a hold changes no status: the run
 * is ALREADY `pending_input` (created that way) and is simply never dispatched,
 * parked on a continuation park instead. So this slice adds the direct seam
 * (`dispatchRunHumanWaitEntered` / `dispatchRunHumanWaitLeft`) and the
 * `waitKind` classification the host cannot derive for a run that carries no
 * HITL interrupt.
 *
 * This file covers the PACKAGE side: the seam dispatchers, their REFUSAL to
 * notify a wait with no live hold behind it, and the hold's own wiring (a NEW
 * hold notifies exactly once; an already-parked re-hold does not re-notify; a
 * release delegates to the sweeper). The CLEAR is deliberately not pinned here —
 * it lives in the release primitive, which this file mocks; it is pinned against
 * the real primitive in recommendation-hold.integration.test.ts. The HOST half —
 * the "needs your input" copy and the conversation deep-link — is pinned in
 * src/lib/__tests__/agent-run-wait-notifications.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const recommendSkillsForAgentTask = vi.fn();
const resolveOrgPolicyRule = vi.fn();
const getAssignedSkillIdsForAgent = vi.fn();
const maybeParkCheckpoint = vi.fn();
const sweepParks = vi.fn();
const readContinuationParksForRun = vi.fn();
const resolveAssignedSkillsActorForRun = vi.fn();

vi.mock("@cinatra-ai/skills/recommendation-server", () => ({
  recommendSkillsForAgentTask: (...a: unknown[]) => recommendSkillsForAgentTask(...a),
}));
vi.mock("../lifecycle-policy-store", () => ({
  resolveOrgPolicyRule: (...a: unknown[]) => resolveOrgPolicyRule(...a),
  POLICY_ARTIFACT_TYPE_WILDCARD: "*",
}));
vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: (...a: unknown[]) => getAssignedSkillIdsForAgent(...a),
}));
vi.mock("@/lib/agent-run-actor-resolve", () => ({
  resolveAssignedSkillsActorForRun: (...a: unknown[]) => resolveAssignedSkillsActorForRun(...a),
}));
vi.mock("../lifecycle-continuation-park-store", () => ({
  maybeParkCheckpoint: (...a: unknown[]) => maybeParkCheckpoint(...a),
  sweepParks: (...a: unknown[]) => sweepParks(...a),
  readContinuationParksForRun: (...a: unknown[]) => readContinuationParksForRun(...a),
}));

import {
  maybeHoldRunForRecommendation,
  releaseRecommendationParkForRun,
} from "../recommendation-hold";
import {
  setRunWaitNotifier,
  dispatchRunHumanWaitEntered,
  dispatchRunHumanWaitLeft,
  type RunHoldBinding,
  type RunWaitNotifier,
} from "../run-wait-notifier";

/** A LIVE recommendation hold — the binding the enter seam now requires. */
const hold = (over: Partial<RunHoldBinding> = {}): RunHoldBinding => ({
  id: "park-1",
  runId: "run-9",
  checkpoint: "recommendation",
  status: "parked",
  ...over,
});

const onEnterHumanWait = vi.fn();
const onLeaveHumanWait = vi.fn();

/** The fake park table behind the mocked store (see beforeEach). */
type FakePark = { id: string; runId: string; checkpoint: string; status: string };
const parkRows: FakePark[] = [];
let parkSeq = 0;

function wireNotifier(over: Partial<RunWaitNotifier> = {}) {
  setRunWaitNotifier({
    onEnterHumanWait: (...a: Parameters<RunWaitNotifier["onEnterHumanWait"]>) =>
      onEnterHumanWait(...a),
    onLeaveHumanWait: (...a: Parameters<RunWaitNotifier["onLeaveHumanWait"]>) =>
      onLeaveHumanWait(...a),
    ...over,
  } as RunWaitNotifier);
}

const run = (over: Record<string, unknown> = {}) => ({
  id: "run-1",
  orgId: "org-1",
  runBy: "user-1",
  sourceType: "agent_builder",
  humanPresent: true,
  inputParams: { prompt: "write a blog" },
  ...over,
});

const template = (over: Record<string, unknown> = {}) => ({
  packageName: "@vendor/agent",
  ...over,
});

const RUN_ACTOR = {
  principalType: "HumanUser" as const,
  principalId: "user-1",
  organizationId: "org-1",
  teamIds: ["team-a"],
  projectIds: ["proj-a"],
  platformRole: "platform_admin" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  wireNotifier();
  // A human-present run whose checkpoint FIRES with a candidate → it parks.
  resolveOrgPolicyRule.mockResolvedValue({ bound: "silent" });
  resolveAssignedSkillsActorForRun.mockResolvedValue(RUN_ACTOR);
  getAssignedSkillIdsForAgent.mockResolvedValue(["s1"]);
  recommendSkillsForAgentTask.mockResolvedValue([
    {
      skillId: "s1",
      skillRevisionId: "s1@rev1",
      name: "Skill One",
      score: 0.9,
      rank: 1,
      recommended: true,
      scoredFeatures: [],
    },
  ]);
  // A STATEFUL park fake, because the hold now RE-READS the park it just wrote
  // before notifying (the liveness half of the hold binding — see
  // `maybeHoldRunForRecommendation`). A flat `mockResolvedValue([])` would model a
  // store in which the row vanishes the instant it is inserted.
  parkRows.length = 0;
  parkSeq = 0;
  readContinuationParksForRun.mockImplementation(async (runId: string) =>
    parkRows.filter((p) => p.runId === runId),
  );
  maybeParkCheckpoint.mockImplementation(async (_outcome: unknown, input: { runId: string }) => {
    const id = `park-${++parkSeq}`;
    parkRows.push({ id, runId: input.runId, checkpoint: "recommendation", status: "parked" });
    return { parked: true, parkId: id, reason: "parked" };
  });
  sweepParks.mockResolvedValue({ released: 1 });
});

afterEach(() => {
  // Never leak the wired notifier into another test file's module singleton.
  setRunWaitNotifier(null);
});

describe("cinatra#2835 — the direct human-wait seam", () => {
  it("dispatchRunHumanWaitEntered drives onEnterHumanWait with the INPUT classification", async () => {
    await dispatchRunHumanWaitEntered({
      runId: "run-9",
      reason: "pending_input",
      waitKind: "input",
      hold: hold(),
    });
    expect(onEnterHumanWait).toHaveBeenCalledTimes(1);
    // The hold binding is a GUARD, not payload — the host contract is unchanged.
    expect(onEnterHumanWait).toHaveBeenCalledWith({
      runId: "run-9",
      reason: "pending_input",
      waitKind: "input",
    });
  });

  it("dispatchRunHumanWaitLeft drives the idempotent clear", async () => {
    await dispatchRunHumanWaitLeft({ runId: "run-9" });
    expect(onLeaveHumanWait).toHaveBeenCalledWith({ runId: "run-9" });
  });

  it("both are no-ops when no host wired a notifier", async () => {
    setRunWaitNotifier(null);
    await expect(
      dispatchRunHumanWaitEntered({ runId: "run-9", reason: "pending_input", hold: hold() }),
    ).resolves.toBeUndefined();
    await expect(dispatchRunHumanWaitLeft({ runId: "run-9" })).resolves.toBeUndefined();
  });

  it("swallows a throwing notifier — a notification can never fail a parked hold", async () => {
    onEnterHumanWait.mockRejectedValueOnce(new Error("notifications down"));
    onLeaveHumanWait.mockRejectedValueOnce(new Error("notifications down"));
    await expect(
      dispatchRunHumanWaitEntered({
        runId: "run-9",
        reason: "pending_input",
        waitKind: "input",
        hold: hold(),
      }),
    ).resolves.toBeUndefined();
    await expect(dispatchRunHumanWaitLeft({ runId: "run-9" })).resolves.toBeUndefined();
  });
});

/**
 * Codex convergence round 2, finding 2 — the enter seam is BOUND TO THE HOLD.
 *
 * Before this, the seam was exported and forwarded a caller-supplied {runId,
 * reason, waitKind} unconditionally: it verified no park and bound to no hold
 * identifier, so any code path could FABRICATE a "needs your input" row against
 * any `pending_input` run with no hold behind it — and because a hold moves no run
 * status, nothing would ever clear that row. Every case below is a REFUSAL: the
 * notifier is not driven at all.
 */
describe("cinatra#2835 — the enter seam REFUSES a wait with no live hold", () => {
  it("refuses a fabricated dispatch with NO hold at all — the case the old seam allowed", async () => {
    // The `hold` argument is REQUIRED, so this does not even typecheck without
    // the cast; the cast is the point — it reproduces, at runtime, exactly what
    // arbitrary caller code used to be able to do. It must write nothing.
    await dispatchRunHumanWaitEntered({
      runId: "run-victim",
      reason: "pending_input",
      waitKind: "input",
    } as unknown as Parameters<typeof dispatchRunHumanWaitEntered>[0]);
    expect(onEnterHumanWait).not.toHaveBeenCalled();
  });

  it("refuses a hold belonging to ANOTHER run — no minting a row against a run you do not hold", async () => {
    await dispatchRunHumanWaitEntered({
      runId: "run-victim",
      reason: "pending_input",
      waitKind: "input",
      hold: hold({ runId: "run-9" }),
    });
    expect(onEnterHumanWait).not.toHaveBeenCalled();
  });

  it("refuses a park that is NOT a recommendation hold — an auto-gate park notifies elsewhere", async () => {
    // A `review` park's wait notifies through onAutoGateOpen; a second row here
    // would double-ring the same wait under a key its resolve never clears.
    await dispatchRunHumanWaitEntered({
      runId: "run-9",
      reason: "pending_input",
      waitKind: "input",
      hold: hold({ checkpoint: "review" }),
    });
    expect(onEnterHumanWait).not.toHaveBeenCalled();
  });

  it("refuses an ALREADY-TERMINAL park — a wait that is over must never mint a row", async () => {
    // Both terminal states: the decision-resolved release and the TTL fail-close.
    // Minting for either is precisely the permanently-stale row this issue exists
    // to prevent (nothing would clear it — the park cannot transition twice).
    for (const status of ["released", "policy_unresolved"] as const) {
      await dispatchRunHumanWaitEntered({
        runId: "run-9",
        reason: "pending_input",
        waitKind: "input",
        hold: hold({ status }),
      });
    }
    expect(onEnterHumanWait).not.toHaveBeenCalled();
  });

  it("a refusal is silent, never a throw — a notification can never fail a hold", async () => {
    await expect(
      dispatchRunHumanWaitEntered({
        runId: "run-victim",
        reason: "pending_input",
        hold: hold({ status: "released" }),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("cinatra#2835 — entering a hold notifies the run's initiator", () => {
  it("a NEW hold dispatches the human-wait enter exactly once, classified as input", async () => {
    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(true);

    expect(onEnterHumanWait).toHaveBeenCalledTimes(1);
    expect(onEnterHumanWait).toHaveBeenCalledWith({
      // The run's ACTUAL status — the hold parks an already-`pending_input` run
      // rather than moving it, so no consumer's state or filter sees anything new.
      runId: "run-1",
      reason: "pending_input",
      // The classification the host cannot derive: a held run carries no HITL
      // interrupt, and the #2729 ruling makes this an INPUT wait.
      waitKind: "input",
    });
  });

  it("an ALREADY-PARKED run does NOT re-notify — a retried run-start never re-rings the bell", async () => {
    // The re-entry guard returns held:true off the existing park without writing
    // a second park row; the notification must follow the same rule (the host's
    // per-run dedupeKey is only the backstop).
    parkRows.push({ id: "park-1", runId: "run-1", checkpoint: "recommendation", status: "parked" });

    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(true);
    expect(maybeParkCheckpoint).not.toHaveBeenCalled();
    expect(onEnterHumanWait).not.toHaveBeenCalled();
  });

  it("a run that does NOT park never notifies (headless, no candidates)", async () => {
    const headless = await maybeHoldRunForRecommendation({
      run: run({ humanPresent: false }),
      template: template(),
    });
    expect(headless.held).toBe(false);
    expect(onEnterHumanWait).not.toHaveBeenCalled();

    recommendSkillsForAgentTask.mockResolvedValue([]);
    getAssignedSkillIdsForAgent.mockResolvedValue([]);
    const noCandidates = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(noCandidates.held).toBe(false);
    expect(onEnterHumanWait).not.toHaveBeenCalled();
  });

  it("the park still holds the run when the notification throws (best-effort, never blocking)", async () => {
    onEnterHumanWait.mockRejectedValueOnce(new Error("notifications down"));
    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(true);
    expect(out).toMatchObject({ parkId: "park-1" });
  });

  it("a RE-HOLD after a release notifies again — once per hold", async () => {
    // Hold → release → a LATER run holds afresh and rings again. It is a later
    // run, not the same one re-held: the re-entry guard answers held:false for a
    // run whose recommendation park is already terminal, so "once per hold" is
    // only observable across holds that actually happen.
    await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(onEnterHumanWait).toHaveBeenCalledTimes(1);
    expect(await releaseRecommendationParkForRun("run-1")).toBe(true);

    await maybeHoldRunForRecommendation({ run: run({ id: "run-2" }), template: template() });
    expect(onEnterHumanWait).toHaveBeenCalledTimes(2);
    expect(onEnterHumanWait).toHaveBeenLastCalledWith({
      runId: "run-2",
      reason: "pending_input",
      waitKind: "input",
    });
  });

  it("does NOT notify when the park it just wrote is no longer live — the liveness re-read", async () => {
    // A concurrent sweep (TTL fail-close, a racing decision) can terminate the
    // park between the insert and the notification. Notifying then would mint the
    // permanently-stale row this issue exists to prevent: the park cannot
    // transition twice, so the clear that rides the transition has already gone.
    maybeParkCheckpoint.mockImplementation(async (_o: unknown, input: { runId: string }) => {
      parkRows.push({
        id: "park-1",
        runId: input.runId,
        checkpoint: "recommendation",
        status: "policy_unresolved",
      });
      return { parked: true, parkId: "park-1", reason: "parked" };
    });

    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(true); // the park decision is unaffected by the notification
    expect(onEnterHumanWait).not.toHaveBeenCalled();
  });
});

/**
 * Codex convergence round 2, finding 1 — the clear is wired into the RELEASE
 * PRIMITIVE (`sweepParks`), not into this helper.
 *
 * It used to live here, after this helper's own sweep call, which covered only
 * releases that came through this helper. Every OTHER path that transitions a
 * park out of `parked` — above all the TTL fail-close, whose production driver is
 * the gate-maintenance drain and which sweeps every due park including a held
 * run's — bypassed it, and since a hold moves no run status there was no
 * transition to clear the row either. So `sweepParks` is mocked out in this file,
 * the clear is NOT observable here, and what these cases pin is that this helper
 * reaches the primitive with the right park and only when it should. The clear
 * itself is pinned against the REAL primitive and a real database in
 * recommendation-hold.integration.test.ts.
 */
describe("cinatra#2835 — leaving a hold goes through the release primitive", () => {
  it("releasing a LIVE park delegates to the sweeper with that park's id", async () => {
    parkRows.push({ id: "park-1", runId: "run-1", checkpoint: "recommendation", status: "parked" });
    const released = await releaseRecommendationParkForRun("run-1");
    expect(released).toBe(true);
    expect(sweepParks).toHaveBeenCalledWith({ releasedParkIds: ["park-1"] });
    // Not from here — the primitive owns it (see the block comment above).
    expect(onLeaveHumanWait).not.toHaveBeenCalled();
  });

  it("a no-op release (no park / already released / wrong hold) never reaches the sweeper", async () => {
    expect(await releaseRecommendationParkForRun("run-1")).toBe(false);

    parkRows.length = 0;
    parkRows.push({ id: "park-1", runId: "run-1", checkpoint: "recommendation", status: "released" });
    expect(await releaseRecommendationParkForRun("run-1")).toBe(false);

    // Instance-bound: a decision naming ANOTHER hold releases nothing, so it must
    // not sweep — and therefore cannot clear the live hold's notification either.
    parkRows.length = 0;
    parkRows.push({ id: "park-2", runId: "run-1", checkpoint: "recommendation", status: "parked" });
    expect(await releaseRecommendationParkForRun("run-1", "park-1")).toBe(false);

    expect(sweepParks).not.toHaveBeenCalled();
    expect(onLeaveHumanWait).not.toHaveBeenCalled();
  });

  it("a sweeper that releases nothing (0 rows) reports no release", async () => {
    parkRows.push({ id: "park-1", runId: "run-1", checkpoint: "recommendation", status: "parked" });
    sweepParks.mockResolvedValue({ released: 0 });
    expect(await releaseRecommendationParkForRun("run-1")).toBe(false);
    expect(onLeaveHumanWait).not.toHaveBeenCalled();
  });
});
