/**
 * cinatra#4264 slice B1b T14: a Regenerate segment run's write lands under ONE
 * gate, crash-safe.
 *
 * A segment run writes its filing node's output as its own production on the
 * repair run; the completer re-files it onto the reviewed artifact and answers
 * the repair with `submitRepairResponse`, recording the segment's own write as
 * the repair's source target in the SAME update that sets `repaired` and the
 * successor. Driven on a real Postgres through the shipped entry points:
 *
 *   ONE GATE   the successor is pinned by exactly the successor gate, and the
 *              segment's own produced event settles under it (`successor-gated`):
 *              no second review gate pins the segment's revision.
 *   CRASH      the run wrote, the completer never answered: the segment's
 *              produced event stays PENDING (the repair is open) and no gate
 *              pins it; nothing is half-written on the repair row.
 *   ORDINARY   an ordinary repair (no source target) still gates a sibling write
 *              normally: the new settle rule names only the recorded source.
 *
 * Red at the B1a head: `submitRepairResponse` has no `sourceTarget`, so the
 * segment's revision is auto-gated a second time.
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
import { autoReviewTaskId, isRepairSuccessorTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_lifecycle_4264_b1b";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-4264-b1b";
/** cinatra#2286 S10 PR2 — the principal fix: a dispatched repair now requires
 * the ORIGINATING producing run's `runBy` to resolve a LIVE org membership
 * (`resolveOrgRoleForUser`), so every `seedRun` in this suite needs a real
 * `public."member"` row. `public."member"` is NOT part of `TEST_SCHEMA`
 * (better-auth tables are unqualified, always `public`) — mirrors the sibling
 * `lifecycle-repair-dispatch.integration.test.ts` suite's seeding. */
const MEMBER_USER = "user-4264-b1b-member";
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
       (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
     VALUES ($1,$2,'organization',$2,'seed','seed','[]','{}','{}',$3,$4)`,
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
  const { replayStoreSchema } = await import("@/lib/test-support/store-schema-replay");
  await replayStoreSchema(admin, buildCreateStoreSchemaQueries(TEST_SCHEMA));
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  // cinatra#2286 S10 PR2 — seed a real better-auth org/user/member row (see the
  // MEMBER_USER comment above); `public` schema, untouched by the TEST_SCHEMA swap.
  const authAdmin = new Client({ connectionString: DB_URL });
  await authAdmin.connect();
  await authAdmin.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG, ORG, ORG],
  );
  await authAdmin.query(
    `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
    [MEMBER_USER, MEMBER_USER, `${MEMBER_USER}@4264-b1b.test`],
  );
  await authAdmin.query(
    `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, 'member', now()) ON CONFLICT (id) DO NOTHING`,
    [`m-4264-b1b-${ORG}`, ORG, MEMBER_USER],
  );
  await authAdmin.end();

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
  const authAdmin = new Client({ connectionString: DB_URL });
  await authAdmin.connect();
  await authAdmin.query(`DELETE FROM public."member" WHERE "userId" = $1`, [MEMBER_USER]).catch(() => {});
  await authAdmin.query(`DELETE FROM public."user" WHERE id = $1`, [MEMBER_USER]).catch(() => {});
  await authAdmin.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG]).catch(() => {});
  await authAdmin.end().catch(() => {});
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
async function landRepair(
  ctx: RepairContext,
  successorRev: string,
  sourceTarget?: { artifactId: string; representationRevisionId: string },
): Promise<string> {
  const rr = await repairStore.submitRepairResponse({
    repairId: ctx.repairId,
    ...(sourceTarget ? { sourceTarget } : {}),
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

async function setRegenerateIntent(repairId: string, nodeId: string) {
  await pool(`UPDATE "${q(TEST_SCHEMA)}"."lifecycle_repair" SET regenerate_node_id=$2 WHERE id=$1`, [repairId, nodeId]);
}

async function repairColumns(repairId: string) {
  const r = await pool(
    `SELECT status, successor_gate_id, source_artifact_id, source_representation_revision_id
       FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE id=$1`,
    [repairId],
  );
  return r.rows[0] as {
    status: string;
    successor_gate_id: string | null;
    source_artifact_id: string | null;
    source_representation_revision_id: string | null;
  };
}

describe.skipIf(!HAS_DB)("cinatra#4264 B1b T14: a Regenerate segment's write lands under one gate", () => {
  it("ONE GATE: the segment's own write settles under the successor gate", async () => {
    const ctx = await driveToDispatchedRepair();
    await setRegenerateIntent(ctx.repairId, "file_image");
    // The segment's filing node wrote a NEW artifact on the repair run.
    const segmentWrite = await produce({ producerRunId: ctx.repairRunId });
    const successorRev = `rev-regenerated-${randomUUID()}`;
    await produce({
      artifactId: ctx.base.artifactId,
      representationRevisionId: successorRev,
      producerRunId: ctx.repairRunId,
    });
    const successorGateId = await landRepair(ctx, successorRev, {
      artifactId: segmentWrite.artifactId,
      representationRevisionId: segmentWrite.representationRevisionId,
    });

    const row = await repairColumns(ctx.repairId);
    expect(row.status).toBe("repaired");
    expect(row.successor_gate_id).toBe(successorGateId);
    expect(row.source_artifact_id).toBe(segmentWrite.artifactId);
    expect(row.source_representation_revision_id).toBe(segmentWrite.representationRevisionId);

    await runAppSweeps();

    const successorGates = await gatesPinning(ctx.base.artifactId, successorRev);
    expect(successorGates.map((g) => g.id)).toEqual([successorGateId]);
    expect(isRepairSuccessorTaskId(successorGates[0].review_task_id)).toBe(true);
    expect(await gatesPinning(segmentWrite.artifactId, segmentWrite.representationRevisionId)).toEqual([]);
    const segmentEvent = await outboxRow(segmentWrite.eventId);
    expect(segmentEvent!.status).toBe("processed");
  });

  it("CRASH: a written segment whose repair never answered stays pending and ungated", async () => {
    const ctx = await driveToDispatchedRepair();
    await setRegenerateIntent(ctx.repairId, "file_image");
    const segmentWrite = await produce({ producerRunId: ctx.repairRunId });

    await runAppSweeps();

    const row = await repairColumns(ctx.repairId);
    expect(row.status).toBe("dispatched");
    expect(row.successor_gate_id).toBeNull();
    expect(row.source_artifact_id).toBeNull();
    expect(row.source_representation_revision_id).toBeNull();
    expect(await gatesPinning(segmentWrite.artifactId, segmentWrite.representationRevisionId)).toEqual([]);
    expect((await outboxRow(segmentWrite.eventId))!.status).toBe("pending");
  });

  it("ORDINARY: without a source target a sibling write on the landed repair run is gated normally", async () => {
    const ctx = await driveToDispatchedRepair();
    const successorRev = `rev-repaired-${randomUUID()}`;
    await produce({
      artifactId: ctx.base.artifactId,
      representationRevisionId: successorRev,
      producerRunId: ctx.repairRunId,
    });
    const sibling = await produce({ producerRunId: ctx.repairRunId });
    const successorGateId = await landRepair(ctx, successorRev);
    await resolveGateApprove(successorGateId);
    await runAppSweeps();

    expect((await repairColumns(ctx.repairId)).source_artifact_id).toBeNull();
    const siblingGates = await gatesPinning(sibling.artifactId, sibling.representationRevisionId);
    expect(siblingGates.length).toBe(1);
    expect(siblingGates[0].id).not.toBe(successorGateId);
  });
});
