/**
 * cinatra#2046 — the DRUPAL producer half of the repair round trip, proven
 * against a real Postgres with the producing template carrying the REAL
 * `@cinatra-ai/drupal-agent` identity and the lifecycle declaration the release
 * this PR's pin advances to actually ships
 * (`cinatra.lifecycle: { repairCapable: true }`).
 *
 * WHY THIS SUITE EXISTS — the negative proof it answers. Driven live on
 * `origin/main` `5091632cd`, a reviewer's changes-request on a DRUPAL CMS
 * snapshot routed `human_escalation`, not `producer_repair`, with
 * `lifecycle_config = <NULL>` on the installed `@cinatra-ai/drupal-agent`
 * template: #2296 advanced ONLY `@cinatra-ai/wordpress-agent`, and the
 * previously lock-pinned drupal-agent 0.1.2 carried no `cinatra.lifecycle` block
 * (evidence comment on cinatra#2046, 2026-07-31). This suite is the executable
 * form of that finding and of its fix: the SAME drive, on the SAME real package
 * identity, is asserted BOTH ways — escalation on the pre-pin (NULL) column, and
 * `producer_repair` + a real dispatch on the pinned declaration.
 *
 * WHAT THIS SUITE DELIBERATELY DOES NOT RE-ARGUE. Everything downstream of the
 * dispatch is CMS-GENERIC and already proven end to end by #2296's suite
 * (`lifecycle-repair-cms-roundtrip.integration.test.ts`): the repaired capture,
 * the re-review, the approval-released apply, the read-back binding and the
 * exactly-one-gate invariant. Core's CMS bridge keys on its own outbox /
 * snapshot-target rows and never on a package name
 * (`lifecycle-repair-cms-production-bridge.ts`), so re-driving those rungs under
 * a Drupal name would duplicate a proof rather than add one. What is genuinely
 * Drupal-specific — and what the pin is FOR — is everything up to and including
 * the dispatch, plus the CMS task text naming the Drupal node the repair must
 * re-drive. That is exactly this suite's scope.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

import { producedEventId, type ArtifactProducedEvent } from "@/lib/lifecycle/lifecycle-produced-event";
import { autoReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";

import { agentLifecycleDeclarationSchema } from "../verdaccio/package-contract";

const TEST_SCHEMA = "cinatra_test_lifecycle_2046_drupal_producer";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2046-drupal-producer";
const MEMBER_USER = "user-2046-drupal-producer";
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

/** The producing package under proof — the REAL extension identity, not a
 * synthetic name: the resolver must route off the same `package_name` →
 * `lifecycle_config` chain a real drupal-agent install produces. */
const DRUPAL_AGENT_PACKAGE = "@cinatra-ai/drupal-agent";

/**
 * The lifecycle declaration `@cinatra-ai/drupal-agent` ships in its
 * `package.json#cinatra.lifecycle` at the release the committed dev lock pins
 * (its `resolvedSha` in cinatra-dev-extensions.lock.json). Kept as a literal
 * (the clone-back extension tree is not materialized in the DB-tier CI job) but
 * NEVER a free-floating stub — see the manifest-ground-truth test below, which
 * parses it through the real manifest contract AND cross-checks it byte-for-byte
 * against the REAL pinned manifest wherever that tree IS on disk.
 */
const DRUPAL_AGENT_LIFECYCLE = { repairCapable: true } as const;

/** The pre-pin state this PR corrects: drupal-agent 0.1.2 declared no
 * `cinatra.lifecycle` block, so `installAgentFromPackage` compiled NOTHING onto
 * `agent_templates.lifecycle_config` and the column stayed NULL. */
const PRE_PIN_LIFECYCLE_CONFIG = null;

const CMS_SNAPSHOT_EMITTER = "object_cms_snapshot_capture";

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
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

/**
 * `agent_templates.package_name` is UNIQUE (`agent_templates_package_name_idx`),
 * so the drupal-agent template is seeded ONCE and shared by every drive — which
 * is also what makes the two drives a fair comparison: the SAME real package
 * identity, with ONLY the manifest-compiled `lifecycle_config` column differing.
 * That column is precisely what the pin changes, and nothing else is varied.
 */
let drupalTemplateId: string | null = null;
async function drupalAgentTemplateWith(lifecycle: Record<string, unknown> | null): Promise<string> {
  if (!drupalTemplateId) {
    const templateId = `tmpl-${randomUUID()}`;
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
         (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
       VALUES ($1,$2,'organization',$2,'seed','seed','[]','{}','{}',$3,NULL)`,
      [templateId, ORG, DRUPAL_AGENT_PACKAGE],
    );
    drupalTemplateId = templateId;
  }
  await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_templates" SET lifecycle_config=$2 WHERE id=$1`, [
    drupalTemplateId,
    lifecycle === null ? null : JSON.stringify(lifecycle),
  ]);
  return drupalTemplateId;
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
 * `buildCmsSnapshotCaptureQueries`'s `targetInsert`, as the sibling CMS suites
 * do). `resourceType: "node"` is the DRUPAL shape (WordPress writes "post"). */
async function insertDrupalSnapshotTarget(input: {
  artifactId: string;
  snapshotRevisionId: string;
  connectorInstance: string;
  resourceId: string;
}): Promise<void> {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."cms_snapshot_targets"
       (id, artifact_id, snapshot_revision_id, scope_manifest, connector_instance,
        resource_type, resource_id, base_remote_revision_ref, operation_id)
     VALUES ($1,$2,$3,'{"paths":[]}'::jsonb,$4,'node',$5,NULL,$6)`,
    [
      `cst-${randomUUID()}`,
      input.artifactId,
      input.snapshotRevisionId,
      input.connectorInstance,
      input.resourceId,
      `op-${randomUUID()}`,
    ],
  );
}

async function repairRow(repairId: string) {
  const r = await pool(
    `SELECT route, status, successor_gate_id FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE id=$1`,
    [repairId],
  );
  return r.rows[0] as { route: string; status: string; successor_gate_id: string | null } | undefined;
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
    [MEMBER_USER, MEMBER_USER, `${MEMBER_USER}@2046-drupal.test`],
  );
  await authAdmin.query(
    `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, 'member', now()) ON CONFLICT (id) DO NOTHING`,
    [`m-2046-drupal-${ORG}`, ORG, MEMBER_USER],
  );
  await authAdmin.end();

  outboxStore = await import("../lifecycle-produced-outbox-store");
  gateStore = await import("../artifact-review-gate-store");
  orch = await import("../lifecycle-review-orchestration-store");
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

/**
 * ONE drive of the reviewer's changes-request on a Drupal CMS snapshot produced
 * by the `@cinatra-ai/drupal-agent` template, with that template's
 * manifest-compiled `lifecycle_config` set to `lifecycle`. Everything except
 * that column is identical between the two drives.
 */
async function driveDrupalChangesRequest(lifecycle: Record<string, unknown> | null) {
  const templateId = await drupalAgentTemplateWith(lifecycle);
  const producerRunId = await seedRun(templateId);
  const base = await produce({ producerRunId });
  const connectorInstance = `drupal-instance-${randomUUID()}`;
  const resourceId = `node-${randomUUID()}`;
  await insertDrupalSnapshotTarget({
    artifactId: base.artifactId,
    snapshotRevisionId: base.representationRevisionId,
    connectorInstance,
    resourceId,
  });

  await orch.sweepReviewOrchestration({ limit: 50 });
  const baseTaskId = autoReviewTaskId(base.eventId);
  const baseGate = await gateStore.readReviewGate(producerRunId, baseTaskId);
  expect(baseGate).not.toBeNull();

  const cr = await crStore.recordReviewSurfaceChangesRequested({
    runId: producerRunId,
    reviewTaskId: baseTaskId,
    baseTarget: {
      artifactId: base.artifactId,
      representationRevisionId: base.representationRevisionId,
    },
    currentBaseRevisionId: base.representationRevisionId,
    feedback: "tighten the node title and fix the body's second paragraph",
  });
  if (!cr.ok) throw new Error(`changes-request failed: ${cr.error}`);
  return { cr, producerRunId, resourceId, connectorInstance, base };
}

describe.skipIf(!HAS_DB)("cinatra#2046 — the Drupal repair producer (pin activation)", () => {
  it("manifest ground truth: the declared lifecycle block is contract-valid and matches the pinned drupal-agent manifest where materialized", () => {
    // The literal parses through the REAL manifest contract — the same strict
    // schema an install compiles onto `agent_templates.lifecycle_config`.
    const parsed = agentLifecycleDeclarationSchema.parse(DRUPAL_AGENT_LIFECYCLE);
    expect(parsed.repairCapable).toBe(true);

    // The committed dev lock pins the drupal-agent release this literal is
    // copied from; when the pinned clone-back tree is on disk, cross-check the
    // REAL manifest byte-for-byte — a manifest drift fails this suite there.
    const lock = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "cinatra-dev-extensions.lock.json"), "utf8"),
    ) as { packages: Array<{ packageName: string; resolvedSha: string }> };
    const pin = lock.packages.find((p) => p.packageName === DRUPAL_AGENT_PACKAGE);
    expect(pin).toBeDefined();
    expect(pin!.resolvedSha).toMatch(/^[0-9a-f]{40}$/);

    const manifestPath = resolve(REPO_ROOT, "extensions", "cinatra-ai", "drupal-agent", "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        cinatra?: { lifecycle?: unknown };
      };
      expect(manifest.cinatra?.lifecycle).toEqual(DRUPAL_AGENT_LIFECYCLE);
    }
  });

  it("PRE-PIN (the recorded negative proof): with lifecycle_config NULL — drupal-agent 0.1.2 — a Drupal changes-request ESCALATES and dispatches nothing", async () => {
    const { cr } = await driveDrupalChangesRequest(PRE_PIN_LIFECYCLE_CONFIG);
    if (!cr.ok) throw new Error("unreachable");

    // Exactly what the live drive on origin/main 5091632cd recorded for Drupal.
    expect(cr.route.kind).toBe("human_escalation");
    expect(cr.status).toBe("escalated");

    const dispatched = await dispatchStore.dispatchPendingProducerRepairs();
    expect(dispatched.dispatched).toBe(0);

    const row = await repairRow(cr.repairId);
    expect(row!.status).toBe("escalated");
    expect(row!.successor_gate_id).toBeNull();
  });

  it("PINNED: with the release's declared lifecycle block, the SAME drive routes producer_repair and dispatches to the drupal-agent template", async () => {
    const { cr, resourceId } = await driveDrupalChangesRequest(DRUPAL_AGENT_LIFECYCLE);
    if (!cr.ok) throw new Error("unreachable");

    // THE PIN'S WHOLE POINT: the route flips off the manifest declaration alone.
    expect(cr.route.kind).toBe("producer_repair");
    expect(cr.status).toBe("requested");

    const dispatched = await dispatchStore.dispatchPendingProducerRepairs();
    expect(dispatched.dispatched).toBe(1);

    // The repair dispatched to a RESOLVABLE producing template — no
    // "no resolvable producing run/template" escalation.
    const repairRunId = dispatchStore.repairRunId(cr.repairId);
    const runRow = await pool(
      `SELECT template_id, source_type, input_params FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`,
      [repairRunId],
    );
    expect(runRow.rows).toHaveLength(1);
    const run = runRow.rows[0] as {
      template_id: string;
      source_type: string | null;
      input_params: string;
    };
    expect(run.template_id).toBe(drupalTemplateId);
    expect(run.source_type).toBe("lifecycle_repair");

    // The dispatched run carries the delivered request, and the CMS task text
    // names the DRUPAL node the repair has to re-drive.
    const inputParams = JSON.parse(run.input_params) as {
      task?: string;
      lifecycleRepairRequest?: unknown;
    };
    expect(inputParams.lifecycleRepairRequest).toBeDefined();
    expect(inputParams.task).toContain(resourceId);

    const row = await repairRow(cr.repairId);
    expect(row!.route).toBe("producer_repair");
  });
});
