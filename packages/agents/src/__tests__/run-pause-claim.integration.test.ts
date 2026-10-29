/**
 * cinatra#4245 (A2), DB tier: the pause claim against a real Postgres.
 *
 * The claim module (claimPause, fencePauseInPlace, releasePauseClaim,
 * settlePauseSend) and the claim rules of the status seam, on a throwaway
 * schema replayed from the store bootstrap, with the core__0116 CHECKs in
 * place, so every write here also passes the shape CHECK:
 *   - a claim at the generation read; the four refusals; the lease measured on
 *     the database clock;
 *   - an expired lease is taken over, and the old holder's release is `lost`;
 *   - two claims at once: exactly one wins;
 *   - the fence (status seam and in place), and a fence with a stale token;
 *   - no stop under a live send (pause_resume_in_flight); the stop lands after
 *     the settle or after the send lease expired;
 *   - an entry into pending_approval raises the generation and clears a claim;
 *   - the change-request end mark gates a stop at its generation;
 *   - the setup resume is refused under a live claim.
 *
 * Red at 675c2bfc: ../run-pause-claim does not exist and the status seam has no
 * claim rules.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. With
 * X4245_PAUSE_CLAIM_REALDB=1 a missing database throws instead of skipping.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

vi.mock("@cinatra-ai/a2a", async (orig) => {
  const actual = await orig<typeof import("@cinatra-ai/a2a")>();
  return { ...actual, expireRunStream: vi.fn(async () => undefined) };
});
vi.mock("../run-wait-notifier", async (orig) => {
  const actual = await orig<typeof import("../run-wait-notifier")>();
  return { ...actual, dispatchRunWaitTransition: vi.fn(async () => undefined) };
});

const TEST_SCHEMA = `cinatra_test_pause_claim_4245_${process.pid}`;
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
if (process.env.X4245_PAUSE_CLAIM_REALDB === "1" && !HAS_DB) {
  throw new Error("the #4245 pause claim DB tier needs a live Postgres in SUPABASE_DB_URL; refusing to skip");
}
const q = (s: string) => s.replaceAll('"', '""');
const T = () => `"${q(TEST_SCHEMA)}"."agent_runs"`;
const ORG = "org-4245-a2";
const USER = "user-4245-a2";
const SESSION = { orgId: ORG, can: () => true };

let claims: typeof import("../run-pause-claim");
let store: typeof import("../store");
let setup: typeof import("../resume-run-from-setup-approval");
let dbMod: typeof import("../db");

async function pool(text: string, values: unknown[] = []) {
  return dbMod.agentBuilderPool.query(text, values);
}

async function seedRun(status: string, generation = 0): Promise<string> {
  const id = `run-${randomUUID()}`;
  await pool(
    `INSERT INTO ${T()} (id, template_id, org_id, status, input_params, run_by, pause_generation)
     VALUES ($1, $2, $3, $4, '{}', $5, $6)`,
    [id, `tpl-${randomUUID()}`, ORG, status, USER, generation],
  );
  return id;
}

type Row = {
  status: string;
  generation: number;
  token: string | null;
  phase: string | null;
  task: string | null;
  /** Seconds from the database's now() to the expiry; null without one. */
  left: number | null;
};

async function read(id: string): Promise<Row> {
  const { rows } = await pool(
    `SELECT status, pause_generation::int AS generation, pause_claim_token AS token,
            pause_claim_phase AS phase, a2a_task_id AS task,
            EXTRACT(EPOCH FROM (pause_claim_expires_at - now()))::float8 AS left
       FROM ${T()} WHERE id = $1`,
    [id],
  );
  return rows[0] as Row;
}

/** Put a claim on the row by hand (the shapes a dead or later holder leaves). */
async function setClaim(id: string, token: string | null, phase: string | null, secondsLeft: number | null) {
  await pool(
    `UPDATE ${T()} SET pause_claim_token = $2, pause_claim_phase = $3,
       pause_claim_expires_at = CASE WHEN $4::float8 IS NULL THEN NULL ELSE now() + make_interval(secs => $4::float8) END
     WHERE id = $1`,
    [id, token, phase, secondsLeft],
  );
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    const { replayStoreSchema } = await import("@/lib/test-support/store-schema-replay");
    await replayStoreSchema(admin, buildCreateStoreSchemaQueries(TEST_SCHEMA), { additionalHeads: ["DO $$ "] });
    // The core__0116 CHECKs are anonymous blocks whose text starts "DO $$\n",
    // a head the replay does not take: apply the leaf itself (it is idempotent).
    const { agentRunPauseClaimSchemaQueries } = await import("@/lib/agent-run-created-at-schema");
    for (const s of agentRunPauseClaimSchemaQueries(TEST_SCHEMA)) await admin.query(s.text);
    await admin.query(
      `INSERT INTO public."organization" (id, name, slug, "createdAt")
       VALUES ($1, $1, $1, now()) ON CONFLICT (id) DO NOTHING`,
      [ORG],
    );
  } finally {
    await admin.end().catch(() => {});
  }
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;
  dbMod = await import("../db");
  claims = await import("../run-pause-claim");
  store = await import("../store");
  setup = await import("../resume-run-from-setup-approval");
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

describe.skipIf(!HAS_DB)("cinatra#4245 the pause claim (real database)", () => {
  it("the throwaway schema carries both core__0116 CHECKs", async () => {
    const { rows } = await pool(
      `SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relname = 'agent_runs' AND c.conname LIKE 'agent_runs_pause_claim_%'
        ORDER BY c.conname`,
      [TEST_SCHEMA],
    );
    expect(rows.map((r: { conname: string }) => r.conname)).toEqual([
      "agent_runs_pause_claim_phase_chk",
      "agent_runs_pause_claim_shape_chk",
    ]);
  });

  it("claims a pending run at the generation read, for two minutes on the database clock", async () => {
    const id = await seedRun("pending_approval", 3);
    const got = await claims.claimPause({ runId: id, orgId: ORG, generation: 3 }, SESSION, { token: "tok-a" });
    expect(got).toMatchObject({ kind: "claimed", token: "tok-a", generation: 3 });
    const row = await read(id);
    expect(row).toMatchObject({ status: "pending_approval", generation: 3, token: "tok-a", phase: "claimed" });
    expect(row.left).toBeGreaterThan(110);
    expect(row.left).toBeLessThanOrEqual(120);
  });

  it("names each refusal and writes nothing", async () => {
    const held = await seedRun("pending_approval", 1);
    await claims.claimPause({ runId: held, orgId: ORG, generation: 1 }, SESSION, { token: "tok-1" });
    expect(await claims.claimPause({ runId: held, orgId: ORG, generation: 1 }, SESSION, { token: "tok-2" })).toEqual({
      kind: "refused",
      reason: "held",
      status: "pending_approval",
      generation: 1,
    });
    expect((await read(held)).token).toBe("tok-1");

    const moved = await seedRun("pending_approval", 5);
    expect(await claims.claimPause({ runId: moved, orgId: ORG, generation: 4 }, SESSION)).toMatchObject({
      kind: "refused",
      reason: "moved-on",
      generation: 5,
    });

    const running = await seedRun("running", 2);
    expect(await claims.claimPause({ runId: running, orgId: ORG, generation: 2 }, SESSION)).toMatchObject({
      kind: "refused",
      reason: "not-pending",
      status: "running",
    });

    expect(await claims.claimPause({ runId: `run-${randomUUID()}`, orgId: ORG, generation: 0 }, SESSION)).toEqual({
      kind: "refused",
      reason: "not-pending",
      status: "absent",
      generation: null,
    });

    const ended = await seedRun("pending_approval", 2);
    await setClaim(ended, "tok-cr", "changes_requested", null);
    expect(await claims.claimPause({ runId: ended, orgId: ORG, generation: 2 }, SESSION)).toMatchObject({
      kind: "refused",
      reason: "changes-requested",
    });
    expect(await read(ended)).toMatchObject({ token: "tok-cr", phase: "changes_requested", left: null });
  });

  it("takes over an expired lease; the old holder's release is lost", async () => {
    for (const phase of ["claimed", "sending"] as const) {
      const id = await seedRun("pending_approval", 2);
      await setClaim(id, "tok-dead", phase, -1);
      const got = await claims.claimPause({ runId: id, orgId: ORG, generation: 2 }, SESSION, { token: "tok-new" });
      expect(got).toMatchObject({ kind: "claimed", token: "tok-new" });
      expect(await claims.releasePauseClaim({ runId: id, orgId: ORG, token: "tok-dead" }, SESSION)).toBe("lost");
      expect(await read(id)).toMatchObject({ token: "tok-new", phase: "claimed" });
    }
  });

  it("two claims at once: exactly one wins", async () => {
    for (let i = 0; i < 5; i += 1) {
      const id = await seedRun("pending_approval", 0);
      const results = await Promise.all(
        ["tok-x", "tok-y"].map((token) => claims.claimPause({ runId: id, orgId: ORG, generation: 0 }, SESSION, { token })),
      );
      const won = results.filter((r) => r.kind === "claimed");
      expect(won).toHaveLength(1);
      expect(results.find((r) => r.kind === "refused")).toMatchObject({ reason: "held" });
      expect((await read(id)).token).toBe((won[0] as { token: string }).token);
    }
  });

  it("release gives back a claimed lease once; settle answers already-cleared on a claimed one", async () => {
    const id = await seedRun("pending_approval", 0);
    await claims.claimPause({ runId: id, orgId: ORG, generation: 0 }, SESSION, { token: "tok-r" });
    expect(await claims.settlePauseSend({ runId: id, orgId: ORG, token: "tok-r" }, SESSION)).toBe("already-cleared");
    expect(await claims.releasePauseClaim({ runId: id, orgId: ORG, token: "tok-r" }, SESSION)).toBe("released");
    expect(await claims.releasePauseClaim({ runId: id, orgId: ORG, token: "tok-r" }, SESSION)).toBe("lost");
    expect(await read(id)).toMatchObject({ token: null, phase: null, left: null, generation: 0 });
  });

  it("the status seam's fence: pending_approval → running under the live claim", async () => {
    const id = await seedRun("pending_approval", 4);
    await claims.claimPause({ runId: id, orgId: ORG, generation: 4 }, SESSION, { token: "tok-f" });

    await expect(
      store.transitionRunStatus(id, "pending_approval", "running", { pauseFence: { token: "tok-other", generation: 4 } }, SESSION),
    ).rejects.toMatchObject({ code: "stale_from_status" });
    await expect(
      store.transitionRunStatus(id, "pending_approval", "running", { pauseFence: { token: "tok-f", generation: 3 } }, SESSION),
    ).rejects.toMatchObject({ code: "stale_from_status" });
    expect(await read(id)).toMatchObject({ status: "pending_approval", generation: 4, phase: "claimed" });

    await store.transitionRunStatus(id, "pending_approval", "running", { pauseFence: { token: "tok-f", generation: 4 } }, SESSION);
    const row = await read(id);
    expect(row).toMatchObject({ status: "running", generation: 5, token: "tok-f", phase: "sending" });
    expect(row.left).toBeGreaterThan(claims.PAUSE_SEND_LEASE_SECONDS - 10);
    expect(row.left).toBeLessThanOrEqual(claims.PAUSE_SEND_LEASE_SECONDS);
  });

  it("a fence of an expired claim is lost", async () => {
    const id = await seedRun("pending_approval", 1);
    await setClaim(id, "tok-late", "claimed", -1);
    await expect(
      store.transitionRunStatus(id, "pending_approval", "running", { pauseFence: { token: "tok-late", generation: 1 } }, SESSION),
    ).rejects.toMatchObject({ code: "stale_from_status" });
    expect(
      await claims.fencePauseInPlace({ runId: id, orgId: ORG, generation: 1, token: "tok-late" }, SESSION),
    ).toBe("lost");
  });

  it("the fence in place keeps the run pending_approval and fences once", async () => {
    const id = await seedRun("pending_approval", 7);
    await claims.claimPause({ runId: id, orgId: ORG, generation: 7 }, SESSION, { token: "tok-d" });
    const ref = { runId: id, orgId: ORG, generation: 7, token: "tok-d" };
    expect(await claims.fencePauseInPlace(ref, SESSION)).toBe("fenced");
    expect(await read(id)).toMatchObject({ status: "pending_approval", generation: 8, token: "tok-d", phase: "sending" });
    expect(await claims.fencePauseInPlace(ref, SESSION)).toBe("lost");
    // The fenced pause is not free: a claim at the new generation is held.
    expect(await claims.claimPause({ runId: id, orgId: ORG, generation: 8 }, SESSION)).toMatchObject({
      kind: "refused",
      reason: "held",
    });
    expect(await claims.settlePauseSend({ runId: id, orgId: ORG, token: "tok-d" }, SESSION)).toBe("settled");
    expect(await read(id)).toMatchObject({ status: "pending_approval", generation: 8, token: null, phase: null });
  });

  it("no stop under a live send; the stop lands after the settle", async () => {
    const id = await seedRun("pending_approval", 0);
    await claims.claimPause({ runId: id, orgId: ORG, generation: 0 }, SESSION, { token: "tok-s" });
    expect(await claims.fencePauseInPlace({ runId: id, orgId: ORG, generation: 0, token: "tok-s" }, SESSION)).toBe("fenced");
    await expect(store.transitionRunStatus(id, "pending_approval", "stopped", undefined, SESSION)).rejects.toMatchObject({
      name: "RunTransitionError",
      code: "pause_resume_in_flight",
    });
    expect(await read(id)).toMatchObject({ status: "pending_approval", phase: "sending" });
    await claims.settlePauseSend({ runId: id, orgId: ORG, token: "tok-s" }, SESSION);
    await store.transitionRunStatus(id, "pending_approval", "stopped", undefined, SESSION);
    expect(await read(id)).toMatchObject({ status: "stopped", token: null, phase: null });
  });

  it("a stop lands under an expired send lease and under a claimed one, and clears it", async () => {
    const expired = await seedRun("running", 2);
    await setClaim(expired, "tok-gone", "sending", -1);
    await store.transitionRunStatus(expired, "running", "stopped", undefined, SESSION);
    expect(await read(expired)).toMatchObject({ status: "stopped", token: null, phase: null, left: null });

    const claimed = await seedRun("pending_approval", 2);
    await claims.claimPause({ runId: claimed, orgId: ORG, generation: 2 }, SESSION, { token: "tok-c" });
    await store.transitionRunStatus(claimed, "pending_approval", "stopped", undefined, SESSION);
    expect(await read(claimed)).toMatchObject({ status: "stopped", token: null, phase: null });
    expect(await claims.releasePauseClaim({ runId: claimed, orgId: ORG, token: "tok-c" }, SESSION)).toBe("lost");
  });

  it("an entry into pending_approval raises the generation, clears a claim and writes the task", async () => {
    const id = await seedRun("running", 5);
    await setClaim(id, "tok-old", "sending", 600);
    await store.transitionRunStatus(id, "running", "pending_approval", { pauseTaskId: "task-4245" }, SESSION);
    expect(await read(id)).toMatchObject({
      status: "pending_approval",
      generation: 6,
      token: null,
      phase: null,
      left: null,
      task: "task-4245",
    });
    expect(await claims.settlePauseSend({ runId: id, orgId: ORG, token: "tok-old" }, SESSION)).toBe("already-cleared");
  });

  it("the end mark gates a stop at its generation", async () => {
    const id = await seedRun("pending_approval", 3);
    await setClaim(id, "tok-cr", "changes_requested", null);
    await expect(
      store.transitionRunStatus(id, "pending_approval", "stopped", { pauseEndMark: { generation: 2 } }, SESSION),
    ).rejects.toMatchObject({ code: "stale_from_status" });
    await store.transitionRunStatus(id, "pending_approval", "stopped", { pauseEndMark: { generation: 3 } }, SESSION);
    expect(await read(id)).toMatchObject({ status: "stopped", token: null, phase: null });

    const unmarked = await seedRun("pending_approval", 3);
    await expect(
      store.transitionRunStatus(unmarked, "pending_approval", "stopped", { pauseEndMark: { generation: 3 } }, SESSION),
    ).rejects.toMatchObject({ code: "stale_from_status" });
  });

  it("the setup resume is refused under a live claim and clears an expired one", async () => {
    const live = await seedRun("pending_approval", 0);
    await claims.claimPause({ runId: live, orgId: ORG, generation: 0 }, SESSION, { token: "tok-l" });
    await expect(setup.resumeRunFromSetupApproval(live, null, SESSION)).rejects.toMatchObject({
      code: "stale_from_status",
    });
    expect(await read(live)).toMatchObject({ status: "pending_approval", token: "tok-l" });

    const marked = await seedRun("pending_approval", 0);
    await setClaim(marked, "tok-cr", "changes_requested", null);
    await expect(setup.resumeRunFromSetupApproval(marked, null, SESSION)).rejects.toMatchObject({
      code: "stale_from_status",
    });

    const expired = await seedRun("pending_approval", 0);
    await setClaim(expired, "tok-x", "claimed", -1);
    await setup.resumeRunFromSetupApproval(expired, null, SESSION);
    expect(await read(expired)).toMatchObject({ status: "queued", token: null, phase: null, left: null });
  });
});
