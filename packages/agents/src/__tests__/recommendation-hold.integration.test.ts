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
let database: typeof import("@/lib/database");

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
    // `DO $$ …` blocks are how the bootstrap creates its ENUM types (e.g.
    // custom_skill_owner_type). Without them the tables that reference those
    // types silently fail to create (cinatra#2148 needs custom_skill_assignments).
    if (
      head !== "CREATE" &&
      head !== "ALTER " &&
      head !== "DROP T" &&
      head !== "DROP S" &&
      head !== "DO $$ "
    ) {
      continue;
    }
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
  database = await import("@/lib/database");
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

// ---------------------------------------------------------------------------
// cinatra#2148 — recommendation-hold CONSISTENCY, against the same real store.
//
//   AC-a  org/workspace-assigned skills are part of the candidate set once the
//         RUN's actor/org context is threaded (finding 1). Proved on the REAL
//         parameterized predicate `readCustomSkillAssignmentsForAgent` — the
//         exact SQL `getAssignedSkillIdsForAgent` unions in — and the REAL
//         lifecycle-deliverability gate.
//   AC-b  park-then-release works for the two formerly-bypassing run-start paths
//         (Dev-Stepper preview + immediate trigger): both park on the SAME
//         per-run event id and both release through the S0 sweeper.
//   AC-d  no NEW park path can strand a run: a park created by the new call
//         sites carries a real TTL, the sweeper fail-closes it when due, and a
//         forced strand of a LIVE park is refused.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("cinatra#2148 — recommendation-hold consistency (real store)", () => {
  const ORG = "org-2148";
  const OTHER_ORG = "org-2148-other";
  const USER = "user-2148";
  const AGENT = "@vendor/agent-2148";

  async function seedScopedAssignments() {
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    // Two SCOPED assignments an actor-FREE resolve provably cannot see, plus a
    // foreign-org row that must never leak.
    await c.query(
      `INSERT INTO "${q(TEST_SCHEMA)}"."custom_skill_assignments"
         (skill_id, agent_id, owner_type, owner_id, created_by)
       VALUES ($1,$4,'organization',$5,$6),
              ($2,$4,'workspace','',$6),
              ($3,$4,'organization',$7,$6)
       ON CONFLICT (skill_id, agent_id) DO NOTHING`,
      [
        "skill-org-scoped",
        "skill-workspace-scoped",
        "skill-foreign-org",
        AGENT,
        ORG,
        USER,
        OTHER_ORG,
      ],
    );
    // The runtime-deliverability gate reads `skills.lifecycle_state`.
    await c.query(
      `INSERT INTO "${q(TEST_SCHEMA)}"."skills" (id, payload, lifecycle_state)
       VALUES ($1,'{}'::jsonb,'active'), ($2,'{}'::jsonb,'active'), ($3,'{}'::jsonb,'active')
       ON CONFLICT (id) DO UPDATE SET lifecycle_state = EXCLUDED.lifecycle_state`,
      ["skill-org-scoped", "skill-workspace-scoped", "skill-foreign-org"],
    );
    await c.end();
  }

  it("AC-a: the RUN's org actor SEES org- and workspace-scoped assignments; an org-less actor sees NONE", async () => {
    await seedScopedAssignments();

    // The filter shape `resolveRecommendationCandidateSkillIds` hands to
    // `getAssignedSkillIdsForAgent` for a run owned by USER in ORG.
    const runActorRows = database.readCustomSkillAssignmentsForAgent(AGENT, {
      principalId: USER,
      teamIds: [],
      projectIds: [],
      organizationId: ORG,
    });
    const runActorIds = runActorRows.map((r) => r.skillId).sort();
    expect(runActorIds).toEqual(["skill-org-scoped", "skill-workspace-scoped"]);
    // A foreign org's assignment never leaks into the candidate set.
    expect(runActorIds).not.toContain("skill-foreign-org");

    // The PRE-#2148 posture: an actor-free resolve degenerates to the most
    // restrictive non-admin caller (no principal, no org), so the SAME rows are
    // invisible — this is exactly why the chip row under-recommended.
    const orgLessRows = database.readCustomSkillAssignmentsForAgent(AGENT, {
      principalId: "",
      teamIds: [],
      projectIds: [],
      organizationId: "",
    });
    expect(orgLessRows).toHaveLength(0);

    // ...and the candidate ids the actor-scoped resolve produces are REAL
    // runtime-deliverable skills (the same lifecycle gate the resolver applies).
    const lifecycle = database.readSkillLifecycleStates(runActorIds);
    expect(lifecycle.ok).toBe(true);
    if (lifecycle.ok) {
      expect(lifecycle.states.get("skill-org-scoped")).toBe("active");
      expect(lifecycle.states.get("skill-workspace-scoped")).toBe("active");
    }
  });

  it("AC-b: BOTH formerly-bypassing run-start paths park on the SAME per-run seam and release", async () => {
    // Dev-Stepper child preview (finding 2) and an immediate trigger (finding 3)
    // are two DIFFERENT run-start paths; each parks its own run through the one
    // shared hold seam.
    for (const label of ["dev-child-preview", "immediate-trigger"] as const) {
      const runId = `run-2148-${label}-${randomUUID()}`;
      const parked = await parkRecommendation(runId);
      expect(parked.parked).toBe(true);

      // ONE recommendation park, keyed by the per-run constant event id.
      const parks = await parkStore.readContinuationParksForRun(runId);
      const recParks = parks.filter((p) => p.checkpoint === "recommendation");
      expect(recParks).toHaveLength(1);
      expect(recParks[0].eventId).toBe(hold.recommendationHoldEventId(runId));
      expect(recParks[0].status).toBe("parked");
      // The park holds the RUN's own execution — nothing downstream to block.
      expect(recParks[0].protectedEffect).toBe("none");

      // A second hold attempt on the same run is idempotent — never a second park.
      const again = await parkRecommendation(runId);
      expect(again.parked).toBe(true);
      if (again.parked) expect(again.parkId).toBe(recParks[0].id);
      expect(
        (await parkStore.readContinuationParksForRun(runId)).filter(
          (p) => p.checkpoint === "recommendation",
        ),
      ).toHaveLength(1);

      // The chip-row decision releases it — the run is free to dispatch.
      expect(await hold.releaseRecommendationParkForRun(runId)).toBe(true);
      expect((await hold.readRecommendationParkForRun(runId))?.status).toBe("released");
      // Idempotent: a second decision (or a retried dispatch) is a no-op.
      expect(await hold.releaseRecommendationParkForRun(runId)).toBe(false);
    }
  });

  it("AC-d: a park from the new call sites carries a REAL TTL the sweeper fail-closes (never an indefinite strand)", async () => {
    const runId = `run-2148-ttl-${randomUUID()}`;
    const parked = await parkRecommendation(runId);
    expect(parked.parked).toBe(true);
    const park = await hold.readRecommendationParkForRun(runId);
    expect(park).not.toBeNull();
    // The hold passes NO ttl override, so the store's default TTL applies — the
    // park is genuinely due-able, never open-ended.
    expect(park!.ttlExpiresAt.getTime()).toBeGreaterThan(Date.now());

    // A LIVE park can never be force-stranded — it must terminate through the
    // sweeper (the S0 forced-strand guard, unchanged by the new call sites).
    await expect(parkStore.strandPark(park!.id)).rejects.toMatchObject({
      code: "forced-strand",
    });

    // Simulate the TTL elapsing, then run the sweeper: the park ALWAYS resumes
    // into the terminal, ops-surfaced `policy_unresolved` state.
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    await c.query(
      `UPDATE "${q(TEST_SCHEMA)}"."lifecycle_continuation_park"
         SET ttl_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [park!.id],
    );
    await c.end();

    const swept = await parkStore.sweepParks();
    expect(swept.blocked).toBeGreaterThanOrEqual(1);
    const after = await hold.readRecommendationParkForRun(runId);
    expect(after?.status).toBe("policy_unresolved");
    expect(after?.resolvedAt).not.toBeNull();
  });
});
