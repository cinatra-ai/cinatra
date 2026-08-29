/**
 * cinatra#2570 (epic #2564 S6a) — REAL-store proofs of the gate-bound suggestion
 * PRODUCER, against real DDL and real constraints (a fresh schema built from the
 * canonical `buildCreateStoreSchemaQueries` bootstrap).
 *
 * `gate_suggestion_snapshots` shipped with a reader and no writer. Everything
 * the later slices assume about it — S6b validates `accepted ⊆ surfaced` against
 * "the pinned snapshot", S6c renders it — depends on properties that only a real
 * database can demonstrate:
 *
 *   S1  a pending gate on a pinned target GAINS a snapshot, bound to that exact
 *       `{artifactId, representationRevisionId}`.
 *   S2  the row is IMMUTABLE and HASH-BOUND: a re-write of the same snapshot is
 *       idempotent, a DIFFERENT snapshot is refused, and the stored bytes still
 *       verify afterwards.
 *   S3  ONE snapshot per gate, including under concurrency — the invariant the
 *       gate row lock buys without a unique index (which would need a migration).
 *   S4  a target the gate never pinned is refused; so is a resolved gate, an
 *       unknown gate, a tampered payload and an empty set.
 *   S5  the LANE end-to-end: projection → deterministic suggestions →
 *       provenance-stamped frozen row.
 *   S6  refusals name NOTHING — no gate id, no run id, no revision.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/s62570 \
 *     pnpm --filter @cinatra-ai/agents test:integration gate-suggestion-producer
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import {
  buildGateSuggestions,
  SUGGESTION_PRODUCER_LANE_ID,
  snapshotSuggestions,
  snapshotTargetPayloads,
  verifyGateSuggestionSnapshotPayload,
  type GateSuggestionSnapshotPayloadV1,
} from "@/lib/lifecycle/lifecycle-suggestion-producer";
import type { CoreAnalysisTarget } from "@/lib/lifecycle/lifecycle-core-analysis";
import type { SuggestionProjector } from "../lifecycle-suggestion-producer-lane";

const TEST_SCHEMA = "cinatra_test_suggestion_2570";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2570";

let gateStore: typeof import("../artifact-review-gate-store");
let snapStore: typeof import("../gate-suggestion-snapshot-store");
let lane: typeof import("../lifecycle-suggestion-producer-lane");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

/** A pending gate pinned to one fresh target. */
async function pinnedGate(): Promise<{ gateId: string; target: CoreAnalysisTarget }> {
  const target: CoreAnalysisTarget = {
    artifactId: `art-${randomUUID()}`,
    representationRevisionId: `rev-${randomUUID()}`,
  };
  const emitted = await gateStore.emitArtifactReviewGate({
    runId: `run-${randomUUID()}`,
    orgId: ORG,
    reviewTaskId: `task-${randomUUID()}`,
    targets: [target],
  });
  return { gateId: emitted.gateId, target };
}

/** A deterministic payload for `target`, varied by the disclosed text. */
function payloadFor(
  target: CoreAnalysisTarget,
  lead: string,
): GateSuggestionSnapshotPayloadV1 {
  const built = buildGateSuggestions({
    target,
    projection: { includedFields: { lead }, excludedFields: ["body"] },
    authzDecision: "authorized",
  });
  if (built.suggestions.length === 0) throw new Error("fixture produced no suggestions");
  return built.payload;
}

function projectorFor(includedFields: Record<string, string>): SuggestionProjector {
  return () => ({
    projection: { includedFields, excludedFields: ["artifact.content"] },
    authzDecision: "authorized" as const,
  });
}

async function snapshotRowsFor(gateId: string) {
  const rows = await pool(
    `SELECT id, gate_id, payload FROM "${q(TEST_SCHEMA)}"."gate_suggestion_snapshots" WHERE gate_id = $1`,
    [gateId],
  );
  return rows.rows as { id: string; gate_id: string; payload: unknown }[];
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

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
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  gateStore = await import("../artifact-review-gate-store");
  snapStore = await import("../gate-suggestion-snapshot-store");
  lane = await import("../lifecycle-suggestion-producer-lane");
  dbMod = await import("../db");
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("S1 — a gate gains a snapshot bound to its pinned target", () => {
  it("writes exactly one row, bound to the exact {artifactId, representationRevisionId}", async () => {
    const { gateId, target } = await pinnedGate();
    const write = await snapStore.writeGateSuggestionSnapshot({
      gateId,
      payload: payloadFor(target, "  a headline  "),
    });
    expect(write.status).toBe("written");

    const rows = await snapshotRowsFor(gateId);
    expect(rows).toHaveLength(1);

    const read = await snapStore.readVerifiedSuggestionSnapshotForGate(gateId);
    // Read through the accessor: the store returns EITHER payload shape
    // (enabler 0.15's multi-target payload beside the single-target one).
    const half = snapshotTargetPayloads(read!.payload)[0]!;
    expect(half.target).toEqual(target);
    expect(half.provenance.targetArtifactId).toBe(target.artifactId);
    expect(half.provenance.targetRevisionId).toBe(target.representationRevisionId);
  });

  it("is visible through the existing run-scoped batch reader", async () => {
    const { gateId, target } = await pinnedGate();
    await snapStore.writeGateSuggestionSnapshot({
      gateId,
      payload: payloadFor(target, "  another headline  "),
    });
    const batch = await snapStore.readSuggestionSnapshotsForGates([gateId]);
    expect(batch).toHaveLength(1);
    expect(batch[0]!.gateId).toBe(gateId);
    expect(verifyGateSuggestionSnapshotPayload(batch[0]!.payload)).not.toBeNull();
  });
});

describe.skipIf(!HAS_DB)("S2 — immutable and hash-bound", () => {
  it("re-writing the SAME snapshot is idempotent, not a second row", async () => {
    const { gateId, target } = await pinnedGate();
    const payload = payloadFor(target, "  same  ");
    const first = await snapStore.writeGateSuggestionSnapshot({ gateId, payload });
    const second = await snapStore.writeGateSuggestionSnapshot({ gateId, payload });
    expect(first.status).toBe("written");
    expect(second.status).toBe("idempotent");
    expect(first.status !== "refused" && second.status !== "refused"
      ? first.snapshotId === second.snapshotId
      : false).toBe(true);
    expect(await snapshotRowsFor(gateId)).toHaveLength(1);
  });

  it("a DIFFERENT snapshot on the same gate is REFUSED — the surfaced set never moves", async () => {
    const { gateId, target } = await pinnedGate();
    const original = payloadFor(target, "  first  ");
    await snapStore.writeGateSuggestionSnapshot({ gateId, payload: original });

    const rewrite = await snapStore.writeGateSuggestionSnapshot({
      gateId,
      payload: payloadFor(target, "  second, entirely different  "),
    });
    expect(rewrite).toEqual({ status: "refused", reason: "already-bound" });

    const rows = await snapshotRowsFor(gateId);
    expect(rows).toHaveLength(1);
    const stored = verifyGateSuggestionSnapshotPayload(rows[0]!.payload);
    expect(stored?.snapshotHash).toBe(original.snapshotHash);
  });

  it("the STORED bytes verify against their own hash after a round trip", async () => {
    const { gateId, target } = await pinnedGate();
    const payload = payloadFor(target, "  round trip  ");
    await snapStore.writeGateSuggestionSnapshot({ gateId, payload });
    const rows = await snapshotRowsFor(gateId);
    expect(verifyGateSuggestionSnapshotPayload(rows[0]!.payload)).toEqual(payload);
  });

  it("a row EDITED underneath the store reads as absent, never as a wider set", async () => {
    const { gateId, target } = await pinnedGate();
    await snapStore.writeGateSuggestionSnapshot({
      gateId,
      payload: payloadFor(target, "  tamper me  "),
    });
    // Forge an extra suggestion directly in the row — the exact attack the
    // `accepted ⊆ surfaced` check in S6b would otherwise inherit.
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."gate_suggestion_snapshots"
         SET payload = jsonb_set(
           payload, '{suggestions}',
           (payload->'suggestions') || '[{"id":"sug_forged","fieldPath":"/x","op":"replace","value":"x","message":"m"}]'::jsonb)
       WHERE gate_id = $1`,
      [gateId],
    );
    expect(await snapStore.readVerifiedSuggestionSnapshotForGate(gateId)).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("S3 — one snapshot per gate, including under concurrency", () => {
  it("two DIFFERENT producers racing the same gate leave exactly one row", async () => {
    const { gateId, target } = await pinnedGate();
    const results = await Promise.all([
      snapStore.writeGateSuggestionSnapshot({ gateId, payload: payloadFor(target, "  race a  ") }),
      snapStore.writeGateSuggestionSnapshot({ gateId, payload: payloadFor(target, "  race b  ") }),
    ]);
    expect(results.filter((r) => r.status === "written")).toHaveLength(1);
    expect(results.filter((r) => r.status === "refused")).toHaveLength(1);
    expect(await snapshotRowsFor(gateId)).toHaveLength(1);
  });

  it("two IDENTICAL producers racing the same gate leave exactly one row", async () => {
    const { gateId, target } = await pinnedGate();
    const payload = payloadFor(target, "  identical race  ");
    const results = await Promise.all([
      snapStore.writeGateSuggestionSnapshot({ gateId, payload }),
      snapStore.writeGateSuggestionSnapshot({ gateId, payload }),
    ]);
    expect(results.every((r) => r.status !== "refused")).toBe(true);
    expect(await snapshotRowsFor(gateId)).toHaveLength(1);
  });
});

describe.skipIf(!HAS_DB)("S4 — the refusals", () => {
  it("refuses a target the gate never pinned", async () => {
    const { gateId } = await pinnedGate();
    const foreign: CoreAnalysisTarget = {
      artifactId: `art-${randomUUID()}`,
      representationRevisionId: `rev-${randomUUID()}`,
    };
    expect(
      await snapStore.writeGateSuggestionSnapshot({
        gateId,
        payload: payloadFor(foreign, "  not mine  "),
      }),
    ).toEqual({ status: "refused", reason: "target-not-pinned" });
    expect(await snapshotRowsFor(gateId)).toHaveLength(0);
  });

  it("refuses a gate that does not exist", async () => {
    const target: CoreAnalysisTarget = {
      artifactId: `art-${randomUUID()}`,
      representationRevisionId: `rev-${randomUUID()}`,
    };
    expect(
      await snapStore.writeGateSuggestionSnapshot({
        gateId: `gate-${randomUUID()}`,
        payload: payloadFor(target, "  ghost  "),
      }),
    ).toEqual({ status: "refused", reason: "gate-unavailable" });
  });

  it("refuses a gate that is no longer pending", async () => {
    const { gateId, target } = await pinnedGate();
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."artifact_review_gates"
         SET status = 'resolved', disposition = 'approve', fingerprint = $2, resolved_at = now()
       WHERE id = $1`,
      [gateId, `fp-${randomUUID()}`],
    );
    expect(
      await snapStore.writeGateSuggestionSnapshot({
        gateId,
        payload: payloadFor(target, "  too late  "),
      }),
    ).toEqual({ status: "refused", reason: "gate-unavailable" });
    expect(await snapshotRowsFor(gateId)).toHaveLength(0);
  });

  it("refuses a payload that does not verify against its own hash", async () => {
    const { gateId, target } = await pinnedGate();
    const payload = payloadFor(target, "  honest  ");
    const forged = {
      ...payload,
      suggestions: [
        ...payload.suggestions,
        { id: "sug_forged", fieldPath: "/x", op: "replace" as const, value: "x", message: "m" },
      ],
    };
    expect(
      await snapStore.writeGateSuggestionSnapshot({ gateId, payload: forged }),
    ).toEqual({ status: "refused", reason: "hash-unverified" });
    expect(await snapshotRowsFor(gateId)).toHaveLength(0);
  });

  it("refuses an empty snapshot — a gate with nothing to propose gets no row", async () => {
    const { gateId, target } = await pinnedGate();
    const empty = buildGateSuggestions({
      target,
      projection: { includedFields: { lead: "already canonical" }, excludedFields: [] },
      authzDecision: "authorized",
    });
    expect(empty.suggestions).toEqual([]);
    expect(
      await snapStore.writeGateSuggestionSnapshot({ gateId, payload: empty.payload }),
    ).toEqual({ status: "refused", reason: "empty-snapshot" });
    expect(await snapshotRowsFor(gateId)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("S5 — the lane, end to end", () => {
  it("projects, derives and freezes one provenance-stamped snapshot", async () => {
    const { gateId, target } = await pinnedGate();
    const outcome = await lane.runSuggestionProducerLane({
      gateId,
      target,
      project: projectorFor({
        "items.0.title": " a ",
        "items.0.subtitle": "sub",
        "items.1.title": "b",
      }),
    });
    expect(outcome.status).toBe("written");

    const read = await snapStore.readVerifiedSuggestionSnapshotForGate(gateId);
    expect(read).not.toBeNull();
    expect(read!.payload.laneId).toBe(SUGGESTION_PRODUCER_LANE_ID);
    const readHalf = snapshotTargetPayloads(read!.payload)[0]!;
    expect(readHalf.provenance).toMatchObject({
      laneId: SUGGESTION_PRODUCER_LANE_ID,
      targetArtifactId: target.artifactId,
      targetRevisionId: target.representationRevisionId,
      includedFields: ["items.0.subtitle", "items.0.title", "items.1.title"],
      excludedFields: ["artifact.content"],
      authzDecision: "authorized",
    });
    expect(readHalf.provenance.projectionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(snapshotSuggestions(read!.payload).map((s) => s.op))).toEqual(
      new Set(["replace", "add"]),
    );
  });

  it("a re-run over the same projection is idempotent", async () => {
    const { gateId, target } = await pinnedGate();
    const project = projectorFor({ lead: "  same again  " });
    const first = await lane.runSuggestionProducerLane({ gateId, target, project });
    const second = await lane.runSuggestionProducerLane({ gateId, target, project });
    expect(first.status).toBe("written");
    expect(second.status).toBe("idempotent");
    expect(await snapshotRowsFor(gateId)).toHaveLength(1);
  });

  it("a DENIED disclosure produces nothing at all", async () => {
    const { gateId, target } = await pinnedGate();
    const outcome = await lane.runSuggestionProducerLane({
      gateId,
      target,
      project: () => ({
        projection: { includedFields: { lead: "  would have suggested  " }, excludedFields: [] },
        authzDecision: "denied" as const,
      }),
    });
    expect(outcome).toEqual({ status: "refused", reason: "empty-snapshot" });
    expect(await snapshotRowsFor(gateId)).toHaveLength(0);
  });

  it("a projector that throws is a refusal, never an exception into the caller", async () => {
    const { gateId, target } = await pinnedGate();
    const outcome = await lane.runSuggestionProducerLane({
      gateId,
      target,
      project: () => {
        throw new Error("projection blew up");
      },
    });
    expect(outcome).toEqual({ status: "refused", reason: "projection-unavailable" });
  });
});

describe.skipIf(!HAS_DB)("S6 — refusals name nothing", () => {
  it("no refusal reason carries a gate id, a run id or a revision id", async () => {
    const { gateId, target } = await pinnedGate();
    const foreign: CoreAnalysisTarget = {
      artifactId: `art-${randomUUID()}`,
      representationRevisionId: `rev-${randomUUID()}`,
    };
    const outcomes = [
      await snapStore.writeGateSuggestionSnapshot({
        gateId,
        payload: payloadFor(foreign, "  x  "),
      }),
      await snapStore.writeGateSuggestionSnapshot({
        gateId: `gate-${randomUUID()}`,
        payload: payloadFor(target, "  y  "),
      }),
    ];
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("refused");
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain(gateId);
      expect(serialized).not.toContain(target.artifactId);
      expect(serialized).not.toContain(target.representationRevisionId);
      expect(serialized).not.toContain(foreign.artifactId);
    }
  });
});

// ---------------------------------------------------------------------------
// Codex convergence round 1 (cinatra#2570) — the real-store half of the review.
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("S7 — verification sits at EVERY read boundary", () => {
  it("the batch reader DROPS a tampered row rather than surfacing a wider set", async () => {
    const a = await pinnedGate();
    const b = await pinnedGate();
    await snapStore.writeGateSuggestionSnapshot({
      gateId: a.gateId,
      payload: payloadFor(a.target, "  intact  "),
    });
    await snapStore.writeGateSuggestionSnapshot({
      gateId: b.gateId,
      payload: payloadFor(b.target, "  will be forged  "),
    });
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."gate_suggestion_snapshots"
         SET payload = jsonb_set(
           payload, '{suggestions}',
           (payload->'suggestions') || '[{"id":"sug_forged","fieldPath":"/x","op":"replace","value":"x","message":"m"}]'::jsonb)
       WHERE gate_id = $1`,
      [b.gateId],
    );
    const batch = await snapStore.readSuggestionSnapshotsForGates([a.gateId, b.gateId]);
    expect(batch.map((r) => r.gateId)).toEqual([a.gateId]);
  });

  it("re-writing over a TAMPERED row refuses instead of claiming idempotence", async () => {
    const { gateId, target } = await pinnedGate();
    const payload = payloadFor(target, "  original  ");
    await snapStore.writeGateSuggestionSnapshot({ gateId, payload });
    await pool(
      `UPDATE "${q(TEST_SCHEMA)}"."gate_suggestion_snapshots"
         SET payload = jsonb_set(payload, '{truncated}', 'true'::jsonb)
       WHERE gate_id = $1`,
      [gateId],
    );
    // Same derived row id, unreadable bytes: reporting `idempotent` would claim
    // a snapshot is present that `readVerified…` answers null for.
    expect(await snapStore.writeGateSuggestionSnapshot({ gateId, payload })).toEqual({
      status: "refused",
      reason: "hash-unverified",
    });
    expect(await snapStore.readVerifiedSuggestionSnapshotForGate(gateId)).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("S8 — the default projector is revision-bound", () => {
  it("denies when the pinned revision does not exist", async () => {
    const { gateId, target } = await pinnedGate();
    const outcome = await lane.produceSuggestionsForNewGate({ gateId, orgId: ORG, target });
    // No representation row was ever appended for this synthetic target, so the
    // host disclosed nothing and the lane proposes nothing.
    expect(outcome.status).toBe("refused");
    expect(await snapshotRowsFor(gateId)).toHaveLength(0);
  });

  it("names the artifact row as WITHHELD — it is not revision-bound", async () => {
    const { target } = await pinnedGate();
    const projected = await lane.defaultSuggestionProjector(ORG)(target);
    expect(projected.projection.excludedFields).toEqual(
      expect.arrayContaining([
        "artifact.title",
        "artifact.mime",
        "artifact.sourceUrl",
        "artifact.content",
        "representation.resource",
      ]),
    );
    expect(projected.projection.includedFields["artifact.title"]).toBeUndefined();
  });
});

describe.skipIf(!HAS_DB)("S9 — the lane returns a value on every failure", () => {
  it("a projector returning an unwalkable projection is `producer-unavailable`", async () => {
    const { gateId, target } = await pinnedGate();
    const outcome = await lane.runSuggestionProducerLane({
      gateId,
      target,
      project: () =>
        ({
          // `includedFields` is required to be an object; a null one makes the
          // pure core throw, which the lane must convert into a value.
          projection: { includedFields: null, excludedFields: [] },
          authzDecision: "authorized",
        }) as unknown as Awaited<ReturnType<SuggestionProjector>>,
    });
    expect(outcome).toEqual({ status: "refused", reason: "producer-unavailable" });
    expect(await snapshotRowsFor(gateId)).toHaveLength(0);
  });
});
