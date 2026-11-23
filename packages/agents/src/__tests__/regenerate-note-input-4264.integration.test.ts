/**
 * cinatra#4264, the reader and dispatch slice, against a real Postgres.
 *
 * A step that declares its Note input regenerates under exactly one successor
 * gate, with the reviewer's note in that input and in no other place. Nothing
 * here stands in for the declaration read: the template's `lifecycle_config`
 * is compiled from a lifecycle block that passed the strict manifest schema,
 * the composer reads it and the verified filing node from the real ledger, the
 * real dispatch drain plans the segment run (its provenance read is the real
 * one, its flow document a file under a temporary runtime mount), and the
 * repair is answered through `submitRepairResponse` as the completer answers
 * a segment.
 *
 *   DECLARED   the press records one Regenerate intent; the drain creates one
 *              repair run on the provenance run whose inputs are the note,
 *              under the start output that feeds the declared input, and the
 *              typed request with no findings; the answered repair opens one
 *              successor gate and settles the base gate.
 *   NOTHING    a step that declares nothing refuses with the same plain reason,
 *              the gate stays pending and nothing is written, even when the
 *              agent says `repairCapable: true`.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided (CI runs it
 * through `pnpm test:integration`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";

import { agentLifecycleDeclarationSchema } from "../verdaccio/package-contract";
import {
  readManifestLifecycle,
  serializeLifecycleConfig,
  REPAIR_FINDINGS_TEXT_LEAD,
} from "@/lib/lifecycle/lifecycle-policy";
import { producedEventId, type ArtifactProducedEvent } from "@/lib/lifecycle/lifecycle-produced-event";
import { autoReviewTaskId, isRepairSuccessorTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_regenerate_note_4264";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-4264-note";
const MEMBER_USER = "user-4264-note-member";
const VENDOR = "regen-fixture";
const FILING_NODE = "write_draft";
const STEP = "draft_flow";
const NOTE_INPUT = "note";
/** The flow's start output that feeds (STEP, NOTE_INPUT); deliberately not
 *  the input's own name. */
const NOTE_START_OUTPUT = "draftNote";
const NOTE = "Open with the harbour at dawn, not the market";

/** The `lifecycle_config` an install writes for this block, after the strict
 *  manifest parse. */
function compiledLifecycleConfig(block: unknown): string | null {
  const lifecycle = agentLifecycleDeclarationSchema.parse(block);
  return serializeLifecycleConfig(readManifestLifecycle({ cinatra: { lifecycle } }));
}

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let repairStore: typeof import("../lifecycle-repair-store");
let crStore: typeof import("../lifecycle-review-changes-requested-store");
let dispatchStore: typeof import("../lifecycle-repair-dispatch-store");
let dbMod: typeof import("../db");
let dataRoot: string;
const previousDataRoot = process.env.CINATRA_EXTENSION_DATA_ROOT;

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

/** The agent's installed flow document under the runtime mount: one start
 *  output feeds the declared note input, and nothing else feeds it. */
function installFlow(packageName: string): void {
  const slug = packageName.split("/")[1]!;
  const dir = path.join(dataRoot, ".agent-mount", VENDOR, slug, "cinatra");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "oas.json"),
    JSON.stringify({
      component_type: "Flow",
      start_node: { $component_ref: "start" },
      data_flow_connections: [
        {
          source_node: { $component_ref: "start" },
          source_output: NOTE_START_OUTPUT,
          destination_node: { $component_ref: STEP },
          destination_input: NOTE_INPUT,
        },
        {
          source_node: { $component_ref: STEP },
          source_output: "content",
          destination_node: { $component_ref: FILING_NODE },
          destination_input: "content",
        },
      ],
    }),
  );
}

async function seedTemplate(lifecycleConfig: string | null): Promise<{ templateId: string; packageName: string }> {
  const templateId = `tmpl-${randomUUID()}`;
  const packageName = `@${VENDOR}/note-agent-${randomUUID().slice(0, 8)}`;
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
       (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name, lifecycle_config)
     VALUES ($1,$2,'organization',$2,'seed','seed','[]','{}','{}',$3,$4)`,
    [templateId, ORG, packageName, lifecycleConfig],
  );
  installFlow(packageName);
  return { templateId, packageName };
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
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, 'document', '{}'::jsonb, $2)
     ON CONFLICT (id) DO NOTHING`,
    [ev.artifactId, ev.orgId],
  );
  await outboxStore.emitArtifactProduced(ev, dbMod.db);
  return ev;
}

/** The ledger row of the write that filed `base` on `runId`, naming the node
 *  the runtime verified. */
async function seedFiling(runId: string, base: ArtifactProducedEvent): Promise<void> {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."artifact_materializations"
       (id, org_id, run_id, output_id, node_id, path, extension, content_hash,
        artifact_id, representation_revision_id, phase, verified_step_id)
     VALUES ($1, $2, $3, $4, $4, 'materialize_tool', '@regen-fixture/ledger', $5, $6, $5, 'finalized', $4)`,
    [`mat-${randomUUID()}`, ORG, runId, FILING_NODE, base.representationRevisionId, base.artifactId],
  );
}

async function gatesPinning(artifactId: string, representationRevisionId: string) {
  const r = await pool(
    `SELECT id, review_task_id, status, disposition FROM "${q(TEST_SCHEMA)}"."artifact_review_gates"
      WHERE pinned_targets @> $1::jsonb ORDER BY created_at`,
    [JSON.stringify([{ artifactId, representationRevisionId }])],
  );
  return r.rows as Array<{ id: string; review_task_id: string; status: string; disposition: string | null }>;
}

/** A produced, auto-gated, verified-filed revision of a run of `templateId`. */
async function reviewedRevision(templateId: string) {
  const producerRunId = await seedRun(templateId);
  const base = await produce({ producerRunId });
  await seedFiling(producerRunId, base);
  await orch.sweepReviewOrchestration({ limit: 50 });
  const reviewTaskId = autoReviewTaskId(base.eventId);
  const gate = await gateStore.readReviewGate(producerRunId, reviewTaskId);
  expect(gate).not.toBeNull();
  return { producerRunId, base, reviewTaskId, gateId: gate!.id };
}

async function pressRegenerate(r: Awaited<ReturnType<typeof reviewedRevision>>) {
  return crStore.recordReviewSurfaceChangesRequested({
    runId: r.producerRunId,
    reviewTaskId: r.reviewTaskId,
    baseTarget: { artifactId: r.base.artifactId, representationRevisionId: r.base.representationRevisionId },
    currentBaseRevisionId: r.base.representationRevisionId,
    feedback: NOTE,
    decidedBy: MEMBER_USER,
    origin: "regenerate",
  });
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
  dataRoot = mkdtempSync(path.join(tmpdir(), "regen-note-4264-"));
  process.env.CINATRA_EXTENSION_DATA_ROOT = dataRoot;

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  const { replayStoreSchema } = await import("@/lib/test-support/store-schema-replay");
  await replayStoreSchema(admin, buildCreateStoreSchemaQueries(TEST_SCHEMA));
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  // The dispatch re-verifies the originating human's live membership.
  const authAdmin = new Client({ connectionString: DB_URL });
  await authAdmin.connect();
  await authAdmin.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG, ORG, ORG],
  );
  await authAdmin.query(
    `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
    [MEMBER_USER, MEMBER_USER, `${MEMBER_USER}@4264-note.test`],
  );
  await authAdmin.query(
    `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
     VALUES ($1, $2, $3, 'member', now()) ON CONFLICT (id) DO NOTHING`,
    [`m-4264-note-${ORG}`, ORG, MEMBER_USER],
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
  if (previousDataRoot === undefined) delete process.env.CINATRA_EXTENSION_DATA_ROOT;
  else process.env.CINATRA_EXTENSION_DATA_ROOT = previousDataRoot;
  rmSync(dataRoot, { recursive: true, force: true });
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

describe.skipIf(!HAS_DB)("cinatra#4264: Regenerate puts the note into the declared input, under one successor gate", () => {
  it("DECLARED: one intent, one repair run with the note in the declared input only, one successor gate", async () => {
    const { templateId } = await seedTemplate(
      compiledLifecycleConfig({ regenerate: [{ artifactNode: FILING_NODE, step: STEP, noteInput: NOTE_INPUT }] }),
    );
    const reviewed = await reviewedRevision(templateId);

    const pressed = await pressRegenerate(reviewed);
    expect(pressed.ok).toBe(true);
    if (!pressed.ok) throw new Error(`Regenerate refused: ${pressed.error}`);
    const intent = await pool(
      `SELECT id, regenerate_node_id, findings FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE gate_id = $1`,
      [reviewed.gateId],
    );
    expect(intent.rows).toHaveLength(1);
    expect(intent.rows[0].regenerate_node_id).toBe(FILING_NODE);

    await dispatchStore.dispatchPendingProducerRepairs();
    const repairRunId = dispatchStore.repairRunId(pressed.repairId);
    const run = await pool(
      `SELECT parent_run_id, input_params FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id = $1`,
      [repairRunId],
    );
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0].parent_run_id).toBe(reviewed.producerRunId);
    const inputText = String(run.rows[0].input_params);
    const inputs = JSON.parse(inputText) as Record<string, unknown>;
    expect(Object.keys(inputs).sort()).toEqual([NOTE_START_OUTPUT, "lifecycleRepairRequest"].sort());
    expect(inputs[NOTE_START_OUTPUT]).toBe(NOTE);
    expect(inputs.lifecycleRepairRequest).toMatchObject({ repairId: pressed.repairId, findings: [] });
    // The note's words appear once in the whole run input, and never wrapped.
    expect(inputText.split(NOTE)).toHaveLength(2);
    expect(inputText).not.toContain(REPAIR_FINDINGS_TEXT_LEAD);

    // The segment's filing node writes on the repair run; the repair is
    // answered with that write as its source, as the completer answers it.
    const segmentWrite = await produce({ producerRunId: repairRunId });
    const successorRev = `rev-regenerated-${randomUUID()}`;
    await produce({
      artifactId: reviewed.base.artifactId,
      representationRevisionId: successorRev,
      producerRunId: repairRunId,
    });
    const answered = await repairStore.submitRepairResponse({
      repairId: pressed.repairId,
      sourceTarget: { artifactId: segmentWrite.artifactId, representationRevisionId: segmentWrite.representationRevisionId },
      currentBaseRevisionId: reviewed.base.representationRevisionId,
      reauthorized: true,
      response: {
        gateId: reviewed.gateId,
        baseTarget: { artifactId: reviewed.base.artifactId, representationRevisionId: reviewed.base.representationRevisionId },
        successorTarget: { artifactId: reviewed.base.artifactId, representationRevisionId: successorRev },
        findingOutcomes: (intent.rows[0].findings as Array<{ id: string }>).map((f) => ({ findingId: f.id, applied: true })),
        changeSummary: "regenerated from the note",
        producerProvenance: { runId: repairRunId, agentId: null },
      },
    });
    expect(answered.ok).toBe(true);
    if (!answered.ok) throw new Error(`repair response failed: ${answered.error}`);
    await orch.sweepReviewOrchestration({ limit: 50 });
    await orch.sweepLifecycleGateMaintenance({ limit: 50 });
    await orch.sweepReviewOrchestration({ limit: 50 });

    const successorGates = await gatesPinning(reviewed.base.artifactId, successorRev);
    expect(successorGates.map((g) => g.id)).toEqual([answered.successorGateId]);
    expect(isRepairSuccessorTaskId(successorGates[0]!.review_task_id)).toBe(true);
    expect(await gatesPinning(segmentWrite.artifactId, segmentWrite.representationRevisionId)).toEqual([]);
    const baseGates = await gatesPinning(reviewed.base.artifactId, reviewed.base.representationRevisionId);
    expect(baseGates).toHaveLength(1);
    expect(baseGates[0]).toMatchObject({ id: reviewed.gateId, status: "resolved", disposition: "changes_requested" });
  });

  it("NOTHING: a step that declares no Note input refuses with the same plain reason, even with repairCapable", async () => {
    const { REGENERATE_NO_NOTE_INPUT } = await import("@/lib/artifacts/review-surface-model");
    for (const block of [{ repairCapable: true }, { repairCapable: true, repairFindingsInput: { input: "instructions" } }]) {
      const { templateId } = await seedTemplate(compiledLifecycleConfig(block));
      const reviewed = await reviewedRevision(templateId);

      const pressed = await pressRegenerate(reviewed);
      expect(pressed.ok).toBe(false);
      if (pressed.ok) throw new Error("unreachable");
      expect(pressed.code).toBe("regenerate-unavailable");
      expect(pressed.error).toBe(REGENERATE_NO_NOTE_INPUT);

      const gates = await gatesPinning(reviewed.base.artifactId, reviewed.base.representationRevisionId);
      expect(gates).toHaveLength(1);
      expect(gates[0]).toMatchObject({ id: reviewed.gateId, status: "pending" });
      const repairs = await pool(
        `SELECT id FROM "${q(TEST_SCHEMA)}"."lifecycle_repair" WHERE gate_id = $1`,
        [reviewed.gateId],
      );
      expect(repairs.rows).toHaveLength(0);
    }
  });
});
