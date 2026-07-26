/**
 * cinatra#2043 (epic #2037 S5) - REAL-store proof of the CMS snapshot READ-BACK
 * binding. The binding is thin: it reads the STORED `cms_snapshot_targets`
 * scope manifest and delegates to the S4 `recordVerificationForExternalChange`,
 * so the three outcomes are exactly the verdict core's - reusing the verdict-core
 * fixture shapes (base -> post projected field maps + findings per scope path).
 *
 *   VERIFIED  a faithful apply (every authorized field changed, no drift).
 *   DRIFTED   an out-of-scope field changed (beyond the STORED scope manifest).
 *   UNMET     an authorized (in-scope) finding's field did not change.
 *   STORED-MANIFEST  the manifest comes from the row, not the caller - a change
 *             outside the stored scope drifts even with matching findings.
 *   NOT-FOUND a read-back for an unknown operation returns target-not-found.
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
import type {
  VerificationFieldProjector,
  VerificationTargetRef,
} from "../lifecycle-verification-store";

const TEST_SCHEMA = "cinatra_test_cms_readback_2043";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2043-readback";

let outboxStore: typeof import("../lifecycle-produced-outbox-store");
let gateStore: typeof import("../artifact-review-gate-store");
let orch: typeof import("../lifecycle-review-orchestration-store");
let readbackStore: typeof import("../cms-snapshot-readback-store");
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

/** Seed a review gate on a run (the binding for the external verification path). */
async function seedGate(runId: string, artifactId: string, rev: string): Promise<string> {
  const ev: ArtifactProducedEvent = {
    eventId: producedEventId(artifactId, rev),
    orgId: ORG,
    artifactId,
    representationRevisionId: rev,
    eventKind: "artifact_produced",
    emitter: "object_cms_snapshot_capture",
    producerRunId: runId,
    producerAgentId: null,
    originKind: "user_provided",
    destinationClass: "external_publish",
    continuationMode: "async_effects_gated",
    continuationAddress: null,
  };
  await insertObject(artifactId, "document");
  await outboxStore.emitArtifactProduced(ev, dbMod.db);
  await orch.sweepReviewOrchestration();
  const g = await gateStore.readReviewGate(runId, autoReviewTaskId(ev.eventId));
  return g!.id;
}

/** Seed a cms_snapshot_targets row with a stored scope manifest. */
async function seedTarget(input: {
  operationId: string;
  artifactId: string;
  snapshotRevisionId: string;
  scopeManifest: { paths: string[] };
}) {
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."cms_snapshot_targets"
       (id, artifact_id, snapshot_revision_id, scope_manifest, connector_instance, resource_type, resource_id, base_remote_revision_ref, operation_id)
     VALUES ($1, $2, $3, $4::jsonb, 'wordpress-mcp-connector:inst-1', 'post', '42', 'etag-1', $5)`,
    [
      randomUUID(),
      input.artifactId,
      input.snapshotRevisionId,
      JSON.stringify(input.scopeManifest),
      input.operationId,
    ],
  );
}

function projector(
  baseRev: string,
  base: Record<string, string>,
  postRev: string,
  post: Record<string, string>,
): VerificationFieldProjector {
  return (t: VerificationTargetRef) => {
    if (t.representationRevisionId === baseRev) return base;
    if (t.representationRevisionId === postRev) return post;
    return {};
  };
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
  readbackStore = await import("../cms-snapshot-readback-store");
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
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("cinatra#2043 - CMS snapshot read-back binding (real store)", () => {
  it("VERIFIED: a faithful apply (every authorized field changed, no drift) records verified", async () => {
    const runId = `run-${randomUUID()}`;
    const artifactId = `art-${randomUUID()}`;
    const baseRev = `rev-base-${randomUUID()}`;
    const postRev = `rev-post-${randomUUID()}`;
    const operationId = `op-${randomUUID()}`;
    const gateId = await seedGate(runId, artifactId, baseRev);
    await seedTarget({ operationId, artifactId, snapshotRevisionId: baseRev, scopeManifest: { paths: ["title", "body"] } });

    const res = await readbackStore.recordCmsApplyVerification({
      operationId,
      gateId,
      orgId: ORG,
      runId,
      repairedTarget: { artifactId, representationRevisionId: postRev },
      acceptedFindings: [{ id: "f1", path: "title" }, { id: "f2", path: "body" }],
      projectFields: projector(baseRev, { title: "Old", body: "old" }, postRev, { title: "New", body: "new" }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.outcome).toBe("verified");
    expect(res.verdict.fieldDiff.map((f) => f.field).sort()).toEqual(["body", "title"]);
    expect(res.reopenedGateId).toBeNull();
  });

  it("DRIFTED: an out-of-scope field changed (beyond the stored manifest) records drifted and reopens a bounded gate", async () => {
    const runId = `run-${randomUUID()}`;
    const artifactId = `art-${randomUUID()}`;
    const baseRev = `rev-base-${randomUUID()}`;
    const postRev = `rev-post-${randomUUID()}`;
    const operationId = `op-${randomUUID()}`;
    const gateId = await seedGate(runId, artifactId, baseRev);
    await seedTarget({ operationId, artifactId, snapshotRevisionId: baseRev, scopeManifest: { paths: ["title", "body"] } });

    const res = await readbackStore.recordCmsApplyVerification({
      operationId,
      gateId,
      orgId: ORG,
      runId,
      repairedTarget: { artifactId, representationRevisionId: postRev },
      acceptedFindings: [{ id: "f1", path: "title" }, { id: "f2", path: "body" }],
      // `author` changed but is NOT in the stored scope manifest.
      projectFields: projector(
        baseRev,
        { title: "Old", body: "old", author: "alice" },
        postRev,
        { title: "New", body: "new", author: "mallory" },
      ),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.outcome).toBe("drifted");
    expect(res.verdict.outOfScopePaths).toEqual(["author"]);
    expect(res.reopenedGateId).not.toBeNull();
  });

  it("UNMET: an authorized (in-scope) finding whose field did NOT change records unmet", async () => {
    const runId = `run-${randomUUID()}`;
    const artifactId = `art-${randomUUID()}`;
    const baseRev = `rev-base-${randomUUID()}`;
    const postRev = `rev-post-${randomUUID()}`;
    const operationId = `op-${randomUUID()}`;
    const gateId = await seedGate(runId, artifactId, baseRev);
    await seedTarget({ operationId, artifactId, snapshotRevisionId: baseRev, scopeManifest: { paths: ["title", "body"] } });

    const res = await readbackStore.recordCmsApplyVerification({
      operationId,
      gateId,
      orgId: ORG,
      runId,
      repairedTarget: { artifactId, representationRevisionId: postRev },
      acceptedFindings: [{ id: "f2", path: "body" }],
      // `body` unchanged -> the authorized apply did not land.
      projectFields: projector(baseRev, { title: "Old", body: "same" }, postRev, { title: "New", body: "same" }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.outcome).toBe("unmet");
    expect(res.verdict.unmetFindingIds).toEqual(["f2"]);
  });

  it("STORED-MANIFEST: the manifest is read from the row, never the caller - a change outside the NARROW stored scope drifts", async () => {
    const runId = `run-${randomUUID()}`;
    const artifactId = `art-${randomUUID()}`;
    const baseRev = `rev-base-${randomUUID()}`;
    const postRev = `rev-post-${randomUUID()}`;
    const operationId = `op-${randomUUID()}`;
    const gateId = await seedGate(runId, artifactId, baseRev);
    // Stored scope authorizes ONLY `title`.
    await seedTarget({ operationId, artifactId, snapshotRevisionId: baseRev, scopeManifest: { paths: ["title"] } });

    const res = await readbackStore.recordCmsApplyVerification({
      operationId,
      gateId,
      orgId: ORG,
      runId,
      repairedTarget: { artifactId, representationRevisionId: postRev },
      // A caller cannot widen scope: even naming `body` as a finding, the stored
      // manifest excludes it, so the body change is out-of-scope drift.
      acceptedFindings: [{ id: "f1", path: "title" }, { id: "f2", path: "body" }],
      projectFields: projector(baseRev, { title: "Old", body: "old" }, postRev, { title: "New", body: "new" }),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.verdict.outcome).toBe("drifted");
    expect(res.verdict.outOfScopePaths).toEqual(["body"]);
  });

  it("NOT-FOUND: a read-back for an unknown operation returns target-not-found", async () => {
    const res = await readbackStore.recordCmsApplyVerification({
      operationId: `op-missing-${randomUUID()}`,
      gateId: "gate-x",
      orgId: ORG,
      runId: "run-x",
      repairedTarget: { artifactId: "a", representationRevisionId: "c" },
      acceptedFindings: [],
      projectFields: () => ({}),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("target-not-found");
  });

  it("GATE-MISMATCH: a stored snapshot NOT pinned by the given gate fails closed (no scope widening across operations)", async () => {
    // Operation A: a broad-scope snapshot on gate A.
    const runId = `run-${randomUUID()}`;
    const artA = `art-${randomUUID()}`;
    const revA = `rev-${randomUUID()}`;
    const opA = `op-${randomUUID()}`;
    const gateA = await seedGate(runId, artA, revA);
    await seedTarget({ operationId: opA, artifactId: artA, snapshotRevisionId: revA, scopeManifest: { paths: ["title", "body", "author"] } });
    // Gate B pins a DIFFERENT (narrow) snapshot.
    const artB = `art-${randomUUID()}`;
    const revB = `rev-${randomUUID()}`;
    const gateB = await seedGate(runId, artB, revB);

    // Attempt to verify against gate B using operation A's broad manifest.
    const res = await readbackStore.recordCmsApplyVerification({
      operationId: opA,
      gateId: gateB,
      orgId: ORG,
      runId,
      repairedTarget: { artifactId: artB, representationRevisionId: `rev-post-${randomUUID()}` },
      acceptedFindings: [{ id: "f1", path: "title" }],
      projectFields: () => ({}),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("gate-target-mismatch");
    // Gate A (which DOES pin operation A's snapshot) is accepted.
    void gateA;
  });

  it("reads the stored target back by operation id and by artifact id", async () => {
    const artifactId = `art-${randomUUID()}`;
    const baseRev = `rev-${randomUUID()}`;
    const operationId = `op-${randomUUID()}`;
    await seedTarget({ operationId, artifactId, snapshotRevisionId: baseRev, scopeManifest: { paths: ["title"] } });
    const byOp = await readbackStore.readCmsSnapshotTargetByOperation(operationId);
    expect(byOp?.artifactId).toBe(artifactId);
    expect(byOp?.scopeManifest).toEqual({ paths: ["title"] });
    const byArt = await readbackStore.readCmsSnapshotTargetByArtifact(artifactId);
    expect(byArt?.operationId).toBe(operationId);
  });
});
