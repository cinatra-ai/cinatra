/**
 * cinatra#2047 defect D-1 — REAL-store proof that a merged producer can complete
 * a repair round-trip. The ACCEPTANCE REPRO, INVERTED.
 *
 * The S8 acceptance run found: "open a lifecycle auto-gate on any produced
 * artifact, submit a typed changes-request on the run-embedded review surface …
 * `cinatra.lifecycle_repair` gets a row with `route=human_escalation,
 * status=escalated, successor_gate_id=NULL, successor_artifact_id=NULL`. No
 * successor gate is pinned; `triggerVerificationForLandedRepair` never fires."
 * Root cause: `BLOG_POST_LIFECYCLE_CONFIG` was exported but never seeded onto any
 * `agent_templates.lifecycle_config` row, so `resolveRepairCapable` (fail-soft)
 * always read false.
 *
 * These cases drive the SHIPPED entry points against a real Postgres:
 *
 *   SEED      — the core lifecycle projection lands `repairCapable:true` on the
 *               blog producer's template row; idempotent; MERGE-not-clear.
 *   REPRO-1   — the acceptance repro with the seeding in place: the SAME
 *               `recordReviewSurfaceChangesRequested` call now yields
 *               `route=producer_repair, status=requested` (not human_escalation).
 *   DELIVER   — the dispatch drain delivers the typed request on a deterministic
 *               repair run and CASes the repair to `dispatched`; idempotent.
 *   CHAIN     — the producer answers on that repair run: a successor gate pins the
 *               repaired revision AND a verification record is written; the
 *               successor's OWN produced event does not open a second auto-gate;
 *               approving the successor releases the held effect.
 *   ESCALATE  — a repair with no resolvable producer is escalated with a recorded
 *               reason (nothing silently drops), never left pending forever.
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
import { autoReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";

const TEST_SCHEMA = "cinatra_test_lifecycle_2047_d1";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2047-d1";
const BLOG_PKG = "@cinatra-ai/blog-draft-writer-agent";

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let repairStore: typeof import("../lifecycle-repair-store");
let crStore: typeof import("../lifecycle-review-changes-requested-store");
let dispatchStore: typeof import("../lifecycle-repair-dispatch-store");
let projection: typeof import("../lifecycle-config-projection");
let verifStore: typeof import("../lifecycle-verification-store");
let dbMod: typeof import("../db");
/** The single blog-producer template row. `agent_templates.package_name` is
 * UNIQUE, so the blog package can exist exactly once per schema; every case here
 * shares it and creates its own producing run. */
let blogTemplateId: string;

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

/** Seed a template row for `packageName` with the given lifecycle_config text. */
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
    destinationClass: "external_publish",
    continuationMode: "async_effects_gated",
    continuationAddress: null,
    ...over,
  };
  await insertObject(ev.artifactId, "document", ev.orgId);
  await outboxStore.emitArtifactProduced(ev, dbMod.db);
  return ev;
}

async function repairRow(repairId: string) {
  const r = await pool(
    `SELECT route, status, successor_gate_id, successor_artifact_id, change_summary
     FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE id=$1`,
    [repairId],
  );
  return r.rows[0] as
    | {
        route: string;
        status: string;
        successor_gate_id: string | null;
        successor_artifact_id: string | null;
        change_summary: string | null;
      }
    | undefined;
}

async function templateLifecycleConfig(templateId: string): Promise<string | null> {
  const r = await pool(
    `SELECT lifecycle_config FROM "${q(TEST_SCHEMA)}"."agent_templates" WHERE id=$1`,
    [templateId],
  );
  return (r.rows[0] as { lifecycle_config: string | null } | undefined)?.lifecycle_config ?? null;
}

async function resolveGateApprove(gateId: string) {
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
     SET status='resolved', disposition='approve', fingerprint=$2, resolved_at=now()
     WHERE id=$1 AND status='pending'`,
    [gateId, `fp-${randomUUID()}`],
  );
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
  projection = await import("../lifecycle-config-projection");
  verifStore = await import("../lifecycle-verification-store");
  dbMod = await import("../db");

  blogTemplateId = await seedTemplate(BLOG_PKG, null);
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

describe.skipIf(!HAS_DB)("cinatra#2047 D-1 — the repair round-trip is reachable for a merged producer", () => {
  it("SEED: the core projection lands repairCapable on the blog producer's template; idempotent; MERGE-not-clear", async () => {
    const unrelated = await seedTemplate(`@cinatra-ai/unrelated-${randomUUID()}-agent`, null);

    // The acceptance state: the blog template carries NO lifecycle declaration.
    expect(await templateLifecycleConfig(blogTemplateId)).toBeNull();

    const first = await projection.projectCoreLifecycleConfig();
    expect(first.updated).toBe(1);
    // The row now declares the capability the repair route keys on.
    expect(JSON.parse((await templateLifecycleConfig(blogTemplateId))!)).toMatchObject({
      repairCapable: true,
    });
    // A package core does not declare is never touched.
    expect(await templateLifecycleConfig(unrelated)).toBeNull();

    // Idempotent: a second pass writes nothing.
    const second = await projection.projectCoreLifecycleConfig();
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);

    // MERGE-not-clear: a manifest-declared key survives the projection; the
    // CORE-declared key wins over a conflicting manifest value.
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."agent_templates" SET lifecycle_config=$2 WHERE id=$1`,
      [blogTemplateId, JSON.stringify({ requestedSkips: ["recommendation"], repairCapable: false })],
    );
    const third = await projection.projectCoreLifecycleConfig();
    expect(third.updated).toBe(1);
    expect(JSON.parse((await templateLifecycleConfig(blogTemplateId))!)).toMatchObject({
      repairCapable: true,
      requestedSkips: ["recommendation"],
    });
  });

  it("REPRO (unseeded): a producer with NO lifecycle declaration still escalates — exactly the acceptance row", async () => {
    // The control case. A template whose row carries no `lifecycle_config` is the
    // state EVERY merged producer was in before D-1: `resolveRepairCapable` is
    // fail-soft to false, so the route is `human_escalation` and no successor
    // gate is ever pinned. This is the behaviour the acceptance run recorded
    // (`route=human_escalation, status=escalated, successor_gate_id=NULL`); the
    // next case is the SAME call on a declared producer.
    const templateId = await seedTemplate(`@cinatra-ai/undeclared-${randomUUID()}-agent`, null);
    const producerRunId = await seedRun(templateId);
    const ev = await produce({ producerRunId });
    await orch.sweepReviewOrchestration({ limit: 50 });
    const baseTaskId = autoReviewTaskId(ev.eventId);

    const cr = await crStore.recordReviewSurfaceChangesRequested({
      runId: producerRunId,
      reviewTaskId: baseTaskId,
      baseTarget: {
        artifactId: ev.artifactId,
        representationRevisionId: ev.representationRevisionId,
      },
      currentBaseRevisionId: ev.representationRevisionId,
      feedback: "tighten the headline",
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;
    expect(cr.route.kind).toBe("human_escalation");
    expect(cr.status).toBe("escalated");
    const row = await repairRow(cr.repairId);
    expect(row!.route).toBe("human_escalation");
    expect(row!.successor_gate_id).toBeNull();
    expect(row!.successor_artifact_id).toBeNull();
    // And the dispatch drain never touches a human_escalation row.
    expect((await dispatchStore.dispatchPendingProducerRepairs()).scanned).toBe(0);
  });

  it("REPRO INVERTED + DELIVER + CHAIN: changes_requested to repair to successor gate to verification record", async () => {
    // A blog producer template whose row carries the CORE-projected declaration.
    const templateId = blogTemplateId;
    await projection.projectCoreLifecycleConfig();
    const producerRunId = await seedRun(templateId);

    // 1. Produce + auto-gate (the shipped emitters/sweeper).
    const ev = await produce({ producerRunId });
    await orch.sweepReviewOrchestration({ limit: 50 });
    const baseTaskId = autoReviewTaskId(ev.eventId);
    const baseGate = await gateStore.readReviewGate(producerRunId, baseTaskId);
    expect(baseGate).not.toBeNull();
    expect(
      (
        await orch.isArtifactEffectHeld({
          artifactId: ev.artifactId,
          representationRevisionId: ev.representationRevisionId,
        })
      ).held,
    ).toBe(true);

    // 2. The EXACT acceptance repro: a typed changes-request through the review
    //    surface composer. Before D-1 this produced route=human_escalation.
    const cr = await crStore.recordReviewSurfaceChangesRequested({
      runId: producerRunId,
      reviewTaskId: baseTaskId,
      baseTarget: {
        artifactId: ev.artifactId,
        representationRevisionId: ev.representationRevisionId,
      },
      currentBaseRevisionId: ev.representationRevisionId,
      feedback: "tighten the headline and add a CTA",
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;
    expect(cr.route.kind).toBe("producer_repair");
    expect(cr.status).toBe("requested");
    expect((await repairRow(cr.repairId))!.route).toBe("producer_repair");

    // 3. DELIVERY: the dispatch drain hands the typed request to the producer.
    const dispatched = await dispatchStore.dispatchPendingProducerRepairs();
    expect(dispatched.dispatched).toBe(1);
    expect((await repairRow(cr.repairId))!.status).toBe("dispatched");

    const repairRunId = dispatchStore.repairRunId(cr.repairId);
    const delivered = await dispatchStore.readDeliveredRepairRequest(repairRunId);
    expect(delivered).not.toBeNull();
    expect(delivered!.gateId).toBe(baseGate!.id);
    expect(delivered!.baseTarget).toEqual({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    expect(delivered!.findings.length).toBeGreaterThan(0);
    // The repair run rides the producing template (the agent that must repair).
    const runRow = await pool(
      `SELECT template_id, source_type FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`,
      [repairRunId],
    );
    expect((runRow.rows[0] as { template_id: string }).template_id).toBe(templateId);

    // Idempotent re-drain: nothing pending, no second run.
    expect((await dispatchStore.dispatchPendingProducerRepairs()).dispatched).toBe(0);

    // 4. The producer answers ON the dispatched repair run: it produces the
    //    successor revision through the normal choke point and submits the typed
    //    response. The successor's OWN produced event must NOT open a second
    //    auto-gate — its gate is the repair successor gate.
    const successorRev = `rev-repaired-${randomUUID()}`;
    await produce({
      artifactId: ev.artifactId,
      representationRevisionId: successorRev,
      producerRunId: repairRunId,
    });
    const sweep = await orch.sweepReviewOrchestration({ limit: 50 });
    expect(sweep.gatesCreated).toBe(0);
    expect(
      await gateStore.readReviewGate(
        repairRunId,
        autoReviewTaskId(producedEventId(ev.artifactId, successorRev)),
      ),
    ).toBeNull();

    const rr = await repairStore.submitRepairResponse({
      repairId: cr.repairId,
      currentBaseRevisionId: ev.representationRevisionId,
      reauthorized: true,
      response: {
        gateId: baseGate!.id,
        baseTarget: {
          artifactId: ev.artifactId,
          representationRevisionId: ev.representationRevisionId,
        },
        successorTarget: { artifactId: ev.artifactId, representationRevisionId: successorRev },
        findingOutcomes: (delivered!.findings ?? []).map((f) => ({ findingId: f.id, applied: true })),
        changeSummary: "headline tightened, CTA added",
        producerProvenance: { runId: repairRunId, agentId: null },
      },
    });
    expect(rr.ok).toBe(true);
    if (!rr.ok) return;

    // 5. The successor gate pins the repaired revision and is DECIDABLE.
    const persisted = await repairRow(cr.repairId);
    expect(persisted!.status).toBe("repaired");
    expect(persisted!.successor_gate_id).toBe(rr.successorGateId);
    expect(persisted!.successor_artifact_id).toBe(ev.artifactId);
    const successorGate = await pool(
      `SELECT status, pinned_targets FROM "${q(TEST_SCHEMA)}"."artifact_review_gates" WHERE id=$1`,
      [rr.successorGateId],
    );
    expect((successorGate.rows[0] as { status: string }).status).toBe("pending");

    // 6. The verification record landed (triggerVerificationForLandedRepair fired
    //    inside the submit) — the last rung the acceptance run could never reach.
    const verification = await verifStore.readVerificationRecordForGate(rr.successorGateId);
    expect(verification).not.toBeNull();
    expect(verification!.gateId).toBe(rr.successorGateId);

    // 7. Approving the successor releases the held effect.
    await resolveGateApprove(rr.successorGateId);
    expect(
      (
        await orch.isArtifactEffectHeld({
          artifactId: ev.artifactId,
          representationRevisionId: ev.representationRevisionId,
        })
      ).held,
    ).toBe(false);
  });

  it("ESCALATE: a producer_repair with no resolvable producing run is escalated with a recorded reason (nothing silently drops)", async () => {
    await projection.projectCoreLifecycleConfig();
    const producerRunId = await seedRun(blogTemplateId);
    const ev = await produce({ producerRunId });
    await orch.sweepReviewOrchestration({ limit: 50 });
    const baseTaskId = autoReviewTaskId(ev.eventId);
    const baseGate = await gateStore.readReviewGate(producerRunId, baseTaskId);

    const cr = await repairStore.recordChangesRequested({
      runId: producerRunId,
      reviewTaskId: baseTaskId,
      orgId: ORG,
      request: {
        gateId: baseGate!.id,
        decisionId: `dec-${randomUUID()}`,
        idempotencyKey: `idem-${randomUUID()}`,
        baseTarget: {
          artifactId: ev.artifactId,
          representationRevisionId: ev.representationRevisionId,
        },
        expectedBaseRevisionId: ev.representationRevisionId,
        findings: [{ id: "f1", message: "fix it" }],
        continuationMode: "async_effects_gated",
        continuationAddress: null,
      },
      repairCapable: true,
      // A producing run that does not exist — there is no producer to deliver to.
      producerRunId: `run-vanished-${randomUUID()}`,
      currentBaseRevisionId: ev.representationRevisionId,
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    const summary = await dispatchStore.dispatchPendingProducerRepairs();
    expect(summary.escalated).toBeGreaterThanOrEqual(1);
    const row = await repairRow(cr.repairId);
    expect(row!.status).toBe("escalated");
    expect(row!.change_summary).toContain(dispatchStore.DISPATCH_ESCALATION_PREFIX.trim());
  });

  it("FENCE: with the activation fence OFF the maintenance drain dispatches nothing", async () => {
    delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
    const summary = await orch.sweepLifecycleGateMaintenance();
    expect(summary.repairsDispatched).toBe(0);
    expect(summary.repairsEscalated).toBe(0);
    process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
  });
});
