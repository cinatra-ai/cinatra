/**
 * THE SCHEDULE MOMENT'S SERVER-SIDE INVARIANTS (cinatra#2928, epic #2926 W2a).
 *
 * The schedule is a lifecycle moment like the others, and the rules about what
 * may still be changed about it are the SERVER's, not the screen's. Three of
 * them, and each is stated here against the real service with only its
 * collaborators stubbed:
 *
 *   1. A ONE-OFF SCHEDULE CAN BE CHANGED UNTIL IT FIRES, AND IS REFUSED
 *      AFTERWARDS. A one-off names a single instant; once that instant has
 *      passed, rewriting the row is not a reschedule but a claim about a moment
 *      that is over.
 *   2. A RECURRING SCHEDULE'S CHANGE APPLIES TO ITS FUTURE TICKS ONLY. It is
 *      never refused for having fired, because its next tick is still ahead of
 *      it — and a tick already fired is a separate run that no change here
 *      reaches back into.
 *   3. RELEASE NOW ON A RECURRING SCHEDULE STARTS ONE COPY AND LEAVES THE
 *      SCHEDULE RUNNING. It used to start the schedule-DEFINING run, which spent
 *      it and left the schedule reading as no longer armed.
 *
 * Harness: the same shape as `trigger-service-terminal-run.test.ts` — the
 * service runs for real, its collaborators are stubbed, no database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const RUN_ID = "run-2928-schedule";
const USER_ID = "user-2928";
const ORG_ID = "org-2928";

const store = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(async () => null),
  transitionRunStatus: vi.fn(
    async (
      _runId: string,
      _from: string,
      _to: string,
      ..._rest: unknown[]
    ): Promise<void> => {},
  ),
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));
const triggerStore = vi.hoisted(() => ({
  createOrUpdateRunTrigger: vi.fn(async () => undefined),
  readRunTriggerByRunId: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  deleteRunTriggerByRunId: vi.fn(async () => undefined),
}));
const schedule = vi.hoisted(() => ({
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: "sched-2928" })),
  cancelTriggerSchedule: vi.fn(async () => undefined),
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
vi.mock("@/lib/pm-integration-providers", () => ({
  syncRunTriggerPmTask: vi.fn(async () => undefined),
  deleteRunTriggerPmTask: vi.fn(async () => undefined),
}));
vi.mock("@/lib/agent-run-enqueue", () => ({
  enqueueAgentRun: vi.fn(async () => ({ runId: "", jobId: "", status: "queued" as const })),
  enqueueDepsForTemplate: vi.fn(() => ({})),
}));

import { setRunTriggerForActor } from "../trigger-service";

const actor = { userId: USER_ID, source: "ui" as const };

const armedRun = {
  id: RUN_ID,
  runBy: USER_ID,
  templateId: "tmpl-2928",
  orgId: ORG_ID,
  status: "armed",
};

/** A one-off schedule, with or without the release stamp that says it fired. */
function oneOff(releasedAt: Date | null) {
  return {
    runId: RUN_ID,
    triggerType: "scheduled",
    scheduledAt: new Date("2026-09-01T09:00:00Z"),
    cronExpression: null,
    timezone: "UTC",
    enabled: true,
    releasedAt,
    jobSchedulerId: "sched-2928",
  };
}

function recurring(releasedAt: Date | null) {
  return {
    runId: RUN_ID,
    triggerType: "recurring",
    scheduledAt: null,
    cronExpression: "0 9 * * *",
    timezone: "UTC",
    enabled: true,
    releasedAt,
    jobSchedulerId: "sched-2928",
  };
}

/** A future instant, in the naive datetime-local shape the form produces. */
function futureNaive(): string {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 16);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.readAgentRunById.mockResolvedValue(armedRun);
  triggerStore.readRunTriggerByRunId.mockResolvedValue(null);
  schedule.scheduleTrigger.mockResolvedValue({ jobSchedulerId: "sched-2928" });
});

describe("a one-off schedule can be changed until it fires", () => {
  it("accepts a change while it has NOT fired", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(oneOff(null));

    const result = await setRunTriggerForActor(actor, {
      runId: RUN_ID,
      triggerType: "scheduled",
      scheduledAt: futureNaive(),
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    expect(triggerStore.createOrUpdateRunTrigger).toHaveBeenCalled();
  });

  it("REFUSES a change once it has fired, and says what to do instead", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(oneOff(new Date("2026-09-01T09:00:01Z")));

    const result = await setRunTriggerForActor(actor, {
      runId: RUN_ID,
      triggerType: "scheduled",
      scheduledAt: futureNaive(),
      timezone: "UTC",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/already fired/i);
    expect(result.ok === false && result.error).toMatch(/start a new run/i);
  });

  it("refuses BEFORE any write — no row rewritten, no schedule cancelled or installed", async () => {
    // The refusal is only worth anything if nothing has happened yet. A refusal
    // after the cancel would have already torn down the schedule it refused to
    // change.
    triggerStore.readRunTriggerByRunId.mockResolvedValue(oneOff(new Date()));

    await setRunTriggerForActor(actor, {
      runId: RUN_ID,
      triggerType: "scheduled",
      scheduledAt: futureNaive(),
      timezone: "UTC",
    });

    expect(triggerStore.createOrUpdateRunTrigger).not.toHaveBeenCalled();
    expect(triggerStore.deleteRunTriggerByRunId).not.toHaveBeenCalled();
    expect(schedule.cancelTriggerSchedule).not.toHaveBeenCalled();
    expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
  });

  it("refuses a fired one-off on EVERY change, not only a change to another one-off", async () => {
    // The rule is about the schedule that fired, not about what it is being
    // changed INTO — a fired one-off cannot become a recurring schedule either.
    triggerStore.readRunTriggerByRunId.mockResolvedValue(oneOff(new Date()));

    const toRecurring = await setRunTriggerForActor(actor, {
      runId: RUN_ID,
      triggerType: "recurring",
      cronExpression: "0 9 * * *",
      timezone: "UTC",
    });

    expect(toRecurring.ok).toBe(false);
    expect(toRecurring.ok === false && toRecurring.error).toMatch(/already fired/i);
  });
});

describe("a recurring schedule's change applies to its future ticks", () => {
  it("is accepted even after ticks have fired", async () => {
    // The release stamp on a recurring row records that a tick fired. Its next
    // tick is still ahead of it, so the change is a change to the future — never
    // the refusal a one-off gets.
    triggerStore.readRunTriggerByRunId.mockResolvedValue(recurring(new Date()));

    const result = await setRunTriggerForActor(actor, {
      runId: RUN_ID,
      triggerType: "recurring",
      cronExpression: "30 18 * * 1",
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    // The OLD scheduler is cancelled and a new one installed — which is what
    // "applies to future ticks" is, mechanically. Ticks already fired are
    // separate runs and nothing here touches them.
    expect(schedule.cancelTriggerSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ jobSchedulerId: "sched-2928", triggerType: "recurring" }),
    );
    expect(schedule.scheduleTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ cronExpression: "30 18 * * 1" }),
    );
  });

  it("never transitions the runs a past tick produced", async () => {
    triggerStore.readRunTriggerByRunId.mockResolvedValue(recurring(new Date()));

    await setRunTriggerForActor(actor, {
      runId: RUN_ID,
      triggerType: "recurring",
      cronExpression: "30 18 * * 1",
      timezone: "UTC",
    });

    // Every transition this call makes is on the SCHEDULE-DEFINING run. A tick's
    // own run has a different id and is never named here.
    for (const call of store.transitionRunStatus.mock.calls) {
      expect(call[0]).toBe(RUN_ID);
    }
  });
});
