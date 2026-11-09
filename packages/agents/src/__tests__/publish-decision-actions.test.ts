// cinatra#4150: the host side of a stop in front of a declared publishing step.
// "Do not publish" (A8), the 24-hour expiry (A9), the late answer, and the hold every
// resume road reads. The park itself is driven through the real input-required branch
// in execution-publish-gate.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AuthzError } from "@/lib/authz/errors";
import { RunTransitionError } from "../run-status";

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
  claimRunBeforeSend,
  declinePublishDecision,
  publishHoldAnswer,
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
  // clearAllMocks keeps queued once-answers; a case that leaves one (a red run over older code) must not feed the next.
  for (const m of [storeMock.readAgentRunById, storeMock.transitionRunStatus, decisions.readOpenDecisionForRun,
    decisions.readLatestDecisionForRun, decisions.decide, decisions.listDueParked, decisions.listSettledWithWaitingRun]) m.mockReset();
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
    await expect(assertNoOpenPublishDecision("run-1")).resolves.toBe(false);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released" }));
    await expect(assertNoOpenPublishDecision("run-1")).resolves.toBe(true);
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
      declinePublishDecision({ runId: "run-1", actorContext: ACTOR }),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("writes nothing for an actor outside the run's organization", async () => {
    resolveOrgRoleForUser.mockResolvedValueOnce(undefined);
    await expect(
      declinePublishDecision({ runId: "run-1", actorContext: ACTOR }),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("an unknown run is hidden and nothing is written", async () => {
    storeMock.readAgentRunById.mockResolvedValue(null);
    enforceRunAccess.mockRejectedValueOnce(new AuthzError({ statusCode: 404, reason: "hidden" }));
    await expect(
      declinePublishDecision({ runId: "run-x", actorContext: ACTOR }),
    ).rejects.toBeInstanceOf(AuthzError);
    expect(decisions.decide).not.toHaveBeenCalled();
  });

  it("a late answer is reported as publish_decision_not_open with the current status", async () => {
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "expired" }));
    expect(
      await declinePublishDecision({ runId: "run-1", actorContext: ACTOR }),
    ).toEqual({ ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: "expired" });
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("an answer that loses the decision write is reported, and the run is not moved", async () => {
    decisions.decide.mockResolvedValueOnce({ outcome: "lost", currentStatus: "declined" });
    expect(
      await declinePublishDecision({ runId: "run-1", actorContext: ACTOR }),
    ).toEqual({ ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: "declined" });
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("a run that already left the gate keeps the decline and reports that it was not stopped here", async () => {
    storeMock.transitionRunStatus.mockRejectedValueOnce(stale());
    expect(
      await declinePublishDecision({ runId: "run-1", actorContext: ACTOR }),
    ).toEqual({ ok: true, runStopped: false });
  });

  it("a store fault on the run move is not swallowed, and its text carries no id or store error", async () => {
    storeMock.transitionRunStatus.mockRejectedValueOnce(new Error("db down: run-1"));
    const err = (await declinePublishDecision({ runId: "run-1", actorContext: ACTOR }).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe("publish_decision_unavailable");
    expect(err.message).not.toMatch(/db down|run-1/);
  });

  it.each([
    ["no note", undefined],
    ["a null note", null],
    ["an empty note", ""],
    ["a note of blanks only", "   \n "],
  ])("%s is recorded as no note", async (_label, note) => {
    expect(
      await declinePublishDecision({ runId: "run-1", actorContext: ACTOR, note }),
    ).toEqual({ ok: true, runStopped: true });
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "declined", actor: "user-a", note: null });
  });

  it("a note the store refuses (over its cap) is not swallowed, and the run is not moved", async () => {
    const longNote = "n".repeat(2001);
    decisions.decide.mockRejectedValueOnce(
      Object.assign(new Error("note must be a non-empty string of at most 2000 characters"), { code: "invalid-input" }),
    );
    await expect(
      declinePublishDecision({ runId: "run-1", actorContext: ACTOR, note: longNote }),
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
    expect(decisions.listDueParked).toHaveBeenCalledWith(50, NOW, undefined);
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "expired", actor: null, newestOnly: true });
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
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "expired", actor: null, newestOnly: true });
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
      const summary = await sweepExpiredPublishDecisions({ authorityFor, now: NOW });
      expect(decisions.listSettledWithWaitingRun).toHaveBeenCalledWith(50, undefined);
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

  it("a run that left pending_approval, or is gone, is not moved", async () => {
    const row = decision({ status: "declined" });
    decisions.listSettledWithWaitingRun.mockResolvedValue([row]);
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

// ---------------------------------------------------------------------------
// The fold of pre-review 2 (cinatra#4150 PR 3a, findings 1-5).
// ---------------------------------------------------------------------------

describe("Do not publish binds every check and the record to one person (finding 1)", () => {
  it("the decider is the actor context's person: the access checks, the membership and the record all name them", async () => {
    expect(await declinePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, runStopped: true });
    expect(enforceRunAccess.mock.calls.map((c) => (c as unknown[])[1])).toEqual([ACTOR, ACTOR]);
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith("org-1", "user-a");
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "declined", actor: "user-a", note: null });
  });

  it("an id passed beside the context is not read: the record names the context's person", async () => {
    await declinePublishDecision({ runId: "run-1", actorContext: ACTOR, actorId: "user-b" } as never);
    expect(resolveOrgRoleForUser).toHaveBeenCalledWith("org-1", "user-a");
    expect(resolveOrgRoleForUser).not.toHaveBeenCalledWith("org-1", "user-b");
    expect(decisions.decide).toHaveBeenCalledWith("d1", expect.objectContaining({ actor: "user-a" }));
  });

  it.each([
    ["a model client", { actorType: "model", source: "mcp", userId: "user-a" }],
    ["an A2A peer", { actorType: "a2a", source: "a2a", userId: "user-a" }],
    ["the system", { actorType: "system", source: "worker", userId: "user-a" }],
    ["an agent acting for a person", { ...ACTOR, oboCeiling: [{ tier: "organization", id: "org-1" }] }],
    ["a person with no user id", { actorType: "human", source: "ui" }],
    ["a person with an empty user id", { ...ACTOR, userId: "" }],
    ["no actor context (null)", null],
    ["no actor context (absent)", undefined],
  ])("%s is refused before anything is read or written", async (_label, actorContext) => {
    await expect(
      declinePublishDecision({ runId: "run-1", actorContext: actorContext as never }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(storeMock.readAgentRunById).not.toHaveBeenCalled();
    expect(enforceRunAccess).not.toHaveBeenCalled();
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
  });
});

describe("Do not publish answers a store fault with a fixed text (finding 5)", () => {
  it.each([
    ["the decision write", () => decisions.decide.mockRejectedValueOnce(new Error("insert failed: d1 user-a not today"))],
    ["the open-decision read", () => decisions.readOpenDecisionForRun.mockRejectedValueOnce(new Error("select failed: run-1"))],
    ["the latest-decision read of a late answer", () => {
      decisions.readOpenDecisionForRun.mockResolvedValueOnce(null);
      decisions.readLatestDecisionForRun.mockRejectedValueOnce(new Error("select failed: run-1"));
    }],
  ])("a raw fault of %s names no id, person, note or store error", async (_label, arrange) => {
    arrange();
    const err = (await declinePublishDecision({ runId: "run-1", actorContext: ACTOR, note: "not today" })
      .catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe("publish_decision_unavailable");
    expect(err.message).not.toMatch(/failed|d1|run-1|user-a|not today/);
    expect("cause" in err).toBe(false);
  });

  // The independent self-check of pre-review 2's fold (C2): every store code passes, and a run move's own refusal does not.
  it.each(["invalid-transition", "malformed-row", "not-found", "conflict"])(
    "the store's own %s refusal of the decision write passes unchanged, and the run is not moved",
    async (code) => {
      const refusal = Object.assign(new Error(`the store refused: ${code}`), { code });
      decisions.decide.mockRejectedValueOnce(refusal);
      const err = await declinePublishDecision({ runId: "run-1", actorContext: ACTOR }).catch((e: unknown) => e);
      expect(err).toBe(refusal);
      expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    },
  );

  it("a run move refused as an illegal transition (not a stale answer) answers the fixed text, with no run id", async () => {
    storeMock.transitionRunStatus.mockRejectedValueOnce(
      new RunTransitionError({ code: "illegal_transition", runId: "run-1", from: "pending_approval", to: "stopped" }),
    );
    const err = (await declinePublishDecision({ runId: "run-1", actorContext: ACTOR }).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe("publish_decision_unavailable");
    expect(err.message).not.toMatch(/run-1|illegal|transitionRunStatus/);
    expect("cause" in err).toBe(false);
    expect(decisions.decide).toHaveBeenCalledTimes(1);
  });
});

describe("the expiry stops a run whose hold wrote its row but not its move (finding 2)", () => {
  const NOW = new Date("2026-11-02T00:00:01Z");
  const authorityFor = vi.fn((orgId: string) => ({ orgId, can: () => true }));

  it("a due decision whose run is still running is expired, and the run moves running -> stopped", async () => {
    decisions.listDueParked.mockResolvedValue([decision()]);
    storeMock.readAgentRunById.mockResolvedValue(run("running"));
    const summary = await sweepExpiredPublishDecisions({ authorityFor, now: NOW });
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "expired", actor: null, newestOnly: true });
    const [runId, from, to] = storeMock.transitionRunStatus.mock.calls[0] as unknown as [string, string, string];
    expect([runId, from, to]).toEqual(["run-1", "running", "stopped"]);
    expect(summary).toEqual({ due: 1, expired: 1, runEnded: 0, lost: 0, failed: 0, stopped: 0 });
  });

  it("a decline that wins while the hold has not yet moved the run is finished by the next pass", async () => {
    // The decline: its decision write wins, its stop from pending_approval answers stale (the run is still running).
    storeMock.readAgentRunById.mockResolvedValue(run("running"));
    storeMock.transitionRunStatus.mockRejectedValueOnce(stale());
    expect(await declinePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, runStopped: false });
    // The next pass: the declined row is the run's newest and the run is still running.
    decisions.listSettledWithWaitingRun.mockResolvedValueOnce([decision({ status: "declined" })]);
    const summary = await sweepExpiredPublishDecisions({ authorityFor, now: NOW });
    const [runId, from, to] = storeMock.transitionRunStatus.mock.calls.at(-1) as unknown as [string, string, string];
    expect([runId, from, to]).toEqual(["run-1", "running", "stopped"]);
    expect(summary.stopped).toBe(1);
  });
});

describe("the expiry reads every page of unmade stops (finding 4)", () => {
  const NOW = new Date("2026-11-02T00:00:01Z");
  const authorityFor = vi.fn((orgId: string) => ({ orgId, can: () => true }));

  it("a full page is followed by the next one, after its last id, until a page is short", async () => {
    const rows = ["d1", "d2", "d3"].map((id, i) => decision({ id, runId: `run-${i + 1}`, status: "declined" }));
    decisions.listSettledWithWaitingRun.mockResolvedValueOnce(rows.slice(0, 2)).mockResolvedValueOnce(rows.slice(2));
    storeMock.readAgentRunById.mockImplementation(async (runId: string) => ({ ...run(), id: runId }));
    const summary = await sweepExpiredPublishDecisions({ authorityFor, now: NOW, limit: 2 });
    expect(decisions.listSettledWithWaitingRun.mock.calls).toEqual([[2, undefined], [2, "d2"]]);
    expect(storeMock.transitionRunStatus.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["run-1", "run-2", "run-3"]);
    expect(summary.stopped).toBe(3);
  });

  it("a page of stops that keep failing does not hide the next page", async () => {
    const rows = ["d1", "d2", "d3"].map((id, i) => decision({ id, runId: `run-${i + 1}`, status: "expired" }));
    decisions.listSettledWithWaitingRun.mockResolvedValueOnce(rows.slice(0, 2)).mockResolvedValueOnce(rows.slice(2));
    storeMock.readAgentRunById.mockImplementation(async (runId: string) => ({ ...run(), id: runId }));
    storeMock.transitionRunStatus
      .mockRejectedValueOnce(new Error("db down"))
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await sweepExpiredPublishDecisions({ authorityFor, now: NOW, limit: 2 })).toEqual({
        due: 0, expired: 0, runEnded: 0, lost: 0, failed: 2, stopped: 1,
      });
    } finally {
      error.mockRestore();
    }
    expect((storeMock.transitionRunStatus.mock.calls.at(-1) as unknown[])[0]).toBe("run-3");
  });

  it("the pass reads the run's newest decision again before the stop, and stops when it is still the listed one", async () => {
    const row = decision({ status: "declined" });
    decisions.listSettledWithWaitingRun.mockResolvedValue([row]);
    decisions.readLatestDecisionForRun.mockResolvedValue(row);
    await sweepExpiredPublishDecisions({ authorityFor, now: NOW });
    expect(decisions.readLatestDecisionForRun).toHaveBeenCalledWith("run-1");
    expect(storeMock.transitionRunStatus).toHaveBeenCalledTimes(1);
  });
});

describe("the claim a pending_approval road makes before its send (finding 3)", () => {
  const AUTH = { orgId: "org-1" } as never;
  const moves = () => storeMock.transitionRunStatus.mock.calls.map((c) => (c as unknown[]).slice(0, 3));

  it("a template with no publishing step: no claim and no read; the road goes on from pending_approval", async () => {
    expect(await claimRunBeforeSend("run-1", false, AUTH)).toBe("pending_approval");
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(decisions.readLatestDecisionForRun).not.toHaveBeenCalled();
  });

  it("a publishing template: the run is claimed FIRST, then the hold is read; the road goes on from running", async () => {
    expect(await claimRunBeforeSend("run-1", true, AUTH)).toBe("running");
    expect(moves()).toEqual([["run-1", "pending_approval", "running"]]);
    expect(storeMock.transitionRunStatus.mock.invocationCallOrder[0]!).toBeLessThan(
      decisions.readLatestDecisionForRun.mock.invocationCallOrder[0]!,
    );
  });

  it("a decision parked after the road's first read refuses the send and puts the run back", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValueOnce(decision());
    await expect(claimRunBeforeSend("run-1", true, AUTH)).rejects.toMatchObject({ code: PUBLISH_DECISION_REQUIRED });
    expect(moves()).toEqual([["run-1", "pending_approval", "running"], ["run-1", "running", "pending_approval"]]);
  });

  it("an unreadable hold after the claim puts the run back and propagates", async () => {
    decisions.readLatestDecisionForRun.mockRejectedValueOnce(new Error("db down"));
    await expect(claimRunBeforeSend("run-1", true, AUTH)).rejects.toThrow("db down");
    expect(moves()).toEqual([["run-1", "pending_approval", "running"], ["run-1", "running", "pending_approval"]]);
  });

  it("a put-back that fails still answers the refusal; the run stays running, where no road resumes it", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValueOnce(decision());
    storeMock.transitionRunStatus.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("db down"));
    await expect(claimRunBeforeSend("run-1", true, AUTH)).rejects.toMatchObject({ code: PUBLISH_DECISION_REQUIRED });
  });

  it("a lost claim (another road holds the run) answers null and reads nothing", async () => {
    storeMock.transitionRunStatus.mockRejectedValueOnce(stale());
    expect(await claimRunBeforeSend("run-1", true, AUTH)).toBeNull();
    expect(decisions.readLatestDecisionForRun).not.toHaveBeenCalled();
  });

  it("agent_run_resume's answer names the refusal code, and an unreadable hold only by a fixed text", () => {
    const required = Object.assign(new Error("This run waits at a publish decision."), { code: PUBLISH_DECISION_REQUIRED });
    expect(publishHoldAnswer(required)).toEqual({ error: required.message, code: PUBLISH_DECISION_REQUIRED });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const answer = publishHoldAnswer(new Error("db down: run-1"));
      expect(answer.code).toBeUndefined();
      expect(answer.error).not.toMatch(/db down|run-1/);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toMatch(/db down|run-1/);
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// The fold of pre-review 3 (cinatra#4150 PR 3a, findings 1-6).
// ---------------------------------------------------------------------------

describe("the hold read tells a road whether the run met a publish gate before (finding 1)", () => {
  it("answers true for a released decision and false for none, so a road claims the run of any template with a decision", async () => {
    decisions.readLatestDecisionForRun.mockResolvedValueOnce(decision({ status: "released" }));
    expect(await assertNoOpenPublishDecision("run-1")).toBe(true);
    decisions.readLatestDecisionForRun.mockResolvedValueOnce(null);
    expect(await assertNoOpenPublishDecision("run-1")).toBe(false);
  });
});

describe("the expiry decides only a run's newest decision, in the same write (finding 2)", () => {
  const NOW = new Date("2026-11-02T00:00:01Z");
  const authorityFor = vi.fn((orgId: string) => ({ orgId, can: () => true }));

  it("a due row a newer decision superseded closes run_ended, and its run is not moved", async () => {
    decisions.listDueParked.mockResolvedValue([decision()]);
    storeMock.readAgentRunById.mockResolvedValue(run("running"));
    decisions.decide
      .mockResolvedValueOnce({ outcome: "lost", currentStatus: "parked" })
      .mockImplementationOnce(async (id: string) => ({ outcome: "won", decision: decision({ id, status: "run_ended" }) }));
    const summary = await sweepExpiredPublishDecisions({ authorityFor, now: NOW });
    expect(decisions.decide.mock.calls).toEqual([
      ["d1", { from: "parked", to: "expired", actor: null, newestOnly: true }],
      ["d1", { from: "parked", to: "run_ended", actor: null }],
    ]);
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(summary).toEqual({ due: 1, expired: 0, runEnded: 1, lost: 0, failed: 0, stopped: 0 });
  });

  it("an unmade stop whose run met a newer decision after the list was read is not stopped", async () => {
    decisions.listSettledWithWaitingRun.mockResolvedValue([decision({ status: "declined" })]);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ id: "d2", status: "parked" }));
    const summary = await sweepExpiredPublishDecisions({ authorityFor, now: NOW });
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(summary.stopped).toBe(0);
  });
});

describe("the expiry reads every page of due decisions (finding 5)", () => {
  const NOW = new Date("2026-11-02T00:00:01Z");
  const authorityFor = vi.fn((orgId: string) => ({ orgId, can: () => true }));

  it("a full page of due rows whose writes keep failing does not hide the next page", async () => {
    const rows = ["d1", "d2", "d3"].map((id, i) => decision({ id, runId: `run-${i + 1}` }));
    decisions.listDueParked.mockResolvedValueOnce(rows.slice(0, 2)).mockResolvedValueOnce(rows.slice(2));
    storeMock.readAgentRunById.mockImplementation(async (runId: string) => ({ ...run(), id: runId }));
    decisions.decide
      .mockRejectedValueOnce(new Error("db down"))
      .mockRejectedValueOnce(new Error("db down"))
      .mockImplementationOnce(async (id: string) => ({ outcome: "won", decision: decision({ id, status: "expired" }) }));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await sweepExpiredPublishDecisions({ authorityFor, now: NOW, limit: 2 })).toEqual({
        due: 3, expired: 1, runEnded: 0, lost: 0, failed: 2, stopped: 0,
      });
    } finally {
      error.mockRestore();
    }
    expect(decisions.listDueParked.mock.calls).toEqual([[2, NOW, undefined], [2, NOW, "d2"]]);
    expect((storeMock.transitionRunStatus.mock.calls[0] as unknown[])[0]).toBe("run-3");
  });
});

describe("Do not publish answers every fault after the person check with a fixed text (finding 3)", () => {
  it.each([
    ["the run read", () => storeMock.readAgentRunById.mockRejectedValueOnce(new Error("select failed: run-1 user-a"))],
    ["the template read", () => storeMock.readAgentTemplateById.mockRejectedValueOnce(new Error("select failed: tmpl-1"))],
    ["the co-owner read", () => storeMock.readRunCoOwners.mockRejectedValueOnce(new Error("select failed: run-1"))],
    ["the membership read", () => resolveOrgRoleForUser.mockRejectedValueOnce(new Error("select failed: org-1 user-a"))],
    ["a fault that is not an Error", () => storeMock.readAgentRunById.mockRejectedValueOnce("run-1 user-a")],
  ])("a fault of %s names no id, person or store error", async (_label, arrange) => {
    arrange();
    const err = (await declinePublishDecision({ runId: "run-1", actorContext: ACTOR })
      .catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe("publish_decision_unavailable");
    expect(err.message).not.toMatch(/failed|run-1|tmpl-1|org-1|user-a/);
    expect("cause" in err).toBe(false);
    expect(decisions.decide).not.toHaveBeenCalled();
  });

  it("an access refusal still passes unchanged", async () => {
    const refusal = new AuthzError({ statusCode: 403, reason: "forbidden" });
    enforceRunAccess.mockRejectedValueOnce(refusal);
    expect(await declinePublishDecision({ runId: "run-1", actorContext: ACTOR }).catch((e: unknown) => e)).toBe(refusal);
  });
});

describe("a put-back that fails after a read error (finding 4)", () => {
  const AUTH = { orgId: "org-1" } as never;

  it("the read error propagates and the run stays running, where no resume road claims it", async () => {
    decisions.readLatestDecisionForRun.mockRejectedValueOnce(new Error("db down"));
    storeMock.transitionRunStatus.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("db down"));
    await expect(claimRunBeforeSend("run-1", true, AUTH)).rejects.toThrow("db down");
    expect(storeMock.transitionRunStatus.mock.calls.map((c) => (c as unknown[]).slice(1, 3))).toEqual([
      ["pending_approval", "running"], ["running", "pending_approval"],
    ]);
  });
});

describe("the write registry tells the truth about the decline's authority (finding 6)", () => {
  const registry = readFileSync(join(__dirname, "..", "..", "..", "..", "src/lib/org-write/write-registry.ts"), "utf8");
  const src = readFileSync(join(__dirname, "..", "publish-decision-actions.ts"), "utf8");

  it("the registry names the member-session authority the decline derives, and claims no 'no authority of its own'", () => {
    const at = registry.indexOf('"packages/agents/src/publish-decision-actions.ts"');
    expect(at).toBeGreaterThan(-1);
    const note = registry.slice(registry.lastIndexOf("cinatra#4150", at), at);
    expect(note).not.toMatch(/mints no authority of its own/);
    expect(note).toMatch(/sessionAuthorityFromResolvedRole/);
  });

  it("the decline's one authority is the decider's member session in the run's org", () => {
    expect(src.match(/sessionAuthorityFromResolvedRole\(/g)).toHaveLength(1);
    expect(src).toContain("sessionAuthorityFromResolvedRole(run.orgId, role)");
  });
});
