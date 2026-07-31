/**
 * cinatra#2286, epic S10 PR2 — the delivered-repair EXECUTION BRIDGE, proven
 * against a real Postgres.
 *
 * `lifecycle-repair-dispatch.integration.test.ts` proves the DELIVERY half
 * (a repair gets a dispatched run) for a generic producer. This suite proves
 * the CMS-GENERIC halves this slice adds on top:
 *
 *   TASK CONSTRUCTION — a CMS base target projects a `task` onto the
 *                        dispatched run's `inputParams`; a non-CMS base
 *                        target (e.g. blog) projects nothing (byte-identical
 *                        dispatch for every other producer).
 *   COMPLETION ADAPTER — once the dispatched repair run has produced a
 *                        matching CMS-snapshot capture, the drain finds it and
 *                        submits it as the repair response (the round trip
 *                        `dispatchPendingProducerRepairs` →
 *                        `completeDispatchedProducerCmsRepairs` this slice
 *                        never had a caller for before).
 *   NO MATCH            — a terminal run with no matching capture leaves the
 *                        repair `dispatched` (open), never silently finalized
 *                        wrong.
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

const TEST_SCHEMA = "cinatra_test_lifecycle_2286_s10_pr2";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2286-s10-pr2";
const MEMBER_USER = "user-2286-s10-pr2-member";
const MANIFEST_REPAIR_CAPABLE = JSON.stringify({ repairCapable: true });
const CMS_SNAPSHOT_EMITTER = "object_cms_snapshot_capture";

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let crStore: typeof import("../lifecycle-review-changes-requested-store");
let dispatchStore: typeof import("../lifecycle-repair-dispatch-store");
let bridge: typeof import("../lifecycle-repair-cms-production-bridge");
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
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, run_by, input_params)
     VALUES ($1,$2,$3,$4,'{}')`,
    [runId, templateId, ORG, MEMBER_USER],
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

/** Insert a `cms_snapshot_targets` row directly — the apply binding a real
 * `captureCmsContentSnapshot` writes (SQL mirrored from
 * `buildCmsSnapshotCaptureQueries`'s `targetInsert`, without pulling in the
 * host's blob-store-backed capture writer). */
async function insertCmsSnapshotTarget(input: {
  artifactId: string;
  snapshotRevisionId: string;
  connectorInstance: string;
  resourceType: string;
  resourceId: string | null;
  operationId?: string;
}): Promise<void> {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."cms_snapshot_targets"
       (id, artifact_id, snapshot_revision_id, scope_manifest, connector_instance,
        resource_type, resource_id, base_remote_revision_ref, operation_id)
     VALUES ($1,$2,$3,'{"paths":[]}'::jsonb,$4,$5,$6,NULL,$7)`,
    [
      `cst-${randomUUID()}`,
      input.artifactId,
      input.snapshotRevisionId,
      input.connectorInstance,
      input.resourceType,
      input.resourceId,
      input.operationId ?? `op-${randomUUID()}`,
    ],
  );
}

async function repairRow(repairId: string) {
  const r = await pool(
    `SELECT route, status, successor_gate_id, successor_artifact_id, successor_representation_revision_id, change_summary
     FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE id=$1`,
    [repairId],
  );
  return r.rows[0] as
    | {
        route: string;
        status: string;
        successor_gate_id: string | null;
        successor_artifact_id: string | null;
        successor_representation_revision_id: string | null;
        change_summary: string | null;
      }
    | undefined;
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

  const authAdmin = new Client({ connectionString: DB_URL });
  await authAdmin.connect();
  await authAdmin.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG, ORG, ORG],
  );
  await authAdmin.query(
    `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
    [MEMBER_USER, MEMBER_USER, `${MEMBER_USER}@2286-s10-pr2.test`],
  );
  await authAdmin.query(
    `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, 'member', now()) ON CONFLICT (id) DO NOTHING`,
    [`m-2286-s10-pr2-${ORG}`, ORG, MEMBER_USER],
  );
  await authAdmin.end();

  outboxStore = await import("../lifecycle-produced-outbox-store");
  gateStore = await import("../artifact-review-gate-store");
  orch = await import("../lifecycle-review-orchestration-store");
  crStore = await import("../lifecycle-review-changes-requested-store");
  dispatchStore = await import("../lifecycle-repair-dispatch-store");
  bridge = await import("../lifecycle-repair-cms-production-bridge");
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
  const authAdmin = new Client({ connectionString: DB_URL });
  await authAdmin.connect();
  await authAdmin.query(`DELETE FROM public."member" WHERE "userId" = $1`, [MEMBER_USER]).catch(() => {});
  await authAdmin.query(`DELETE FROM public."user" WHERE id = $1`, [MEMBER_USER]).catch(() => {});
  await authAdmin.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG]).catch(() => {});
  await authAdmin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

/** Drive a produced CMS-snapshot artifact through auto-gate → typed
 * changes-request → producer repair → delivery, returning the dispatched
 * repair's identity. */
async function driveToDispatchedCmsRepair(): Promise<{
  repairId: string;
  repairRunId: string;
  base: ArtifactProducedEvent;
  connectorInstance: string;
  resourceType: string;
  resourceId: string;
}> {
  const templateId = await seedTemplate(
    `@cinatra-ai/declared-cms-${randomUUID()}-agent`,
    MANIFEST_REPAIR_CAPABLE,
  );
  const producerRunId = await seedRun(templateId);
  const base = await produce({ producerRunId, emitter: CMS_SNAPSHOT_EMITTER });
  const connectorInstance = `wp-instance-${randomUUID()}`;
  const resourceType = "post";
  const resourceId = `post-${randomUUID()}`;
  await insertCmsSnapshotTarget({
    artifactId: base.artifactId,
    snapshotRevisionId: base.representationRevisionId,
    connectorInstance,
    resourceType,
    resourceId,
  });

  await orch.sweepReviewOrchestration({ limit: 50 });
  const baseTaskId = autoReviewTaskId(base.eventId);
  const baseGate = await gateStore.readReviewGate(producerRunId, baseTaskId);
  expect(baseGate).not.toBeNull();

  const cr = await crStore.recordReviewSurfaceChangesRequested({
    runId: producerRunId,
    reviewTaskId: baseTaskId,
    baseTarget: { artifactId: base.artifactId, representationRevisionId: base.representationRevisionId },
    currentBaseRevisionId: base.representationRevisionId,
    feedback: "fix the title",
  });
  expect(cr.ok).toBe(true);
  if (!cr.ok) throw new Error(`changes-request failed: ${cr.error}`);
  expect(cr.route.kind).toBe("producer_repair");

  const dispatched = await dispatchStore.dispatchPendingProducerRepairs();
  expect(dispatched.dispatched).toBe(1);
  const repairRunId = dispatchStore.repairRunId(cr.repairId);

  return { repairId: cr.repairId, repairRunId, base, connectorInstance, resourceType, resourceId };
}

describe.skipIf(!HAS_DB)("cinatra#2286 S10 PR2 — the delivered-repair execution bridge", () => {
  it("TASK CONSTRUCTION: a CMS base target projects a task onto the dispatched run's inputParams", async () => {
    const ctx = await driveToDispatchedCmsRepair();
    const runRow = await pool(
      `SELECT input_params FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`,
      [ctx.repairRunId],
    );
    const inputParams = JSON.parse((runRow.rows[0] as { input_params: string }).input_params) as {
      task?: string;
      lifecycleRepairRequest?: unknown;
    };
    expect(inputParams.task).toBeDefined();
    expect(inputParams.task).toContain(ctx.resourceType);
    expect(inputParams.task).toContain(ctx.connectorInstance);
    expect(inputParams.lifecycleRepairRequest).toBeDefined();
  });

  it("TASK CONSTRUCTION (non-CMS): a non-CMS base target projects NO task (byte-identical dispatch for e.g. blog)", async () => {
    const templateId = await seedTemplate(
      `@cinatra-ai/declared-noncms-${randomUUID()}-agent`,
      MANIFEST_REPAIR_CAPABLE,
    );
    const producerRunId = await seedRun(templateId);
    // A plain (non-CMS) production — no cms_snapshot_targets row for its base.
    const base = await produce({ producerRunId });
    await orch.sweepReviewOrchestration({ limit: 50 });
    const baseTaskId = autoReviewTaskId(base.eventId);

    const cr = await crStore.recordReviewSurfaceChangesRequested({
      runId: producerRunId,
      reviewTaskId: baseTaskId,
      baseTarget: { artifactId: base.artifactId, representationRevisionId: base.representationRevisionId },
      currentBaseRevisionId: base.representationRevisionId,
      feedback: "fix the copy",
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    await dispatchStore.dispatchPendingProducerRepairs();
    const repairRunId = dispatchStore.repairRunId(cr.repairId);
    const runRow = await pool(
      `SELECT input_params FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`,
      [repairRunId],
    );
    const inputParams = JSON.parse((runRow.rows[0] as { input_params: string }).input_params) as {
      task?: string;
    };
    expect(inputParams.task).toBeUndefined();
  });

  it("COMPLETION ADAPTER: a matching CMS-snapshot production is found and submitted as the repair response", async () => {
    const ctx = await driveToDispatchedCmsRepair();

    // The dispatched repair run's own tool call re-drives the connector's
    // capture path — simulated here by minting the SAME shape of production
    // (outbox row + cms_snapshot_targets row) `captureCmsContentSnapshot`
    // would have written, with `producerRunId` set to the REPAIR run's id.
    // A FRESH artifact id (never `ctx.base.artifactId`) — the bridge's own
    // doc comment states every capture mints a fresh artifact id, and
    // reusing the base's here would leave two `cms_snapshot_targets` rows on
    // ONE artifact id, a shape `findMatchingCmsProduction` cannot occur in
    // production (and would ambiguate its lookup).
    const successorArtifactId = `art-repaired-${randomUUID()}`;
    const successorRev = `rev-repaired-${randomUUID()}`;
    await insertObject(successorArtifactId, "document", ORG);
    await insertCmsSnapshotTarget({
      artifactId: successorArtifactId,
      snapshotRevisionId: successorRev,
      connectorInstance: ctx.connectorInstance,
      resourceType: ctx.resourceType,
      resourceId: ctx.resourceId,
    });
    await outboxStore.emitArtifactProduced(
      {
        eventId: producedEventId(successorArtifactId, successorRev),
        orgId: ORG,
        artifactId: successorArtifactId,
        representationRevisionId: successorRev,
        eventKind: "artifact_produced",
        emitter: CMS_SNAPSHOT_EMITTER,
        producerRunId: ctx.repairRunId,
        producerAgentId: null,
        originKind: "agent_produced",
        destinationClass: "external_publish",
        continuationMode: "async_effects_gated",
        continuationAddress: null,
      },
      dbMod.db,
    );

    const completion = await bridge.completeDispatchedProducerCmsRepairs({ limit: 50 });
    expect(completion.completed).toBeGreaterThanOrEqual(1);

    const row = await repairRow(ctx.repairId);
    expect(row!.status).toBe("repaired");
    expect(row!.successor_artifact_id).toBe(successorArtifactId);
    expect(row!.successor_representation_revision_id).toBe(successorRev);
    expect(row!.successor_gate_id).not.toBeNull();

    // Idempotent re-drain: the repair is already `repaired`, not `dispatched` —
    // nothing further should happen to THIS repair. Assert on `completed`
    // (an outcome scoped to rows the drain actually finalizes) rather than
    // `scanned`: the global `dispatched`/`producer_repair` scan is a
    // system-wide sweep with no per-test/org filter, so earlier tests in this
    // suite legitimately leave their own repairs sitting in `dispatched` —
    // `scanned` picks those up too and is not a property this test owns.
    const again = await bridge.completeDispatchedProducerCmsRepairs({ limit: 50 });
    expect(again.completed).toBe(0);
  });

  it("NO MATCH: a terminal run with no matching CMS production leaves the repair open (never silently finalized wrong)", async () => {
    const ctx = await driveToDispatchedCmsRepair();
    // Mark the repair run terminal with NO matching production ever landing.
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status='completed' WHERE id=$1`, [
      ctx.repairRunId,
    ]);

    const completion = await bridge.completeDispatchedProducerCmsRepairs({ limit: 50 });
    expect(completion.unresolved).toBeGreaterThanOrEqual(1);

    const row = await repairRow(ctx.repairId);
    expect(row!.status).toBe("dispatched");
    expect(row!.successor_gate_id).toBeNull();
  });

  it("STILL RUNNING: a repair run with no matching production yet, still in flight, is left pending (re-checked next pass)", async () => {
    const ctx = await driveToDispatchedCmsRepair();
    // The freshly-dispatched run defaults to `queued` — not terminal.
    const completion = await bridge.completeDispatchedProducerCmsRepairs({ limit: 50 });
    expect(completion.pending).toBeGreaterThanOrEqual(1);
    const row = await repairRow(ctx.repairId);
    expect(row!.status).toBe("dispatched");
  });
});
