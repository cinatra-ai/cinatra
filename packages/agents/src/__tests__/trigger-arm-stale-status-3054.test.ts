/**
 * cinatra#3054 — a stale run status while arming a trigger is a REFUSAL.
 *
 * THE DEFECT. The shared trigger setter exposed the trigger and its scheduler
 * while holding only the trigger claim, and the `pending_trigger → armed`
 * compare-and-set on the run's status came last. The claim serializes writers of
 * the TRIGGER ROW; it does not lock the RUN's status column, which several
 * writers legitimately move. So a Stop landing between the claimed re-read and
 * that compare-and-set made it fail — and the failure was logged and converted
 * into an apparent success one screen up, leaving a trigger row and a live
 * scheduler on a run that is over.
 *
 * HOW THE INTERLEAVING IS FORCED HERE — no sleeps, no timing. The racing Stop
 * lands inside the SEAM the schedule registration gives us: `scheduleTrigger` is
 * called after the claimed re-read and before the compare-and-set on both the
 * old code and the new, so a stub that moves the run at that instant is exactly
 * the window the issue names. The run's status lives in one variable, and the
 * transition stub is CAS-shaped against it — only the rung whose `from` matches
 * the row succeeds — so the ladder is walked for real.
 *
 * The one deterministic REAL-STORE proof of the same race is its sibling,
 * `trigger-arm-stale-status-3054.integration.test.ts`; this file is the focused
 * result-propagation cover for the surfaces (cinatra#3054 acceptance 4).
 *
 * Harness mirrors trigger-service-terminal-run.test.ts: the service runs for
 * real, only its collaborators are stubbed, so no database is needed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TEST_RUN_ID = "run-3054-raced";
const TEST_USER_ID = "user-3054";

/** The status the fake run row is in. The transition stub CASes against it, and
 *  the racing Stop is nothing more than moving it. */
let currentStatus = "pending_trigger";

const store = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(async () => null),
  transitionRunStatus: vi.fn(
    async (_runId: string, _from: string, _to: string, ..._rest: unknown[]): Promise<void> => {},
  ),
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
/** The row shape the setter writes — declared so the assertions below can read
 *  a recorded write without casting it back out of an untyped stub. */
type TriggerRowWrite = {
  runId: string;
  triggerType: string;
  scheduledAt: Date | null;
  cronExpression: string | null;
  timezone: string;
  enabled: boolean;
  jobSchedulerId: string | null;
};

const triggerStore = vi.hoisted(() => ({
  createOrUpdateRunTrigger: vi.fn(async (_row: TriggerRowWrite) => undefined),
  readRunTriggerByRunId: vi.fn(
    async (): Promise<{
      runId: string;
      triggerType: string;
      jobSchedulerId: string | null;
      stoppedAt?: Date | null;
      releasedAt?: Date | null;
    } | null> => null,
  ),
  deleteRunTriggerByRunId: vi.fn(async () => undefined),
  stopRunTriggerInDb: vi.fn(async () => undefined),
}));
const schedule = vi.hoisted(() => ({
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: "sched-3054" })),
  cancelTriggerSchedule: vi.fn(async () => undefined),
}));
/** WHAT HAPPENED, AND IN WHICH ORDER — the claim mock brackets its body and the
 *  transition stub records itself, so a test can prove a write happened while
 *  the claim was HELD rather than after it was released (cinatra#3054,
 *  convergence round). */
const order = vi.hoisted(() => ({ events: [] as string[] }));
const pm = vi.hoisted(() => ({
  syncRunTriggerPmTask: vi.fn(async () => undefined),
  deleteRunTriggerPmTask: vi.fn(async () => undefined),
}));

// The trigger claim reaches Postgres for its advisory lock and this tier has no
// database. The pass-through preserves the CONTRACT the claim gives its callers
// — the body decides on the row as read at claim time — while the row itself
// keeps coming from this file's own mocked store.
vi.mock("../trigger-claim", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../trigger-claim")>();
  const { readRunTriggerByRunId } = await import("../trigger-store");
  return {
    ...actual,
    withTriggerClaim: async (
      runId: string,
      body: (live: Awaited<ReturnType<typeof readRunTriggerByRunId>>) => Promise<unknown>,
    ) => {
      const live = await readRunTriggerByRunId(runId);
      order.events.push("claim:held");
      try {
        return await body(live);
      } finally {
        order.events.push("claim:released");
      }
    },
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
  setRunTriggerForActor,
  deleteRunTriggerForActor,
  armRunScheduleForActor,
  updateRunTriggerScheduleForActor,
  ARM_SCHEDULE_REFUSALS,
} from "../trigger-service";

const actor = { userId: TEST_USER_ID, source: "ui" as const };

function runRow() {
  return {
    id: TEST_RUN_ID,
    runBy: TEST_USER_ID,
    templateId: "tmpl-3054",
    orgId: "org-3054",
    status: currentStatus,
  };
}

/** A naive `datetime-local` a couple of hours out — what the card submits. */
function laterToday(): string {
  return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

/** THE RACE, as one line: the Stop lands while the schedule is being
 *  registered — after the claimed re-read, before the compare-and-set. */
function stopLandsWhileTheScheduleIsRegistered(): void {
  schedule.scheduleTrigger.mockImplementation(async () => {
    currentStatus = "stopped";
    return { jobSchedulerId: "sched-3054" };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  currentStatus = "pending_trigger";
  triggerStore.readRunTriggerByRunId.mockResolvedValue(null);
  // `clearAllMocks` clears CALLS, not implementations: the failure-injecting
  // cases below install their own, so the ordinary ones are put back here.
  triggerStore.createOrUpdateRunTrigger.mockImplementation(async () => undefined);
  triggerStore.deleteRunTriggerByRunId.mockResolvedValue(undefined);
  triggerStore.stopRunTriggerInDb.mockResolvedValue(undefined);
  schedule.scheduleTrigger.mockResolvedValue({ jobSchedulerId: "sched-3054" });
  schedule.cancelTriggerSchedule.mockResolvedValue(undefined);
  store.readAgentRunById.mockImplementation(async () => runRow());
  // CAS-shaped stub: only the edge whose `from` matches the row succeeds.
  store.transitionRunStatus.mockImplementation(async (_runId: string, from: string, to: string) => {
    order.events.push(`transition:${from}->${to}`);
    if (from !== currentStatus) throw new store.RunTransitionError("stale_from_status");
    currentStatus = to;
  });
  order.events.length = 0;
});

describe("cinatra#3054 — the shared setter does not report a stale status as an armed schedule", () => {
  it("refuses a SCHEDULED arm whose run was stopped in the window, and leaves no live scheduler", async () => {
    stopLandsWhileTheScheduleIsRegistered();

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "scheduled",
      scheduledAt: laterToday(),
      timezone: "UTC",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(ARM_SCHEDULE_REFUSALS.movedOn);
    // The scheduler this call registered is taken back down…
    expect(schedule.cancelTriggerSchedule).toHaveBeenCalledWith({
      jobSchedulerId: "sched-3054",
      triggerType: "scheduled",
    });
    // …and no row is left that could name one.
    expect(triggerStore.deleteRunTriggerByRunId).toHaveBeenCalledWith(TEST_RUN_ID);
    expect(
      triggerStore.createOrUpdateRunTrigger.mock.calls.some(
        ([row]) => row.jobSchedulerId !== null,
      ),
    ).toBe(false);
    // Nothing is mirrored outward for a schedule that did not arm.
    expect(pm.syncRunTriggerPmTask).not.toHaveBeenCalled();
  });

  it("refuses a RECURRING arm whose run was stopped in the window — the schedule that would keep firing", async () => {
    stopLandsWhileTheScheduleIsRegistered();

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "recurring",
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(ARM_SCHEDULE_REFUSALS.movedOn);
    expect(schedule.cancelTriggerSchedule).toHaveBeenCalledWith({
      jobSchedulerId: "sched-3054",
      triggerType: "recurring",
    });
    expect(triggerStore.deleteRunTriggerByRunId).toHaveBeenCalledWith(TEST_RUN_ID);
  });

  it("the conversation card's Confirm renders `movedOn` rather than a success", async () => {
    stopLandsWhileTheScheduleIsRegistered();

    const result = await armRunScheduleForActor(actor, {
      runId: TEST_RUN_ID,
      schedule: { kind: "scheduled", runAt: laterToday(), timezone: "UTC" },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(ARM_SCHEDULE_REFUSALS.movedOn);
    expect(schedule.cancelTriggerSchedule).toHaveBeenCalledTimes(1);
  });

  it("pins the durable state SEPARATELY when the scheduler cleanup itself fails: nothing reports the schedule as armed", async () => {
    stopLandsWhileTheScheduleIsRegistered();
    schedule.cancelTriggerSchedule.mockRejectedValue(new Error("redis unreachable"));

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "recurring",
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
    });

    expect(result.ok).toBe(false);
    // The row is NOT deleted — the orphan has to stay nameable, which is the
    // same shape the stop path relies on: the first tick reads the stamp,
    // refuses to fire and tears the scheduler down.
    expect(triggerStore.deleteRunTriggerByRunId).not.toHaveBeenCalled();
    const lastWrite = triggerStore.createOrUpdateRunTrigger.mock.calls.at(-1)?.[0];
    expect(lastWrite?.jobSchedulerId).toBe("sched-3054");
    expect(lastWrite?.enabled).toBe(false);
    expect(triggerStore.stopRunTriggerInDb).toHaveBeenCalledWith(TEST_RUN_ID);
  });

  it("still succeeds when the run is ALREADY armed — the postcondition asks the RUN, not the compare-and-set", async () => {
    // **Save changes** on a live schedule: both rungs of the ladder are stale
    // because the run left `pending_*` when it was first armed. That is not a
    // run that moved on, and it must not be refused or rolled back.
    currentStatus = "armed";
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      runId: TEST_RUN_ID,
      triggerType: "recurring",
      jobSchedulerId: "sched-prior",
      stoppedAt: null,
      releasedAt: null,
    });

    const result = await updateRunTriggerScheduleForActor(actor, {
      runId: TEST_RUN_ID,
      schedule: { kind: "scheduled", runAt: laterToday(), timezone: "UTC" },
    });

    expect(result.ok).toBe(true);
    expect(triggerStore.deleteRunTriggerByRunId).not.toHaveBeenCalled();
    expect(triggerStore.stopRunTriggerInDb).not.toHaveBeenCalled();
    // The prior scheduler is cancelled by the replace step; the NEW one stands.
    expect(schedule.cancelTriggerSchedule).toHaveBeenCalledWith({
      jobSchedulerId: "sched-prior",
      triggerType: "recurring",
    });
    const lastWrite = triggerStore.createOrUpdateRunTrigger.mock.calls.at(-1)?.[0];
    expect(lastWrite?.jobSchedulerId).toBe("sched-3054");
  });

  // ------------------------------------------------------------------
  // The convergence round's cases: the refusal must not reach past the race
  // it exists for, and the two failure paths it opens have to be honest.
  // ------------------------------------------------------------------

  it("does NOT refuse a recurring save on a run that is simply getting on with its own life", async () => {
    // The run was never on a rung this ladder flips: it is `running`, and it
    // finishes while the call is in flight. That is ordinary progress, not a
    // race — a recurring row is a future-fire schedule, meaningful
    // independently of this run's own outcome (cinatra#2482 item 4). Refusing
    // here would delete a schedule the reader just asked for.
    currentStatus = "running";
    schedule.scheduleTrigger.mockImplementation(async () => {
      currentStatus = "completed";
      return { jobSchedulerId: "sched-3054" };
    });

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "recurring",
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    expect(schedule.cancelTriggerSchedule).not.toHaveBeenCalled();
    expect(triggerStore.deleteRunTriggerByRunId).not.toHaveBeenCalled();
    const lastWrite = triggerStore.createOrUpdateRunTrigger.mock.calls.at(-1)?.[0];
    expect(lastWrite?.jobSchedulerId).toBe("sched-3054");
  });

  it("does NOT tear a schedule down when the settlement READ fails on a run that was never being armed", async () => {
    // A database that will not answer is not evidence that a run moved. On a
    // run the arm was never going to flip, an unreadable status leaves the
    // schedule exactly where the old code left it.
    currentStatus = "running";
    let reads = 0;
    store.readAgentRunById.mockImplementation(async () => {
      reads += 1;
      if (reads > 1) throw new Error("read timed out");
      return runRow();
    });

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "recurring",
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    expect(schedule.cancelTriggerSchedule).not.toHaveBeenCalled();
    expect(triggerStore.deleteRunTriggerByRunId).not.toHaveBeenCalled();
  });

  it("DOES refuse when the settlement read fails on a run that WAS being armed — both rungs stale already prove it moved", async () => {
    stopLandsWhileTheScheduleIsRegistered();
    let reads = 0;
    store.readAgentRunById.mockImplementation(async () => {
      reads += 1;
      if (reads > 1) throw new Error("read timed out");
      return runRow();
    });

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "scheduled",
      scheduledAt: laterToday(),
      timezone: "UTC",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(ARM_SCHEDULE_REFUSALS.movedOn);
    expect(schedule.cancelTriggerSchedule).toHaveBeenCalledWith({
      jobSchedulerId: "sched-3054",
      triggerType: "scheduled",
    });
  });

  it("cancels the scheduler when the FINAL row write fails, so nothing fires behind a reported failure", async () => {
    // The status settles before this write now, so the run is `armed` when it
    // throws. The run cannot be un-armed, but the scheduler can be taken back —
    // and taking it back is what keeps the schedule from firing a run whose
    // caller was told the call failed.
    let writes = 0;
    triggerStore.createOrUpdateRunTrigger.mockImplementation(async () => {
      writes += 1;
      if (writes > 1) throw new Error("write failed");
      return undefined;
    });

    await expect(
      setRunTriggerForActor(actor, {
        runId: TEST_RUN_ID,
        triggerType: "scheduled",
        scheduledAt: laterToday(),
        timezone: "UTC",
      }),
    ).rejects.toThrow("write failed");

    expect(schedule.cancelTriggerSchedule).toHaveBeenCalledWith({
      jobSchedulerId: "sched-3054",
      triggerType: "scheduled",
    });
  });

  it("still refuses, and still reports no armed schedule, when NEITHER repair write lands after a failed cancel", async () => {
    // The unsafe corner named in the helper's docblock: the scheduler will not
    // cancel and the database will not take either repair. Nothing here can
    // make that state safe; what it must do is refuse, claim nothing, and say
    // so — never report an armed schedule.
    stopLandsWhileTheScheduleIsRegistered();
    schedule.cancelTriggerSchedule.mockRejectedValue(new Error("redis unreachable"));
    let writes = 0;
    triggerStore.createOrUpdateRunTrigger.mockImplementation(async () => {
      writes += 1;
      if (writes > 1) throw new Error("write failed");
      return undefined;
    });
    triggerStore.stopRunTriggerInDb.mockRejectedValue(new Error("write failed"));

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "recurring",
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(ARM_SCHEDULE_REFUSALS.movedOn);
    expect(
      triggerStore.createOrUpdateRunTrigger.mock.calls.some(
        ([row]) => row.enabled === true && row.jobSchedulerId !== null,
      ),
    ).toBe(false);
  });

  it("leaves an IN-FLIGHT run paused at a trigger step alone — its resume rides this very row", async () => {
    currentStatus = "waiting_trigger";

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "scheduled",
      scheduledAt: laterToday(),
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    expect(triggerStore.deleteRunTriggerByRunId).not.toHaveBeenCalled();
    expect(schedule.cancelTriggerSchedule).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Second convergence round (cinatra#3054). Two holes the first settlement
  // still left open, each pinned by the interleaving that reaches it.
  // -------------------------------------------------------------------------

  it("refuses an arm whose run LEFT AND CAME BACK to the status the arm was decided on", async () => {
    // THE INTERLEAVING. The arm is decided on `pending_input`. The person opens
    // the trigger form while the schedule is registering (`pending_input ->
    // pending_trigger`), so the first rung is stale; then they navigate away
    // (`pending_trigger -> pending_input`) before the second rung is tried, so
    // that one is stale too. Both edges are in LEGAL_TRANSITIONS. The run ends
    // on exactly the status the arm was decided on, and NOTHING armed it.
    //
    // An earlier settlement asked `settled !== run.status` and read this as
    // "nothing raced the arm", reporting an armed schedule over a run that is
    // not armed and that no release job will ever move.
    currentStatus = "pending_input";
    schedule.scheduleTrigger.mockImplementation(async () => {
      currentStatus = "pending_trigger"; // the form is opened mid-arm
      return { jobSchedulerId: "sched-3054" };
    });
    store.transitionRunStatus.mockImplementation(
      async (_runId: string, from: string, to: string) => {
        if (from !== currentStatus) {
          // The navigate-away lands between the two rungs: the first rung finds
          // `pending_trigger` and fails, and by the second the run is back.
          if (from === "pending_input" && currentStatus === "pending_trigger") {
            currentStatus = "pending_input";
          }
          throw new store.RunTransitionError("stale_from_status");
        }
        currentStatus = to;
      },
    );

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "recurring",
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
    });

    // The run never reached `armed`, so the arm is refused...
    expect(currentStatus).toBe("pending_input");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(ARM_SCHEDULE_REFUSALS.movedOn);
    // ...and the scheduler that would have ticked for ever is taken back down.
    expect(schedule.cancelTriggerSchedule).toHaveBeenCalledWith({
      jobSchedulerId: "sched-3054",
      triggerType: "recurring",
    });
    expect(
      triggerStore.createOrUpdateRunTrigger.mock.calls.some(
        ([row]) => row.jobSchedulerId !== null,
      ),
    ).toBe(false);
  });

  it("cancels the scheduler when the SETTLEMENT ITSELF throws, so no orphan outlives the error", async () => {
    // A settlement failure that is NOT `stale_from_status` -- a database
    // timeout, an authority rejection -- propagates to the caller. The
    // scheduler is already registered and the row does not name it yet (the id
    // is persisted only after the settlement), and the release job tears a
    // scheduler down ONLY through the id on the row. So an orphan left here is
    // unnameable and immortal; it has to be cancelled before the rethrow.
    store.transitionRunStatus.mockImplementation(async () => {
      throw new Error("the database could not be reached");
    });

    await expect(
      setRunTriggerForActor(actor, {
        runId: TEST_RUN_ID,
        triggerType: "recurring",
        cronExpression: "0 9 * * 1",
        timezone: "UTC",
      }),
    ).rejects.toThrow("the database could not be reached");

    expect(schedule.cancelTriggerSchedule).toHaveBeenCalledWith({
      jobSchedulerId: "sched-3054",
      triggerType: "recurring",
    });
    // Nothing was left behind naming a scheduler as though the arm had settled.
    expect(
      triggerStore.createOrUpdateRunTrigger.mock.calls.some(
        ([row]) => row.jobSchedulerId !== null,
      ),
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // THE OTHER HALF OF THE SAME RACE (cinatra#3054, convergence round). Arming
  // settles the run INSIDE the trigger claim; a Stop that flips `armed →
  // stopped` OUTSIDE the claim could therefore still land between that
  // settlement and the arm's final row write, and the arm would publish an
  // enabled row and a live scheduler over a stopped run. So the stop's own flip
  // is written inside the claim too, and this pins it there.
  // -------------------------------------------------------------------------
  it("writes the stop's armed→stopped flip INSIDE the trigger claim, so no arm can settle across it", async () => {
    currentStatus = "armed";
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      runId: TEST_RUN_ID,
      triggerType: "recurring",
      jobSchedulerId: "sched-3054",
      stoppedAt: null,
      releasedAt: null,
    });

    const result = await deleteRunTriggerForActor(actor, { runId: TEST_RUN_ID });

    expect(result.ok).toBe(true);
    expect(currentStatus).toBe("stopped");
    const flip = order.events.indexOf("transition:armed->stopped");
    expect(flip).toBeGreaterThan(-1);
    expect(order.events.indexOf("claim:held")).toBeLessThan(flip);
    expect(order.events.indexOf("claim:released")).toBeGreaterThan(flip);
  });

  it("reports an orphaned scheduler the row could not NAME, even when the stopped stamp landed", async () => {
    // The cancel fails, so the repair is the nameable-and-dead row. The naming
    // write fails and the stamp succeeds: the row then reads stopped but cannot
    // tell the release job which scheduler to cancel, so a live scheduler
    // survives and has to be reported as one.
    stopLandsWhileTheScheduleIsRegistered();
    schedule.cancelTriggerSchedule.mockImplementation(async () => {
      throw new Error("redis is unreachable");
    });
    triggerStore.createOrUpdateRunTrigger.mockImplementation(async (row: TriggerRowWrite) => {
      if (row.jobSchedulerId) throw new Error("the row could not be written");
      return undefined;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "recurring",
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(ARM_SCHEDULE_REFUSALS.movedOn);
    // The stamp DID land…
    expect(triggerStore.stopRunTriggerInDb).toHaveBeenCalledWith(TEST_RUN_ID);
    // …and the unnameable live scheduler is still reported.
    expect(
      errors.mock.calls.some(([first]) =>
        typeof first === "string" && first.includes("could not be recorded on its row"),
      ),
    ).toBe(true);
    errors.mockRestore();
  });
});
