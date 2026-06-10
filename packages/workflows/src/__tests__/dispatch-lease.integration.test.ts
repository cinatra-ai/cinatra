import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { createWorkflowFromSpec, readWorkflow } from "../store";
import { reconcileWorkflow, startWorkflow, buildExecutorRegistry } from "../engine";
import type { WorkflowSpec } from "../spec/schema";
import type { ExecutorInput } from "../engine/executors";

// Durable dispatch lease (issue: crash-mid-dispatch recovery). Covers:
//  - lease acquired with the claim (visible to the in-flight executor) and
//    released in the same tx as the outcome,
//  - reclaim of an EXPIRED lease: the SAME attempt is re-dispatched under its
//    original idempotency key (no new attempt, no duplicate child run) and the
//    child run id is persisted, after which the normal poll path completes it,
//  - a live (unexpired) lease is NOT reclaimed (in-flight dispatch),
//  - no lease at all is NOT reclaimed (legacy rows / executor-not-wired stay
//    on the findStuckTasks operator path).

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const ORG = "test-org-dispatch-lease";
const PAST = "2020-01-01T00:00:00Z";

async function pg() {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await c.connect();
  return c;
}

type LeaseRow = {
  id: string;
  task_id: string;
  attempt_id: string;
  holder_id: string;
  token: string;
  expires_at: Date;
};

async function leaseRows(workflowId: string): Promise<LeaseRow[]> {
  const c = await pg();
  const { rows } = await c.query(
    `SELECT id, task_id, attempt_id, holder_id, token, expires_at
     FROM "${SCHEMA}"."workflow_dispatch_lease" WHERE workflow_id = $1`,
    [workflowId],
  );
  await c.end();
  return rows;
}

async function attemptForTask(
  workflowId: string,
  taskKey: string,
): Promise<{ id: string; attempt_no: number; idempotency_key: string; status: string; child_run_id: string | null }> {
  const c = await pg();
  const { rows } = await c.query(
    `SELECT a.id, a.attempt_no, a.idempotency_key, a.status, a.child_run_id
     FROM "${SCHEMA}"."workflow_task_attempt" a
     JOIN "${SCHEMA}"."workflow_task" t ON t.id = a.task_id
     WHERE a.workflow_id = $1 AND t.key = $2
     ORDER BY a.attempt_no DESC LIMIT 1`,
    [workflowId, taskKey],
  );
  await c.end();
  return rows[0];
}

async function attemptCountForTask(workflowId: string, taskKey: string): Promise<number> {
  const c = await pg();
  const { rows } = await c.query(
    `SELECT count(a.id)::int AS n
     FROM "${SCHEMA}"."workflow_task_attempt" a
     JOIN "${SCHEMA}"."workflow_task" t ON t.id = a.task_id
     WHERE a.workflow_id = $1 AND t.key = $2`,
    [workflowId, taskKey],
  );
  await c.end();
  return Number(rows[0]?.n ?? 0);
}

async function eventCountOfKind(workflowId: string, kind: string): Promise<number> {
  const c = await pg();
  const { rows } = await c.query(
    `SELECT count(*)::int AS n FROM "${SCHEMA}"."workflow_event" WHERE workflow_id = $1 AND kind = $2`,
    [workflowId, kind],
  );
  await c.end();
  return Number(rows[0]?.n ?? 0);
}

async function taskIdOf(workflowId: string, taskKey: string): Promise<string> {
  const c = await pg();
  const { rows } = await c.query(
    `SELECT id FROM "${SCHEMA}"."workflow_task" WHERE workflow_id = $1 AND key = $2`,
    [workflowId, taskKey],
  );
  await c.end();
  return rows[0].id;
}

/** Fabricate the crash-mid-dispatch state for task `a` of `workflowId`: the
 *  claim committed (attempt running, task running) but the dispatcher died
 *  before recordOutcomes — child_run_id never persisted, lease never released.
 *  `expiresAt` controls whether the fabricated lease reads as lapsed. */
async function fabricateCrash(
  workflowId: string,
  taskKey: string,
  opts: { expiresAt: Date | null; at: Date },
): Promise<void> {
  const c = await pg();
  const taskId = (
    await c.query(`SELECT id FROM "${SCHEMA}"."workflow_task" WHERE workflow_id = $1 AND key = $2`, [
      workflowId,
      taskKey,
    ])
  ).rows[0].id as string;
  const attemptId = (
    await c.query(
      `SELECT id FROM "${SCHEMA}"."workflow_task_attempt" WHERE workflow_id = $1 AND task_id = $2 ORDER BY attempt_no DESC LIMIT 1`,
      [workflowId, taskId],
    )
  ).rows[0].id as string;
  // The crash happened before the child run id was recorded.
  await c.query(`UPDATE "${SCHEMA}"."workflow_task_attempt" SET child_run_id = NULL WHERE id = $1`, [attemptId]);
  // ...and before the lease was released (the normal outcome path deleted it,
  // so re-insert the dead dispatcher's lease).
  await c.query(`DELETE FROM "${SCHEMA}"."workflow_dispatch_lease" WHERE task_id = $1`, [taskId]);
  if (opts.expiresAt) {
    await c.query(
      `INSERT INTO "${SCHEMA}"."workflow_dispatch_lease"
       (id, workflow_id, task_id, attempt_id, holder_id, token, acquired_at, heartbeat_at, expires_at)
       VALUES ($1, $2, $3, $4, 'wfproc_dead', 'token-of-dead-dispatcher', $5, $5, $6)`,
      [`wlease_test_${Math.random().toString(36).slice(2)}`, workflowId, taskId, attemptId, opts.at, opts.expiresAt],
    );
  }
  await c.end();
}

async function start(spec: WorkflowSpec) {
  const { workflowId } = await createWorkflowFromSpec({ spec, name: spec.name, orgId: ORG });
  const s = await startWorkflow(workflowId, { skipStartValid: true });
  expect(s.ok, JSON.stringify(s)).toBe(true);
  return workflowId;
}

const statusByKey = async (wfId: string) => {
  const r = await readWorkflow(wfId);
  return Object.fromEntries(r!.tasks.map((t) => [t.key, t.status]));
};

const agentSpec = (name: string): WorkflowSpec =>
  ({
    name,
    target: { at: PAST, tz: "UTC" },
    tasks: [
      { key: "a", type: "agent_task", title: "A", agentRef: { package: "p" } },
      { key: "b", type: "checkpoint", title: "B", dependsOn: [{ taskKey: "a" }] },
    ],
  }) as WorkflowSpec;

/** agent_task executor that records every dispatch input and derives the
 *  child run id from the idempotency key — the same contract as the host
 *  executor (same attempt → same key → same child run). */
function recordingExecutors(calls: ExecutorInput[]) {
  return buildExecutorRegistry({
    agent_task: (input) => {
      calls.push(input);
      return { status: "running", childRunId: `child:${input.idempotencyKey}` };
    },
  });
}

beforeAll(async () => {
  const c = await pg();
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) await c.query(q.text);
  await c.query(`DROP INDEX IF EXISTS "${SCHEMA}"."workflow_template_key_version_uniq"`);
  await c.query(`DELETE FROM "${SCHEMA}"."workflow" WHERE org_id = $1`, [ORG]);
  await c.end();
}, 60_000);

describe("durable dispatch lease (integration)", () => {
  it("acquires the lease with the claim (visible in flight) and releases it with the outcome", async () => {
    const inFlightLeases: LeaseRow[][] = [];
    const wfIdBox: { id?: string } = {};
    const executors = buildExecutorRegistry({
      agent_task: async (input) => {
        // The claim tx committed before dispatch — the lease must be live now.
        inFlightLeases.push(await leaseRows(wfIdBox.id!));
        return { status: "running", childRunId: `child:${input.idempotencyKey}` };
      },
    });
    const wfId = await start(agentSpec("LeaseLifecycle"));
    wfIdBox.id = wfId;
    const t0 = new Date("2026-06-01T00:00:00Z");
    await reconcileWorkflow(wfId, { executors, now: () => t0 });

    // In flight: exactly one lease, bound to task `a`'s attempt, unexpired.
    expect(inFlightLeases).toHaveLength(1);
    expect(inFlightLeases[0]).toHaveLength(1);
    const lease = inFlightLeases[0][0];
    expect(lease.task_id).toBe(await taskIdOf(wfId, "a"));
    expect(new Date(lease.expires_at).getTime()).toBeGreaterThan(t0.getTime());

    // Settled: the outcome tx released the lease; the child run id persisted.
    expect(await leaseRows(wfId)).toHaveLength(0);
    expect((await attemptForTask(wfId, "a")).child_run_id).toBe(`child:${wfId}:${lease.task_id}:1`);
  });

  it("reclaims an expired lease: re-dispatches the SAME attempt under its original idempotency key", async () => {
    const calls: ExecutorInput[] = [];
    const executors = recordingExecutors(calls);
    const wfId = await start(agentSpec("LeaseReclaim"));
    const t0 = new Date("2026-06-01T00:00:00Z");
    await reconcileWorkflow(wfId, { executors, now: () => t0 });
    expect(calls).toHaveLength(1);
    const firstKey = calls[0].idempotencyKey;
    expect((await statusByKey(wfId)).a).toBe("running");

    // The dispatcher crashed mid-dispatch; its lease lapses.
    await fabricateCrash(wfId, "a", { at: t0, expiresAt: new Date(t0.getTime() + 1000) });
    expect((await attemptForTask(wfId, "a")).child_run_id).toBeNull();

    // Next tick, past the lease expiry: reclaim + same-attempt re-dispatch.
    const t1 = new Date(t0.getTime() + 5 * 60_000);
    await reconcileWorkflow(wfId, { executors, now: () => t1 });
    expect(calls).toHaveLength(2);
    expect(calls[1].idempotencyKey).toBe(firstKey); // SAME key → same child run
    expect(calls[1].attemptNo).toBe(1); // no retry-budget burn
    expect(await attemptCountForTask(wfId, "a")).toBe(1); // no new attempt row
    const attempt = await attemptForTask(wfId, "a");
    expect(attempt.status).toBe("running");
    expect(attempt.child_run_id).toBe(`child:${firstKey}`); // child id repaired
    expect(await eventCountOfKind(wfId, "dispatch_reclaimed")).toBe(1);
    expect(await leaseRows(wfId)).toHaveLength(0); // reclaimer released it too

    // The recovered task settles through the normal poll path.
    const getChildRunStatus = async () => ({ status: "completed", terminal: true, failed: false, hitl: false });
    const res = await reconcileWorkflow(wfId, { executors, getChildRunStatus, now: () => t1 });
    expect(res.status).toBe("completed");
    expect(await statusByKey(wfId)).toEqual({ a: "succeeded", b: "succeeded" });
    expect(await attemptCountForTask(wfId, "a")).toBe(1); // still a single child dispatch
  });

  it("does NOT reclaim a live (unexpired) lease — that is an in-flight dispatch", async () => {
    const calls: ExecutorInput[] = [];
    const executors = recordingExecutors(calls);
    const wfId = await start(agentSpec("LeaseLive"));
    const t0 = new Date("2026-06-01T00:00:00Z");
    await reconcileWorkflow(wfId, { executors, now: () => t0 });
    expect(calls).toHaveLength(1);

    // Crash state, but the (slow) dispatcher's heartbeat keeps the lease alive.
    // Lease liveness is WALL-time (heartbeats run on the wall clock), so the
    // fabricated expiry must be wall-relative, not logical-now-relative.
    const t1 = new Date(t0.getTime() + 5 * 60_000);
    await fabricateCrash(wfId, "a", { at: t0, expiresAt: new Date(Date.now() + 60 * 60_000) });

    await reconcileWorkflow(wfId, { executors, now: () => t1 });
    expect(calls).toHaveLength(1); // no re-dispatch
    expect((await attemptForTask(wfId, "a")).child_run_id).toBeNull(); // untouched
    expect((await statusByKey(wfId)).a).toBe("running");
    expect(await eventCountOfKind(wfId, "dispatch_reclaimed")).toBe(0);
  });

  it("drops a stale dispatcher's outcome once its lease is taken over (token rotated)", async () => {
    // The recordOutcomes ownership gate: a dispatcher that lost its lease to a
    // reclaimer (token rotated) is presumed dead — its late outcome must be
    // dropped, or a stale `failed` would burn the retry budget while the
    // reclaimer's re-dispatch is live.
    const wfId = await start(agentSpec("LeaseStaleOutcome"));
    const rotateThenFail = buildExecutorRegistry({
      agent_task: async () => {
        // Simulate a concurrent reclaim landing while this dispatch is in
        // flight: another process rotated the lease token.
        const c = await pg();
        await c.query(
          `UPDATE "${SCHEMA}"."workflow_dispatch_lease" SET token = 'token-of-reclaimer', holder_id = 'wfproc_other' WHERE workflow_id = $1`,
          [wfId],
        );
        await c.end();
        return { status: "failed" as const, error: { message: "stale boom" } };
      },
    });
    const t0 = new Date("2026-06-01T00:00:00Z");
    await reconcileWorkflow(wfId, { executors: rotateThenFail, now: () => t0 });

    // The stale `failed` was dropped: no attempt settle, no retry/dead-letter,
    // and the reclaimer's lease is left untouched.
    const attempt = await attemptForTask(wfId, "a");
    expect(attempt.status).toBe("running");
    expect(attempt.child_run_id).toBeNull();
    expect(await attemptCountForTask(wfId, "a")).toBe(1);
    expect((await statusByKey(wfId)).a).toBe("running");
    expect(await eventCountOfKind(wfId, "retry_scheduled")).toBe(0);
    expect(await eventCountOfKind(wfId, "dead_lettered")).toBe(0);
    const leases = await leaseRows(wfId);
    expect(leases).toHaveLength(1);
    expect(leases[0].token).toBe("token-of-reclaimer");

    // The task is NOT stranded: once the reclaimer's lease lapses in turn, the
    // normal reclaim path re-dispatches the same attempt and recovery proceeds.
    // Lease liveness is wall-time, so lapse the rotated lease explicitly (the
    // simulated reclaimer died too and stopped heartbeating).
    const cExpire = await pg();
    await cExpire.query(
      `UPDATE "${SCHEMA}"."workflow_dispatch_lease" SET expires_at = now() - interval '1 second' WHERE workflow_id = $1`,
      [wfId],
    );
    await cExpire.end();
    const calls: ExecutorInput[] = [];
    const t1 = new Date(t0.getTime() + 60 * 60_000); // far past the lease TTL
    await reconcileWorkflow(wfId, { executors: recordingExecutors(calls), now: () => t1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].attemptNo).toBe(1); // same attempt, same key
    expect((await attemptForTask(wfId, "a")).child_run_id).toBe(`child:${calls[0].idempotencyKey}`);
    expect(await eventCountOfKind(wfId, "dispatch_reclaimed")).toBe(1);
  });

  it("does NOT reclaim without a lease — legacy rows stay on the operator path", async () => {
    const calls: ExecutorInput[] = [];
    const executors = recordingExecutors(calls);
    const wfId = await start(agentSpec("LeaseMissing"));
    const t0 = new Date("2026-06-01T00:00:00Z");
    await reconcileWorkflow(wfId, { executors, now: () => t0 });
    expect(calls).toHaveLength(1);

    // Pre-lease legacy shape: running attempt, NULL child run id, no lease row.
    await fabricateCrash(wfId, "a", { at: t0, expiresAt: null });

    const t1 = new Date(t0.getTime() + 60 * 60_000);
    await reconcileWorkflow(wfId, { executors, now: () => t1 });
    expect(calls).toHaveLength(1); // no re-dispatch
    expect((await statusByKey(wfId)).a).toBe("running"); // surfaced by findStuckTasks instead
    expect(await eventCountOfKind(wfId, "dispatch_reclaimed")).toBe(0);
  });
});
