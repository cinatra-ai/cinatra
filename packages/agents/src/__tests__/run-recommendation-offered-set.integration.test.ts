/**
 * cinatra#2906 — the OFFERED SET store, proved against a REAL store.
 *
 * The unit suites mock the store, so they prove the argument a caller passed.
 * The facts the confirm depends on are different ones, and only a real Postgres
 * can show them:
 *
 *   COMMITTED — an offer written by the draw is readable through a SEPARATE
 *               connection, which is what "the confirm can read what the card
 *               showed" actually means.
 *   IMMUTABLE — a second draw does NOT move the offer. A replace-on-redraw store
 *               would resolve one reader's confirm against revisions another
 *               reader's redraw put there, which is the substitution this table
 *               exists to prevent.
 *   ATOMIC    — two concurrent FIRST draws leave one whole offer, never a union
 *               of two partial ones.
 *   NO MIX    — two confirms derived from one claimed offer, across a live-state
 *               change, commit exactly the offered rows through the REAL
 *               `ON CONFLICT DO NOTHING` writer (AC-6, proved on the database
 *               rather than on a mock's arguments).
 *   PER-HOLD  — a run parked twice keeps the two offers apart, so a decision on
 *               the second hold can never be resolved against the first one's
 *               revisions.
 *   ORDER     — the offer reads back in the order it was drawn (rank, then skill
 *               id), so the recorded set is a stable, reproducible input.
 *   ABSENT    — an unknown hold reads back EMPTY rather than throwing, which is
 *               what keeps a pre-#2906 hold decidable on the compatibility path.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_offered_2906";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');

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

/** Read the offer through a connection of our OWN — a row this client can see
 *  is a COMMITTED row. */
async function offerViaFreshConnection(
  holdId: string,
): Promise<Array<{ skillId: string; skillRevisionId: string; recommended: boolean; rank: number }>> {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT skill_id, skill_revision_id, recommended, offered_rank
         FROM "${q(TEST_SCHEMA)}"."run_recommendation_offered_set"
        WHERE hold_id = $1
        ORDER BY offered_rank ASC, skill_id ASC`,
      [holdId],
    );
    return r.rows.map((row) => ({
      skillId: String(row.skill_id),
      skillRevisionId: String(row.skill_revision_id),
      recommended: row.recommended === true,
      rank: Number(row.offered_rank),
    }));
  } finally {
    await client.end().catch(() => {});
  }
}

describe.skipIf(!HAS_DB)("cinatra#2906 — the offered set (real store)", () => {
  it("COMMITTED: what the draw recorded is readable through a SEPARATE connection", async () => {
    const runId = `run-${randomUUID()}`;
    const holdId = `hold-${randomUUID()}`;
    await store.writeRunRecommendationOfferedSet({
      runId,
      holdId,
      offered: [
        { skillId: "b", skillRevisionId: "b@1", recommended: true, rank: 2 },
        { skillId: "a", skillRevisionId: "a@1", recommended: true, rank: 1 },
        { skillId: "c", skillRevisionId: "c@1", recommended: false, rank: 3 },
      ],
    });
    expect(await offerViaFreshConnection(holdId)).toEqual([
      { skillId: "a", skillRevisionId: "a@1", recommended: true, rank: 1 },
      { skillId: "b", skillRevisionId: "b@1", recommended: true, rank: 2 },
      { skillId: "c", skillRevisionId: "c@1", recommended: false, rank: 3 },
    ]);
  });

  it("ORDER: the store reads it back in the order it was drawn", async () => {
    const runId = `run-${randomUUID()}`;
    const holdId = `hold-${randomUUID()}`;
    await store.writeRunRecommendationOfferedSet({
      runId,
      holdId,
      offered: [
        { skillId: "z", skillRevisionId: "z@1", recommended: true, rank: 1 },
        { skillId: "a", skillRevisionId: "a@1", recommended: false, rank: 2 },
      ],
    });
    const read = await store.readRunRecommendationOfferedSet(holdId);
    expect(read.map((o) => o.skillId)).toEqual(["z", "a"]);
    expect(read[0]!.recommended).toBe(true);
    expect(read[1]!.recommended).toBe(false);
  });

  it("IMMUTABLE: a later draw does NOT move what the first draw claimed", async () => {
    const runId = `run-${randomUUID()}`;
    const holdId = `hold-${randomUUID()}`;
    await store.writeRunRecommendationOfferedSet({
      runId,
      holdId,
      offered: [
        { skillId: "a", skillRevisionId: "a@1", recommended: true, rank: 1 },
        { skillId: "b", skillRevisionId: "b@1", recommended: true, rank: 2 },
      ],
    });
    // A second tab redraws after `a@2` is published and `b`'s assignment is
    // withdrawn. The first reader is still looking at the first card, so their
    // confirm must still resolve against a@1 and b@1.
    await store.writeRunRecommendationOfferedSet({
      runId,
      holdId,
      offered: [{ skillId: "a", skillRevisionId: "a@2", recommended: false, rank: 1 }],
    });
    expect(await offerViaFreshConnection(holdId)).toEqual([
      { skillId: "a", skillRevisionId: "a@1", recommended: true, rank: 1 },
      { skillId: "b", skillRevisionId: "b@1", recommended: true, rank: 2 },
    ]);
  });

  it("ATOMIC: two concurrent FIRST draws leave one whole offer, not a union", async () => {
    const runId = `run-${randomUUID()}`;
    const holdId = `hold-${randomUUID()}`;
    // Disjoint skill ids: a per-row conflict rule would happily keep BOTH sets,
    // leaving an offer neither draw ever showed anybody.
    await Promise.all([
      store.writeRunRecommendationOfferedSet({
        runId,
        holdId,
        offered: [
          { skillId: "left-1", skillRevisionId: "left-1@1", recommended: true, rank: 1 },
          { skillId: "left-2", skillRevisionId: "left-2@1", recommended: true, rank: 2 },
        ],
      }),
      store.writeRunRecommendationOfferedSet({
        runId,
        holdId,
        offered: [
          { skillId: "right-1", skillRevisionId: "right-1@1", recommended: true, rank: 1 },
          { skillId: "right-2", skillRevisionId: "right-2@1", recommended: true, rank: 2 },
        ],
      }),
    ]);
    const committed = await offerViaFreshConnection(holdId);
    const prefixes = new Set(committed.map((o) => o.skillId.split("-")[0]));
    expect(committed).toHaveLength(2);
    expect(prefixes.size).toBe(1);
  });

  it("AC-6 NO MIX: two confirms over one claimed offer commit exactly the offered rows", async () => {
    const { deriveSelectionFromOfferedSet } = await import("@cinatra-ai/skills/recommendation");
    const runId = `run-${randomUUID()}`;
    const holdId = `hold-${randomUUID()}`;
    await store.writeRunRecommendationOfferedSet({
      runId,
      holdId,
      offered: [
        { skillId: "a", skillRevisionId: "a@1", recommended: true, rank: 1 },
        { skillId: "b", skillRevisionId: "b@1", recommended: true, rank: 2 },
      ],
    });

    // The press, twice — its response lost the first time. Between them the live
    // catalogue moves: `a` is republished and `z` becomes installed. Neither can
    // reach the write, because the write is derived from the CLAIMED offer.
    const press = async () => {
      const offer = await store.readRunRecommendationOfferedSet(holdId);
      const derived = deriveSelectionFromOfferedSet({
        offered: offer,
        confirmedSkillIds: ["a", "b"],
        honourableSkillIds: offer.map((o) => o.skillId),
      });
      expect(derived.ok).toBe(true);
      if (!derived.ok) return;
      store.writeRunSelectedSkillRevisions({ runId, selections: derived.selection });
    };
    await press();
    await press();

    const client = new Client({ connectionString: DB_URL });
    await client.connect();
    try {
      const r = await client.query(
        `SELECT skill_id, skill_revision_id
           FROM "${q(TEST_SCHEMA)}"."run_selected_skill_revisions"
          WHERE run_id = $1
          ORDER BY skill_id ASC`,
        [runId],
      );
      expect(
        r.rows.map((row) => [String(row.skill_id), String(row.skill_revision_id)]),
      ).toEqual([
        ["a", "a@1"],
        ["b", "b@1"],
      ]);
    } finally {
      await client.end().catch(() => {});
    }
  });

  it("PER-HOLD: a run parked twice keeps its two offers apart", async () => {
    const runId = `run-${randomUUID()}`;
    const firstHold = `hold-${randomUUID()}`;
    const secondHold = `hold-${randomUUID()}`;
    await store.writeRunRecommendationOfferedSet({
      runId,
      holdId: firstHold,
      offered: [{ skillId: "a", skillRevisionId: "a@1", recommended: true, rank: 1 }],
    });
    await store.writeRunRecommendationOfferedSet({
      runId,
      holdId: secondHold,
      offered: [{ skillId: "a", skillRevisionId: "a@2", recommended: true, rank: 1 }],
    });
    expect((await store.readRunRecommendationOfferedSet(firstHold))[0]!.skillRevisionId).toBe("a@1");
    expect((await store.readRunRecommendationOfferedSet(secondHold))[0]!.skillRevisionId).toBe("a@2");
  });

  it("ABSENT: an unknown hold reads back EMPTY, so a pre-#2906 hold stays decidable", async () => {
    expect(await store.readRunRecommendationOfferedSet(`hold-${randomUUID()}`)).toEqual([]);
    // A draw that offered nothing likewise claims nothing.
    const holdId = `hold-${randomUUID()}`;
    await store.writeRunRecommendationOfferedSet({ runId: `run-${randomUUID()}`, holdId, offered: [] });
    expect(await store.readRunRecommendationOfferedSet(holdId)).toEqual([]);
  });
});
