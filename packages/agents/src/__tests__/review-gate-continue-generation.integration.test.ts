/**
 * cinatra#4245 change B — the review page's Continue under the pause claim (spec 4.4,
 * 5.3; tests C1-C3; spec-rev1 MF2 and MF3). REAL store for the run, the claim and
 * the seam.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import { GateNotPendingError } from "../run-status";

type Gate = { reached: Promise<void>; arrive: () => void; open: () => void; wait: Promise<void> };
const ctl = vi.hoisted(() => ({
  role: null as null | Gate,
  mint: null as null | Gate,
  latest: null as null | string,
  reverse: null as null | string,
  failBack: false,
}));
function gate(): Gate {
  let arrive!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((r) => { arrive = r; });
  const wait = new Promise<void>((r) => { open = r; });
  return { reached, arrive, open, wait };
}
const pass = vi.hoisted(() => async (slot: "role" | "mint") => {
  const g = ctl[slot];
  if (!g) return;
  ctl[slot] = null;
  g.arrive();
  await g.wait;
});

vi.mock("@/lib/auth-session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth-session")>()),
  getAuthSession: vi.fn(async () => null),
  isPlatformAdmin: vi.fn(() => false),
  resolveOrgRoleForUser: vi.fn(async () => {
    await pass("role");
    return "member";
  }),
}));
vi.mock("../auth-policy", async (orig) => ({
  ...(await orig<typeof import("../auth-policy")>()),
  enforceRunAccess: vi.fn(async () => undefined),
}));
vi.mock("../agent-run-serde", async (orig) => ({
  ...(await orig<typeof import("../agent-run-serde")>()),
  assertAgentRunScopeAuthorized: vi.fn(async () => undefined),
  assertAgentRunDispatchAuthorized: vi.fn(async () => undefined),
}));
vi.mock("../store", async (orig) => {
  const actual = await orig<typeof import("../store")>();
  return {
    ...actual,
    // `failBack` fails only the edge that puts a gate back (running → pending_approval).
    transitionRunStatus: vi.fn(async (...args: Parameters<typeof actual.transitionRunStatus>) => {
      if (ctl.failBack && args[1] === "running" && args[2] === "pending_approval") throw new Error("db blip");
      return actual.transitionRunStatus(...args);
    }),
    readRunCoOwners: vi.fn(async () => []),
    readAgentTemplateById: vi.fn(async () => ({
      id: "tmpl-cont",
      packageName: "@cinatra-ai/cont-agent",
      sourceType: "internal",
      agentAuthPolicy: null,
    })),
  };
});
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  createWayflowFetch: vi.fn(() => globalThis.fetch),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));
const mint = vi.hoisted(() =>
  vi.fn(async () => {
    await pass("mint");
    return {};
  }),
);
vi.mock("../wayflow-run-token-carrier", () => ({ mintResumeRunTokenMetadata: mint }));
const sendTask = vi.hoisted(() =>
  vi.fn(async (req: { message: { contextId: string } }) => ({ id: `t2-${randomUUID()}`, contextId: req.message.contextId, status: { state: "input-required" } }) as unknown),
);
vi.mock("../../../a2a/src/external-client", () => ({
  createExternalA2AClient: vi.fn(async () => ({ sendTask })),
}));
vi.mock("../../../a2a/src/event-log", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveRunIdByWayflowTaskId: vi.fn(async () => ctl.reverse),
  resolveLatestWayflowGateTaskId: vi.fn(async () => {
    if (ctl.latest === "throw") throw new Error("redis is down");
    return ctl.latest;
  }),
  rememberLatestWayflowGateTask: vi.fn(async () => undefined),
  rememberAnsweredGateSubmission: vi.fn(async () => undefined),
}));
// The run re-parks at the next task through the real seam.
const handle = vi.hoisted(() => vi.fn());
vi.mock("../execution", async (orig) => ({
  ...(await orig<typeof import("../execution")>()),
  handleWayflowTaskState: handle,
}));
vi.mock("../resume-run-from-setup-approval", () => ({ resumeRunFromSetupApproval: vi.fn(async () => undefined) }));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent-builder-execution" },
}));

const TEST_SCHEMA = "cinatra_test_continue_gen_4245";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const RUNS = `"${q(TEST_SCHEMA)}"."agent_runs"`;
const ORG = "org-4245-continue";
const SESSION = { orgId: ORG, can: () => true } as never;

let dbMod: typeof import("../db");
let store: typeof import("../store");
const pool = (text: string, values: unknown[] = []) => dbMod.agentBuilderPool.query(text, values);

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  const { replayStoreSchema } = await import("@/lib/test-support/store-schema-replay");
  await replayStoreSchema(admin, buildCreateStoreSchemaQueries(TEST_SCHEMA));
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;
  dbMod = await import("../db");
  store = await import("../store");
  await pool(`INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $1, $1, now()) ON CONFLICT (id) DO NOTHING`, [ORG]);
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

beforeEach(() => {
  vi.clearAllMocks();
  ctl.role = ctl.mint = null;
  ctl.latest = ctl.reverse = null;
  ctl.failBack = false;
  handle.mockImplementation(async ({ runId, task }: { runId: string; task: { id: string } }) => {
    await store.updateAgentRunA2ATaskId(runId, task.id);
    await store.transitionRunStatus(runId, "running", "pending_approval", { pauseTaskId: task.id }, SESSION);
  });
});

async function seed() {
  const runId = `run-cont-${randomUUID()}`;
  const templateId = `tmpl-${randomUUID()}`;
  const task = randomUUID();
  await pool(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates" (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name)
     VALUES ($1,$2,'organization',$2,'seed','seed','[]','{}','{}',$3)`,
    [templateId, ORG, `@cinatra-ai/seed-${templateId}`],
  );
  await pool(
    `INSERT INTO ${RUNS} (id, template_id, org_id, input_params, status, a2a_task_id, a2a_context_id, run_by)
     VALUES ($1,$2,$3,'{}','pending_approval',$4,$5,'user-a')`,
    [runId, templateId, ORG, task, `ctx-${task}`],
  );
  return { runId, task, gate: `wayflow-${task}` };
}
async function answer(reviewTaskId: string, userResponse?: string) {
  const { approveReviewTaskInternal } = await import("../review-task-actions");
  return approveReviewTaskInternal(reviewTaskId, "user-a", userResponse === undefined ? undefined : { userResponse });
}
const promptRows = async (id: string) =>
  Number((await pool(`SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."agent_run_hitl_prompts" WHERE run_id=$1`, [id])).rows[0].n);
const redis = async () => import("../../../a2a/src/event-log") as unknown as Promise<{
  rememberAnsweredGateSubmission: ReturnType<typeof vi.fn>;
  rememberLatestWayflowGateTask: ReturnType<typeof vi.fn>;
}>;
const refused = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(GateNotPendingError);
  return e as GateNotPendingError;
};
const statusOf = async (id: string) => (await pool(`SELECT status FROM ${RUNS} WHERE id=$1`, [id])).rows[0].status as string;

describe.skipIf(!HAS_DB)("cinatra#4245 change B — Continue under the pause claim (real store)", () => {
  it("C1: a stalled answer to T1 cannot act on T2, the pause another answer led to", async () => {
    const s = await seed();
    const held = (ctl.role = gate());
    const a = answer(s.gate);
    await held.reached;
    await answer(s.gate); // Answer B sends, and the run parks at t2.
    expect(sendTask).toHaveBeenCalledTimes(1);
    expect(await statusOf(s.runId)).toBe("pending_approval");
    held.open();
    await refused(a);
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("C2: an answer to T1 of a run now at T2, found through the reverse map, is refused", async () => {
    const s = await seed();
    const t2 = randomUUID();
    await pool(`UPDATE ${RUNS} SET a2a_task_id=$2 WHERE id=$1`, [s.runId, t2]);
    ctl.reverse = s.runId;
    ctl.latest = t2;
    await refused(answer(s.gate));
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("C2 variants: no latest task or a Redis error refuses; the latest task itself is answered", async () => {
    const s = await seed();
    await pool(`UPDATE ${RUNS} SET a2a_task_id=$2 WHERE id=$1`, [s.runId, randomUUID()]);
    ctl.reverse = s.runId;
    ctl.latest = null;
    await refused(answer(s.gate));
    ctl.latest = "throw";
    await refused(answer(s.gate));
    expect(sendTask).not.toHaveBeenCalled();
    ctl.latest = s.task;
    await answer(s.gate);
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("C3: a stop between the claim and the fence: refused as stopped, nothing sent", async () => {
    const s = await seed();
    const held = (ctl.mint = gate());
    const a = answer(s.gate);
    await held.reached;
    await store.transitionRunStatus(s.runId, "pending_approval", "stopped", undefined, SESSION);
    held.open();
    expect((await refused(a)).currentStatus).toBe("stopped");
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("a second answer while the first holds the claim is refused as running (the #3423 reading)", async () => {
    const s = await seed();
    const held = (ctl.mint = gate());
    const a = answer(s.gate);
    await held.reached;
    expect((await refused(answer(s.gate))).currentStatus).toBe("running");
    held.open();
    await a;
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("a step that fails before the send gives the claim back; a send that fails settles it", async () => {
    const s = await seed();
    mint.mockRejectedValueOnce(new Error("no carrier"));
    await expect(answer(s.gate)).rejects.toThrow("no carrier");
    expect(await statusOf(s.runId)).toBe("pending_approval");
    sendTask.mockRejectedValueOnce(new Error("wire down"));
    await expect(answer(s.gate)).rejects.toThrow("wire down");
    expect(await statusOf(s.runId)).toBe("running");
    await store.transitionRunStatus(s.runId, "running", "stopped", undefined, SESSION);
    expect(await statusOf(s.runId)).toBe("stopped");
  });

  it("spec-rev1 MF2: found by the column, a latest task that names another task refuses", async () => {
    const s = await seed();
    ctl.latest = randomUUID();
    await refused(answer(s.gate));
    expect(sendTask).not.toHaveBeenCalled();
    expect(await statusOf(s.runId)).toBe("pending_approval");
  });

  it("spec-rev1 MF2 guard: found by the column, no latest task or a Redis error keeps the column's word", async () => {
    const s = await seed();
    ctl.latest = "throw";
    await answer(s.gate);
    expect(sendTask).toHaveBeenCalledTimes(1);
    const t = await seed();
    ctl.latest = null;
    await answer(t.gate);
    expect(sendTask).toHaveBeenCalledTimes(2);
  });

  it("spec-rev1 MF3: an abandoned answer writes no answered-gate record, no latest task and no prompt row", async () => {
    const s = await seed();
    const held = (ctl.mint = gate());
    const a = answer(s.gate, JSON.stringify({ pick: "abandoned" }));
    await held.reached;
    await pool(`UPDATE ${RUNS} SET pause_claim_expires_at = now() - interval '1 second' WHERE id=$1`, [s.runId]);
    const live = JSON.stringify({ pick: "live" });
    await answer(s.gate, live);
    held.open();
    await refused(a);
    expect(sendTask).toHaveBeenCalledTimes(1);
    const r = await redis();
    expect(r.rememberAnsweredGateSubmission.mock.calls).toEqual([[s.runId, s.task, live]]);
    expect(r.rememberLatestWayflowGateTask.mock.calls).toEqual([[s.runId, s.task]]);
    expect(await promptRows(s.runId)).toBe(1);
  });

  it("spec-rev1 MF3: a Redis failure after the fence puts the gate back; nothing is sent or recorded", async () => {
    const s = await seed();
    const r = await redis();
    r.rememberAnsweredGateSubmission.mockRejectedValueOnce(new Error("redis is down"));
    await expect(answer(s.gate, JSON.stringify({ pick: "one" }))).rejects.toThrow("redis is down");
    expect(sendTask).not.toHaveBeenCalled();
    expect(await statusOf(s.runId)).toBe("pending_approval");
    const back = (await pool(`SELECT a2a_task_id, pause_claim_token FROM ${RUNS} WHERE id=$1`, [s.runId])).rows[0];
    expect(back).toEqual({ a2a_task_id: s.task, pause_claim_token: null });
    expect(await promptRows(s.runId)).toBe(0);
    await answer(s.gate, JSON.stringify({ pick: "two" }));
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("a Redis failure and a failed put-back: the error says both, nothing was sent", async () => {
    const s = await seed();
    const r = await redis();
    r.rememberAnsweredGateSubmission.mockRejectedValueOnce(new Error("redis is down"));
    ctl.failBack = true;
    const e = await answer(s.gate, JSON.stringify({ pick: "one" })).then(() => null, (err: unknown) => err as Error);
    expect(e?.message).toMatch(/^redis is down; nothing was sent, and the gate could not be put back \(db blip\)/);
    expect(e?.message).toMatch(/a stop lands once its send lease ends at \d{4}-/);
    expect(sendTask).not.toHaveBeenCalled();
    expect(await statusOf(s.runId)).toBe("running");
  });
});
