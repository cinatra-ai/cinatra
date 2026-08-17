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
    });

    const enter = new Client({ connectionString: DB_URL });
    const sweeper = new Client({ connectionString: DB_URL });
    await enter.connect();
    await sweeper.connect();
    try {
      // The enter opens its transaction and takes the park's row lock, exactly as
      // the fenced INSERT does.
      await enter.query("BEGIN");
      const guarded = await enter.query(fence.guard.text, fence.guard.values);
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
      const guard = enter.query(fence.guard.text, fence.guard.values).then((r) => {
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
});
