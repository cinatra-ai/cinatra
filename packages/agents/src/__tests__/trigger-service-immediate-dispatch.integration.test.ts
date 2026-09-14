/**
 * "Run now" actually runs (cinatra#2523 — owner ruling 2026-08-09, remedy (c)).
 *
 * The defect: `setRunTriggerForActor`'s immediate branch performed
 * `pending_input → queued`, CAUGHT the resulting `stale_from_status` when the
 * run was not in `pending_input`, and returned `{ok:true}` having dispatched
 * nothing. The existing unit suite could not see it because it STUBS
 * `transitionRunStatus` — a stub always "succeeds", so the swallow had nothing
 * to swallow (this issue's acceptance criterion 2 names that gap explicitly).
 *
 * So this suite runs the REAL `transitionRunStatus` against the REAL store tier:
 * a live Postgres row, the real legal-transition table, the real org-scoped CAS,
 * and the real `→queued` install-scope guard. Only the collaborators that are
 * neither the state machine nor the store are stubbed — the BullMQ schedule, the
 * recommendation hold, the PM mirror, the session-authority mint, and the
 * enqueue chokepoint (which is spied on precisely so "did a dispatch happen?"
 * is observable).
 *
 * What it pins:
 *   1. THE MAIN PATH. A setup-success run (`pending_trigger`, the hand-off
 *      execution.ts now performs) + an immediate trigger ⇒ the run really
 *      transitions to `queued` AND an execution job is really enqueued.
 *   2. ok:true ⟹ A DISPATCH HAPPENED. Every ok:true arm asserts the enqueue.
 *      No arm may report success with the queue untouched.
 *   3. ok:false ⟹ ACTIONABLE COPY, NO WRITE. A run that genuinely cannot be
 *      dispatched is refused by name, and its status is left exactly as found.
 *   4. FINALITY HOLDS EVERYWHERE ELSE. `completed` / `failed` / `stopped` are
 *      never resurrected — the cinatra#580 carve-out that used to let a
 *      `completed` run through is gone, because setup no longer ENDS there.
 *
 * DB-gated: skips when SUPABASE_DB_URL is unset (matches the sibling suites).
 *
 * Run:
 *   cd packages/agents && CINATRA_TEST_DB_URL=... pnpm test:integration \
 *     src/__tests__/trigger-service-immediate-dispatch.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !isPlaceholderDbUrl(dbUrl);
const q = (s: string) => s.replaceAll('"', '""');

const ORG_ID = "org-2523";
const RUN_OWNER = "user-2523";
const MEMBER_ROW_ID = `m-2523-${ORG_ID}`;

// ---------------------------------------------------------------------------
// Stubs — everything EXCEPT the state machine and the store.
// ---------------------------------------------------------------------------
const enqueue = vi.hoisted(() => ({
  enqueueAgentRun: vi.fn(async () => ({ runId: "", jobId: "", status: "queued" as const })),
  enqueueDepsForTemplate: vi.fn(() => ({})),
}));
const schedule = vi.hoisted(() => ({
  // The immediate arm's real `scheduleTrigger` only marks the Redis gate
  // released; stubbing it keeps the suite Postgres-only.
  scheduleTrigger: vi.fn(async () => ({ jobSchedulerId: null })),
  cancelTriggerSchedule: vi.fn(async () => undefined),
}));

vi.mock("@/lib/agent-run-enqueue", () => enqueue);
vi.mock("../trigger-schedule", () => schedule);
vi.mock("../recommendation-hold", () => ({
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false, reason: "headless" })),
}));
vi.mock("@/lib/pm-integration-providers", () => ({
  syncRunTriggerPmTask: vi.fn(async () => undefined),
  deleteRunTriggerPmTask: vi.fn(async () => undefined),
}));
vi.mock("@/lib/org-write/authority", () => ({
  // A member-shaped authority for the run's org — the same shape the sibling
  // integration suites hand to the guarded store writers.
  verifySessionAuthority: vi.fn(async (_userId: string, orgId: string) => ({
    orgId,
    can: () => true,
  })),
}));

const actor = { userId: RUN_OWNER, source: "ui" as const };

let templateId = "";

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Create a run and force it into `status` (fixture write, not a transition). */
async function makeRunInStatus(status: string): Promise<string> {
  const { createAgentRun } = await import("../store");
  const runId = `r_2523_${randomUUID()}`;
  await createAgentRun(
    { id: runId, templateId, inputParams: {}, orgId: ORG_ID, runBy: RUN_OWNER },
    { orgId: ORG_ID, can: () => true },
  );
  await withClient((c) =>
    c.query(`UPDATE "${q(SCHEMA)}"."agent_runs" SET status = $1 WHERE id = $2`, [status, runId]),
  );
  return runId;
}

async function statusOf(runId: string): Promise<string> {
  return withClient(async (c) => {
    const res = await c.query(`SELECT status FROM "${q(SCHEMA)}"."agent_runs" WHERE id = $1`, [runId]);
    return res.rows[0]?.status as string;
  });
}

beforeAll(async () => {
  if (!hasDb) return;
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
      [ORG_ID, ORG_ID, ORG_ID],
    );
    await c.query(
      `INSERT INTO public."user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $1, $2, false, now(), now()) ON CONFLICT (id) DO NOTHING`,
      [RUN_OWNER, `${RUN_OWNER}@dispatch.test`],
    );
    await c.query(
      `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt")
       VALUES ($1, $2, $3, 'owner', now()) ON CONFLICT (id) DO NOTHING`,
      [MEMBER_ROW_ID, ORG_ID, RUN_OWNER],
    );
  });
  // cinatra#2485 C — the template's INSTALL SCOPE authorizes the run, so the
  // fixture agent is installed in ORG_ID (`createAgentTemplate` stamps
  // owner_level='organization' / owner_id=orgId from this anchor). Without it
  // every `→queued` transition is refused `unknown_scope`.
  const { createAgentTemplate } = await import("../store");
  templateId = `t_2523_${randomUUID()}`;
  await createAgentTemplate({
    id: templateId,
    name: `dispatch-2523-${randomUUID().slice(0, 8)}`,
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
    orgId: ORG_ID,
  });
}, 60_000);

afterAll(async () => {
  if (!hasDb) return;
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM "${q(SCHEMA)}"."agent_run_triggers" WHERE run_id IN (SELECT id FROM "${q(SCHEMA)}"."agent_runs" WHERE org_id = $1)`,
      [ORG_ID],
    );
    await c.query(`DELETE FROM "${q(SCHEMA)}"."agent_runs" WHERE org_id = $1`, [ORG_ID]);
    await c.query(`DELETE FROM "${q(SCHEMA)}"."agent_templates" WHERE id = $1`, [templateId]);
    await c.query(`DELETE FROM public."member" WHERE id = $1`, [MEMBER_ROW_ID]);
    await c.query(`DELETE FROM public."user" WHERE id = $1`, [RUN_OWNER]);
    await c.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG_ID]);
  });
}, 60_000);

beforeEach(() => {
  enqueue.enqueueAgentRun.mockClear();
  schedule.scheduleTrigger.mockClear();
});

describe.skipIf(!hasDb)("setRunTriggerForActor — immediate dispatch (cinatra#2523)", () => {
  // -------------------------------------------------------------------------
  // 1. The documented main path, end to end.
  // -------------------------------------------------------------------------
  it("dispatches a setup-success run: pending_trigger → queued AND an execution job is enqueued", async () => {
    const { setRunTriggerForActor } = await import("../trigger-service");
    const runId = await makeRunInStatus("pending_trigger");

    const result = await setRunTriggerForActor(actor, { runId, triggerType: "immediate" });

    expect(result.ok).toBe(true);
    // The run really moved — this is the assertion the stubbed suite could not make.
    expect(await statusOf(runId)).toBe("queued");
    // ok:true ⟹ a dispatch happened. Before cinatra#2523 the immediate branch
    // never enqueued at all: it transitioned and stopped, and the run only ran
    // if some other job happened to be parked on the trigger gate.
    expect(enqueue.enqueueAgentRun).toHaveBeenCalledTimes(1);
    expect((enqueue.enqueueAgentRun.mock.calls[0] as unknown as unknown[])[0]).toEqual({ runId });
  });

  it("dispatches a pending_input run the same way (created-but-never-dispatched)", async () => {
    const { setRunTriggerForActor } = await import("../trigger-service");
    const runId = await makeRunInStatus("pending_input");

    const result = await setRunTriggerForActor(actor, { runId, triggerType: "immediate" });

    expect(result.ok).toBe(true);
    expect(await statusOf(runId)).toBe("queued");
    expect(enqueue.enqueueAgentRun).toHaveBeenCalledTimes(1);
  });

  it("dispatches an armed run re-configured to run now (its old schedule was just cancelled)", async () => {
    const { setRunTriggerForActor } = await import("../trigger-service");
    const runId = await makeRunInStatus("armed");

    const result = await setRunTriggerForActor(actor, { runId, triggerType: "immediate" });

    expect(result.ok).toBe(true);
    expect(await statusOf(runId)).toBe("queued");
    expect(enqueue.enqueueAgentRun).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 2. No path returns ok:true having dispatched nothing.
  // -------------------------------------------------------------------------
  it("refuses — with actionable copy — a run whose real status has no dispatch edge, and writes nothing", async () => {
    const { setRunTriggerForActor } = await import("../trigger-service");
    // `pending_approval` is a genuine, still-reachable state: the user is mid
    // setup form. The real CAS refuses BOTH ladder rungs, which is exactly the
    // shape that used to be swallowed into ok:true.
    const runId = await makeRunInStatus("pending_approval");

    const result = await setRunTriggerForActor(actor, { runId, triggerType: "immediate" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/setup form/i);
    expect(await statusOf(runId)).toBe("pending_approval");
    expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. Finality holds everywhere else — the #580 carve-out is gone.
  // -------------------------------------------------------------------------
  it.each(["completed", "failed", "stopped"])(
    "never resurrects a %s run — refused before any write, no trigger row, no dispatch",
    async (status) => {
      const { setRunTriggerForActor } = await import("../trigger-service");
      const { readRunTriggerByRunId } = await import("../trigger-store");
      const runId = await makeRunInStatus(status);

      const result = await setRunTriggerForActor(actor, { runId, triggerType: "immediate" });

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/already finished/i);
      expect(await statusOf(runId)).toBe(status);
      // The carve-out this issue removed let a `completed` run with NO trigger
      // row through — so the "no row" case is the one that must now refuse too.
      expect(await readRunTriggerByRunId(runId)).toBeNull();
      expect(schedule.scheduleTrigger).not.toHaveBeenCalled();
      expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
    },
  );

  // -------------------------------------------------------------------------
  // 4. The scheduled sibling of the hand-off: `pending_trigger → armed` was a
  //    declared-but-unreachable edge until setup started producing the state.
  // -------------------------------------------------------------------------
  it("arms a setup-success run for a scheduled trigger: pending_trigger → armed", async () => {
    const { setRunTriggerForActor } = await import("../trigger-service");
    const runId = await makeRunInStatus("pending_trigger");
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16);

    const result = await setRunTriggerForActor(actor, {
      runId,
      triggerType: "scheduled",
      scheduledAt,
      timezone: "UTC",
    });

    expect(result.ok).toBe(true);
    expect(await statusOf(runId)).toBe("armed");
    // A future fire is not a dispatch — the release job owns that.
    expect(enqueue.enqueueAgentRun).not.toHaveBeenCalled();
  });
});
