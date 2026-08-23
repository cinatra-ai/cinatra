/**
 * SAVE CHANGES — re-arming an already-armed trigger from the card's own rows
 * (cinatra#2788, epic #2784 S9d).
 *
 * The plan's words, which this suite is the executable reading of:
 *
 *   "No second card is drawn for the confirmed state: the same card, with the
 *    same option rows, now shows the armed schedule; to change it you return to
 *    the card, change the rows and press **Save changes**, which re-arms the
 *    trigger."                                    — PLAN (A) §7.2
 *   "From the armed card in the conversation: change the rows and press **Save
 *    changes** → **End state: re-armed**."         — PLAN (A) §7.4, as designed
 *
 * WHAT IS PINNED, and each is a rule a re-arm has that a first arm does not:
 *
 *   1. IDENTITY. Only the run's owner or an administrator may re-arm; nobody
 *      else, and not an unauthenticated caller.
 *   2. A ONE-OFF THAT HAS ALREADY FIRED IS REFUSED. A single delayed job that
 *      has run is not a schedule any more, and re-arming it would quietly make a
 *      SECOND run out of a control whose whole promise is "change this one".
 *   3. A RECURRING CHANGE IS FUTURE-ONLY. The prior scheduler is CANCELLED
 *      before the replacement is registered, and nothing is dispatched now — so
 *      ticks that already fired are untouched and only the next one moves.
 *   4. A RELEASED TRIGGER IS REFUSED — its gate is already open.
 *   5. "Run right after setup" is refused: that row dispatches rather than
 *      schedules, and Save changes is not a disguised Release now.
 *   6. Every refusal happens BEFORE any write, so a refused save never cancels
 *      the schedule it declined to replace.
 *
 * Harness mirrors trigger-service-terminal-run.test.ts: the service runs for
 * real, only its collaborators are stubbed, so no database is needed.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/trigger-service-save-schedule.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const RUN_ID = "run-2788-save";
const OWNER_ID = "user-2788-owner";

const store = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(async () => null),
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
  readRunTriggerByRunId: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  deleteRunTriggerByRunId: vi.fn(async () => undefined),
}));
const schedule = vi.hoisted(() => ({
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: "sched-2788" })),
  cancelTriggerSchedule: vi.fn(async () => undefined),
}));
const pm = vi.hoisted(() => ({
  syncRunTriggerPmTask: vi.fn(async () => undefined),
  deleteRunTriggerPmTask: vi.fn(async () => undefined),
}));

vi.mock("../store", () => store);
vi.mock("../trigger-store", () => triggerStore);
vi.mock("../trigger-schedule", () => schedule);
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
}));
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/pm-integration-providers", () => pm);
vi.mock("@/lib/agent-run-enqueue", () => enqueue);

import {
  SAVE_SCHEDULE_REFUSALS,
  updateRunTriggerScheduleForActor,
} from "../trigger-service";
import { buildCron, DEFAULT_RECURRING_CONFIG } from "../trigger-recurrence";

const owner = { userId: OWNER_ID, source: "ui" as const };
const stranger = { userId: "user-2788-somebody-else", source: "ui" as const };
const admin = { userId: "user-2788-admin", role: "admin", source: "ui" as const };

const RUN = {
  id: RUN_ID,
  runBy: OWNER_ID,
  templateId: "tmpl-2788",
  orgId: "org-2788",
  status: "armed",
};

const HOUR = 60 * 60 * 1000;

/** §VI's recurring selection, corrected to 08:00 on weekdays — the plan's own
 *  example of a change a reader makes on the card. */
const WEEKDAYS_AT_8 = {
  kind: "recurring" as const,
  timezone: "Europe/Berlin",
  selection: { ...DEFAULT_RECURRING_CONFIG, weekdays: [1, 2, 3, 4, 5], hour: 8, minute: 0 },
};

function armedRecurring(over: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    triggerType: "recurring",
    scheduledAt: null,
    cronExpression: "0 9 * * 1-5",
    timezone: "Europe/Berlin",
    releasedAt: null,
    jobSchedulerId: "sched-OLD",
    ...over,
  };
}

function armedOneOff(over: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    triggerType: "scheduled",
    scheduledAt: new Date(Date.now() + 24 * HOUR),
    cronExpression: null,
    timezone: "Europe/Berlin",
    releasedAt: null,
    jobSchedulerId: "sched-OLD",
    ...over,
  };
}

/** Nothing was written: no row, no scheduler cancelled, no job enqueued. */
function expectNoWrites() {
  expect(triggerStore.createOrUpdateRunTrigger).not.toHaveBeenCalled();
  expect(schedule.cancelTriggerSchedule).not.toHaveBeenCalled();
  expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
  expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  store.readAgentRunById.mockResolvedValue(RUN);
  schedule.scheduleTrigger.mockResolvedValue({ jobSchedulerId: "sched-NEW" });
});

describe("Save changes re-arms (plan (A) §7.2)", () => {
  it("a recurring change replaces the schedule and installs the reader's own selections", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(armedRecurring());

    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: WEEKDAYS_AT_8,
    });

    expect(result).toEqual({ ok: true, runId: RUN_ID });
    // The cron is DERIVED from the selections by the one builder the scheduling
    // step and the proposal producer both use — never sent by the client.
    const expectedCron = buildCron(WEEKDAYS_AT_8.selection);
    expect(schedule.scheduleTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        triggerType: "recurring",
        cronExpression: expectedCron,
        timezone: "Europe/Berlin",
      }),
    );
    expect(expectedCron).not.toBe("0 9 * * 1-5");
  });

  it("FUTURE TICKS ONLY: the prior scheduler is cancelled before the replacement, and nothing fires now", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(armedRecurring());

    await updateRunTriggerScheduleForActor(owner, { runId: RUN_ID, schedule: WEEKDAYS_AT_8 });

    // The old recurring job is cancelled, by its own id — so no tick is ever
    // scheduled by both the prior expression and the new one.
    expect(schedule.cancelTriggerSchedule).toHaveBeenCalledWith({
      jobSchedulerId: "sched-OLD",
      triggerType: "recurring",
    });
    const cancelOrder = schedule.cancelTriggerSchedule.mock.invocationCallOrder[0];
    const scheduleOrder = schedule.scheduleTrigger.mock.invocationCallOrder[0];
    expect(cancelOrder).toBeLessThan(scheduleOrder);
    // A re-arm is not a run: nothing is dispatched, so an already-fired tick's
    // clone is untouched and the change only reaches the NEXT one.
    expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("an administrator may re-arm somebody else's run", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(armedRecurring());
    const result = await updateRunTriggerScheduleForActor(admin, {
      runId: RUN_ID,
      schedule: WEEKDAYS_AT_8,
    });
    expect(result.ok).toBe(true);
  });
});

describe("the refusals, all of them before any write", () => {
  it("REFUSES a one-off that has already fired — a fired schedule is not a schedule", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(
      armedOneOff({ scheduledAt: new Date(Date.now() - HOUR) }),
    );

    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: { kind: "scheduled", runAt: "2099-01-01T09:00", timezone: "Europe/Berlin" },
    });

    expect(result).toEqual({ ok: false, error: SAVE_SCHEDULE_REFUSALS.firedOneOff });
    expect(result.ok === false && result.error).toMatch(/already run/i);
    expectNoWrites();
  });

  it("allows a one-off whose moment is still ahead", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(armedOneOff());
    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: { kind: "scheduled", runAt: "2099-01-01T09:00", timezone: "Europe/Berlin" },
    });
    expect(result.ok).toBe(true);
    expect(schedule.scheduleTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "scheduled" }),
    );
  });

  it("REFUSES a released trigger — its held steps are already eligible", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(
      armedRecurring({ releasedAt: new Date() }),
    );
    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: WEEKDAYS_AT_8,
    });
    expect(result).toEqual({ ok: false, error: SAVE_SCHEDULE_REFUSALS.released });
    expectNoWrites();
  });

  it("REFUSES a run with no armed trigger at all", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(null);
    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: WEEKDAYS_AT_8,
    });
    expect(result).toEqual({ ok: false, error: SAVE_SCHEDULE_REFUSALS.noTrigger });
    expectNoWrites();
  });

  it('REFUSES "Run right after setup" — Save changes is not a disguised Release now', async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(armedRecurring());
    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: { kind: "immediate" },
    });
    expect(result).toEqual({ ok: false, error: SAVE_SCHEDULE_REFUSALS.immediate });
    expectNoWrites();
  });

  it("REFUSES a caller who is neither the run's owner nor an administrator", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(armedRecurring());
    const result = await updateRunTriggerScheduleForActor(stranger, {
      runId: RUN_ID,
      schedule: WEEKDAYS_AT_8,
    });
    expect(result).toEqual({ ok: false, error: "forbidden" });
    expectNoWrites();
  });

  it("REFUSES an unauthenticated caller before it reads anything", async () => {
    const result = await updateRunTriggerScheduleForActor(
      { userId: "", source: "ui" },
      { runId: RUN_ID, schedule: WEEKDAYS_AT_8 },
    );
    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(store.readAgentRunById).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it("REFUSES a run that does not exist", async () => {
    store.readAgentRunById.mockResolvedValue(null);
    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: WEEKDAYS_AT_8,
    });
    expect(result).toEqual({ ok: false, error: "run not found" });
    expectNoWrites();
  });
});
