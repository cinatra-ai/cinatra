/**
 * cinatra#3054 — a Stop that lands between the arm's claimed re-read and its
 * `pending_trigger → armed` compare-and-set, against a REAL store.
 *
 * THE WINDOW, exactly as the issue names it. The conversation card's Confirm
 * reaches the shared trigger setter through `armRunScheduleForActor`, which
 * re-asks "is this run still waiting?" INSIDE the trigger claim. The claim
 * serializes writers of the TRIGGER ROW; it does not lock the RUN's status
 * column, which a Stop legitimately moves. So a Stop can land after that claimed
 * re-read and before the compare-and-set — and it used to leave a trigger row
 * and a live scheduler behind on a stopped run, with the call reporting success.
 *
 * HOW THE INTERLEAVING IS FORCED — a deterministic seam, never a sleep. The
 * schedule registration is wrapped, so the test is handed control at exactly one
 * instruction that lies inside the window on the OLD code and the NEW alike, and
 * the REAL registration runs immediately after. The racing Stop is a real
 * `pending_trigger → stopped` transition through the real guarded primitive, and
 * it is AWAITED to commit before the arm is allowed to continue: the interleaving
 * is a fact about the database, not an elapsed interval. Everything else is
 * production code against a real Postgres and a real queue.
 *
 * The FIRST case is the one deterministic proof of the race invariant. The two
 * that follow are RESULT-PROPAGATION checks through the other two callers — the
 * run page's own scheduling step and the trigger MCP handler — and they drive
 * the same one seam rather than re-proving the race: the refusal exists exactly
 * for a run that moved out from under its arm, so that is the only state in
 * which their propagation can be read. The conversation card's Confirm and the
 * setter's own refusals are covered in the focused sibling
 * `trigger-arm-stale-status-3054.test.ts`, and the proposal installer in
 * `trigger-schedule-install-order.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// The seams. One-shot: each hook clears itself the first time it fires.
// ---------------------------------------------------------------------------
const seam = vi.hoisted(() => {
  const state: {
    onSchedule: (() => Promise<void>) | null;
    failNextCancel: boolean;
  } = { onSchedule: null, failNextCancel: false };
  return state;
});

vi.mock("../trigger-schedule", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../trigger-schedule")>();
  return {
    ...actual,
    scheduleTrigger: async (args: Parameters<typeof actual.scheduleTrigger>[0]) => {
      const hook = seam.onSchedule;
      if (hook) {
        seam.onSchedule = null;
        await hook();
      }
      return actual.scheduleTrigger(args);
    },
    cancelTriggerSchedule: async (
      args: Parameters<typeof actual.cancelTriggerSchedule>[0],
    ) => {
      if (seam.failNextCancel) {
        seam.failNextCancel = false;
        throw new Error("the queue could not be reached");
      }
      return actual.cancelTriggerSchedule(args);
    },
  };
});

// PARTIAL: only the session resolution the run page's action needs is faked.
// The rest of the module is real — the guarded run creation this suite uses
// resolves org roles through it.
vi.mock("@/lib/auth-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-session")>();
  return { ...actual, requireAuthSession: vi.fn() };
});

import { requireAuthSession } from "@/lib/auth-session";
import {
  armRunScheduleForActor,
  ARM_SCHEDULE_REFUSALS,
  type TriggerActorContext,
} from "../trigger-service";
import { setRunTrigger } from "../run-actions";
import { handleAgentRunTriggerSet } from "../mcp/handlers";
import { runAgentRunTriggerReleaseJob } from "../trigger-release-job";
import {
  createOrUpdateRunTrigger,
  readRunTriggerByRunId,
} from "../trigger-store";
import {
  createAgentRun,
  createAgentTemplate,
  readAgentRunById,
  transitionRunStatus,
} from "../store";
import { db, agentBuilderPool } from "../db";
import { agentRuns } from "../schema";
import { ensureBackgroundJobRuntime } from "@/lib/background-jobs";

const dbUrl = process.env.SUPABASE_DB_URL;
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";

// Ids unique to THIS file (never shared with a sibling integration suite).
const ORG = "org-3054-arm-postcondition";
const USER = "user-3054-owner";
const ACTOR: TriggerActorContext = { userId: USER, role: "owner", source: "ui" };
const AUTHORITY = { orgId: ORG, can: () => true };

let observer: Client;
const createdRunIds: string[] = [];
let TEMPLATE_ID = "";

/** A naive `datetime-local` a couple of hours out — what Confirm submits. */
function laterToday(): string {
  return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

function schedulerIdFor(runId: string): string {
  return `trigger-release-${runId}`;
}

/** Is a job that could still release this run sitting on the queue? */
async function liveSchedulerFor(runId: string): Promise<boolean> {
  const runtime = await ensureBackgroundJobRuntime();
  const job = await runtime.queue.getJob(schedulerIdFor(runId));
  return Boolean(job);
}

async function removeSchedulerFor(runId: string): Promise<void> {
  const runtime = await ensureBackgroundJobRuntime();
  const job = await runtime.queue.getJob(schedulerIdFor(runId)).catch(() => null);
  await job?.remove().catch(() => {});
}

/** A fresh run parked exactly where the card's Confirm finds one. */
async function runWaitingAtItsScheduleMoment(): Promise<string> {
  const id = `run-3054-${randomUUID()}`;
  await createAgentRun(
    {
      id,
      templateId: TEMPLATE_ID,
      inputParams: { hello: "world" },
      orgId: ORG,
      runBy: USER,
    },
    AUTHORITY,
  );
  createdRunIds.push(id);
  await transitionRunStatus(id, "queued", "pending_input", undefined, AUTHORITY);
  await transitionRunStatus(id, "pending_input", "pending_trigger", undefined, AUTHORITY);
  return id;
}

/** Arm THIS run's schedule with a real Stop landing in the window, and hand back
 *  what the surface under test answered. One seam, three surfaces. */
function stopLandsInTheWindow(runId: string): void {
  seam.onSchedule = async () => {
    await transitionRunStatus(runId, "pending_trigger", "stopped", undefined, AUTHORITY);
  };
}

async function executionEnqueues(): Promise<{
  spy: ReturnType<typeof vi.spyOn>;
  newRunIds: () => string[];
}> {
  const runtime = await ensureBackgroundJobRuntime();
  const spy = vi.spyOn(runtime.queue, "add");
  return {
    spy,
    newRunIds: () =>
      spy.mock.calls
        .filter(([name]) => name === "agent-builder-execution")
        .map(([, payload]) => (payload as { runId: string }).runId),
  };
}

beforeAll(async () => {
  if (!dbUrl) {
    throw new Error(
      "trigger-arm-stale-status-3054.integration.test.ts requires SUPABASE_DB_URL",
    );
  }
  observer = new Client({ connectionString: dbUrl });
  await observer.connect();
  await observer.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt")
     VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG, ORG, ORG],
  );
  await observer.query(
    `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
    [USER, USER, `${USER}@3054.test`],
  );
  await observer.query(
    `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, 'owner', now()) ON CONFLICT (id) DO NOTHING`,
    [`m-3054-${ORG}`, ORG, USER],
  );
  TEMPLATE_ID = `tmpl-3054-${randomUUID()}`;
  await createAgentTemplate({
    id: TEMPLATE_ID,
    name: "trigger arm postcondition fixture",
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
    packageName: `@test/${TEMPLATE_ID}`,
    orgId: ORG,
  });
}, 60_000);

afterAll(async () => {
  for (const id of createdRunIds) {
    await removeSchedulerFor(id);
    await db.delete(agentRuns).where(eq(agentRuns.id, id)).catch(() => {});
  }
  if (observer) {
    await observer
      .query(`DELETE FROM "${SCHEMA.replaceAll('"', '""')}"."agent_runs" WHERE org_id = $1`, [ORG])
      .catch(() => {});
    await observer.query(`DELETE FROM public."member" WHERE "userId" = $1`, [USER]).catch(() => {});
    await observer.query(`DELETE FROM public."user" WHERE id = $1`, [USER]).catch(() => {});
    await observer.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG]).catch(() => {});
    await observer.end().catch(() => {});
  }
  await agentBuilderPool.end().catch(() => {});
});

describe("cinatra#3054 — an arm whose run moved on leaves no live scheduler", () => {
  it("a Stop inside the window: the run stays stopped, no scheduler survives, and Confirm is refused", async () => {
    const runId = await runWaitingAtItsScheduleMoment();
    let stoppedAtTheSeam = false;

    seam.onSchedule = async () => {
      // THE WINDOW: the claimed re-read has already answered "still waiting",
      // and the compare-and-set has not run yet. The Stop lands HERE, and it is
      // committed before the arm is allowed to go on.
      await transitionRunStatus(runId, "pending_trigger", "stopped", undefined, AUTHORITY);
      stoppedAtTheSeam = (await readAgentRunById(runId))?.status === "stopped";
    };

    const result = await armRunScheduleForActor(ACTOR, {
      runId,
      schedule: { kind: "scheduled", runAt: laterToday(), timezone: "UTC" },
    });

    expect(stoppedAtTheSeam).toBe(true);
    // 1. The operation reports a refusal, and the reader-facing sentence is the
    //    one the card renders for a run that has moved on.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(ARM_SCHEDULE_REFUSALS.movedOn);
    // 2. The run is still stopped — the arm never wrote past the Stop.
    expect((await readAgentRunById(runId))?.status).toBe("stopped");
    // 3. No live scheduler remains, and no row is left that could name one.
    expect(await liveSchedulerFor(runId)).toBe(false);
    const row = await readRunTriggerByRunId(runId);
    expect(row?.jobSchedulerId ?? null).toBeNull();
  }, 90_000);

  it("when the scheduler cleanup itself fails, the durable state is pinned separately and is safe", async () => {
    const runId = await runWaitingAtItsScheduleMoment();
    seam.onSchedule = async () => {
      await transitionRunStatus(runId, "pending_trigger", "stopped", undefined, AUTHORITY);
    };
    seam.failNextCancel = true;

    const result = await armRunScheduleForActor(ACTOR, {
      runId,
      schedule: { kind: "scheduled", runAt: laterToday(), timezone: "UTC" },
    });

    expect(result.ok).toBe(false);
    expect((await readAgentRunById(runId))?.status).toBe("stopped");
    // The orphan the cancel could not take down is NAMEABLE and DEAD: the row
    // carries its id and reads stopped, so nothing reports the schedule as
    // armed and the first tick to arrive tears the scheduler down.
    const row = await readRunTriggerByRunId(runId);
    expect(row?.jobSchedulerId).toBe(schedulerIdFor(runId));
    expect(row?.stoppedAt).toBeInstanceOf(Date);
    expect(row?.enabled).toBe(false);

    // And the tick that does arrive releases nothing.
    const enqueues = await executionEnqueues();
    await runAgentRunTriggerReleaseJob({ runId }, "job-3054-orphan");
    expect(enqueues.newRunIds()).not.toContain(runId);
    expect((await readAgentRunById(runId))?.status).toBe("stopped");
    enqueues.spy.mockRestore();
  }, 90_000);

  it("the run page's scheduling step shows a refusal instead of a schedule it did not arm", async () => {
    const runId = await runWaitingAtItsScheduleMoment();
    stopLandsInTheWindow(runId);
    vi.mocked(requireAuthSession).mockResolvedValueOnce({
      user: { id: USER },
    } as Awaited<ReturnType<typeof requireAuthSession>>);

    const result = await setRunTrigger({
      runId,
      triggerType: "scheduled",
      scheduledAt: laterToday(),
      timezone: "UTC",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(ARM_SCHEDULE_REFUSALS.movedOn);
    expect(await liveSchedulerFor(runId)).toBe(false);
    expect((await readRunTriggerByRunId(runId))?.jobSchedulerId ?? null).toBeNull();
  }, 90_000);

  it("the trigger MCP handler returns an error instead of a runId", async () => {
    const runId = await runWaitingAtItsScheduleMoment();
    stopLandsInTheWindow(runId);

    const result = (await handleAgentRunTriggerSet({
      primitiveName: "agent_run_trigger_set",
      input: {
        runId,
        triggerType: "recurring",
        cronExpression: "0 9 * * 1",
        timezone: "UTC",
      },
      actor: { actorType: "user", source: "mcp", userId: USER },
      mode: "deterministic",
    } as unknown as Parameters<typeof handleAgentRunTriggerSet>[0])) as {
      runId?: string;
      jobSchedulerId?: string | null;
      error?: string;
    };

    expect(result.error).toBe(ARM_SCHEDULE_REFUSALS.movedOn);
    expect(result.runId).toBeUndefined();
    expect(await liveSchedulerFor(runId)).toBe(false);
  }, 90_000);

  it("the release job re-reads the run and enqueues nothing unless it is armed", async () => {
    // The defence in depth, pinned on its own: even with an enabled one-off row
    // in front of it — the residue this fix removes, or one left by a cleanup
    // that failed — the job releases nothing on a run that is not armed.
    const runId = await runWaitingAtItsScheduleMoment();
    await transitionRunStatus(runId, "pending_trigger", "stopped", undefined, AUTHORITY);
    await createOrUpdateRunTrigger({
      runId,
      triggerType: "scheduled",
      scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      cronExpression: null,
      timezone: "UTC",
      enabled: true,
      jobSchedulerId: schedulerIdFor(runId),
    });

    const enqueues = await executionEnqueues();
    await runAgentRunTriggerReleaseJob({ runId }, "job-3054-guard");

    expect(enqueues.newRunIds()).not.toContain(runId);
    expect((await readAgentRunById(runId))?.status).toBe("stopped");
    enqueues.spy.mockRestore();
  }, 90_000);
});
