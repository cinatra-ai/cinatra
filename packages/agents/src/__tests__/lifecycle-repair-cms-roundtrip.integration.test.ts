/**
 * cinatra#2286, epic S10 PR4 — the CMS repair ROUND TRIP, proven end-to-end
 * against a real Postgres, with the producing template carrying the REAL
 * `@cinatra-ai/wordpress-agent` identity + the lifecycle declaration the
 * lock-pinned release ships (`cinatra.lifecycle: { repairCapable: true }` — the
 * exact block the pin this PR advances brings into the dev universe; the
 * release is identified by its `resolvedSha` in cinatra-dev-extensions.lock.json).
 *
 * What the sibling suites already prove is NOT re-argued here:
 *   - delivery + CMS task construction + completion adapter mechanics
 *     (`lifecycle-repair-cms-production-bridge.integration.test.ts`, PR2);
 *   - the generic single-gated-successor invariant for a SAME-ARTIFACT
 *     successor revision (`lifecycle-repair-successor-batch.integration.test.ts`,
 *     cinatra#2047 OBS-2).
 *
 * What THIS suite adds (deliverables 3 + 7 of cinatra#2286):
 *
 *   ROUND TRIP     — request-changes on a produced CMS snapshot → the resolver
 *                    routes `producer_repair` off the wordpress-agent-named
 *                    template's manifest declaration → dispatch → the producer's
 *                    re-staged CMS capture (fresh artifact, same resource
 *                    identity) → completion drain submits the repair response →
 *                    the drain's PRODUCTION capture writer pins a `repaired`
 *                    record against the successor target (cinatra#2044 / #2046 —
 *                    this suite writes no capture row of its own; it asserts the
 *                    shipped writer fired) → the repair-successor gate is re-reviewed
 *                    and APPROVED → the held external effect releases through
 *                    that gate (the apply authorization) → the successor's
 *                    read-back binding still names the same CMS resource.
 *   EXACTLY ONE GATE — the CMS-specific duplicate-gate proof: the re-staged
 *                    write's own produced event NEVER mints an auto-gate. While
 *                    the repair is open the event stays pending (no gate); after
 *                    the response lands the event settles UNLINKED and the
 *                    repaired revision is owned by exactly ONE gate — the repair
 *                    successor gate. PROOF of merged suppression behaviour
 *                    (`classifyRepairRunProduction`), no new suppression code.
 *
 * The CMS shape differs from OBS-2's in exactly the ways that make this a
 * distinct proof: the successor is a FRESH artifact id (a CMS capture always
 * mints one), the response is submitted by the CMS production bridge's drain
 * (never `submitRepairResponse` called directly), and the completion carries
 * the live principal re-verification PR2 added.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

import {
  producedEventId,
  type ArtifactProducedEvent,
} from "@/lib/lifecycle/lifecycle-produced-event";
import { autoReviewTaskId, isRepairSuccessorTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import { agentLifecycleDeclarationSchema } from "../verdaccio/package-contract";
import { publishCmsRepairedCapturePort } from "../cms-repaired-capture-port";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_lifecycle_2286_s10_pr4";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2286-s10-pr4";
const MEMBER_USER = "user-2286-s10-pr4-member";
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

/** The producing package under proof — the REAL extension identity, not a
 * synthetic name: the resolver must route off the same `package_name` →
 * `lifecycle_config` chain a real wordpress-agent install produces. */
const WORDPRESS_AGENT_PACKAGE = "@cinatra-ai/wordpress-agent";

/**
 * The lifecycle declaration `@cinatra-ai/wordpress-agent` ships in its
 * `package.json#cinatra.lifecycle` at the release the committed dev lock pins
 * (its `resolvedSha` in cinatra-dev-extensions.lock.json). Kept as a
 * literal (the clone-back extension tree is not materialized in the DB-tier CI
 * job) but NEVER a free-floating stub:
 *   - it must PARSE through the real manifest contract
 *     (`agentLifecycleDeclarationSchema`) — the same schema
 *     `installAgentFromPackage` compiles onto `agent_templates.lifecycle_config`;
 *   - whenever the pinned clone-back tree IS on disk (dev checkouts, the
 *     conformance jobs), the literal is cross-checked byte-for-byte against the
 *     REAL pinned manifest — a manifest drift fails this suite there.
 */
const WORDPRESS_AGENT_LIFECYCLE = { repairCapable: true } as const;
const CMS_SNAPSHOT_EMITTER = "object_cms_snapshot_capture";

// The PRODUCTION repaired-capture chain (cinatra#2044 / #2046): the adapter the
// boot binder publishes, and the capture store's own deterministic id. Loaded
// REAL — the whole point of this suite's third-picture proof is that no test
// code writes the capture row — but DYNAMICALLY, in `beforeAll` after
// `SUPABASE_SCHEMA` is set: `postgresSchema` is a module-LOAD-time constant, so
// a static import here would bind the host's capture writer to the default
// `cinatra` schema and every one of its reads would miss this suite's schema.
let captureBinder: typeof import("@/lib/register-cms-review-host-seam-runtime");
let captureStore: typeof import("@/lib/artifacts/cms-preview-capture-store");

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

/** `agent_templates.package_name` is UNIQUE (`agent_templates_package_name_idx`),
 * so the wordpress-agent template is seeded ONCE and shared by every drive. */
let wordpressTemplateId: string | null = null;
async function seedWordPressAgentTemplate(): Promise<string> {
  if (wordpressTemplateId) return wordpressTemplateId;
  const templateId = `tmpl-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
     VALUES ($1,$2,'organization',$2,'seed','seed','[]','{}','{}',$3,$4)`,
    [templateId, ORG, WORDPRESS_AGENT_PACKAGE, JSON.stringify(WORDPRESS_AGENT_LIFECYCLE)],
  );
  wordpressTemplateId = templateId;
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
    emitter: CMS_SNAPSHOT_EMITTER,
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
 * `buildCmsSnapshotCaptureQueries`'s `targetInsert`, same as PR2's suite). */
async function insertCmsSnapshotTarget(input: {
  artifactId: string;
  snapshotRevisionId: string;
  connectorInstance: string;
  resourceType: string;
  resourceId: string | null;
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
      `op-${randomUUID()}`,
    ],
  );
}

/** EVERY gate whose frozen `pinned_targets` set contains this revision — the
 * "how many gates own this revision" question the duplicate-gate proof turns
 * on (mirrors the OBS-2 suite's helper). */
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

async function repairRow(repairId: string) {
  const r = await pool(
    `SELECT route, status, successor_gate_id, successor_artifact_id,
            successor_representation_revision_id, change_summary
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

/** The reviewer's approval on the successor gate (the re-review) — the same
 * resolution shape the OBS-2 suite drives. */
async function resolveGateApprove(gateId: string) {
  await pool(
    `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
     SET status='resolved', disposition='approve', fingerprint=$2, resolved_at=now()
     WHERE id=$1 AND status='pending'`,
    [gateId, `fp-${randomUUID()}`],
  );
}

/** One full maintenance cycle of the app's own background drains, in the order
 * the boot loops run them (mirrors the OBS-2 suite). */
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

  const authAdmin = new Client({ connectionString: DB_URL });
  await authAdmin.connect();
  await authAdmin.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG, ORG, ORG],
  );
  await authAdmin.query(
    `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
    [MEMBER_USER, MEMBER_USER, `${MEMBER_USER}@2286-s10-pr4.test`],
  );
  await authAdmin.query(
    `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, 'member', now()) ON CONFLICT (id) DO NOTHING`,
    [`m-2286-s10-pr4-${ORG}`, ORG, MEMBER_USER],
  );
  await authAdmin.end();

  outboxStore = await import("../lifecycle-produced-outbox-store");
  gateStore = await import("../artifact-review-gate-store");
  orch = await import("../lifecycle-review-orchestration-store");
  crStore = await import("../lifecycle-review-changes-requested-store");
  dispatchStore = await import("../lifecycle-repair-dispatch-store");
  bridge = await import("../lifecycle-repair-cms-production-bridge");
  dbMod = await import("../db");

  // Publish the PRODUCTION repaired-capture adapter — the same one the boot
  // phase `bind-cms-review-host-seam` publishes via
  // `bindCmsReviewHostSeamRuntime()`. Only the boot CALL SITE is stubbed out
  // here (this suite never boots the app); the adapter, the capture
  // orchestrator and the store writer behind it are all production code, so the
  // `repaired` row this suite asserts is one NO test code wrote.
  captureBinder = await import("@/lib/register-cms-review-host-seam-runtime");
  captureStore = await import("@/lib/artifacts/cms-preview-capture-store");
  publishCmsRepairedCapturePort(captureBinder.createCmsRepairedCapturePort());
}, 90_000);

beforeEach(() => {
  if (!HAS_DB) return;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
});

afterAll(async () => {
  if (!HAS_DB) return;
  delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
  publishCmsRepairedCapturePort(undefined);
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

interface CmsRepairContext {
  base: ArtifactProducedEvent;
  baseGateId: string;
  repairId: string;
  repairRunId: string;
  connectorInstance: string;
  resourceType: string;
  resourceId: string;
}

/** Drive a produced CMS snapshot (wordpress-agent-produced) through auto-gate →
 * typed changes-request → producer repair → delivery, leaving an open repair on
 * its dispatched repair run. */
async function driveToDispatchedWordPressRepair(): Promise<CmsRepairContext> {
  const templateId = await seedWordPressAgentTemplate();
  const producerRunId = await seedRun(templateId);
  const base = await produce({ producerRunId });
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
  // The base production is single-gated too — the control for the invariant.
  expect((await gatesPinning(base.artifactId, base.representationRevisionId)).map((g) => g.id)).toEqual([
    baseGate!.id,
  ]);

  const cr = await crStore.recordReviewSurfaceChangesRequested({
    runId: producerRunId,
    reviewTaskId: baseTaskId,
    baseTarget: { artifactId: base.artifactId, representationRevisionId: base.representationRevisionId },
    currentBaseRevisionId: base.representationRevisionId,
    feedback: "tighten the headline and fix the excerpt",
  });
  expect(cr.ok).toBe(true);
  if (!cr.ok) throw new Error(`changes-request failed: ${cr.error}`);
  // THE ROUTING PROOF: `changes_requested` on a wordpress-agent production
  // resolves `producer_repair` off the template's manifest-declared capability.
  expect(cr.route.kind).toBe("producer_repair");

  const dispatched = await dispatchStore.dispatchPendingProducerRepairs();
  expect(dispatched.dispatched).toBe(1);
  return {
    base,
    baseGateId: baseGate!.id,
    repairId: cr.repairId,
    repairRunId: dispatchStore.repairRunId(cr.repairId),
    connectorInstance,
    resourceType,
    resourceId,
  };
}

/** The producer's re-staged CMS write for the repair: a FRESH capture artifact
 * carrying the SAME resource identity, produced by the repair run (the shape
 * `captureCmsContentSnapshot` writes when the repair run's tool call re-drives
 * the connector's staged-write path). */
async function mintRepairedProduction(ctx: CmsRepairContext): Promise<{
  artifactId: string;
  revisionId: string;
  eventId: string;
}> {
  const artifactId = `art-repaired-${randomUUID()}`;
  const revisionId = `rev-repaired-${randomUUID()}`;
  await insertObject(artifactId, "document", ORG);
  await insertCmsSnapshotTarget({
    artifactId,
    snapshotRevisionId: revisionId,
    connectorInstance: ctx.connectorInstance,
    resourceType: ctx.resourceType,
    resourceId: ctx.resourceId,
  });
  const ev = await produce({
    artifactId,
    representationRevisionId: revisionId,
    producerRunId: ctx.repairRunId,
  });
  return { artifactId, revisionId, eventId: ev.eventId };
}

describe.skipIf(!HAS_DB)("cinatra#2286 S10 PR4 — the WordPress CMS repair round trip", () => {
  it("manifest ground truth: the declared lifecycle block is contract-valid and matches the pinned wordpress-agent manifest where materialized", () => {
    // The literal parses through the REAL manifest contract — the same schema an
    // install compiles onto `agent_templates.lifecycle_config`.
    const parsed = agentLifecycleDeclarationSchema.parse(WORDPRESS_AGENT_LIFECYCLE);
    expect(parsed.repairCapable).toBe(true);

    // The committed dev lock pins the wordpress-agent release this literal is
    // copied from; when the pinned clone-back tree is on disk, cross-check the
    // REAL manifest byte-for-byte.
    const lock = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "cinatra-dev-extensions.lock.json"), "utf8"),
    ) as { packages: Array<{ packageName: string; resolvedSha: string }> };
    const pin = lock.packages.find((p) => p.packageName === WORDPRESS_AGENT_PACKAGE);
    expect(pin).toBeDefined();
    expect(pin!.resolvedSha).toMatch(/^[0-9a-f]{40}$/);

    const manifestPath = resolve(REPO_ROOT, "extensions", "cinatra-ai", "wordpress-agent", "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        cinatra?: { lifecycle?: unknown };
      };
      expect(manifest.cinatra?.lifecycle).toEqual(WORDPRESS_AGENT_LIFECYCLE);
    }
  });

  it("ROUND TRIP: request-changes → producer repair → repaired capture → re-review → approve → apply released → read-back binding", async () => {
    const ctx = await driveToDispatchedWordPressRepair();

    // The dispatched run carries the delivered request + the CMS task text.
    const runRow = await pool(
      `SELECT input_params FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`,
      [ctx.repairRunId],
    );
    const inputParams = JSON.parse((runRow.rows[0] as { input_params: string }).input_params) as {
      task?: string;
      lifecycleRepairRequest?: unknown;
    };
    expect(inputParams.lifecycleRepairRequest).toBeDefined();
    expect(inputParams.task).toContain(ctx.resourceId);

    // The producer answers: a fresh re-staged capture on the same CMS resource.
    const repaired = await mintRepairedProduction(ctx);

    // The completion drain finds the matching production and submits the
    // repair response (live principal re-verification inside).
    const completion = await bridge.completeDispatchedProducerCmsRepairs({ limit: 50 });
    expect(completion.completed).toBeGreaterThanOrEqual(1);
    const row = await repairRow(ctx.repairId);
    expect(row!.status).toBe("repaired");
    expect(row!.successor_artifact_id).toBe(repaired.artifactId);
    expect(row!.successor_representation_revision_id).toBe(repaired.revisionId);
    const successorGateId = row!.successor_gate_id!;
    expect(successorGateId).not.toBeNull();

    // THE THIRD PICTURE (cinatra#2044 / #2046) — written by PRODUCTION code
    // inside the drain call above. NOTHING in this suite inserts it: the port
    // published in `beforeAll` is `createCmsRepairedCapturePort()`, the very
    // adapter `bindCmsReviewHostSeamRuntime()` publishes at boot, which drives
    // the real `captureRepairedPreviewForGate` → `writePinnedPreviewCapture`.
    // Before this writer existed the drain wrote no `repaired` record at all and
    // the successor pair rendered "This side was never captured" forever.
    //
    // The drain's own counters first: the capture was ATTEMPTED and accounted
    // for, and it was not the silent class — `repairedCaptureMissing` is the one
    // outcome that leaves the gate with no picture AND no stated reason.
    expect(
      completion.repairedCaptured +
        completion.repairedCaptureDegraded +
        completion.repairedCaptureMissing,
    ).toBeGreaterThanOrEqual(1);
    expect(completion.repairedCaptureMissing).toBe(0);

    // The row itself, at the STORE's own deterministic id (imported real, not
    // mirrored), bound to the SUCCESSOR target — never the base. That binding is
    // exactly what #2287's `loadPinnedRepairPair` reads for its right-hand side.
    const captureId = captureStore.previewCaptureArtifactId(
      repaired.artifactId,
      repaired.revisionId,
      "repaired",
    );
    const captureRead = await pool(
      `SELECT data FROM "${q(TEST_SCHEMA)}"."objects" WHERE id=$1 AND type=$2 AND org_id=$3`,
      [captureId, captureStore.CMS_PREVIEW_CAPTURE_OBJECT_TYPE, ORG],
    );
    expect(captureRead.rows).toHaveLength(1);
    const captureData = captureRead.rows[0] as { data: unknown };
    const capture = (
      typeof captureData.data === "string" ? JSON.parse(captureData.data) : captureData.data
    ) as {
      role: string;
      status: string;
      degradedReason: string | null;
      boundArtifactId: string;
      boundSnapshotRevisionId: string;
    };
    expect(capture.role).toBe("repaired");
    expect(capture.boundArtifactId).toBe(repaired.artifactId);
    expect(capture.boundSnapshotRevisionId).toBe(repaired.revisionId);

    // This suite seeds no connect-registered site (it proves the repair LOOP,
    // not a live CMS), so the capture's addressing policy refuses first and the
    // honest outcome is a degraded record carrying that NAMED reason. That is
    // exactly the fix: the successor gate now STATES its gap instead of silently
    // rendering "This side was never captured". The `captured` shape and every
    // other degrade class are pinned against the real orchestrator in
    // src/lib/artifacts/__tests__/cms-preview-capture-repaired.test.ts.
    expect(capture.status).toBe("degraded");
    expect(capture.degradedReason).toBe("no-registered-site");

    // App sweeps settle the successor's own event; the ORIGINAL producing
    // event's held effect was re-pointed onto the successor gate.
    await runAppSweeps();
    const basePointer = await outboxRow(ctx.base.eventId);
    expect(basePointer!.continuation_address).toBe(successorGateId);

    // RE-REVIEW: the successor gate is pending + pinned to the repaired target;
    // the reviewer approves it.
    const successorGates = await gatesPinning(repaired.artifactId, repaired.revisionId);
    expect(successorGates.map((g) => g.id)).toEqual([successorGateId]);
    expect(successorGates[0].status).toBe("pending");
    expect(isRepairSuccessorTaskId(successorGates[0].review_task_id)).toBe(true);
    await resolveGateApprove(successorGateId);

    // APPLY: the held external effect (carried by the ORIGINAL producing event)
    // releases through the APPROVED successor gate — the apply authorization,
    // under the reviewer's own approval, never the dispatcher authority.
    const released = await orch.resolveArtifactEffectDisposition({
      artifactId: ctx.base.artifactId,
      representationRevisionId: ctx.base.representationRevisionId,
    });
    expect(released.disposition).toBe("approved");
    expect(released.gate?.gateId).toBe(successorGateId);

    // READ-BACK: the successor's committed apply binding still names the SAME
    // CMS resource — the exact identity the read-back verification drives
    // against the site after the apply.
    const readBack = await pool(
      `SELECT connector_instance, resource_type, resource_id
         FROM "${q(TEST_SCHEMA)}"."cms_snapshot_targets"
        WHERE artifact_id=$1 AND snapshot_revision_id=$2`,
      [repaired.artifactId, repaired.revisionId],
    );
    expect(readBack.rows).toHaveLength(1);
    expect(readBack.rows[0]).toEqual({
      connector_instance: ctx.connectorInstance,
      resource_type: ctx.resourceType,
      resource_id: ctx.resourceId,
    });
  });

  it("EXACTLY ONE GATE: the repaired revision is owned solely by the repair-successor gate — no auto-gate from the re-staged write", async () => {
    const ctx = await driveToDispatchedWordPressRepair();
    const repaired = await mintRepairedProduction(ctx);

    // LEG A — repair still OPEN (dispatched): the sweep does NOT auto-gate the
    // re-staged write; the event stays pending (re-evaluated later), the
    // repaired revision owns NO gate yet.
    await orch.sweepReviewOrchestration({ limit: 50 });
    expect(await gatesPinning(repaired.artifactId, repaired.revisionId)).toEqual([]);
    expect((await outboxRow(repaired.eventId))!.status).toBe("pending");

    // The response lands through the CMS completion drain.
    const completion = await bridge.completeDispatchedProducerCmsRepairs({ limit: 50 });
    expect(completion.completed).toBeGreaterThanOrEqual(1);
    const row = await repairRow(ctx.repairId);
    const successorGateId = row!.successor_gate_id!;

    // LEG B — repair REPAIRED: the sweeps settle the successor's event UNLINKED
    // (its gate is the successor gate; linking it would double-gate), and the
    // repaired revision is owned by EXACTLY ONE gate — the repair-successor
    // gate submitRepairResponse pinned.
    await runAppSweeps();
    const successorEvent = await outboxRow(repaired.eventId);
    expect(successorEvent!.status).toBe("processed");
    expect(successorEvent!.continuation_address).toBeNull();
    const gates = await gatesPinning(repaired.artifactId, repaired.revisionId);
    expect(gates.map((g) => g.id)).toEqual([successorGateId]);
    expect(isRepairSuccessorTaskId(gates[0].review_task_id)).toBe(true);

    // A later sweep cycle never re-gates it (idempotent settle).
    await runAppSweeps();
    expect((await gatesPinning(repaired.artifactId, repaired.revisionId)).map((g) => g.id)).toEqual([
      successorGateId,
    ]);
  });
});
