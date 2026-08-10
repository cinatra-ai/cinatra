/**
 * IMMEDIATE RE-ARM against a terminal run (cinatra#2482).
 *
 * The issue's repro ends "Browser-back to /trigger + Continue repeats the
 * identical dead-end." That loop existed because an immediate trigger on an
 * already-finished run was a SILENT NO-OP that reported success: the service
 * rewrote the trigger row, attempted `pending_input → queued`, caught the
 * resulting `stale_from_status` and returned `{ ok: true }` — so the form's
 * Continue routed the user straight back to the same finished run, forever.
 *
 * This suite locks the guard:
 *
 *   1. an immediate RE-arm (a trigger row already exists) on completed /
 *      failed / stopped is REFUSED, with a message naming the real next action;
 *   2. the refusal happens BEFORE any write — no trigger row, no schedule, no
 *      status transition, no PM sync;
 *   3. the FIRST arm of a terminal run is NOT gated. Codex round-B finding:
 *      terminal status alone also describes cinatra#580's genuine
 *      setup-success state (`completed`, no trigger row, redirected to the form
 *      precisely so a trigger can be chosen), so gating on it would hard-error
 *      the first arm of every such run — the feature's main path;
 *   4. scheduled / recurring are NEVER gated (their row is a future-fire
 *      schedule, meaningful independently of this run's own outcome);
 *   5. the ordinary immediate dispatch from `pending_input` is untouched.
 *
 * Harness mirrors trigger-service-cron-validation.test.ts: the service runs for
 * real, only its collaborators are stubbed, so no database is needed.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/trigger-service-terminal-run.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TEST_RUN_ID = "run-2482-terminal";
const TEST_USER_ID = "user-2482";

const store = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(async () => null),
  transitionRunStatus: vi.fn(
    async (_runId: string, _from: string, _to: string, ..._rest: unknown[]): Promise<void> => {},
  ),
  // cinatra#2523: the immediate branch now walks a LADDER of legal `from`
  // states, so the stub must refuse the ones that do not match the run — a stub
  // that accepts every `from` would let any rung "succeed" and prove nothing
  // about which edge the service actually took. (The no-stub proof of the
  // swallow itself lives in trigger-service-immediate-dispatch.integration.test.ts,
  // per this issue's acceptance criterion 2.)
  RunTransitionError: class RunTransitionError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));
// cinatra#2523: `ok:true` now means a job was really enqueued, so the chokepoint
// is spied on rather than reached.
const enqueue = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(async () => ({ runId: "", jobId: "", status: "queued" as const })),
  enqueueDepsForTemplate: vi.fn(() => ({})),
}));
type ExistingTrigger = {
  runId: string;
  triggerType: string;
  jobSchedulerId: string | null;
} | null;
const triggerStore = vi.hoisted(() => ({
  createOrUpdateRunTrigger: vi.fn(async () => undefined),
  readRunTriggerByRunId: vi.fn(
    async (): Promise<{
      runId: string;
      triggerType: string;
      jobSchedulerId: string | null;
    } | null> => null,
  ),
  deleteRunTriggerByRunId: vi.fn(async () => undefined),
}));
const schedule = vi.hoisted(() => ({
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: "sched-2482" })),
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

import { setRunTriggerForActor } from "../trigger-service";

const actor = { userId: TEST_USER_ID, source: "ui" as const };

/** The status the fake run row is in — the transition stub CASes against it. */
let currentStatus = "pending_input";

function runInStatus(status: string) {
  currentStatus = status;
  return {
    id: TEST_RUN_ID,
    runBy: TEST_USER_ID,
    templateId: "tmpl-2482",
    orgId: "org-2482",
    status,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  triggerStore.readRunTriggerByRunId.mockResolvedValue(null);
  schedule.scheduleTrigger.mockResolvedValue({ jobSchedulerId: "sched-2482" });
  // CAS-shaped stub: only the edge whose `from` matches the row succeeds.
  store.transitionRunStatus.mockImplementation(async (_runId: string, from: string) => {
    if (from !== currentStatus) throw new store.RunTransitionError("stale_from_status");
  });
});

/** An already-configured immediate trigger — i.e. the arm is a RE-arm. */
const existingImmediate: ExistingTrigger = {
  runId: TEST_RUN_ID,
  triggerType: "immediate",
  jobSchedulerId: null,
};

describe("setRunTriggerForActor — immediate re-arm on a terminal run (cinatra#2482)", () => {
  it.each(["completed", "failed", "stopped"])(
    "refuses an immediate RE-arm on a %s run instead of silently no-opping",
    async (status) => {
      store.readAgentRunById.mockResolvedValue(runInStatus(status));
      triggerStore.readRunTriggerByRunId.mockResolvedValue(existingImmediate);

      const result = await setRunTriggerForActor(actor, {
        runId: TEST_RUN_ID,
        triggerType: "immediate",
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/already finished/i);
      expect(result.ok === false && result.error).toMatch(/start a new run/i);
    },
  );

  // cinatra#2523 (owner ruling 2026-08-09, remedy (c)) REPLACED this pin.
  //
  // The carve-out it used to lock let a `completed` run with no trigger row
  // through, on the reasoning that terminal status ALONE also described
  // cinatra#580's setup-success state. That reasoning was sound and the
  // carve-out was still wrong: the run WAS terminal, the `→queued` CAS failed,
  // the failure was swallowed, and the documented main path reported success
  // having dispatched nothing.
  //
  // Remedy (c) removed the premise instead of the check — setup now ends on
  // `pending_trigger` (execution.ts), never `completed` — so `completed` means
  // only one thing again and is refused like every other terminal status.
  it("refuses the FIRST immediate arm of a completed run — setup no longer ends there (cinatra#2523)", async () => {
    store.readAgentRunById.mockResolvedValue(runInStatus("completed"));
    triggerStore.readRunTriggerByRunId.mockResolvedValue(null);

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "immediate",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/already finished/i);
    expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
    expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
  });

  // The state that REPLACED it. This is the documented main path now.
  it("dispatches the setup-success hand-off state (pending_trigger) — and really enqueues (cinatra#2523)", async () => {
    store.readAgentRunById.mockResolvedValue(runInStatus("pending_trigger"));

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "immediate",
    });

    expect(result.ok).toBe(true);
    expect(store.transitionRunStatus).toHaveBeenCalledWith(
      TEST_RUN_ID,
      "pending_trigger",
      "queued",
      undefined,
      expect.anything(),
      { actingUserId: TEST_USER_ID },
    );
    // ok:true implies a dispatch happened — the whole point of the ruling.
    expect(enqueue.enqueueAgentRun).toHaveBeenCalledTimes(1);
  });

  // The honesty half: a status with no dispatch edge is REFUSED, not swallowed.
  it("refuses instead of reporting success when no legal dispatch edge exists (cinatra#2523)", async () => {
    store.readAgentRunById.mockResolvedValue(runInStatus("pending_approval"));

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "immediate",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/setup form/i);
    expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
  });

  // Codex round-2 finding. The carve-out above is for the SETUP-SUCCESS state
  // only. `failed` / `stopped` with no trigger row are not that state — their
  // transition is equally stale, so a "first" arm there is the same silent
  // no-op the gate exists to kill. An earlier cut exempted all three and the
  // parameterized test locked the wrong behavior.
  it.each(["failed", "stopped"])(
    "still refuses the first immediate arm of a %s run — that is not setup-success",
    async (status) => {
      store.readAgentRunById.mockResolvedValue(runInStatus(status));
      triggerStore.readRunTriggerByRunId.mockResolvedValue(null);

      const result = await setRunTriggerForActor(actor, {
        runId: TEST_RUN_ID,
        triggerType: "immediate",
      });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/already finished/i);
      expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
    },
  );

  it("refuses BEFORE any write — no trigger row, no schedule, no transition, no PM sync", async () => {
    store.readAgentRunById.mockResolvedValue(runInStatus("completed"));
    triggerStore.readRunTriggerByRunId.mockResolvedValue(existingImmediate);

    await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "immediate",
    });

    expect(triggerStore.createOrUpdateRunTrigger).not.toHaveBeenCalled();
    expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
    expect(store.transitionRunStatus).not.toHaveBeenCalled();
    expect(pm.syncRunTriggerPmTask).not.toHaveBeenCalled();
  });

  // cinatra#2523 (codex round-1 finding). `waiting_trigger` is an IN-FLIGHT run
  // paused at a TriggerWaitNode inside its own flow; the release job resumes it
  // through THIS trigger row. Refusing it late — after the cancel + upsert —
  // would cancel the scheduler that owns the resume and replace the row with an
  // immediate trigger that enqueues no release job, stranding a live run.
  it("refuses an immediate trigger on an in-flight waiting_trigger run BEFORE touching its schedule", async () => {
    store.readAgentRunById.mockResolvedValue(runInStatus("waiting_trigger"));
    triggerStore.readRunTriggerByRunId.mockResolvedValue({
      runId: TEST_RUN_ID,
      triggerType: "scheduled",
      jobSchedulerId: "sched-existing",
    });

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "immediate",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/paused at a trigger step/i);
    // Its existing schedule and row are untouched — the resume still owns them.
    expect(schedule.cancelTriggerSchedule).not.toHaveBeenCalled();
    expect(triggerStore.createOrUpdateRunTrigger).not.toHaveBeenCalled();
    expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
    expect(store.transitionRunStatus).not.toHaveBeenCalled();
    expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
  });

  it("does NOT gate a scheduled trigger on a finished run — that row is a future fire", async () => {
    store.readAgentRunById.mockResolvedValue(runInStatus("completed"));
    triggerStore.readRunTriggerByRunId.mockResolvedValue(existingImmediate);
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16);

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "scheduled",
      scheduledAt,
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    expect(schedule.scheduleTrigger).toHaveBeenCalledTimes(1);
  });

  // Codex round-B finding: converting a FINISHED immediate run to a recurring
  // schedule is legitimate — a recurring trigger clones a fresh run each fire.
  it("does NOT gate a recurring trigger on a finished, already-triggered run", async () => {
    store.readAgentRunById.mockResolvedValue(runInStatus("completed"));
    triggerStore.readRunTriggerByRunId.mockResolvedValue(existingImmediate);

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "recurring",
      cronExpression: "0 9 * * 1",
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    expect(schedule.scheduleTrigger).toHaveBeenCalledTimes(1);
  });

  it("leaves the ordinary immediate dispatch from pending_input untouched", async () => {
    store.readAgentRunById.mockResolvedValue(runInStatus("pending_input"));

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "immediate",
    });

    expect(result.ok).toBe(true);
    expect(schedule.scheduleTrigger).toHaveBeenCalledTimes(1);
    // cinatra#2523: the transition is now followed by a real enqueue — before
    // it, this path wrote a status and put nothing on any queue.
    expect(enqueue.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect(store.transitionRunStatus).toHaveBeenCalledWith(
      TEST_RUN_ID,
      "pending_input",
      "queued",
      undefined,
      expect.anything(),
      // cinatra#2485 C: the DISPATCHING actor rides the `→queued` guard.
      // `isOwnerOrAdmin` admits a non-owner admin, so `run_by` alone is not the
      // scope subject on this path.
      { actingUserId: TEST_USER_ID },
    );
  });
});
