/**
 * cinatra#4312 (#3035 W11) — Regenerate on the featured image's review keeps the
 * blog pipeline's run PARKED at the successor gate, and the run goes on only once
 * that gate is continued.
 *
 * Real store, real repair loop, real resume worker (`sweepArtifactReviewResumeIntents`
 * over the real resume outbox). Only the WayFlow side is replaced: the A2A client
 * (its `sendTask` is the resume of the paused run) and the task-state handler that
 * a sent resume drives. So "parked" reads as: the run is still `pending_approval`
 * and no resume was sent; "goes on" reads as: exactly one resume was sent into the
 * run's context, carrying the successor gate's own decision.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://… \
 *     pnpm --filter @cinatra-ai/agents test:integration lifecycle-c-w11-picture-regenerate-parks-run-3035
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { buildReviewApproveEnvelope } from "@/lib/artifacts/artifact-review-rejection";
import { isRepairSuccessorTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const { sendTaskSpy, handleWayflowTaskStateSpy } = vi.hoisted(() => ({
  sendTaskSpy: vi.fn(async (_req: unknown) => ({ id: "wf-task", status: { state: "completed" } })),
  handleWayflowTaskStateSpy: vi.fn(async (_args: unknown) => undefined),
}));
vi.mock("@cinatra-ai/a2a", () => ({
  createExternalA2AClient: vi.fn(async () => ({ sendTask: sendTaskSpy })),
  resolveRunIdByWayflowTaskId: vi.fn(async () => null),
  resolveLatestWayflowGateTaskId: vi.fn(async () => null),
  expireRunStream: vi.fn(async () => undefined),
}));
vi.mock("../execution", () => ({ handleWayflowTaskState: handleWayflowTaskStateSpy }));
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  createWayflowFetch: vi.fn(() => globalThis.fetch),
}));
// The install-scope recheck reads the run's principal; this suite seeds none. Its
// behaviour is proven in agent-template-scope.test.ts / agent-run-scope-guard.test.ts.
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));

const TEST_SCHEMA = "cinatra_test_regenerate_park_4312";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-4312-park";

let gateStore: typeof import("../artifact-review-gate-store");
let repairStore: typeof import("../lifecycle-repair-store");
let crStore: typeof import("../lifecycle-review-changes-requested-store");
let resumeDelivery: typeof import("../artifact-review-resume-delivery");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  const { replayStoreSchema } = await import("@/lib/test-support/store-schema-replay");
  await replayStoreSchema(admin, buildCreateStoreSchemaQueries(TEST_SCHEMA));
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  gateStore = await import("../artifact-review-gate-store");
  repairStore = await import("../lifecycle-repair-store");
  crStore = await import("../lifecycle-review-changes-requested-store");
  resumeDelivery = await import("../artifact-review-resume-delivery");
  dbMod = await import("../db");
}, 90_000);

beforeEach(() => {
  if (!HAS_DB) return;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
  sendTaskSpy.mockClear();
  handleWayflowTaskStateSpy.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

type Pin = { artifactId: string; representationRevisionId: string };
type Pipeline = { runId: string; contextId: string; step: string; leg2: string; post: Pin; picture: Pin };

/** The blog pipeline's run, paused at its marked review step: one declared gate per
 * artifact (the post's on the step's task id, the featured image's on `#2`), from
 * the real `emitDeclaredReviewGateFamily`. The run is internal and repair-capable. */
async function pausedPipeline(): Promise<Pipeline> {
  const runId = `run-blog-${randomUUID()}`;
  const templateId = `tmpl-${randomUUID()}`;
  const taskId = `task-${randomUUID()}`;
  const contextId = `ctx-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
     VALUES ($1,$2,'organization',$2,'seed','seed','[]','{}','{}',$3,$4)`,
    [templateId, ORG, `@cinatra-ai/seed-${templateId}`, JSON.stringify({ repairCapable: true })],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs"
       (id, template_id, org_id, input_params, status, a2a_task_id, a2a_context_id)
     VALUES ($1,$2,$3,'{}','pending_approval',$4,$5)`,
    [runId, templateId, ORG, taskId, contextId],
  );
  const post = { artifactId: `art-post-${randomUUID()}`, representationRevisionId: `rev-post-${randomUUID()}` };
  const picture = { artifactId: `art-img-${randomUUID()}`, representationRevisionId: `rev-img-${randomUUID()}` };
  for (const [id, type] of [[post.artifactId, "document"], [picture.artifactId, "image"]]) {
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, $2, '{}'::jsonb, $3)`,
      [id, type, ORG],
    );
  }
  const step = `wayflow-${taskId}`;
  await gateStore.emitDeclaredReviewGateFamily({ runId, orgId: ORG, reviewTaskId: step, targets: [post, picture] });
  return { runId, contextId, step, leg2: `${step}#2`, post, picture };
}

/** A person presses Regenerate with a note on `reviewTaskId` (the real store entry
 * point); `answer()` is the producer answering with a regenerated picture (the real
 * repair), which pins the successor gate. */
async function pressRegenerate(runId: string, reviewTaskId: string, base: Pin) {
  const cr = await crStore.recordReviewSurfaceChangesRequested({
    runId,
    reviewTaskId,
    baseTarget: base,
    currentBaseRevisionId: base.representationRevisionId,
    feedback: "Make the sky darker",
  });
  if (!cr.ok) throw new Error(`changes_requested refused: ${cr.code}`);
  expect(cr.route.kind).toBe("producer_repair");
  const repairId = cr.repairId;
  const settled = await gateStore.readReviewGate(runId, reviewTaskId);
  expect(settled).toMatchObject({ status: "resolved", disposition: "changes_requested" });
  const settledGateId = settled!.id;
  return { answer: () => answerRegenerate(runId, repairId, settledGateId, base) };
}

async function answerRegenerate(runId: string, repairId: string, settledGateId: string, base: Pin) {
  const regenerated = { artifactId: base.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` };
  const rr = await repairStore.submitRepairResponse({
    repairId,
    currentBaseRevisionId: base.representationRevisionId,
    reauthorized: true,
    response: {
      gateId: settledGateId,
      baseTarget: base,
      successorTarget: regenerated,
      findingOutcomes: [{ findingId: "prompt-window", applied: true }],
      changeSummary: "darker sky",
      producerProvenance: { runId, agentId: null },
    },
  });
  if (!rr.ok) throw new Error(`repair refused: ${rr.code}`);
  expect(isRepairSuccessorTaskId(rr.successorTaskId)).toBe(true);
  return { taskId: rr.successorTaskId, gateId: rr.successorGateId, pin: regenerated };
}

async function regenerate(runId: string, reviewTaskId: string, base: Pin) {
  return (await pressRegenerate(runId, reviewTaskId, base)).answer();
}

/** Continue (approve) a gate the way the decision commit leaves it: the gate CAS and
 * its exactly-once resume intent, which the worker then drains. */
async function approve(runId: string, reviewTaskId: string): Promise<string> {
  const gate = await gateStore.readReviewGate(runId, reviewTaskId);
  expect(gate?.status).toBe("pending");
  const responseText = JSON.stringify(buildReviewApproveEnvelope({
    reviewTaskId, comment: null, targets: gate!.pinnedTargets,
  }));
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
       SET status='resolved', disposition='approve', fingerprint=$2, resolved_at=now()
     WHERE id=$1 AND status='pending'`,
    [gate!.id, `fp-${randomUUID()}`],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
       (gate_id, run_id, review_task_id, kind, response_text) VALUES ($1,$2,$3,'approve',$4)`,
    [gate!.id, runId, reviewTaskId, responseText],
  );
  return responseText;
}

async function runStatus(runId: string): Promise<string> {
  const r = await pool(`SELECT status FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`, [runId]);
  return (r.rows[0] as { status: string }).status;
}

async function pendingGates(runId: string): Promise<string[]> {
  const r = await pool(
    `SELECT review_task_id FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id=$1 AND status='pending'`,
    [runId],
  );
  return (r.rows as { review_task_id: string }[]).map((x) => x.review_task_id);
}

async function intentStatus(runId: string, reviewTaskId: string): Promise<string | undefined> {
  const gate = await gateStore.readReviewGate(runId, reviewTaskId);
  return (await gateStore.readResumeIntent(gate!.id))?.status;
}

/** The run is parked: still pending_approval, and no resume was sent. */
async function expectParked(p: Pipeline) {
  expect(sendTaskSpy).not.toHaveBeenCalled();
  expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
  expect(await runStatus(p.runId)).toBe("pending_approval");
}

/** The run goes on: exactly one resume into the run's context, carrying `text`. */
function expectResumedWith(p: Pipeline, text: string) {
  expect(sendTaskSpy).toHaveBeenCalledTimes(1);
  const req = sendTaskSpy.mock.calls[0][0] as { message: { contextId: string; parts: { text: string }[] } };
  expect(req.message.contextId).toBe(p.contextId);
  expect(req.message.parts[0].text).toBe(text);
  expect(handleWayflowTaskStateSpy).toHaveBeenCalledTimes(1);
  expect(handleWayflowTaskStateSpy.mock.calls[0][0]).toMatchObject({ runId: p.runId, fromStatus: "pending_approval" });
}

describe.skipIf(!HAS_DB)("cinatra#4312 — the run stays parked at the picture's successor gate (real worker)", () => {
  it("PICTURE FIRST: once the post is continued the run stays parked at the successor, and goes on when the successor is continued", async () => {
    const p = await pausedPipeline();
    const successor = await regenerate(p.runId, p.leg2, p.picture);
    expect((await pendingGates(p.runId)).sort()).toEqual([p.step, successor.taskId].sort());

    await approve(p.runId, p.step);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    await expectParked(p);
    expect(await intentStatus(p.runId, p.step)).toBe("done");
    expect(await pendingGates(p.runId)).toEqual([successor.taskId]);

    const text = await approve(p.runId, successor.taskId);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    expectResumedWith(p, text);
    expect(await intentStatus(p.runId, successor.taskId)).toBe("done");
    expect(await pendingGates(p.runId)).toEqual([]);
  });

  it("POST FIRST: the run stays parked through the post's decision and the Regenerate, and goes on when the successor is continued", async () => {
    const p = await pausedPipeline();
    await approve(p.runId, p.step);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    await expectParked(p);

    const successor = await regenerate(p.runId, p.leg2, p.picture);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    await expectParked(p);
    expect(await pendingGates(p.runId)).toEqual([successor.taskId]);

    const text = await approve(p.runId, successor.taskId);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    expectResumedWith(p, text);
    expect(await intentStatus(p.runId, successor.taskId)).toBe("done");
  });

  it("IN FLIGHT: while the producer has not answered the Regenerate yet, the post's decision leaves the run parked", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    await approve(p.runId, p.step);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    await expectParked(p);
    expect(await pendingGates(p.runId)).toEqual([]);

    const successor = await pressed.answer();
    const text = await approve(p.runId, successor.taskId);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    expectResumedWith(p, text);
  });

  it("TWICE: Regenerate on the successor keeps the run parked at the next successor, which alone lets it go on", async () => {
    const p = await pausedPipeline();
    const first = await regenerate(p.runId, p.leg2, p.picture);
    await approve(p.runId, p.step);
    const second = await regenerate(p.runId, first.taskId, first.pin);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    await expectParked(p);
    expect(await pendingGates(p.runId)).toEqual([second.taskId]);

    const text = await approve(p.runId, second.taskId);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    expectResumedWith(p, text);
  });
});
