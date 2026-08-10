/**
 * The install drain's PINNED ORDER (cinatra#2569, epic #2564 S5).
 *
 * The real-DB tier proves the outbox row can express arm-before-expose. This
 * suite proves the DRAIN actually performs it — that `installScheduleForIntent`
 * arms the run BEFORE `scheduleTrigger` makes the schedule visible, in that
 * order, on every path.
 *
 * Why it matters, concretely: `scheduleTrigger` installs a BullMQ job that can
 * fire the instant it is due. The release path's `armed → queued` CAS logs and
 * SKIPS a run that is not armed, so a one-shot schedule installed before the
 * arm — and due in the seconds between — never runs and never reports that it
 * did not. Expose-then-arm is what the shipped `setRunTriggerForActor` does;
 * this drain deliberately inverts it, and an inversion here would be silent.
 *
 * The IMMEDIATE arm is proven to delegate to the RESHAPED ladder (#2615) rather
 * than restate it, including that its honest refusals stay honest.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: string[] = [];

const scheduleTrigger = vi.fn(async () => {
  calls.push("expose:scheduleTrigger");
  return { jobSchedulerId: "trigger-release-run-1" };
});
const createOrUpdateRunTrigger = vi.fn(async (input: { jobSchedulerId: string | null }) => {
  calls.push(input.jobSchedulerId ? "row:with-scheduler" : "row:no-scheduler");
  return {} as never;
});
const transitionRunStatus = vi.fn(async (_r: string, from: string, to: string) => {
  calls.push(`arm:${from}->${to}`);
});
const markInstallIntentArmed = vi.fn(async () => {
  calls.push("stamp:armed");
  return true;
});
const markInstallIntentDone = vi.fn(async () => {
  calls.push("stamp:done");
  return true;
});
const releaseInstallIntent = vi.fn(async () => {
  calls.push("release");
  return "retry" as const;
});
const parkInstallIntent = vi.fn(async () => {
  calls.push("park");
  return true;
});
const readAgentRunById = vi.fn(async () => ({
  id: "run-1",
  orgId: "org-1",
  status: "pending_input",
}));
const setRunTriggerForActor = vi.fn(async () => {
  calls.push("immediate:setRunTriggerForActor");
  return { ok: true as const, runId: "run-1", jobSchedulerId: null };
});

const INTENT = {
  runId: "run-1",
  orgId: "org-1",
  requestedBy: "user-1",
  triggerType: "recurring" as const,
  scheduledAt: null,
  cronExpression: "0 9 * * 1,2,3,4,5",
  timezone: "Europe/Berlin",
  status: "installing",
  attempts: 1,
  maxAttempts: 20,
  leaseToken: "lease-1",
  armedAt: null,
};

async function loadService() {
  vi.resetModules();
  vi.doMock("../trigger-schedule", () => ({ scheduleTrigger, cancelTriggerSchedule: vi.fn() }));
  vi.doMock("../trigger-store", () => ({
    createOrUpdateRunTrigger,
    readRunTriggerByRunId: vi.fn(async () => null),
  }));
  vi.doMock("../store", () => ({
    createAgentRunPendingInput: vi.fn(),
    readAgentRunById,
    readAgentTemplateById: vi.fn(async () => null),
    transitionRunStatus,
    RunTransitionError: class RunTransitionError extends Error {
      constructor(public code: string) {
        super(code);
      }
    },
  }));
  vi.doMock("../trigger-schedule-proposal-store", () => ({
    ProposalAlreadyConsumedError: class extends Error {},
    claimPendingInstallIntents: vi.fn(async () => []),
    markInstallIntentArmed,
    markInstallIntentDone,
    readInstallIntent: vi.fn(async () => null),
    readProposalConsume: vi.fn(async () => null),
    parkInstallIntent,
    releaseInstallIntent,
    spendProposalWithinTx: vi.fn(),
  }));
  vi.doMock("../trigger-service", () => ({ setRunTriggerForActor }));
  vi.doMock("../runtime-install-gate", () => ({
    assertAgentPackageRunnable: vi.fn(async () => null),
  }));
  vi.doMock("@/lib/org-write/authority", () => ({
    verifySessionAuthority: vi.fn(async () => ({ orgId: "org-1" })),
  }));
  return import("../trigger-schedule-proposal-service");
}

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  readAgentRunById.mockResolvedValue({ id: "run-1", orgId: "org-1", status: "pending_input" });
});

afterEach(() => {
  vi.resetModules();
});

describe("scheduled / recurring: ARM before EXPOSE", () => {
  it("writes the row, arms the run, stamps armed, and only THEN installs the schedule", async () => {
    const svc = await loadService();
    const outcome = await svc.installScheduleForIntent(INTENT);
    expect(outcome).toBe("installed");
    expect(calls).toEqual([
      // 1. the durable row — no scheduler id, so nothing can fire from it
      "row:no-scheduler",
      // 2. the ARM — after this a fire can no longer be lost
      "arm:pending_input->armed",
      "stamp:armed",
      // 3. only now is the schedule visible to the scheduler
      "expose:scheduleTrigger",
      // 4. persist the id Cancel needs, and close the intent
      "row:with-scheduler",
      "stamp:done",
    ]);
  });

  it("arms STRICTLY before exposing — the property stated as an index comparison", async () => {
    const svc = await loadService();
    await svc.installScheduleForIntent(INTENT);
    expect(calls.indexOf("stamp:armed")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("expose:scheduleTrigger")).toBeGreaterThan(
      calls.indexOf("stamp:armed"),
    );
  });

  it("never marks the intent done before the schedule is installed", async () => {
    const svc = await loadService();
    await svc.installScheduleForIntent(INTENT);
    expect(calls.indexOf("stamp:done")).toBeGreaterThan(
      calls.indexOf("expose:scheduleTrigger"),
    );
  });

  it("carries the confirmed cron and timezone through unchanged", async () => {
    const svc = await loadService();
    await svc.installScheduleForIntent(INTENT);
    expect(scheduleTrigger).toHaveBeenCalledWith({
      runId: "run-1",
      triggerType: "recurring",
      scheduledAt: undefined,
      cronExpression: "0 9 * * 1,2,3,4,5",
      timezone: "Europe/Berlin",
    });
  });

  async function staleCas() {
    const { RunTransitionError } = (await import("../store")) as unknown as {
      RunTransitionError: new (code: string) => Error;
    };
    transitionRunStatus.mockImplementationOnce(async () => {
      throw new RunTransitionError("stale_from_status");
    });
  }

  it("tolerates a run that is GENUINELY already armed — at-least-once redelivery", async () => {
    const svc = await loadService();
    await staleCas();
    readAgentRunById
      .mockResolvedValueOnce({ id: "run-1", orgId: "org-1", status: "pending_input" })
      .mockResolvedValueOnce({ id: "run-1", orgId: "org-1", status: "armed" });
    const outcome = await svc.installScheduleForIntent(INTENT);
    expect(outcome).toBe("installed");
    expect(calls.indexOf("expose:scheduleTrigger")).toBeGreaterThan(
      calls.indexOf("stamp:armed"),
    );
  });

  it("does NOT read a stale CAS as 'already armed' — codex round-2 finding", async () => {
    // A cancelled / stopped / queued / finished run fails the SAME CAS. Taking
    // that as "already armed" would expose a schedule whose run is not armed —
    // precisely the loss this ordering exists to prevent.
    for (const status of ["stopped", "failed", "completed", "queued", "running"]) {
      const svc = await loadService();
      calls.length = 0;
      await staleCas();
      readAgentRunById
        .mockResolvedValueOnce({ id: "run-1", orgId: "org-1", status: "pending_input" })
        .mockResolvedValueOnce({ id: "run-1", orgId: "org-1", status });
      const outcome = await svc.installScheduleForIntent(INTENT);
      expect(outcome, status).toBe("failed");
      expect(calls, status).not.toContain("expose:scheduleTrigger");
      expect(parkInstallIntent).toHaveBeenCalledWith(
        "run-1",
        "lease-1",
        expect.stringContaining(status),
      );
      vi.clearAllMocks();
    }
  });

  it("CLOSES rather than re-installs when a schedule we already armed has since fired — codex round-2 finding", async () => {
    // Crash after EXPOSE, before the intent was closed. The run has moved past
    // `armed` because the schedule did its job. Re-installing a one-shot here
    // is exactly how a schedule fires twice.
    const svc = await loadService();
    await staleCas();
    readAgentRunById
      .mockResolvedValueOnce({ id: "run-1", orgId: "org-1", status: "pending_input" })
      .mockResolvedValueOnce({ id: "run-1", orgId: "org-1", status: "running" });
    const outcome = await svc.installScheduleForIntent({
      ...INTENT,
      armedAt: new Date("2026-08-10T07:00:00Z"),
    });
    expect(outcome).toBe("installed");
    expect(calls).not.toContain("expose:scheduleTrigger");
    expect(calls).toContain("stamp:done");
  });

  it("does NOT expose a schedule when the arm fails for a real reason", async () => {
    const svc = await loadService();
    transitionRunStatus.mockRejectedValueOnce(new Error("org archived"));
    const outcome = await svc.installScheduleForIntent(INTENT);
    expect(outcome).toBe("retry");
    expect(calls).not.toContain("expose:scheduleTrigger");
    expect(calls).not.toContain("stamp:done");
    expect(releaseInstallIntent).toHaveBeenCalled();
  });

  it("leaves the intent retryable when the EXPOSE fails — the run is armed, nothing is lost", async () => {
    const svc = await loadService();
    scheduleTrigger.mockRejectedValueOnce(new Error("redis unavailable"));
    const outcome = await svc.installScheduleForIntent(INTENT);
    expect(outcome).toBe("retry");
    expect(calls).toContain("stamp:armed");
    expect(calls).not.toContain("stamp:done");
  });

  it("refuses to act at all without a live lease — a stale worker installs nothing", async () => {
    const svc = await loadService();
    const outcome = await svc.installScheduleForIntent({ ...INTENT, leaseToken: null });
    expect(outcome).toBe("retry");
    expect(calls).toEqual([]);
  });
});

describe("immediate: delegate to the reshaped ladder, do not restate it", () => {
  it("goes through setRunTriggerForActor rather than transitioning itself", async () => {
    const svc = await loadService();
    const outcome = await svc.installScheduleForIntent({
      ...INTENT,
      triggerType: "immediate",
      cronExpression: null,
    });
    expect(outcome).toBe("installed");
    expect(setRunTriggerForActor).toHaveBeenCalledWith(
      { userId: "user-1", source: "ui" },
      { runId: "run-1", triggerType: "immediate", timezone: "Europe/Berlin" },
    );
    // The drain never reaches for the transition ladder or the scheduler on
    // this arm — #2615's `dispatchImmediateNow` owns both.
    expect(transitionRunStatus).not.toHaveBeenCalled();
    expect(scheduleTrigger).not.toHaveBeenCalled();
  });

  it("parks an HONEST refusal instead of retrying it twenty times", async () => {
    const svc = await loadService();
    setRunTriggerForActor.mockResolvedValueOnce({
      ok: false,
      error: "This run has already finished — it can't be run again. Start a new run instead.",
    } as never);
    const outcome = await svc.installScheduleForIntent({
      ...INTENT,
      triggerType: "immediate",
      cronExpression: null,
    });
    expect(outcome).toBe("failed");
    // PARKED, not released: the retry budget is for transient trouble, and
    // "this run has already finished" will not become true on the twentieth
    // attempt — burning nineteen attempts on it would only bury the reason.
    expect(parkInstallIntent).toHaveBeenCalledWith(
      "run-1",
      "lease-1",
      expect.stringContaining("already finished"),
    );
    expect(releaseInstallIntent).not.toHaveBeenCalled();
  });
});

describe("the selections → trigger-row translation", () => {
  it("turns a recurring selection into the SAME cron the scheduling form submits", async () => {
    const svc = await loadService();
    const install = svc.installIntentFor({
      kind: "recurring",
      timezone: "Europe/Berlin",
      selection: {
        frequency: "weekly",
        interval: 1,
        weekdays: [1, 2, 3, 4, 5],
        dayOfMonth: 1,
        monthlyMode: "date",
        nthWeek: 1,
        monthlyWeekday: 0,
        quarterAnchor: "start",
        yearlyMonth: 1,
        hour: 9,
        minute: 0,
      },
    })!;
    expect(install.triggerType).toBe("recurring");
    expect(install.cronExpression).toBe("0 9 * * 1,2,3,4,5");
    expect(install.timezone).toBe("Europe/Berlin");
    expect(install.scheduledAt).toBeNull();
  });

  it("reads a scheduled wall clock in ITS OWN zone, not the server's", async () => {
    const svc = await loadService();
    const berlin = svc.installIntentFor({
      kind: "scheduled",
      runAt: "2026-07-14T09:00",
      timezone: "Europe/Berlin",
    })!;
    const utc = svc.installIntentFor({
      kind: "scheduled",
      runAt: "2026-07-14T09:00",
      timezone: "UTC",
    })!;
    // July: Berlin is UTC+2, so the same wall clock is two hours EARLIER in UTC.
    expect(utc.scheduledAt!.getTime() - berlin.scheduledAt!.getTime()).toBe(2 * 3600 * 1000);
  });

  it("refuses an unknown timezone rather than silently scheduling in UTC", async () => {
    const svc = await loadService();
    expect(
      svc.installIntentFor({
        kind: "scheduled",
        runAt: "2026-07-14T09:00",
        timezone: "Mars/Olympus_Mons",
      }),
    ).toBeNull();
  });

  it("carries an immediate proposal with no schedule fields at all", async () => {
    const svc = await loadService();
    expect(svc.installIntentFor({ kind: "immediate" })).toEqual({
      triggerType: "immediate",
      scheduledAt: null,
      cronExpression: null,
      timezone: "UTC",
    });
  });
});

describe("the plain-language line the settled card draws", () => {
  it("describes each option row without leaking a cron expression", async () => {
    const svc = await loadService();
    expect(svc.describeProposalSchedule({ kind: "immediate" })).toBe(
      "Runs right after setup",
    );
    expect(
      svc.describeProposalSchedule({
        kind: "scheduled",
        runAt: "2026-07-14T09:00",
        timezone: "Europe/Berlin",
      }),
    ).toBe("Once, at 2026-07-14 09:00");
    const recurring = svc.describeProposalSchedule({
      kind: "recurring",
      timezone: "Europe/Berlin",
      selection: {
        frequency: "weekly",
        interval: 1,
        weekdays: [1, 2, 3, 4, 5],
        dayOfMonth: 1,
        monthlyMode: "date",
        nthWeek: 1,
        monthlyWeekday: 0,
        quarterAnchor: "start",
        yearlyMonth: 1,
        hour: 9,
        minute: 0,
      },
    });
    expect(recurring).toBe("Every weekday at 09:00");
    expect(recurring).not.toContain("*");
  });
});
