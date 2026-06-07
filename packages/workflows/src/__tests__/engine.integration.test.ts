import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import {
  createWorkflowFromSpec,
  readWorkflow,
  decideWorkflowApproval,
  listPendingApprovalsForOrg,
  updateWorkflowDraftSpec,
  reconstructSpec,
  applyWorkflowTaskWindow,
  rescheduleWorkflow,
  deleteWorkflowTask,
} from "../store";
import {
  reconcileWorkflow,
  startWorkflow,
  pauseWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  markManualDone,
  buildExecutorRegistry,
} from "../engine";
import type { WorkflowSpec } from "../spec/schema";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const ORG = "test-org-engine";
const PAST = "2020-01-01T00:00:00Z";

async function pg() {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await c.connect();
  return c;
}

async function attemptCount(workflowId: string): Promise<Record<string, number>> {
  const c = await pg();
  const { rows } = await c.query(
    `SELECT t.key, count(a.id)::int AS n
     FROM "${SCHEMA}"."workflow_task" t
     LEFT JOIN "${SCHEMA}"."workflow_task_attempt" a ON a.task_id = t.id
     WHERE t.workflow_id = $1 GROUP BY t.key`,
    [workflowId],
  );
  await c.end();
  return Object.fromEntries(rows.map((r) => [r.key, Number(r.n)]));
}

async function artifactsForTask(workflowId: string, taskKey: string): Promise<{ kind: string; ref: string }[]> {
  const c = await pg();
  const { rows } = await c.query(
    `SELECT ar.kind, ar.ref FROM "${SCHEMA}"."workflow_artifact" ar
     JOIN "${SCHEMA}"."workflow_task" t ON t.id = ar.task_id
     WHERE ar.workflow_id = $1 AND t.key = $2`,
    [workflowId, taskKey],
  );
  await c.end();
  return rows.map((r) => ({ kind: r.kind, ref: r.ref }));
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

async function approvalForTask(workflowId: string, taskKey: string): Promise<{ id: string; status: string }> {
  const c = await pg();
  const { rows } = await c.query(
    `SELECT ap.id, ap.status FROM "${SCHEMA}"."workflow_approval" ap
     JOIN "${SCHEMA}"."workflow_task" t ON t.id = ap.task_id
     WHERE ap.workflow_id = $1 AND t.key = $2`,
    [workflowId, taskKey],
  );
  await c.end();
  return rows[0];
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

beforeAll(async () => {
  const c = await pg();
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) await c.query(q.text);
  await c.query(`DROP INDEX IF EXISTS "${SCHEMA}"."workflow_template_key_version_uniq"`);
  await c.query(`DELETE FROM "${SCHEMA}"."workflow" WHERE org_id = $1`, [ORG]);
  await c.end();
}, 60_000);

describe("durable engine (integration)", () => {
  it("runs a non-agent workflow to completion", async () => {
    const spec: WorkflowSpec = {
      name: "Completing",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "a", type: "checkpoint", title: "A" },
        { key: "b", type: "wait", title: "B", dependsOn: [{ taskKey: "a" }] },
        { key: "c", type: "notification", title: "C", message: "done", dependsOn: [{ taskKey: "b" }] },
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    const res = await reconcileWorkflow(wfId, { now: () => new Date() });
    expect(res.status).toBe("completed");
    expect(await statusByKey(wfId)).toEqual({ a: "succeeded", b: "succeeded", c: "succeeded" });
    // exactly one attempt per task (no double-dispatch)
    expect(await attemptCount(wfId)).toEqual({ a: 1, b: 1, c: 1 });
  });

  it("does not double-dispatch a running (manual) task across ticks", async () => {
    const spec: WorkflowSpec = {
      name: "Manual",
      target: { at: PAST, tz: "UTC" },
      tasks: [{ key: "m", type: "manual", title: "Approve copy" }],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId); // dispatches m → running (awaiting human)
    await reconcileWorkflow(wfId); // m still running → not re-claimed
    expect((await statusByKey(wfId)).m).toBe("running");
    expect((await attemptCount(wfId)).m).toBe(1); // single attempt despite 2 ticks
    // human completes it → workflow finishes
    const r = await readWorkflow(wfId);
    const mId = r!.tasks.find((t) => t.key === "m")!.id;
    const done = await markManualDone(mId, { actorId: "user-x" });
    expect(done.ok).toBe(true);
    expect((await readWorkflow(wfId))!.workflow.status).toBe("completed");
  });

  it("retries then dead-letters a failing task and fails the workflow (block policy)", async () => {
    const spec: WorkflowSpec = {
      name: "Failing",
      target: { at: PAST, tz: "UTC" },
      tasks: [{ key: "x", type: "agent_task", title: "X", agentRef: { package: "p" }, maxAttempts: 2 }],
    } as WorkflowSpec;
    const wfId = await start(spec);
    const executors = buildExecutorRegistry({ agent_task: () => ({ status: "failed", error: { message: "boom" } }) });
    const t0 = new Date("2026-06-01T00:00:00Z");
    await reconcileWorkflow(wfId, { executors, now: () => t0 }); // attempt 1 fails → retry scheduled
    expect((await statusByKey(wfId)).x).toBe("scheduled");
    const t1 = new Date(t0.getTime() + 5 * 60_000); // past the backoff
    const res = await reconcileWorkflow(wfId, { executors, now: () => t1 }); // attempt 2 fails → dead-letter
    expect((await statusByKey(wfId)).x).toBe("failed");
    expect((await attemptCount(wfId)).x).toBe(2);
    expect(res.status).toBe("failed"); // block-policy required failure
  });

  it("skip-propagates downstream when an upstream fails with skip policy", async () => {
    const spec: WorkflowSpec = {
      name: "Skip",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "x", type: "agent_task", title: "X", agentRef: { package: "p" }, maxAttempts: 1, failurePolicy: "skip" },
        { key: "y", type: "checkpoint", title: "Y", dependsOn: [{ taskKey: "x", outcome: "success" }] },
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    const executors = buildExecutorRegistry({ agent_task: () => ({ status: "failed", error: { message: "boom" } }) });
    const res = await reconcileWorkflow(wfId, { executors, now: () => new Date("2026-06-01T00:00:00Z") });
    const statuses = await statusByKey(wfId);
    expect(statuses.x).toBe("failed");
    expect(statuses.y).toBe("skipped"); // permanently blocked by skip-policy failure → skipped
    expect(res.status).toBe("completed"); // skip does not fail the workflow
  });

  it("holds an approval task pending until granted, then dispatches + succeeds", async () => {
    const spec: WorkflowSpec = {
      name: "ApprovalGate",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "build", type: "checkpoint", title: "Build" },
        {
          key: "legal",
          type: "approval",
          title: "Legal sign-off",
          requiredScope: { level: "organization" },
          dependsOn: [{ taskKey: "build" }],
        },
        { key: "ship", type: "checkpoint", title: "Ship", dependsOn: [{ taskKey: "legal" }] },
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);

    // Tick 1: build succeeds, but the approval gate holds `legal` pending — the
    // workflow cannot complete and `ship` stays blocked behind the ungranted gate.
    const r1 = await reconcileWorkflow(wfId, { now: () => new Date() });
    expect(r1.status).toBe("active");
    let statuses = await statusByKey(wfId);
    expect(statuses.build).toBe("succeeded");
    expect(statuses.legal).not.toBe("succeeded");
    expect(statuses.ship).not.toBe("succeeded");
    // The approval is scaffolded pending; no executor has touched it.
    expect((await approvalForTask(wfId, "legal")).status).toBe("pending");
    expect((await attemptCount(wfId)).legal ?? 0).toBe(0); // gate-held → never dispatched

    // A human grants the approval. The decision "approved" must persist as the
    // canonical "granted" the gate evaluator reads.
    const appr = await approvalForTask(wfId, "legal");
    const decided = await decideWorkflowApproval({ approvalId: appr.id, decidedBy: "user-1", decision: "approved" });
    expect(decided.ok, JSON.stringify(decided)).toBe(true);
    expect((await approvalForTask(wfId, "legal")).status).toBe("granted");

    // Tick 2: the approval gate now passes → the `approval` executor runs →
    // `legal` succeeds → `ship` unblocks → the whole workflow completes.
    const r2 = await reconcileWorkflow(wfId, { now: () => new Date() });
    expect(r2.status).toBe("completed");
    statuses = await statusByKey(wfId);
    expect(statuses).toEqual({ build: "succeeded", legal: "succeeded", ship: "succeeded" });
    expect((await attemptCount(wfId)).legal).toBe(1); // exactly one dispatch after grant
  });

  it("rejecting an approval (default needs_revision) leaves the gated task blocked", async () => {
    const spec: WorkflowSpec = {
      name: "ApprovalRejected",
      target: { at: PAST, tz: "UTC" },
      tasks: [{ key: "legal", type: "approval", title: "Legal sign-off", requiredScope: { level: "organization" } }],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId, { now: () => new Date() });

    const appr = await approvalForTask(wfId, "legal");
    const decided = await decideWorkflowApproval({ approvalId: appr.id, decidedBy: "user-1", decision: "rejected" });
    expect(decided.ok).toBe(true);
    // Default rejection policy is needs_revision → held for revise+resubmit,
    // which is NOT "granted" so the gate stays closed.
    expect(decided.rejectionPolicy).toBe("needs_revision");
    expect((await approvalForTask(wfId, "legal")).status).toBe("needs_revision");

    // A non-granted approval does NOT open the gate → the task never dispatches.
    const res = await reconcileWorkflow(wfId, { now: () => new Date() });
    expect(res.status).toBe("active");
    expect((await statusByKey(wfId)).legal).not.toBe("succeeded");
    expect((await attemptCount(wfId)).legal ?? 0).toBe(0);
  });

  it("solicits an opened approval: stamps solicitedAt, emits approval_needed, surfaces in the inbox", async () => {
    const spec: WorkflowSpec = {
      name: "SolicitGate",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "build", type: "checkpoint", title: "Build" },
        {
          key: "legal",
          type: "approval",
          title: "Legal sign-off",
          requiredScope: { level: "organization" },
          dependsOn: [{ taskKey: "build" }],
        },
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);

    // Before reconcile the approval is pending but UNOPENED → not in the inbox.
    const before = await listPendingApprovalsForOrg(ORG);
    expect(before.find((a) => a.workflowId === wfId)).toBeUndefined();

    const events: string[] = [];
    await reconcileWorkflow(wfId, {
      now: () => new Date(),
      notify: (n) => {
        events.push(n.event);
      },
    });
    // build succeeded → deps satisfied → approval solicited this tick.
    expect(events).toContain("approval_needed");
    expect((await approvalForTask(wfId, "legal")).status).toBe("pending");

    // Now OPENED → appears in the org inbox; a second reconcile does not re-notify.
    const after = await listPendingApprovalsForOrg(ORG);
    expect(after.find((a) => a.workflowId === wfId && a.taskKey === "legal")).toBeDefined();
    const events2: string[] = [];
    await reconcileWorkflow(wfId, { now: () => new Date(), notify: (n) => { events2.push(n.event); } });
    expect(events2).not.toContain("approval_needed"); // solicitedAt dedupe
  });

  it("does NOT solicit an approval whose upstream deps are unsatisfied", async () => {
    const spec: WorkflowSpec = {
      name: "GatedSolicit",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "x", type: "agent_task", title: "X", agentRef: { package: "p" }, maxAttempts: 1 },
        {
          key: "legal",
          type: "approval",
          title: "Legal sign-off",
          requiredScope: { level: "organization" },
          dependsOn: [{ taskKey: "x" }],
        },
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    // x stays running (agent executor leaves it running) → legal's dep unsatisfied.
    const events: string[] = [];
    const executors = buildExecutorRegistry({ agent_task: () => ({ status: "running" }) });
    await reconcileWorkflow(wfId, { executors, now: () => new Date(), notify: (n) => { events.push(n.event); } });
    expect(events).not.toContain("approval_needed");
    const inbox = await listPendingApprovalsForOrg(ORG);
    expect(inbox.find((a) => a.workflowId === wfId)).toBeUndefined();
  });

  it("rejection policy skip → skips the gated task and skip-propagates downstream", async () => {
    const spec: WorkflowSpec = {
      name: "RejectSkip",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "build", type: "checkpoint", title: "Build" },
        {
          key: "legal",
          type: "approval",
          title: "Legal sign-off",
          requiredScope: { level: "organization" },
          rejectionPolicy: "skip",
          dependsOn: [{ taskKey: "build" }],
        },
        { key: "ship", type: "checkpoint", title: "Ship", dependsOn: [{ taskKey: "legal" }] },
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId, { now: () => new Date() }); // build succeeds → legal solicited
    const appr = await approvalForTask(wfId, "legal");
    const decided = await decideWorkflowApproval({ approvalId: appr.id, decidedBy: "u", decision: "rejected" });
    expect(decided.rejectionPolicy).toBe("skip");
    // The reconciler applies the skip DURABLY (no host fast-path).
    const res = await reconcileWorkflow(wfId, { now: () => new Date() });
    const statuses = await statusByKey(wfId);
    expect(statuses.legal).toBe("skipped");
    expect(statuses.ship).toBe("skipped"); // skip-propagates (dep outcome success unmet)
    expect(res.status).toBe("completed"); // skip does not fail the workflow
  });

  it("rejection policy cancel → reconciler cancels the workflow durably", async () => {
    const spec: WorkflowSpec = {
      name: "RejectCancel",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "build", type: "checkpoint", title: "Build" },
        {
          key: "legal",
          type: "approval",
          title: "Legal sign-off",
          requiredScope: { level: "organization" },
          rejectionPolicy: "cancel",
          dependsOn: [{ taskKey: "build" }],
        },
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId, { now: () => new Date() });
    const appr = await approvalForTask(wfId, "legal");
    const decided = await decideWorkflowApproval({ approvalId: appr.id, decidedBy: "u", decision: "rejected" });
    expect(decided.rejectionPolicy).toBe("cancel");
    expect((await approvalForTask(wfId, "legal")).status).toBe("rejected"); // not needs_revision
    // The reconciler cancels the workflow durably (even if the action died).
    const res = await reconcileWorkflow(wfId, { now: () => new Date() });
    expect(res.status).toBe("cancelled");
    expect((await readWorkflow(wfId))!.workflow.status).toBe("cancelled");
  });

  it("invalidates a granted approval when reviewed content changes → re-solicits", async () => {
    const spec: WorkflowSpec = {
      name: "HashInvalidate",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "build", type: "checkpoint", title: "Build" },
        {
          key: "legal",
          type: "approval",
          title: "Legal sign-off",
          requiredScope: { level: "organization" },
          dependsOn: [{ taskKey: "build" }],
        },
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId, { now: () => new Date() }); // build succeeds → legal solicited (hash stored)
    const appr = await approvalForTask(wfId, "legal");
    await decideWorkflowApproval({ approvalId: appr.id, decidedBy: "u", decision: "approved" });
    expect((await approvalForTask(wfId, "legal")).status).toBe("granted");

    // Change the reviewed content (retitle the upstream task) → hash mismatch.
    const c = await pg();
    await c.query(`UPDATE "${SCHEMA}"."workflow_task" SET title = 'Build (revised)' WHERE workflow_id = $1 AND key = 'build'`, [wfId]);
    await c.end();

    const events: string[] = [];
    await reconcileWorkflow(wfId, { now: () => new Date(), notify: (n) => { events.push(n.event); } });
    // The granted approval is invalidated + re-solicited; the task did NOT dispatch.
    expect((await approvalForTask(wfId, "legal")).status).toBe("pending");
    expect((await statusByKey(wfId)).legal).not.toBe("succeeded");
    expect(events).toContain("approval_needed"); // re-solicited

    // The re-solicited approval is valid again — re-solicitation cleared the
    // invalidatedAt stamp, so it is decidable: the invalidatedAt CAS must
    // NOT over-block a legitimately re-opened approval.
    const reAppr = await approvalForTask(wfId, "legal");
    const reDecide = await decideWorkflowApproval({ approvalId: reAppr.id, decidedBy: "u2", decision: "approved" });
    expect(reDecide.ok, JSON.stringify(reDecide)).toBe(true);
    expect((await approvalForTask(wfId, "legal")).status).toBe("granted");
  });

  it("allows editing a paused workflow with zero attempts", async () => {
    const spec: WorkflowSpec = {
      name: "PausedEditableNoAttempts",
      target: { at: PAST, tz: "UTC" },
      tasks: [{ key: "m", type: "manual", title: "M" }],
    } as WorkflowSpec;
    const wfId = await start(spec);
    // No reconcile → manual was never claimed → no attempts yet.
    const p = await pauseWorkflow(wfId);
    expect(p.ok).toBe(true);
    const reconstructed = await reconstructSpec(wfId);
    expect(reconstructed).not.toBeNull();
    const wf = (await readWorkflow(wfId))!.workflow;
    const r = await updateWorkflowDraftSpec({
      workflowId: wfId,
      spec: reconstructed!,
      expectedLockVersion: wf.lockVersion,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("allows a NON-removing edit on a paused workflow that has attempts, preserving them", async () => {
    const spec: WorkflowSpec = {
      name: "PausedDiffApply",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "a", type: "checkpoint", title: "A" },
        { key: "m", type: "manual", title: "M", dependsOn: [{ taskKey: "a" }] },
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId); // a succeeds (attempt) → m claims (attempt, manual=running)
    expect((await attemptCount(wfId)).a).toBe(1);
    const p = await pauseWorkflow(wfId);
    expect(p.ok).toBe(true);

    // Re-title a task (a non-removing structural edit) on the paused workflow.
    const reconstructed = (await reconstructSpec(wfId))!;
    const patched: WorkflowSpec = {
      ...reconstructed,
      tasks: reconstructed.tasks.map((t) => (t.key === "m" ? { ...t, title: "M (revised)" } : t)),
    };
    const wf = (await readWorkflow(wfId))!.workflow;
    const r = await updateWorkflowDraftSpec({ workflowId: wfId, spec: patched, expectedLockVersion: wf.lockVersion });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    // Diff-and-apply preserved the attempts (no FK crash, no history loss) and
    // applied the title change in place.
    expect((await attemptCount(wfId)).a).toBe(1);
    const tasks = (await readWorkflow(wfId))!.tasks;
    expect(tasks.find((t) => t.key === "m")!.title).toBe("M (revised)");
    expect(tasks.find((t) => t.key === "a")!.status).toBe("succeeded"); // status preserved
  });

  it("rejects removing a task that has attempts on a paused workflow", async () => {
    const spec: WorkflowSpec = {
      name: "PausedRemoveWithAttempts",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "a", type: "checkpoint", title: "A" },
        { key: "m", type: "manual", title: "M" }, // independent — keeps the workflow active
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId); // a succeeds (attempt) → m claims (running)
    expect((await attemptCount(wfId)).a).toBe(1);
    const p = await pauseWorkflow(wfId);
    expect(p.ok).toBe(true);

    // Remove task `a` (which has an attempt) — not FK-safe → rejected.
    const reconstructed = (await reconstructSpec(wfId))!;
    const patched: WorkflowSpec = { ...reconstructed, tasks: reconstructed.tasks.filter((t) => t.key !== "a") };
    const before = (await readWorkflow(wfId))!.workflow;
    const r = await updateWorkflowDraftSpec({ workflowId: wfId, spec: patched, expectedLockVersion: before.lockVersion });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("task_has_attempts");
    // task `a` + its attempt are untouched by the aborted tx.
    expect((await readWorkflow(wfId))!.tasks.find((t) => t.key === "a")).toBeDefined();
    expect((await attemptCount(wfId)).a).toBe(1);
    // Regression guard: the rejected apply must NOT commit the
    // workflow-row CAS — lock/specVersion/name/release stay exactly as before.
    const after = (await readWorkflow(wfId))!.workflow;
    expect(after.lockVersion).toBe(before.lockVersion);
    expect(after.specVersion).toBe(before.specVersion);
    expect(after.name).toBe(before.name);
    expect(after.targetAtUtc?.getTime()).toBe(before.targetAtUtc?.getTime());
  });

  it("rejects mutating an attempted task's execution identity on a paused workflow", async () => {
    const spec: WorkflowSpec = {
      name: "PausedIdentityFreeze",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "a", type: "checkpoint", title: "A" }, // succeeds → has an attempt
        { key: "m", type: "manual", title: "M" }, // claims → running (keeps workflow active)
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId); // a → succeeded (attempt), m → running
    expect((await attemptCount(wfId)).a).toBe(1);
    const p = await pauseWorkflow(wfId);
    expect(p.ok).toBe(true);

    // Change `a`'s TYPE (execution identity) — its attempt rows describe a
    // checkpoint that ran, so flipping it to manual must be rejected.
    const reconstructed = (await reconstructSpec(wfId))!;
    const patched: WorkflowSpec = {
      ...reconstructed,
      tasks: reconstructed.tasks.map((t) => (t.key === "a" ? { ...t, type: "manual" } : t)),
    };
    const before = (await readWorkflow(wfId))!.workflow;
    const r = await updateWorkflowDraftSpec({ workflowId: wfId, spec: patched, expectedLockVersion: before.lockVersion });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("task_immutable");
    // identity + workflow row untouched by the aborted tx.
    const after = (await readWorkflow(wfId))!;
    expect(after.tasks.find((t) => t.key === "a")!.type).toBe("checkpoint");
    expect(after.workflow.lockVersion).toBe(before.lockVersion);
    expect(after.workflow.specVersion).toBe(before.specVersion);
  });

  it("rejects removing a terminal skipped task on a paused workflow", async () => {
    const spec: WorkflowSpec = {
      name: "PausedRemoveSkipped",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "x", type: "agent_task", title: "X", agentRef: { package: "p" }, maxAttempts: 1, failurePolicy: "skip" },
        { key: "y", type: "checkpoint", title: "Y", dependsOn: [{ taskKey: "x", outcome: "success" }] }, // → skipped, 0 attempts
        { key: "m", type: "manual", title: "M" }, // running → keeps the workflow active/pausable
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    const executors = buildExecutorRegistry({ agent_task: () => ({ status: "failed", error: { message: "boom" } }) });
    await reconcileWorkflow(wfId, { executors, now: () => new Date() }); // x failed (skip) → y skipped; m running
    expect((await statusByKey(wfId)).y).toBe("skipped");
    expect((await attemptCount(wfId)).y ?? 0).toBe(0); // y never dispatched → no FK evidence
    const p = await pauseWorkflow(wfId);
    expect(p.ok).toBe(true);

    // `y` carries no attempts/artifacts/approval, but it is terminal (status
    // freeze) → its identity is immutable, so deleting it (which would erase the
    // skip from history) is rejected — same boundary as the kept-task freeze.
    const reconstructed = (await reconstructSpec(wfId))!;
    const patched: WorkflowSpec = { ...reconstructed, tasks: reconstructed.tasks.filter((t) => t.key !== "y") };
    const before = (await readWorkflow(wfId))!.workflow;
    const r = await updateWorkflowDraftSpec({ workflowId: wfId, spec: patched, expectedLockVersion: before.lockVersion });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("task_immutable");
    expect((await readWorkflow(wfId))!.tasks.find((t) => t.key === "y")).toBeDefined();
    expect((await readWorkflow(wfId))!.workflow.lockVersion).toBe(before.lockVersion);
  });

  it("rejects removing a SOLICITED approval task on a paused workflow", async () => {
    const spec: WorkflowSpec = {
      name: "PausedRemoveApproval",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "build", type: "checkpoint", title: "Build" },
        { key: "legal", type: "approval", title: "Legal", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "build" }] },
        { key: "m", type: "manual", title: "M" }, // independent — keeps the workflow active/pausable
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId); // build succeeds → legal solicited (solicitedAt stamped); m → running
    expect((await approvalForTask(wfId, "legal")).status).toBe("pending"); // solicited but undecided
    const p = await pauseWorkflow(wfId);
    expect(p.ok).toBe(true);

    // Remove the solicited approval task — its workflow_approval row is RESTRICT
    // evidence (deleting the approval first would orphan the ledger) → rejected.
    const reconstructed = (await reconstructSpec(wfId))!;
    const patched: WorkflowSpec = { ...reconstructed, tasks: reconstructed.tasks.filter((t) => t.key !== "legal") };
    const before = (await readWorkflow(wfId))!.workflow;
    const r = await updateWorkflowDraftSpec({ workflowId: wfId, spec: patched, expectedLockVersion: before.lockVersion });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("task_has_attempts");
    expect((await readWorkflow(wfId))!.tasks.find((t) => t.key === "legal")).toBeDefined();
    expect((await readWorkflow(wfId))!.workflow.lockVersion).toBe(before.lockVersion);
  });

  it("does NOT reopen a CONSUMED (succeeded) approval on a paused edit", async () => {
    const spec: WorkflowSpec = {
      name: "PausedConsumedApproval",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "build", type: "checkpoint", title: "Build" },
        { key: "legal", type: "approval", title: "Legal", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "build" }] },
        { key: "m", type: "manual", title: "M" }, // running → keeps the workflow active/pausable
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId); // build succeeds → legal solicited; m running
    const appr = await approvalForTask(wfId, "legal");
    await decideWorkflowApproval({ approvalId: appr.id, decidedBy: "u", decision: "approved" });
    await reconcileWorkflow(wfId); // granted gate opens → legal dispatches → succeeds (consumed)
    expect((await statusByKey(wfId)).legal).toBe("succeeded");
    await pauseWorkflow(wfId);

    // Change build's title (feeds legal's packet) — but legal already SUCCEEDED,
    // so its sign-off is consumed history and must NOT be reopened.
    const reconstructed = (await reconstructSpec(wfId))!;
    const patched: WorkflowSpec = {
      ...reconstructed,
      tasks: reconstructed.tasks.map((t) => (t.key === "build" ? { ...t, title: "Build (revised)" } : t)),
    };
    const wf = (await readWorkflow(wfId))!.workflow;
    const r = await updateWorkflowDraftSpec({ workflowId: wfId, spec: patched, expectedLockVersion: wf.lockVersion });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((await approvalForTask(wfId, "legal")).status).toBe("granted"); // decision preserved
    expect((await statusByKey(wfId)).legal).toBe("succeeded"); // task stays consumed
  });

  it("reopens an opened approval when a paused edit changes its review-packet content", async () => {
    const spec: WorkflowSpec = {
      name: "PausedStaleApproval",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "build", type: "checkpoint", title: "Build" },
        { key: "legal", type: "approval", title: "Legal", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "build" }] },
        { key: "m", type: "manual", title: "M" }, // running → keeps the workflow active/pausable
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId); // build succeeds → legal solicited; m running
    const appr = await approvalForTask(wfId, "legal");
    await decideWorkflowApproval({ approvalId: appr.id, decidedBy: "u", decision: "approved" });
    expect((await approvalForTask(wfId, "legal")).status).toBe("granted");
    await pauseWorkflow(wfId);

    // Change the UPSTREAM task's title — an editable field that feeds legal's
    // review packet — so the prior sign-off is now against stale content. The
    // the reconciler's hash-invalidation can't run on a paused workflow, so the
    // diff-apply must reopen the approval synchronously.
    const reconstructed = (await reconstructSpec(wfId))!;
    const patched: WorkflowSpec = {
      ...reconstructed,
      tasks: reconstructed.tasks.map((t) => (t.key === "build" ? { ...t, title: "Build (revised scope)" } : t)),
    };
    const wf = (await readWorkflow(wfId))!.workflow;
    const r = await updateWorkflowDraftSpec({ workflowId: wfId, spec: patched, expectedLockVersion: wf.lockVersion });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    // legal is reopened (no longer granted) and not decidable until re-solicited.
    expect((await approvalForTask(wfId, "legal")).status).toBe("pending");
    const reAppr = await approvalForTask(wfId, "legal");
    const reDecide = await decideWorkflowApproval({ approvalId: reAppr.id, decidedBy: "u", decision: "approved" });
    expect(reDecide.ok).toBe(false);
    expect(reDecide.reason).toBe("invalidated");
  });

  it("decides an approval on a paused workflow + preserves the grant across a paused edit", async () => {
    const spec: WorkflowSpec = {
      name: "PausedDecidePreserve",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "build", type: "checkpoint", title: "Build" },
        { key: "legal", type: "approval", title: "Legal", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "build" }] },
        { key: "m", type: "manual", title: "M" }, // running → keeps the workflow active/pausable
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId); // build succeeds → legal solicited; m running
    const p = await pauseWorkflow(wfId);
    expect(p.ok).toBe(true);

    // Decide on the PAUSED workflow — decideWorkflowApproval now takes the same
    // per-workflow advisory lock as the diff-apply, so this serializes cleanly.
    const appr = await approvalForTask(wfId, "legal");
    const decided = await decideWorkflowApproval({ approvalId: appr.id, decidedBy: "user-1", decision: "approved" });
    expect(decided.ok, JSON.stringify(decided)).toBe(true);
    expect((await approvalForTask(wfId, "legal")).status).toBe("granted");

    // A subsequent paused edit (re-title an editable task) must NOT clobber the
    // grant — the diff-apply preserves the decided approval by key.
    const reconstructed = (await reconstructSpec(wfId))!;
    const patched: WorkflowSpec = {
      ...reconstructed,
      tasks: reconstructed.tasks.map((t) => (t.key === "m" ? { ...t, title: "M (revised)" } : t)),
    };
    const wf = (await readWorkflow(wfId))!.workflow;
    const r = await updateWorkflowDraftSpec({ workflowId: wfId, spec: patched, expectedLockVersion: wf.lockVersion });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect((await approvalForTask(wfId, "legal")).status).toBe("granted"); // decision survived the rebuild
  });

  it("rejects changing a solicited approval's required scope on a paused workflow", async () => {
    const spec: WorkflowSpec = {
      name: "PausedApprovalScopeFreeze",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "build", type: "checkpoint", title: "Build" },
        { key: "legal", type: "approval", title: "Legal", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "build" }] },
        { key: "m", type: "manual", title: "M" },
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId); // legal solicited
    await pauseWorkflow(wfId);

    // Swap the approval's required scope under the preserved (solicited) decision
    // ledger — the original solicitation targeted org approvers, not user.
    const reconstructed = (await reconstructSpec(wfId))!;
    const patched: WorkflowSpec = {
      ...reconstructed,
      tasks: reconstructed.tasks.map((t) => (t.key === "legal" ? { ...t, requiredScope: { level: "user" } } : t)),
    };
    const before = (await readWorkflow(wfId))!.workflow;
    const r = await updateWorkflowDraftSpec({ workflowId: wfId, spec: patched, expectedLockVersion: before.lockVersion });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("task_immutable");
    expect((await readWorkflow(wfId))!.workflow.lockVersion).toBe(before.lockVersion);
  });

  it("rejects changing a succeeded task's dependency edges on a paused workflow", async () => {
    const spec: WorkflowSpec = {
      name: "PausedDepEdgeFreeze",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "a", type: "checkpoint", title: "A" },
        { key: "b", type: "checkpoint", title: "B", dependsOn: [{ taskKey: "a" }] }, // ran gated behind a
        { key: "m", type: "manual", title: "M" },
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId); // a succeeds
    await reconcileWorkflow(wfId); // b (dep satisfied) succeeds → has an attempt → frozen
    expect((await attemptCount(wfId)).b).toBe(1);
    await pauseWorkflow(wfId);

    // Drop b's dependency on a — rewrites the gate condition under which b ran.
    const reconstructed = (await reconstructSpec(wfId))!;
    const patched: WorkflowSpec = {
      ...reconstructed,
      tasks: reconstructed.tasks.map((t) => (t.key === "b" ? { ...t, dependsOn: [] } : t)),
    };
    const before = (await readWorkflow(wfId))!.workflow;
    const r = await updateWorkflowDraftSpec({ workflowId: wfId, spec: patched, expectedLockVersion: before.lockVersion });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("task_immutable");
    expect((await readWorkflow(wfId))!.workflow.lockVersion).toBe(before.lockVersion);
  });

  it("rejects rescheduling a completed task on a paused workflow; allows an idle one", async () => {
    const spec: WorkflowSpec = {
      name: "PausedPerTaskGate",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "a", type: "checkpoint", title: "A" }, // will succeed → completed
        { key: "m", type: "manual", title: "M" }, // claims → running (keeps workflow active)
        { key: "c", type: "checkpoint", title: "C", dependsOn: [{ taskKey: "m" }] }, // blocked behind m → stays idle
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId); // a → succeeded, m → running, c → idle (dep unmet)
    await pauseWorkflow(wfId);
    const lv = (await readWorkflow(wfId))!.workflow.lockVersion;
    // `a` is completed → read-only.
    const rA = await applyWorkflowTaskWindow({
      workflowId: wfId,
      taskKey: "a",
      startAtUtc: PAST,
      endAtUtc: PAST,
      expectedLockVersion: lv,
    });
    expect(rA.ok).toBe(false);
    expect(rA.reason).toBe("task_not_editable");

    // `c` is idle → editable: the same operation succeeds — the
    // "allows an idle one" half must actually be exercised. lv is unchanged
    // because rA aborted before the CAS.
    const rC = await applyWorkflowTaskWindow({
      workflowId: wfId,
      taskKey: "c",
      startAtUtc: PAST,
      endAtUtc: PAST,
      expectedLockVersion: lv,
    });
    expect(rC.ok, JSON.stringify(rC)).toBe(true);
  });

  it("a release-date move on a paused workflow leaves an already-run relative task put but cascades an idle one", async () => {
    const spec: WorkflowSpec = {
      name: "PausedReleaseCascade",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        // relative to release, due before it → in the past → runs + succeeds → frozen.
        { key: "a", type: "checkpoint", title: "A", schedule: { mode: "relative", anchor: "target", offsetIso8601: "P1D", direction: "before" } },
        { key: "m", type: "manual", title: "M" }, // running → keeps the workflow active
        // relative to release, blocked behind running m → stays idle → still cascades.
        { key: "b", type: "checkpoint", title: "B", dependsOn: [{ taskKey: "m" }], schedule: { mode: "relative", anchor: "target", offsetIso8601: "P1D", direction: "after" } },
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId); // a → succeeded (attempt → frozen); m → running; b → idle
    expect((await attemptCount(wfId)).a).toBe(1);
    await pauseWorkflow(wfId);

    const beforeTasks = (await readWorkflow(wfId))!.tasks;
    const aDueBefore = beforeTasks.find((t) => t.key === "a")!.dueAtUtc!.getTime();
    const bDueBefore = beforeTasks.find((t) => t.key === "b")!.dueAtUtc!.getTime();
    const lv = (await readWorkflow(wfId))!.workflow.lockVersion;

    const THIRTY_DAYS = 30 * 24 * 3600 * 1000;
    const newTarget = new Date(Date.parse(PAST) + THIRTY_DAYS).toISOString();
    const r = await rescheduleWorkflow({ workflowId: wfId, newTargetAt: newTarget, expectedLockVersion: lv });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const afterTasks = (await readWorkflow(wfId))!.tasks;
    const aDueAfter = afterTasks.find((t) => t.key === "a")!.dueAtUtc!.getTime();
    const bDueAfter = afterTasks.find((t) => t.key === "b")!.dueAtUtc!.getTime();
    // Frozen `a` keeps its committed due (would otherwise drift to the new
    // release); idle `b` cascades by exactly the release delta.
    expect(aDueAfter).toBe(aDueBefore);
    expect(bDueAfter).toBe(bDueBefore + THIRTY_DAYS);
  });

  it("blocks deciding a solicited approval after the workflow is cancelled", async () => {
    const spec: WorkflowSpec = {
      name: "CancelThenDecide",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "build", type: "checkpoint", title: "Build" },
        { key: "legal", type: "approval", title: "Legal", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "build" }] },
        { key: "m", type: "manual", title: "M" }, // running → keeps the workflow active (cancellable)
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId); // build succeeds → legal solicited; m running
    const appr = await approvalForTask(wfId, "legal");

    // Cancel stamps invalidatedAt on the pending approval WITHOUT clearing
    // solicitedAt — the exact race the invalidation CAS guards.
    // Before cancel the solicited approval is in the org inbox.
    expect((await listPendingApprovalsForOrg(ORG)).find((a) => a.workflowId === wfId)).toBeDefined();

    const cancelled = await cancelWorkflow(wfId);
    expect(cancelled.ok, JSON.stringify(cancelled)).toBe(true);

    const decided = await decideWorkflowApproval({ approvalId: appr.id, decidedBy: "u", decision: "approved" });
    expect(decided.ok).toBe(false);
    expect(decided.reason).toBe("invalidated");
    expect((await approvalForTask(wfId, "legal")).status).toBe("pending"); // never granted
    // ...and it drops out of the actionable inbox.
    expect((await listPendingApprovalsForOrg(ORG)).find((a) => a.workflowId === wfId)).toBeUndefined();
  });

  it("cannot decide an approval before its gate is solicited", async () => {
    const spec: WorkflowSpec = {
      name: "DecideGuard",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "x", type: "agent_task", title: "X", agentRef: { package: "p" }, maxAttempts: 1 },
        {
          key: "legal",
          type: "approval",
          title: "Legal sign-off",
          requiredScope: { level: "organization" },
          dependsOn: [{ taskKey: "x" }],
        },
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    // No reconcile yet → the approval is pending but UNOPENED (not solicited).
    const appr = await approvalForTask(wfId, "legal");
    const d = await decideWorkflowApproval({ approvalId: appr.id, decidedBy: "user-1", decision: "approved" });
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("not_opened");
  });

  it("fires workflow_completed via the injected notifier", async () => {
    const spec: WorkflowSpec = {
      name: "NotifyComplete",
      target: { at: PAST, tz: "UTC" },
      tasks: [{ key: "a", type: "checkpoint", title: "A" }],
    } as WorkflowSpec;
    const wfId = await start(spec);
    const events: { event: string; taskId?: string | null }[] = [];
    const res = await reconcileWorkflow(wfId, {
      now: () => new Date(),
      notify: (n) => {
        events.push({ event: n.event, taskId: n.taskId });
      },
    });
    expect(res.status).toBe("completed");
    expect(events.map((e) => e.event)).toContain("workflow_completed");
  });

  it("fires task_failed + workflow_failed when a task dead-letters", async () => {
    const spec: WorkflowSpec = {
      name: "NotifyFail",
      target: { at: PAST, tz: "UTC" },
      tasks: [{ key: "x", type: "agent_task", title: "X", agentRef: { package: "p" }, maxAttempts: 1 }],
    } as WorkflowSpec;
    const wfId = await start(spec);
    const events: { event: string; taskId?: string | null }[] = [];
    const executors = buildExecutorRegistry({ agent_task: () => ({ status: "failed", error: { message: "boom" } }) });
    const res = await reconcileWorkflow(wfId, {
      executors,
      now: () => new Date("2026-06-01T00:00:00Z"),
      notify: (n) => {
        events.push({ event: n.event, taskId: n.taskId });
      },
    });
    expect(res.status).toBe("failed");
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain("task_failed");
    expect(kinds).toContain("workflow_failed");
    // task_failed carries the dead-lettered task id; workflow_failed does not.
    expect(events.find((e) => e.event === "task_failed")?.taskId).toBeTruthy();
  });
});

describe("lifecycle (integration)", () => {
  const simple: WorkflowSpec = {
    name: "Lifecycle",
    target: { at: PAST, tz: "UTC" },
    tasks: [{ key: "m", type: "manual", title: "Manual step" }],
  } as WorkflowSpec;

  it("pauses (halts dispatch) and resumes", async () => {
    const wfId = await start(simple);
    expect((await pauseWorkflow(wfId)).ok).toBe(true);
    expect((await readWorkflow(wfId))!.workflow.status).toBe("paused");
    // a paused workflow is skipped by the reconciler
    const r = await reconcileWorkflow(wfId);
    expect(r.status).toBe("paused");
    expect((await resumeWorkflow(wfId)).ok).toBe(true);
    expect((await readWorkflow(wfId))!.workflow.status).toBe("active");
  });

  it("cancels with deterministic teardown — tasks cancelled + child runs cancelled", async () => {
    const spec: WorkflowSpec = {
      name: "Cancel + teardown",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "m", type: "manual", title: "Manual" },
        { key: "a", type: "agent_task", title: "Agent", agentRef: { package: "p" } },
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    const executors = buildExecutorRegistry({ agent_task: () => ({ status: "running", childRunId: "child-1" }) });
    await reconcileWorkflow(wfId, { executors }); // m + a dispatched → running (a has child-1)

    const cancelledChildren: string[] = [];
    const res = await cancelWorkflow(wfId, { cancelChildRun: (cid) => void cancelledChildren.push(cid), actorId: "user-x" });
    expect(res.ok).toBe(true);
    const after = await readWorkflow(wfId);
    expect(after!.workflow.status).toBe("cancelled");
    expect(after!.tasks.every((t) => t.status === "cancelled")).toBe(true);
    expect(cancelledChildren).toContain("child-1"); // in-flight child agent run cancelled
  });

  it("rejects cancelling an already-terminal workflow", async () => {
    const wfId = await start(simple);
    await cancelWorkflow(wfId);
    const second = await cancelWorkflow(wfId);
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/not_cancellable/);
  });
});

describe("agent_task child-run poll (integration)", () => {
  // The executor returns a childRunId derived from the per-attempt idempotency
  // key, so a retry (new attemptNo → new key) yields a distinct child run.
  const dispatching = () =>
    buildExecutorRegistry({
      agent_task: ({ idempotencyKey }) => ({ status: "running", childRunId: `child:${idempotencyKey}` }),
    });

  it("polls a dispatched agent_task to completion, links the run artifact, unblocks downstream", async () => {
    const spec: WorkflowSpec = {
      name: "Agent completes",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "a", type: "agent_task", title: "A", agentRef: { package: "p" } },
        { key: "b", type: "checkpoint", title: "B", dependsOn: [{ taskKey: "a" }] },
      ],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId, { executors: dispatching() }); // a → running (child run dispatched)
    expect((await statusByKey(wfId)).a).toBe("running");

    const getChildRunStatus = async () => ({ status: "completed", terminal: true, failed: false, hitl: false });
    const res = await reconcileWorkflow(wfId, { executors: dispatching(), getChildRunStatus });
    const statuses = await statusByKey(wfId);
    expect(statuses.a).toBe("succeeded");
    expect(statuses.b).toBe("succeeded"); // unblocked + cascaded in the same tick
    expect(res.status).toBe("completed");
    expect((await attemptCount(wfId)).a).toBe(1); // single child run — no double dispatch
    const arts = await artifactsForTask(wfId, "a");
    expect(arts.some((x) => x.kind === "agent_run")).toBe(true); // child run linked as evidence
  });

  it("bubbles agent HITL as a single event and leaves the task running (handoff)", async () => {
    const spec: WorkflowSpec = {
      name: "Agent HITL",
      target: { at: PAST, tz: "UTC" },
      tasks: [{ key: "a", type: "agent_task", title: "A", agentRef: { package: "p" } }],
    } as WorkflowSpec;
    const wfId = await start(spec);
    await reconcileWorkflow(wfId, { executors: dispatching() });
    const getChildRunStatus = async () => ({ status: "pending_approval", terminal: false, failed: false, hitl: true });
    await reconcileWorkflow(wfId, { executors: dispatching(), getChildRunStatus }); // bubble
    await reconcileWorkflow(wfId, { executors: dispatching(), getChildRunStatus }); // still HITL → no dup
    expect((await statusByKey(wfId)).a).toBe("running"); // task stays running
    expect(await eventCountOfKind(wfId, "agent_hitl")).toBe(1); // idempotent bubble
  });

  it("retries then dead-letters when the polled child run fails", async () => {
    const spec: WorkflowSpec = {
      name: "Agent fails",
      target: { at: PAST, tz: "UTC" },
      tasks: [{ key: "a", type: "agent_task", title: "A", agentRef: { package: "p" }, maxAttempts: 2 }],
    } as WorkflowSpec;
    const wfId = await start(spec);
    const failing = async () => ({ status: "failed", terminal: true, failed: true, hitl: false, error: { message: "agent boom" } });
    const t0 = new Date("2026-06-01T00:00:00Z");
    await reconcileWorkflow(wfId, { executors: dispatching(), now: () => t0 }); // attempt 1 → running
    await reconcileWorkflow(wfId, { executors: dispatching(), getChildRunStatus: failing, now: () => t0 }); // poll → fail → retry
    expect((await statusByKey(wfId)).a).toBe("scheduled");
    const t1 = new Date(t0.getTime() + 5 * 60_000); // past backoff
    await reconcileWorkflow(wfId, { executors: dispatching(), now: () => t1 }); // attempt 2 → running
    const res = await reconcileWorkflow(wfId, { executors: dispatching(), getChildRunStatus: failing, now: () => t1 }); // poll → fail → dead-letter
    expect((await statusByKey(wfId)).a).toBe("failed");
    expect((await attemptCount(wfId)).a).toBe(2);
    expect(res.status).toBe("failed");
  });
  // The host executor's tenancy guard (cross-org fail-closed)
  // + idempotent dispatch + status mapping are unit-tested in
  // src/lib/__tests__/workflow-agent-executor.test.ts (mocked agents store).
});

describe("task hierarchy (integration)", () => {
  async function parentTaskIdOf(workflowId: string, key: string): Promise<string | null> {
    const c = await pg();
    const { rows } = await c.query(
      `SELECT parent_task_id FROM "${SCHEMA}"."workflow_task" WHERE workflow_id=$1 AND key=$2`,
      [workflowId, key],
    );
    await c.end();
    return rows[0]?.parent_task_id ?? null;
  }
  async function taskIdOf(workflowId: string, key: string): Promise<string> {
    const c = await pg();
    const { rows } = await c.query(
      `SELECT id FROM "${SCHEMA}"."workflow_task" WHERE workflow_id=$1 AND key=$2`,
      [workflowId, key],
    );
    await c.end();
    return rows[0].id;
  }
  const hierSpec = (): WorkflowSpec =>
    ({
      name: "Hierarchy",
      target: { at: PAST, tz: "UTC" },
      tasks: [
        { key: "phase", type: "checkpoint", title: "Stage one" },
        { key: "design", type: "checkpoint", title: "Design", parent: "phase" },
        { key: "build", type: "manual", title: "Build", parent: "phase" },
      ],
    }) as WorkflowSpec;

  it("round-trips parent through create → reconstruct (id↔key, same workflow)", async () => {
    const { workflowId } = await createWorkflowFromSpec({ spec: hierSpec(), name: "Hierarchy", orgId: ORG });
    // DB: each child's parent_task_id points at the parent row id (same workflow).
    const phaseId = await taskIdOf(workflowId, "phase");
    expect(await parentTaskIdOf(workflowId, "design")).toBe(phaseId);
    expect(await parentTaskIdOf(workflowId, "build")).toBe(phaseId);
    expect(await parentTaskIdOf(workflowId, "phase")).toBeNull();
    // Spec: reconstructSpec emits the parent KEY (not the id).
    const spec = await reconstructSpec(workflowId);
    const byKey = Object.fromEntries(spec!.tasks.map((t) => [t.key, t])) as Record<
      string,
      { parent?: string }
    >;
    expect(byKey.design.parent).toBe("phase");
    expect(byKey.build.parent).toBe("phase");
    expect(byKey.phase.parent).toBeUndefined();
  });

  it("ON DELETE SET NULL — raw-deleting a parent orphans children, not cascade-delete", async () => {
    const { workflowId } = await createWorkflowFromSpec({ spec: hierSpec(), name: "Hierarchy", orgId: ORG });
    const phaseId = await taskIdOf(workflowId, "phase");
    const c = await pg();
    await c.query(`DELETE FROM "${SCHEMA}"."workflow_task" WHERE id=$1`, [phaseId]);
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM "${SCHEMA}"."workflow_task" WHERE workflow_id=$1`,
      [workflowId],
    );
    await c.end();
    expect(Number(rows[0].n)).toBe(2); // children survive
    expect(await parentTaskIdOf(workflowId, "design")).toBeNull();
    expect(await parentTaskIdOf(workflowId, "build")).toBeNull();
  });

  it("deleteWorkflowTask(parent) orphans children to top-level via the spec rebuild", async () => {
    const { workflowId } = await createWorkflowFromSpec({ spec: hierSpec(), name: "Hierarchy", orgId: ORG });
    const wf = await readWorkflow(workflowId);
    const res = await deleteWorkflowTask({
      workflowId,
      taskKey: "phase",
      expectedLockVersion: wf!.workflow.lockVersion,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(await parentTaskIdOf(workflowId, "design")).toBeNull();
    expect(await parentTaskIdOf(workflowId, "build")).toBeNull();
    const spec = await reconstructSpec(workflowId);
    expect(spec!.tasks.find((t) => t.key === "phase")).toBeUndefined();
  });

  it("deleting the whole workflow cascades all tasks", async () => {
    const { workflowId } = await createWorkflowFromSpec({ spec: hierSpec(), name: "Hierarchy", orgId: ORG });
    const c = await pg();
    await c.query(`DELETE FROM "${SCHEMA}"."workflow" WHERE id=$1`, [workflowId]);
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM "${SCHEMA}"."workflow_task" WHERE workflow_id=$1`,
      [workflowId],
    );
    await c.end();
    expect(Number(rows[0].n)).toBe(0);
  });
});
