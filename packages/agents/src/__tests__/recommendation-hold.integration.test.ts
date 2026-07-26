/**
 * cinatra#2067 (epic #2037 C3) — run-start recommendation HOLD/RELEASE against
 * the REAL store (real DDL + constraints, fresh schema from the canonical
 * `buildCreateStoreSchemaQueries` bootstrap — the exact operator-upgrade twin).
 *
 * Store-level evidence for the issue's acceptance criteria:
 *   AC-1 a human-present run PARKS at the recommendation interception (a real
 *        lifecycle_continuation_park row, checkpoint "recommendation", parked).
 *   AC-2 confirm → the authoritative per-run selection is written AND the park
 *        is RELEASED by the sweeper.
 *   AC-3 skip → durable `user_skipped` evidence, NO selection row (computed
 *        default), distinguishable from no-decision; the park releases.
 *   AC-5 a headless run auto-applies/skips and NEVER parks (no recommendation
 *        park row).
 *   AC-7 the Skills-tab join labels a ledger skill by its selection source
 *        (confirmed / auto-applied / forced).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { evaluatePolicy } from "@/lib/lifecycle/lifecycle-policy";
import { evaluateThenPark } from "@/lib/lifecycle/lifecycle-continuation";

const TEST_SCHEMA = "cinatra_test_recommendation_hold_2067";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');

let parkStore: typeof import("../lifecycle-continuation-park-store");
let hold: typeof import("../recommendation-hold");
let interception: typeof import("../recommendation-interception");
let selectionStore: typeof import("@/lib/run-selected-skill-revisions");
let ledgerStore: typeof import("@/lib/agent-run-skills-used");
let dbMod: typeof import("../db");

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

  parkStore = await import("../lifecycle-continuation-park-store");
  hold = await import("../recommendation-hold");
  interception = await import("../recommendation-interception");
  selectionStore = await import("@/lib/run-selected-skill-revisions");
  ledgerStore = await import("@/lib/agent-run-skills-used");
  dbMod = await import("../db");
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

// Park a run at the recommendation interception exactly as the pre-dispatch hold
// does (the pure lattice fires recommendation for humanPresent + silent org).
async function parkRecommendation(runId: string) {
  const decision = evaluatePolicy({
    checkpoint: "recommendation",
    artifactType: "*",
    destinationClass: "none",
    originKind: "agent_produced",
    humanPresent: true,
    orgRule: { bound: "silent" },
  });
  expect(decision.fired).toBe(true);
  const outcome = evaluateThenPark(decision, {
    checkpoint: "recommendation",
    destinationClass: "none",
  });
  return parkStore.maybeParkCheckpoint(outcome, {
    runId,
    eventId: hold.recommendationHoldEventId(runId),
  });
}

describe.skipIf(!HAS_DB)("cinatra#2067 — run-start recommendation hold/release (real store)", () => {
  it("AC-1/AC-2: human-present run PARKS, confirm writes the selection + RELEASES", async () => {
    const runId = `run-${randomUUID()}`;
    const parked = await parkRecommendation(runId);
    expect(parked.parked).toBe(true);

    // AC-1: the run is held — a real parked recommendation continuation.
    const held = await hold.readRecommendationParkForRun(runId);
    expect(held?.checkpoint).toBe("recommendation");
    expect(held?.status).toBe("parked");

    // Confirm: write the authoritative per-run selection (a recommended-confirmed
    // skill + a human-forced one), then release the hold.
    selectionStore.writeRunSelectedSkillRevisions({
      runId,
      selections: [
        { skillId: "skill-a", skillRevisionId: "skill-a@1", selectionSource: "recommended_confirmed" },
        { skillId: "skill-c", skillRevisionId: "skill-c@2", selectionSource: "user_forced" },
      ],
    });
    const released = await hold.releaseRecommendationParkForRun(runId);
    expect(released).toBe(true);

    // AC-2: the park is released and the selection is the authoritative set.
    const after = await hold.readRecommendationParkForRun(runId);
    expect(after?.status).toBe("released");
    const sel = selectionStore.readRunSelectedSkillRevisions(runId);
    expect(sel.map((s) => s.skillId).sort()).toEqual(["skill-a", "skill-c"]);
    expect(sel.find((s) => s.skillId === "skill-a")?.selectionSource).toBe("recommended_confirmed");
    expect(sel.find((s) => s.skillId === "skill-c")?.selectionSource).toBe("user_forced");

    // Releasing again is a no-op (idempotent).
    expect(await hold.releaseRecommendationParkForRun(runId)).toBe(false);
  });

  it("AC-3: skip persists durable evidence (no selection row) and RELEASES", async () => {
    const runId = `run-${randomUUID()}`;
    await parkRecommendation(runId);

    // Skip: durable `user_skipped` evidence, NO selection row (computed default).
    selectionStore.writeRunRejectedRecommendations({
      runId,
      rejected: [
        { skillId: "skill-a", skillRevisionId: "skill-a@1", recommendationSource: "user_skipped", recommendedRank: 1 },
      ],
    });
    const released = await hold.releaseRecommendationParkForRun(runId);
    expect(released).toBe(true);

    // Distinguishable from no-decision, and from a confirm (no selection rows).
    expect(selectionStore.hasRunRecommendationSkip(runId)).toBe(true);
    expect(selectionStore.readRunSelectedSkillRevisions(runId)).toHaveLength(0);
    // A different run with NO decision has NO skip evidence.
    expect(selectionStore.hasRunRecommendationSkip(`run-${randomUUID()}`)).toBe(false);
    expect((await hold.readRecommendationParkForRun(runId))?.status).toBe("released");
  });

  it("AC-5: a HEADLESS run auto-applies/skips and NEVER parks", async () => {
    const runId = `run-${randomUUID()}`;
    // Org silent + no manifest ⇒ the headless lattice default (humanPresent:false)
    // is SKIP — a no-op that writes nothing and creates NO park.
    const out = await interception.autoApplyHeadlessRecommendation({
      runId,
      orgId: "org-headless-2067",
      agentId: "@vendor/agent",
      intent: { promptText: "{}" },
      restrictToSkillIds: [],
    });
    expect(out.mode).toBe("skipped");
    expect(out.written).toBe(0);
    const parks = await parkStore.readContinuationParksForRun(runId);
    expect(parks.filter((p) => p.checkpoint === "recommendation")).toHaveLength(0);
    expect(await hold.readRecommendationParkForRun(runId)).toBeNull();
  });

  it("AC-7: the Skills-tab join labels a ledger skill by its selection source", async () => {
    const runId = `run-${randomUUID()}`;
    // agent_run_skills_used FKs agent_runs(id) — insert the bare run row first.
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    await c.query(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, status, input_params, human_present)
       VALUES ($1, $2, $3, 'pending_input', '{}', true)`,
      [runId, `tpl-${randomUUID()}`, "org-2067"],
    );
    await c.end();
    // The run-start snapshot writes the telemetry ledger; the authoritative
    // selection carries the source the Skills tab labels by.
    ledgerStore.snapshotSkillsAtRunStart({
      runId,
      skills: [
        { skillId: "skill-a", skillKind: "installed" },
        { skillId: "skill-b", skillKind: "installed" },
        { skillId: "skill-c", skillKind: "installed" },
      ],
    });
    selectionStore.writeRunSelectedSkillRevisions({
      runId,
      selections: [
        { skillId: "skill-a", skillRevisionId: "skill-a@1", selectionSource: "recommended_confirmed" },
        { skillId: "skill-b", skillRevisionId: "skill-b@1", selectionSource: "recommended_auto_applied" },
        { skillId: "skill-c", skillRevisionId: "skill-c@1", selectionSource: "user_forced" },
      ],
    });

    // The join the Skills tab performs: ledger skill → selection source.
    const ledger = ledgerStore.listSkillsUsedForRun({ runId });
    const sourceBySkill = new Map(
      selectionStore.readRunSelectedSkillRevisions(runId).map((s) => [s.skillId, s.selectionSource]),
    );
    expect(ledger.length).toBeGreaterThanOrEqual(3);
    expect(sourceBySkill.get("skill-a")).toBe("recommended_confirmed"); // Confirmed
    expect(sourceBySkill.get("skill-b")).toBe("recommended_auto_applied"); // Auto-applied
    expect(sourceBySkill.get("skill-c")).toBe("user_forced"); // Forced
  });
});
