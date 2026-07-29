/**
 * cinatra#2047 re-acceptance OBS-2 — a repair successor is never dragged into a
 * BATCH gate by a sibling production on the same repair run.
 *
 * The re-acceptance recorded: "the successor revision was gated twice: once by
 * `submitRepairResponse` (the correct successor gate, approved) and once by a
 * BATCH gate on the repair run … `resolveArtifactEffectDisposition` for the
 * successor then answers through the batch gate". It also stated the CONFOUND: the
 * batch existed only because an aborted lane step produced a SECOND artifact on the
 * same repair run.
 *
 * These cases separate the two. Driven on a real Postgres through the SHIPPED
 * entry points (`emitArtifactProduced` → `sweepReviewOrchestration` →
 * `recordReviewSurfaceChangesRequested` → `dispatchPendingProducerRepairs` →
 * `submitRepairResponse` → `sweepLifecycleGateMaintenance`), fence ON:
 *
 *   CLEAN        — one successor, no sibling. Exactly ONE gate pins the successor
 *                  revision (the repair successor gate) and the held effect answers
 *                  through it. The confound-free control.
 *   OBS-2        — the confounded shape: a SECOND artifact on the LANDED repair
 *                  run. The successor stays single-gated and its produced event is
 *                  never linked to the sibling's gate; the sibling is gated
 *                  NORMALLY (its own per-event auto-gate) — #2114's ruling that
 *                  "anything else falls through to normal auto-gating".
 *   OPEN REPAIR  — two productions while the repair is still open: BOTH stay
 *                  pending (the coalescing path honours "an OPEN repair leaves the
 *                  event PENDING" too), and after the repair lands the successor
 *                  settles while the sibling gets its own gate.
 *   STILL BATCHES— three productions on a landed repair run: the two SIBLINGS
 *                  coalesce into one batch partition gate (batching is not disabled
 *                  on a repair run) while the successor is excluded from the sealed
 *                  membership.
 *   NON-REPAIR   — the ordinary multi-artifact production still coalesces into a
 *                  single batch partition gate (no regression).
 *   PRE-FIX EPOCH— an OPEN batch epoch only a pre-fix seal can have produced —
 *                  `sealBatchEpoch` REUSES a frozen membership regardless of the
 *                  candidate set, so excluding the successor from new candidates does
 *                  not protect one. Two shapes, both QUARANTINED (fail closed: no gate,
 *                  nothing marked, effects stay held, epoch left open for ops): a
 *                  landed repair whose successor is frozen, and an epoch sealed while
 *                  the repair was still open.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import {
  producedEventId,
  type ArtifactProducedEvent,
} from "@/lib/lifecycle/lifecycle-produced-event";
import {
  autoReviewTaskId,
  isBatchAutoReviewTaskId,
  isRepairSuccessorTaskId,
} from "@/lib/lifecycle/lifecycle-orchestration";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";

const TEST_SCHEMA = "cinatra_test_lifecycle_2047_obs2";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2047-obs2";
/** The manifest-declared repair capability (`installAgentFromPackage` compiles this
 * onto `agent_templates.lifecycle_config`) — what routes `changes_requested` to the
 * producer instead of a human. */
const MANIFEST_REPAIR_CAPABLE = JSON.stringify({ repairCapable: true });

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let repairStore: typeof import("../lifecycle-repair-store");
let crStore: typeof import("../lifecycle-review-changes-requested-store");
let dispatchStore: typeof import("../lifecycle-repair-dispatch-store");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

async function insertObject(id: string, type: string, orgId = ORG) {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, $2, '{}'::jsonb, $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, type, orgId],
  );
}

async function seedTemplate(packageName: string, lifecycleConfig: string | null): Promise<string> {
  const templateId = `tmpl-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, org_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
     VALUES ($1,$2,'seed','seed','[]','{}','{}',$3,$4)`,
    [templateId, ORG, packageName, lifecycleConfig],
  );
  return templateId;
}

async function seedRun(templateId: string): Promise<string> {
  const runId = `run-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, input_params)
     VALUES ($1,$2,$3,'{}')`,
    [runId, templateId, ORG],
  );
  return runId;
}

async function produce(over: Partial<ArtifactProducedEvent> = {}): Promise<ArtifactProducedEvent> {
  const artifactId = over.artifactId ?? `art-${randomUUID()}`;
  const representationRevisionId = over.representationRevisionId ?? `rev-${randomUUID()}`;
  const ev: ArtifactProducedEvent = {
    eventId: producedEventId(artifactId, representationRevisionId),
    orgId: ORG,
    artifactId,
    representationRevisionId,
    eventKind: "artifact_produced",
    emitter: "createSemanticArtifact",
    producerRunId: over.producerRunId ?? `run-${randomUUID()}`,
    producerAgentId: null,
    originKind: "agent_produced",
    // EXTERNAL on purpose: the disposition join OBS-2 names is only meaningful for
    // an effect-carrying revision.
    destinationClass: "external_publish",
    continuationMode: "async_effects_gated",
    continuationAddress: null,
    ...over,
  };
  await insertObject(ev.artifactId, "document", ev.orgId);
  await outboxStore.emitArtifactProduced(ev, dbMod.db);
  return ev;
}

/** EVERY gate whose frozen `pinned_targets` set contains this revision — the
 * "how many gates own this revision" question OBS-2 turns on. */
async function gatesPinning(artifactId: string, representationRevisionId: string) {
  const r = await pool(
    `SELECT id, run_id, review_task_id, status, disposition
       FROM "${q(TEST_SCHEMA)}"."artifact_review_gates"
      WHERE pinned_targets @> $1::jsonb
      ORDER BY created_at`,
    [JSON.stringify([{ artifactId, representationRevisionId }])],
  );
  return r.rows as Array<{
    id: string;
    run_id: string;
    review_task_id: string;
    status: string;
    disposition: string | null;
  }>;
}

async function outboxRow(eventId: string) {
  const r = await pool(
    `SELECT status, continuation_address
       FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox" WHERE event_id=$1`,
    [eventId],
  );
  return r.rows[0] as { status: string; continuation_address: string | null } | undefined;
}

/** The sealed batch memberships recorded for a production. */
async function batchEpochMemberships(producerRunId: string) {
  const r = await pool(
    `SELECT membership FROM "${q(TEST_SCHEMA)}"."lifecycle_batch_epoch"
      WHERE org_id=$1 AND producer_run_id=$2 ORDER BY sealed_at`,
    [ORG, producerRunId],
  );
  return (r.rows as Array<{ membership: Array<{ artifactId: string; representationRevisionId: string }> }>).map(
    (row) => row.membership,
  );
}

async function resolveGateApprove(gateId: string) {
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
     SET status='resolved', disposition='approve', fingerprint=$2, resolved_at=now()
     WHERE id=$1 AND status='pending'`,
    [gateId, `fp-${randomUUID()}`],
  );
}

/** One full maintenance cycle of the app's own background drains, in the order the
 * boot loops run them — the "let the maintenance sweep run" step of the repro. */
async function runAppSweeps() {
  await orch.sweepReviewOrchestration({ limit: 50 });
  await orch.sweepLifecycleGateMaintenance({ limit: 50 });
  await orch.sweepReviewOrchestration({ limit: 50 });
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
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    if (qy.text.includes("user_slug_move_trg")) continue;
    try {
      await admin.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  outboxStore = await import("../lifecycle-produced-outbox-store");
  gateStore = await import("../artifact-review-gate-store");
  orch = await import("../lifecycle-review-orchestration-store");
  repairStore = await import("../lifecycle-repair-store");
  crStore = await import("../lifecycle-review-changes-requested-store");
  dispatchStore = await import("../lifecycle-repair-dispatch-store");
  dbMod = await import("../db");
}, 90_000);

beforeEach(() => {
  if (!HAS_DB) return;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
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

interface RepairContext {
  base: ArtifactProducedEvent;
  baseGateId: string;
  repairId: string;
  repairRunId: string;
  findingOutcomes: Array<{ findingId: string; applied: boolean }>;
}

/** Drive a produced artifact through auto-gate → typed changes-request → producer
 * repair → delivery, leaving an open repair on its dispatched repair run. */
async function driveToDispatchedRepair(): Promise<RepairContext> {
  const templateId = await seedTemplate(
    `@cinatra-ai/declared-${randomUUID()}-agent`,
    MANIFEST_REPAIR_CAPABLE,
  );
  const producerRunId = await seedRun(templateId);
  const base = await produce({ producerRunId });
  await orch.sweepReviewOrchestration({ limit: 50 });
  const baseGate = await gateStore.readReviewGate(producerRunId, autoReviewTaskId(base.eventId));
  expect(baseGate).not.toBeNull();

  const cr = await crStore.recordReviewSurfaceChangesRequested({
    runId: producerRunId,
    reviewTaskId: autoReviewTaskId(base.eventId),
    baseTarget: {
      artifactId: base.artifactId,
      representationRevisionId: base.representationRevisionId,
    },
    currentBaseRevisionId: base.representationRevisionId,
    feedback: "tighten the headline",
  });
  expect(cr.ok).toBe(true);
  if (!cr.ok) throw new Error(`changes-request failed: ${cr.error}`);
  expect(cr.route.kind).toBe("producer_repair");

  await dispatchStore.dispatchPendingProducerRepairs();
  const repairRunId = dispatchStore.repairRunId(cr.repairId);
  const delivered = await dispatchStore.readDeliveredRepairRequest(repairRunId);
  return {
    base,
    baseGateId: baseGate!.id,
    repairId: cr.repairId,
    repairRunId,
    findingOutcomes: (delivered?.findings ?? []).map((f) => ({ findingId: f.id, applied: true })),
  };
}

/** Land the repair: the producer answers with `successorRev` as the successor. */
async function landRepair(ctx: RepairContext, successorRev: string): Promise<string> {
  const rr = await repairStore.submitRepairResponse({
    repairId: ctx.repairId,
    currentBaseRevisionId: ctx.base.representationRevisionId,
    reauthorized: true,
    response: {
      gateId: ctx.baseGateId,
      baseTarget: {
        artifactId: ctx.base.artifactId,
        representationRevisionId: ctx.base.representationRevisionId,
      },
      successorTarget: {
        artifactId: ctx.base.artifactId,
        representationRevisionId: successorRev,
      },
      findingOutcomes: ctx.findingOutcomes,
      changeSummary: "headline tightened",
      producerProvenance: { runId: ctx.repairRunId, agentId: null },
    },
  });
  expect(rr.ok).toBe(true);
  if (!rr.ok) throw new Error(`repair response failed: ${rr.error}`);
  return rr.successorGateId;
}

describe.skipIf(!HAS_DB)("cinatra#2047 OBS-2 — a repair successor is single-gated", () => {
  it("CLEAN: one successor, no sibling — exactly ONE gate owns the successor revision and the effect answers through it", async () => {
    const ctx = await driveToDispatchedRepair();
    const successorRev = `rev-repaired-${randomUUID()}`;
    await produce({
      artifactId: ctx.base.artifactId,
      representationRevisionId: successorRev,
      producerRunId: ctx.repairRunId,
    });
    const successorGateId = await landRepair(ctx, successorRev);

    // Let the app's own drains run AFTER the repair landed — the exact sequencing
    // the re-acceptance flagged.
    await runAppSweeps();

    const gates = await gatesPinning(ctx.base.artifactId, successorRev);
    expect(gates.map((g) => g.id)).toEqual([successorGateId]);
    expect(isRepairSuccessorTaskId(gates[0].review_task_id)).toBe(true);

    // The successor's OWN produced event is settled and carries NO gate linkage —
    // the successor gate owns the revision; the HELD EFFECT rides the original
    // producing event, which `submitRepairResponse` re-pointed onto that gate.
    const successorEvent = await outboxRow(producedEventId(ctx.base.artifactId, successorRev));
    expect(successorEvent!.status).toBe("processed");
    expect(successorEvent!.continuation_address).toBeNull();

    // Pinned so the next reader does not mistake it for the OBS-2 symptom: querying
    // the SUCCESSOR REVISION's own effect answers `ungated` with NO gate, in this
    // clean shape and in the confounded one alike. That is the S2 contract, not a
    // by-product — `submitRepairResponse` re-points the ORIGINAL producing event
    // (the effect carrier) onto the successor gate and deliberately leaves the
    // successor's own event unlinked. What OBS-2 recorded was a DIFFERENT answer,
    // produced by a sibling's batch gate having captured that linkage.
    const successorOwn = await orch.resolveArtifactEffectDisposition({
      artifactId: ctx.base.artifactId,
      representationRevisionId: successorRev,
    });
    expect(successorOwn).toEqual({ disposition: "ungated", gate: null });

    const heldBefore = await orch.resolveArtifactEffectDisposition({
      artifactId: ctx.base.artifactId,
      representationRevisionId: ctx.base.representationRevisionId,
    });
    expect(heldBefore.disposition).toBe("held");
    expect(heldBefore.gate?.gateId).toBe(successorGateId);

    await resolveGateApprove(successorGateId);
    const released = await orch.resolveArtifactEffectDisposition({
      artifactId: ctx.base.artifactId,
      representationRevisionId: ctx.base.representationRevisionId,
    });
    expect(released.disposition).toBe("approved");
    expect(released.gate?.gateId).toBe(successorGateId);
  });

  it("OBS-2: a SECOND artifact on the landed repair run never drags the successor into a batch gate", async () => {
    const ctx = await driveToDispatchedRepair();
    const successorRev = `rev-repaired-${randomUUID()}`;
    await produce({
      artifactId: ctx.base.artifactId,
      representationRevisionId: successorRev,
      producerRunId: ctx.repairRunId,
    });
    // The confound, driven deliberately: a SECOND artifact on the SAME repair run
    // (the re-acceptance's aborted lane step). Before the fix this made the
    // production multi-artifact, so the sweep took the COALESCING path — which
    // never consulted the repair row and sealed the successor into a batch gate.
    const sibling = await produce({ producerRunId: ctx.repairRunId });

    const successorGateId = await landRepair(ctx, successorRev);
    await resolveGateApprove(successorGateId);
    await runAppSweeps();

    // 1. The successor revision is owned by EXACTLY ONE gate — its successor gate.
    const successorGates = await gatesPinning(ctx.base.artifactId, successorRev);
    expect(successorGates.map((g) => g.id)).toEqual([successorGateId]);
    expect(successorGates.some((g) => isBatchAutoReviewTaskId(g.review_task_id))).toBe(false);

    // 2. Its produced event is settled UNLINKED — the disposition can no longer
    //    answer through a sibling's gate (the OBS-2 "wrong join": the successor
    //    gate had already APPROVED while the batch gate still read pending).
    const successorEvent = await outboxRow(producedEventId(ctx.base.artifactId, successorRev));
    expect(successorEvent!.status).toBe("processed");
    expect(successorEvent!.continuation_address).toBeNull();
    expect(
      await orch.resolveArtifactEffectDisposition({
        artifactId: ctx.base.artifactId,
        representationRevisionId: successorRev,
      }),
    ).toEqual({ disposition: "ungated", gate: null }); // identical to the clean shape.

    // 3. The effect carried by the ORIGINAL producing event answers through the
    //    approved successor gate, not through the sibling's.
    const disposition = await orch.resolveArtifactEffectDisposition({
      artifactId: ctx.base.artifactId,
      representationRevisionId: ctx.base.representationRevisionId,
    });
    expect(disposition.disposition).toBe("approved");
    expect(disposition.gate?.gateId).toBe(successorGateId);

    // 4. Nothing is dropped: the sibling is gated NORMALLY — its own single-target
    //    per-event auto-gate, exactly #2114's "falls through to normal auto-gating".
    const siblingGates = await gatesPinning(sibling.artifactId, sibling.representationRevisionId);
    expect(siblingGates.length).toBe(1);
    expect(siblingGates[0].review_task_id).toBe(autoReviewTaskId(sibling.eventId));
    const siblingEvent = await outboxRow(sibling.eventId);
    expect(siblingEvent!.status).toBe("processed");
    expect(siblingEvent!.continuation_address).toBe(siblingGates[0].id);

    // 5. No sealed batch membership was ever recorded for this repair run.
    expect(await batchEpochMemberships(ctx.repairRunId)).toEqual([]);
  });

  it("OPEN REPAIR: two productions before the response BOTH stay pending, then settle correctly once it lands", async () => {
    const ctx = await driveToDispatchedRepair();
    const successorRev = `rev-repaired-${randomUUID()}`;
    await produce({
      artifactId: ctx.base.artifactId,
      representationRevisionId: successorRev,
      producerRunId: ctx.repairRunId,
    });
    const sibling = await produce({ producerRunId: ctx.repairRunId });

    // The sweep runs while the repair is still OPEN. The single-artifact path
    // already left such an event PENDING; the coalescing path must too — a member
    // sealed into a frozen batch membership now could not be withdrawn once the
    // repair lands and names one of them the successor.
    await runAppSweeps();
    const successorEventId = producedEventId(ctx.base.artifactId, successorRev);
    expect((await outboxRow(successorEventId))!.status).toBe("pending");
    expect((await outboxRow(sibling.eventId))!.status).toBe("pending");
    expect(await gatesPinning(ctx.base.artifactId, successorRev)).toEqual([]);
    expect(await gatesPinning(sibling.artifactId, sibling.representationRevisionId)).toEqual([]);
    expect(await batchEpochMemberships(ctx.repairRunId)).toEqual([]);

    // The repair lands: the successor settles under its successor gate, and the
    // sibling — now `not-claimed` — is gated like any other production.
    const successorGateId = await landRepair(ctx, successorRev);
    await runAppSweeps();

    expect((await outboxRow(successorEventId))!.continuation_address).toBeNull();
    expect((await gatesPinning(ctx.base.artifactId, successorRev)).map((g) => g.id)).toEqual([
      successorGateId,
    ]);
    const siblingGates = await gatesPinning(sibling.artifactId, sibling.representationRevisionId);
    expect(siblingGates.length).toBe(1);
    expect(siblingGates[0].review_task_id).toBe(autoReviewTaskId(sibling.eventId));
  });

  it("STILL BATCHES: two siblings on a landed repair run coalesce with each other, never with the successor", async () => {
    const ctx = await driveToDispatchedRepair();
    const successorRev = `rev-repaired-${randomUUID()}`;
    await produce({
      artifactId: ctx.base.artifactId,
      representationRevisionId: successorRev,
      producerRunId: ctx.repairRunId,
    });
    const siblingA = await produce({ producerRunId: ctx.repairRunId });
    const siblingB = await produce({ producerRunId: ctx.repairRunId });
    const successorGateId = await landRepair(ctx, successorRev);
    await runAppSweeps();

    // Batching is NOT disabled on a repair run: the two siblings are a genuine
    // multi-artifact production and coalesce into ONE batch partition gate.
    const gatesA = await gatesPinning(siblingA.artifactId, siblingA.representationRevisionId);
    const gatesB = await gatesPinning(siblingB.artifactId, siblingB.representationRevisionId);
    expect(gatesA.length).toBe(1);
    expect(gatesB.length).toBe(1);
    expect(gatesA[0].id).toBe(gatesB[0].id);
    expect(isBatchAutoReviewTaskId(gatesA[0].review_task_id)).toBe(true);

    // …and the successor is NOT in the sealed membership, nor in the batch gate.
    const memberships = await batchEpochMemberships(ctx.repairRunId);
    expect(memberships.length).toBe(1);
    expect(memberships[0].map((t) => t.representationRevisionId).sort()).toEqual(
      [siblingA.representationRevisionId, siblingB.representationRevisionId].sort(),
    );
    expect((await gatesPinning(ctx.base.artifactId, successorRev)).map((g) => g.id)).toEqual([
      successorGateId,
    ]);
  });

  it("PRE-FIX EPOCH: an open epoch whose frozen membership already pins the successor fails CLOSED", async () => {
    // `sealBatchEpoch` REUSES an open epoch's frozen membership regardless of the
    // current candidate set, so excluding the successor from the candidates is not
    // enough for an epoch sealed BEFORE this fix. The frozen set cannot be edited
    // (the partition gate ids hash it) and cannot be resealed (an already-emitted
    // partition gate for a co-member would be duplicated), so the sweep must refuse
    // to drive the production rather than emit a gate pinning the successor.
    const ctx = await driveToDispatchedRepair();
    const successorRev = `rev-repaired-${randomUUID()}`;
    await produce({
      artifactId: ctx.base.artifactId,
      representationRevisionId: successorRev,
      producerRunId: ctx.repairRunId,
    });
    const sibling = await produce({ producerRunId: ctx.repairRunId });
    const successorGateId = await landRepair(ctx, successorRev);

    // Seed exactly what a pre-fix pass would have sealed: BOTH revisions frozen.
    const frozen = [
      { artifactId: ctx.base.artifactId, representationRevisionId: successorRev },
      { artifactId: sibling.artifactId, representationRevisionId: sibling.representationRevisionId },
    ];
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."lifecycle_batch_epoch"
         (id, org_id, producer_run_id, membership_hash, membership, target_count, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,'sealed')`,
      [randomUUID(), ORG, ctx.repairRunId, `prefix-${randomUUID()}`, JSON.stringify(frozen), frozen.length],
    );

    const sweep = await orch.sweepReviewOrchestration({ limit: 50 });
    expect(sweep.failed).toBe(1);
    expect(sweep.gatesCreated).toBe(0);

    // Nothing was gated, nothing was marked — the production is untouched and the
    // external effect on each pending revision stays HELD (fail-closed).
    const successorEventId = producedEventId(ctx.base.artifactId, successorRev);
    expect((await outboxRow(successorEventId))!.status).toBe("pending");
    expect((await outboxRow(sibling.eventId))!.status).toBe("pending");
    expect((await gatesPinning(ctx.base.artifactId, successorRev)).map((g) => g.id)).toEqual([
      successorGateId,
    ]);
    expect(await gatesPinning(sibling.artifactId, sibling.representationRevisionId)).toEqual([]);
    expect(
      (
        await orch.isArtifactEffectHeld({
          artifactId: sibling.artifactId,
          representationRevisionId: sibling.representationRevisionId,
        })
      ).held,
    ).toBe(true);

    // The seeded corruption is durable by design (that is the point — it needs ops).
    // Drop it so it does not re-report on every later case's sweep.
    await pool(
      `DELETE FROM "${q(TEST_SCHEMA)}"."lifecycle_batch_epoch" WHERE producer_run_id=$1`,
      [ctx.repairRunId],
    );
  });

  it("PRE-FIX EPOCH (repair still open): quarantined too, and the epoch drain refuses to close it", async () => {
    // The second legacy shape (Codex round 2): a pre-fix pass sealed a membership
    // while the repair was still `dispatched`. ANY frozen member may yet be named
    // the successor, so driving the epoch could pin one in a batch gate before
    // `submitRepairResponse` pins it in its successor gate. Post-fix nothing is ever
    // sealed while a repair is open, so refusing this shape over-quarantines nothing.
    const ctx = await driveToDispatchedRepair();
    const first = await produce({ producerRunId: ctx.repairRunId });
    const second = await produce({ producerRunId: ctx.repairRunId });
    const frozen = [first, second].map((e) => ({
      artifactId: e.artifactId,
      representationRevisionId: e.representationRevisionId,
    }));
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."lifecycle_batch_epoch"
         (id, org_id, producer_run_id, membership_hash, membership, target_count, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,'sealed')`,
      [randomUUID(), ORG, ctx.repairRunId, `prefix-${randomUUID()}`, JSON.stringify(frozen), frozen.length],
    );

    const sweep = await orch.sweepReviewOrchestration({ limit: 50 });
    expect(sweep.failed).toBe(1);
    expect(sweep.gatesCreated).toBe(0);
    expect(await gatesPinning(first.artifactId, first.representationRevisionId)).toEqual([]);
    expect(await gatesPinning(second.artifactId, second.representationRevisionId)).toEqual([]);

    // And once every member is (somehow) non-pending, the independent open-epoch
    // drain must still NOT close it — closing would silently retire the state ops
    // has to reconcile, since the pending-keyed drain can no longer reach it.
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_produced_outbox" SET status='processed'
        WHERE producer_run_id=$1`,
      [ctx.repairRunId],
    );
    await orch.sweepReviewOrchestration({ limit: 50 });
    const stillOpen = await pool(
      `SELECT status FROM "${q(TEST_SCHEMA)}"."lifecycle_batch_epoch" WHERE producer_run_id=$1`,
      [ctx.repairRunId],
    );
    expect((stillOpen.rows[0] as { status: string }).status).toBe("sealed");

    await pool(
      `DELETE FROM "${q(TEST_SCHEMA)}"."lifecycle_batch_epoch" WHERE producer_run_id=$1`,
      [ctx.repairRunId],
    );
  });

  it("NON-REPAIR: an ordinary multi-artifact production still coalesces (no regression)", async () => {
    const templateId = await seedTemplate(`@cinatra-ai/plain-${randomUUID()}-agent`, null);
    const runId = await seedRun(templateId);
    const first = await produce({ producerRunId: runId });
    const second = await produce({ producerRunId: runId });
    await runAppSweeps();

    const gatesFirst = await gatesPinning(first.artifactId, first.representationRevisionId);
    const gatesSecond = await gatesPinning(second.artifactId, second.representationRevisionId);
    expect(gatesFirst.length).toBe(1);
    expect(gatesFirst[0].id).toBe(gatesSecond[0]?.id);
    expect(isBatchAutoReviewTaskId(gatesFirst[0].review_task_id)).toBe(true);
    const memberships = await batchEpochMemberships(runId);
    expect(memberships.length).toBe(1);
    expect(memberships[0].length).toBe(2);
  });
});
