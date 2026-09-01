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
 *   CORE CAP  — an artifact whose type CORE implements the repair for routes to
 *               the producer with no row declaration at all (the capability is
 *               keyed on the produced ROLE, never on a package).
 *   REPRO-1   — the acceptance repro with the declaration in place: the SAME
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
import {
  autoReviewTaskId,
  repairSuccessorReviewTaskId,
} from "@/lib/lifecycle/lifecycle-orchestration";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";

const TEST_SCHEMA = "cinatra_test_lifecycle_2047_d1";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2047-d1";
/** cinatra#2286 S10 PR2 — the principal fix. A dispatched repair now requires
 * the ORIGINATING producing run's `runBy` to resolve a LIVE org membership
 * (`resolveOrgRoleForUser`, re-verified at dispatch time), so this suite seeds
 * a real `public."organization"` / `public."user"` / `public."member"` row for
 * a producing-run principal — mirrors the `a2a-internal-dispatch-actor`
 * integration suite's pattern (better-auth's `member` table lives in `public`,
 * UNAFFECTED by this suite's `TEST_SCHEMA` swap for the lifecycle tables). */
const MEMBER_USER = "user-2047-d1-member";
const OUTSIDER_USER = "user-2047-d1-outsider";
/** The MANIFEST-declared form of the capability (an extension that implements its
 * own repair) — the shape `installAgentFromPackage` now compiles onto the row. */
const MANIFEST_REPAIR_CAPABLE = JSON.stringify({ repairCapable: true });

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let repairStore: typeof import("../lifecycle-repair-store");
let crStore: typeof import("../lifecycle-review-changes-requested-store");
let dispatchStore: typeof import("../lifecycle-repair-dispatch-store");
let completionStore: typeof import("../lifecycle-repair-producer-completion-store");
let verifStore: typeof import("../lifecycle-verification-store");
let dbMod: typeof import("../db");
/** The object type of an artifact CORE implements the repair for — derived from
 * the core-repairable ROLE through the generated role bindings, never a hardcoded
 * package (mirrors what `resolveCoreRepairCapable` does at runtime). */
let coreRepairableObjectType: string;

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
       (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
     VALUES ($1,$2,'organization',$2,'seed','seed','[]','{}','{}',$3,$4)`,
    [templateId, ORG, packageName, lifecycleConfig],
  );
  return templateId;
}

/** `runBy` defaults to the seeded real member (cinatra#2286 S10 PR2 — the
 * dispatch-time principal gate needs a live-resolvable org role); pass
 * `runBy: null` explicitly for the no-human-principal cases. */
async function seedRun(templateId: string, runBy: string | null = MEMBER_USER): Promise<string> {
  const runId = `run-${randomUUID()}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, run_by, input_params)
     VALUES ($1,$2,$3,$4,'{}')`,
    [runId, templateId, ORG, runBy],
  );
  return runId;
}

async function produce(
  over: Partial<ArtifactProducedEvent> = {},
  objectType = "document",
): Promise<ArtifactProducedEvent> {
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
  await insertObject(ev.artifactId, objectType, ev.orgId);
  await outboxStore.emitArtifactProduced(ev, dbMod.db);
  return ev;
}

/**
 * Seed the artifact's own REPRESENTATION row (cinatra#3080, the fourth
 * reproduction of the real road).
 *
 * `produce()` writes the produced-event outbox row and the object, and NOT a
 * `representation` row — which is exactly why this suite could not see the
 * doubled gate. The S4 auto-trigger projects both the reviewed and the repaired
 * revision through `defaultRepresentationFieldProjector`, which reads that table;
 * with no rows it projected `{}` on both sides, the diff was empty, the verdict
 * came back `verified` and nothing was reopened. On the running application the
 * rows are there, both sides project three fields, the revision advance reads as
 * out-of-scope drift and a SECOND pending gate opens on every Regenerate.
 *
 * Seeding the row is what puts this fixture on the real road.
 */
async function seedRepresentation(
  artifactId: string,
  representationRevisionId: string,
  revision: number,
): Promise<void> {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."representation"
       (id, org_id, artifact_id, resource_id, revision, form)
     VALUES ($1, $2, $3, $4, $5, 'file')
     ON CONFLICT (id) DO NOTHING`,
    [representationRevisionId, ORG, artifactId, `res-${randomUUID()}`, revision],
  );
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

  // cinatra#2286 S10 PR2 — seed a REAL better-auth org/user/member row so the
  // dispatch-time principal gate (`resolveOrgRoleForUser`) resolves a live
  // role for the producing run's `runBy`. `public."member"` is NOT part of
  // `TEST_SCHEMA` (better-auth tables are unqualified, always `public`), so
  // this rides a separate connection against the shared `public` schema —
  // mirrors `a2a-internal-dispatch-actor.integration.test.ts` exactly.
  const authAdmin = new Client({ connectionString: DB_URL });
  await authAdmin.connect();
  await authAdmin.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG, ORG, ORG],
  );
  for (const userId of [MEMBER_USER, OUTSIDER_USER]) {
    await authAdmin.query(
      `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
      [userId, userId, `${userId}@2047-d1.test`],
    );
  }
  // MEMBER_USER is a real member of ORG. OUTSIDER_USER exists but has NO
  // membership row anywhere — the "runBy no longer resolves a live role" case.
  await authAdmin.query(
    `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, 'member', now()) ON CONFLICT (id) DO NOTHING`,
    [`m-2047-d1-${ORG}`, ORG, MEMBER_USER],
  );
  await authAdmin.end();

  outboxStore = await import("../lifecycle-produced-outbox-store");
  gateStore = await import("../artifact-review-gate-store");
  orch = await import("../lifecycle-review-orchestration-store");
  repairStore = await import("../lifecycle-repair-store");
  crStore = await import("../lifecycle-review-changes-requested-store");
  dispatchStore = await import("../lifecycle-repair-dispatch-store");
  completionStore = await import("../lifecycle-repair-producer-completion-store");
  verifStore = await import("../lifecycle-verification-store");
  dbMod = await import("../db");

  const { resolveExtensionRole } = await import("@/lib/extension-roles");
  const claimant = resolveExtensionRole("artifact-blog-post-body");
  coreRepairableObjectType = `${claimant ?? "@unresolved/role"}:post`;
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
  await authAdmin
    .query(`DELETE FROM public."member" WHERE "userId" = ANY($1)`, [[MEMBER_USER, OUTSIDER_USER]])
    .catch(() => {});
  await authAdmin
    .query(`DELETE FROM public."user" WHERE id = ANY($1)`, [[MEMBER_USER, OUTSIDER_USER]])
    .catch(() => {});
  await authAdmin.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG]).catch(() => {});
  await authAdmin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("cinatra#2047 D-1 — the repair round-trip is reachable for a merged producer", () => {
  it("CORE CAPABILITY: an artifact whose type core implements the repair for routes to the producer with NO row declaration", async () => {
    // The blog pipeline's repair implementation lives in CORE, so no package
    // manifest can declare it. Core declares the capability against the produced
    // artifact ROLE, resolved to its claimant through the generated bindings — so
    // a template carrying NO `lifecycle_config` at all still routes to the
    // producer when the artifact under review is one core can repair.
    const templateId = await seedTemplate(`@cinatra-ai/core-repairable-${randomUUID()}-agent`, null);
    expect(await templateLifecycleConfig(templateId)).toBeNull();
    const producerRunId = await seedRun(templateId);
    const ev = await produce({ producerRunId }, coreRepairableObjectType);
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
    expect(cr.route.kind).toBe("producer_repair");
    expect((await repairRow(cr.repairId))!.route).toBe("producer_repair");
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
    // And the dispatch drain never touches a human_escalation row: after a pass,
    // this repair is untouched (no repair run minted for it).
    await dispatchStore.dispatchPendingProducerRepairs();
    expect((await repairRow(cr.repairId))!.status).toBe("escalated");
    const runs = await pool(`SELECT id FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`, [
      dispatchStore.repairRunId(cr.repairId),
    ]);
    expect(runs.rows.length).toBe(0);
  });

  it("REPRO INVERTED + DELIVER + CHAIN: changes_requested to repair to successor gate to verification record", async () => {
    // A producer whose MANIFEST declares the capability — the ingestion path this
    // PR opens (`installAgentFromPackage` compiles `cinatra.lifecycle` onto the
    // row). The artifact type is deliberately NOT one core repairs, so this case
    // exercises the manifest half in isolation.
    const templateId = await seedTemplate(
      `@cinatra-ai/declared-${randomUUID()}-agent`,
      MANIFEST_REPAIR_CAPABLE,
    );
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
    // cinatra#2286 S10 PR2 — the principal fix: the delivered request carries
    // the LIVE-VERIFIED originating human, and the repair run's own `run_by`
    // is attributed to that SAME human (never the system dispatch authority).
    expect(delivered!.originatingRunBy).toBe(MEMBER_USER);
    // The repair run rides the producing template (the agent that must repair).
    const runRow = await pool(
      `SELECT template_id, source_type, run_by FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`,
      [repairRunId],
    );
    expect((runRow.rows[0] as { template_id: string }).template_id).toBe(templateId);
    expect((runRow.rows[0] as { run_by: string | null }).run_by).toBe(MEMBER_USER);

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
    const successorEventId = producedEventId(ev.artifactId, successorRev);
    const sweep = await orch.sweepReviewOrchestration({ limit: 50 });
    expect(sweep.gatesCreated).toBe(0);
    expect(await gateStore.readReviewGate(repairRunId, autoReviewTaskId(successorEventId))).toBeNull();
    // FAIL-SAFE: while the repair has not answered, the successor's event stays
    // PENDING (never silently marked done) so a crash between the production and
    // the response converges instead of leaving the revision ungated.
    const beforeResponse = await pool(
      `SELECT status FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox" WHERE event_id=$1`,
      [successorEventId],
    );
    expect((beforeResponse.rows[0] as { status: string }).status).toBe("pending");

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

    // Once the repair landed, the successor's own event settles (its gate is the
    // repair successor gate) instead of opening a second one.
    await orch.sweepReviewOrchestration({ limit: 50 });
    const afterResponse = await pool(
      `SELECT status FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox" WHERE event_id=$1`,
      [successorEventId],
    );
    expect((afterResponse.rows[0] as { status: string }).status).toBe("processed");
    expect(await gateStore.readReviewGate(repairRunId, autoReviewTaskId(successorEventId))).toBeNull();

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
    const templateId = await seedTemplate(
      `@cinatra-ai/declared-${randomUUID()}-agent`,
      MANIFEST_REPAIR_CAPABLE,
    );
    const producerRunId = await seedRun(templateId);
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

  it("CHECKPOINTED: the delivery is a resume, which this drain does not implement — escalated, never mis-delivered", async () => {
    const templateId = await seedTemplate(
      `@cinatra-ai/declared-${randomUUID()}-agent`,
      MANIFEST_REPAIR_CAPABLE,
    );
    const producerRunId = await seedRun(templateId);
    const ev = await produce({ producerRunId, continuationMode: "checkpointed" });
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
        continuationMode: "checkpointed",
        continuationAddress: baseGate!.id,
      },
      repairCapable: true,
      producerRunId,
      currentBaseRevisionId: ev.representationRevisionId,
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;
    expect(cr.route.kind).toBe("producer_repair");

    const summary = await dispatchStore.dispatchPendingProducerRepairs();
    expect(summary.escalated).toBeGreaterThanOrEqual(1);
    const row = await repairRow(cr.repairId);
    expect(row!.status).toBe("escalated");
    expect(
      dispatchStore.dispatchEscalationReason({
        status: row!.status,
        changeSummary: row!.change_summary,
      }),
    ).toContain("resume");
    // No repair run was created for a checkpointed repair.
    const runs = await pool(`SELECT id FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`, [
      dispatchStore.repairRunId(cr.repairId),
    ]);
    expect(runs.rows.length).toBe(0);
  });

  it("PRINCIPAL (no runBy): a producing run with NO human runBy is escalated, never dispatched (cinatra#2286 S10 PR2)", async () => {
    // The confused-deputy hazard, closed: a producing run with no delegating
    // human must never dispatch a repair that runs (and could write) under a
    // generic worker identity.
    const templateId = await seedTemplate(
      `@cinatra-ai/declared-${randomUUID()}-agent`,
      MANIFEST_REPAIR_CAPABLE,
    );
    const producerRunId = await seedRun(templateId, null);
    const ev = await produce({ producerRunId });
    await orch.sweepReviewOrchestration({ limit: 50 });
    const baseTaskId = autoReviewTaskId(ev.eventId);

    const cr = await crStore.recordReviewSurfaceChangesRequested({
      runId: producerRunId,
      reviewTaskId: baseTaskId,
      baseTarget: { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
      currentBaseRevisionId: ev.representationRevisionId,
      feedback: "tighten the headline",
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;
    expect(cr.route.kind).toBe("producer_repair");

    const summary = await dispatchStore.dispatchPendingProducerRepairs();
    expect(summary.escalated).toBeGreaterThanOrEqual(1);
    expect(summary.dispatched).toBe(0);
    const row = await repairRow(cr.repairId);
    expect(row!.status).toBe("escalated");
    expect(
      dispatchStore.dispatchEscalationReason({ status: row!.status, changeSummary: row!.change_summary }),
    ).toContain("no human runBy");
    // No repair run was ever minted — the gate runs BEFORE any dispatch.
    const runs = await pool(`SELECT id FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`, [
      dispatchStore.repairRunId(cr.repairId),
    ]);
    expect(runs.rows.length).toBe(0);
  });

  it("PRINCIPAL (stale runBy): a runBy that no longer resolves a live org membership is escalated, never dispatched (cinatra#2286 S10 PR2)", async () => {
    // The LIVE re-verify, exercised: OUTSIDER_USER is a real user with NO
    // membership row in ORG (revoked, or never a member) — the dispatch-time
    // check must never trust whatever the producing run carried at produce time.
    const templateId = await seedTemplate(
      `@cinatra-ai/declared-${randomUUID()}-agent`,
      MANIFEST_REPAIR_CAPABLE,
    );
    const producerRunId = await seedRun(templateId, OUTSIDER_USER);
    const ev = await produce({ producerRunId });
    await orch.sweepReviewOrchestration({ limit: 50 });
    const baseTaskId = autoReviewTaskId(ev.eventId);

    const cr = await crStore.recordReviewSurfaceChangesRequested({
      runId: producerRunId,
      reviewTaskId: baseTaskId,
      baseTarget: { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
      currentBaseRevisionId: ev.representationRevisionId,
      feedback: "tighten the headline",
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) return;

    const summary = await dispatchStore.dispatchPendingProducerRepairs();
    expect(summary.escalated).toBeGreaterThanOrEqual(1);
    expect(summary.dispatched).toBe(0);
    const row = await repairRow(cr.repairId);
    expect(row!.status).toBe("escalated");
    expect(
      dispatchStore.dispatchEscalationReason({ status: row!.status, changeSummary: row!.change_summary }),
    ).toContain("no longer a verified member");
    const runs = await pool(`SELECT id FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`, [
      dispatchStore.repairRunId(cr.repairId),
    ]);
    expect(runs.rows.length).toBe(0);
  });

  it("SENTINEL: the escalation reason is read through the STATUS, never the prefix alone", async () => {
    // A legitimate change summary that happens to start with the sentinel text is
    // NOT an escalation reason on a repaired row.
    expect(
      dispatchStore.dispatchEscalationReason({
        status: "repaired",
        changeSummary: `${dispatchStore.DISPATCH_ESCALATION_PREFIX}not an escalation`,
      }),
    ).toBeNull();
    expect(dispatchStore.dispatchEscalationReason({ status: "escalated", changeSummary: null })).toBeNull();
  });

  it("OPT-OUT: with the activation switch explicitly `off` the maintenance drain dispatches nothing", async () => {
    // #2047 activation flip: the switch is DEFAULT-ON, so proving the inert
    // posture requires the EXPLICIT opt-out — deleting the var now means ACTIVE.
    process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "off";
    const summary = await orch.sweepLifecycleGateMaintenance();
    expect(summary.repairsDispatched).toBe(0);
    expect(summary.repairsEscalated).toBe(0);
    process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
  });
});

// ---------------------------------------------------------------------------
// cinatra#3080 — REGENERATE OPENS ITS SUCCESSOR, WITH NO HUMAN STEP BETWEEN
// ---------------------------------------------------------------------------
//
// THE SHAPE THE CAPTURE MEASURED. Pressing Regenerate on a real run settled the
// gate as superseded and minted a real repair run — and then the road stopped:
// the run PARKED at `pending_approval` on a setup screen, no revision was
// appended, no successor gate opened, and the review target was never
// re-pointed, while the settled panel told the reader "the review has moved on
// from it". The park has one cause and the missing successor has another, and
// the two cases below are those two causes, each stated as the store can see it.
//
// CAUSE ONE — THE REPAIR RUN WAS ASKED THE SETUP QUESTION AGAIN. The execution
// path pauses a queued run for every REQUIRED input its template declares that
// the run's own `input_params` does not already hold (the setup interrupt loop
// in `execution.ts`). The delivered repair carried the typed request and NOTHING
// ELSE, so every one of the producing template's required inputs read as
// pending and the run stopped on a screen before it ever produced anything. The
// drawing has no such step in it: "Regenerate runs the same producing step again
// from the note field". So the delivery now carries the producing run's OWN
// inputs — the same step, the same inputs — and the note rides beside them.
//
// CAUSE TWO — NOTHING COMPLETED THE BLOG ROAD. A dispatched repair is finished
// by a completer that finds what the repair run produced and submits the typed
// response, which is what pins the successor gate. One completer existed and it
// owned CMS snapshots only; every other producer's repair sat `dispatched`
// forever with its production unclaimed. The generic completer is that missing
// half.
describe.skipIf(!HAS_DB)("cinatra#3080 — Regenerate produces the revision and the successor gate", () => {
  /** A template that declares one REQUIRED input, the way a real producer does. */
  async function seedTemplateWithRequiredInput(): Promise<string> {
    const templateId = `tmpl-${randomUUID()}`;
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
         (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
       VALUES ($1,$2,'organization',$2,'seed','seed','[]',$3,'{}',$4,$5)`,
      [
        templateId,
        ORG,
        JSON.stringify({
          type: "object",
          required: ["idea"],
          properties: { idea: { type: "object", title: "idea" } },
        }),
        `@cinatra-ai/regen-${randomUUID()}-agent`,
        MANIFEST_REPAIR_CAPABLE,
      ],
    );
    return templateId;
  }

  /** A producing run that already answered its setup question. */
  async function seedAnsweredRun(templateId: string, inputParams: unknown): Promise<string> {
    const runId = `run-${randomUUID()}`;
    await pool(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, run_by, input_params, status)
       VALUES ($1,$2,$3,$4,$5,'completed')`,
      [runId, templateId, ORG, MEMBER_USER, JSON.stringify(inputParams)],
    );
    return runId;
  }

  async function runRow(runId: string) {
    const r = await pool(
      `SELECT input_params, status, source_type FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`,
      [runId],
    );
    return r.rows[0] as
      | { input_params: string | null; status: string; source_type: string | null }
      | undefined;
  }

  async function gatesForRun(runId: string) {
    const r = await pool(
      `SELECT id, status, pinned_targets, review_task_id FROM "${q(TEST_SCHEMA)}"."artifact_review_gates"
       WHERE run_id=$1 ORDER BY created_at ASC`,
      [runId],
    );
    return r.rows as Array<{
      id: string;
      status: string;
      pinned_targets: unknown;
      review_task_id: string;
    }>;
  }

  /** The setup interrupt loop's OWN predicate, stated here so the assertion is
   *  about the thing that actually parked the run rather than a paraphrase of
   *  it: a required, non-hidden field the run's `input_params` does not hold. */
  function pendingSetupFields(
    required: string[],
    inputParams: Record<string, unknown>,
  ): string[] {
    return required.filter((f) => !Object.prototype.hasOwnProperty.call(inputParams, f));
  }

  /**
   * Hold a dispatched repair run at a chosen status, DETERMINISTICALLY.
   *
   * A minted repair run is picked up and driven by the runtime inside this same
   * process, and with no real producing graph behind it that ends in `failed` a
   * moment later — asynchronously, which makes "the run is still queued" a race
   * rather than a fact. So the run is first allowed to REACH a terminal status
   * (nothing touches it after that), and only then held at the status the case
   * is about. Every reading below is taken after this returns.
   */
  async function holdRunAt(runId: string, status: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const row = await runRow(runId);
      if (row && ["completed", "failed", "stopped"].includes(row.status)) break;
      if (Date.now() > deadline) throw new Error(`the repair run never settled: ${runId}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status=$2 WHERE id=$1`, [
      runId,
      status,
    ]);
  }

  /** Drive a run to a pending review and press Regenerate on it. */
  async function regenerateOn(templateId: string, producerRunId: string) {
    const ev = await produce({ producerRunId }, coreRepairableObjectType);
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
      feedback: "the second section needs a plainer opening sentence",
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) throw new Error("the change road refused the press");
    expect(cr.route.kind).toBe("producer_repair");
    return { ev, repairId: cr.repairId };
  }

  it("THE PARK: the repair run carries the producing step's own inputs, so no setup screen stands between the press and the work", async () => {
    const templateId = await seedTemplateWithRequiredInput();
    const idea = { title: "How Teams Adopt New Connectors", summary: "a summary", outline: [] };
    const producerRunId = await seedAnsweredRun(templateId, { idea });

    const { repairId } = await regenerateOn(templateId, producerRunId);
    expect((await dispatchStore.dispatchPendingProducerRepairs()).dispatched).toBe(1);

    const repairRunId = dispatchStore.repairRunId(repairId);
    const row = await runRow(repairRunId);
    expect(row).toBeDefined();
    expect(row!.source_type).toBe("lifecycle_repair");

    const params = JSON.parse(row!.input_params ?? "{}") as Record<string, unknown>;
    // The same producing step, the same inputs — the drawing's own words.
    expect(params.idea).toEqual(idea);
    // And the note still rides beside them: the request is the instruction.
    expect((params.lifecycleRepairRequest as { kind?: string } | undefined)?.kind).toBe(
      "lifecycle_repair_request",
    );
    expect(
      ((params.lifecycleRepairRequest as { findings?: unknown[] }).findings ?? []).length,
    ).toBeGreaterThan(0);

    // Stated in the setup loop's OWN terms: nothing is pending, so nothing
    // pauses the run before it produces.
    expect(pendingSetupFields(["idea"], params)).toEqual([]);
  });

  it("THE PARK: a repair of a repair does not inherit the previous round's request", async () => {
    // A second attempt's base is the first attempt's successor, and the
    // producing run of a second attempt can itself be a repair run. Copying its
    // `input_params` wholesale would carry the OLD request into the new one and
    // the producer would answer the earlier attempt's findings. The delivery
    // overwrites it with this attempt's.
    const templateId = await seedTemplateWithRequiredInput();
    const idea = { title: "Round two", summary: "s", outline: [] };
    const producerRunId = await seedAnsweredRun(templateId, {
      idea,
      lifecycleRepairRequest: { kind: "lifecycle_repair_request", repairId: "an-older-repair" },
    });

    const { repairId } = await regenerateOn(templateId, producerRunId);
    expect((await dispatchStore.dispatchPendingProducerRepairs()).dispatched).toBe(1);

    const params = JSON.parse(
      (await runRow(dispatchStore.repairRunId(repairId)))!.input_params ?? "{}",
    ) as Record<string, unknown>;
    expect(params.idea).toEqual(idea);
    expect((params.lifecycleRepairRequest as { repairId?: string }).repairId).toBe(repairId);
  });

  it("THE SUCCESSOR: exactly ONE new gate opens on the NEW revision, beneath the settled one", async () => {
    const templateId = await seedTemplateWithRequiredInput();
    const producerRunId = await seedAnsweredRun(templateId, {
      idea: { title: "Successor", summary: "s", outline: [] },
    });
    const { ev, repairId } = await regenerateOn(templateId, producerRunId);
    expect((await dispatchStore.dispatchPendingProducerRepairs()).dispatched).toBe(1);

    const repairRunId = dispatchStore.repairRunId(repairId);
    // The dispatched run does its producing work and finishes, exactly as any
    // other agent run does.
    const successorRev = `rev-regenerated-${randomUUID()}`;
    await produce(
      {
        artifactId: ev.artifactId,
        representationRevisionId: successorRev,
        producerRunId: repairRunId,
      },
      coreRepairableObjectType,
    );
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status='completed' WHERE id=$1`, [
      repairRunId,
    ]);

    const before = await gatesForRun(producerRunId);
    expect(before).toHaveLength(1);
    expect(before[0]!.status).toBe("resolved");

    const completion = await completionStore.completeDispatchedProducerRepairs();
    expect(completion.completed).toBe(1);

    // The repair landed, and it names the revision the repair run produced.
    const settled = await repairRow(repairId);
    expect(settled!.status).toBe("repaired");
    expect(settled!.successor_gate_id).not.toBeNull();
    expect(settled!.successor_artifact_id).toBe(ev.artifactId);

    // EXACTLY ONE successor, pending, over the NEW revision — a fresh review
    // entry beneath the settled one, which is left exactly as it was.
    const after = await gatesForRun(producerRunId);
    expect(after).toHaveLength(2);
    const successor = after.find((g) => g.id === settled!.successor_gate_id)!;
    expect(successor.status).toBe("pending");
    expect(successor.pinned_targets).toEqual([
      { artifactId: ev.artifactId, representationRevisionId: successorRev },
    ]);
    // The superseded gate keeps the revision it froze.
    const superseded = after.find((g) => g.id === before[0]!.id)!;
    expect(superseded.status).toBe("resolved");
    expect(superseded.pinned_targets).toEqual([
      { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
    ]);

    // The successor's OWN produced event does not open a second gate on top of
    // the one the repair pinned.
    expect((await orch.sweepReviewOrchestration({ limit: 50 })).gatesCreated).toBe(0);
    expect(await gatesForRun(producerRunId)).toHaveLength(2);

    // Idempotent: a re-drain claims nothing and mints no second successor.
    expect((await completionStore.completeDispatchedProducerRepairs()).completed).toBe(0);
    expect(await gatesForRun(producerRunId)).toHaveLength(2);
  });

  it("THE SUCCESSOR: a repair run still working is left alone, not finalized on nothing", async () => {
    const templateId = await seedTemplateWithRequiredInput();
    const producerRunId = await seedAnsweredRun(templateId, {
      idea: { title: "In flight", summary: "s", outline: [] },
    });
    const { repairId } = await regenerateOn(templateId, producerRunId);
    expect((await dispatchStore.dispatchPendingProducerRepairs()).dispatched).toBe(1);

    const completion = await completionStore.completeDispatchedProducerRepairs();
    // The counters are the DRAIN's, and this tier shares one schema across its
    // cases, so earlier cases' open repairs are in the same scan. What is
    // exactly this repair's is the row and the run's gates; of the counters,
    // only "nothing was completed" is a statement about the whole scan that this
    // case can make, and it is the one that matters — a repair still working
    // must not be finalized by anybody.
    expect(completion.completed).toBe(0);
    expect(completion.pending).toBeGreaterThanOrEqual(1);
    expect((await repairRow(repairId))!.status).toBe("dispatched");
    expect((await repairRow(repairId))!.successor_gate_id).toBeNull();
    expect(await gatesForRun(producerRunId)).toHaveLength(1);
  });

  it("THE SUCCESSOR: a repair run that has written something but is STILL RUNNING is not claimed on its first write", async () => {
    // A producing step is allowed to write more than once — an outline before
    // the draft, a picture beside the post. The completer claims the LATEST
    // thing the repair run wrote, and "latest" is only an ANSWER once the run
    // has stopped writing. Claiming mid-flight pins the first fragment into the
    // successor gate, and the finished work that follows arrives at a repair
    // already `repaired` and is dropped: the reviewer is then asked to decide on
    // something the producer had already moved past, with no way back.
    const templateId = await seedTemplateWithRequiredInput();
    const producerRunId = await seedAnsweredRun(templateId, {
      idea: { title: "Still writing", summary: "s", outline: [] },
    });
    const { ev, repairId } = await regenerateOn(templateId, producerRunId);
    expect((await dispatchStore.dispatchPendingProducerRepairs()).dispatched).toBe(1);

    const runId = dispatchStore.repairRunId(repairId);
    // The run writes an INTERMEDIATE artifact and is still going.
    await produce(
      {
        artifactId: ev.artifactId,
        representationRevisionId: `rev-intermediate-${randomUUID()}`,
        producerRunId: runId,
      },
      coreRepairableObjectType,
    );
    await holdRunAt(runId, "running");
    // Named here rather than imported: the point of the case is that the run has
    // NOT reached any of the three terminal statuses, so the three are written
    // out where the assertion is read.
    expect(["completed", "failed", "stopped"]).not.toContain((await runRow(runId))!.status);

    const completion = await completionStore.completeDispatchedProducerRepairs();
    expect(completion.completed).toBe(0);

    // Untouched and still open: no successor was pinned on a fragment.
    expect((await repairRow(repairId))!.status).toBe("dispatched");
    expect((await repairRow(repairId))!.successor_gate_id).toBeNull();
    expect(await gatesForRun(producerRunId)).toHaveLength(1);
  });

  it("THE SUCCESSOR: a repair run PARKED waiting for a person is unresolved, never reported as still working", async () => {
    // The exact shape the first capture photographed. A run parked on a human
    // gate does not move again by itself, so the repair behind it is WEDGED, not
    // in flight — and counting it `pending` reports a permanent wedge as
    // ordinary progress, pass after pass, with nothing ever saying so.
    const templateId = await seedTemplateWithRequiredInput();
    const producerRunId = await seedAnsweredRun(templateId, {
      idea: { title: "Parked", summary: "s", outline: [] },
    });
    const { repairId } = await regenerateOn(templateId, producerRunId);
    expect((await dispatchStore.dispatchPendingProducerRepairs()).dispatched).toBe(1);

    // The counters are the whole drain's and this tier shares one schema, so the
    // reading is a DELTA across the ONE thing that changes between two passes:
    // this repair run's status. Everything else in the scan has already settled
    // terminal by now and no longer moves.
    const runId = dispatchStore.repairRunId(repairId);
    await holdRunAt(runId, "running");
    const working = await completionStore.completeDispatchedProducerRepairs();
    expect(working.pending).toBeGreaterThanOrEqual(1);

    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status='pending_approval' WHERE id=$1`,
      [runId],
    );
    const parked = await completionStore.completeDispatchedProducerRepairs();

    // The same repair, the same everything else: WORKING became WEDGED.
    expect(parked.pending).toBe(working.pending - 1);
    expect(parked.unresolved).toBe(working.unresolved + 1);
    // And still open, never finalized on a run that has not produced.
    expect((await repairRow(repairId))!.status).toBe("dispatched");
    expect(await gatesForRun(producerRunId)).toHaveLength(1);
  });

  it("THE SUCCESSOR: a finished repair run that produced nothing leaves the repair OPEN rather than finalizing wrong", async () => {
    const templateId = await seedTemplateWithRequiredInput();
    const producerRunId = await seedAnsweredRun(templateId, {
      idea: { title: "Produced nothing", summary: "s", outline: [] },
    });
    const { repairId } = await regenerateOn(templateId, producerRunId);
    expect((await dispatchStore.dispatchPendingProducerRepairs()).dispatched).toBe(1);
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status='failed' WHERE id=$1`, [
      dispatchStore.repairRunId(repairId),
    ]);

    const completion = await completionStore.completeDispatchedProducerRepairs();
    // As above: the row and the gates are this case's; of the counters, only
    // "nothing was completed" speaks for the whole scan.
    expect(completion.completed).toBe(0);
    expect(completion.unresolved).toBeGreaterThanOrEqual(1);
    // Open and ops-visible, never silently repaired.
    expect((await repairRow(repairId))!.status).toBe("dispatched");
    expect((await repairRow(repairId))!.successor_gate_id).toBeNull();
    expect(await gatesForRun(producerRunId)).toHaveLength(1);
  });

  it("THE PAGE: a repair run is a run — the run page opens it exactly as it opens any other run, and the link to it is a URL", async () => {
    // The last reading of the running application could not open the repair
    // run's own page, so the person could not see where the work had stopped. Two things have to
    // hold for "a repair run is a run": the page's OWN resolver must resolve
    // it for the person whose repair it is, exactly as it resolves the run
    // that produced it — no filter, no narrower policy, nothing keyed on how
    // the run was made — and the link the product draws for it must be a
    // valid address. The second half is what a repair run breaks and an
    // ordinary run cannot: its id is derived from its repair rather than
    // minted as a uuid, so it carries a character a path segment must escape.
    const templateId = await seedTemplateWithRequiredInput();
    const producerRunId = await seedAnsweredRun(templateId, {
      idea: { title: "The page", summary: "s", outline: [] },
    });
    const { repairId } = await regenerateOn(templateId, producerRunId);
    expect((await dispatchStore.dispatchPendingProducerRepairs()).dispatched).toBe(1);
    const repairRunId = dispatchStore.repairRunId(repairId);

    const store = await import("../store");
    const actor = { actorType: "human" as const, source: "ui" as const, userId: MEMBER_USER };
    const roles = { platformRole: "member" as const, actorOrganizationId: ORG };

    // The URL the page is reached by names the agent, and the agent resolves.
    const packageName = (
      (
        await pool(
          `SELECT package_name FROM "${q(TEST_SCHEMA)}"."agent_templates" WHERE id=$1`,
          [templateId],
        )
      ).rows[0] as { package_name: string }
    ).package_name;
    const agentId = packageName.slice(1);
    expect(
      await store.readAgentTemplateBySlug(agentId, {
        actorUserId: MEMBER_USER,
        includeNonPublished: true,
      }),
    ).not.toBeNull();

    // The run the page opens: the producing run is the control, the repair run
    // is the case, and the page reads them through the SAME call.
    const producerSeen = await store.readAgentRunById(producerRunId, actor, roles);
    expect(producerSeen?.id).toBe(producerRunId);
    const repairSeen = await store.readAgentRunById(repairRunId, actor, roles);
    expect(repairSeen?.id).toBe(repairRunId);
    expect(repairSeen?.sourceType).toBe("lifecycle_repair");

    // And the address of that page is a single path segment for this run and
    // decodes back to it — the reading that was false for a repair run.
    const { buildAgentInstancePath } = await import("@/lib/agent-url");
    const href = buildAgentInstancePath(packageName, repairRunId);
    const segments = href.split("/");
    expect(segments).toHaveLength(5);
    expect(decodeURIComponent(segments[4]!)).toBe(repairRunId);
    expect(segments[4]).not.toContain(":");
    // An ordinary run's link is unchanged, character for character.
    expect(buildAgentInstancePath(packageName, producerRunId)).toBe(
      `/agents/${agentId}/${producerRunId}`,
    );
  });

  it("THE WHOLE ROAD: Regenerate settles its gate superseded and raises exactly ONE successor over the new revision, with nothing parked and no wedge said", async () => {
    // The drawing, end to end: "Regenerate sends the work back to be made again
    // from the words in the note field, settles this gate as superseded, and
    // raises its successor over the new revision". This drives that whole road
    // once, in the store, and reads every step of it — including the reading
    // the last reading of the running application could not get: that the
    // repair run never parks waiting for a person, so the completer never has
    // a wedge to report.
    const templateId = await seedTemplateWithRequiredInput();
    const producerRunId = await seedAnsweredRun(templateId, {
      idea: { title: "The whole road", summary: "s", outline: [] },
    });

    // The gate is pending, and it is the only one.
    const ev = await produce({ producerRunId }, coreRepairableObjectType);
    await seedRepresentation(ev.artifactId, ev.representationRevisionId, 1);
    await orch.sweepReviewOrchestration({ limit: 50 });
    const opened = await gatesForRun(producerRunId);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.status).toBe("pending");

    // Regenerate, with the reviewer's words in the note field.
    const note = "Open the second section with a plainer sentence and keep the harbour example.";
    const cr = await crStore.recordReviewSurfaceChangesRequested({
      runId: producerRunId,
      reviewTaskId: autoReviewTaskId(ev.eventId),
      baseTarget: {
        artifactId: ev.artifactId,
        representationRevisionId: ev.representationRevisionId,
      },
      currentBaseRevisionId: ev.representationRevisionId,
      feedback: note,
    });
    expect(cr.ok).toBe(true);
    if (!cr.ok) throw new Error("the change road refused the press");
    const repairId = cr.repairId;

    // ONE repair, delivered on a run that carries the producing step's own
    // inputs and the reviewer's words — nothing to ask a person.
    expect((await dispatchStore.dispatchPendingProducerRepairs()).dispatched).toBe(1);
    const repairRunId = dispatchStore.repairRunId(repairId);
    const delivered = JSON.parse((await runRow(repairRunId))!.input_params ?? "{}") as Record<
      string,
      unknown
    >;
    expect(pendingSetupFields(["idea"], delivered)).toEqual([]);
    const request = delivered.lifecycleRepairRequest as { findings?: Array<{ message?: string }> };
    expect((request.findings ?? []).some((f) => (f.message ?? "").includes("harbour"))).toBe(true);

    // The repair run does its producing work and finishes, like any other run.
    const successorRev = `rev-regenerated-${randomUUID()}`;
    await produce(
      {
        artifactId: ev.artifactId,
        representationRevisionId: successorRev,
        producerRunId: repairRunId,
      },
      coreRepairableObjectType,
    );
    await seedRepresentation(ev.artifactId, successorRev, 2);
    await pool(`UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status='completed' WHERE id=$1`, [
      repairRunId,
    ]);

    // The completion drain, watched: the wedge line is what a parked repair run
    // makes the completer say, and there is nothing parked on this road.
    const said: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      said.push(args.map((a) => String(a)).join(" "));
      realError(...(args as []));
    };
    let completion: Awaited<ReturnType<typeof completionStore.completeDispatchedProducerRepairs>>;
    try {
      completion = await completionStore.completeDispatchedProducerRepairs();
    } finally {
      console.error = realError;
    }
    expect(completion.completed).toBe(1);
    expect(
      said.filter((line) => line.includes(`repair ${repairId}`) && line.includes("waiting for a person")),
    ).toEqual([]);

    // The gate it was pressed on is settled, and it keeps the revision it froze.
    const after = await gatesForRun(producerRunId);
    expect(after).toHaveLength(2);
    const superseded = after.find((g) => g.id === opened[0]!.id)!;
    expect(superseded.status).toBe("resolved");
    expect(superseded.pinned_targets).toEqual([
      { artifactId: ev.artifactId, representationRevisionId: ev.representationRevisionId },
    ]);

    // EXACTLY ONE successor, beneath it, over the NEW revision — and the
    // review target the repair records is that new revision, not the old one.
    const settled = await repairRow(repairId);
    expect(settled!.status).toBe("repaired");
    expect(settled!.successor_artifact_id).toBe(ev.artifactId);
    expect(settled!.successor_representation_revision_id).toBe(successorRev);
    const successor = after.find((g) => g.id === settled!.successor_gate_id)!;
    expect(successor).toBeDefined();
    expect(successor.status).toBe("pending");
    expect(successor.pinned_targets).toEqual([
      { artifactId: ev.artifactId, representationRevisionId: successorRev },
    ]);
    expect(after.filter((g) => g.status === "pending")).toHaveLength(1);

    // ONE PRESS, ONE PENDING GATE — and it is the successor, by name.
    //
    // The drawing: "Regenerate settles the gate it was pressed on as superseded
    // and mints a successor gate for that same artifact — a fresh review entry
    // beneath the settled one"; "a new review gate entry on the rail, beneath
    // the one just resolved". One. The running application opened TWO, 0.3 s
    // apart, on both presses: the repair successor
    // (`lifecycle-review:repair:{repairId}:1`) and a second gate whose review
    // task read `lifecycle-review:verify:verify:{gateId}` — the S4 auto-trigger
    // firing on a projection whose own axis it was judging as drift, under an
    // identifier that spelled its prefix twice.
    const pending = after.filter((g) => g.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.review_task_id).toBe(
      repairSuccessorReviewTaskId(repairId, 1),
    );
    // No gate anywhere on this run carries the doubled word.
    expect(after.filter((g) => g.review_task_id.includes("verify:verify"))).toEqual([]);
    // The verification RECORD still lands — the audit reading the run rail
    // opens is not what was wrong; reopening a gate over it was.
    const verification = await verifStore.readVerificationRecordForGate(
      settled!.successor_gate_id!,
    );
    expect(verification).not.toBeNull();
    expect(verification!.outcome).toBe("verified");
  });
});
