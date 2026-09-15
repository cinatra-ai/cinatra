/**
 * cinatra#3028 (epic #3023, lifecycle-c W4) — ENABLER 0.15's PRODUCTION-PATH
 * FIXTURE, against a REAL Postgres on the real substrate DDL.
 *
 * THIS IS ACCEPTANCE ITEM 3: "A fixture kind's declared projector produces
 * suggestion snapshots through the production run, artifact and gate road on
 * both the single-target and the batch path." — and ACCEPTANCE ITEM 5, the epic
 * ruling that "#2950 closes on W4's projector and its production-path fixture".
 *
 * WHAT cinatra#2950 MEASURED, verbatim: "the single-artifact auto-gate invokes
 * the suggestion lane with the identity-only default projector, unconditionally
 * …; the batch auto-gate does not invoke the suggestion lane at all …. No
 * production artifact-kind suggestion-projector resolver exists in the tree. The
 * states drawn by the suggestion-chip cells … are reachable today only through a
 * driver that calls the suggestion producer directly — not through anything the
 * product does on its own."
 *
 * SO THE FIXTURE DRIVES THE PRODUCT, NOT THE PRODUCER. Nothing below calls the
 * suggestion producer, the lane or the snapshot store: it emits produced events
 * the way a run's write does and runs `sweepReviewOrchestration` — the drain the
 * product runs on its own — then reads `gate_suggestion_snapshots`. A snapshot
 * that appears there was produced by the production path or not at all.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=<a scratch database DSN> \
 *     pnpm --filter @cinatra-ai/agents test:integration lifecycle-c-w4-suggestion-projector
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import {
  producedEventId,
  type ArtifactProducedEvent,
} from "@/lib/lifecycle/lifecycle-produced-event";
import { autoReviewTaskId, batchPartitionReviewTaskId } from "@/lib/lifecycle/lifecycle-orchestration";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import {
  isMultiTargetSnapshotPayload,
  snapshotSuggestions,
  snapshotTargetPayloads,
  verifyGateSuggestionSnapshotPayload,
} from "@/lib/lifecycle/lifecycle-suggestion-producer";
import {
  __clearSuggestionProjectorsForTest,
  registerSuggestionProjector,
} from "@/lib/lifecycle/suggestion-projector-registry";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_w4_projector_3028";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-3028-projector";

/** The FIXTURE KIND — an artifact type that declares a suggestion projector. */
const FIXTURE_KIND = "@cinatra-ai/fixture-draft-artifact:draft";
const FIXTURE_PROJECTOR_ID = "@cinatra-ai/fixture-draft-artifact#draft";
/** A second kind, declaring NO projector — the batch gate's mixed case. */
const KIND_WITHOUT_PROJECTOR = "@cinatra-ai/fixture-image-artifact:image";

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let gateStore: typeof import("../artifact-review-gate-store");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

async function insertObject(id: string, type: string) {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."objects" (id, type, data, org_id) VALUES ($1, $2, '{}'::jsonb, $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, type, ORG],
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

/** Emit a produced event AND seed its objects row under `type` — exactly what a
 *  run's own artifact write leaves behind. */
async function produce(
  type: string,
  over: Partial<ArtifactProducedEvent> = {},
): Promise<ArtifactProducedEvent> {
  const ev = mkEvent(over);
  await insertObject(ev.artifactId, type);
  await outboxStore.emitArtifactProduced(ev, dbMod.db);
  return ev;
}

async function snapshotRowsFor(gateId: string) {
  const r = await pool(
    `SELECT id, payload FROM "${q(TEST_SCHEMA)}"."gate_suggestion_snapshots" WHERE gate_id = $1`,
    [gateId],
  );
  return r.rows as { id: string; payload: unknown }[];
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
  orch = await import("../lifecycle-review-orchestration-store");
  gateStore = await import("../artifact-review-gate-store");
  dbMod = await import("../db");
}, 120_000);

beforeEach(() => {
  if (!HAS_DB) return;
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "on";
  __clearSuggestionProjectorsForTest();
  // THE FIXTURE KIND'S DECLARATION — "an artifact extension may declare, beside
  // its display, a suggestion projector for its type". Registered the way a
  // display registration is: by type, at boot.
  registerSuggestionProjector({
    typeId: FIXTURE_KIND,
    projectorId: FIXTURE_PROJECTOR_ID,
    create: () => (target) => ({
      // A type-aware projection of the reviewed CONTENT — the thing the default
      // identity-only projector could never produce, and the reason cinatra#2950
      // says the drawn states "cannot arise on a real run".
      projection: {
        includedFields: { title: `  a draft for ${target.artifactId}  ` },
        excludedFields: ["artifact.content"],
      },
      authzDecision: "authorized" as const,
    }),
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  __clearSuggestionProjectorsForTest();
  delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("cinatra#3028 W4 — the projector by kind, on the production path", () => {
  it("SINGLE-TARGET PATH: a fixture kind's declared projector produces a snapshot through the run → artifact → gate road", async () => {
    const ev = await produce(FIXTURE_KIND);
    await orch.sweepReviewOrchestration();

    const gate = await gateStore.readReviewGate(ev.producerRunId!, autoReviewTaskId(ev.eventId));
    expect(gate).not.toBeNull();

    const rows = await snapshotRowsFor(gate!.id);
    expect(rows).toHaveLength(1);
    const payload = verifyGateSuggestionSnapshotPayload(rows[0]!.payload);
    expect(payload).not.toBeNull();
    expect(isMultiTargetSnapshotPayload(payload!)).toBe(true);

    const halves = snapshotTargetPayloads(payload!);
    expect(halves).toHaveLength(1);
    expect(halves[0]!.kind).toBe(FIXTURE_KIND);
    expect(halves[0]!.projectorId).toBe(FIXTURE_PROJECTOR_ID);
    expect(halves[0]!.target).toEqual({
      artifactId: ev.artifactId,
      representationRevisionId: ev.representationRevisionId,
    });
    // At least one real suggestion — the identity-only default produced none,
    // which is exactly what cinatra#2950 measured.
    expect(snapshotSuggestions(payload!).length).toBeGreaterThan(0);
  });

  it("BATCH PATH: a production of several artifacts gets a snapshot too — the path that skipped the lane entirely", async () => {
    const runId = `run-${randomUUID()}`;
    const a = await produce(FIXTURE_KIND, { producerRunId: runId });
    const b = await produce(FIXTURE_KIND, { producerRunId: runId });
    await orch.sweepReviewOrchestration();

    const targets = [
      { artifactId: a.artifactId, representationRevisionId: a.representationRevisionId },
      { artifactId: b.artifactId, representationRevisionId: b.representationRevisionId },
    ];
    const gate = await gateStore.readReviewGate(runId, batchPartitionReviewTaskId(targets));
    expect(gate).not.toBeNull();
    expect(gate!.pinnedTargets).toHaveLength(2);

    const rows = await snapshotRowsFor(gate!.id);
    expect(rows).toHaveLength(1);
    const payload = verifyGateSuggestionSnapshotPayload(rows[0]!.payload);
    expect(payload).not.toBeNull();

    // ONE SNAPSHOT PER GATE HOLDING A PAYLOAD PER PINNED TARGET — and, before
    // this slice, the second target would have returned `already-bound` even if
    // the lane had run at all.
    const halves = snapshotTargetPayloads(payload!);
    expect(halves).toHaveLength(2);
    expect(new Set(halves.map((h) => h.target.artifactId))).toEqual(
      new Set([a.artifactId, b.artifactId]),
    );
    for (const half of halves) {
      expect(half.kind).toBe(FIXTURE_KIND);
      expect(half.projectorId).toBe(FIXTURE_PROJECTOR_ID);
      expect(half.suggestions.length).toBeGreaterThan(0);
    }
    // The batch decision stays ONE all-or-nothing boundary: one gate, one
    // snapshot, one surfaced set.
    const ids = snapshotSuggestions(payload!).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("BATCH PATH, SEVERAL KINDS: a kind with no projector is served alike and RECORDED as such", async () => {
    const runId = `run-${randomUUID()}`;
    const a = await produce(FIXTURE_KIND, { producerRunId: runId });
    const b = await produce(KIND_WITHOUT_PROJECTOR, { producerRunId: runId });
    await orch.sweepReviewOrchestration();

    const targets = [
      { artifactId: a.artifactId, representationRevisionId: a.representationRevisionId },
      { artifactId: b.artifactId, representationRevisionId: b.representationRevisionId },
    ];
    const gate = await gateStore.readReviewGate(runId, batchPartitionReviewTaskId(targets));
    expect(gate).not.toBeNull();

    const payload = verifyGateSuggestionSnapshotPayload(
      (await snapshotRowsFor(gate!.id))[0]!.payload,
    );
    expect(payload).not.toBeNull();
    const halves = snapshotTargetPayloads(payload!);
    const withProjector = halves.find((h) => h.kind === FIXTURE_KIND)!;
    const without = halves.find((h) => h.kind === KIND_WITHOUT_PROJECTOR)!;
    expect(withProjector.suggestions.length).toBeGreaterThan(0);
    // "a kind without one yields no suggestions, RECORDED AS SUCH" — the entry
    // exists, names its kind, and names no projector.
    expect(without.projectorId).toBeNull();
    expect(without.suggestions).toEqual([]);
  });

  it("A KIND WITH NO PROJECTOR ALONE writes no row — 'nothing to propose', not a silent failure", async () => {
    const ev = await produce(KIND_WITHOUT_PROJECTOR);
    await orch.sweepReviewOrchestration();
    const gate = await gateStore.readReviewGate(ev.producerRunId!, autoReviewTaskId(ev.eventId));
    expect(gate).not.toBeNull();
    expect(await snapshotRowsFor(gate!.id)).toHaveLength(0);
  });

  it("A RE-SWEEP re-derives nothing — one snapshot per gate, and never against a gate a reviewer may be reading", async () => {
    const ev = await produce(FIXTURE_KIND);
    await orch.sweepReviewOrchestration();
    const gate = await gateStore.readReviewGate(ev.producerRunId!, autoReviewTaskId(ev.eventId));
    const before = await snapshotRowsFor(gate!.id);
    expect(before).toHaveLength(1);

    await outboxStore.emitArtifactProduced(ev, dbMod.db);
    await orch.sweepReviewOrchestration();
    const after = await snapshotRowsFor(gate!.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
  });
});
