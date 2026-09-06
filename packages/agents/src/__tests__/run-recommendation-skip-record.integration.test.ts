/**
 * cinatra#2794 S9b — the RUN-LEVEL skip record, proved against a REAL store.
 *
 * The unit suite (`run-recommendation-skip-evidence.test.ts`) mocks the writer,
 * so it can only prove the ARGUMENT the action passed. That is not the fact the
 * card depends on: the writer is `ON CONFLICT DO NOTHING`, so a non-empty
 * argument and a committed row are different things. This file drives the REAL
 * sync-pg store against real DDL (fresh schema per file from the CANONICAL
 * `buildCreateStoreSchemaQueries` bootstrap — the migration core__0095 twin) so
 * the marker is proved COMMITTED, by a reader that never saw the write:
 *
 *   COMMITTED  — the marker is readable through a SEPARATE connection after the
 *                write returns, which is what "durable" means here.
 *   VERIFIED   — the writer READS BACK and reports whether the marker landed, so
 *                a silent no-op cannot be mistaken for a decision on record.
 *   IDEMPOTENT — a retried skip converges on one row (PK run_id) and still
 *                verifies true; the first write's facts win.
 *   COLLISION  — a legitimate skill id `__run_level_skip__` is a NORMAL rejected
 *                row: it stays readable in the efficacy split, and it does NOT
 *                make an un-skipped run look skipped. This is the exact defect
 *                the reserved-id marker carried.
 *   LEGACY     — a run skipped BEFORE this table (only `user_skipped` rejected
 *                rows, no marker) still reads as skipped, so core__0095 needs no
 *                backfill and no already-settled card regresses.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://postgres:postgres@127.0.0.1:15433/skip2794 \
 *     pnpm --filter @cinatra-ai/agents test:integration run-recommendation-skip-record
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const TEST_SCHEMA = "cinatra_test_skip_2794";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const q = (s: string) => s.replaceAll('"', '""');

/** The id the retired sentinel reserved. A REAL skill may carry it — skill ids
 * are caller-provided text (`createOrUpdateSkill` takes `input.skillId`
 * verbatim) — which is why the marker no longer lives in the skill-keyed table. */
const COLLIDING_SKILL_ID = "__run_level_skip__";

let store: typeof import("@/lib/run-selected-skill-revisions");

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
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  // Imported AFTER the schema env is set — the store binds `postgresSchema` at
  // module load.
  store = await import("@/lib/run-selected-skill-revisions");
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

/** Read the marker through a connection of our OWN, not the store's. A row this
 * client can see is a COMMITTED row — the fact the release is gated on. */
async function markerViaFreshConnection(
  runId: string,
): Promise<{ skippedBy: string; candidateCount: number } | null> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT skipped_by, candidate_count
         FROM "${q(TEST_SCHEMA)}"."run_recommendation_skips"
        WHERE run_id = $1`,
      [runId],
    );
    if (r.rows.length === 0) return null;
    return {
      skippedBy: String(r.rows[0].skipped_by),
      candidateCount: Number(r.rows[0].candidate_count),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

describe.skipIf(!HAS_DB)("cinatra#2794 — the run-level skip record (real store)", () => {
  it("COMMITTED: the marker is readable through a SEPARATE connection after the write returns", async () => {
    const runId = `run-skip-${randomUUID()}`;

    const verified = store.writeRunRecommendationSkip({
      runId,
      skippedBy: "user-owner",
      candidateCount: 2,
    });

    // The writer's own read-back said it landed...
    expect(verified).toBe(true);
    // ...and a reader that never saw the write agrees. This is the assertion the
    // mocked unit test structurally cannot make.
    expect(await markerViaFreshConnection(runId)).toEqual({
      skippedBy: "user-owner",
      candidateCount: 2,
    });
    // And the fact the settled card actually reads.
    expect(store.hasRunRecommendationSkip(runId)).toBe(true);
  });

  it("VERIFIED: a run with no marker reads false, so an unwritten skip cannot pass as recorded", async () => {
    expect(store.hasRunRecommendationSkip(`run-never-${randomUUID()}`)).toBe(false);
  });

  it("IDEMPOTENT: a retried skip converges on ONE row, still verifies, and keeps the first write's facts", async () => {
    const runId = `run-retry-${randomUUID()}`;

    expect(store.writeRunRecommendationSkip({ runId, skippedBy: "user-owner", candidateCount: 3 })).toBe(true);
    // The retry (a lost response, a double-click) must not duplicate or fail.
    expect(store.writeRunRecommendationSkip({ runId, skippedBy: "user-other", candidateCount: 99 })).toBe(true);

    const client = new Client({ connectionString: DB_URL });
    await client.connect();
    const rows = await client.query(
      `SELECT skipped_by, candidate_count FROM "${q(TEST_SCHEMA)}"."run_recommendation_skips" WHERE run_id = $1`,
      [runId],
    );
    await client.end();

    expect(rows.rows).toHaveLength(1);
    // ON CONFLICT DO NOTHING — first write wins, exactly like both siblings.
    expect(rows.rows[0].skipped_by).toBe("user-owner");
    expect(Number(rows.rows[0].candidate_count)).toBe(3);
  });

  it("DRIFT: a marker with NO candidates is still a marker (candidate_count 0)", async () => {
    // The branch the reserved-id sentinel existed to serve: drift retired the
    // offered set, so there is no skill to name — and the run still settles.
    const runId = `run-drift-${randomUUID()}`;

    expect(store.writeRunRecommendationSkip({ runId, skippedBy: "user-owner", candidateCount: 0 })).toBe(true);

    expect(await markerViaFreshConnection(runId)).toEqual({ skippedBy: "user-owner", candidateCount: 0 });
    expect(store.hasRunRecommendationSkip(runId)).toBe(true);
    // No per-skill row was invented for a run that had nothing left to offer.
    expect(store.readRunRejectedRecommendations(runId)).toEqual([]);
  });

  it("COLLISION: a legitimate skill id `__run_level_skip__` stays READABLE in the efficacy split", async () => {
    // The acceptance clause. Under the old marker this row was filtered out of
    // every efficacy read — a genuine rejected skill silently dropped.
    const runId = `run-collide-${randomUUID()}`;
    store.writeRunRejectedRecommendations({
      runId,
      rejected: [
        { skillId: COLLIDING_SKILL_ID, skillRevisionId: "rev-x", recommendationSource: "recommended_not_kept", recommendedRank: 1 },
        { skillId: "zz-ordinary-skill", skillRevisionId: "rev-y", recommendationSource: "recommended_not_kept", recommendedRank: 2 },
      ],
    });

    const rows = store.readRunRejectedRecommendations(runId);

    expect(rows.map((r) => r.skillId)).toEqual([COLLIDING_SKILL_ID, "zz-ordinary-skill"]);
    const collided = rows.find((r) => r.skillId === COLLIDING_SKILL_ID);
    expect(collided?.skillRevisionId).toBe("rev-x");
    expect(collided?.recommendedRank).toBe(1);
  });

  it("COLLISION: a `__run_level_skip__` rejection does NOT make an un-skipped run look skipped", async () => {
    // The other half of the same defect: the reserved id was the marker, so a
    // real skill carrying it could have announced a decision nobody made. The
    // marker now lives in its own table and the rejected row is just a row.
    const runId = `run-collide-2-${randomUUID()}`;
    store.writeRunRejectedRecommendations({
      runId,
      rejected: [
        { skillId: COLLIDING_SKILL_ID, skillRevisionId: null, recommendationSource: "recommended_not_kept", recommendedRank: null },
      ],
    });

    expect(store.hasRunRecommendationSkip(runId)).toBe(false);
    expect(await markerViaFreshConnection(runId)).toBeNull();
  });

  it("ATOMIC: a failed MARKER write leaves NO durable skip evidence at all", async () => {
    // cinatra#2794 round-8 finding 2, proved where it actually lives — in the
    // store, against real rows. The two halves used to be two autocommitted
    // writes, the per-skill `user_skipped` rows first. A marker that failed
    // after those rows committed refused the skip and left the park LIVE, while
    // `hasRunRecommendationSkip` answered `skipped` off the orphans through its
    // legacy `recommendation_source` arm — settling the card for a decision the
    // action had just refused, on a run still parked. The legacy arm cannot be
    // narrowed away from that path: nothing distinguishes an orphan from a
    // genuine pre-core__0095 row.
    //
    // The failure is driven the bluntest honest way: the marker table is taken
    // out from under the write, so the rejected INSERT runs and the marker
    // INSERT then throws — exactly the ordering the defect needed.
    const runId = `run-atomic-${randomUUID()}`;
    const rejected = [
      {
        skillId: "skill-ranked",
        skillRevisionId: "rev-a",
        recommendationSource: "user_skipped",
        recommendedRank: 1,
      },
      {
        skillId: "skill-forced",
        skillRevisionId: "rev-b",
        recommendationSource: "user_skipped",
        recommendedRank: null,
      },
    ];

    const admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    const marker = `"${q(TEST_SCHEMA)}"."run_recommendation_skips"`;
    await admin.query(`ALTER TABLE ${marker} RENAME TO run_recommendation_skips__hidden`);
    let threw = false;
    try {
      store.writeRunRecommendationSkip({
        runId,
        skippedBy: "user-owner",
        candidateCount: rejected.length,
        rejected,
      });
    } catch {
      threw = true;
    } finally {
      await admin.query(
        `ALTER TABLE "${q(TEST_SCHEMA)}"."run_recommendation_skips__hidden" RENAME TO run_recommendation_skips`,
      );
      await admin.end().catch(() => {});
    }

    // The write failed, so the caller returns its typed refusal and the park
    // stays live.
    expect(threw).toBe(true);
    // And the store holds NOTHING: the per-skill rows rolled back with the
    // transaction that carried them...
    expect(store.readRunRejectedRecommendations(runId)).toEqual([]);
    // ...so the reader does not settle a card for the refused decision.
    expect(store.hasRunRecommendationSkip(runId)).toBe(false);
    expect(await markerViaFreshConnection(runId)).toBeNull();
  });

  it("ATOMIC: a SUCCESSFUL skip commits both halves together", async () => {
    // The other side of the same invariant — atomicity must not have cost the
    // happy path its per-skill half.
    const runId = `run-atomic-ok-${randomUUID()}`;

    const verified = store.writeRunRecommendationSkip({
      runId,
      skippedBy: "user-owner",
      candidateCount: 2,
      rejected: [
        { skillId: "a-skill", skillRevisionId: "rev-a", recommendationSource: "user_skipped", recommendedRank: 1 },
        { skillId: "b-skill", skillRevisionId: null, recommendationSource: "user_skipped", recommendedRank: null },
      ],
    });

    expect(verified).toBe(true);
    expect(await markerViaFreshConnection(runId)).toEqual({
      skippedBy: "user-owner",
      candidateCount: 2,
    });
    expect(store.readRunRejectedRecommendations(runId).map((r) => r.skillId)).toEqual([
      "a-skill",
      "b-skill",
    ]);
    expect(store.hasRunRecommendationSkip(runId)).toBe(true);
  });

  it("LEGACY: a run skipped before this table still reads as skipped (no backfill needed)", async () => {
    // core__0095 ships no backfill — it would have to invent a `skipped_by` the
    // old rows never recorded — so the reader keeps the legacy arm, keyed on the
    // SOURCE column rather than on any reserved skill id.
    const runId = `run-legacy-${randomUUID()}`;
    store.writeRunRejectedRecommendations({
      runId,
      rejected: [
        { skillId: "skill-old", skillRevisionId: null, recommendationSource: "user_skipped", recommendedRank: null },
      ],
    });

    expect(await markerViaFreshConnection(runId)).toBeNull(); // no run-level row
    expect(store.hasRunRecommendationSkip(runId)).toBe(true); // card still settles
  });
});
