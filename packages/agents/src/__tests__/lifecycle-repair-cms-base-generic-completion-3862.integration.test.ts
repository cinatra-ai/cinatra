/**
 * cinatra#3862 leg 7 (slice 2) — the GENERIC repair completer on a repair whose
 * base is a captured CMS snapshot, against a real Postgres.
 *
 * Since slice 2 the generic completer (`completeDispatchedProducerRepairs`)
 * takes every dispatched repair, a captured CMS snapshot's included; the CMS
 * bridge's completer no longer runs. This suite drives a CMS base (an object of
 * the app-owned snapshot type with a `cms_snapshot_targets` row) to a
 * dispatched repair, and reads what the generic completer does with two answers
 * it must not finish:
 *
 *   CAPTURE ONLY      — the repair run's only write is a host capture (emitter
 *                       `object_cms_snapshot_capture`). The completer never
 *                       claims it, so the repair stays OPEN and counts
 *                       `unresolved`. The capture is seeded as a revision the
 *                       base's type WOULD accept, so without the emitter
 *                       exclusion it would be re-filed onto the base: the case
 *                       reads that no revision was filed.
 *   ACCEPTS MISMATCH  — the repair run answers with a revision whose MIME the
 *                       snapshot type does not accept. The revision door
 *                       refuses the re-file (`accepts-mismatch`), nothing is
 *                       written onto the base, and the repair stays OPEN on
 *                       every maintenance sweep.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import {
  producedEventId,
  type ArtifactProducedEvent,
  type ProducedEventEmitter,
} from "@/lib/lifecycle/lifecycle-produced-event";
import { autoReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_lifecycle_3862_s2_cms_base";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-3862-s2-cms-base";
const MEMBER_USER = "user-3862-s2-cms-base-member";
const MANIFEST_REPAIR_CAPABLE = JSON.stringify({ repairCapable: true });
const CMS_SNAPSHOT_EMITTER: ProducedEventEmitter = "object_cms_snapshot_capture";
const CMS_SNAPSHOT_TYPE = "@cinatra-ai/objects:cms-content-snapshot";
const CMS_FIELDS_MIME = "application/vnd.cinatra.cms-fields+json";

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let crStore: typeof import("../lifecycle-review-changes-requested-store");
let dispatchStore: typeof import("../lifecycle-repair-dispatch-store");
let completion: typeof import("../lifecycle-repair-producer-completion-store");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

function producedEvent(over: Partial<ArtifactProducedEvent> & { producerRunId: string }): ArtifactProducedEvent {
  const artifactId = over.artifactId ?? `art-${randomUUID()}`;
  const representationRevisionId = over.representationRevisionId ?? `rev-${randomUUID()}`;
  return {
    eventId: producedEventId(artifactId, representationRevisionId),
    orgId: ORG,
    artifactId,
    representationRevisionId,
    eventKind: "artifact_produced",
    emitter: "createSemanticArtifact",
    producerAgentId: null,
    originKind: "agent_produced",
    destinationClass: "external_publish",
    continuationMode: "async_effects_gated",
    continuationAddress: null,
    ...over,
  };
}

/** A revision a run wrote: its object row, its substance and its representation,
 * marked with the run that wrote it, plus the outbox row that announces it. */
async function seedRunAnswer(input: {
  runId: string;
  type: string;
  mime: string;
  emitter: ProducedEventEmitter;
}): Promise<{ artifactId: string; revisionId: string }> {
  const artifactId = `art-${randomUUID()}`;
  const revisionId = `rev-${randomUUID()}`;
  const resourceId = `res-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, $2, $3::jsonb, $4)`,
    [artifactId, input.type, JSON.stringify({ artifactType: "file", mime: input.mime, latestRepresentationRevisionId: revisionId }), ORG],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."resource" (id, org_id, kind, substance_key, mime, size_bytes, created_by, metadata)
     VALUES ($1, $2, 'blob', $3, $4, 11, NULL, '{}'::jsonb)`,
    [resourceId, ORG, `blob:answer-${artifactId}`, input.mime],
  );
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."representation" (id, org_id, artifact_id, resource_id, revision, form, created_by_run_id)
     VALUES ($1, $2, $3, $4, 1, 'file', $5)`,
    [revisionId, ORG, artifactId, resourceId, input.runId],
  );
  await outboxStore.emitArtifactProduced(
    producedEvent({ artifactId, representationRevisionId: revisionId, producerRunId: input.runId, emitter: input.emitter }),
    dbMod.db,
  );
  return { artifactId, revisionId };
}

async function revisionsOn(artifactId: string): Promise<number> {
  const r = await pool(`SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."representation" WHERE artifact_id=$1`, [
    artifactId,
  ]);
  return (r.rows[0] as { n: number }).n;
}

async function repairRow(repairId: string) {
  const r = await pool(
    `SELECT status, successor_gate_id FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE id=$1`,
    [repairId],
  );
  return r.rows[0] as { status: string; successor_gate_id: string | null } | undefined;
}

/** A captured CMS snapshot (the app-owned type, with its `cms_snapshot_targets`
 * row) driven through auto-gate → typed changes-request → producer repair →
 * delivery; the repair run then finishes. Returns the dispatched repair. */
async function driveToFinishedCmsBaseRepair(): Promise<{ repairId: string; repairRunId: string; baseArtifactId: string }> {
  const templateId = `tmpl-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
     VALUES ($1,$2,'organization',$2,'seed','seed','[]','{}','{}',$3,$4)`,
    [templateId, ORG, `@cinatra-ai/declared-cms-${randomUUID()}-agent`, MANIFEST_REPAIR_CAPABLE],
  );
  const producerRunId = `run-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, run_by, input_params) VALUES ($1,$2,$3,$4,'{}')`,
    [producerRunId, templateId, ORG, MEMBER_USER],
  );
  const base = producedEvent({ producerRunId, emitter: CMS_SNAPSHOT_EMITTER });
  await pool(`INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, $2, '{}'::jsonb, $3)`, [
    base.artifactId,
    CMS_SNAPSHOT_TYPE,
    ORG,
  ]);
  await outboxStore.emitArtifactProduced(base, dbMod.db);
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."cms_snapshot_targets"
       (id, artifact_id, snapshot_revision_id, scope_manifest, connector_instance,
        resource_type, resource_id, base_remote_revision_ref, operation_id)
     VALUES ($1,$2,$3,'{"paths":[]}'::jsonb,$4,'post',$5,NULL,$6)`,
    [`cst-${randomUUID()}`, base.artifactId, base.representationRevisionId, `wp-${randomUUID()}`, `post-${randomUUID()}`, `op-${randomUUID()}`],
  );

  await orch.sweepReviewOrchestration({ limit: 50 });
  const baseTaskId = autoReviewTaskId(base.eventId);
  expect(await gateStore.readReviewGate(producerRunId, baseTaskId)).not.toBeNull();
  const cr = await crStore.recordReviewSurfaceChangesRequested({
    runId: producerRunId,
    reviewTaskId: baseTaskId,
    baseTarget: { artifactId: base.artifactId, representationRevisionId: base.representationRevisionId },
    currentBaseRevisionId: base.representationRevisionId,
    feedback: "fix the title",
  });
  if (!cr.ok) throw new Error(`changes-request failed: ${cr.error}`);
  expect(cr.route.kind).toBe("producer_repair");
  expect((await dispatchStore.dispatchPendingProducerRepairs()).dispatched).toBe(1);
  const repairRunId = dispatchStore.repairRunId(cr.repairId);
  await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status='completed' WHERE id=$1`, [repairRunId]);
  return { repairId: cr.repairId, repairRunId, baseArtifactId: base.artifactId };
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

  const authAdmin = new Client({ connectionString: DB_URL });
  await authAdmin.connect();
  await authAdmin.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG, ORG, ORG],
  );
  await authAdmin.query(
    `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
    [MEMBER_USER, MEMBER_USER, `${MEMBER_USER}@3862-s2.test`],
  );
  await authAdmin.query(
    `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, 'member', now()) ON CONFLICT (id) DO NOTHING`,
    [`m-3862-s2-${ORG}`, ORG, MEMBER_USER],
  );
  await authAdmin.end();

  outboxStore = await import("../lifecycle-produced-outbox-store");
  gateStore = await import("../artifact-review-gate-store");
  orch = await import("../lifecycle-review-orchestration-store");
  crStore = await import("../lifecycle-review-changes-requested-store");
  dispatchStore = await import("../lifecycle-repair-dispatch-store");
  completion = await import("../lifecycle-repair-producer-completion-store");
  dbMod = await import("../db");
}, 90_000);

beforeEach(async () => {
  if (!HAS_DB) return;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
  // Each case reads exact counts, so no dispatched repair of an earlier case is
  // left in the completer's scan.
  await pool(`UPDATE "${q(TEST_SCHEMA)}"."lifecycle_repair" SET status='stale' WHERE status='dispatched'`);
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

describe.skipIf(!HAS_DB)("cinatra#3862 leg 7 — the generic completer on a captured CMS base", () => {
  it("CAPTURE ONLY: a repair run whose only write is a host capture is never claimed; the repair stays open, unresolved", async () => {
    const ctx = await driveToFinishedCmsBaseRepair();
    // A revision the snapshot type accepts, written by the repair run, but by
    // the capture writer's emitter.
    await seedRunAnswer({ runId: ctx.repairRunId, type: CMS_SNAPSHOT_TYPE, mime: CMS_FIELDS_MIME, emitter: CMS_SNAPSHOT_EMITTER });

    const summary = await completion.completeDispatchedProducerRepairs({ limit: 50 });

    expect(summary).toEqual({ scanned: 1, completed: 0, pending: 0, unresolved: 1, failed: 0 });
    expect(await repairRow(ctx.repairId)).toEqual({ status: "dispatched", successor_gate_id: null });
    expect(await revisionsOn(ctx.baseArtifactId)).toBe(0);
  });

  it("ACCEPTS MISMATCH: an answer the snapshot type does not accept is refused at the door; the repair stays open on every sweep", async () => {
    const ctx = await driveToFinishedCmsBaseRepair();
    await seedRunAnswer({ runId: ctx.repairRunId, type: "document", mime: "text/html", emitter: "createSemanticArtifact" });

    for (const pass of [1, 2]) {
      const summary = await orch.sweepLifecycleGateMaintenance();
      expect({ pass, completed: summary.producerRepairsCompleted, unresolved: summary.producerRepairsUnresolved }).toEqual({
        pass,
        completed: 0,
        unresolved: 1,
      });
      expect(await repairRow(ctx.repairId)).toEqual({ status: "dispatched", successor_gate_id: null });
      expect(await revisionsOn(ctx.baseArtifactId)).toBe(0);
    }
  });
});
