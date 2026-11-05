/**
 * cinatra#4245 — bulk stop and a live send (spec 4.6, E1). REAL store: a run whose
 * answer is on the wire is not stopped and is counted as `resuming`; the others stop.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

vi.mock("@cinatra-ai/a2a", async (orig) => ({ ...(await orig<Record<string, unknown>>()) }));

const TEST_SCHEMA = "cinatra_test_bulk_stop_4245";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-4245-bulk";
const SESSION = { orgId: ORG, can: () => true } as never;

let store: typeof import("../store");
let claims: typeof import("../run-pause-claim");
let dbMod: typeof import("../db");

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
  store = await import("../store");
  claims = await import("../run-pause-claim");
  dbMod = await import("../db");
  await dbMod.agentBuilderPool.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $1, $1, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG],
  );
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

async function seed(status: string, templateId: string) {
  const id = `run-bulk-${randomUUID()}`;
  await dbMod.agentBuilderPool.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_runs" (id, template_id, org_id, input_params, status, run_by) VALUES ($1,$2,$3,'{}',$4,'user-a')`,
    [id, templateId, ORG, status],
  );
  return id;
}
const statusOf = async (id: string) =>
  (await dbMod.agentBuilderPool.query(`SELECT status FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id=$1`, [id])).rows[0].status as string;

async function seedTemplate() {
  const id = `tmpl-${randomUUID()}`;
  await dbMod.agentBuilderPool.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates" (id, org_id, owner_level, owner_id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name)
     VALUES ($1,$2,'organization',$2,'seed','seed','[]','{}','{}',$3)`,
    [id, ORG, `@cinatra-ai/seed-${id}`],
  );
  return id;
}

/** A run with its answer on the wire: claimed and fenced, by the real writers. */
async function seedSending(templateId: string) {
  const id = await seed("pending_approval", templateId);
  const claim = await claims.claimPause({ runId: id, orgId: ORG, generation: 0 }, SESSION);
  if (claim.kind !== "claimed") throw new Error("the seed's claim was refused");
  await store.transitionRunStatus(id, "pending_approval", "running", { pauseFence: { token: claim.token, generation: claim.generation } }, SESSION);
  return id;
}

describe.skipIf(!HAS_DB)("cinatra#4245 — bulk stop and a live send (real store)", () => {
  it("E1: by ids, the sending run is counted as resuming and stays running; the others stop", async () => {
    const t = await seedTemplate();
    const sending = await seedSending(t);
    const other = await seed("running", t);
    const finished = await seed("completed", t);
    const result = await store.bulkStopAgentRuns([sending, other, finished], SESSION);
    expect(result).toEqual({ stopped: 1, alreadyTerminal: 1, resuming: 1, total: 3 });
    expect(await statusOf(sending)).toBe("running");
    expect(await statusOf(other)).toBe("stopped");
  });

  it("E1: by template, the same", async () => {
    const t = await seedTemplate();
    const sending = await seedSending(t);
    const other = await seed("pending_approval", t);
    const result = await store.bulkStopAgentRunsByTemplate(t, SESSION);
    expect(result).toMatchObject({ stopped: 1, alreadyTerminal: 0, resuming: 1, total: 2 });
    expect(await statusOf(sending)).toBe("running");
    expect(await statusOf(other)).toBe("stopped");
  });

  it("no ids: the empty answer carries the new count", async () => {
    expect(await store.bulkStopAgentRuns([], SESSION)).toEqual({ stopped: 0, alreadyTerminal: 0, resuming: 0, total: 0 });
  });
});
