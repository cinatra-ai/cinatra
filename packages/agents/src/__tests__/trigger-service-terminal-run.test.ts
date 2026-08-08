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
  transitionRunStatus: vi.fn(async () => undefined),
  RunTransitionError: class RunTransitionError extends Error {},
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

import { setRunTriggerForActor } from "../trigger-service";

const actor = { userId: TEST_USER_ID, source: "ui" as const };

function runInStatus(status: string) {
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

  // Codex round-B finding. Terminal status ALONE also describes cinatra#580's
  // genuine setup-success state: setup finished (`completed`), no trigger row
  // yet, the run view redirected the user here precisely so they could pick
  // one. Gating on it would hard-error the FIRST arm of every such run.
  it("does NOT gate the FIRST arm of a completed run with no trigger row (cinatra#580)", async () => {
    store.readAgentRunById.mockResolvedValue(runInStatus("completed"));
    triggerStore.readRunTriggerByRunId.mockResolvedValue(null);

    const result = await setRunTriggerForActor(actor, {
      runId: TEST_RUN_ID,
      triggerType: "immediate",
    });

    expect(result.ok).toBe(true);
    expect(schedule.scheduleTrigger).toHaveBeenCalledTimes(1);
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
    expect(store.transitionRunStatus).toHaveBeenCalledWith(
      TEST_RUN_ID,
      "pending_input",
      "queued",
      undefined,
      expect.anything(),
    );
  });
});
