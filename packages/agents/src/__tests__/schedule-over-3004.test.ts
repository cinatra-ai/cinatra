/**
 * A SCHEDULE THAT IS OVER TAKES NO WRITE, AND ITS RECORD CANNOT BE REMOVED
 * (cinatra#3004).
 *
 * The plan's second sentence, which this file is the executable reading of:
 *
 *   "A recurring schedule that ran at least once and was then cancelled is over,
 *    the same as a run set to run once that already ran: the run is over and
 *    nothing in that run can be configured anymore."
 *
 * Read here as the run's SCHEDULE configuration — its trigger row, on every
 * server path that writes one.
 *
 * WHAT IS PINNED:
 *
 *   1. `setRunTriggerForActor` refuses a `scheduled` request AND a `recurring`
 *      request on a run whose recurring schedule was cancelled after a fire —
 *      the same ending a fired one-off already gets. Nothing is written: no
 *      trigger row, no scheduler, no status transition.
 *   2. `deleteRunTriggerForActor` refuses to REMOVE that row. The stopped row is
 *      the record of an ending; taking it away is what let a surface walk around
 *      the ending, because every refusal above reads the row that was deleted.
 *      So the "removed first" state cannot be produced in the first place.
 *   3. The run-addressed resolve answers for a run whose schedule came from the
 *      run's own scheduling step, so the agent page's schedule surface and the
 *      run page's schedule step draw the form for it rather than nothing. The
 *      binding is the run's own — its owner, in its own organization.
 *
 * Harness mirrors trigger-service-stop-recurring.test.ts: the services run for
 * real, only their collaborators are stubbed, so no database is needed.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/schedule-over-3004.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const RUN_ID = "run-3004";
const OWNER_ID = "user-3004-owner";
const ORG_ID = "org-3004";
const TEMPLATE_ID = "tmpl-3004";

const store = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(async () => null as unknown),
  createAgentRunPendingInput: vi.fn(),
  transitionRunStatus: vi.fn(async (): Promise<void> => {}),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));
const enqueue = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(async () => ({ runId: "", jobId: "", status: "queued" as const })),
  enqueueDepsForTemplate: vi.fn(() => ({})),
}));
const triggerStore = vi.hoisted(() => ({
  createOrUpdateRunTrigger: vi.fn(async () => undefined),
  readRunTriggerByRunId: vi.fn<
    (runId?: string) => Promise<Record<string, unknown> | null>
  >(async () => null),
  deleteRunTriggerByRunId: vi.fn(async () => undefined),
  stopRunTriggerInDb: vi.fn(async () => undefined),
}));
const schedule = vi.hoisted(() => ({
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: "sched-3004" })),
  cancelTriggerSchedule: vi.fn(async () => undefined),
}));
const pm = vi.hoisted(() => ({
  syncRunTriggerPmTask: vi.fn(async () => undefined),
  deleteRunTriggerPmTask: vi.fn(async () => undefined),
}));
const proposalStore = vi.hoisted(() => ({
  ProposalAlreadyConsumedError: class extends Error {},
  claimPendingInstallIntents: vi.fn(async () => []),
  markInstallIntentArmed: vi.fn(),
  markInstallIntentDone: vi.fn(),
  parkInstallIntent: vi.fn(),
  readInstallIntent: vi.fn(async () => null as unknown),
  readProposalConsume: vi.fn(async () => null as unknown),
  readProposalConsumeByRunId: vi.fn(async () => null as unknown),
  releaseInstallIntent: vi.fn(),
  spendProposalWithinTx: vi.fn(),
}));

// cinatra#2981 — the trigger claim reaches Postgres for its advisory lock, and
// this tier has no database. The pass-through preserves the CONTRACT the claim
// gives its callers — the body decides on the row as read at claim time — while
// the row itself keeps coming from this file's own mocked store. A `vi.fn` so a
// case can make the claim UNAVAILABLE and read what the caller does about it.
const claim = vi.hoisted(() => ({ withTriggerClaim: vi.fn() }));
vi.mock("../trigger-claim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../trigger-claim")>();
  return { ...actual, withTriggerClaim: claim.withTriggerClaim };
});

vi.mock("../store", () => store);
vi.mock("../trigger-store", () => triggerStore);
vi.mock("../trigger-schedule", () => schedule);
vi.mock("../trigger-schedule-proposal-store", () => proposalStore);
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
}));
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/pm-integration-providers", () => pm);
vi.mock("@/lib/agent-run-enqueue", () => enqueue);
vi.mock("../runtime-install-gate", () => ({
  assertAgentPackageRunnable: vi.fn(async () => null),
}));

import {
  deleteRunTriggerForActor,
  scheduleIsOver,
  setRunTriggerForActor,
} from "../trigger-service";
import { resolveProposalForRun } from "../trigger-schedule-proposal-service";
import { TriggerClaimUnavailableError } from "../trigger-claim";

const owner = { userId: OWNER_ID, source: "ui" as const };

const RUN = {
  id: RUN_ID,
  runBy: OWNER_ID,
  templateId: TEMPLATE_ID,
  orgId: ORG_ID,
  status: "armed",
};

/** A one-off that has FIRED — the plan's other ending, once its run is over. */
const FIRED_ONE_OFF = {
  runId: RUN_ID,
  triggerType: "scheduled",
  scheduledAt: new Date("2026-08-24T09:00:00Z"),
  cronExpression: null,
  timezone: "Europe/Berlin",
  enabled: true,
  releasedAt: new Date("2026-08-24T09:00:00Z"),
  lastFiredAt: null,
  stoppedAt: null,
  jobSchedulerId: "sched-3004-one-off",
};

/** The ending the plan describes: recurring, fired at least once, cancelled. */
const CANCELLED_AFTER_A_FIRE = {
  runId: RUN_ID,
  triggerType: "recurring",
  scheduledAt: null,
  cronExpression: "0 9 * * 1-5",
  timezone: "Europe/Berlin",
  enabled: false,
  releasedAt: null,
  lastFiredAt: new Date("2026-08-24T09:00:00Z"),
  stoppedAt: new Date("2026-08-25T10:00:00Z"),
  jobSchedulerId: "sched-3004",
};

beforeEach(() => {
  vi.clearAllMocks();
  store.readAgentRunById.mockResolvedValue(RUN);
  triggerStore.readRunTriggerByRunId.mockResolvedValue(CANCELLED_AFTER_A_FIRE);
  claim.withTriggerClaim.mockImplementation(
    async (runId: string, body: (live: unknown) => Promise<unknown>) =>
      body(await triggerStore.readRunTriggerByRunId(runId)),
  );
});

// ---------------------------------------------------------------------------
// 1 — no schedule write on a run whose schedule is over
// ---------------------------------------------------------------------------

describe("setRunTriggerForActor on a recurring schedule cancelled after a fire", () => {
  const REQUESTS = [
    [
      "scheduled",
      { runId: RUN_ID, triggerType: "scheduled" as const, scheduledAt: "2027-01-01T09:00" },
    ],
    [
      "recurring",
      { runId: RUN_ID, triggerType: "recurring" as const, cronExpression: "0 9 * * 1-5" },
    ],
  ] as const;

  it.each(REQUESTS)("refuses a %s request", async (_kind, args) => {
    const result = await setRunTriggerForActor(owner, args);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/cancelled|stopped/i);
  });

  it.each(REQUESTS)(
    "writes no trigger row and installs no scheduler for a %s request",
    async (_kind, args) => {
      await setRunTriggerForActor(owner, args);

      expect(triggerStore.createOrUpdateRunTrigger).not.toHaveBeenCalled();
      expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
      expect(schedule.cancelTriggerSchedule).not.toHaveBeenCalled();
      expect(store.transitionRunStatus).not.toHaveBeenCalled();
      expect(pm.syncRunTriggerPmTask).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// 2 — the record of the ending cannot be removed
// ---------------------------------------------------------------------------

describe("scheduleIsOver — the rule, read on its own", () => {
  const live = { triggerType: "recurring", releasedAt: null, stoppedAt: null };

  it("a recurring schedule cancelled after a fire is over, whatever the run says", () => {
    expect(scheduleIsOver({ ...live, stoppedAt: new Date() }, "armed")).toBe(true);
    expect(scheduleIsOver({ ...live, stoppedAt: new Date() }, "completed")).toBe(true);
  });

  it.each(["completed", "failed", "stopped"])(
    "a fired one-off on a %s run is over — both halves of the plan's clause",
    (status) => {
      expect(
        scheduleIsOver({ triggerType: "scheduled", releasedAt: new Date(), stoppedAt: null }, status),
      ).toBe(true);
      // **Run right after setup** is a one-off too, and it is written as
      // "everything that is not recurring", so a kind added later is protected.
      expect(
        scheduleIsOver({ triggerType: "immediate", releasedAt: new Date(), stoppedAt: null }, status),
      ).toBe(true);
      expect(
        scheduleIsOver({ triggerType: "webhook", releasedAt: new Date(), stoppedAt: null }, status),
      ).toBe(true);
    },
  );

  it.each(["pending_input", "armed", "queued", "running", "waiting_trigger"])(
    "a one-off that fired on a %s run is NOT over — the run is still going",
    (status) => {
      expect(
        scheduleIsOver({ triggerType: "immediate", releasedAt: new Date(), stoppedAt: null }, status),
      ).toBe(false);
    },
  );

  it("a schedule that never fired is not an ending, whatever the run's own outcome was", () => {
    expect(
      scheduleIsOver({ triggerType: "scheduled", releasedAt: null, stoppedAt: null }, "failed"),
    ).toBe(false);
    // A recurring schedule that has fired but was never cancelled is LIVE.
    expect(
      scheduleIsOver({ triggerType: "recurring", releasedAt: new Date(), stoppedAt: null }, "armed"),
    ).toBe(false);
  });
});

describe("deleteRunTriggerForActor on a schedule that is over", () => {
  const removedNothing = () => {
    expect(triggerStore.deleteRunTriggerByRunId).not.toHaveBeenCalled();
    expect(schedule.cancelTriggerSchedule).not.toHaveBeenCalled();
    expect(store.transitionRunStatus).not.toHaveBeenCalled();
    expect(pm.deleteRunTriggerPmTask).not.toHaveBeenCalled();
  };

  it("refuses to remove the stopped row — the ending cannot be deleted away", async () => {
    const result = await deleteRunTriggerForActor(owner, { runId: RUN_ID });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/schedule is over/i);
    removedNothing();
  });

  // THE DECISIVE ONE. Deleting a fired one-off's row takes its `releasedAt`
  // stamp with it, and every refusal that keeps that ending reads the row — so
  // without this the finished run could be given a fresh schedule.
  it.each(["completed", "failed", "stopped"])(
    "refuses to remove a fired one-off's row on a %s run",
    async (status) => {
      store.readAgentRunById.mockResolvedValue({ ...RUN, status });
      triggerStore.readRunTriggerByRunId.mockResolvedValue(FIRED_ONE_OFF);

      const result = await deleteRunTriggerForActor(owner, { runId: RUN_ID });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/schedule is over/i);
      removedNothing();
    },
  );

  it("still removes a one-off whose run is still going — the in-flight tidy-up is untouched", async () => {
    store.readAgentRunById.mockResolvedValue({ ...RUN, status: "queued" });
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      ...FIRED_ONE_OFF,
      triggerType: "immediate",
    });

    const result = await deleteRunTriggerForActor(owner, { runId: RUN_ID });

    expect(result).toEqual({ ok: true });
    expect(triggerStore.deleteRunTriggerByRunId).toHaveBeenCalledWith(RUN_ID);
  });

  it("still removes a live recurring schedule that has fired but was never cancelled", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      ...CANCELLED_AFTER_A_FIRE,
      enabled: true,
      stoppedAt: null,
    });

    const result = await deleteRunTriggerForActor(owner, { runId: RUN_ID });

    expect(result).toEqual({ ok: true });
    expect(triggerStore.deleteRunTriggerByRunId).toHaveBeenCalledWith(RUN_ID);
    expect(store.transitionRunStatus).toHaveBeenCalled();
  });

  it("still removes an ordinary live schedule — only an ENDING is protected", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      ...CANCELLED_AFTER_A_FIRE,
      enabled: true,
      lastFiredAt: null,
      stoppedAt: null,
    });

    const result = await deleteRunTriggerForActor(owner, { runId: RUN_ID });

    expect(result).toEqual({ ok: true });
    expect(triggerStore.deleteRunTriggerByRunId).toHaveBeenCalledWith(RUN_ID);
  });

  // THE RACE THIS CLOSES (cinatra#2981's claim, applied here). The row this
  // call decides on is the one the CLAIM hands it, so a **Cancel schedule**
  // landing while this call waits is the row it sees — there is no earlier
  // snapshot left to go stale, because the function takes none.
  it("decides on the row the claim hands it — no read happens outside the claim", async () => {
    const seen: unknown[] = [];
    claim.withTriggerClaim.mockImplementation(
      async (runId: string, body: (live: unknown) => Promise<unknown>) => {
        const live = await triggerStore.readRunTriggerByRunId(runId);
        seen.push(live);
        return body(live);
      },
    );

    const result = await deleteRunTriggerForActor(owner, { runId: RUN_ID });

    expect(claim.withTriggerClaim).toHaveBeenCalledWith(RUN_ID, expect.any(Function));
    // ONE read, and the claim performed it.
    expect(triggerStore.readRunTriggerByRunId).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([CANCELLED_AFTER_A_FIRE]);
    expect(result.ok).toBe(false);
    expect(triggerStore.deleteRunTriggerByRunId).not.toHaveBeenCalled();
  });

  it("answers BUSY and removes nothing when the claim is not available", async () => {
    claim.withTriggerClaim.mockImplementation(async () => {
      throw new TriggerClaimUnavailableError(RUN_ID);
    });
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      ...CANCELLED_AFTER_A_FIRE,
      stoppedAt: null,
    });

    const result = await deleteRunTriggerForActor(owner, { runId: RUN_ID });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/something else is changing/i);
    expect(triggerStore.deleteRunTriggerByRunId).not.toHaveBeenCalled();
    expect(store.transitionRunStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3 — the run-addressed resolve answers for a run with no proposal behind it
// ---------------------------------------------------------------------------

describe("resolveProposalForRun for a run whose schedule came from its own scheduling step", () => {
  const READER = { userId: OWNER_ID, orgId: ORG_ID };

  beforeEach(() => {
    store.readAgentTemplateById.mockResolvedValue({
      id: TEMPLATE_ID,
      name: "Weekly cohort sweep",
      packageName: "weekly-cohort-sweep",
      orgId: ORG_ID,
    });
  });

  it("draws the settled form off the run's own trigger row, stopped and unsaveable", async () => {
    const resolution = await resolveProposalForRun(RUN_ID, READER);

    expect(resolution.phase).toBe("settled");
    if (resolution.phase !== "settled") return;
    expect(resolution.triggerType).toBe("recurring");
    expect(resolution.stopped).toBe(true);
    expect(resolution.firedOnce).toBe(true);
    // The two readings the card draws its frozen state from, derived here from
    // the row rather than supplied: no save, and no Cancel schedule left.
    expect(resolution.canSave).toBe(false);
  });

  it("draws the form for a live recurring schedule the run's own step armed", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      ...CANCELLED_AFTER_A_FIRE,
      enabled: true,
      stoppedAt: null,
    });

    const resolution = await resolveProposalForRun(RUN_ID, READER);

    expect(resolution.phase).toBe("settled");
    if (resolution.phase !== "settled") return;
    expect(resolution.canSave).toBe(true);
    // FIRED ONCE and not stopped — the one state the plan puts Cancel schedule
    // in, derived from `lastFiredAt` on the row rather than supplied.
    expect(resolution.firedOnce).toBe(true);
    expect(resolution.stopped).toBe(false);
  });

  it("answers a stranger and another organization with nothing at all", async () => {
    await expect(
      resolveProposalForRun(RUN_ID, { userId: "somebody-else", orgId: ORG_ID }),
    ).resolves.toEqual({ phase: "absent" });
    await expect(
      resolveProposalForRun(RUN_ID, { userId: OWNER_ID, orgId: "org-other" }),
    ).resolves.toEqual({ phase: "absent" });
  });

  // WITH A STANDING PRESENTED, the RUN's own access control decides — the same
  // probe every other run surface takes, so an administrator and a co-owner of a
  // shared run read this schedule exactly where they already read the run.
  it("asks the run's own access control when the reader's standing is presented", async () => {
    const access = {
      actor: { userId: "org-admin" } as never,
      roles: { orgRole: "admin", actorOrganizationId: ORG_ID } as never,
    };

    const resolution = await resolveProposalForRun(
      RUN_ID,
      { userId: "org-admin", orgId: ORG_ID },
      access,
    );

    expect(store.readAgentRunById).toHaveBeenCalledWith(RUN_ID, access.actor, access.roles);
    // The run read answered, so the reader may see it — even though they are
    // not the run's own `runBy`.
    expect(resolution.phase).toBe("settled");
  });

  it("answers a reader the run's access control refuses with nothing at all", async () => {
    class FakeAuthzError extends Error {}
    store.readAgentRunById.mockRejectedValue(new FakeAuthzError("forbidden"));

    // A non-Authz failure still throws — a store outage is not an absence.
    await expect(
      resolveProposalForRun(
        RUN_ID,
        { userId: "stranger", orgId: ORG_ID },
        { actor: { userId: "stranger" } as never },
      ),
    ).rejects.toBeInstanceOf(FakeAuthzError);
  });

  it("falls back to the run's own owner when no standing was presented", async () => {
    store.readAgentRunById.mockResolvedValue({ ...RUN, runBy: null });

    await expect(resolveProposalForRun(RUN_ID, READER)).resolves.toEqual({
      phase: "absent",
    });
    // Read WITHOUT an access probe on that path — there is no standing to probe.
    expect(store.readAgentRunById).toHaveBeenCalledWith(RUN_ID);
  });

  it("stays absent for an IMMEDIATE row — that run's surface is the first-step form, not this card", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      ...CANCELLED_AFTER_A_FIRE,
      triggerType: "immediate",
      cronExpression: null,
      releasedAt: new Date("2026-08-24T09:00:00Z"),
      lastFiredAt: null,
      stoppedAt: null,
    });

    await expect(resolveProposalForRun(RUN_ID, READER)).resolves.toEqual({
      phase: "absent",
    });
  });

  it("stays absent for a run with no trigger row at all", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(null);

    await expect(resolveProposalForRun(RUN_ID, READER)).resolves.toEqual({
      phase: "absent",
    });
  });
});
