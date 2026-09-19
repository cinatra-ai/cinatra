/**
 * ONE GATE PER ARTIFACT — ON THE BATCH/COALESCED ROAD, AGAINST A REAL STORE
 * (cinatra#3080, the fix leg after the second proof round).
 *
 * THE DRAWING'S OWN SENTENCE, read at design `specs/app-artifact-review.html`
 * §III: "A gate carries one target: one artifact, one pinned reference. Work
 * that made several artifacts raises one gate per artifact, in order — each its
 * own entry on the rail, the run waiting at each — never one gate combining
 * them (§VI, §I.3)." §VI says it again: "One artifact per review, one reference
 * per gate ... There is no combined gate and no per-target verdict to
 * reconcile."
 *
 * WHAT THE SECOND ROUND SAW, ON THE REAL ROAD. A real Blog Idea Generator run
 * whose step wrote five artifacts raised ONE review over all five — a
 * `lifecycle-review:batch:` gate — on the chat card, on the run page's Review
 * step and on the review page, with Regenerate greyed everywhere behind "This
 * review covers more than one piece of work". The first fix leg's test covered
 * the DIRECT emit only; the real run's gate came through this road — the
 * coalesced production, sealed into one epoch and partitioned into ≤50-target
 * partitions, one gate per PARTITION.
 *
 * WHAT THIS FILE PINS. The same road, driven end to end against a real Postgres:
 * a single production whose step yields three artifacts drains into THREE gates,
 * one per artifact, in the step's own output order, each pinning exactly ONE
 * target — so Regenerate is live on every fresh gate, because the refusal is
 * keyed on a gate that pins more than one. And the legacy row keeps its refusal:
 * a gate minted before this fix, pinning several targets, still reads back with
 * its several targets (the surface's refusal is pinned by
 * `regenerate-refused-on-a-multi-target-gate-3080`).
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. It builds and
 * drops its OWN schema, exactly as the #2039 real-store file does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import {
  producedEventId,
  type ArtifactProducedEvent,
} from "@/lib/lifecycle/lifecycle-produced-event";
import {
  batchPartitionReviewTaskId,
  isBatchAutoReviewTaskId,
} from "@/lib/lifecycle/lifecycle-orchestration";
import { type BatchTarget } from "@/lib/lifecycle/lifecycle-batch";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_review_batch_3080";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-3080-batch";

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let repairStore: typeof import("../lifecycle-repair-store");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

/** Seed a minimal objects row so review-context resolution finds the artifact type. */
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

async function produce(
  type: string,
  over: Partial<ArtifactProducedEvent> = {},
): Promise<ArtifactProducedEvent> {
  const ev = mkEvent(over);
  await insertObject(ev.artifactId, type, ev.orgId);
  await outboxStore.emitArtifactProduced(ev, dbMod.db);
  return ev;
}

type GateRow = {
  id: string;
  review_task_id: string;
  pinned_targets: BatchTarget[];
  created_at: Date;
};

async function gatesForRun(runId: string): Promise<GateRow[]> {
  const r = await pool(
    `SELECT id, review_task_id, pinned_targets, created_at
       FROM "${q(TEST_SCHEMA)}"."artifact_review_gates"
      WHERE run_id = $1
      ORDER BY created_at ASC, id ASC`,
    [runId],
  );
  return r.rows as GateRow[];
}

async function readEventRow(eventId: string) {
  const r = await pool(
    `SELECT status, continuation_address FROM "${q(TEST_SCHEMA)}"."artifact_produced_outbox" WHERE event_id = $1`,
    [eventId],
  );
  return r.rows[0] as { status: string; continuation_address: string | null } | undefined;
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
  dbMod = await import("../db");
}, 120_000);

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

describe.skipIf(!HAS_DB)("cinatra#3080 — the coalesced production raises one gate per artifact", () => {
  it("a step that yields THREE artifacts drains into THREE gates, one artifact each, in the step's output order", async () => {
    const runId = `run-3080-batch-${randomUUID()}`;
    // The step's output order IS the order the production wrote them.
    const first = await produce("document", { producerRunId: runId, artifactId: `idea-c-${runId}` });
    const second = await produce("document", { producerRunId: runId, artifactId: `idea-a-${runId}` });
    const third = await produce("document", { producerRunId: runId, artifactId: `idea-b-${runId}` });
    const outputOrder = [first, second, third];

    const summary = await orch.sweepReviewOrchestration({ limit: 50 });
    // Still the coalesced road — one production, one sealed epoch.
    expect(summary.batchesCoalesced).toBe(1);
    expect(summary.gatesCreated).toBe(3);

    const gates = await gatesForRun(runId);
    expect(gates).toHaveLength(3);
    // EVERY gate carries one target: one artifact, one pinned reference.
    for (const g of gates) {
      expect(g.pinned_targets).toHaveLength(1);
      expect(isBatchAutoReviewTaskId(g.review_task_id)).toBe(true);
    }

    // IN ORDER. The frozen membership is the production's own output order, and
    // the gate minted for each member derives from that member alone.
    const epochRows = await pool(
      `SELECT membership FROM "${q(TEST_SCHEMA)}"."lifecycle_batch_epoch" WHERE producer_run_id = $1`,
      [runId],
    );
    expect(epochRows.rows).toHaveLength(1);
    const membership = (epochRows.rows[0] as { membership: BatchTarget[] }).membership;
    expect(membership.map((m) => m.artifactId)).toEqual(outputOrder.map((e) => e.artifactId));
    expect(gates.map((g) => g.review_task_id)).toEqual(
      membership.map((m) => batchPartitionReviewTaskId([m])),
    );

    // The rows are ordered on the wire the way the step wrote them.
    for (let i = 1; i < gates.length; i++) {
      expect(new Date(gates[i].created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(gates[i - 1].created_at).getTime(),
      );
    }

    // Each member event is processed and linked to ITS OWN artifact's gate.
    const gateByArtifact = new Map(gates.map((g) => [g.pinned_targets[0].artifactId, g.id]));
    for (const e of outputOrder) {
      const row = await readEventRow(e.eventId);
      expect(row?.status).toBe("processed");
      expect(row?.continuation_address).toBe(gateByArtifact.get(e.artifactId));
    }

    // Replay: re-emit every member + re-sweep → no second gate for any artifact.
    for (const e of outputOrder) await outboxStore.emitArtifactProduced(e, dbMod.db);
    const replay = await orch.sweepReviewOrchestration({ limit: 50 });
    expect(replay.gatesCreated).toBe(0);
    expect(await gatesForRun(runId)).toHaveLength(3);

    // The epoch closed once every frozen member was gated, linked and marked.
    const open = await repairStore.resolveOpenBatchEpoch(ORG, runId);
    expect(open).toBeNull();
  }, 120_000);

  it("a LEGACY row minted before the fix keeps its several targets — and its refusal with them", async () => {
    // The refusal is keyed on the GATE's pinned set, so a row from before
    // one-review-per-artifact must still read back as the multi-target row it is.
    const runId = `run-3080-legacy-${randomUUID()}`;
    const targets: BatchTarget[] = [
      { artifactId: `legacy-a-${runId}`, representationRevisionId: `rev-a-${runId}` },
      { artifactId: `legacy-b-${runId}`, representationRevisionId: `rev-b-${runId}` },
    ];
    const reviewTaskId = batchPartitionReviewTaskId(targets);
    const emitted = await gateStore.emitArtifactReviewGate({
      runId,
      orgId: ORG,
      reviewTaskId,
      targets,
    });
    expect(emitted.gateId).toBeTruthy();
    const gate = await gateStore.readReviewGate(runId, reviewTaskId);
    expect(gate).not.toBeNull();
    expect(gate!.pinnedTargets).toHaveLength(2);
    expect(isBatchAutoReviewTaskId(reviewTaskId)).toBe(true);
  }, 120_000);
});
