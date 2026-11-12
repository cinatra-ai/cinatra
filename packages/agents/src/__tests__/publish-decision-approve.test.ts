// cinatra#4150 part 5a: "Publish" lets a run held at a publish gate go on (A7), and who may decide a publish on a run
// with no human owner (A11). The shared WayFlow resume itself is driven by the generic approve's suites; here it is a
// double, so these cases pin the order: the authority, ONE released decision, the claim, then ONE send.
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
vi.mock("../review-task-actions", () => ({ sendWayflowResume }));

const assertAgentRunDispatchAuthorized = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../agent-run-serde", () => ({ assertAgentRunDispatchAuthorized }));

vi.mock("../wayflow-url", () => ({ resolveWayflowUrl: (pkg: string) => `http://wayflow.test/${pkg}` }));

// The run's current gate visit (the latest-task map the interrupt writes): "task-1" is the gate task of decision() below.
const resolveLatestWayflowGateTaskId = vi.hoisted(() => vi.fn(async (_runId: string): Promise<string | null> => "task-1"));
vi.mock("@cinatra-ai/a2a", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveLatestWayflowGateTaskId,
}));

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
    status: "pending_approval", a2aContextId: "ctx-1", a2aTaskId: "task-1", ...overrides,
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
    enforceRunAccess, resolveOrgRoleForUser, assertAgentRunDispatchAuthorized, resolveLatestWayflowGateTaskId]) m.mockReset();
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
});

describe("Publish (A7)", () => {
  it("checks the decider, writes ONE released decision, then claims the run and sends once into its held context", async () => {
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: true });
    expect(enforceRunAccess.mock.calls.map((c) => (c as unknown[])[2])).toEqual(["execute", "approveHitl"]);
    expect(assertAgentRunDispatchAuthorized).toHaveBeenCalledWith({ runId: "run-1", stage: "dispatch", actingUserId: "user-a" });
    expect(decisions.decide).toHaveBeenCalledTimes(1);
    expect(decisions.decide).toHaveBeenCalledWith("d1", { from: "parked", to: "released", actor: "user-a" });
    expect(moves()).toEqual([["run-1", "pending_approval", "running"]]);
    expect(sendWayflowResume).toHaveBeenCalledTimes(1);
    const args = sendWayflowResume.mock.calls[0]![0] as Record<string, unknown> & { authority: { orgId: string } };
    expect(args.contextId).toBe("ctx-1");
    expect(args.agentUrl).toBe("http://wayflow.test/@acme/poster");
    expect(typeof args.text).toBe("string");
    expect((args.text as string).length).toBeGreaterThan(0);
    expect((args.run as { id: string }).id).toBe("run-1");
    expect(args.authority.orgId).toBe("org-1");
    const order = [
      decisions.decide.mock.invocationCallOrder[0]!,
      storeMock.transitionRunStatus.mock.invocationCallOrder[0]!,
      sendWayflowResume.mock.invocationCallOrder[0]!,
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("a second Publish resumes nothing more", async () => {
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released" }));
    storeMock.transitionRunStatus.mockRejectedValueOnce(stale());
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: false });
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("a Publish that loses the decision write to another Publish sends nothing when that one holds the run", async () => {
    decisions.decide.mockResolvedValueOnce({ outcome: "lost", currentStatus: "released" });
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released" }));
    storeMock.transitionRunStatus.mockRejectedValueOnce(stale());
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: false });
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
      expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
      expect(sendWayflowResume).not.toHaveBeenCalled();
    },
  );

  it("a Publish that loses the decision write to Do not publish is reported and nothing is sent", async () => {
    decisions.decide.mockResolvedValueOnce({ outcome: "lost", currentStatus: "declined" });
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "declined" }));
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({
      ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: "declined",
    });
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
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

  it("a resume that fails before its send puts the run back, keeps the decision, and Publish again retries only the resume", async () => {
    sendWayflowResume.mockRejectedValueOnce(new Error("wayflow down: run-1 ctx-1"));
    const err = (await approvePublishDecision({ runId: "run-1", actorContext: ACTOR }).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe("publish_resume_failed");
    expect(err.message).not.toMatch(/wayflow down|run-1|ctx-1/);
    expect(moves()).toEqual([["run-1", "pending_approval", "running"], ["run-1", "running", "pending_approval"]]);

    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released" }));
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: true });
    expect(decisions.decide).toHaveBeenCalledTimes(1);
    expect(sendWayflowResume).toHaveBeenCalledTimes(2);
  });

  it("a Publish after the run parked at a later gate sends nothing", async () => {
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released", gateTaskId: "task-1" }));
    resolveLatestWayflowGateTaskId.mockResolvedValue("task-7");
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: false });
    expect(resolveLatestWayflowGateTaskId).toHaveBeenCalledWith("run-1");
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("two Publishes at once: the one that claims after the other's resume reached a later gate gives the claim back and sends nothing", async () => {
    // The loser read the decision's own gate before its claim; the winner's resume then parked the run at a later gate
    // (the runtime records that gate before the run is back in pending_approval), so the loser's claim succeeds.
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released", gateTaskId: "task-1" }));
    resolveLatestWayflowGateTaskId.mockResolvedValueOnce("task-1").mockResolvedValueOnce("task-7");
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: false });
    expect(moves()).toEqual([["run-1", "pending_approval", "running"], ["run-1", "running", "pending_approval"]]);
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("a gate that cannot be read under the claim gives the claim back and answers the fixed text", async () => {
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released" }));
    resolveLatestWayflowGateTaskId.mockResolvedValueOnce("task-1").mockRejectedValueOnce(new Error("redis down: run-1"));
    const err = (await approvePublishDecision({ runId: "run-1", actorContext: ACTOR }).catch((e: unknown) => e)) as Error & { code?: string };
    expect(err.code).toBe("publish_decision_unavailable");
    expect(err.message).not.toMatch(/redis|run-1/);
    expect(moves()).toEqual([["run-1", "pending_approval", "running"], ["run-1", "running", "pending_approval"]]);
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("a resume fault is logged by a fixed error name only, never a custom name", async () => {
    sendWayflowResume.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "Run run-1 ctx-1" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).rejects.toMatchObject({ code: "publish_resume_failed" });
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toMatch(/run-1|ctx-1/);
      expect(logged).toMatch(/: Error$/m);
    } finally {
      warn.mockRestore();
    }
  });

  it("a released decision whose run's current gate cannot be read resumes nothing", async () => {
    decisions.readOpenDecisionForRun.mockResolvedValue(null);
    decisions.readLatestDecisionForRun.mockResolvedValue(decision({ status: "released" }));
    resolveLatestWayflowGateTaskId.mockResolvedValue(null);
    expect(await approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).toEqual({ ok: true, resumed: false });
    expect(decisions.decide).not.toHaveBeenCalled();
    expect(storeMock.transitionRunStatus).not.toHaveBeenCalled();
    expect(sendWayflowResume).not.toHaveBeenCalled();
  });

  it("a resume that fails after its send leaves the run where the send left it", async () => {
    sendWayflowResume.mockImplementationOnce(async (args: { onDispatch?: () => void }) => {
      args.onDispatch?.();
      throw new Error("timeout");
    });
    await expect(approvePublishDecision({ runId: "run-1", actorContext: ACTOR })).rejects.toMatchObject({ code: "publish_resume_failed" });
    expect(moves()).toEqual([["run-1", "pending_approval", "running"]]);
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
