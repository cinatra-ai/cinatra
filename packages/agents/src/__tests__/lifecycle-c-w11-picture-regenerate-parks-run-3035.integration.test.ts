/**
 * cinatra#4312 (#3035 W11) — Regenerate on the featured image's review keeps the
 * blog pipeline's run PARKED at the successor gate, and the run goes on only once
 * that gate is continued.
 *
 * Real store, real repair loop, real resume worker (`sweepArtifactReviewResumeIntents`
 * over the real resume outbox). Replaced: the WayFlow side, i.e. the A2A client
 * (its `sendTask` is the resume of the paused run) and the task-state handler that
 * a sent resume drives, and the worker's install-scope recheck
 * (`assertAgentRunDispatchAuthorized`, which reads a run principal this suite does
 * not seed). So "parked" reads as: the run is still `pending_approval` and no
 * resume was sent; "goes on" reads as: exactly one resume was sent into the run's
 * context, carrying the decision the case names.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://… \
 *     pnpm --filter @cinatra-ai/agents test:integration lifecycle-c-w11-picture-regenerate-parks-run-3035
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { buildReviewApproveEnvelope } from "@/lib/artifacts/artifact-review-rejection";
import {
  REPAIR_SUCCESSOR_TASK_PREFIX,
  autoReviewTaskId,
  isRepairSuccessorTaskId,
} from "@/lib/lifecycle/lifecycle-orchestration";
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
 * the real `emitDeclaredReviewGateFamily`. The run is internal and, unless a case
 * says otherwise, repair-capable. */
async function pausedPipeline(repairCapable = true): Promise<Pipeline> {
  const runId = `run-blog-${randomUUID()}`;
  const templateId = `tmpl-${randomUUID()}`;
  const taskId = `task-${randomUUID()}`;
  const contextId = `ctx-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
     VALUES ($1,$2,'organization',$2,'seed','seed','[]','{}','{}',$3,$4)`,
    [templateId, ORG, `@cinatra-ai/seed-${templateId}`, JSON.stringify({ repairCapable })],
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
  return {
    repairId,
    settledGateId,
    answer: (regenerated?: Pin) => answerRegenerate(runId, repairId, settledGateId, base, regenerated),
  };
}

async function answerRegenerate(runId: string, repairId: string, settledGateId: string, base: Pin, pin?: Pin) {
  const regenerated = pin ?? { artifactId: base.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` };
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

  it("ESCALATED: Regenerate on #2 with a producer that cannot repair opens no successor, so the post's decision lets the run go on", async () => {
    const p = await pausedPipeline(false);
    const cr = await crStore.recordReviewSurfaceChangesRequested({
      runId: p.runId,
      reviewTaskId: p.leg2,
      baseTarget: p.picture,
      currentBaseRevisionId: p.picture.representationRevisionId,
      feedback: "Make the sky darker",
    });
    expect(cr).toMatchObject({ ok: true, status: "escalated" });
    const leg = await gateStore.readReviewGate(p.runId, p.leg2);
    expect(leg).toMatchObject({ status: "resolved", disposition: "changes_requested" });
    expect(await repairStore.isRepairLineageOpen(leg!.id)).toBe(false);
    expect(await pendingGates(p.runId)).toEqual([p.step]);

    const text = await approve(p.runId, p.step);
    await resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
    expectResumedWith(p, text);
    expect(await intentStatus(p.runId, p.step)).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// cinatra#4312, review 1 of cinatra#4339 — the roads the first cases left out.
// ---------------------------------------------------------------------------

async function sweep() {
  return resumeDelivery.sweepArtifactReviewResumeIntents({ limit: 50 });
}

async function repairOf(repairId: string): Promise<{ status: string; lineage_id: string; successor_gate_id: string | null }> {
  const r = await pool(
    `SELECT status, lineage_id, successor_gate_id FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE id=$1`,
    [repairId],
  );
  return r.rows[0] as { status: string; lineage_id: string; successor_gate_id: string | null };
}

async function setRepair(repairId: string, assignment: string, values: unknown[] = []) {
  await pool(`UPDATE "${q(TEST_SCHEMA)}"."lifecycle_repair" SET ${assignment} WHERE id=$1`, [repairId, ...values]);
}

/** A representation row for `pin` (the default verification projector reads
 * revision, resource and form from it). */
async function seedRepresentation(pin: Pin, revision: number) {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."representation" (id, org_id, artifact_id, resource_id, revision, form)
     VALUES ($1,$2,$3,$4,$5,'file')`,
    [pin.representationRevisionId, ORG, pin.artifactId, `res-${randomUUID()}`, revision],
  );
}

/** A decided gate row written straight to the table, with its resume intent. */
async function decidedGateWithIntent(runId: string, reviewTaskId: string, pin: Pin): Promise<string> {
  const id = `gate-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_review_gates"
       (id, run_id, org_id, review_task_id, status, pinned_targets, disposition, fingerprint, resolved_at)
     VALUES ($1,$2,$3,$4,'resolved',$5::jsonb,'approve',$6,now())`,
    [id, runId, ORG, reviewTaskId, JSON.stringify([pin]), `fp-${randomUUID()}`],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_review_resume_outbox"
       (gate_id, run_id, review_task_id, kind, response_text) VALUES ($1,$2,$3,'approve','{}')`,
    [id, runId, reviewTaskId],
  );
  return id;
}

async function intentStatusOf(gateId: string): Promise<string | undefined> {
  return (await gateStore.readResumeIntent(gateId))?.status;
}

/** The sweep did not act on an unreadable lineage: it failed, sent nothing and
 * left the intent for re-claim (still leased, never `done`). */
async function expectLeftForReclaim(summary: { failed: number }, gateId: string) {
  expect(summary.failed).toBeGreaterThanOrEqual(1);
  expect(sendTaskSpy).not.toHaveBeenCalled();
  expect(handleWayflowTaskStateSpy).not.toHaveBeenCalled();
  expect(await intentStatusOf(gateId)).toBe("delivering");
}

describe.skipIf(!HAS_DB)("cinatra#4312 — a lineage that closes with no successor wakes the paused run (finding 1)", () => {
  it("POST FIRST, then Regenerate with a producer that cannot repair: the escalation wakes the post's decision and the run goes on", async () => {
    const p = await pausedPipeline(false);
    const text = await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    expect(await intentStatus(p.runId, p.step)).toBe("done");

    const cr = await crStore.recordReviewSurfaceChangesRequested({
      runId: p.runId,
      reviewTaskId: p.leg2,
      baseTarget: p.picture,
      currentBaseRevisionId: p.picture.representationRevisionId,
      feedback: "Make the sky darker",
    });
    expect(cr).toMatchObject({ ok: true, status: "escalated" });
    expect(await pendingGates(p.runId)).toEqual([]);
    expect(await intentStatus(p.runId, p.step)).toBe("pending");

    await sweep();
    expectResumedWith(p, text);
    expect(await intentStatus(p.runId, p.step)).toBe("done");
  });

  it("STALE: the post is continued while the repair waits, then the producer answers against a moved base; the stale lineage wakes the post's decision", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const text = await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);

    const rr = await repairStore.submitRepairResponse({
      repairId: pressed.repairId,
      currentBaseRevisionId: `rev-img-moved-${randomUUID()}`,
      reauthorized: true,
      response: {
        gateId: pressed.settledGateId,
        baseTarget: p.picture,
        successorTarget: { artifactId: p.picture.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` },
        findingOutcomes: [{ findingId: "prompt-window", applied: true }],
        changeSummary: "darker sky",
        producerProvenance: { runId: p.runId, agentId: null },
      },
    });
    expect(rr).toMatchObject({ ok: false, code: "stale-base" });
    expect((await repairOf(pressed.repairId)).status).toBe("stale");
    expect(await pendingGates(p.runId)).toEqual([]);

    await sweep();
    expectResumedWith(p, text);
  });

  it("ESCALATED LATER: the post is continued while the repair waits, then the dispatch drain escalates it (no human principal); the escalation wakes the post's decision", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const text = await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);

    // This case's repair is the only one waiting, so the drain touches no other case.
    const waiting = await pool(`SELECT id FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE status='requested'`);
    expect(waiting.rows).toEqual([{ id: pressed.repairId }]);
    const { dispatchPendingProducerRepairs } = await import("../lifecycle-repair-dispatch-store");
    const drained = await dispatchPendingProducerRepairs({ limit: 200 });
    expect(drained).toMatchObject({ escalated: 1, dispatched: 0 });
    expect((await repairOf(pressed.repairId)).status).toBe("escalated");

    await sweep();
    expectResumedWith(p, text);
  });
});

describe.skipIf(!HAS_DB)("cinatra#4312 — the wake also reaches a decision a worker holds at that moment (finding 1, race)", () => {
  it("IN-FLIGHT: the post's intent is leased when the lineage goes stale; the holder's acknowledgement no longer lands and the next sweep lets the run go on", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const text = await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    const claimed = await gateStore.claimPendingResumeIntents({ limit: 50, leaseMs: 300_000 });
    const held = claimed.find((c) => c.gateId === post!.id);
    expect(held?.status).toBe("delivering");

    const rr = await repairStore.submitRepairResponse({
      repairId: pressed.repairId,
      currentBaseRevisionId: `rev-img-moved-${randomUUID()}`,
      reauthorized: true,
      response: {
        gateId: pressed.settledGateId,
        baseTarget: p.picture,
        successorTarget: { artifactId: p.picture.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` },
        findingOutcomes: [{ findingId: "prompt-window", applied: true }],
        changeSummary: "darker sky",
        producerProvenance: { runId: p.runId, agentId: null },
      },
    });
    expect(rr).toMatchObject({ ok: false, code: "stale-base" });
    // The holder read the lineage as open before the stale commit and now tries to
    // acknowledge without sending: the wake took its lease, so that write misses.
    expect(await gateStore.markResumeIntentDelivered(post!.id, held!.leaseToken!)).toBe(false);
    expect(await intentStatusOf(post!.id)).toBe("pending");

    await sweep();
    expectResumedWith(p, text);
  });
});

describe.skipIf(!HAS_DB)("cinatra#4312 — one new pending gate per Regenerate on real representations (finding 2)", () => {
  it("a regenerated picture whose revision and resource differ opens only its successor; the verdict is recorded on that successor", async () => {
    const p = await pausedPipeline();
    await seedRepresentation(p.picture, 1);
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const regenerated = { artifactId: p.picture.artifactId, representationRevisionId: `rev-img-r-${randomUUID()}` };
    await seedRepresentation(regenerated, 2);
    const { defaultRepresentationFieldProjector } = await import("../lifecycle-verification-store");
    expect(await defaultRepresentationFieldProjector(ORG)(regenerated)).toMatchObject({ "representation.revision": "2" });

    const successor = await pressed.answer(regenerated);
    expect((await pendingGates(p.runId)).sort()).toEqual([p.step, successor.taskId].sort());
    const record = await pool(
      `SELECT outcome FROM "${q(TEST_SCHEMA)}"."artifact_verification_records" WHERE gate_id=$1`,
      [successor.gateId],
    );
    expect(record.rows).toEqual([{ outcome: "drifted" }]);

    await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    const text = await approve(p.runId, successor.taskId);
    await sweep();
    expectResumedWith(p, text);
    expect(await pendingGates(p.runId)).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("cinatra#4312 — the successor is a new revision of the reviewed picture (finding 3)", () => {
  it("a repair answer that pins the post, or any other artifact, is refused and pins nothing; the picture's own regeneration is accepted", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    for (const other of [p.post.artifactId, `art-other-${randomUUID()}`]) {
      const rr = await repairStore.submitRepairResponse({
        repairId: pressed.repairId,
        currentBaseRevisionId: p.picture.representationRevisionId,
        reauthorized: true,
        response: {
          gateId: pressed.settledGateId,
          baseTarget: p.picture,
          successorTarget: { artifactId: other, representationRevisionId: `rev-other-${randomUUID()}` },
          findingOutcomes: [{ findingId: "prompt-window", applied: true }],
          changeSummary: "darker sky",
          producerProvenance: { runId: p.runId, agentId: null },
        },
      });
      expect(rr).toMatchObject({ ok: false, code: "successor-other-artifact" });
      expect(await pendingGates(p.runId)).toEqual([p.step]);
      expect((await repairOf(pressed.repairId)).status).toBe("requested");
    }
    const successor = await pressed.answer();
    expect(successor.pin.artifactId).toBe(p.picture.artifactId);
    expect((await pendingGates(p.runId)).sort()).toEqual([p.step, successor.taskId].sort());
  });
});

describe.skipIf(!HAS_DB)("cinatra#4312 — the lineage readers fail closed with a named error (finding 4)", () => {
  it("a picture leg settled as changes requested with no repair row: the post's decision resumes nothing (missing-repair)", async () => {
    const p = await pausedPipeline();
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
         SET status='resolved', disposition='changes_requested', fingerprint=$3, resolved_at=now()
       WHERE run_id=$1 AND review_task_id=$2`,
      [p.runId, p.leg2, `fp-${randomUUID()}`],
    );
    const leg = await gateStore.readReviewGate(p.runId, p.leg2);
    await expect(repairStore.isRepairLineageOpen(leg!.id)).rejects.toMatchObject({ code: "missing-repair" });
    await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    await expectLeftForReclaim(await sweep(), post!.id);
    expect(await runStatus(p.runId)).toBe("pending_approval");
  });

  it("a latest attempt in a status the reader does not know: the post's decision resumes nothing (unknown-repair-status)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    await pressed.answer();
    await setRepair(pressed.repairId, "status='superseded'");
    await expect(repairStore.isRepairLineageOpen(pressed.settledGateId)).rejects.toMatchObject({ code: "unknown-repair-status" });
    await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    await expectLeftForReclaim(await sweep(), post!.id);
  });

  it("a repaired attempt with no successor id: the post's decision is neither resumed nor acknowledged (repaired-without-successor)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    await pressed.answer();
    await setRepair(pressed.repairId, "successor_gate_id=NULL");
    await expect(repairStore.isRepairLineageOpen(pressed.settledGateId)).rejects.toMatchObject({ code: "repaired-without-successor" });
    await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    await expectLeftForReclaim(await sweep(), post!.id);
  });

  it("a repaired attempt whose successor gate is missing: the post's decision is neither resumed nor acknowledged (missing-successor-gate)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    await pressed.answer();
    await setRepair(pressed.repairId, "successor_gate_id=$2", [`gate-gone-${randomUUID()}`]);
    await expect(repairStore.isRepairLineageOpen(pressed.settledGateId)).rejects.toMatchObject({ code: "missing-successor-gate" });
    await approve(p.runId, p.step);
    const post = await gateStore.readReviewGate(p.runId, p.step);
    await expectLeftForReclaim(await sweep(), post!.id);
  });

  it("a known repair whose root gate is missing: the successor's decision is not acknowledged on the automatic road (missing-root-gate)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const successor = await pressed.answer();
    await setRepair(pressed.repairId, "lineage_id=$2", [`gate-gone-${randomUUID()}`]);
    await expect(repairStore.readRepairLineageRootGate(successor.taskId, successor.gateId)).rejects.toMatchObject({ code: "missing-root-gate" });
    await approve(p.runId, successor.taskId);
    await expectLeftForReclaim(await sweep(), successor.gateId);
  });

  it("a successor task that names another attempt of a real repair is refused (attempt-mismatch)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const successor = await pressed.answer();
    await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    const task = `${REPAIR_SUCCESSOR_TASK_PREFIX}${pressed.repairId}:7`;
    const forged = await decidedGateWithIntent(p.runId, task, successor.pin);
    await expect(repairStore.readRepairLineageRootGate(task, forged)).rejects.toMatchObject({ code: "attempt-mismatch" });
    await expectLeftForReclaim(await sweep(), forged);
  });

  it("a gate that carries a real successor task id but is not that repair's successor is refused (successor-mismatch)", async () => {
    const p = await pausedPipeline();
    const pressed = await pressRegenerate(p.runId, p.leg2, p.picture);
    const successor = await pressed.answer();
    await approve(p.runId, p.step);
    await sweep();
    await expectParked(p);
    const forged = await decidedGateWithIntent(`run-other-${randomUUID()}`, successor.taskId, successor.pin);
    await expect(repairStore.readRepairLineageRootGate(successor.taskId, forged)).rejects.toMatchObject({ code: "successor-mismatch" });
    await expectLeftForReclaim(await sweep(), forged);
  });

  it("a successor task id with no attempt is refused (malformed-successor-task)", async () => {
    const p = await pausedPipeline();
    const task = `${REPAIR_SUCCESSOR_TASK_PREFIX}not-a-repair`;
    const forged = await decidedGateWithIntent(p.runId, task, p.picture);
    await expect(repairStore.readRepairLineageRootGate(task, forged)).rejects.toMatchObject({ code: "malformed-successor-task" });
    await expectLeftForReclaim(await sweep(), forged);
  });
});

describe.skipIf(!HAS_DB)("cinatra#4312 — the roads that stay as they were, against the real store (review 1 LOW 6, SC S3)", () => {
  it("the successor of an ORDINARY automatic gate keeps the automatic-gate road: its intent is acknowledged and nothing is sent", async () => {
    const p = await pausedPipeline();
    const pin = { artifactId: `art-auto-${randomUUID()}`, representationRevisionId: `rev-auto-${randomUUID()}` };
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, 'document', '{}'::jsonb, $2)`,
      [pin.artifactId, ORG],
    );
    const autoTask = autoReviewTaskId(`ev-${randomUUID()}`);
    await gateStore.emitArtifactReviewGate({ runId: p.runId, orgId: ORG, reviewTaskId: autoTask, targets: [pin] });
    const successor = await regenerate(p.runId, autoTask, pin);
    await approve(p.runId, successor.taskId);
    const summary = await sweep();
    expect(summary.failed).toBe(0);
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(await intentStatus(p.runId, successor.taskId)).toBe("done");
    expect(await runStatus(p.runId)).toBe("pending_approval");
  });

  it("the successor of a repair that started on the post's own leg keeps the automatic-gate road", async () => {
    const p = await pausedPipeline();
    const postGate = await gateStore.readReviewGate(p.runId, p.step);
    const key = `k-${randomUUID()}`;
    const cr = await repairStore.recordChangesRequested({
      runId: p.runId,
      reviewTaskId: p.step,
      orgId: ORG,
      request: {
        gateId: postGate!.id,
        decisionId: key,
        idempotencyKey: key,
        baseTarget: p.post,
        expectedBaseRevisionId: p.post.representationRevisionId,
        findings: [{ id: "prompt-window", message: "Tighten the intro" }],
        continuationMode: "async_effects_gated",
        continuationAddress: null,
      },
      repairCapable: true,
      producerRunId: p.runId,
      currentBaseRevisionId: p.post.representationRevisionId,
    });
    if (!cr.ok) throw new Error(`changes_requested refused: ${cr.code}`);
    const successor = await answerRegenerate(p.runId, cr.repairId, postGate!.id, p.post);
    await approve(p.runId, successor.taskId);
    const summary = await sweep();
    expect(summary.failed).toBe(0);
    expect(sendTaskSpy).not.toHaveBeenCalled();
    expect(await intentStatus(p.runId, successor.taskId)).toBe("done");
  });

  it("SUCCESSOR FIRST, post last: the successor's decision is set aside while the post is open, and the post's decision lets the run go on", async () => {
    const p = await pausedPipeline();
    const successor = await regenerate(p.runId, p.leg2, p.picture);
    await approve(p.runId, successor.taskId);
    await sweep();
    await expectParked(p);
    expect(await intentStatus(p.runId, successor.taskId)).toBe("done");

    const text = await approve(p.runId, p.step);
    await sweep();
    expectResumedWith(p, text);
  });
});
