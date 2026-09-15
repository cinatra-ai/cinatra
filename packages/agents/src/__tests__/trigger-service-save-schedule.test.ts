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

// cinatra#2981 — the trigger claim reaches Postgres for its advisory lock, and
// this tier has no database. The pass-through preserves the CONTRACT the claim
// gives its callers — the body decides on the row as read at claim time — while
// the row itself keeps coming from this file's own mocked store.
vi.mock("../trigger-claim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../trigger-claim")>();
  const { readRunTriggerByRunId } = await import("../trigger-store");
  return {
    ...actual,
    withTriggerClaim: async (
      runId: string,
      body: (
        live: Awaited<ReturnType<typeof readRunTriggerByRunId>>,
      ) => Promise<unknown>,
    ) => body(await readRunTriggerByRunId(runId)),
  };
});

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
    lastFiredAt: null,
    stoppedAt: null,
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
    lastFiredAt: null,
    stoppedAt: null,
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

  // THE FIXTURE MOVED FROM RECURRING TO ONE-OFF (cinatra#2972), and that is the
  // finding rather than a convenience: `releasedAt` is the ONE-OFF's and the
  // IMMEDIATE's firing. A recurring tick opens the COPY's gate, never this
  // run's, so a recurring row's stamp says nothing about whether the schedule
  // is still live — and plan (A) §7.2 as amended 2026-08-25 requires a fired
  // recurring schedule to stay changeable. Refusing it here would have made the
  // server contradict the card's own `canSave`.
  it("REFUSES a released ONE-OFF — its held steps are already eligible", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(
      armedOneOff({ releasedAt: new Date() }),
    );
    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: WEEKDAYS_AT_8,
    });
    expect(result).toEqual({ ok: false, error: SAVE_SCHEDULE_REFUSALS.released });
    expectNoWrites();
  });

  it("ALLOWS a recurring schedule carrying a releasedAt — a tick is not its firing", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(
      armedRecurring({ releasedAt: new Date(), lastFiredAt: new Date() }),
    );
    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: WEEKDAYS_AT_8,
    });
    expect(result.ok).toBe(true);
  });

  it("REFUSES a STOPPED schedule — Cancel schedule made the scheduler non-editable", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(
      armedRecurring({ stoppedAt: new Date(), lastFiredAt: new Date() }),
    );
    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: WEEKDAYS_AT_8,
    });
    expect(result).toEqual({ ok: false, error: SAVE_SCHEDULE_REFUSALS.stopped });
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

describe("the replacement is atomic or it does not happen (cinatra#2788, convergence F1)", () => {
  it("REFUSES the save when the prior scheduler cannot be cancelled — one run never gets two schedulers", async () => {
    // The whole hazard in one line: the cancel fails. Before this fix the
    // failure was caught, logged and STEPPED OVER, and the replacement was
    // installed anyway — leaving the old scheduler live beside the new one, two
    // things able to fire the same run, and a reader who was shown exactly one
    // schedule.
    triggerStore.readRunTriggerByRunId.mockResolvedValue(armedRecurring());
    // ...Once, deliberately: `vi.clearAllMocks()` in beforeEach clears CALLS but
    // not implementations, so a persistent rejection here would leak into the
    // sibling test below that proves the ordinary path still installs.
    schedule.cancelTriggerSchedule.mockRejectedValueOnce(
      new Error("scheduler backend unreachable"),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: WEEKDAYS_AT_8,
    });

    expect(result).toEqual({ ok: false, error: SAVE_SCHEDULE_REFUSALS.cancelFailed });
    // NO SECOND SCHEDULER. Neither the scheduler registration nor the row write
    // happened, so the schedule the reader is looking at is still the only one.
    expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
    expect(triggerStore.createOrUpdateRunTrigger).not.toHaveBeenCalled();
    // And the refusal names the state truthfully: nothing changed.
    expect(result.ok === false && result.error).toMatch(/unchanged and still armed/i);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("REFUSES when the trigger is RELEASED between the guard's read and the write", async () => {
    // A ONE-OFF, since cinatra#2972: `releasedAt` on a recurring row is not its
    // firing and no longer refuses. The RACE this pins is unchanged.
    // The race: the refusals at the top of the save read ONE snapshot, and the
    // setter re-reads later. A release that lands in that gap used to pass the
    // guard and then be overwritten by the replacement — re-arming a trigger
    // whose held steps are already eligible.
    let reads = 0;
    triggerStore.readRunTriggerByRunId.mockImplementation(async () => {
      reads += 1;
      // Read 1 is the guard's snapshot: still armed, so the save proceeds.
      // Every later read — including the setter's own pre-cancel read, the one
      // the cancel and the upsert act on — sees it released meanwhile.
      return reads === 1 ? armedOneOff() : armedOneOff({ releasedAt: new Date() });
    });

    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: WEEKDAYS_AT_8,
    });

    // EITHER REFUSAL IS THE RIGHT ANSWER, and which one wins is not the
    // property (cinatra#2972). The fixture moved to a one-off, and a released
    // one-off meets TWO truthful guards on the setter's own later read — the
    // fired-one-off refusal `setRunTriggerForActor` has carried since #2928,
    // and the save guard's re-ask. What this test pins is that a release
    // landing in the gap is REFUSED on a re-read rather than overwritten, and
    // that nothing was written on the way there.
    expect(result.ok).toBe(false);
    expect([
      SAVE_SCHEDULE_REFUSALS.released,
      SAVE_SCHEDULE_REFUSALS.firedOneOff,
      "This run's schedule has already fired, so it can't be changed. Start a new run to schedule it again.",
    ]).toContain((result as { error: string }).error);
    // The re-ask happens BEFORE the cancel, so the released trigger is not even
    // cancelled on the way to the refusal.
    expectNoWrites();
    expect(reads).toBeGreaterThan(1);
  });

  it("the ordinary path is untouched: a cancel that SUCCEEDS still installs the replacement", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(armedRecurring());

    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: WEEKDAYS_AT_8,
    });

    expect(result).toEqual({ ok: true, runId: RUN_ID });
    expect(schedule.cancelTriggerSchedule).toHaveBeenCalledWith({
      jobSchedulerId: "sched-OLD",
      triggerType: "recurring",
    });
    expect(schedule.scheduleTrigger).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// cinatra#2972 — A STOP LANDING MID-SAVE IS REFUSED BY THE SAME RE-ASK
//
// The shape that makes this necessary: the config upsert writes `enabled` back
// to true, so a Save that got past the snapshot would re-arm a schedule the
// person had just stopped. The stop's own stamp is what the re-ask reads, and
// the stamp is the one thing the upsert cannot write.
// ---------------------------------------------------------------------------

describe("a stop landing between the guard's read and the write", () => {
  it("REFUSES, and cancels nothing on the way to the refusal", async () => {
    let reads = 0;
    triggerStore.readRunTriggerByRunId.mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? armedRecurring({ lastFiredAt: new Date() })
        : armedRecurring({ lastFiredAt: new Date(), stoppedAt: new Date() });
    });

    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: WEEKDAYS_AT_8,
    });

    expect(result).toEqual({ ok: false, error: SAVE_SCHEDULE_REFUSALS.stopped });
    expectNoWrites();
    expect(reads).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// cinatra#2972 (codex round 3) — THE COMPENSATION MUST NOT DELETE A STOPPED ROW
//
// The interleaving: a Save gets past the re-ask, a Cancel schedule lands, and
// then the Save's own `scheduleTrigger` fails. The cleanup that follows a failed
// schedule DELETES the trigger row — which would take away the schedule the
// person stopped, contradicting "it never deletes the schedule".
// ---------------------------------------------------------------------------

describe("a stop landing between the re-ask and a failed schedule install", () => {
  it("leaves the stopped row intact instead of deleting it", async () => {
    let reads = 0;
    triggerStore.readRunTriggerByRunId.mockImplementation(async () => {
      reads += 1;
      // Reads 1 and 2 are the pre-check and the setter's own pre-cancel read:
      // still live, so the save proceeds. The stop lands after them, and the
      // compensation's own read is what sees it.
      return reads <= 2
        ? armedRecurring({ lastFiredAt: new Date() })
        : armedRecurring({ lastFiredAt: new Date(), stoppedAt: new Date() });
    });
    schedule.scheduleTrigger.mockRejectedValueOnce(new Error("redis is down"));

    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: WEEKDAYS_AT_8,
    });

    expect(result.ok).toBe(false);
    expect(triggerStore.deleteRunTriggerByRunId).not.toHaveBeenCalled();
  });

  it("an ORDINARY failed schedule still cleans up — the guard is narrow", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(armedRecurring());
    schedule.scheduleTrigger.mockRejectedValueOnce(new Error("redis is down"));

    const result = await updateRunTriggerScheduleForActor(owner, {
      runId: RUN_ID,
      schedule: WEEKDAYS_AT_8,
    });

    expect(result.ok).toBe(false);
    expect(triggerStore.deleteRunTriggerByRunId).toHaveBeenCalledWith(RUN_ID);
  });
});
