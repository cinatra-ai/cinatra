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
 * (`dispatchRecommendationHoldEntered` / `dispatchRecommendationHoldCleared`) and
 * the input classification the host cannot derive for a run that carries no HITL
 * interrupt.
 *
 * This file covers the PACKAGE side: the seam dispatchers, the FENCE SQL they are
 * written behind, and the hold's own wiring (a NEW hold notifies exactly once with
 * the park id it just wrote; an already-parked re-hold does not re-notify; a
 * release delegates to the sweeper).
 *
 * What this tier deliberately does NOT prove (Codex convergence round 3): that a
 * fabricated park id writes nothing, and that an enter racing a sweep cannot leave
 * a stale row. Both are now enforced by the DATABASE — a `SELECT … FOR UPDATE` of
 * the park feeding the INSERT inside one transaction — and the previous rounds'
 * mistake was exactly to assert such properties against mocks that could not fail
 * them. They are pinned against a real Postgres in
 * recommendation-hold.integration.test.ts. Here we pin the pure half: that the
 * fence SQL asks for the right thing. The HOST half — the "needs your input" copy,
 * the conversation deep-link, and the park-scoped clear — is pinned in
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
  buildHoldNotificationFence,
  dispatchRecommendationHoldEntered,
  dispatchRecommendationHoldCleared,
  type RunWaitNotifier,
} from "../run-wait-notifier";

const onEnterHumanWait = vi.fn();
const onLeaveHumanWait = vi.fn();
const onEnterRecommendationHold = vi.fn();
const onClearRecommendationHold = vi.fn();

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
    onEnterRecommendationHold: (input: { runId: string; parkId: string }) =>
      onEnterRecommendationHold(input),
    onClearRecommendationHold: (input: { runId: string; parkId: string }) =>
      onClearRecommendationHold(input),
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
  // A STATEFUL park fake: the hold's re-entry guard reads the run's parks before
  // deciding whether to create one, so a flat `mockResolvedValue([])` would model
  // a store in which the row vanishes the instant it is inserted.
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
  sweepParks.mockResolvedValue({ released: 1, blocked: 0, holdNotificationsCleared: 0 });
  onClearRecommendationHold.mockResolvedValue(true);
});

afterEach(() => {
  // Never leak the wired notifier into another test file's module singleton.
  setRunWaitNotifier(null);
});

describe("cinatra#2835 — the direct human-wait seam", () => {
  it("dispatchRecommendationHoldEntered forwards the run and the park it names", async () => {
    await dispatchRecommendationHoldEntered({ runId: "run-9", parkId: "park-1" });
    expect(onEnterRecommendationHold).toHaveBeenCalledTimes(1);
    // Two opaque ids and no assertions about either: the seam no longer claims a
    // park is live, it hands over the id whose liveness the WRITE checks.
    expect(onEnterRecommendationHold).toHaveBeenCalledWith({
      runId: "run-9",
      parkId: "park-1",
    });
  });

  it("dispatchRecommendationHoldCleared drives the park-scoped clear and returns its ack", async () => {
    onClearRecommendationHold.mockResolvedValueOnce(true);
    await expect(
      dispatchRecommendationHoldCleared({ runId: "run-9", parkId: "park-1" }),
    ).resolves.toBe(true);
    expect(onClearRecommendationHold).toHaveBeenCalledWith({
      runId: "run-9",
      parkId: "park-1",
    });
  });

  it("a clear that did NOT commit reports false, so the sweeper keeps the obligation", async () => {
    onClearRecommendationHold.mockResolvedValueOnce(false);
    await expect(
      dispatchRecommendationHoldCleared({ runId: "run-9", parkId: "park-1" }),
    ).resolves.toBe(false);
  });

  it("no wired notifier: the enter is a no-op and the clear does NOT claim to have cleared", async () => {
    setRunWaitNotifier(null);
    await expect(
      dispatchRecommendationHoldEntered({ runId: "run-9", parkId: "park-1" }),
    ).resolves.toBeUndefined();
    // `false`, not `true`. Nothing discharged the obligation, and reporting
    // otherwise would retire a clear that never happened.
    await expect(
      dispatchRecommendationHoldCleared({ runId: "run-9", parkId: "park-1" }),
    ).resolves.toBe(false);
  });

  it("a host that wires no hold methods is skipped, not crashed", async () => {
    // The pair is optional for structural back-compat with existing doubles.
    setRunWaitNotifier({
      onEnterHumanWait: () => {},
      onLeaveHumanWait: () => {},
    } satisfies RunWaitNotifier);
    await expect(
      dispatchRecommendationHoldEntered({ runId: "run-9", parkId: "park-1" }),
    ).resolves.toBeUndefined();
    await expect(
      dispatchRecommendationHoldCleared({ runId: "run-9", parkId: "park-1" }),
    ).resolves.toBe(false);
  });

  it("swallows a throwing notifier — a notification can never fail a parked hold", async () => {
    onEnterRecommendationHold.mockRejectedValueOnce(new Error("notifications down"));
    onClearRecommendationHold.mockRejectedValueOnce(new Error("notifications down"));
    await expect(
      dispatchRecommendationHoldEntered({ runId: "run-9", parkId: "park-1" }),
    ).resolves.toBeUndefined();
    // A throw is not an ack: the obligation survives for the next sweep.
    await expect(
      dispatchRecommendationHoldCleared({ runId: "run-9", parkId: "park-1" }),
    ).resolves.toBe(false);
  });
});

/**
 * Codex convergence round 3, findings 1 + 2 — the FENCE the write happens behind.
 *
 * Round 2 answered "may this notification be written?" in TypeScript, over fields
 * the caller supplied. That was wrong twice over: a cast satisfied it (finding 2),
 * and even an honest caller could only report what was true when it read the park,
 * not what is true when the row commits (finding 1). Both defects were the same
 * defect — a check in one place and a write in another.
 *
 * The check therefore moved INTO the write, as SQL. These cases pin what that SQL
 * asks for; that it is actually ENFORCED is a property of Postgres and is proven
 * against a real one in recommendation-hold.integration.test.ts. This is the
 * honest division: a mock cannot fail a row lock, so nothing here pretends to
 * test one.
 */
describe("cinatra#2835 — the hold-notification write fence", () => {
  const fence = buildHoldNotificationFence({
    schema: "cinatra_test",
    parkId: "park-1",
    runId: "run-9",
    insertedCte: "notification_write",
  });

  it("the guard matches the park on ALL FOUR facts a fabricated binding could lie about", () => {
    // id (the park exists), run_id (it is THIS run's), checkpoint (it is a hold
    // and not an auto-gate `review` park), status (the wait is not already over).
    expect(fence.guard).toContain("id = $1");
    expect(fence.guard).toContain("run_id = $2");
    expect(fence.guard).toContain("checkpoint = $3");
    expect(fence.guard).toContain("status = 'parked'");
    expect(fence.values).toEqual(["park-1", "run-9", "recommendation"]);
  });

  it("the guard takes the park's ROW LOCK — the whole TOCTOU fix", () => {
    // Without FOR UPDATE the guard is a snapshot read: a sweep could CAS the park
    // terminal and clear the notification while this transaction is still open,
    // and the insert would commit afterwards into a wait that is already over.
    // With it, the guard and the sweeper's `status = 'parked'` CAS contend for the
    // same lock and one of them provably goes second.
    expect(fence.guard).toContain("FOR UPDATE");
  });

  it("it reads the park table, and never the notifications table", () => {
    expect(fence.guard).toContain('"cinatra_test"."lifecycle_continuation_park"');
    expect(fence.guard).not.toContain("notifications");
  });

  it("the mark records the write under the SAME predicate that admitted it", () => {
    // A fence that refused the insert must not be able to mark the park `live`,
    // or the sweeper would chase a clear obligation for a row nobody wrote.
    expect(fence.mark).toContain("hold_notification = 'live'");
    expect(fence.mark).toContain("status = 'parked'");
  });

  // cinatra#2838 — THE PREDICATE IS NOT ENOUGH.
  //
  // The guard admitting the write does not mean the write happened: the insert
  // carries `ON CONFLICT (user_id, dedupe_key) DO NOTHING`, and the hold's key is
  // the run's PER-RUN awaiting-human key. An initiator who already holds a row on
  // that key — an earlier wait on the same run — makes the insert no-op while the
  // park is perfectly `parked` and the guard perfectly satisfied. A mark that only
  // repeated the guard's predicate then recorded `live` for a row carrying no park
  // id of this hold's, and the park-scoped clear later matched nothing and acked
  // the obligation as discharged: the hold announced to nobody, on the record as
  // announced. So the mark hangs off the insert's own RETURNING.
  it("the mark ALSO hangs off the insert's own RETURNING, not just the predicate", () => {
    expect(fence.mark).toContain('EXISTS (SELECT 1 FROM "notification_write")');
  });

  it("the CTE name is the writer's, never hand-spelled here", () => {
    const renamed = buildHoldNotificationFence({
      schema: "cinatra_test",
      parkId: "park-1",
      runId: "run-9",
      insertedCte: "some_other_cte",
    });
    expect(renamed.mark).toContain('EXISTS (SELECT 1 FROM "some_other_cte")');
  });

  it("the schema name AND the CTE name are quoted, not interpolated raw", () => {
    const hostile = buildHoldNotificationFence({
      schema: 'we"ird',
      parkId: "p",
      runId: "r",
      insertedCte: 'od"d',
    });
    expect(hostile.guard).toContain('"we""ird"."lifecycle_continuation_park"');
    expect(hostile.mark).toContain('"od""d"');
  });
});

describe("cinatra#2835 — entering a hold notifies the run's initiator", () => {
  it("a NEW hold dispatches the human-wait enter exactly once, classified as input", async () => {
    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(true);

    expect(onEnterRecommendationHold).toHaveBeenCalledTimes(1);
    // The park id it JUST INSERTED — not one re-read afterwards. The re-read used
    // to be the liveness check; it is gone because it could never have been one
    // (whatever it observed was already history by the time the row was written).
    // Liveness is now the fence's job, and the fence needs this exact id.
    expect(onEnterRecommendationHold).toHaveBeenCalledWith({
      runId: "run-1",
      parkId: out.held ? out.parkId : undefined,
    });
    // The wait's classification and copy are the HOST's to apply now that the
    // write is fenced — pinned in agent-run-wait-notifications.test.ts. Nothing
    // rides the transition seam for a hold: it moves no status.
    expect(onEnterHumanWait).not.toHaveBeenCalled();
  });

  it("an ALREADY-PARKED run does NOT re-notify — a retried run-start never re-rings the bell", async () => {
    // The re-entry guard returns held:true off the existing park without writing
    // a second park row; the notification must follow the same rule (the host's
    // per-run dedupeKey is only the backstop).
    parkRows.push({ id: "park-1", runId: "run-1", checkpoint: "recommendation", status: "parked" });

    const out = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(out.held).toBe(true);
    expect(maybeParkCheckpoint).not.toHaveBeenCalled();
    expect(onEnterRecommendationHold).not.toHaveBeenCalled();
  });

  it("a run that does NOT park never notifies (headless, no candidates)", async () => {
    const headless = await maybeHoldRunForRecommendation({
      run: run({ humanPresent: false }),
      template: template(),
    });
    expect(headless.held).toBe(false);
    expect(onEnterRecommendationHold).not.toHaveBeenCalled();

    recommendSkillsForAgentTask.mockResolvedValue([]);
    getAssignedSkillIdsForAgent.mockResolvedValue([]);
    const noCandidates = await maybeHoldRunForRecommendation({ run: run(), template: template() });
    expect(noCandidates.held).toBe(false);
    expect(onEnterRecommendationHold).not.toHaveBeenCalled();
  });

  it("the park still holds the run when the notification throws (best-effort, never blocking)", async () => {
    onEnterRecommendationHold.mockRejectedValueOnce(new Error("notifications down"));
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
    expect(onEnterRecommendationHold).toHaveBeenCalledTimes(1);
    expect(await releaseRecommendationParkForRun("run-1")).toBe(true);

    await maybeHoldRunForRecommendation({ run: run({ id: "run-2" }), template: template() });
    expect(onEnterRecommendationHold).toHaveBeenCalledTimes(2);
    // A DIFFERENT park id: the second hold is its own row, cleared under its own
    // key. The two can never collapse onto one another.
    expect(onEnterRecommendationHold).toHaveBeenLastCalledWith({
      runId: "run-2",
      parkId: "park-2",
    });
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
    expect(onClearRecommendationHold).not.toHaveBeenCalled();
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
    expect(onClearRecommendationHold).not.toHaveBeenCalled();
  });

  it("a sweeper that releases nothing (0 rows) reports no release", async () => {
    parkRows.push({ id: "park-1", runId: "run-1", checkpoint: "recommendation", status: "parked" });
    sweepParks.mockResolvedValue({ released: 0, blocked: 0, holdNotificationsCleared: 0 });
    expect(await releaseRecommendationParkForRun("run-1")).toBe(false);
    expect(onClearRecommendationHold).not.toHaveBeenCalled();
  });
});
