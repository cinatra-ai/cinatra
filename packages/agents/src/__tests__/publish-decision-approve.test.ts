// cinatra#4150 part 5a: "Publish" lets a run held at a publish gate go on (A7), and who may decide a publish on a run
// with no human owner (A11). The shared WayFlow resume itself is driven by the generic approve's suites; here it is a
// double, so these cases pin the order: the authority, the claim, the gate read under it, ONE released decision, the
// preparation, the fence, then ONE send. Since cinatra#4245 the claim is the pause claim (a double here: its rules are
// pinned by run-pause-claim's own suites) and the fence is the one move pending_approval -> running.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuthzError } from "@/lib/authz/errors";

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  readRunCoOwners: vi.fn(async () => [] as Array<{ userId: string }>),
  transitionRunStatus: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

const decisions = vi.hoisted(() => ({
  insertParkedDecision: vi.fn(),
  decide: vi.fn(),
  readDecisionForRunNode: vi.fn(),
  readLatestDecisionForRun: vi.fn(),
  readOpenDecisionForRun: vi.fn(),
  listDueParked: vi.fn(async () => [] as unknown[]),
  listSettledWithWaitingRun: vi.fn(async () => [] as unknown[]),
}));
vi.mock("../publish-decision-store", () => decisions);

const enforceRunAccess = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../auth-policy", () => ({ enforceRunAccess, resolveEffectivePolicy: () => "owner-only" }));

const resolveOrgRoleForUser = vi.hoisted(() => vi.fn(async () => "member" as string | undefined));
vi.mock("@/lib/auth-session", () => ({ resolveOrgRoleForUser }));

const sendWayflowResume = vi.hoisted(() => vi.fn());
const PREPARED = { client: "the client", metadata: { token: "t" }, messageId: "m-1" };
const prepareWayflowResume = vi.hoisted(() => vi.fn());
vi.mock("../review-task-actions", () => ({ sendWayflowResume, prepareWayflowResume }));

const claims = vi.hoisted(() => ({
  claimPause: vi.fn(),
  releasePauseClaim: vi.fn(),
  settlePauseSend: vi.fn(),
}));
vi.mock("../run-pause-claim", () => claims);
const CLAIMED = { kind: "claimed" as const, token: "tok-1", generation: 4, expiresAt: new Date("2026-11-01T00:01:00Z") };
const refused = (reason: string, status = "pending_approval") => ({ kind: "refused" as const, reason, status, generation: 3 });

const assertAgentRunDispatchAuthorized = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../agent-run-serde", () => ({ assertAgentRunDispatchAuthorized }));

vi.mock("../wayflow-url", () => ({ resolveWayflowUrl: (pkg: string) => `http://wayflow.test/${pkg}` }));

// The run's current gate visit (the latest-task map the interrupt writes): "task-1" is the gate task of decision() below.
// A full double, as in artifact-review-resume-delivery.test.ts: Publish reads only this one export. A partial double loads
// the real module, whose graph imports this package's index back over the partial doubles above; in CI that load failed,
// so every gate read under the claim answered publish_decision_unavailable.
const resolveLatestWayflowGateTaskId = vi.hoisted(() => vi.fn(async (_runId: string): Promise<string | null> => "task-1"));
vi.mock("@cinatra-ai/a2a", () => ({ resolveLatestWayflowGateTaskId }));

// The card's read names a settled decider through this helper; the retry case below reads the card over these doubles.
vi.mock("@/lib/lifecycle/lifecycle-settled-outcome", () => ({ readDeciderName: async () => "Dana Okafor" }));

import * as decisionActions from "../publish-decision-actions";
import { decidePublishDecisionCardForActor, publishDecisionCardStateForRun } from "../publish-decision-card-core";
import {
  PUBLISH_DECISION_NOT_OPEN,
  approvePublishDecision,
  declinePublishDecision,
} from "../publish-decision-actions";

const ACTOR = { actorType: "human" as const, source: "ui" as const, userId: "user-a" };
const ROLE_HINTS = { actorOrganizationId: "org-9" };

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1", templateId: "tmpl-1", orgId: "org-1", runBy: "user-a", authPolicy: null,
    status: "pending_approval", a2aContextId: "ctx-1", a2aTaskId: "task-1", pauseGeneration: 3, ...overrides,
  };
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: "d1", orgId: "org-1", runId: "run-1", nodeId: "publish", gateTaskId: "task-1", a2aContextId: "ctx-1",
    status: "parked", surfacedValues: { what: "the post" }, decidedBy: null, decidedAt: null, decisionNote: null,
    createdAt: new Date("2026-11-01T00:00:00Z"), expiresAt: new Date("2026-11-02T00:00:00Z"), ...overrides,
  };
}

const stale = () => Object.assign(new Error("stale"), { code: "stale_from_status" });
const moves = () => storeMock.transitionRunStatus.mock.calls.map((c) => (c as unknown[]).slice(0, 3));

beforeEach(() => {
  vi.clearAllMocks();
  for (const m of [storeMock.readAgentRunById, storeMock.readAgentTemplateById, storeMock.transitionRunStatus,
    decisions.decide, decisions.readOpenDecisionForRun, decisions.readLatestDecisionForRun, sendWayflowResume,
    enforceRunAccess, resolveOrgRoleForUser, assertAgentRunDispatchAuthorized, resolveLatestWayflowGateTaskId,
    prepareWayflowResume, claims.claimPause, claims.releasePauseClaim, claims.settlePauseSend]) m.mockReset();
  storeMock.readAgentRunById.mockResolvedValue(run());
  storeMock.readAgentTemplateById.mockResolvedValue({ id: "tmpl-1", packageName: "@acme/poster", sourceType: "internal", agentAuthPolicy: null });
  storeMock.readRunCoOwners.mockResolvedValue([]);
  storeMock.transitionRunStatus.mockResolvedValue(undefined);
  decisions.readOpenDecisionForRun.mockResolvedValue(decision());
  decisions.readLatestDecisionForRun.mockResolvedValue(null);
  decisions.decide.mockImplementation(async (id: string, change: { to: string }) => ({
    outcome: "won", decision: decision({ id, status: change.to }),
  }));
  sendWayflowResume.mockImplementation(async (args: { onDispatch?: () => void }) => {
    args.onDispatch?.();
    return { id: "task-2", contextId: "ctx-1", status: { state: "completed" } };
  });
  enforceRunAccess.mockResolvedValue(undefined);
  resolveOrgRoleForUser.mockResolvedValue("member");
  assertAgentRunDispatchAuthorized.mockResolvedValue(undefined);
  resolveLatestWayflowGateTaskId.mockResolvedValue("task-1");
  prepareWayflowResume.mockResolvedValue(PREPARED);
  claims.claimPause.mockResolvedValue(CLAIMED);
  claims.releasePauseClaim.mockResolvedValue("released");
  claims.settlePauseSend.mockResolvedValue("settled");
});

// cinatra#4758: the site widget's Allow. The widget's reader is admitted ONLY on this road (the widget's decide route);
// the decision, the claim, the fence and the one send are Publish's own.
describe("Allow from the site widget (cinatra#4758)", () => {
  const WIDGET = { actorType: "human" as const, source: "a2a" as const, userId: "user-a", orgId: "org-1" };
  type Approve = (input: { runId: string; actorContext: unknown }) => Promise<unknown>;
  const approveAsWidget = (input: Parameters<Approve>[0]) => {
    const fn = (decisionActions as unknown as Record<string, unknown>).approvePublishDecisionAsWidgetReader;
    expect(typeof fn, "the widget's approve road is exported").toBe("function");
    return (fn as Approve)(input);
  };

  it("releases the decision as the widget's person and resumes the run to its publishing step, once", async () => {
    expect(await approveAsWidget({ runId: "run-1", actorContext: WIDGET })).toEqual({ ok: true, resumed: true });
    expect(enforceRunAccess.mock.calls.map((c) => (c as unknown[])[2])).toEqual(["execute", "approveHitl"]);
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "released", actor: "user-a" });
    expect(sendWayflowResume).toHaveBeenCalledTimes(1);
  });

  it("the session road still refuses the widget's reader, and the widget road refuses a UI person", async () => {
    await expect(approvePublishDecision({ runId: "run-1", actorContext: WIDGET })).rejects.toMatchObject({ statusCode: 403 });
    await expect(approveAsWidget({ runId: "run-1", actorContext: ACTOR })).rejects.toMatchObject({ statusCode: 403 });
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });
});

// gate A was answered elsewhere and gate B opened before this card re-read; Allow
// pressed on the stale card A must leave B untouched: no claim, no decision write, no send. Both doors run for real.
describe("a stale card never approves a newer gate", () => {
  const WIDGET = { actorType: "human" as const, source: "a2a" as const, userId: "user-a", orgId: "org-1" };

  beforeEach(() => {
    decisions.readOpenDecisionForRun.mockResolvedValue(decision({ id: "dB", nodeId: "publish-2", gateTaskId: "task-2" }));
    resolveLatestWayflowGateTaskId.mockResolvedValue("task-2");
    decisions.decide.mockImplementation(async (id: string, change: { to: string }) =>
      id === "dA" ? { outcome: "lost", currentStatus: "released" } : { outcome: "won", decision: decision({ id, status: change.to }) });
  });

  it.each([
    ["the session door", "decidePublishDecisionCardForActor", ACTOR],
    ["the widget door", "decidePublishDecisionCardForWidgetReader", WIDGET],
  ] as const)("%s: Allow on card A is not open, and B is not released and nothing is sent", async (_label, door, actor) => {
    const core = await import("../publish-decision-card-core");
    expect(await core[door]({ runId: "run-1", decisionId: "dA", answer: "approve" }, { actor, roleHints: {} })).toBe("not_open");
    expect(decisions.decide.mock.calls.map((c) => (c as unknown[])[0])).not.toContain("dB");
    expect(sendWayflowResume).not.toHaveBeenCalled();
    expect(moves()).toEqual([]);
  });

  it("an Allow that names the open row writes it under the claim, bound to the run, and only while it is the newest open row of the current attempt", async () => {
    decisions.readOpenDecisionForRun.mockResolvedValue(decision());
    resolveLatestWayflowGateTaskId.mockResolvedValue("task-1");
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR, decisionId: "d1" } as never)).toEqual({ ok: true, resumed: true });
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "released", actor: "user-a", ofRun: "run-1", newestOnly: true });
  });

  it("a stale card never resumes another decision released earlier", async () => {
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ id: "dB", status: "released", gateTaskId: "task-2" }));
    resolveLatestWayflowGateTaskId.mockResolvedValue("task-2");
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR, decisionId: "dA" } as never)).toMatchObject({
      ok: false, code: PUBLISH_DECISION_NOT_OPEN,
    });
    expect(claims.claimPause).not.toHaveBeenCalled();
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });
});

describe("Publish (A7)", () => {
  it("checks the decider, claims the pause, writes ONE released decision under the claim, then fences and sends once into its held context", async () => {
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: true });
    expect(enforceRunAccess.mock.calls.map((c) => (c as unknown[])[2])).toEqual(["execute", "approveHitl"]);
    expect(assertAgentRunDispatchAuthorized).toHaveBeenCalledWith({ runId: "run-1", stage: "dispatch", actingUserId: "user-a" });
    expect(decisions.decide).toHaveBeenCalledTimes(1);
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "released", actor: "user-a" });
    expect(claims.claimPause).toHaveBeenCalledTimes(1);
    expect((claims.claimPause.mock.calls[0] as unknown[])[0]).toEqual({ runId: "run-1", orgId: "org-1", generation: 3, taskId: "task-1" });
    expect(moves()).toEqual([["run-1", "pending_approval", "running"]]);
    expect((storeMock.transitionRunStatus.mock.calls[0] as unknown[])[3]).toEqual({ pauseFence: { token: "tok-1", generation: 4 } });
    expect(prepareWayflowResume).toHaveBeenCalledWith("run-1", "http://wayflow.test/@acme/poster");
    expect(sendWayflowResume).toHaveBeenCalledTimes(1);
    const args = sendWayflowResume.mock.calls[0]![0] as Record<string, unknown> & { authority: { orgId: string } };
    expect(args.contextId).toBe("ctx-1");
    expect(args.prepared).toBe(PREPARED);
    expect(args.pauseClaimToken).toBe("tok-1");
    expect(typeof args.text).toBe("string");
    expect((args.text as string).length).toBeGreaterThan(0);
    expect((args.run as { id: string }).id).toBe("run-1");
    expect(args.authority.orgId).toBe("org-1");
    // Every step of the order is called exactly once, so no entry below is an undefined that sorts last.
    expect(claims.settlePauseSend).toHaveBeenCalledTimes(1);
    expect(resolveLatestWayflowGateTaskId).toHaveBeenCalledTimes(1);
    expect(prepareWayflowResume).toHaveBeenCalledTimes(1);
    expect(storeMock.transitionRunStatus).toHaveBeenCalledTimes(1);
    const order = [
      claims.claimPause.mock.invocationCallOrder[0]!,
      resolveLatestWayflowGateTaskId.mock.invocationCallOrder[0]!,
      decisions.decide.mock.invocationCallOrder[0]!,
      prepareWayflowResume.mock.invocationCallOrder[0]!,
      storeMock.transitionRunStatus.mock.invocationCallOrder[0]!,
      sendWayflowResume.mock.invocationCallOrder[0]!,
      claims.settlePauseSend.mock.invocationCallOrder[0]!,
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(claims.releasePauseClaim).not.toHaveBeenCalled();
  });

  it("a second Publish resumes nothing more", async () => {
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released" }));
    claims.claimPause.mockResolvedValueOnce(refused("moved-on"));
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: false });
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("a Publish that finds the run claimed by another Publish, which released the decision, writes and sends nothing", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released" }));
    claims.claimPause.mockResolvedValueOnce(refused("moved-on"));
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: false });
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it.each(["declined", "expired", "run_ended", "parked"])(
    "a late Publish on a run whose newest decision is %s is reported and nothing is sent",
    async (status) => {
      decisions.readOpenDecisionForRun.mockResolvedValue(null);
      decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status }));
      expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({
        ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: status,
      });
      expect(claims.claimPause).not.toHaveBeenCalled();
      expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
      expect(sendWayflowResume).not.toHaveBeenCalled();
    },
  );

  it("a Publish that loses the decision write to Do not publish gives the claim back, is reported and nothing is sent", async () => {
    decisions.decide.mockResolvedValueOnce({ outcome: "lost", currentStatus: "declined" });
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "declined" }));
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({
      ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: "declined",
    });
    expect(moves()).toEqual([]);
    expect(claims.releasePauseClaim).toHaveBeenCalledWith({ runId: "run-1", orgId: "org-1", token: "tok-1" }, expect.anything());
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("a run with no decision at all is reported, not resumed", async () => {
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({
      ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: null,
    });
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("a late Do not publish after Publish is reported with the released status", async () => {
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released" }));
    expect(await declinePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({
      ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: "released",
    });
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("a resume that fails before its send gives the claim back, keeps the decision, and Publish again retries only the resume", async () => {
    prepareWayflowResume.mockRejectedValueOnce(new Error("wayflow down: run-1 ctx-1"));
    const err = (await approvePublishDecision({ runId: "run-1", actorContext: ACTOR }).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe("publish_resume_failed");
    expect(err.message).not.toMatch(/wayflow down|run-1|ctx-1/);
    expect(moves()).toEqual([]);
    expect(claims.releasePauseClaim).toHaveBeenCalledTimes(1);
    expect(sendWayflowResume).not.toHaveBeenCalled();

    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released" }));
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: true });
    expect(decisions.decide).toHaveBeenCalledTimes(1);
    expect(sendWayflowResume).toHaveBeenCalledTimes(1);
  });

  // The card is the reader's only way to answer. After an Allow whose resume failed before its fence, the run still
  // waits at the gate with its decision released: the card must keep offering Allow on that decision, and that Allow
  // resumes the run without a second decision write. A card that read "Approved" here would leave the run paused for good.
  it("after a resume that failed before its send, the card still offers Allow, and that Allow resumes the run once", async () => {
    const who = { actor: ACTOR, roleHints: ROLE_HINTS };
    prepareWayflowResume.mockRejectedValueOnce(new Error("wayflow down"));
    // red-first-expect: decidePublishDecisionCardForActor is not a function
    expect(await decidePublishDecisionCardForActor({ runId: "run-1", decisionId: "d1", answer: "approve" }, who)).toBe("failed");
    expect(decisions.decide).toHaveBeenCalledTimes(1);
    expect(sendWayflowResume).not.toHaveBeenCalled();

    // What the store now holds: the decision released by user-a, the run still pending_approval at gate task-1.
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released", decidedBy: "user-a" }));
    const card = await publishDecisionCardStateForRun(run() as never, who);
    expect(card).toMatchObject({ state: "pending", decisionId: "d1", mayDecide: true });

    expect(await decidePublishDecisionCardForActor({ runId: "run-1", decisionId: "d1", answer: "approve" }, who)).toBe("decided");
    expect(decisions.decide).toHaveBeenCalledTimes(1);
    expect(moves()).toEqual([["run-1", "pending_approval", "running"]]);
    expect(sendWayflowResume).toHaveBeenCalledTimes(1);
  });

  // The accurate reading: the run row and the latest-task key both name the released decision's gate task, so the run
  // still waits at that pause. Allow stays, and it resumes the run exactly once, with no second decision write, under a
  // pause claim bound to that gate task (cinatra#4758). Red first at 7ca04b14: the claim named the generation only. On
  // the base, which has no retry reading, the card reads Approved:
  // red-first-expect: expected { state: 'approved', …(4) } to match object { state: 'pending', …(3) }
  it("a released decision whose run row and latest-task key both name its gate keeps Allow, and Allow resumes the run exactly once under a claim bound to that gate", async () => {
    const who = { actor: ACTOR, roleHints: ROLE_HINTS };
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released", decidedBy: "user-a" }));
    resolveLatestWayflowGateTaskId.mockResolvedValue("task-1");
    expect(await publishDecisionCardStateForRun(run() as never, who)).toMatchObject({ state: "pending", decisionId: "d1", mayDecide: true, resumeOnly: true });
    expect(await decidePublishDecisionCardForActor({ runId: "run-1", decisionId: "d1", answer: "approve" }, who)).toBe("decided");
    expect(claims.claimPause).toHaveBeenCalledTimes(1);
    expect((claims.claimPause.mock.calls[0] as unknown[])[0]).toEqual({ runId: "run-1", orgId: "org-1", generation: 3, taskId: "task-1" });
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(moves()).toEqual([["run-1", "pending_approval", "running"]]);
    expect(sendWayflowResume).toHaveBeenCalledTimes(1);
  });

  // The latest-task key lives seven days and can be lost, and the run row's task can still name an earlier gate visit
  // (event-log.ts: a pause entered without its own task write keeps the column, and that write can lose a race). Gate A
  // (task-1) was released and the run went on; it now waits at gate B, a later pause, but a2a_task_id still names A and
  // the key has expired. The row alone cannot tell A's pause from B's: no card (never Allow, never Approved), and an
  // Allow resumes nothing, so B is never answered. Red first at 7ca04b14: the row alone was read as A's pause.
  // red-first-expect: to deeply equal { state: 'none' }
  it("with a stale run row and no latest-task key, a released decision offers no Allow and its Allow resumes nothing", async () => {
    const who = { actor: ACTOR, roleHints: ROLE_HINTS };
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released", decidedBy: "user-a" }));
    const atGateB = run({ a2aTaskId: "task-1", pauseGeneration: 6 });
    storeMock.readAgentRunById.mockResolvedValue(atGateB);
    resolveLatestWayflowGateTaskId.mockResolvedValue(null);
    expect(await publishDecisionCardStateForRun(atGateB as never, who)).toEqual({ state: "none" });
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: false });
    expect(await decidePublishDecisionCardForActor({ runId: "run-1", decisionId: "d1", answer: "approve" }, who)).not.toBe("decided");
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(prepareWayflowResume).not.toHaveBeenCalled();
    expect(moves()).toEqual([]);
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("a latest-task read that faults never turns a run still waiting at the released decision's pause into Approved, nor into Allow", async () => {
    const who = { actor: ACTOR, roleHints: ROLE_HINTS };
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released", decidedBy: "user-a" }));
    resolveLatestWayflowGateTaskId.mockRejectedValue(new Error("redis down"));
    // red-first-expect: to deeply equal { state: 'none' }
    expect(await publishDecisionCardStateForRun(run() as never, who)).toEqual({ state: "none" });
  });

  // The run went on past the released decision and paused at another gate: the run row names that other gate task. The
  // old decision is settled, with or without the latest-task key, and its Allow claims nothing back from the new pause.
  it("a released decision whose run went on, or waits at another gate, reads as Approved, and its Allow resumes nothing", async () => {
    const who = { actor: ACTOR, roleHints: ROLE_HINTS };
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released", decidedBy: "user-a" }));
    expect(await publishDecisionCardStateForRun(run({ status: "running" }) as never, who)).toMatchObject({ state: "approved" });
    const movedOn = run({ a2aTaskId: "task-7", pauseGeneration: 5 });
    storeMock.readAgentRunById.mockResolvedValue(movedOn);
    for (const latest of ["task-7", null]) {
      resolveLatestWayflowGateTaskId.mockResolvedValue(latest);
      expect(await publishDecisionCardStateForRun(movedOn as never, who)).toMatchObject({ state: "approved" });
    }
    resolveLatestWayflowGateTaskId.mockRejectedValue(new Error("redis down"));
    expect(await publishDecisionCardStateForRun(movedOn as never, who)).toMatchObject({ state: "approved" });
    resolveLatestWayflowGateTaskId.mockResolvedValue(null);
    expect(await decidePublishDecisionCardForActor({ runId: "run-1", decisionId: "d1", answer: "approve" }, who)).toBe("not_open");
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(moves()).toEqual([]);
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("a fence lost to a stop or another claimer sends nothing, gives nothing back and keeps the decision", async () => {
    storeMock.transitionRunStatus.mockRejectedValueOnce(stale());
    const err = (await approvePublishDecision({ runId: "run-1", actorContext: ACTOR }).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe("publish_resume_failed");
    expect(moves()).toEqual([["run-1", "pending_approval", "running"]]);
    expect(decisions.decide).toHaveBeenCalledTimes(1);
    expect(sendWayflowResume).not.toHaveBeenCalled();
    expect(claims.releasePauseClaim).not.toHaveBeenCalled();
    expect(claims.settlePauseSend).not.toHaveBeenCalled();
  });

  it("a Publish after the run parked at a later gate sends nothing", async () => {
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released", gateTaskId: "task-1" }));
    resolveLatestWayflowGateTaskId.mockResolvedValue("task-7");
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: false });
    expect(resolveLatestWayflowGateTaskId).toHaveBeenCalledWith("run-1");
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(moves()).toEqual([]);
    expect(claims.releasePauseClaim).toHaveBeenCalledTimes(1);
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("the Publish that would win the decision write, claiming after another resume parked the run at a later gate, releases and sends nothing (finding 1)", async () => {
    // Its read of the open decision (gate task-1) came before the other resume; when it claims, the run waits at task-7.
    resolveLatestWayflowGateTaskId.mockResolvedValue("task-7");
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: false });
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(moves()).toEqual([]);
    expect(claims.releasePauseClaim).toHaveBeenCalledTimes(1);
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("two Publishes at once on one parked decision, and a third with the same old read: ONE release, ONE send (finding 1)", async () => {
    let runStatus = "pending_approval";
    let decided = "parked";
    // The pause claim: one holder at a time, cleared by a give-back or the settle of a send.
    let holder: string | null = null;
    let tokens = 0;
    claims.claimPause.mockImplementation(async () => {
      if (holder !== null || runStatus !== "pending_approval") return refused("held");
      holder = `tok-${++tokens}`;
      return { ...CLAIMED, token: holder };
    });
    claims.releasePauseClaim.mockImplementation(async (ref: { token: string }) => {
      if (holder !== ref.token) return "lost";
      holder = null;
      return "released";
    });
    claims.settlePauseSend.mockImplementation(async (ref: { token: string }) => {
      if (holder !== ref.token) return "already-cleared";
      holder = null;
      return "settled";
    });
    storeMock.transitionRunStatus.mockImplementation(async (...args: unknown[]) => {
      const [, from, to] = args as string[];
      if (runStatus !== from) throw stale();
      runStatus = to!;
      return undefined;
    });
    decisions.decide.mockImplementation(async (id: string, change: { to: string }) => {
      if (decided !== "parked") return { outcome: "lost", currentStatus: decided };
      decided = change.to;
      return { outcome: "won", decision: decision({ id, status: decided }) };
    });
    decisions.readLatestDecisionForRun.mockImplementation(async () => decision({ status: decided }));
    // The resume reaches a later gate: the runtime records it, then the run waits again.
    sendWayflowResume.mockImplementation(async (args: { onDispatch?: () => void }) => {
      args.onDispatch?.();
      resolveLatestWayflowGateTaskId.mockResolvedValue("task-7");
      runStatus = "pending_approval";
      return { id: "task-7", contextId: "ctx-1", status: { state: "input-required" } };
    });
    const answers = await Promise.all([1, 2].map(() => approvePublishDecision({ runId: "run-1", actorContext: ACTOR })));
    expect(answers.filter((a) => a.ok && a.resumed)).toHaveLength(1);
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: false });
    expect(decisions.decide).toHaveBeenCalledTimes(1);
    expect(sendWayflowResume).toHaveBeenCalledTimes(1);
    expect(runStatus).toBe("pending_approval");
  });

  it("a Publish on a run that already ended releases nothing, so the expiry can still close the row run_ended (finding 3)", async () => {
    storeMock.readAgentRunById.mockResolvedValue(run({ status: "stopped" }));
    claims.claimPause.mockResolvedValueOnce(refused("not-pending", "stopped"));
    decisions.readLatestDecisionForRun.mockResolvedValue(decision());
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({
      ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: "parked",
    });
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("a resume that fails before its send and whose give-back faults ends the run failed (finding 2)", async () => {
    prepareWayflowResume.mockRejectedValueOnce(new Error("credential mint failed"));
    claims.releasePauseClaim.mockRejectedValueOnce(new Error("db down: run-1"));
    await expect(approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).rejects.toMatchObject({ code: "publish_resume_failed" });
    expect(moves()).toEqual([["run-1", "pending_approval", "failed"]]);
    const patch = (storeMock.transitionRunStatus.mock.calls[0] as unknown[])[3] as { error: string };
    expect(patch.error).toMatch(/^publish_resume_failed:/);
    expect(patch.error).not.toMatch(/run-1|db down/);
  });

  it("a claim given back at another gate whose give-back faults ends the run failed (finding 2)", async () => {
    resolveLatestWayflowGateTaskId.mockResolvedValue("task-7");
    claims.releasePauseClaim.mockRejectedValueOnce(new Error("db down"));
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: false });
    expect(moves()).toEqual([["run-1", "pending_approval", "failed"]]);
    expect(decisions.decide).not.toHaveBeenCalled();
  });

  it("when the give-back and the failed move both fault, the fault surfaces with the fixed text, not as a resume failure (finding 2)", async () => {
    prepareWayflowResume.mockRejectedValueOnce(new Error("credential mint failed"));
    claims.releasePauseClaim.mockRejectedValueOnce(new Error("db down: run-1"));
    storeMock.transitionRunStatus.mockRejectedValue(new Error("db down: run-1"));
    const err = (await approvePublishDecision({ runId: "run-1", actorContext: ACTOR }).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe("publish_decision_unavailable");
    expect(err.message).not.toMatch(/db down|run-1/);
    expect(moves()).toEqual([["run-1", "pending_approval", "failed"]]);
  });

  it("a gate that cannot be read under the claim gives the claim back and answers the fixed text", async () => {
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released" }));
    resolveLatestWayflowGateTaskId.mockRejectedValueOnce(new Error("redis down: run-1"));
    const err = (await approvePublishDecision({ runId: "run-1", actorContext: ACTOR }).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe("publish_decision_unavailable");
    expect(err.message).not.toMatch(/redis|run-1/);
    expect(moves()).toEqual([]);
    expect(claims.releasePauseClaim).toHaveBeenCalledTimes(1);
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("a resume fault after the fence is logged by a fixed error name only, never a custom name, and the send's claim is settled", async () => {
    sendWayflowResume.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "Run run-1 ctx-1" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).rejects.toMatchObject({ code: "publish_resume_failed" });
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toMatch(/run-1|ctx-1/);
      expect(logged).toMatch(/: Error$/m);
      expect(claims.settlePauseSend).toHaveBeenCalledTimes(1);
      expect(claims.releasePauseClaim).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("a released decision whose run row names another gate task resumes nothing, with no latest-task key", async () => {
    storeMock.readAgentRunById.mockResolvedValue(run({ a2aTaskId: "task-7" }));
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released" }));
    resolveLatestWayflowGateTaskId.mockResolvedValue(null);
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: false });
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(moves()).toEqual([]);
    expect(claims.releasePauseClaim).toHaveBeenCalledTimes(1);
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("a resume that fails after its send leaves the run where the send left it", async () => {
    sendWayflowResume.mockImplementationOnce(async (args: { onDispatch?: () => void }) => {
      args.onDispatch?.();
      throw new Error("timeout");
    });
    await expect(approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).rejects.toMatchObject({ code: "publish_resume_failed" });
    expect(moves()).toEqual([["run-1", "pending_approval", "running"]]);
    expect(claims.settlePauseSend).toHaveBeenCalledTimes(1);
    expect(claims.releasePauseClaim).not.toHaveBeenCalled();
  });

  it.each([
    ["no held context", { a2aContextId: null }, undefined],
    ["a template that is not internal", {}, { id: "tmpl-1", packageName: "@acme/poster", sourceType: "external", agentAuthPolicy: null }],
    ["a template with no package", {}, { id: "tmpl-1", packageName: null, sourceType: "internal", agentAuthPolicy: null }],
    ["no template", {}, null],
  ])("a run with %s is refused before any decision write", async (_label, runPatch, template) => {
    storeMock.readAgentRunById.mockResolvedValue(run(runPatch));
    if (template !== undefined) storeMock.readAgentTemplateById.mockResolvedValue(template);
    const err = (await approvePublishDecision({ runId: "run-1", actorContext: ACTOR }).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe("publish_decision_unavailable");
    expect(err.message).not.toMatch(/run-1|tmpl-1|acme/);
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("a decider outside the agent's install scope is refused before any write, with a text that names nothing", async () => {
    assertAgentRunDispatchAuthorized.mockRejectedValueOnce(
      Object.assign(new Error("template tmpl-1 scope denied"), { code: "AGENT_TEMPLATE_SCOPE_DENIED" }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const err = (await approvePublishDecision({ runId: "run-1", actorContext: ACTOR }).catch((e: unknown) => e)) as AuthzError;
      expect(err).toBeInstanceOf(AuthzError);
      expect(err.statusCode).toBe(403);
      expect(err.message).not.toMatch(/tmpl-1/);
    } finally {
      warn.mockRestore();
    }
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("a fault of the install-scope check that is not a scope refusal answers the fixed text, before any write", async () => {
    assertAgentRunDispatchAuthorized.mockRejectedValueOnce(new Error("select failed: tmpl-1 user-a"));
    const err = (await approvePublishDecision({ runId: "run-1", actorContext: ACTOR }).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe("publish_decision_unavailable");
    expect(err.message).not.toMatch(/failed|tmpl-1|user-a/);
    expect("cause" in err).toBe(false);
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("an access refusal from the install-scope check passes unchanged", async () => {
    const refusal = new AuthzError({ statusCode: 403, reason: "forbidden" });
    assertAgentRunDispatchAuthorized.mockRejectedValueOnce(refusal);
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR }).catch((e: unknown) => e)).toBe(refusal);
    expect(decisions.decide).not.toHaveBeenCalled();
  });

  it("a store fault is not swallowed, and its text carries no id or store error", async () => {
    decisions.decide.mockRejectedValueOnce(new Error("db down: d1 run-1"));
    const err = (await approvePublishDecision({ runId: "run-1", actorContext: ACTOR }).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe("publish_decision_unavailable");
    expect(err.message).not.toMatch(/db down|d1|run-1/);
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });
});

describe("who may decide a publish (A11)", () => {
  const roads = [
    ["Publish", (actorContext: unknown) => approvePublishDecision({ runId: "run-1", actorContext: actorContext as typeof ACTOR, roleHints: ROLE_HINTS })],
    ["Do not publish", (actorContext: unknown) => declinePublishDecision({ runId: "run-1", actorContext: actorContext as typeof ACTOR, roleHints: ROLE_HINTS })],
  ] as const;

  describe.each(roads)("%s", (_road, decideAs) => {
    it("a run with an owner keeps its run policy and the caller's role hints", async () => {
      await expect(decideAs(ACTOR)).resolves.toMatchObject({ ok: true });
      for (const call of enforceRunAccess.mock.calls as unknown as Array<[Record<string, unknown>, unknown, string, unknown]>) {
        expect(call[0]).toMatchObject({ id: "run-1", runBy: "user-a", orgId: "org-1", effectivePolicy: "owner-only" });
        expect(call[3]).toEqual(ROLE_HINTS);
      }
    });

    it("a run with no human owner is decided by a same-org person through the kernel, with no run policy", async () => {
      storeMock.readAgentRunById.mockResolvedValue(run({ runBy: null }));
      resolveOrgRoleForUser.mockResolvedValue("member");
      await expect(decideAs(ACTOR)).resolves.toMatchObject({ ok: true });
      expect(resolveOrgRoleForUser).toHaveBeenCalledWith("org-1", "user-a");
      const calls = enforceRunAccess.mock.calls as unknown as Array<[Record<string, unknown>, unknown, string, Record<string, unknown>]>;
      expect(calls.map((c) => c[2])).toEqual(["execute", "approveHitl"]);
      for (const [probe, actor, , roles] of calls) {
        expect(probe).toMatchObject({ id: "run-1", runBy: null, orgId: "org-1" });
        expect(probe.effectivePolicy).toBeUndefined();
        expect(actor).toBe(ACTOR);
        expect(roles).toMatchObject({ orgRole: "member", actorOrganizationId: "org-1" });
      }
    });

    it("a run with no human owner is refused to a person outside its organization, before the kernel and any write", async () => {
      storeMock.readAgentRunById.mockResolvedValue(run({ runBy: null }));
      resolveOrgRoleForUser.mockResolvedValue(undefined);
      await expect(decideAs(ACTOR)).rejects.toMatchObject({ statusCode: 404 });
      expect(enforceRunAccess).not.toHaveBeenCalled();
      expect(decisions.decide).not.toHaveBeenCalled();
      expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    });

    it("a person outside the run's organization gets the same answer as a run that is not found", async () => {
      storeMock.readAgentRunById.mockResolvedValue(run({ runBy: null }));
      resolveOrgRoleForUser.mockResolvedValue(undefined);
      const foreign = (await decideAs(ACTOR).catch((e: unknown) => e)) as AuthzError;
      storeMock.readAgentRunById.mockResolvedValue(null);
      const missing = (await decideAs(ACTOR).catch((e: unknown) => e)) as AuthzError;
      expect(foreign).toBeInstanceOf(AuthzError);
      expect(missing).toBeInstanceOf(AuthzError);
      expect([foreign.statusCode, foreign.reason, foreign.message]).toEqual([missing.statusCode, missing.reason, missing.message]);
      expect(decisions.decide).not.toHaveBeenCalled();
    });

    it.each([["an empty string", ""], ["false", false], ["zero", 0], ["a number", 42]])(
      "a run whose owner is %s is not taken as a run with no human owner: refused before the kernel and any write",
      async (_label, runBy) => {
        storeMock.readAgentRunById.mockResolvedValue(run({ runBy }));
        await expect(decideAs(ACTOR)).rejects.toMatchObject({ statusCode: 404 });
        expect(resolveOrgRoleForUser).not.toHaveBeenCalled();
        expect(enforceRunAccess).not.toHaveBeenCalled();
        expect(decisions.decide).not.toHaveBeenCalled();
        expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
      },
    );

    it("a run with no human owner keeps its stored agent ceiling on the kernel probe", async () => {
      const ceiling = [{ tier: "organization", id: "org-1" }];
      storeMock.readAgentRunById.mockResolvedValue(run({ runBy: null, oboCeiling: ceiling }));
      await expect(decideAs(ACTOR)).resolves.toMatchObject({ ok: true });
      for (const call of enforceRunAccess.mock.calls as unknown as Array<[Record<string, unknown>]>) {
        expect(call[0].oboCeiling).toEqual(ceiling);
      }
    });

    it.each(["execute", "approveHitl"])(
      "a run with no human owner is refused when the kernel denies the %s permission",
      async (denied) => {
        storeMock.readAgentRunById.mockResolvedValue(run({ runBy: null }));
        enforceRunAccess.mockImplementation(async (...args: unknown[]) => {
          if (args[2] === denied) throw new AuthzError({ statusCode: 403, reason: "forbidden" });
        });
        await expect(decideAs(ACTOR)).rejects.toBeInstanceOf(AuthzError);
        expect(decisions.decide).not.toHaveBeenCalled();
        expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["a model client", { actorType: "model", source: "mcp", userId: "user-a" }],
      ["an A2A peer", { actorType: "a2a", source: "a2a", userId: "user-a" }],
      ["the system", { actorType: "system", source: "system" }],
      ["an agent acting for a person", { ...ACTOR, oboCeiling: [{ tier: "organization", id: "org-1" }] }],
      ["no actor", undefined],
      // A human label is not enough: only the UI or a session route, with no token scopes, decides.
      ["a human built from the passthrough road's headers", { actorType: "human", source: "a2a", userId: "user-a", orgId: "org-1" }],
      ["a human through the MCP transport", { actorType: "human", source: "mcp", userId: "user-a" }],
      ["a human through a worker", { actorType: "human", source: "worker", userId: "user-a" }],
      ["a human through an agent", { actorType: "human", source: "agent", userId: "user-a" }],
      ["a human through the scheduler", { actorType: "human", source: "scheduler", userId: "user-a" }],
      ["a token-scoped human that holds both permissions", { ...ACTOR, tokenScopes: ["run.execute", "run.approveHitl"] }],
      ["a token-scoped human with no scopes", { ...ACTOR, tokenScopes: [] }],
    ])("%s never decides a publish, and nothing is read or written", async (_label, actor) => {
      storeMock.readAgentRunById.mockResolvedValue(run({ runBy: null }));
      await expect(decideAs(actor)).rejects.toMatchObject({ statusCode: 403 });
      expect(storeMock.readAgentRunById).not.toHaveBeenCalled();
      expect(decisions.decide).not.toHaveBeenCalled();
      expect(sendWayflowResume).not.toHaveBeenCalled();
    });
  });
});
