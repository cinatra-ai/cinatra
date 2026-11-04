// cinatra#4150: the host side of a stop in front of a declared publishing step.
// "Do not publish" (A8), the 24-hour expiry (A9), the late answer, and the hold every
// resume road reads. The park itself is driven through the real input-required branch
// in execution-publish-gate.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AuthzError } from "@/lib/authz/errors";

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(async () => null),
  readRunCoOwners: vi.fn(async () => [] as Array<{ userId: string }>),
  transitionRunStatus: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

const decisions = vi.hoisted(() => ({
  insertParkedDecision: vi.fn(),
  decide: vi.fn(),
  readLatestDecisionForRun: vi.fn(async (_runId: string) => null as unknown),
  readOpenDecisionForRun: vi.fn(async () => null as unknown),
  listDueParked: vi.fn(async () => [] as unknown[]),
  listSettledWithWaitingRun: vi.fn(async () => [] as unknown[]),
}));
vi.mock("../publish-decision-store", () => decisions);

const enforceRunAccess = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../auth-policy", () => ({
  enforceRunAccess,
  resolveEffectivePolicy: () => "owner-only",
}));

const resolveOrgRoleForUser = vi.hoisted(() => vi.fn(async () => "member" as string | undefined));
vi.mock("@/lib/auth-session", () => ({ resolveOrgRoleForUser }));

import {
  PUBLISH_DECISION_NOT_OPEN,
  PUBLISH_DECISION_REQUIRED,
  assertNoOpenPublishDecision,
  declinePublishDecision,
  sweepExpiredPublishDecisions,
} from "../publish-decision-actions";

const ACTOR = { actorType: "human" as const, source: "ui" as const, userId: "user-a" };

function run(status = "pending_approval") {
  return { id: "run-1", templateId: "tmpl-1", orgId: "org-1", runBy: "user-a", authPolicy: null, status };
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: "d1",
    orgId: "org-1",
    runId: "run-1",
    nodeId: "publish",
    gateTaskId: "task-1",
    a2aContextId: "ctx-1",
    status: "parked",
    surfacedValues: { what: "the post" },
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    expiresAt: new Date("2026-11-02T00:00:00Z"),
    ...overrides,
  };
}

const stale = () => Object.assign(new Error("stale"), { code: "stale_from_status" });

beforeEach(() => {
  vi.clearAllMocks();
  storeMock.readAgentRunById.mockResolvedValue(run());
  storeMock.transitionRunStatus.mockResolvedValue(undefined);
  decisions.readOpenDecisionForRun.mockResolvedValue(decision());
  decisions.readLatestDecisionForRun.mockResolvedValue(null);
  decisions.decide.mockImplementation(async (id: string, change: { to: string }) => ({
    outcome: "won",
    decision: decision({ id, status: change.to }),
  }));
  decisions.listDueParked.mockResolvedValue([]);
  decisions.listSettledWithWaitingRun.mockResolvedValue([]);
  enforceRunAccess.mockResolvedValue(undefined);
  resolveOrgRoleForUser.mockResolvedValue("member");
});

describe("the hold every resume road reads", () => {
  it.each(["parked", "declined", "expired", "run_ended"])(
    "a run whose newest decision is %s is refused with publish_decision_required",
    async (status) => {
      decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status }));
      await expect(assertNoOpenPublishDecision("run-1")).rejects.toMatchObject({
        code: PUBLISH_DECISION_REQUIRED,
      });
      expect(decisions.readLatestDecisionForRun).toHaveBeenCalledWith("run-1");
    },
  );

  it("a run with no decision, or a released one, may go on", async () => {
    await expect(assertNoOpenPublishDecision("run-1")).resolves.toBeUndefined();
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released" }));
    await expect(assertNoOpenPublishDecision("run-1")).resolves.toBeUndefined();
  });

  it("an unreadable record is a refusal, never a pass", async () => {
    decisions.readLatestDecisionForRun.mockRejectedValue(new Error("db down"));
    await expect(assertNoOpenPublishDecision("run-1")).rejects.toThrow("db down");
  });

  it("the refusal text names no run, step or value", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValue(decision());
    const err = (await assertNoOpenPublishDecision("run-1").catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("run-1");
    expect(err.message).not.toContain("the post");
    expect(err.message).not.toContain("d1");
  });
});

describe("Do not publish (A8)", () => {
  it("checks run.execute and run.approveHitl, writes ONE declined decision, then stops the run", async () => {
    const answer = await declinePublishDecision({
      runId: "run-1",
      actorId: "user-a",
      actorContext: ACTOR,
      note: "not today",
    });
    expect(answer).toEqual({ ok: true, runStopped: true });
    expect(enforceRunAccess.mock.calls.map((c) => (c as unknown[])[2])).toEqual(["execute", "approveHitl"]);
    expect(decisions.decide).toHaveBeenCalledTimes(1);
    expect(decisions.decide).toHaveBeenCalledWith("d1", {
      from: "parked",
      to: "declined",
      actor: "user-a",
      note: "not today",
    });
    expect(storeMock.transitionRunStatus).toHaveBeenCalledTimes(1);
    const [runId, from, to, patch, authority] = storeMock.transitionRunStatus.mock.calls[0] as unknown as [
      string, string, string, { completedAt?: unknown }, { orgId: string },
    ];
    expect([runId, from, to]).toEqual(["run-1", "pending_approval", "stopped"]);
    expect(patch.completedAt).toBeInstanceOf(Date);
    expect(authority.orgId).toBe("org-1");
    expect(decisions.decide.mock.invocationCallOrder[0]!).toBeLessThan(
      storeMock.transitionRunStatus.mock.invocationCallOrder[0]!,
    );
  });

  it("writes nothing for an actor the run's access rule refuses", async () => {
    enforceRunAccess.mockRejectedValueOnce(new AuthzError({ statusCode: 403, reason: "forbidden" }));
    await expect(
      declinePublishDecision({ runId: "run-1", actorId: "user-b", actorContext: ACTOR }),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("writes nothing for an actor outside the run's organization", async () => {
    resolveOrgRoleForUser.mockResolvedValueOnce(undefined);
    await expect(
      declinePublishDecision({ runId: "run-1", actorId: "user-a", actorContext: ACTOR }),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("an unknown run is hidden and nothing is written", async () => {
    storeMock.readAgentRunById.mockResolvedValue(null);
    enforceRunAccess.mockRejectedValueOnce(new AuthzError({ statusCode: 404, reason: "hidden" }));
    await expect(
      declinePublishDecision({ runId: "run-x", actorId: "user-a", actorContext: ACTOR }),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(decisions.decide).not.toHaveBeenCalled();
  });

  it("a late answer is reported as publish_decision_not_open with the current status", async () => {
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "expired" }));
    expect(
      await declinePublishDecision({ runId: "run-1", actorId: "user-a", actorContext: ACTOR }),
    ).toEqual({ ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: "expired" });
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("an answer that loses the decision write is reported, and the run is not moved", async () => {
    decisions.decide.mockResolvedValueOnce({ outcome: "lost", currentStatus: "declined" });
    expect(
      await declinePublishDecision({ runId: "run-1", actorId: "user-a", actorContext: ACTOR }),
    ).toEqual({ ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: "declined" });
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("a run that already left the gate keeps the decline and reports that it was not stopped here", async () => {
    storeMock.transitionRunStatus.mockRejectedValueOnce(stale());
    expect(
      await declinePublishDecision({ runId: "run-1", actorId: "user-a", actorContext: ACTOR }),
    ).toEqual({ ok: true, runStopped: false });
  });

  it("a store fault on the run move is not swallowed", async () => {
    storeMock.transitionRunStatus.mockRejectedValueOnce(new Error("db down"));
    await expect(
      declinePublishDecision({ runId: "run-1", actorId: "user-a", actorContext: ACTOR }),
    ).rejects.toThrow("db down");
  });

  it.each([
    ["no note", undefined],
    ["a null note", null],
    ["an empty note", ""],
    ["a note of blanks only", "   \n "],
  ])("%s is recorded as no note", async (_label, note) => {
    expect(
      await declinePublishDecision({ runId: "run-1", actorId: "user-a", actorContext: ACTOR, note }),
    ).toEqual({ ok: true, runStopped: true });
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "declined", actor: "user-a", note: null });
  });

  it("a note the store refuses (over its cap) is not swallowed, and the run is not moved", async () => {
    const longNote = "n".repeat(2001);
    decisions.decide.mockRejectedValueOnce(
      Object.assign(new Error("note must be a non-empty string of at most 2000 characters"), { code: "invalid-input" }),
    );
    await expect(
      declinePublishDecision({ runId: "run-1", actorId: "user-a", actorContext: ACTOR, note: longNote }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "declined", actor: "user-a", note: longNote });
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });
});

describe("the 24-hour expiry (A9)", () => {
  const NOW = new Date("2026-11-02T00:00:01Z");
  const authorityFor = vi.fn((orgId: string) => ({ orgId, can: () => true }));

  it("closes a due decision expired with no person and stops its waiting run", async () => {
    decisions.listDueParked.mockResolvedValue([decision()]);
    const summary = await sweepExpiredPublishDecisions({ authorityFor, now: NOW });
    expect(decisions.listDueParked).toHaveBeenCalledWith(50, NOW);
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "expired", actor: null });
    expect(storeMock.transitionRunStatus).toHaveBeenCalledTimes(1);
    const [runId, from, to, , authority] = storeMock.transitionRunStatus.mock.calls[0] as unknown as [
      string, string, string, unknown, { orgId: string },
    ];
    expect([runId, from, to]).toEqual(["run-1", "pending_approval", "stopped"]);
    expect(authority.orgId).toBe("org-1");
    expect(authorityFor).toHaveBeenCalledWith("org-1");
    expect(summary).toEqual({ due: 1, expired: 1, runEnded: 0, lost: 0, failed: 0, stopped: 0 });
  });

  it("closes the row run_ended, not expired, when the run was stopped by other means", async () => {
    decisions.listDueParked.mockResolvedValue([decision()]);
    storeMock.readAgentRunById.mockResolvedValue(run("stopped"));
    const summary = await sweepExpiredPublishDecisions({ authorityFor, now: NOW });
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "run_ended", actor: null });
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(summary).toEqual({ due: 1, expired: 0, runEnded: 1, lost: 0, failed: 0, stopped: 0 });
  });

  it("a decision answered meanwhile is left as answered", async () => {
    decisions.listDueParked.mockResolvedValue([decision()]);
    decisions.decide.mockResolvedValueOnce({ outcome: "lost", currentStatus: "declined" });
    const summary = await sweepExpiredPublishDecisions({ authorityFor, now: NOW });
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(summary.lost).toBe(1);
  });

  it("one row's fault does not stop the next row", async () => {
    decisions.listDueParked.mockResolvedValue([decision({ id: "d1" }), decision({ id: "d2", runId: "run-2" })]);
    decisions.decide
      .mockRejectedValueOnce(new Error("db down"))
      .mockImplementationOnce(async (id: string) => ({ outcome: "won", decision: decision({ id, status: "expired" }) }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const summary = await sweepExpiredPublishDecisions({ authorityFor, now: NOW });
      expect(summary).toEqual({ due: 2, expired: 1, runEnded: 0, lost: 0, failed: 1, stopped: 0 });
      const logged = error.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).not.toContain("db down");
      expect(logged).not.toMatch(/d1|d2|run-1|run-2/);
    } finally {
      error.mockRestore();
    }
  });

  it("closes the row run_ended when the run row is gone", async () => {
    decisions.listDueParked.mockResolvedValue([decision()]);
    storeMock.readAgentRunById.mockResolvedValue(null);
    const summary = await sweepExpiredPublishDecisions({ authorityFor, now: NOW });
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "run_ended", actor: null });
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(summary).toEqual({ due: 1, expired: 0, runEnded: 1, lost: 0, failed: 0, stopped: 0 });
  });

  it("a run that leaves the gate between the decision and its stop keeps the expired decision", async () => {
    decisions.listDueParked.mockResolvedValue([decision()]);
    storeMock.transitionRunStatus.mockRejectedValueOnce(stale());
    const summary = await sweepExpiredPublishDecisions({ authorityFor, now: NOW });
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "expired", actor: null });
    expect(summary).toEqual({ due: 1, expired: 1, runEnded: 0, lost: 0, failed: 0, stopped: 0 });
  });

  it("a store fault on the stop after a won decision counts as failed, and the next pass finishes the stop", async () => {
    decisions.listDueParked.mockResolvedValueOnce([decision()]);
    storeMock.transitionRunStatus.mockRejectedValueOnce(new Error("db down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await sweepExpiredPublishDecisions({ authorityFor, now: NOW })).toEqual({
        due: 1, expired: 0, runEnded: 0, lost: 0, failed: 1, stopped: 0,
      });
      expect(error.mock.calls.map((c) => String(c[0])).join("\n")).not.toMatch(/db down|d1|run-1/);
    } finally {
      error.mockRestore();
    }
    // The row is expired now and the run still waits: the next pass stops it.
    const expired = decision({ status: "expired" });
    decisions.listSettledWithWaitingRun.mockResolvedValueOnce([expired]);
    decisions.readLatestDecisionForRun.mockResolvedValueOnce(expired);
    expect(await sweepExpiredPublishDecisions({ authorityFor, now: NOW })).toEqual({
      due: 0, expired: 0, runEnded: 0, lost: 0, failed: 0, stopped: 1,
    });
    const [runId, from, to] = storeMock.transitionRunStatus.mock.calls.at(-1) as unknown as [string, string, string];
    expect([runId, from, to]).toEqual(["run-1", "pending_approval", "stopped"]);
    expect(decisions.decide).toHaveBeenCalledTimes(1);
  });

  it("an unreadable due list is not swallowed", async () => {
    decisions.listDueParked.mockRejectedValue(new Error("db down"));
    await expect(sweepExpiredPublishDecisions({ authorityFor, now: NOW })).rejects.toThrow("db down");
  });
});

describe("the expiry finishes a stop a decline or an expiry decided but did not make (C4)", () => {
  const NOW = new Date("2026-11-02T00:00:01Z");
  const authorityFor = vi.fn((orgId: string) => ({ orgId, can: () => true }));

  it.each(["declined", "expired"])(
    "a run still in pending_approval whose newest decision is %s is stopped, and nothing is decided again",
    async (status) => {
      const row = decision({ status });
      decisions.listSettledWithWaitingRun.mockResolvedValue([row]);
      decisions.readLatestDecisionForRun.mockResolvedValue(row);
      const summary = await sweepExpiredPublishDecisions({ authorityFor, now: NOW });
      expect(decisions.listSettledWithWaitingRun).toHaveBeenCalledWith(50);
      expect(decisions.decide).not.toHaveBeenCalled();
      expect(storeMock.transitionRunStatus).toHaveBeenCalledTimes(1);
      const [runId, from, to, patch, authority] = storeMock.transitionRunStatus.mock.calls[0] as unknown as [
        string, string, string, { completedAt?: unknown }, { orgId: string },
      ];
      expect([runId, from, to]).toEqual(["run-1", "pending_approval", "stopped"]);
      expect(patch.completedAt).toBeInstanceOf(Date);
      expect(authority.orgId).toBe("org-1");
      expect(summary).toEqual({ due: 0, expired: 0, runEnded: 0, lost: 0, failed: 0, stopped: 1 });
    },
  );

  it("a newer decision of the run governs it: no move", async () => {
    decisions.listSettledWithWaitingRun.mockResolvedValue([decision({ status: "declined" })]);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ id: "d9", status: "released" }));
    expect((await sweepExpiredPublishDecisions({ authorityFor, now: NOW })).stopped).toBe(0);
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("a run that left pending_approval, or is gone, is not moved", async () => {
    const row = decision({ status: "declined" });
    decisions.listSettledWithWaitingRun.mockResolvedValue([row]);
    decisions.readLatestDecisionForRun.mockResolvedValue(row);
    storeMock.readAgentRunById.mockResolvedValueOnce(run("stopped")).mockResolvedValueOnce(null);
    await sweepExpiredPublishDecisions({ authorityFor, now: NOW });
    await sweepExpiredPublishDecisions({ authorityFor, now: NOW });
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("a stale answer is no failure; a store fault counts as failed and the next row still runs", async () => {
    const a = decision({ id: "d1", status: "declined" });
    const b = decision({ id: "d2", runId: "run-2", status: "expired" });
    const c = decision({ id: "d3", runId: "run-3", status: "expired" });
    decisions.listSettledWithWaitingRun.mockResolvedValue([a, b, c]);
    decisions.readLatestDecisionForRun.mockImplementation(async (runId: string) => [a, b, c].find((r) => r.runId === runId));
    storeMock.readAgentRunById.mockImplementation(async (runId: string) => ({ ...run(), id: runId }));
    storeMock.transitionRunStatus
      .mockRejectedValueOnce(stale())
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await sweepExpiredPublishDecisions({ authorityFor, now: NOW })).toEqual({
        due: 0, expired: 0, runEnded: 0, lost: 0, failed: 1, stopped: 1,
      });
      expect(error.mock.calls.map((x) => String(x[0])).join("\n")).not.toMatch(/db down|d2|run-2/);
    } finally {
      error.mockRestore();
    }
  });

  it("an unreadable list of unmade stops is not swallowed", async () => {
    decisions.listSettledWithWaitingRun.mockRejectedValue(new Error("db down"));
    await expect(sweepExpiredPublishDecisions({ authorityFor, now: NOW })).rejects.toThrow("db down");
  });
});

describe("the decision road never travels the approve road", () => {
  const src = readFileSync(join(__dirname, "..", "publish-decision-actions.ts"), "utf8");

  it("sends nothing to a flow context and reads no feature fence", () => {
    expect(src).not.toMatch(/sendTask|createExternalA2AClient/);
    expect(src).not.toMatch(/isLifecycleReviewOrchestrationActive|lifecycle-activation|sweepLifecycleGateMaintenance\(/);
  });

  it("mints no execution authority of its own", () => {
    expect(src).not.toContain("mintAgentRunExecutionAuthority");
  });
});
