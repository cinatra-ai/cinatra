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
 * This file covers the PACKAGE side: the seam dispatchers, and the hold's own
 * wiring (a NEW hold notifies exactly once; an already-parked re-hold does not
 * re-notify; releasing the park clears). The HOST half — the "needs your input"
 * copy and the conversation deep-link — is pinned in
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
  type RunWaitNotifier,
} from "../run-wait-notifier";

const onEnterHumanWait = vi.fn();
const onLeaveHumanWait = vi.fn();

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
  readContinuationParksForRun.mockResolvedValue([]);
  maybeParkCheckpoint.mockResolvedValue({ parked: true, parkId: "park-1", reason: "parked" });
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
    });
    expect(onEnterHumanWait).toHaveBeenCalledTimes(1);
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
      dispatchRunHumanWaitEntered({ runId: "run-9", reason: "pending_input" }),
    ).resolves.toBeUndefined();
    await expect(dispatchRunHumanWaitLeft({ runId: "run-9" })).resolves.toBeUndefined();
  });

  it("swallows a throwing notifier — a notification can never fail a parked hold", async () => {
    onEnterHumanWait.mockRejectedValueOnce(new Error("notifications down"));
    onLeaveHumanWait.mockRejectedValueOnce(new Error("notifications down"));
    await expect(
      dispatchRunHumanWaitEntered({ runId: "run-9", reason: "pending_input", waitKind: "input" }),
    ).resolves.toBeUndefined();
    await expect(dispatchRunHumanWaitLeft({ runId: "run-9" })).resolves.toBeUndefined();
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
    readContinuationParksForRun.mockResolvedValue([
      { id: "park-1", checkpoint: "recommendation", status: "parked" },
    ]);

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
    // Hold → release → the park is terminal, so a later run-start holds afresh.
    await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(onEnterHumanWait).toHaveBeenCalledTimes(1);

    readContinuationParksForRun.mockResolvedValue([
      { id: "park-1", checkpoint: "recommendation", status: "parked" },
    ]);
    await releaseRecommendationParkForRun("run-1");

    readContinuationParksForRun.mockResolvedValue([]);
    await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(onEnterHumanWait).toHaveBeenCalledTimes(2);
  });
});

describe("cinatra#2835 — leaving a hold clears the notification", () => {
  it("releasing a LIVE park dispatches the clear", async () => {
    readContinuationParksForRun.mockResolvedValue([
      { id: "park-1", checkpoint: "recommendation", status: "parked" },
    ]);
    const released = await releaseRecommendationParkForRun("run-1");
    expect(released).toBe(true);
    expect(onLeaveHumanWait).toHaveBeenCalledWith({ runId: "run-1" });
  });

  it("a no-op release (no park / already released / wrong hold) clears NOTHING", async () => {
    readContinuationParksForRun.mockResolvedValue([]);
    expect(await releaseRecommendationParkForRun("run-1")).toBe(false);

    readContinuationParksForRun.mockResolvedValue([
      { id: "park-1", checkpoint: "recommendation", status: "released" },
    ]);
    expect(await releaseRecommendationParkForRun("run-1")).toBe(false);

    // Instance-bound: a decision naming ANOTHER hold releases nothing, so it must
    // not clear the live hold's notification either.
    readContinuationParksForRun.mockResolvedValue([
      { id: "park-2", checkpoint: "recommendation", status: "parked" },
    ]);
    expect(await releaseRecommendationParkForRun("run-1", "park-1")).toBe(false);

    expect(onLeaveHumanWait).not.toHaveBeenCalled();
  });

  it("a sweeper that releases nothing (0 rows) clears nothing", async () => {
    readContinuationParksForRun.mockResolvedValue([
      { id: "park-1", checkpoint: "recommendation", status: "parked" },
    ]);
    sweepParks.mockResolvedValue({ released: 0 });
    expect(await releaseRecommendationParkForRun("run-1")).toBe(false);
    expect(onLeaveHumanWait).not.toHaveBeenCalled();
  });
});
