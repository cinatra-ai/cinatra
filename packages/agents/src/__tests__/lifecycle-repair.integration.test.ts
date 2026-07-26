/**
 * cinatra#2040 (epic #2037 S2) — REAL-store proofs of the repair loop against real
 * DDL + constraints (fresh schema per file from the CANONICAL
 * `buildCreateStoreSchemaQueries` bootstrap — the migration core__0081 twin):
 *
 *   REPAIR     — a full round-trip: auto gate → changes_requested (2 findings)
 *                CLOSES the review attempt (gate resolved 'changes_requested', effect
 *                still HELD) + opens a repair → the producer repairs → a NEW successor
 *                gate pins the repaired revision + the effect re-points onto it →
 *                approve releases the effect; the lineage + audit are recorded.
 *   CAS        — a moved base (CAS witness mismatch) is rejected as STALE at
 *                changes_requested AND marks a submitted repair stale; a tombstoned
 *                base is rejected.
 *   CYCLE      — the cycle guard trips at the bound and ESCALATES (no unbounded reopen).
 *   ROUTE      — a non-repairing producer routes changes_requested to a human (never drops).
 *   BATCH      — the durable per-epoch aggregate disposition matrix (approved /
 *                changes_requested / rejected / partially_approved), idempotent.
 *   SEAL       — the >50-target DURABLE sealed-membership epoch closes S1's crash-window:
 *                a crash after a partition emit + a NEW revision arriving does NOT
 *                grow the frozen membership; the re-sweep pins EXACTLY the sealed set;
 *                the new revisions seal a SUCCESSOR epoch.
 *   EFFICACY   — the routed rejected-recommendation efficacy row persists durably.
 *   FENCE      — the repair drains are inert (nothing here runs) with the fence off.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/s2_2040 \
 *     pnpm --filter @cinatra-ai/agents test:integration lifecycle-repair
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
  batchPartitionReviewTaskId,
  isBatchAutoReviewTaskId,
  repairSuccessorReviewTaskId,
} from "@/lib/lifecycle/lifecycle-orchestration";
import { partitionBatchTargets, type BatchTarget } from "@/lib/lifecycle/lifecycle-batch";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import type { ChangesRequestedRequest } from "@/lib/lifecycle/lifecycle-repair";

const TEST_SCHEMA = "cinatra_test_lifecycle_2040";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2040-repair";

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let repairStore: typeof import("../lifecycle-repair-store");
let recoveryStore: typeof import("../lifecycle-repair-recovery-store");
let crStore: typeof import("../lifecycle-review-changes-requested-store");
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

function mkEvent(over: Partial<ArtifactProducedEvent> = {}): ArtifactProducedEvent {
  const artifactId = over.artifactId ?? `art-${randomUUID()}`;
  const representationRevisionId = over.representationRevisionId ?? `rev-${randomUUID()}`;
  return {
    eventId: producedEventId(artifactId, representationRevisionId),
    orgId: ORG,
    artifactId,
    representationRevisionId,
    eventKind: "artifact_produced",
    emitter: "createSemanticArtifact",
    producerRunId: `run-${randomUUID()}`,
    producerAgentId: null,
    originKind: "agent_produced",
    destinationClass: "none",
    continuationMode: "async_effects_gated",
    continuationAddress: null,
    ...over,
  };
}

async function produce(type: string, over: Partial<ArtifactProducedEvent> = {}): Promise<ArtifactProducedEvent> {
  const ev = mkEvent(over);
  await insertObject(ev.artifactId, type, ev.orgId);
  await outboxStore.emitArtifactProduced(ev, dbMod.db);
  return ev;
}

async function resolveGateApprove(gateId: string) {
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
     SET status='resolved', disposition='approve', fingerprint=$2, resolved_at=now()
     WHERE id=$1 AND status='pending'`,
    [gateId, `fp-${randomUUID()}`],
  );
}

async function gatesForRun(runId: string): Promise<Array<{ id: string; reviewTaskId: string; pinned: BatchTarget[] }>> {
  const r = await pool(
    `SELECT id, review_task_id, pinned_targets FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id=$1`,
    [runId],
  );
  return (r.rows as Array<{ id: string; review_task_id: string; pinned_targets: BatchTarget[] }>).map((x) => ({
    id: x.id,
    reviewTaskId: x.review_task_id,
    pinned: x.pinned_targets,
  }));
}

async function eventRow(eventId: string) {
  const r = await pool(
    `SELECT status, continuation_address FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox" WHERE event_id=$1`,
    [eventId],
  );
  return r.rows[0] as { status: string; continuation_address: string | null } | undefined;
}

function mkChangesRequested(ev: ArtifactProducedEvent, gateId: string, over: Partial<ChangesRequestedRequest> = {}): ChangesRequestedRequest {
  return {
    gateId,
    decisionId: `dec-${randomUUID()}`,
    idempotencyKey: `idem-${randomUUID()}`,
    baseTarget: { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
    expectedBaseRevisionId: ev.representationRevisionId,
    findings: [
      { id: "f1", message: "tighten the headline" },
      { id: "f2", message: "add a CTA" },
    ],
    continuationMode: "async_effects_gated",
    continuationAddress: null,
    ...over,
  };
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
  recoveryStore = await import("../lifecycle-repair-recovery-store");
  crStore = await import("../lifecycle-review-changes-requested-store");
  dbMod = await import("../db");
}, 90_000);

/** Seed a repair-capable producing run + template so the surface composer resolves
 * `repairCapable: true` from `agent_templates.lifecycle_config` (the route → a live
 * producer repair). Minimal NOT-NULL columns only. */
async function seedRepairCapableProducer(runId: string): Promise<void> {
  const templateId = `tmpl-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, org_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
     VALUES ($1,$2,'seed','seed','[]','{}','{}',$3,$4) ON CONFLICT (id) DO NOTHING`,
    [templateId, ORG, `@cinatra-ai/seed-${templateId}`, JSON.stringify({ repairCapable: true })],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, input_params)
     VALUES ($1,$2,$3,'{}') ON CONFLICT (id) DO NOTHING`,
    [runId, templateId, ORG],
  );
}

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

describe.skipIf(!HAS_DB)("cinatra#2040 — repair loop (real store)", () => {
  it("REPAIR: full round-trip — changes_requested closes the attempt + holds the effect; the repair pins a successor gate; approve releases", async () => {
    const ev = await produce("document", { destinationClass: "external_publish" });
    await orch.sweepReviewOrchestration();
    const baseTaskId = autoReviewTaskId(ev.eventId);
    const baseGate = await gateStore.readReviewGate(ev.producerRunId!, baseTaskId);
    expect(baseGate).not.toBeNull();

    // The external effect is HELD by the pending gate.
    const heldPending = await orch.isArtifactEffectHeld({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(heldPending.held).toBe(true);

    // changes_requested (2 findings), repair-capable producer, base unmoved.
    const req = mkChangesRequested(ev, baseGate!.id);
    const cr = await repairStore.recordChangesRequested({
      runId: ev.producerRunId!,
      reviewTaskId: baseTaskId,
      orgId: ORG,
      request: req,
      repairCapable: true,
      producerRunId: ev.producerRunId,
      currentBaseRevisionId: ev.representationRevisionId,
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;
    expect(cr.status).toBe("requested");
    expect(cr.route.kind).toBe("producer_repair");
    expect(cr.attempt).toBe(1);

    // The base gate is RESOLVED as changes_requested — the review attempt closed.
    const closed = await gateStore.readReviewGate(ev.producerRunId!, baseTaskId);
    expect(closed!.status).toBe("resolved");
    expect(closed!.disposition).toBe("changes_requested");

    // The effect stays HELD (repair in flight) despite the resolved base gate.
    const heldDuringRepair = await orch.isArtifactEffectHeld({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(heldDuringRepair.held).toBe(true);

    // The producer repairs: a NEW successor revision pinned in a NEW gate.
    const successorRev = `rev-repaired-${randomUUID()}`;
    const rr = await repairStore.submitRepairResponse({
      repairId: cr.repairId,
      currentBaseRevisionId: ev.representationRevisionId,
      reauthorized: true,
      response: {
        gateId: req.gateId,
        baseTarget: req.baseTarget,
        successorTarget: { artifactId: ev.artifactId, representationRevisionId: successorRev },
        findingOutcomes: [
          { findingId: "f1", applied: true },
          { findingId: "f2", applied: true },
        ],
        changeSummary: "retitled + added CTA",
        producerProvenance: { runId: ev.producerRunId, agentId: null },
      },
    });
    expect(rr.ok).toBe(true);
    if (!rr.ok) return;

    const successorGate = await pool(
      `SELECT status, pinned_targets FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE id=$1`,
      [rr.successorGateId],
    );
    expect((successorGate.rows[0] as { status: string }).status).toBe("pending");
    expect((successorGate.rows[0] as { pinned_targets: BatchTarget[] }).pinned_targets).toEqual([
      { artifactId: ev.artifactId, representationRevisionId: successorRev },
    ]);

    // The base event's held effect RE-POINTED onto the successor gate; still held.
    const rept = await eventRow(ev.eventId);
    expect(rept?.continuation_address).toBe(rr.successorGateId);
    const heldAwaitingSuccessor = await orch.isArtifactEffectHeld({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(heldAwaitingSuccessor.held).toBe(true);

    // Approve the successor → the effect RELEASES.
    await resolveGateApprove(rr.successorGateId);
    const released = await orch.isArtifactEffectHeld({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(released.held).toBe(false);

    // The lineage + audit are recorded.
    const lineage = await repairStore.readRepairLineage(req.gateId);
    expect(lineage).toHaveLength(1);
    expect(lineage[0].status).toBe("repaired");
    expect(lineage[0].successorGateId).toBe(rr.successorGateId);
    const audit = await gateStore.readGateAuditRows(req.gateId);
    expect(audit.some((a) => a.disposition === "changes_requested")).toBe(true);
  });

  it("CAS: a moved base is rejected as STALE at changes_requested; a tombstoned base is rejected", async () => {
    const ev = await produce("document", { destinationClass: "external_publish" });
    await orch.sweepReviewOrchestration();
    const taskId = autoReviewTaskId(ev.eventId);
    const gate = await gateStore.readReviewGate(ev.producerRunId!, taskId);

    const stale = await repairStore.recordChangesRequested({
      runId: ev.producerRunId!,
      reviewTaskId: taskId,
      orgId: ORG,
      request: mkChangesRequested(ev, gate!.id),
      repairCapable: true,
      currentBaseRevisionId: "rev-moved", // base moved since the review
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("stale-base");

    const tomb = await repairStore.recordChangesRequested({
      runId: ev.producerRunId!,
      reviewTaskId: taskId,
      orgId: ORG,
      request: mkChangesRequested(ev, gate!.id),
      repairCapable: true,
      currentBaseRevisionId: null, // tombstoned
    });
    expect(tomb.ok).toBe(false);
    if (!tomb.ok) expect(tomb.code).toBe("tombstoned-base");
  });

  it("CAS: a submitted repair whose base moved is marked STALE", async () => {
    const ev = await produce("document", { destinationClass: "external_publish" });
    await orch.sweepReviewOrchestration();
    const taskId = autoReviewTaskId(ev.eventId);
    const gate = await gateStore.readReviewGate(ev.producerRunId!, taskId);
    const req = mkChangesRequested(ev, gate!.id);
    const cr = await repairStore.recordChangesRequested({
      runId: ev.producerRunId!,
      reviewTaskId: taskId,
      orgId: ORG,
      request: req,
      repairCapable: true,
      currentBaseRevisionId: ev.representationRevisionId,
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    const rr = await repairStore.submitRepairResponse({
      repairId: cr.repairId,
      currentBaseRevisionId: "rev-moved-after", // moved between the request and the repair
      reauthorized: true,
      response: {
        gateId: req.gateId,
        baseTarget: req.baseTarget,
        successorTarget: { artifactId: ev.artifactId, representationRevisionId: `rev-${randomUUID()}` },
        findingOutcomes: [
          { findingId: "f1", applied: true },
          { findingId: "f2", applied: true },
        ],
        changeSummary: "x",
        producerProvenance: { runId: ev.producerRunId, agentId: null },
      },
    });
    expect(rr.ok).toBe(false);
    if (!rr.ok) expect(rr.code).toBe("stale-base");
    const repair = await repairStore.readRepair(cr.repairId);
    expect(repair?.status).toBe("stale");
  });

  it("CYCLE: the cycle guard trips at the bound and ESCALATES (no unbounded reopen)", async () => {
    // A shared lineage; each changes_requested on a fresh gate carries the SAME
    // lineage id so the cycle guard counts the whole chain.
    const lineageId = `lineage-${randomUUID()}`;
    const maxCycles = 3;
    let lastStatus = "";
    let lastRoute = "";
    for (let i = 1; i <= maxCycles + 1; i++) {
      const ev = await produce("document", { destinationClass: "external_publish" });
      await orch.sweepReviewOrchestration();
      const taskId = autoReviewTaskId(ev.eventId);
      const gate = await gateStore.readReviewGate(ev.producerRunId!, taskId);
      const cr = await repairStore.recordChangesRequested({
        runId: ev.producerRunId!,
        reviewTaskId: taskId,
        orgId: ORG,
        request: mkChangesRequested(ev, gate!.id),
        repairCapable: true,
        currentBaseRevisionId: ev.representationRevisionId,
        lineageId,
        maxCycles,
      });
      expect(cr.ok).toBe(true);
      if (!cr.ok) return;
      lastStatus = cr.status;
      lastRoute = cr.route.kind;
      if (i <= maxCycles) {
        expect(cr.status).toBe("requested");
        expect(cr.attempt).toBe(i);
      }
    }
    // The (maxCycles+1)-th attempt escalates — never dispatches another repair.
    expect(lastStatus).toBe("escalated");
    expect(lastRoute).toBe("producer_repair"); // route is producer, but the cycle bound forces escalation
  });

  it("ROUTE: a non-repairing producer routes changes_requested to a human (never drops)", async () => {
    const ev = await produce("document", { destinationClass: "external_publish" });
    await orch.sweepReviewOrchestration();
    const taskId = autoReviewTaskId(ev.eventId);
    const gate = await gateStore.readReviewGate(ev.producerRunId!, taskId);
    const cr = await repairStore.recordChangesRequested({
      runId: ev.producerRunId!,
      reviewTaskId: taskId,
      orgId: ORG,
      request: mkChangesRequested(ev, gate!.id),
      repairCapable: false, // producer cannot repair
      currentBaseRevisionId: ev.representationRevisionId,
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;
    expect(cr.status).toBe("escalated");
    expect(cr.route.kind).toBe("human_escalation");
    // The review attempt still closed (the base gate resolved).
    const closed = await gateStore.readReviewGate(ev.producerRunId!, taskId);
    expect(closed!.disposition).toBe("changes_requested");
  });

  it("BATCH: the durable per-epoch aggregate disposition matrix, idempotent", async () => {
    const runId = `run-batch-${randomUUID()}`;
    const t = (n: number): BatchTarget => ({ artifactId: `b-${runId}-${n}`, representationRevisionId: `r-${n}` });
    const members = [t(1), t(2), t(3)];
    const { epoch } = await repairStore.sealBatchEpoch({ orgId: ORG, producerRunId: runId, candidateMembers: members });

    // approve + reject + changes_requested → changes_requested dominates. The
    // outcomes are a BIJECTION with the sealed membership (every member decided once).
    const fullOutcomes = [
      { target: t(1), disposition: "approve" as const },
      { target: t(2), disposition: "reject" as const },
      { target: t(3), disposition: "changes_requested" as const, findings: [{ id: "g1", message: "fix" }] },
    ];
    const d = await repairStore.recordBatchDisposition({ epochId: epoch.id, outcomes: fullOutcomes });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.disposition.aggregate).toBe("changes_requested");
    expect(d.disposition.repairScope).toEqual([t(3)]); // rejected excluded from repair scope
    expect(d.disposition.effectsReleasable).toBe(false);
    expect(d.idempotent).toBe(false);

    // A partial (incomplete) outcome set is REJECTED (no subset may persist 'approved').
    const partial = await repairStore.recordBatchDisposition({
      epochId: epoch.id,
      outcomes: [{ target: t(1), disposition: "approve" }],
    });
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.code).toBe("outcome-membership-mismatch");

    // Idempotent: a re-drive with the SAME full outcomes returns the stored aggregate.
    const again = await repairStore.recordBatchDisposition({ epochId: epoch.id, outcomes: fullOutcomes });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.idempotent).toBe(true);
    const stored = await repairStore.readBatchDisposition(epoch.id);
    expect(stored?.aggregate).toBe("changes_requested"); // the FIRST write wins
  });

  it("SEAL: a >50-target production seals a durable epoch; a crash + a new revision does NOT grow the frozen membership (S1 crash-window closed)", async () => {
    const runId = `run-seal-${randomUUID()}`;
    const N = 55;
    const members: BatchTarget[] = [];
    for (let i = 0; i < N; i++) {
      const ev = await produce("document", {
        producerRunId: runId,
        destinationClass: "external_publish",
        artifactId: `seal-${runId}-${String(i).padStart(3, "0")}`,
      });
      members.push({ artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId });
    }

    // Durably SEAL the epoch (as the first pass would, BEFORE any gate emit).
    const { epoch, reused } = await repairStore.sealBatchEpoch({
      orgId: ORG,
      producerRunId: runId,
      candidateMembers: members,
    });
    expect(reused).toBe(false);
    expect(epoch.targetCount).toBe(N);

    // Simulate the CRASH-after-emit: manually emit the FIRST partition's gate
    // (events left pending + unlinked — the exact window S1 documented).
    const frozenPartitions = partitionBatchTargets(epoch.membership);
    expect(frozenPartitions).toHaveLength(2); // 50 + 5
    await gateStore.emitArtifactReviewGate({
      runId,
      orgId: ORG,
      reviewTaskId: batchPartitionReviewTaskId(frozenPartitions[0]),
      targets: frozenPartitions[0],
    });

    // A NEW revision arrives for the SAME production BEFORE the reconciling sweep.
    const newer1 = await produce("document", { producerRunId: runId, destinationClass: "external_publish", artifactId: `seal-${runId}-new1` });
    const newer2 = await produce("document", { producerRunId: runId, destinationClass: "external_publish", artifactId: `seal-${runId}-new2` });

    // RE-SWEEP. With the durable epoch, the frozen membership (N=55) is recovered —
    // NOT the grown pending set (57).
    await orch.sweepReviewOrchestration();

    // Every BATCH gate for the run pins ONLY the frozen membership (no overlap with
    // the new revisions); exactly ceil(55/50) = 2 partition gates.
    const gates = await gatesForRun(runId);
    const batchGates = gates.filter((g) => isBatchAutoReviewTaskId(g.reviewTaskId));
    expect(batchGates).toHaveLength(2);
    const pinnedIds = new Set(batchGates.flatMap((g) => g.pinned.map((p) => p.artifactId)));
    expect(pinnedIds.size).toBe(N);
    expect(pinnedIds.has(newer1.artifactId)).toBe(false);
    expect(pinnedIds.has(newer2.artifactId)).toBe(false);

    // The epoch is now CLOSED (all 55 frozen members processed).
    const closed = await repairStore.readBatchEpoch(epoch.id);
    expect(closed?.status).toBe("partitioned");

    // The two new revisions are STILL pending (they belong to a successor epoch).
    expect((await eventRow(newer1.eventId))?.status).toBe("pending");
    expect((await eventRow(newer2.eventId))?.status).toBe("pending");

    // A SECOND sweep seals a SUCCESSOR epoch over exactly the two new revisions.
    await orch.sweepReviewOrchestration();
    const open2 = await repairStore.resolveOpenBatchEpoch(ORG, runId);
    // After processing, the successor epoch is also closed; confirm a DISTINCT epoch
    // captured exactly the two new revisions.
    const r = await pool(
      `SELECT id, target_count, membership FROM "${q(TEST_SCHEMA)}"."lifecycle_batch_epoch"
       WHERE org_id=$1 AND producer_run_id=$2 AND id <> $3`,
      [ORG, runId, epoch.id],
    );
    expect(r.rows.length).toBe(1);
    expect((r.rows[0] as { target_count: number }).target_count).toBe(2);
    const successorMembers = (r.rows[0] as { membership: BatchTarget[] }).membership.map((m) => m.artifactId);
    expect(new Set(successorMembers)).toEqual(new Set([newer1.artifactId, newer2.artifactId]));
    void open2;
  });

  it("SEAL: a SOLE remaining frozen member resumes via the frozen partition gate, never an overlapping per-event gate", async () => {
    const runId = `run-sole-${randomUUID()}`;
    const a = await produce("document", { producerRunId: runId, destinationClass: "external_publish", artifactId: `sole-${runId}-a` });
    const b = await produce("document", { producerRunId: runId, destinationClass: "external_publish", artifactId: `sole-${runId}-b` });
    const membersM: BatchTarget[] = [a, b].map((e) => ({ artifactId: e.artifactId, representationRevisionId: e.representationRevisionId }));

    // Seal the epoch, then simulate a crash that fully processed ONLY member `a`
    // (its partition gate emitted + `a` linked + marked), leaving `b` the sole
    // pending frozen member.
    const { epoch } = await repairStore.sealBatchEpoch({ orgId: ORG, producerRunId: runId, candidateMembers: membersM });
    const [partition] = partitionBatchTargets(epoch.membership);
    const partTask = batchPartitionReviewTaskId(partition);
    const emitted = await gateStore.emitArtifactReviewGate({ runId, orgId: ORG, reviewTaskId: partTask, targets: partition });
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_produced_outbox" SET status='processed', continuation_address=$2 WHERE event_id=$1`,
      [a.eventId, emitted.gateId],
    );

    // Re-sweep: `b` is the SOLE pending member — it MUST resume via the frozen
    // partition gate (batch prefix), never a per-event `lifecycle-review:<eventId>` gate.
    await orch.sweepReviewOrchestration();
    const brow = await eventRow(b.eventId);
    expect(brow?.status).toBe("processed");
    expect(brow?.continuation_address).toBe(emitted.gateId); // the SAME frozen partition gate
    const gates = await gatesForRun(runId);
    const perEventGate = gates.find((g) => g.reviewTaskId === autoReviewTaskId(b.eventId));
    expect(perEventGate).toBeUndefined(); // NO overlapping per-event gate
    expect((await repairStore.readBatchEpoch(epoch.id))?.status).toBe("partitioned");
  });

  it("SEAL: an epoch STRANDED by a crash-after-final-mark is closed by the independent drain", async () => {
    const runId = `run-strand-${randomUUID()}`;
    const m1: BatchTarget = { artifactId: `strand-${runId}-1`, representationRevisionId: "r1" };
    const m2: BatchTarget = { artifactId: `strand-${runId}-2`, representationRevisionId: "r2" };
    const { epoch } = await repairStore.sealBatchEpoch({ orgId: ORG, producerRunId: runId, candidateMembers: [m1, m2] });
    // Simulate: every member was produced + fully processed, but the crash hit
    // BEFORE closeBatchEpoch — so there are NO pending events for this production.
    for (const m of [m1, m2]) {
      const ev = await produce("document", { producerRunId: runId, destinationClass: "external_publish", artifactId: m.artifactId, representationRevisionId: m.representationRevisionId });
      await pool(
        `UPDATE "${q(TEST_SCHEMA)}"."artifact_produced_outbox" SET status='processed', continuation_address='some-gate' WHERE event_id=$1`,
        [ev.eventId],
      );
    }
    expect((await repairStore.readBatchEpoch(epoch.id))?.status).toBe("sealed");
    // The pending-keyed sweep never revisits this production (no pending events);
    // the independent open-epoch drain must still close it.
    await orch.sweepReviewOrchestration();
    expect((await repairStore.readBatchEpoch(epoch.id))?.status).toBe("partitioned");
  });

  it("EFFICACY: the routed rejected-recommendation efficacy row persists durably", async () => {
    const rej = await import("@/lib/run-selected-skill-revisions");
    const runId = `run-eff-${randomUUID()}`;
    rej.writeRunRejectedRecommendations({
      runId,
      rejected: [
        { skillId: "skill-a", skillRevisionId: "rev-a", recommendationSource: "recommended_not_kept", recommendedRank: 2 },
        { skillId: "skill-b", skillRevisionId: null, recommendationSource: "recommended_not_kept", recommendedRank: 5 },
      ],
    });
    const rows = rej.readRunRejectedRecommendations(runId);
    expect(rows.map((r) => r.skillId)).toEqual(["skill-a", "skill-b"]);
    expect(rows[1].skillRevisionId).toBeNull();
    // Idempotent on (run, skill): a re-drive writes no duplicate (first write wins).
    rej.writeRunRejectedRecommendations({
      runId,
      rejected: [{ skillId: "skill-a", skillRevisionId: "rev-a2", recommendationSource: "recommended_not_kept", recommendedRank: 2 }],
    });
    const after = rej.readRunRejectedRecommendations(runId);
    expect(after.find((r) => r.skillId === "skill-a")?.skillRevisionId).toBe("rev-a"); // unchanged
  });

  it("FENCE: with the S1 fence OFF, the orchestration drain is inert", async () => {
    delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
    const ev = await produce("document", { destinationClass: "external_publish" });
    const summary = await orch.sweepReviewOrchestration();
    expect(summary.gatesCreated).toBe(0);
    expect((await eventRow(ev.eventId))?.status).toBe("pending");
    process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
  });

  // -------------------------------------------------------------------------
  // SURFACE — the S12 review-surface prompt-window changes_requested composer
  // (cinatra#2063; owner ruling 2026-07-25). The typed feedback becomes ONE
  // finding; the base gate closes as changes_requested through the SAME S2 entry
  // point; the repair opens; the CAS is fail-closed. currentBaseRevisionId is the
  // value the surface binder resolves via its revisionMember port — passed here
  // directly (the pinned revision when live, null when tombstoned).
  // -------------------------------------------------------------------------
  it("SURFACE: prompt-window feedback closes the base gate as changes_requested + opens a repair (repair-capable → requested)", async () => {
    const ev = await produce("document", { destinationClass: "external_publish" });
    await seedRepairCapableProducer(ev.producerRunId!);
    await orch.sweepReviewOrchestration();
    const taskId = autoReviewTaskId(ev.eventId);
    const baseGate = await gateStore.readReviewGate(ev.producerRunId!, taskId);
    expect(baseGate).not.toBeNull();

    const cr = await crStore.recordReviewSurfaceChangesRequested({
      runId: ev.producerRunId!,
      reviewTaskId: taskId,
      baseTarget: { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
      currentBaseRevisionId: ev.representationRevisionId, // the pinned revision, still live
      feedback: "  Tighten the headline and add a CTA.  ",
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;
    expect(cr.status).toBe("requested");
    expect(cr.route.kind).toBe("producer_repair");
    expect(cr.attempt).toBe(1);

    // The base gate is RESOLVED as changes_requested — the review attempt closed.
    const closed = await gateStore.readReviewGate(ev.producerRunId!, taskId);
    expect(closed!.status).toBe("resolved");
    expect(closed!.disposition).toBe("changes_requested");

    // The typed feedback became exactly ONE finding, TRIMMED.
    const repair = await repairStore.readRepair(cr.repairId);
    expect(repair!.findings).toHaveLength(1);
    expect(repair!.findings[0].message).toBe("Tighten the headline and add a CTA.");

    // The external effect stays HELD (repair in flight) despite the resolved gate.
    const held = await orch.isArtifactEffectHeld({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(held.held).toBe(true);

    // Idempotent on the gate: a response-lost re-drive with the SAME feedback
    // returns the SAME repair (never a second).
    const again = await crStore.recordReviewSurfaceChangesRequested({
      runId: ev.producerRunId!,
      reviewTaskId: taskId,
      baseTarget: { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
      currentBaseRevisionId: ev.representationRevisionId,
      feedback: "Tighten the headline and add a CTA.",
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.idempotent).toBe(true);
    expect(again.repairId).toBe(cr.repairId);
  });

  it("SURFACE: a non-repairing producer (no repair capability) still closes the gate + opens a repair, ESCALATED (never drops)", async () => {
    const ev = await produce("document", { destinationClass: "external_publish" });
    // No producer template seeded ⇒ repairCapable resolves false ⇒ human escalation.
    await orch.sweepReviewOrchestration();
    const taskId = autoReviewTaskId(ev.eventId);

    const cr = await crStore.recordReviewSurfaceChangesRequested({
      runId: ev.producerRunId!,
      reviewTaskId: taskId,
      baseTarget: { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
      currentBaseRevisionId: ev.representationRevisionId,
      feedback: "please revise",
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;
    expect(cr.status).toBe("escalated");
    expect(cr.route.kind).toBe("human_escalation");
    const closed = await gateStore.readReviewGate(ev.producerRunId!, taskId);
    expect(closed!.disposition).toBe("changes_requested");
  });

  it("SURFACE: FAIL-CLOSED — a tombstoned base (currentBaseRevisionId null) is rejected; the gate stays pending", async () => {
    const ev = await produce("document", { destinationClass: "external_publish" });
    await orch.sweepReviewOrchestration();
    const taskId = autoReviewTaskId(ev.eventId);

    const cr = await crStore.recordReviewSurfaceChangesRequested({
      runId: ev.producerRunId!,
      reviewTaskId: taskId,
      baseTarget: { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
      currentBaseRevisionId: null, // the pinned revision no longer resolves live
      feedback: "please revise",
    });
    expect(cr.ok).toBe(false);
    if (cr.ok) return;
    expect(cr.code).toBe("tombstoned-base");
    // The gate was NOT closed — the change request never committed.
    const gate = await gateStore.readReviewGate(ev.producerRunId!, taskId);
    expect(gate!.status).toBe("pending");
  });

  it("SURFACE: a NON-lifecycle (flow-authored wayflow-) gate is rejected — the composer only closes lifecycle gates", async () => {
    const runId = `run-wf-${randomUUID()}`;
    const artifactId = `art-${randomUUID()}`;
    const rev = `rev-${randomUUID()}`;
    await insertObject(artifactId, "document");
    const wf = await gateStore.emitArtifactReviewGate({
      runId,
      orgId: ORG,
      reviewTaskId: `wayflow-${randomUUID()}`,
      targets: [{ artifactId, representationRevisionId: rev }],
      expiresAt: null,
    });
    expect(wf.gateId).toBeTruthy();
    const cr = await crStore.recordReviewSurfaceChangesRequested({
      runId,
      reviewTaskId: (await gatesForRun(runId))[0].reviewTaskId,
      baseTarget: { artifactId, representationRevisionId: rev },
      currentBaseRevisionId: rev,
      feedback: "please revise",
    });
    expect(cr.ok).toBe(false);
    if (cr.ok) return;
    expect(cr.code).toBe("not-a-lifecycle-gate");
  });

  it("SURFACE: MULTI-CYCLE — a 2-round repair chain does NOT strand the held effect; approve of the final successor releases it (cinatra#2063 codex fix)", async () => {
    // Round 1: auto gate on an external-publish artifact; the surface requests
    // changes; the producer repairs into a successor gate (the ORIGINAL event
    // re-points onto it, effect still held).
    const ev = await produce("document", { destinationClass: "external_publish" });
    await seedRepairCapableProducer(ev.producerRunId!);
    await orch.sweepReviewOrchestration();
    const baseTaskId = autoReviewTaskId(ev.eventId);

    const cr1 = await crStore.recordReviewSurfaceChangesRequested({
      runId: ev.producerRunId!,
      reviewTaskId: baseTaskId,
      baseTarget: { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
      currentBaseRevisionId: ev.representationRevisionId,
      feedback: "round 1 — tighten",
    });
    expect(cr1.ok).toBe(true);
    if (!cr1.ok) return;
    const rev2 = `rev-r1-${randomUUID()}`;
    const rr1 = await repairStore.submitRepairResponse({
      repairId: cr1.repairId,
      currentBaseRevisionId: ev.representationRevisionId,
      reauthorized: true,
      response: {
        gateId: (await gateStore.readReviewGate(ev.producerRunId!, baseTaskId))!.id,
        baseTarget: { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
        successorTarget: { artifactId: ev.artifactId, representationRevisionId: rev2 },
        findingOutcomes: [{ findingId: "prompt-window", applied: true }],
        changeSummary: "r1",
        producerProvenance: { runId: ev.producerRunId, agentId: null },
      },
    });
    expect(rr1.ok).toBe(true);
    if (!rr1.ok) return;

    // Round 2: the surface requests changes AGAIN on the SUCCESSOR gate (a repair
    // chain). The cycle lineage is the original (attempt 2). The ORIGINAL event is
    // still the one linked to the successor gate — the effect stays held.
    const cr2 = await crStore.recordReviewSurfaceChangesRequested({
      runId: ev.producerRunId!,
      reviewTaskId: rr1.successorTaskId,
      baseTarget: { artifactId: ev.artifactId, representationRevisionId: rev2 },
      currentBaseRevisionId: rev2,
      feedback: "round 2 — add a CTA",
    });
    expect(cr2.ok).toBe(true);
    if (!cr2.ok) return;
    expect(cr2.attempt).toBe(2); // the cycle guard counts the whole chain
    const heldDuringR2 = await orch.isArtifactEffectHeld({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(heldDuringR2.held).toBe(true);

    // The producer repairs round 2 into a THIRD gate. The re-point must follow the
    // ORIGINAL event (linked to the round-2 base gate) onto this new gate — NOT the
    // round-2 base event, which would strand the original effect forever.
    const rev3 = `rev-r2-${randomUUID()}`;
    const rr2 = await repairStore.submitRepairResponse({
      repairId: cr2.repairId,
      currentBaseRevisionId: rev2,
      reauthorized: true,
      response: {
        gateId: (await gateStore.readReviewGate(ev.producerRunId!, rr1.successorTaskId))!.id,
        baseTarget: { artifactId: ev.artifactId, representationRevisionId: rev2 },
        successorTarget: { artifactId: ev.artifactId, representationRevisionId: rev3 },
        findingOutcomes: [{ findingId: "prompt-window", applied: true }],
        changeSummary: "r2",
        producerProvenance: { runId: ev.producerRunId, agentId: null },
      },
    });
    expect(rr2.ok).toBe(true);
    if (!rr2.ok) return;

    // The ORIGINAL event re-pointed onto the round-2 successor gate (the fix): the
    // effect is STILL held (round-2 successor pending), NOT stranded.
    expect((await eventRow(ev.eventId))?.continuation_address).toBe(rr2.successorGateId);
    const heldAwaitingFinal = await orch.isArtifactEffectHeld({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(heldAwaitingFinal.held).toBe(true);

    // Approve the final successor → the effect RELEASES (proving no strand).
    await resolveGateApprove(rr2.successorGateId);
    const released = await orch.isArtifactEffectHeld({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(released.held).toBe(false);
  });

  // -------------------------------------------------------------------------
  // SEAM A hardening (cinatra#2065) — the successor-gate emit + repair finalize
  // is now ONE transaction (the enlisted emit), and pre-fix orphaned strands are
  // converged by orphan-recovery.
  // -------------------------------------------------------------------------

  /** Drive a repair to the `requested` state on a fresh external-publish artifact. */
  async function openRepair(): Promise<{ ev: ArtifactProducedEvent; repairId: string; attempt: number; req: ChangesRequestedRequest }> {
    const ev = await produce("document", { destinationClass: "external_publish" });
    await orch.sweepReviewOrchestration();
    const baseTaskId = autoReviewTaskId(ev.eventId);
    const baseGate = await gateStore.readReviewGate(ev.producerRunId!, baseTaskId);
    const req = mkChangesRequested(ev, baseGate!.id);
    const cr = await repairStore.recordChangesRequested({
      runId: ev.producerRunId!,
      reviewTaskId: baseTaskId,
      orgId: ORG,
      request: req,
      repairCapable: true,
      producerRunId: ev.producerRunId,
      currentBaseRevisionId: ev.representationRevisionId,
    });
    if (!cr.ok) throw new Error(`openRepair: ${cr.code}`);
    return { ev, repairId: cr.repairId, attempt: cr.attempt, req };
  }

  it("SEAM A: a fault between successor emit and finalize strands NOTHING; a FRESH-target retry converges (no pin conflict)", async () => {
    const { ev, repairId, attempt, req } = await openRepair();
    const runId = ev.producerRunId!;
    const successorTaskId = repairSuccessorReviewTaskId(repairId, attempt);
    const faultedTarget = { artifactId: ev.artifactId, representationRevisionId: `rev-faulted-${randomUUID()}` };

    // FAULT INJECTION — emit the successor gate ENLISTED on a transaction (exactly
    // as the atomic submit does), then throw BEFORE the finalize so the unit rolls
    // back. This is the "crash between emit and finalize" the AC demands; with the
    // atomic fix it must leave NOTHING behind.
    await expect(
      dbMod.db.transaction(async (tx) => {
        await gateStore.emitArtifactReviewGate(
          { runId, orgId: ORG, reviewTaskId: successorTaskId, targets: [faultedTarget], expiresAt: null },
          tx,
        );
        throw new Error("injected fault after successor emit, before finalize");
      }),
    ).rejects.toThrow("injected fault");

    // NO stranded gate (the enlisted emit rolled back with the transaction); the
    // repair is still open (never finalized).
    expect(await gateStore.readReviewGate(runId, successorTaskId)).toBeNull();
    expect((await repairStore.readRepair(repairId))?.status).toBe("requested");

    // FRESH-target retry (a DIFFERENT successor revision than the faulted attempt)
    // converges — no successor-pin conflict, because nothing was stranded.
    const freshRev = `rev-fresh-${randomUUID()}`;
    const rr = await repairStore.submitRepairResponse({
      repairId,
      currentBaseRevisionId: ev.representationRevisionId,
      reauthorized: true,
      response: {
        gateId: req.gateId,
        baseTarget: req.baseTarget,
        successorTarget: { artifactId: ev.artifactId, representationRevisionId: freshRev },
        findingOutcomes: [
          { findingId: "f1", applied: true },
          { findingId: "f2", applied: true },
        ],
        changeSummary: "fresh retry after fault",
        producerProvenance: { runId, agentId: null },
      },
    });
    expect(rr.ok).toBe(true);
    if (!rr.ok) return;

    // The successor gate pins the FRESH revision (not the faulted one); exactly ONE
    // gate occupies the deterministic (run, task) slot.
    const succ = await pool(
      `SELECT pinned_targets FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE id=$1`,
      [rr.successorGateId],
    );
    expect((succ.rows[0] as { pinned_targets: BatchTarget[] }).pinned_targets).toEqual([
      { artifactId: ev.artifactId, representationRevisionId: freshRev },
    ]);
    const cnt = await pool(
      `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id=$1 AND review_task_id=$2`,
      [runId, successorTaskId],
    );
    expect((cnt.rows[0] as { n: number }).n).toBe(1);

    // The held effect re-pointed onto the fresh successor and releases ONLY by a
    // genuine approve (a same-target retry passing would not have proven this).
    expect((await eventRow(ev.eventId))?.continuation_address).toBe(rr.successorGateId);
    expect(
      (await orch.isArtifactEffectHeld({ artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId })).held,
    ).toBe(true);
    await resolveGateApprove(rr.successorGateId);
    expect(
      (await orch.isArtifactEffectHeld({ artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId })).held,
    ).toBe(false);
  });

  it("SEAM A LEGACY: a pre-fix orphaned successor gate is CONVERGED by orphan-recovery (adopt); a naive fresh-target retry conflicts; idempotent", async () => {
    const { ev, repairId, attempt, req } = await openRepair();
    const runId = ev.producerRunId!;
    const successorTaskId = repairSuccessorReviewTaskId(repairId, attempt);
    const legacyRev = `rev-legacy-${randomUUID()}`;

    // SEED the pre-fix strand DIRECTLY: the OLD non-atomic code emitted the successor
    // gate in its OWN committed statement, then crashed before the separate finalize.
    // Emit the orphan (committed) with the repair still 'requested' and the effect
    // still linked to the BASE gate — a state the atomic fix can never mint.
    const orphan = await gateStore.emitArtifactReviewGate({
      runId,
      orgId: ORG,
      reviewTaskId: successorTaskId,
      targets: [{ artifactId: ev.artifactId, representationRevisionId: legacyRev }],
      expiresAt: null,
    });
    expect((await repairStore.readRepair(repairId))?.status).toBe("requested");
    expect((await repairStore.readRepair(repairId))?.successorGateId).toBeNull();
    expect((await eventRow(ev.eventId))?.continuation_address).toBe(req.gateId); // still on the base gate

    // A naive FRESH-target retry cannot converge past the strand — the orphan occupies
    // the deterministic slot → successor-pin-conflict. This is why recovery, not a
    // same-slot re-emit, is the convergence path.
    const conflict = await repairStore.submitRepairResponse({
      repairId,
      currentBaseRevisionId: ev.representationRevisionId,
      reauthorized: true,
      response: {
        gateId: req.gateId,
        baseTarget: req.baseTarget,
        successorTarget: { artifactId: ev.artifactId, representationRevisionId: `rev-conflict-${randomUUID()}` },
        findingOutcomes: [
          { findingId: "f1", applied: true },
          { findingId: "f2", applied: true },
        ],
        changeSummary: "x",
        producerProvenance: { runId, agentId: null },
      },
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("successor-pin-conflict");
    // The strand did not finalize the repair.
    expect((await repairStore.readRepair(repairId))?.status).toBe("requested");

    // RECOVERY converges the strand: ADOPT the orphan gate as the successor.
    const rec = await recoveryStore.recoverOrphanedRepairSuccessor(repairId);
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    expect(rec.status).toBe("recovered");
    if (rec.status !== "recovered") return;
    expect(rec.successorGateId).toBe(orphan.gateId);

    const repaired = await repairStore.readRepair(repairId);
    expect(repaired?.status).toBe("repaired");
    expect(repaired?.successorGateId).toBe(orphan.gateId);
    expect(repaired?.successorRepresentationRevisionId).toBe(legacyRev);
    // The held effect re-pointed onto the adopted successor gate; still held.
    expect((await eventRow(ev.eventId))?.continuation_address).toBe(orphan.gateId);
    expect(
      (await orch.isArtifactEffectHeld({ artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId })).held,
    ).toBe(true);

    // Idempotent: a second recovery is a no-op (already-repaired).
    const rec2 = await recoveryStore.recoverOrphanedRepairSuccessor(repairId);
    expect(rec2.ok).toBe(true);
    if (!rec2.ok) return;
    expect(rec2.status).toBe("already-repaired");

    // The effect releases ONLY by a genuine approve of the adopted successor.
    await resolveGateApprove(orphan.gateId);
    expect(
      (await orch.isArtifactEffectHeld({ artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId })).held,
    ).toBe(false);
  });

  it("SEAM A: two CONCURRENT responses finalize exactly once — one successor gate, no strand, no duplicate (throw-rollback of the loser)", async () => {
    const { ev, repairId, attempt, req } = await openRepair();
    const runId = ev.producerRunId!;
    const successorTaskId = repairSuccessorReviewTaskId(repairId, attempt);
    const rev = `rev-concurrent-${randomUUID()}`;
    const mkResp = () => ({
      repairId,
      currentBaseRevisionId: ev.representationRevisionId,
      reauthorized: true,
      response: {
        gateId: req.gateId,
        baseTarget: req.baseTarget,
        successorTarget: { artifactId: ev.artifactId, representationRevisionId: rev },
        findingOutcomes: [
          { findingId: "f1", applied: true },
          { findingId: "f2", applied: true },
        ],
        changeSummary: "concurrent",
        producerProvenance: { runId, agentId: null },
      },
    });

    // Both responses race the SAME deterministic (run, task) slot. The unique index
    // serializes the emit; the loser's finalize CAS matches 0 rows → it THROWS
    // FinalizeRollback → its transaction rolls back (discarding any work) → it
    // returns the winner's successor gate idempotently. No strand, no duplicate.
    const [a, b] = await Promise.all([
      repairStore.submitRepairResponse(mkResp()),
      repairStore.submitRepairResponse(mkResp()),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.successorGateId).toBe(b.successorGateId); // the SAME gate

    const cnt = await pool(
      `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE run_id=$1 AND review_task_id=$2`,
      [runId, successorTaskId],
    );
    expect((cnt.rows[0] as { n: number }).n).toBe(1); // exactly one gate at the slot
    const repaired = await repairStore.readRepair(repairId);
    expect(repaired?.status).toBe("repaired");
    expect(repaired?.successorGateId).toBe(a.successorGateId);
    // The held effect re-pointed exactly once onto the single successor gate.
    expect((await eventRow(ev.eventId))?.continuation_address).toBe(a.successorGateId);
  });

  it("SEAM A LEGACY: the bounded recovery SWEEP converges a seeded orphan (autonomous recovery)", async () => {
    const { ev, repairId, attempt } = await openRepair();
    const runId = ev.producerRunId!;
    const successorTaskId = repairSuccessorReviewTaskId(repairId, attempt);
    await gateStore.emitArtifactReviewGate({
      runId,
      orgId: ORG,
      reviewTaskId: successorTaskId,
      targets: [{ artifactId: ev.artifactId, representationRevisionId: `rev-sweep-${randomUUID()}` }],
      expiresAt: null,
    });
    expect((await repairStore.readRepair(repairId))?.status).toBe("requested");

    const summary = await recoveryStore.recoverOrphanedRepairSuccessors(500);
    expect(summary.recovered).toBeGreaterThanOrEqual(1);
    // The seeded orphan's repair converged autonomously.
    expect((await repairStore.readRepair(repairId))?.status).toBe("repaired");
  });

});
