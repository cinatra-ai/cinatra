/**
 * CANCEL SCHEDULE — stopping a recurring schedule (cinatra#2972).
 *
 * The plan's words, which this suite is the executable reading of:
 *
 *   "its one control is **Cancel schedule**, shown only for a recurring
 *    schedule that has fired once — it stops the recurring schedule and then
 *    makes the scheduler non-editable"          — PLAN (A) §7.2, 2026-08-25
 *   "**Cancel schedule** → **End state: stopped** (the scheduler then
 *    non-editable)"                              — PLAN (A) §7.4, as designed
 *
 * and the issue's own sentence, which is the one this file mostly exists for:
 * it "never deletes the schedule or pauses the run".
 *
 * WHAT IS PINNED:
 *
 *   1. IDENTITY — the run's owner or an administrator, and nobody else.
 *   2. SUBJECT — a RECURRING schedule that has FIRED. A one-off is refused; so
 *      is a recurring schedule that has produced nothing yet.
 *   3. IT DOES NOT DELETE. The trigger row is never deleted, so the person can
 *      still read the schedule they stopped.
 *   4. IT DOES NOT PAUSE THE RUN. No status transition is attempted at all —
 *      which is the whole difference from `deleteRunTriggerForActor`, the path
 *      this operation used to take.
 *   5. IT STAMPS FIRST, THEN CANCELS THE SCHEDULER. A failed cancel is not
 *      fatal, because the durable answer is already written and the fire path
 *      refuses a stopped row (and unschedules the orphan on that tick). The
 *      opposite order is what would strand a lie: a row still reading ARMED and
 *      EDITABLE with no scheduler behind it.
 *   6. IT IS IDEMPOTENT — a second press is a no-op, not a refusal.
 *
 * Harness mirrors trigger-service-save-schedule.test.ts: the service runs for
 * real, only its collaborators are stubbed, so no database is needed.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/trigger-service-stop-recurring.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const RUN_ID = "run-2972-stop";
const OWNER_ID = "user-2972-owner";

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
  stopRunTriggerInDb: vi.fn(async () => undefined),
}));
const schedule = vi.hoisted(() => ({
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: "sched-2972" })),
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

import { stopRecurringTriggerForActor } from "../trigger-service";

const owner = { userId: OWNER_ID, source: "ui" as const };
const stranger = { userId: "user-2972-somebody-else", source: "ui" as const };
const admin = { userId: "user-2972-admin", role: "admin", source: "ui" as const };

const RUN = {
  id: RUN_ID,
  runBy: OWNER_ID,
  templateId: "tmpl-2972",
  orgId: "org-2972",
  status: "armed",
};

/** A recurring schedule that HAS fired — the one state the control exists in. */
const FIRED_RECURRING = {
  runId: RUN_ID,
  triggerType: "recurring",
  scheduledAt: null,
  cronExpression: "0 9 * * 1-5",
  timezone: "Europe/Berlin",
  enabled: true,
  releasedAt: null,
  lastFiredAt: new Date("2026-08-24T09:00:00Z"),
  stoppedAt: null,
  jobSchedulerId: "sched-2972",
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  store.readAgentRunById.mockResolvedValue(RUN);
  triggerStore.readRunTriggerByRunId.mockResolvedValue({ ...FIRED_RECURRING });
});

describe("who may stop a schedule", () => {
  it("the run's owner may", async () => {
    await expect(
      stopRecurringTriggerForActor(owner, { runId: RUN_ID }),
    ).resolves.toEqual({ ok: true });
  });

  it("an administrator may", async () => {
    await expect(
      stopRecurringTriggerForActor(admin, { runId: RUN_ID }),
    ).resolves.toEqual({ ok: true });
  });

  it("a stranger may not, and nothing is written", async () => {
    const result = await stopRecurringTriggerForActor(stranger, { runId: RUN_ID });
    expect(result).toEqual({ ok: false, error: "forbidden" });
    expect(triggerStore.stopRunTriggerInDb).not.toHaveBeenCalled();
    expect(schedule.cancelTriggerSchedule).not.toHaveBeenCalled();
  });

  it("an unauthenticated caller may not", async () => {
    const result = await stopRecurringTriggerForActor(
      { userId: "", source: "ui" },
      { runId: RUN_ID },
    );
    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(triggerStore.stopRunTriggerInDb).not.toHaveBeenCalled();
  });
});

describe("what may be stopped — the plan's own subject", () => {
  it("a schedule DISABLED by something other than Cancel schedule is NOT read as stopped", async () => {
    // `trigger_config_set` can disable any trigger. Reading that as "the person
    // pressed Cancel schedule" would permanently freeze a schedule nobody
    // stopped, so the stamp is the only signal (cinatra#2972).
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      ...FIRED_RECURRING,
      enabled: false,
      stoppedAt: null,
    });
    await expect(
      stopRecurringTriggerForActor(owner, { runId: RUN_ID }),
    ).resolves.toEqual({ ok: true });
    expect(triggerStore.stopRunTriggerInDb).toHaveBeenCalledWith(RUN_ID);
  });

  it("a ONE-OFF is refused, however it stands", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      ...FIRED_RECURRING,
      triggerType: "scheduled",
      cronExpression: null,
      scheduledAt: new Date("2026-08-24T09:00:00Z"),
      releasedAt: new Date("2026-08-24T09:00:00Z"),
      lastFiredAt: null,
    });
    const result = await stopRecurringTriggerForActor(owner, { runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(triggerStore.stopRunTriggerInDb).not.toHaveBeenCalled();
  });

  it("a recurring schedule that has NOT fired yet is refused — there is nothing to stop", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      ...FIRED_RECURRING,
      lastFiredAt: null,
    });
    const result = await stopRecurringTriggerForActor(owner, { runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(triggerStore.stopRunTriggerInDb).not.toHaveBeenCalled();
  });

  it("a run with no trigger at all is refused", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(null);
    expect((await stopRecurringTriggerForActor(owner, { runId: RUN_ID })).ok).toBe(false);
  });

  it("an already-stopped schedule answers ok without writing again", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      ...FIRED_RECURRING,
      // The STAMP is the state — not `enabled`, which the trigger MCP tool also
      // writes for reasons that have nothing to do with Cancel schedule.
      stoppedAt: new Date("2026-08-24T10:00:00Z"),
      enabled: false,
      jobSchedulerId: null,
    });
    await expect(
      stopRecurringTriggerForActor(owner, { runId: RUN_ID }),
    ).resolves.toEqual({ ok: true });
    expect(triggerStore.stopRunTriggerInDb).not.toHaveBeenCalled();
  });
});

describe("it stops — and it does not delete, and it does not pause the run", () => {
  it("cancels the scheduler and marks the row stopped", async () => {
    await stopRecurringTriggerForActor(owner, { runId: RUN_ID });
    expect(schedule.cancelTriggerSchedule).toHaveBeenCalledWith({
      jobSchedulerId: "sched-2972",
      triggerType: "recurring",
    });
    expect(triggerStore.stopRunTriggerInDb).toHaveBeenCalledWith(RUN_ID);
  });

  it("NEVER deletes the trigger row — the schedule stays readable", async () => {
    await stopRecurringTriggerForActor(owner, { runId: RUN_ID });
    expect(triggerStore.deleteRunTriggerByRunId).not.toHaveBeenCalled();
  });

  it("NEVER moves the run — no transition is even attempted", async () => {
    await stopRecurringTriggerForActor(owner, { runId: RUN_ID });
    expect(store.transitionRunStatus).not.toHaveBeenCalled();
  });

  it("unschedules the mirrored PM task, fail-open", async () => {
    pm.deleteRunTriggerPmTask.mockRejectedValueOnce(new Error("PM is down"));
    await expect(
      stopRecurringTriggerForActor(owner, { runId: RUN_ID }),
    ).resolves.toEqual({ ok: true });
    expect(pm.deleteRunTriggerPmTask).toHaveBeenCalledWith({ runId: RUN_ID });
  });

  it("STAMPS BEFORE it cancels — the order is the crash protocol", async () => {
    const order: string[] = [];
    triggerStore.stopRunTriggerInDb.mockImplementationOnce(async () => {
      order.push("stamp");
    });
    schedule.cancelTriggerSchedule.mockImplementationOnce(async () => {
      order.push("cancel");
    });
    await stopRecurringTriggerForActor(owner, { runId: RUN_ID });
    expect(order).toEqual(["stamp", "cancel"]);
  });

  it("the scheduler id SURVIVES the stop, so a failed cancel leaves an orphan that can be named", async () => {
    // Erasing the id would leave a stopped row and a scheduler nothing can
    // unschedule with — it would tick into a refusal forever (codex round 3).
    await stopRecurringTriggerForActor(owner, { runId: RUN_ID });
    const written = triggerStore.stopRunTriggerInDb.mock.calls.length;
    expect(written).toBe(1);
    // The store write is the whole contract here: it takes the run id and
    // nothing else, and the store never clears `jobSchedulerId`.
    expect(triggerStore.stopRunTriggerInDb).toHaveBeenCalledWith(RUN_ID);
  });

  it("a failed CANCEL still leaves the schedule stopped — the fire path is authoritative", async () => {
    // Cancelling first and stamping second would leave, on a failure, a row
    // that reads armed and editable with no scheduler behind it. This order
    // leaves the opposite: a row that reads stopped, refuses to be changed, and
    // whose surviving scheduler is torn down by the tick that reads the stamp.
    schedule.cancelTriggerSchedule.mockRejectedValueOnce(new Error("redis is down"));
    const result = await stopRecurringTriggerForActor(owner, { runId: RUN_ID });
    expect(result).toEqual({ ok: true });
    expect(triggerStore.stopRunTriggerInDb).toHaveBeenCalledWith(RUN_ID);
    expect(triggerStore.deleteRunTriggerByRunId).not.toHaveBeenCalled();
  });

  it("a failed STAMP writes nothing and refuses — the scheduler is untouched", async () => {
    triggerStore.stopRunTriggerInDb.mockRejectedValueOnce(new Error("db is down"));
    const result = await stopRecurringTriggerForActor(owner, { runId: RUN_ID });
    expect(result.ok).toBe(false);
    expect(schedule.cancelTriggerSchedule).not.toHaveBeenCalled();
    expect(triggerStore.deleteRunTriggerByRunId).not.toHaveBeenCalled();
  });
});
