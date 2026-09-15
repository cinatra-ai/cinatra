/**
 * cinatra#2981 — stop, save and the release tick share ONE serialization.
 *
 * Three race windows, one shape: a write that reads the trigger row, decides,
 * and only later commits, racing **Cancel schedule**. This suite drives each of
 * them deterministically and asserts the property the serialization owes.
 *
 * HOW THE INTERLEAVING IS FORCED — no timing sleeps drive correctness.
 *   · A SEAM inside the racing writer: `launchAgentRun` (window a) and
 *     `cancelTriggerSchedule` (windows b and c) are wrapped so the test is
 *     handed control at exactly the instruction the issue names, and the REAL
 *     implementation runs immediately after. Nothing else is faked: the run
 *     rows, the trigger rows, the guards, the release job and the trigger
 *     service are all the production code, against a real Postgres schema.
 *   · The racing stop is the REAL `stopRecurringTriggerForActor` — both of its
 *     steps, the DB stamp and the best-effort scheduler cancel.
 *   · The test then waits until the stop has either COMMITTED or is provably
 *     BLOCKED — read out of `pg_stat_activity` (`wait_event_type = 'Lock'`),
 *     a fact about the database, not an elapsed interval. Which of the two
 *     happens is itself the difference the fix makes, and the assertions read
 *     the persisted rows either way.
 *
 * WHAT A CLAIM CAN AND CANNOT PROMISE, stated here because window (a)'s
 * assertion is shaped by it. Serialization makes a stop TOTAL FROM THE INSTANT
 * IT COMMITS: no fire proceeds under a stop that is already committed, and a
 * stop that arrives while a tick holds the claim commits after that tick's copy
 * — it does not reach back and un-launch it. That is the strongest property
 * available to any mechanism (the alternative would have to abort work already
 * done), so window (a) asserts exactly it: at every launch, the stop stamp was
 * not yet visible. Today's code violates it — the stop commits in the gap the
 * job's own comment names, and the tick launches anyway.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// The seams. One-shot: each hook clears itself the first time it fires, so the
// racing stop's OWN cancel is never intercepted by the save's seam.
// ---------------------------------------------------------------------------
const seam = vi.hoisted(() => {
  const state: {
    onLaunch: (() => Promise<void>) | null;
    onCancelSchedule: (() => Promise<void>) | null;
  } = { onLaunch: null, onCancelSchedule: null };
  return state;
});

vi.mock("../lifecycle-coordinator", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lifecycle-coordinator")>();
  return {
    ...actual,
    launchAgentRun: async (
      input: Parameters<typeof actual.launchAgentRun>[0],
    ) => {
      const hook = seam.onLaunch;
      if (hook) {
        seam.onLaunch = null;
        await hook();
      }
      return actual.launchAgentRun(input);
    },
  };
});

vi.mock("../trigger-schedule", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../trigger-schedule")>();
  return {
    ...actual,
    cancelTriggerSchedule: async (
      args: Parameters<typeof actual.cancelTriggerSchedule>[0],
    ) => {
      const hook = seam.onCancelSchedule;
      if (hook) {
        seam.onCancelSchedule = null;
        await hook();
      }
      return actual.cancelTriggerSchedule(args);
    },
  };
});

import { runAgentRunTriggerReleaseJob } from "../trigger-release-job";
import {
  stopRecurringTriggerForActor,
  updateRunTriggerScheduleForActor,
  type TriggerActorContext,
} from "../trigger-service";
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
import { agentRuns, agentRunTriggers } from "../schema";
import type { RecurringConfig } from "../trigger-recurrence";
import { TRIGGER_CLAIM_NAMESPACE } from "../trigger-claim";
import { ensureBackgroundJobRuntime } from "@/lib/background-jobs";

const dbUrl = process.env.SUPABASE_DB_URL;
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";

// Ids unique to THIS file (never shared with a sibling integration suite).
const ORG = "org-2981-serialization";
const USER = "user-2981-owner";
const ACTOR: TriggerActorContext = { userId: USER, role: "owner" };

/** The one long-lived observer connection. Its only job is to read facts about
 *  OTHER backends (who is waiting on a lock) and the committed row, from
 *  outside every transaction under test. */
let observer: Client;

async function observe<T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await observer.query<T>(text, values)).rows;
}

/** TRUE when a backend is waiting on THIS run's trigger claim — the exact
 *  two-int advisory key `withTriggerClaim` takes, read out of `pg_locks`, never
 *  "some lock somewhere". A suite running beside this one, or an unrelated wait
 *  on the same table, cannot make it answer true, so the interleaving cannot be
 *  satisfied by an accident. */
async function claimHeldAgainst(runId: string): Promise<boolean> {
  const rows = await observe<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND classid = hashtext($1)::oid
        AND objid = hashtext($2)::oid
        AND objsubid = 2
        AND NOT granted`,
    [TRIGGER_CLAIM_NAMESPACE, runId],
  );
  return Number(rows[0]?.n ?? "0") > 0;
}

/** The committed stop stamp, read outside every transaction under test. */
async function committedStopStamp(runId: string): Promise<string | null> {
  const rows = await observe<{ stopped_at: Date | null }>(
    `SELECT stopped_at FROM "${SCHEMA.replaceAll('"', '""')}"."agent_run_triggers" WHERE run_id = $1`,
    [runId],
  );
  const stamp = rows[0]?.stopped_at ?? null;
  return stamp === null ? null : new Date(stamp).toISOString();
}

type Settling = { settled: boolean };

/** Wait until the racing writer has COMMITTED or is provably BLOCKED. Bounded
 *  and terminal: it throws rather than passing vacuously if the interleaving
 *  never happened. */
async function untilCommittedOrHeld(
  state: Settling,
  runId: string,
): Promise<"committed" | "held"> {
  for (let i = 0; i < 600; i++) {
    if (state.settled) return "committed";
    if (await claimHeldAgainst(runId)) return "held";
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    "the racing stop neither committed nor blocked within 15s — the interleaving under test never happened",
  );
}

function track<T>(promise: Promise<T>): { promise: Promise<T>; state: Settling } {
  const state: Settling = { settled: false };
  const settle = () => {
    state.settled = true;
  };
  promise.then(settle, settle);
  return { promise, state };
}

const createdRunIds: string[] = [];
/** One real template row for the whole file — `createAgentRun`'s scope guard
 *  refuses a run whose template does not exist (`unknown_scope`). */
let TEMPLATE_ID = "";

async function fixtureRun(): Promise<string> {
  const id = `run-2981-${randomUUID()}`;
  await createAgentRun(
    {
      id,
      templateId: TEMPLATE_ID,
      inputParams: { hello: "world" },
      orgId: ORG,
      runBy: USER,
    },
    { orgId: ORG, can: () => true },
  );
  createdRunIds.push(id);
  return id;
}

/** A recurring schedule that has already fired once — the only shape
 *  **Cancel schedule** is defined for. */
async function firedRecurringSchedule(runId: string): Promise<void> {
  await createOrUpdateRunTrigger({
    runId,
    triggerType: "recurring",
    cronExpression: "0 9 * * MON",
    timezone: "UTC",
    enabled: true,
    jobSchedulerId: `trigger-release-${runId}`,
  });
  await db
    .update(agentRunTriggers)
    .set({ lastFiredAt: new Date(Date.now() - 60_000) })
    .where(eq(agentRunTriggers.runId, runId));
}

const WEEKLY: RecurringConfig = {
  frequency: "weekly",
  interval: 1,
  weekdays: [2],
  dayOfMonth: 1,
  monthlyMode: "date",
  nthWeek: 1,
  monthlyWeekday: 1,
  quarterAnchor: "start",
  yearlyMonth: 1,
  hour: 10,
  minute: 30,
};

/** A naive `datetime-local` string a couple of hours out, which is what the
 *  save form submits for "Schedule for later". */
function laterToday(): string {
  return new Date(Date.now() + 2 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 16);
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
      "trigger-stop-save-tick-serialization.integration.test.ts requires SUPABASE_DB_URL",
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
    [USER, USER, `${USER}@2981.test`],
  );
  await observer.query(
    `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, 'owner', now()) ON CONFLICT (id) DO NOTHING`,
    [`m-2981-${ORG}`, ORG, USER],
  );
  TEMPLATE_ID = `tmpl-2981-${randomUUID()}`;
  await createAgentTemplate({
    id: TEMPLATE_ID,
    name: "trigger serialization fixture",
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

describe("cinatra#2981 — stop, save and the release tick serialize on the trigger row", () => {
  // -------------------------------------------------------------------------
  // WINDOW (a) — a stop landing between the tick's fire decision and its launch
  // -------------------------------------------------------------------------
  it("window (a): a recurring tick never launches a copy under a stop that has already committed", async () => {
    const runId = await fixtureRun();
    await firedRecurringSchedule(runId);
    const enqueues = await executionEnqueues();

    let stopStampAtLaunch: string | null = null;
    let launches = 0;
    let racing: { promise: Promise<{ ok: boolean }>; state: Settling } | null = null;

    seam.onLaunch = async () => {
      // THE WINDOW, exactly as the issue names it: the tick has finished its
      // pre-flight and decided to fire; the stop is pressed HERE.
      racing = track(stopRecurringTriggerForActor(ACTOR, { runId }));
      await untilCommittedOrHeld(racing.state, runId);
      stopStampAtLaunch = await committedStopStamp(runId);
      launches += 1;
    };

    await runAgentRunTriggerReleaseJob({ runId }, "job-2981-a");
    expect(racing).not.toBeNull();
    const stopResult = await racing!.promise;

    // THE SAFETY PROPERTY. A launch that proceeds while the stop stamp is
    // already committed is a run started after the person was told the
    // schedule had stopped. Today's code does exactly that.
    expect(launches).toBe(1);
    expect(stopStampAtLaunch).toBeNull();

    // …and the stop is honoured, whichever side of the claim it fell on.
    expect(stopResult.ok).toBe(true);
    const stopped = await readRunTriggerByRunId(runId);
    expect(stopped?.stoppedAt).toBeInstanceOf(Date);
    expect(stopped?.enabled).toBe(false);

    // No later tick fires under the stopped schedule.
    const before = enqueues.newRunIds().length;
    await runAgentRunTriggerReleaseJob({ runId }, "job-2981-a2");
    expect(enqueues.newRunIds().length).toBe(before);
    for (const id of enqueues.newRunIds()) {
      if (id !== runId) createdRunIds.push(id);
    }
    enqueues.spy.mockRestore();
  }, 90_000);

  // -------------------------------------------------------------------------
  // WINDOW (b) — a recurring→recurring save racing the stop
  // -------------------------------------------------------------------------
  it("window (b): a same-kind save cannot leave a stopped schedule enabled, and nothing fires under the retained scheduler id", async () => {
    const runId = await fixtureRun();
    await firedRecurringSchedule(runId);
    const enqueues = await executionEnqueues();

    let racing: { promise: Promise<{ ok: boolean }>; state: Settling } | null = null;
    seam.onCancelSchedule = async () => {
      // The save has re-asked its guard and is about to cancel-and-upsert.
      racing = track(stopRecurringTriggerForActor(ACTOR, { runId }));
      await untilCommittedOrHeld(racing.state, runId);
    };

    await updateRunTriggerScheduleForActor(ACTOR, {
      runId,
      schedule: { kind: "recurring", selection: WEEKLY, timezone: "UTC" },
    });
    expect(racing).not.toBeNull();
    await racing!.promise;

    // THE STOP STAMP WINS. A row left `enabled: true` under a committed stop is
    // a revived schedule — the state window (c) then fires from.
    const after = await readRunTriggerByRunId(runId);
    expect(after?.stoppedAt).toBeInstanceOf(Date);
    expect(after?.enabled).toBe(false);

    // The acceptance's own reading: the scheduler id is deliberately retained,
    // so the assertion is that nothing fires under it — and the stamp still
    // stands once a tick has run.
    const before = enqueues.newRunIds().length;
    await runAgentRunTriggerReleaseJob({ runId }, "job-2981-b");
    expect(enqueues.newRunIds().length).toBe(before);
    const settled = await readRunTriggerByRunId(runId);
    expect(settled?.stoppedAt).toBeInstanceOf(Date);
    enqueues.spy.mockRestore();
  }, 90_000);

  // -------------------------------------------------------------------------
  // WINDOW (c) — a recurring→scheduled save racing the stop, and the one-off
  // branch's missing stopped_at check
  // -------------------------------------------------------------------------
  it("window (c): a cross-kind save racing a stop never leaves a run the one-off branch will fire", async () => {
    const runId = await fixtureRun();
    await firedRecurringSchedule(runId);
    await transitionRunStatus(runId, "queued", "pending_input", undefined, {
      orgId: ORG,
      can: () => true,
    });
    await transitionRunStatus(runId, "pending_input", "armed", undefined, {
      orgId: ORG,
      can: () => true,
    });
    const enqueues = await executionEnqueues();

    let racing: { promise: Promise<{ ok: boolean }>; state: Settling } | null = null;
    seam.onCancelSchedule = async () => {
      racing = track(stopRecurringTriggerForActor(ACTOR, { runId }));
      await untilCommittedOrHeld(racing.state, runId);
    };

    await updateRunTriggerScheduleForActor(ACTOR, {
      runId,
      schedule: { kind: "scheduled", runAt: laterToday(), timezone: "UTC" },
    });
    expect(racing).not.toBeNull();
    await racing!.promise;

    // The delayed job fires. The run must NOT be released or dispatched: it was
    // never itself stopped, only its schedule was, and the schedule is stopped.
    await runAgentRunTriggerReleaseJob({ runId }, "job-2981-c");
    expect((await readAgentRunById(runId))?.status).toBe("armed");
    expect(enqueues.newRunIds()).not.toContain(runId);
    expect((await readRunTriggerByRunId(runId))?.releasedAt).toBeNull();

    const after = await readRunTriggerByRunId(runId);
    expect(after?.stoppedAt).toBeInstanceOf(Date);
    expect(after?.enabled).toBe(false);

    // AND THE SHAPE ITSELF, built directly: a one-off row that is enabled and
    // stopped at once — what a cross-kind save leaves behind. The one-off
    // branch has to refuse it on `stopped_at` alone.
    const direct = await fixtureRun();
    await createOrUpdateRunTrigger({
      runId: direct,
      triggerType: "scheduled",
      scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      timezone: "UTC",
      enabled: true,
      jobSchedulerId: `trigger-release-${direct}`,
    });
    await db
      .update(agentRunTriggers)
      .set({ stoppedAt: new Date() })
      .where(eq(agentRunTriggers.runId, direct));
    await transitionRunStatus(direct, "queued", "pending_input", undefined, {
      orgId: ORG,
      can: () => true,
    });
    await transitionRunStatus(direct, "pending_input", "armed", undefined, {
      orgId: ORG,
      can: () => true,
    });

    await runAgentRunTriggerReleaseJob({ runId: direct }, "job-2981-c2");
    expect(enqueues.newRunIds()).not.toContain(direct);
    expect((await readAgentRunById(direct))?.status).toBe("armed");
    expect((await readRunTriggerByRunId(direct))?.releasedAt).toBeNull();
    enqueues.spy.mockRestore();
  }, 90_000);
});
