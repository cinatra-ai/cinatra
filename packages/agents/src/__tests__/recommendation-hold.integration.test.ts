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
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { evaluatePolicy } from "@/lib/lifecycle/lifecycle-policy";
import { evaluateThenPark, type EvaluateThenParkOutcome } from "@/lib/lifecycle/lifecycle-continuation";

import {
  buildHoldNotificationFence,
  dispatchRecommendationHoldEntered,
  setRunWaitNotifier,
  type RunWaitNotifier,
} from "../run-wait-notifier";

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

/**
 * cinatra#2835 — the hold notification, against the REAL park table, the REAL
 * notifications table, the REAL sweeper and the REAL host writer.
 *
 * Two convergence rounds were lost here to the same mistake, so it is worth
 * naming: every claim this feature makes is about ORDERING between two writers,
 * and ordering is exactly what a mocked store cannot have. Round 1 wired the
 * clear into one helper and asserted it with a mocked `sweepParks`; round 2 moved
 * the clear to the primitive and asserted the ENTER's safety with a re-read that
 * a mock could never race. Both passed. Both were wrong.
 *
 * So these cases hold nothing back to a double. The notifier is the production
 * `runWaitNotifier`, which writes through the real notifications service into the
 * real `notifications` table; the park transitions run through the real
 * `sweepParks`; and where a race is the claim, two genuine Postgres sessions
 * contend for the row and the test asserts what the SECOND one sees.
 *
 * Round 3 findings covered here:
 *   1  TOCTOU — an enter can no longer land after the sweep that would have
 *      cleared it, in either direction of the race.
 *   2  FABRICATION — the exported dispatcher, called with any ids a caller likes,
 *      writes nothing unless the park backs them. The refusal is the database's.
 *   3  AT-MOST-ONCE CLEAR — a clear that does not commit leaves a retryable
 *      obligation on the park, and a later sweep discharges it.
 */
describe.skipIf(!HAS_DB)("cinatra#2835 — the hold notification against a real database", () => {
  const USER = "user-2835";

  beforeEach(async () => {
    // The PRODUCTION host writer, not a recording double.
    const hostNotifier = await import("@/lib/agent-run-wait-notifications");
    setRunWaitNotifier(hostNotifier.runWaitNotifier satisfies RunWaitNotifier);
  });

  // Never leak the wired notifier into another test file's module singleton.
  afterEach(() => setRunWaitNotifier(null));

  async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end().catch(() => {});
    }
  }

  /** A run the host writer can address a notification to (it reads `run_by`). */
  async function seedRun(runId: string) {
    await withClient((c) =>
      c.query(
        `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs"
           (id, template_id, org_id, status, input_params, human_present, run_by)
         VALUES ($1, $2, 'org-2835', 'pending_input', '{}', true, $3)
         ON CONFLICT (id) DO NOTHING`,
        [runId, `tpl-${randomUUID()}`, USER],
      ),
    );
  }

  /** Every awaiting-human row this run currently owns, park id included. */
  async function notificationRows(runId: string) {
    return withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT id, user_id, title, href,
                metadata -> 'runAwaitingHuman' ->> 'holdParkId' AS hold_park_id
           FROM "${q(TEST_SCHEMA)}"."notifications"
          WHERE dedupe_key = $1`,
        [`run-awaiting-human:${runId}`],
      );
      return rows as Array<Record<string, string | null>>;
    });
  }

  /** The park's status and what it owes the feed, read together. */
  async function parkState(parkId: string) {
    return withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT status, hold_notification FROM "${q(TEST_SCHEMA)}"."lifecycle_continuation_park" WHERE id = $1`,
        [parkId],
      );
      return rows[0] as { status: string; hold_notification: string } | undefined;
    });
  }

  /** Park a fresh run and notify for it exactly as the run-start hold does. */
  async function heldRun() {
    const runId = `run-2835-${randomUUID()}`;
    await seedRun(runId);
    const parked = await parkRecommendation(runId);
    expect(parked.parked).toBe(true);
    if (!parked.parked) throw new Error("unreachable: park failed");
    await dispatchRecommendationHoldEntered({ runId, parkId: parked.parkId });
    return { runId, parkId: parked.parkId };
  }

  // -------------------------------------------------------------------------
  // The enter, fenced.
  // -------------------------------------------------------------------------

  it("a LIVE hold: the row lands, carries its park id, and the park records the obligation", async () => {
    const { runId, parkId } = await heldRun();

    const rows = await notificationRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(USER);
    // The park id is stamped on the row, which is what lets the clear name its
    // OWN row rather than whatever currently holds this run's per-run key.
    expect(rows[0].hold_park_id).toBe(parkId);
    // Written in the SAME transaction as the insert: the obligation cannot claim
    // a row that was not written, nor miss one that was.
    expect(await parkState(parkId)).toMatchObject({
      status: "parked",
      hold_notification: "live",
    });
  });

  // -------------------------------------------------------------------------
  // cinatra#2838 — the insert can no-op even when the fence holds.
  //
  // The guard admitting the write is not the same fact as the write happening:
  // the insert carries `ON CONFLICT (user_id, dedupe_key) DO NOTHING`, and the
  // hold's key is the run's PER-RUN awaiting-human key. So an initiator who
  // already holds a row on that key — an earlier wait on the same run whose clear
  // has not landed — makes the insert write nothing while the park is perfectly
  // `parked`. This is the case a mark that only repeated the guard's predicate got
  // wrong, and it got it wrong in the worst direction: it recorded the park `live`,
  // the park-scoped clear then matched no row (none carried this hold's park id)
  // and acked the obligation discharged, and the hold was never announced to
  // anybody while the ledger said it had been.
  // -------------------------------------------------------------------------

  it("A NO-OPPED INSERT MARKS NOTHING: a pre-existing row on the run's key leaves the park owing nothing", async () => {
    const runId = `run-2838-${randomUUID()}`;
    await seedRun(runId);

    // A DIFFERENT writer already holds this run's per-run key — a real approval
    // gate the run reached first, carrying no hold park id.
    const squatterId = randomUUID();
    await withClient((c) =>
      c.query(
        `INSERT INTO "${q(TEST_SCHEMA)}"."notifications"
           (id, user_id, recipient_kind, recipient_id, topic, kind, title, body, dedupe_key, metadata, created_at)
         VALUES ($1, $2, 'user', $2, 'user', 'warning', 'A run is awaiting your approval', '', $3,
                 jsonb_build_object('runAwaitingHuman', jsonb_build_object('runId', $4::text, 'reason', 'pending_approval')), now())`,
        [squatterId, USER, `run-awaiting-human:${runId}`, runId],
      ),
    );

    const parked = await parkRecommendation(runId);
    expect(parked.parked).toBe(true);
    if (!parked.parked) throw new Error("unreachable: park failed");
    await dispatchRecommendationHoldEntered({ runId, parkId: parked.parkId });

    // The insert no-opped: the key still holds exactly the earlier row, untouched.
    const rows = await notificationRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(squatterId);
    expect(rows[0].hold_park_id).toBeNull();

    // AND THE PARK SAYS SO. `live` would be a lie here — no row carries this
    // hold's park id, so the park-scoped clear could never find one, and acking it
    // would retire an obligation that was never incurred.
    expect(await parkState(parked.parkId)).toMatchObject({
      status: "parked",
      hold_notification: "none",
    });
  });

  it("...and the sweep that follows discharges nothing and destroys nothing", async () => {
    // The other half of the same defect: with the park marked `none`, the drain
    // has no obligation to chase, so the squatting row of a DIFFERENT wait cannot
    // be collateral of a hold that never wrote anything.
    const runId = `run-2838b-${randomUUID()}`;
    await seedRun(runId);
    await withClient((c) =>
      c.query(
        `INSERT INTO "${q(TEST_SCHEMA)}"."notifications"
           (id, user_id, recipient_kind, recipient_id, topic, kind, title, body, dedupe_key, metadata, created_at)
         VALUES ($1, $2, 'user', $2, 'user', 'warning', 'A run is awaiting your approval', '', $3,
                 jsonb_build_object('runAwaitingHuman', jsonb_build_object('runId', $4::text, 'reason', 'pending_approval')), now())`,
        [randomUUID(), USER, `run-awaiting-human:${runId}`, runId],
      ),
    );
    const parked = await parkRecommendation(runId);
    if (!parked.parked) throw new Error("unreachable: park failed");
    await dispatchRecommendationHoldEntered({ runId, parkId: parked.parkId });

    await parkStore.sweepParks({ releasedParkIds: [parked.parkId] });

    const rows = await notificationRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].hold_park_id).toBeNull();
    expect(rows[0].title).toContain("awaiting your approval");
  });

  // -------------------------------------------------------------------------
  // Finding 2 — fabrication, refused by the database.
  // -------------------------------------------------------------------------

  it("FABRICATION: an invented park id writes NOTHING — a cast cannot buy a notification", async () => {
    const victim = `run-2835-victim-${randomUUID()}`;
    await seedRun(victim);

    // Exactly what the round-2 seam could be made to accept: the caller asserts a
    // live hold that does not exist. The cast is the point — it reproduces what
    // arbitrary caller code can do at runtime once the seam is exported. It is now
    // powerless, because the assertion is no longer made in TypeScript.
    await dispatchRecommendationHoldEntered({
      runId: victim,
      parkId: `park-invented-${randomUUID()}`,
    } as Parameters<typeof dispatchRecommendationHoldEntered>[0]);

    expect(await notificationRows(victim)).toHaveLength(0);
  });

  it("FABRICATION: a REAL park that is not this run's hold writes nothing either", async () => {
    const victim = `run-2835-victim2-${randomUUID()}`;
    await seedRun(victim);

    // (a) Someone else's live recommendation hold. The park is real and parked —
    // only the pairing is a lie, and the guard matches on run_id too.
    const other = await heldRun();
    await dispatchRecommendationHoldEntered({
      runId: victim,
      parkId: other.parkId,
    });
    expect(await notificationRows(victim)).toHaveLength(0);

    // (b) This run's own park, but a `review` (auto-gate) one. That wait notifies
    // through the auto-gate pair; a second row here would double-ring it under a
    // key the gate's resolve never clears.
    const reviewOutcome: EvaluateThenParkOutcome = {
      kind: "park",
      checkpoint: "review",
      protectedEffect: "external_publish",
      reevaluationIntent: false,
      reason: "test review park",
    };
    const review = await parkStore.maybeParkCheckpoint(reviewOutcome, {
      runId: victim,
      eventId: `evt-review-${randomUUID()}`,
    });
    expect(review.parked).toBe(true);
    if (!review.parked) return;
    await dispatchRecommendationHoldEntered({
      runId: victim,
      parkId: review.parkId,
    });
    expect(await notificationRows(victim)).toHaveLength(0);
    // ...and the review park is untouched: nothing marked it as owing a clear.
    expect(await parkState(review.parkId)).toMatchObject({ hold_notification: "none" });
  });

  // -------------------------------------------------------------------------
  // Finding 1 — the TOCTOU, in both directions.
  // -------------------------------------------------------------------------

  it("TOCTOU (sweep first): a hold whose park ALREADY went terminal mints nothing", async () => {
    // The exact sequence the finding names: the park transitions, the sweep's
    // clear runs, and only THEN does the enter reach the write. Under the round-2
    // shape this recreated the row after its one clearing transition had passed —
    // permanently stale, because a park cannot transition twice.
    const runId = `run-2835-late-${randomUUID()}`;
    await seedRun(runId);
    const parked = await parkRecommendation(runId);
    if (!parked.parked) return;

    const swept = await parkStore.sweepParks({ releasedParkIds: [parked.parkId] });
    expect(swept.released).toBe(1);

    await dispatchRecommendationHoldEntered({ runId, parkId: parked.parkId });

    expect(await notificationRows(runId)).toHaveLength(0);
    expect(await parkState(parked.parkId)).toMatchObject({
      status: "released",
      hold_notification: "none",
    });
  });

  it("TOCTOU (enter first): the enter's row LOCK makes the sweeper's CAS wait for it", async () => {
    // The claim under test is not "the code checks something" — it is that two
    // Postgres sessions cannot both proceed. So this drives two real sessions and
    // asserts the second one BLOCKS.
    const runId = `run-2835-lock-${randomUUID()}`;
    await seedRun(runId);
    const parked = await parkRecommendation(runId);
    if (!parked.parked) return;

    const fence = buildHoldNotificationFence({
      schema: TEST_SCHEMA,
      parkId: parked.parkId,
      runId,
      insertedCte: "notification_write",
    });

    const enter = new Client({ connectionString: DB_URL });
    const sweeper = new Client({ connectionString: DB_URL });
    await enter.connect();
    await sweeper.connect();
    try {
      // The enter opens its transaction and takes the park's row lock, exactly as
      // the fenced INSERT does.
      await enter.query("BEGIN");
      const guarded = await enter.query(fence.guard, fence.values);
      expect(guarded.rowCount).toBe(1);

      // The sweeper's own CAS, verbatim. It must not be able to transition the
      // park while the enter is mid-write.
      let casSettled = false;
      const cas = sweeper
        .query(
          `UPDATE "${q(TEST_SCHEMA)}"."lifecycle_continuation_park"
              SET status = 'released', resolved_at = now()
            WHERE id = $1 AND status = 'parked'`,
          [parked.parkId],
        )
        .then((r) => {
          casSettled = true;
          return r;
        });

      // Bounded wait: if the lock did NOT hold, the CAS would have completed here.
      await new Promise((r) => setTimeout(r, 400));
      expect(casSettled).toBe(false);

      await enter.query("COMMIT");
      const casResult = await cas;
      expect(casSettled).toBe(true);
      // The CAS still finds a `parked` row (the enter changed no status), so the
      // transition happens AFTER the write — which is the ordering that lets the
      // clear see the row it must delete.
      expect(casResult.rowCount).toBe(1);
    } finally {
      await enter.query("ROLLBACK").catch(() => {});
      await enter.end().catch(() => {});
      await sweeper.end().catch(() => {});
    }
  });

  it("TOCTOU (sweep first, contended): a guard that waits on the CAS then matches NOTHING", async () => {
    // The other side of the same lock. The enter's guard arrives while a sweep's
    // CAS is uncommitted, blocks on its lock, and — under READ COMMITTED — is
    // re-evaluated against the row version the CAS committed. It must find no row,
    // which is what makes "the wait is already over" impossible to miss.
    const runId = `run-2835-recheck-${randomUUID()}`;
    await seedRun(runId);
    const parked = await parkRecommendation(runId);
    if (!parked.parked) return;

    const fence = buildHoldNotificationFence({
      schema: TEST_SCHEMA,
      parkId: parked.parkId,
      runId,
      insertedCte: "notification_write",
    });

    const sweeper = new Client({ connectionString: DB_URL });
    const enter = new Client({ connectionString: DB_URL });
    await sweeper.connect();
    await enter.connect();
    try {
      await sweeper.query("BEGIN");
      await sweeper.query(
        `UPDATE "${q(TEST_SCHEMA)}"."lifecycle_continuation_park"
            SET status = 'policy_unresolved', resolved_at = now()
          WHERE id = $1 AND status = 'parked'`,
        [parked.parkId],
      );

      let guardSettled = false;
      const guard = enter.query(fence.guard, fence.values).then((r) => {
        guardSettled = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(guardSettled).toBe(false); // waiting on the sweeper's lock

      await sweeper.query("COMMIT");
      const guarded = await guard;
      // ZERO rows: the re-check saw `policy_unresolved`. The insert this guard
      // feeds therefore inserts nothing, with no code in between to get it wrong.
      expect(guarded.rowCount).toBe(0);
    } finally {
      await sweeper.query("ROLLBACK").catch(() => {});
      await sweeper.end().catch(() => {});
      await enter.end().catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // Finding 3 — the clear is an obligation, and obligations survive failure.
  // -------------------------------------------------------------------------

  it("the transition and the clear are ONE observable state: terminal park ⇒ no row", async () => {
    const { runId, parkId } = await heldRun();
    expect(await notificationRows(runId)).toHaveLength(1);

    const swept = await parkStore.sweepParks({ releasedParkIds: [parkId] });
    expect(swept.released).toBe(1);
    expect(swept.holdNotificationsCleared).toBe(1);

    // Read the invariant in ONE DB state, not as two separate happenings.
    const [state, rows] = await Promise.all([parkState(parkId), notificationRows(runId)]);
    expect(state).toMatchObject({ status: "released", hold_notification: "cleared" });
    expect(rows).toHaveLength(0);
  });

  it("TTL FAIL-CLOSE clears too — the arm with no decision and no helper behind it", async () => {
    const { runId, parkId } = await heldRun();
    await withClient((c) =>
      c.query(
        `UPDATE "${q(TEST_SCHEMA)}"."lifecycle_continuation_park"
            SET ttl_expires_at = now() - interval '1 minute' WHERE id = $1`,
        [parkId],
      ),
    );

    const swept = await parkStore.sweepParks();
    expect(swept.blocked).toBeGreaterThanOrEqual(1);
    expect(await parkState(parkId)).toMatchObject({
      status: "policy_unresolved",
      hold_notification: "cleared",
    });
    expect(await notificationRows(runId)).toHaveLength(0);
  });

  it("the hold helper's release clears too — it INHERITS the primitive", async () => {
    const { runId, parkId } = await heldRun();
    expect(await hold.releaseRecommendationParkForRun(runId)).toBe(true);
    expect(await parkState(parkId)).toMatchObject({ hold_notification: "cleared" });
    expect(await notificationRows(runId)).toHaveLength(0);
  });

  it("A CLEAR THAT DOES NOT COMMIT leaves the obligation — and the NEXT sweep discharges it", async () => {
    // This is the round-3 finding stated as a test: under the old shape the clear
    // was dispatched after the CAS and its failure was swallowed, so a notifier
    // outage (or a process that died right here) stranded the row forever — the
    // park was already terminal, and a terminal park can never be re-returned by a
    // later CAS. Nothing in the system would have looked at it again.
    const { runId, parkId } = await heldRun();

    // The notifier is down for this pass. The park still transitions — a
    // notification must never fail a sweep — but nothing is acked.
    setRunWaitNotifier({
      onEnterHumanWait: () => {},
      onLeaveHumanWait: () => {},
      onClearRecommendationHold: () => {
        throw new Error("notifications down");
      },
    } satisfies RunWaitNotifier);

    const first = await parkStore.sweepParks({ releasedParkIds: [parkId] });
    expect(first.released).toBe(1);
    expect(first.holdNotificationsCleared).toBe(0);
    // Terminal park, row still standing — and, crucially, the obligation with it.
    expect(await parkState(parkId)).toMatchObject({
      status: "released",
      hold_notification: "live",
    });
    expect(await notificationRows(runId)).toHaveLength(1);

    // A later pass. It transitions NOTHING — the park is long terminal — and this
    // is exactly the case the old shape could not express.
    const hostNotifier = await import("@/lib/agent-run-wait-notifications");
    setRunWaitNotifier(hostNotifier.runWaitNotifier satisfies RunWaitNotifier);
    const second = await parkStore.sweepParks();
    expect(second.released).toBe(0);
    expect(second.holdNotificationsCleared).toBeGreaterThanOrEqual(1);

    expect(await notificationRows(runId)).toHaveLength(0);
    expect(await parkState(parkId)).toMatchObject({ hold_notification: "cleared" });
  });

  it("the clear names its OWN row — a later, unrelated wait on the same run survives it", async () => {
    // The dedupeKey is per-RUN, and a retried clear can arrive arbitrarily late.
    // By then the key may legitimately belong to a different wait (a real approval
    // gate the run reached afterwards), which this hold has no business deleting.
    const { runId, parkId } = await heldRun();
    await parkStore.sweepParks({ releasedParkIds: [parkId] });
    expect(await notificationRows(runId)).toHaveLength(0);

    // A DIFFERENT writer takes the same per-run key, carrying no hold park id.
    await withClient((c) =>
      c.query(
        `INSERT INTO "${q(TEST_SCHEMA)}"."notifications"
           (id, user_id, recipient_kind, recipient_id, topic, kind, title, body, dedupe_key, metadata, created_at)
         VALUES ($1, $2, 'user', $2, 'user', 'warning', 'A run is awaiting your approval', '', $3,
                 jsonb_build_object('runAwaitingHuman', jsonb_build_object('runId', $4::text, 'reason', 'pending_approval')), now())`,
        [randomUUID(), USER, `run-awaiting-human:${runId}`, runId],
      ),
    );

    // Force the obligation back on, as a stuck retry would leave it, and sweep.
    await withClient((c) =>
      c.query(
        `UPDATE "${q(TEST_SCHEMA)}"."lifecycle_continuation_park"
            SET hold_notification = 'live' WHERE id = $1`,
        [parkId],
      ),
    );
    await parkStore.sweepParks();

    // The approval row is untouched: it carries no holdParkId, so no hold can
    // address it.
    const rows = await notificationRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].hold_park_id).toBeNull();
    expect(rows[0].title).toContain("awaiting your approval");
  });

  it("a NON-hold park leaving `parked` clears NOTHING", async () => {
    // A `review` park never enters through this seam, so it never owes a clear and
    // the drain's checkpoint predicate never picks it up.
    const runId = `run-2835-review-${randomUUID()}`;
    await seedRun(runId);
    const reviewOutcome: EvaluateThenParkOutcome = {
      kind: "park",
      checkpoint: "review",
      protectedEffect: "external_publish",
      reevaluationIntent: false,
      reason: "test review park",
    };
    const parked = await parkStore.maybeParkCheckpoint(reviewOutcome, {
      runId,
      eventId: `evt-review-${randomUUID()}`,
    });
    if (!parked.parked) return;

    const swept = await parkStore.sweepParks({ releasedParkIds: [parked.parkId] });
    expect(swept.released).toBe(1);
    expect(swept.holdNotificationsCleared).toBe(0);
  });

  // -------------------------------------------------------------------------
  // FAIR SELECTION (cinatra#2838, Codex convergence round 4). The drain is
  // BOUNDED — at most `limit` obligations per pass — and a dispatch that fails
  // leaves its obligation standing. Unordered, those two facts multiply into a
  // starvation bound rather than a work bound: `limit` deterministically-failing
  // obligations (a recipient that no longer exists, a park whose run row was
  // hard-deleted) hold the page on EVERY pass, and everything queued behind them
  // is never attempted — not delayed, never attempted.
  //
  // Ordering is a property of the database, not of a mock (the same reason the
  // TOCTOU cases above use two real sessions), so these run against the real
  // table, with the parks' `created_at` written to fixed, distinct instants so the
  // model has ONE possible claim order.
  // -------------------------------------------------------------------------

  /** Retire every obligation this file's earlier cases may have left standing, so
   * a fairness model is exactly the rows it seeds — nothing older sorts ahead. */
  async function clearOutstandingObligations() {
    await withClient((c) =>
      c.query(
        `UPDATE "${q(TEST_SCHEMA)}"."lifecycle_continuation_park"
            SET hold_notification = 'cleared' WHERE hold_notification = 'live'`,
      ),
    );
  }

  /** Pin the park's age, so "oldest first" is decided by the test, not the clock. */
  async function ageParkBy(parkId: string, minutes: number) {
    await withClient((c) =>
      c.query(
        `UPDATE "${q(TEST_SCHEMA)}"."lifecycle_continuation_park"
            SET created_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
        [parkId, String(minutes)],
      ),
    );
  }

  /** The retry cursor, read raw: null until the drain has claimed the obligation. */
  async function attemptedAt(parkId: string): Promise<Date | null> {
    return withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT hold_notify_attempted_at FROM "${q(TEST_SCHEMA)}"."lifecycle_continuation_park" WHERE id = $1`,
        [parkId],
      );
      return (rows[0]?.hold_notify_attempted_at ?? null) as Date | null;
    });
  }

  /**
   * The production host writer, with the clear POISONED for a named set of parks
   * and RECORDING every park it was asked to clear, in order. A poisoned park
   * throws — the same shape as a notifier that is up but can never satisfy this
   * particular row — so `dispatchRecommendationHoldCleared` returns false and the
   * obligation stands. Every other park clears for real, through the real service.
   */
  async function poisonedNotifier(poison: ReadonlySet<string>, seen: string[]) {
    const hostNotifier = await import("@/lib/agent-run-wait-notifications");
    const real = hostNotifier.runWaitNotifier;
    setRunWaitNotifier({
      ...real,
      onClearRecommendationHold: async (input: { runId: string; parkId: string }) => {
        seen.push(input.parkId);
        if (poison.has(input.parkId)) throw new Error("notifier cannot satisfy this row");
        return (await real.onClearRecommendationHold?.(input)) ?? false;
      },
    } as RunWaitNotifier);
  }

  it("A PAGE OF POISON DELAYS, IT DOES NOT STARVE: the row behind it dispatches on the next sweep", async () => {
    await clearOutstandingObligations();
    const LIMIT = 2; // == the number of poison rows, so they FILL a page exactly.

    // Two obligations whose clear can never commit, both OLDER than the healthy
    // one behind them — so an unordered page picks them, every time, forever.
    const poisonA = await heldRun();
    const poisonB = await heldRun();
    const healthy = await heldRun();
    await ageParkBy(poisonA.parkId, 30);
    await ageParkBy(poisonB.parkId, 20);
    await ageParkBy(healthy.parkId, 10);

    const seen: string[] = [];
    await poisonedNotifier(new Set([poisonA.parkId, poisonB.parkId]), seen);

    // SWEEP 1 — the page is the two poison rows, and it retires nothing.
    const first = await parkStore.sweepParks({
      releasedParkIds: [poisonA.parkId, poisonB.parkId, healthy.parkId],
      limit: LIMIT,
    });
    expect(first.released).toBe(3);
    expect(first.holdNotificationsCleared).toBe(0);
    // The PAGE is what the claim decides; the order the two dispatches happen in
    // inside one pass is not a property (both happen before the pass returns).
    expect([...seen].sort()).toEqual([poisonA.parkId, poisonB.parkId].sort());
    // The healthy obligation was not even ATTEMPTED — its cursor is untouched.
    expect(await attemptedAt(healthy.parkId)).toBeNull();
    expect(await parkState(healthy.parkId)).toMatchObject({ hold_notification: "live" });
    // ...while both poison rows now carry a cursor: they have been to the front.
    expect(await attemptedAt(poisonA.parkId)).not.toBeNull();
    expect(await attemptedAt(poisonB.parkId)).not.toBeNull();

    // SWEEP 2 — THE PIN. The poison rows have rotated behind the one obligation
    // that has never been attempted, so the healthy row is served and its bell
    // goes away. Under the unordered page this sweep dispatched the same two
    // poison rows again, and every sweep after it would have too.
    seen.length = 0;
    const second = await parkStore.sweepParks({ limit: LIMIT });
    expect(seen).toContain(healthy.parkId);
    expect(second.holdNotificationsCleared).toBe(1);
    expect(await parkState(healthy.parkId)).toMatchObject({ hold_notification: "cleared" });
    expect(await notificationRows(healthy.runId)).toHaveLength(0);

    // NOTHING WAS DROPPED to buy that: both poison obligations are still standing,
    // still `live`, with their bells intact — and they are RETRIED, not abandoned,
    // the moment the notifier can satisfy them.
    expect(await parkState(poisonA.parkId)).toMatchObject({ hold_notification: "live" });
    expect(await parkState(poisonB.parkId)).toMatchObject({ hold_notification: "live" });
    expect(await notificationRows(poisonA.runId)).toHaveLength(1);
    expect(await notificationRows(poisonB.runId)).toHaveLength(1);

    const hostNotifier = await import("@/lib/agent-run-wait-notifications");
    setRunWaitNotifier(hostNotifier.runWaitNotifier satisfies RunWaitNotifier);
    const third = await parkStore.sweepParks({ limit: LIMIT });
    expect(third.holdNotificationsCleared).toBe(2);
    expect(await parkState(poisonA.parkId)).toMatchObject({ hold_notification: "cleared" });
    expect(await parkState(poisonB.parkId)).toMatchObject({ hold_notification: "cleared" });
    expect(await notificationRows(poisonA.runId)).toHaveLength(0);
    expect(await notificationRows(poisonB.runId)).toHaveLength(0);
  });

  it("the claim order is a ROUND ROBIN over the outstanding obligations, oldest cursor first", async () => {
    await clearOutstandingObligations();

    // Three obligations, none of which can be satisfied — so none is ever retired
    // and the queue's ORDER is the only thing that moves. ONE ROW PER PAGE, because
    // the claim's guarantee is about which obligations a page CONTAINS (the whole
    // page is dispatched in the same pass, so the order inside it is not a
    // property anyone should depend on) — at limit 1, the page IS the order.
    const first = await heldRun();
    const second = await heldRun();
    const third = await heldRun();
    await ageParkBy(first.parkId, 30);
    await ageParkBy(second.parkId, 20);
    await ageParkBy(third.parkId, 10);

    const seen: string[] = [];
    await poisonedNotifier(new Set([first.parkId, second.parkId, third.parkId]), seen);

    await parkStore.sweepParks({
      releasedParkIds: [first.parkId, second.parkId, third.parkId],
      limit: 1,
    });
    for (let pass = 0; pass < 3; pass++) await parkStore.sweepParks({ limit: 1 });

    // Oldest-untried first (creation order), then the same cycle again as each
    // failed attempt sends its row to the back — no row is served twice before
    // every other row has been served once.
    expect(seen).toEqual([first.parkId, second.parkId, third.parkId, first.parkId]);
    expect(await parkState(first.parkId)).toMatchObject({ hold_notification: "live" });
    expect(await parkState(second.parkId)).toMatchObject({ hold_notification: "live" });
    expect(await parkState(third.parkId)).toMatchObject({ hold_notification: "live" });
  });

  it("a forced strand REFUSES to abandon an outstanding obligation", async () => {
    // The park row is the only place the obligation lives. Deleting it while a
    // clear is owed would strand the notification with nothing left to re-drive
    // it — so the teardown discharges the obligation first, or does not happen.
    const { runId, parkId } = await heldRun();
    setRunWaitNotifier({
      onEnterHumanWait: () => {},
      onLeaveHumanWait: () => {},
      onClearRecommendationHold: () => false,
    } satisfies RunWaitNotifier);
    await parkStore.sweepParks({ releasedParkIds: [parkId] });
    expect(await parkState(parkId)).toMatchObject({ hold_notification: "live" });

    await expect(parkStore.strandPark(parkId)).rejects.toMatchObject({ code: "conflict" });
    expect(await parkState(parkId)).toBeDefined(); // still there to be retried

    // With the real writer the obligation discharges and the teardown proceeds.
    const hostNotifier = await import("@/lib/agent-run-wait-notifications");
    setRunWaitNotifier(hostNotifier.runWaitNotifier satisfies RunWaitNotifier);
    await parkStore.strandPark(parkId);
    expect(await parkState(parkId)).toBeUndefined();
    expect(await notificationRows(runId)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // THE BOUNDED DISPATCH (cinatra#2868). The drain's `await` on the notifier used
  // to be unbounded. `dispatchRecommendationHoldCleared` swallows a THROWN port —
  // that is the failure the cases above exercise — but a promise that never
  // SETTLES is not a throw, and nothing in the loop could ever come back from
  // one. No obligation was lost (the page is stamped at claim, so its rows rotate
  // and a later sweep recovers them); the SWEEPER was what hung, and it has two
  // callers that cannot afford it: the ~60s gate-maintenance job, whose slot
  // stalls, and `releaseRecommendationParkForRun`, which awaits `sweepParks`
  // synchronously on a human's confirm/skip.
  //
  // These cases run against the real store with a real wedged port and real wall
  // clock — a fake-timer double could not fail them, because the property under
  // test is "this call returns", not "this code calls setTimeout".
  //
  // The bound is `HOLD_NOTIFY_DISPATCH_TIMEOUT_MS` = 500ms at concurrency
  // `HOLD_NOTIFY_DISPATCH_CONCURRENCY` = 4, with the pass giving up after
  // `HOLD_NOTIFY_EXPIRY_BREAKER` = 4 expiries; all three are module-private, so
  // the numbers below name them rather than import them.
  //
  // The breaker is the second half of the fix and has its own case below: the
  // bound abandons a wedged operation rather than cancelling it, so capping the
  // WAIT is not the same as capping how much a wedged page leaves running.
  // -------------------------------------------------------------------------

  const BOUND_MS = 500; // == HOLD_NOTIFY_DISPATCH_TIMEOUT_MS
  const WAVE = 4; // == HOLD_NOTIFY_DISPATCH_CONCURRENCY
  const BREAKER = 4; // == HOLD_NOTIFY_EXPIRY_BREAKER

  /**
   * The production host writer with the clear WEDGED for a named set of parks: it
   * hands back a promise nothing will ever settle, which is exactly the shape the
   * dispatcher cannot report. Every other park clears for real, through the real
   * service, so a wedged row and a healthy one can share one page.
   */
  async function wedgedNotifier(wedged: ReadonlySet<string>, seen: string[]) {
    const hostNotifier = await import("@/lib/agent-run-wait-notifications");
    const real = hostNotifier.runWaitNotifier;
    setRunWaitNotifier({
      ...real,
      onClearRecommendationHold: async (input: { runId: string; parkId: string }) => {
        seen.push(input.parkId);
        if (wedged.has(input.parkId)) return new Promise<boolean>(() => {});
        return (await real.onClearRecommendationHold?.(input)) ?? false;
      },
    } as RunWaitNotifier);
  }

  it("A NEVER-SETTLING NOTIFIER DOES NOT PARK THE DRAIN: the sweep comes back", async () => {
    await clearOutstandingObligations();
    const wedgedA = await heldRun();
    const wedgedB = await heldRun();

    const seen: string[] = [];
    await wedgedNotifier(new Set([wedgedA.parkId, wedgedB.parkId]), seen);

    const startedAt = Date.now();
    const swept = await parkStore.sweepParks({
      releasedParkIds: [wedgedA.parkId, wedgedB.parkId],
      limit: 2,
    });
    const elapsed = Date.now() - startedAt;

    // THE PIN, and it is the plainest one in this file: the call RETURNED.
    // Unbounded, this `await` never resolves and the case dies on the timeout.
    expect(swept.released).toBe(2);
    expect(swept.holdNotificationsCleared).toBe(0);
    expect([...seen].sort()).toEqual([wedgedA.parkId, wedgedB.parkId].sort());

    // Bounded by the budget rather than by luck: both dispatches fit inside one
    // concurrency wave, so the page costs about ONE bound, not two.
    expect(elapsed).toBeGreaterThanOrEqual(BOUND_MS - 100);
    expect(elapsed).toBeLessThan(BOUND_MS * 6);

    // ...and an EXPIRY is exactly a `false`. The obligation stands, its bell is
    // untouched, and the claim's cursor moved, so the page rotates as always.
    for (const w of [wedgedA, wedgedB]) {
      expect(await parkState(w.parkId)).toMatchObject({
        status: "released",
        hold_notification: "live",
      });
      expect(await notificationRows(w.runId)).toHaveLength(1);
      expect(await attemptedAt(w.parkId)).not.toBeNull();
    }
  });

  it("an EXPIRED obligation is RETRIED: a later sweep discharges it for real", async () => {
    await clearOutstandingObligations();
    const wedged = await heldRun();

    const seen: string[] = [];
    await wedgedNotifier(new Set([wedged.parkId]), seen);

    const first = await parkStore.sweepParks({ releasedParkIds: [wedged.parkId], limit: 1 });
    expect(first.holdNotificationsCleared).toBe(0);
    expect(await parkState(wedged.parkId)).toMatchObject({ hold_notification: "live" });
    expect(await notificationRows(wedged.runId)).toHaveLength(1);

    // Nothing on the row says "timed out", and that is the design: an expiry is
    // not a state, it is the ABSENCE of an ack — so the ordinary retry path, the
    // one a throwing port already used, applies unchanged.
    const hostNotifier = await import("@/lib/agent-run-wait-notifications");
    setRunWaitNotifier(hostNotifier.runWaitNotifier satisfies RunWaitNotifier);

    const second = await parkStore.sweepParks({ limit: 1 });
    expect(second.holdNotificationsCleared).toBe(1);
    expect(await parkState(wedged.parkId)).toMatchObject({ hold_notification: "cleared" });
    expect(await notificationRows(wedged.runId)).toHaveLength(0);
  });

  it("a HEALTHY page pays NOTHING for the bound — it is a ceiling, never a floor", async () => {
    await clearOutstandingObligations();
    const runs: Array<Awaited<ReturnType<typeof heldRun>>> = [];
    for (let i = 0; i < WAVE * 2; i++) runs.push(await heldRun());

    const startedAt = Date.now();
    const swept = await parkStore.sweepParks({
      releasedParkIds: runs.map((r) => r.parkId),
      limit: runs.length,
    });
    const elapsed = Date.now() - startedAt;

    expect(swept.holdNotificationsCleared).toBe(runs.length);
    for (const r of runs) {
      expect(await parkState(r.parkId)).toMatchObject({ hold_notification: "cleared" });
      expect(await notificationRows(r.runId)).toHaveLength(0);
    }
    // TWO full waves of settled dispatches. Each one clears its timer the instant
    // it settles, so the page never waits for the bound — a floor would have cost
    // 2 x 500ms here and this assertion is what would catch it.
    expect(elapsed).toBeLessThan(BOUND_MS * 2);
  });

  it("the bound does not LEAK ACROSS dispatches: a healthy row on a wedged page clears", async () => {
    await clearOutstandingObligations();
    const wedged = await heldRun();
    const healthy = await heldRun();

    const seen: string[] = [];
    await wedgedNotifier(new Set([wedged.parkId]), seen);

    const swept = await parkStore.sweepParks({
      releasedParkIds: [wedged.parkId, healthy.parkId],
      limit: 2,
    });

    // The wedged row costs itself one bound and costs its page-mate nothing.
    expect(swept.holdNotificationsCleared).toBe(1);
    expect(await parkState(healthy.parkId)).toMatchObject({ hold_notification: "cleared" });
    expect(await notificationRows(healthy.runId)).toHaveLength(0);
    expect(await parkState(wedged.parkId)).toMatchObject({ hold_notification: "live" });
    expect(await notificationRows(wedged.runId)).toHaveLength(1);
  });

  it("A WEDGED PAGE STOPS LAUNCHING: the breaker caps how many operations one pass abandons", async () => {
    // THE FINDING THIS PINS. The per-dispatch bound bounds the WAIT, not the
    // OPERATION: on expiry the drain walks away and the dispatch it started keeps
    // running. Without a breaker the wave simply refills, so a page of N wedged
    // rows leaves N live in-flight operations behind it — not `WAVE` of them —
    // and each one can hold a connection of the agents pool (pg default max 10)
    // for as long as it stays wedged. The cap has to be on how many the pass ever
    // LAUNCHES, because nothing here can reclaim one it already has.
    await clearOutstandingObligations();

    // A page comfortably larger than E + WAVE, so "stopped early" and "ran the
    // whole page" are different numbers and the assertion can tell them apart.
    const PAGE = 12;
    const runs: Array<Awaited<ReturnType<typeof heldRun>>> = [];
    for (let i = 0; i < PAGE; i++) runs.push(await heldRun());

    const seen: string[] = [];
    await wedgedNotifier(new Set(runs.map((r) => r.parkId)), seen);

    const startedAt = Date.now();
    const swept = await parkStore.sweepParks({
      releasedParkIds: runs.map((r) => r.parkId),
      limit: PAGE,
    });
    const elapsed = Date.now() - startedAt;

    expect(swept.released).toBe(PAGE);
    expect(swept.holdNotificationsCleared).toBe(0);

    // THE PIN — and `seen` is the honest instrument for it, because it counts what
    // the port was actually ASKED to do, which is exactly the set of operations
    // left running. The ceiling is E + WAVE - 1 = 7, and a fully wedged page
    // really does reach it: the wave expires in unison, so the first WAVE - 1
    // workers each read a count still under budget and pull one more row before
    // the last one trips the breaker.
    expect(seen.length).toBeLessThanOrEqual(BREAKER + WAVE - 1);
    expect(seen.length).toBeLessThan(PAGE); // the mutation-discriminating half
    // Every park the breaker skipped is untouched and still owed — stopping a pass
    // strands nothing, because claim-time stamping already rotated the whole page.
    for (const r of runs) {
      expect(await parkState(r.parkId)).toMatchObject({
        status: "released",
        hold_notification: "live",
      });
      expect(await notificationRows(r.runId)).toHaveLength(1);
      expect(await attemptedAt(r.parkId)).not.toBeNull();
    }

    // The wall clock follows from the same property: the timeout contribution no
    // longer scales with the page. This page pays ceil((E + WAVE - 1) / WAVE) = 2
    // waves and would pay ceil(12 / 4) = 3 without the breaker — and the gap only
    // widens with the page, which is the point: at the 500-row cap the breaker
    // still pays 2 waves and the unbroken drain pays 125.
    expect(elapsed).toBeLessThan(BOUND_MS * 3);

    // AND THE SKIPPED ROWS ARE NOT LOST. With the notifier healthy again the very
    // next sweep discharges the entire page — including every obligation this pass
    // deliberately declined to dispatch.
    const hostNotifier = await import("@/lib/agent-run-wait-notifications");
    setRunWaitNotifier(hostNotifier.runWaitNotifier satisfies RunWaitNotifier);
    const second = await parkStore.sweepParks({ limit: PAGE });
    expect(second.holdNotificationsCleared).toBe(PAGE);
    for (const r of runs) {
      expect(await parkState(r.parkId)).toMatchObject({ hold_notification: "cleared" });
      expect(await notificationRows(r.runId)).toHaveLength(0);
    }
  });

  it("the ABANDONED dispatch settling LATE is consumed: no unhandled rejection", async () => {
    await clearOutstandingObligations();
    const late = await heldRun();

    const hostNotifier = await import("@/lib/agent-run-wait-notifications");
    setRunWaitNotifier({
      ...hostNotifier.runWaitNotifier,
      // Settles long after the drain has walked away, and settles by REJECTING —
      // the shape that leaks when a losing promise is left with no handler on it.
      // (The shipped dispatcher turns this into a late `false`; what is pinned is
      // that the promise the drain abandoned is CONSUMED however it ends, and that
      // its late settle changes nothing it no longer owns.)
      onClearRecommendationHold: () =>
        new Promise<boolean>((_resolve, reject) => {
          setTimeout(() => reject(new Error("late port failure")), BOUND_MS * 3);
        }),
    } as RunWaitNotifier);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const swept = await parkStore.sweepParks({ releasedParkIds: [late.parkId], limit: 1 });
      expect(swept.holdNotificationsCleared).toBe(0);
      // Outlive the loser, then give the loop a full turn — Node reports an
      // unhandled rejection a tick AFTER the rejection nobody handled.
      await new Promise((r) => setTimeout(r, BOUND_MS * 5));
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
    // The late settle retires nothing: it lost, so it cannot ack an obligation the
    // drain already declined to ack, and the next sweep still owns the retry.
    expect(await parkState(late.parkId)).toMatchObject({ hold_notification: "live" });
    expect(await notificationRows(late.runId)).toHaveLength(1);
  });
});
