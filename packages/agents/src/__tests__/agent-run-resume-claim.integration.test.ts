/**
 * cinatra#4245 change B — `agent_run_resume` and `agent_run_stop` under the pause
 * claim (spec 4.2, 4.3; tests B1-B8). REAL store for the run, the claim and the seam;
 * identity, transport, the run credential and the answer's handling are replaced.
 *
 * Barriers: in the prompt capture (after the claim, before the fence), in the stop's
 * access check (after its read, before its compare-and-set), and in the send.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

type Gate = { reached: Promise<void>; arrive: () => void; open: () => void; wait: Promise<void> };
const ctl = vi.hoisted(() => ({
  capture: null as null | Gate,
  access: null as null | Gate,
  send: null as null | Gate,
  failRelease: false,
}));
function gate(): Gate {
  let arrive!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((r) => { arrive = r; });
  const wait = new Promise<void>((r) => { open = r; });
  return { reached, arrive, open, wait };
}
const passThrough = vi.hoisted(() => async (slot: "capture" | "access" | "send") => {
  const g = ctl[slot];
  if (!g) return;
  ctl[slot] = null;
  g.arrive();
  await g.wait;
});

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => null),
  isPlatformAdmin: vi.fn(() => false),
  requireAuthSession: vi.fn(),
  resolveOrgRoleForUser: vi.fn(async () => "member"),
}));
vi.mock("../auth-policy", async (orig) => ({
  ...(await orig<typeof import("../auth-policy")>()),
  enforceRunAccess: vi.fn(async () => { await passThrough("access"); }),
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
    // The row itself, past the handler's access filter.
    readAgentRunById: vi.fn(async (id: string) => actual.readAgentRunById(id)),
    readRunCoOwners: vi.fn(async () => []),
    readAgentTemplateById: vi.fn(async () => ({
      id: "tmpl-claim",
      packageName: "@cinatra-ai/claim-agent",
      sourceType: "internal",
      agentAuthPolicy: null,
    })),
  };
});
vi.mock("../agent-run-hitl-prompts", async (orig) => {
  const actual = await orig<typeof import("../agent-run-hitl-prompts")>();
  return {
    ...actual,
    captureHitlPromptForContinue: async (input: Parameters<typeof actual.captureHitlPromptForContinue>[0]) => {
      await passThrough("capture");
      return actual.captureHitlPromptForContinue(input);
    },
  };
});
vi.mock("../run-pause-claim", async (orig) => {
  const actual = await orig<typeof import("../run-pause-claim")>();
  return {
    ...actual,
    releasePauseClaim: async (...args: Parameters<typeof actual.releasePauseClaim>) => {
      if (ctl.failRelease) throw new Error("release is down");
      return actual.releasePauseClaim(...args);
    },
  };
});
vi.mock("../wayflow-url", () => ({
  WAYFLOW_UNDICI_TIMEOUT_MS: 60_000,
  resolveWayflowUrl: vi.fn(() => "http://wayflow.test"),
  WAYFLOW_A2A_TIMEOUT_MS: 86_400_000,
  createWayflowFetch: vi.fn(() => globalThis.fetch),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));
const mint = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../wayflow-run-token-carrier", () => ({ mintResumeRunTokenMetadata: mint }));
const sendTask = vi.hoisted(() =>
  vi.fn(async () => {
    await passThrough("send");
    return { id: "t-next", status: { state: "completed" } } as unknown;
  }),
);
vi.mock("../../../a2a/src/external-client", () => ({
  createExternalA2AClient: vi.fn(async () => ({ sendTask })),
}));
// The answer's handling has its own test (wayflow-pause-task-id-durable.test.ts):
// here the run stays where the fence put it.
const handle = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../execution", async (orig) => ({
  ...(await orig<typeof import("../execution")>()),
  handleWayflowTaskState: handle,
}));
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: vi.fn(),
}));
vi.mock("../verdaccio/publish-metadata", () => ({ derivePublishMetadataFromSnapshot: vi.fn() }));
vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({
  isSafePathSegment: (s: unknown): boolean =>
    typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s),
  assertSafePathSegment: (): void => undefined,
  listAgentPackages: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(() => ({ attributes: {}, body: "" })),
}));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectGrantsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  listAccessibleOrgIdsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => null),
}));

const TEST_SCHEMA = "cinatra_test_resume_claim_4245";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const RUNS = `"${q(TEST_SCHEMA)}"."agent_runs"`;
const ORG = "org-4245-claim";
const SESSION = { orgId: ORG, can: () => true } as never;

let dbMod: typeof import("../db");
let store: typeof import("../store");
let claims: typeof import("../run-pause-claim");
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
  claims = await import("../run-pause-claim");
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
  ctl.capture = ctl.access = ctl.send = null;
  ctl.failRelease = false;
});

async function seed() {
  const runId = `run-claim-${randomUUID()}`;
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
  return runId;
}
const actor = { actorType: "human" as const, source: "ui" as const, userId: "user-a", orgWriteAuthority: SESSION };
async function handlers() {
  const { createAgentBuilderPrimitiveHandlers } = await import("../mcp/handlers");
  return createAgentBuilderPrimitiveHandlers();
}
type Answer = { error?: string; status?: string; message?: string; runId?: string; thrown?: string };
async function resume(runId: string): Promise<Answer> {
  return (await handlers())
    .agent_run_resume({ primitiveName: "agent_run_resume", input: { runId, note: "go on" }, actor, mode: "deterministic" } as never)
    .catch((e: unknown) => ({ thrown: String(e) })) as Promise<Answer>;
}
async function stop(runId: string): Promise<Answer> {
  return (await handlers()).agent_run_stop({ primitiveName: "agent_run_stop", input: { runId }, actor, mode: "deterministic" } as never) as Promise<Answer>;
}
async function row(runId: string) {
  const r = await pool(`SELECT status, pause_claim_token, pause_claim_phase, pause_generation FROM ${RUNS} WHERE id=$1`, [runId]);
  return r.rows[0] as { status: string; pause_claim_token: string | null; pause_claim_phase: string | null; pause_generation: number | string };
}
const excludedFlags = async (runId: string) =>
  (await pool(`SELECT excluded FROM "${q(TEST_SCHEMA)}"."agent_run_hitl_prompts" WHERE run_id=$1`, [runId])).rows.map((r) => r.excluded as boolean);
const ALREADY = /Run is already resuming: its answer was sent before this stop, so it was not stopped/;

describe.skipIf(!HAS_DB)("cinatra#4245 change B — resume and stop under the pause claim (real store)", () => {
  it("B1: a claimer that dies: its lease expires, a second resume sends once, the first's late fence is refused", async () => {
    const id = await seed();
    const g = (ctl.capture = gate());
    const first = resume(id);
    await g.reached;
    await pool(`UPDATE ${RUNS} SET pause_claim_expires_at = now() - interval '1 second' WHERE id=$1`, [id]);
    const second = await resume(id);
    expect(second.error).toBeUndefined();
    expect(sendTask).toHaveBeenCalledTimes(1);
    g.open();
    expect((await first).error).toMatch(/claim on the pause expired before the send; nothing was sent/);
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("B1: a second resume while the first holds a live claim is refused", async () => {
    const id = await seed();
    const g = (ctl.capture = gate());
    const first = resume(id);
    await g.reached;
    expect((await resume(id)).error).toBe("Run is already being resumed at this pause by another request.");
    g.open();
    expect((await first).error).toBeUndefined();
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("B2: a step that fails and a release that fails: the error names both and the expiry", async () => {
    const id = await seed();
    mint.mockRejectedValueOnce(new Error("no carrier"));
    ctl.failRelease = true;
    const r = await resume(id);
    // The handler's own catch turns a thrown step into its "Resume failed" answer.
    expect(r.error).toMatch(/no carrier/);
    expect(r.error).toMatch(/release is down/);
    expect(r.error).toMatch(/it frees itself at \d{4}-/);
    expect(sendTask).not.toHaveBeenCalled();
  });

  it("guard: a step that fails with a working release gives the pause back", async () => {
    const id = await seed();
    mint.mockRejectedValueOnce(new Error("no carrier"));
    expect((await resume(id)).error).toMatch(/no carrier/);
    expect(await row(id)).toMatchObject({ status: "pending_approval", pause_claim_token: null });
    expect((await resume(id)).error).toBeUndefined();
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("B3: a stop that read pending_approval, then the resume fenced: already resuming, not stopped", async () => {
    const id = await seed();
    const s = (ctl.access = gate());
    const stopping = stop(id);
    await s.reached;
    const r = (ctl.send = gate());
    const resuming = resume(id);
    await r.reached;
    s.open();
    const answer = await stopping;
    expect(answer.error).toMatch(ALREADY);
    expect(answer.status).toBe("running");
    expect((await row(id)).status).toBe("running");
    r.open();
    await resuming;
    expect(sendTask).toHaveBeenCalledTimes(1);
  });

  it("B4: a stop between the claim and the fence wins: nothing is sent, the prompt row is excluded", async () => {
    const id = await seed();
    const p = (ctl.capture = gate());
    const resuming = resume(id);
    await p.reached;
    expect((await stop(id)).status).toBe("stopped");
    p.open();
    expect((await resuming).error).toBe("Run was stopped before the answer was sent; nothing was sent.");
    expect(sendTask).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ status: "stopped", pause_claim_token: null });
    expect(await excludedFlags(id)).toEqual([true]);
  });

  it("B5: a stop during a live send: already resuming", async () => {
    const id = await seed();
    const r = (ctl.send = gate());
    const resuming = resume(id);
    await r.reached;
    expect((await stop(id)).error).toMatch(ALREADY);
    r.open();
    await resuming;
  });

  it("B6: guard (green at base): a stop after the resumed leg returned is an ordinary stop", async () => {
    const id = await seed();
    expect((await resume(id)).error).toBeUndefined();
    expect((await stop(id)).status).toBe("stopped");
    expect((await row(id)).status).toBe("stopped");
  });

  it("B7: a send that throws: run running, claim settled, a later stop succeeds", async () => {
    const id = await seed();
    sendTask.mockRejectedValueOnce(new Error("wire down"));
    expect((await resume(id)).error).toMatch(/wire down/);
    expect(await row(id)).toMatchObject({ status: "running", pause_claim_token: null });
    expect((await stop(id)).status).toBe("stopped");
  });

  it("B8: a stop during the worker's in-place fence: already resuming, the status stays pending_approval", async () => {
    const id = await seed();
    const claim = await claims.claimPause({ runId: id, orgId: ORG, generation: 0 }, SESSION);
    if (claim.kind !== "claimed") throw new Error("refused");
    expect(await claims.fencePauseInPlace({ runId: id, orgId: ORG, generation: 0, token: claim.token }, SESSION)).toBe("fenced");
    const answer = await stop(id);
    expect(answer.error).toMatch(ALREADY);
    expect(answer.status).toBe("pending_approval");
  });

  it("a lost compare-and-set is never a stop: a terminal row gets the terminal answer", async () => {
    const id = await seed();
    const s = (ctl.access = gate());
    const stopping = stop(id);
    await s.reached;
    await pool(`UPDATE ${RUNS} SET status='completed' WHERE id=$1`, [id]);
    s.open();
    expect(await stopping).toMatchObject({ status: "completed", message: "Run already in terminal state: completed" });
  });

  it("the three attempts: a row that keeps moving gets the try-again answer, and is not stopped", async () => {
    const { stopRunRespectingPauseClaim } = await import("../run-resume-under-claim");
    const id = await seed();
    await pool(`UPDATE ${RUNS} SET status='running' WHERE id=$1`, [id]);
    const answer = await stopRunRespectingPauseClaim({
      runId: id, fromStatus: "queued", authority: SESSION,
      // Each read says the row moved again; the row itself stays `running`.
      readRun: async () => ({ status: "queued" }),
    });
    expect(answer).toMatchObject({ runId: id, error: "Run changed state while stopping and was not stopped; try again." });
    expect((await row(id)).status).toBe("running");
  });

  it("the sender's task-id write is conditional on its own token", async () => {
    const id = await seed();
    const claim = await claims.claimPause({ runId: id, orgId: ORG, generation: 0 }, SESSION);
    if (claim.kind !== "claimed") throw new Error("refused");
    expect(await store.updateAgentRunA2ATaskId(id, "t-other", { pauseClaimToken: "someone-else" })).toEqual({ written: false });
    expect(await store.updateAgentRunA2ATaskId(id, "t-own", { pauseClaimToken: claim.token })).toEqual({ written: true });
  });
});
