/**
 * THE NAMED START'S RUN, ON A REAL DATABASE (cinatra#2935, epic #2926 W5d).
 *
 * Acceptance item 1 says the named agent is started "under the person's own
 * rights, with the run card appearing". The unit tier proves the ORDER of the
 * gates and WHICH envelope the start is made with. What it cannot prove is that
 * Postgres agrees about the row that envelope produces:
 *
 *   1. THE OWNER IS THE PERSON. `run_by` is the acting human and `org_id` is
 *      their organization — read back off the real row, not off the input. A
 *      run created without an owner is a run whose later re-authorization falls
 *      back to the template's installation principal, which is exactly the
 *      person-shaped guarantee this slice is about.
 *   2. THE ORIGIN IS THE CONVERSATION. The launch reaches the coordinator as a
 *      chat-origin launch, so a run started by naming an agent parks at the
 *      moment a person is present for instead of running headless.
 *   3. THE CREATOR IS THE COORDINATOR. The row is created by `launchAgentRun`
 *      and by nothing else — the run-creation fence's own claim, checked here
 *      against a real table rather than against a source scan.
 *
 * WHAT IS DRIVEN, AND WHAT IS NOT. The envelope comes from the PRODUCTION
 * builder (`buildStartActorEnvelope`), so "under the person's own rights" is
 * asserted about the shipped function rather than about a copy of it. The
 * BullMQ enqueue is not exercised: it is Redis, not the database tier, and it is
 * held out by the headless `caller_dispatches` contract the coordinator already
 * offers rather than by a stub of the creator.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided — EXCEPT in the
 * dedicated lane, which refuses to skip. Run with:
 *   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:named-agent-start
 *
 * A SCRATCH DATABASE NEEDS THE AUTH FLOOR FIRST, and that is a property of the
 * store rather than of this suite: the module graph opens its pool at import
 * time, before any hook runs, and the store's cross-schema foreign keys point at
 * the Better Auth tables in `public`. A production database already has them; a
 * freshly created scratch one has none. `PUBLIC_FLOOR` below is that minimal
 * set, in the spirit of `scripts/check-fresh-schema-ddl.mjs`'s own precondition
 * block rather than a copy of it. It is replayed in the hook, so a run is
 * self-sufficient either way: against a database provisioned the repository's
 * own way (`node scripts/apply-public-schema.mjs`, which is what CI runs) every
 * statement is an `IF NOT EXISTS` no-op and the committed snapshot's shapes are
 * the ones that apply; against a brand-new scratch database the hook creates the
 * floor itself, in order, before the store DDL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { launchAgentRun } from "@cinatra-ai/agents/lifecycle-coordinator";
import { buildStartActorEnvelope } from "@/lib/lifecycle/named-agent-start-mcp";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB =
  DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const describeDb = HAS_DB ? describe : describe.skip;

const IN_DEDICATED_LANE = process.env.CINATRA_NAMED_AGENT_START_REALDB === "1";
const ALLOW_SKIP = process.env.X2935_ALLOW_SKIP === "1";

if (IN_DEDICATED_LANE && !ALLOW_SKIP && !HAS_DB) {
  throw new Error(
    "the #2935 named-agent-start lane needs a live Postgres: set SUPABASE_DB_URL " +
      "to a real connection string (it is unset, empty, or the unused:unused " +
      "placeholder). Refusing to skip — a skipped proof that a run is owned by " +
      "the person proves nothing. Pass X2935_ALLOW_SKIP=1 to skip anyway.",
  );
}

const TEST_SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_x2935";
const q = (s: string) => s.replaceAll('"', '""');
const RUNS = `"${q(TEST_SCHEMA)}"."agent_runs"`;

const TEMPLATE_ID = "tpl-x2935";
const PACKAGE_NAME = "@cinatra-ai/x2935-agent";
const ORG_ID = "org-x2935";
const PERSON_ID = "usr-x2935";

let admin: Client;

/** The person's OWN credential, in the shape `resolveBoundTurnActor` returns —
 *  the live standing the start is made with. */
const OWN_CREDENTIAL = {
  actor: { actorType: "human", source: "agent", userId: PERSON_ID, orgId: ORG_ID },
  orgId: ORG_ID,
  roleHints: {
    actorOrganizationId: ORG_ID,
    orgRole: "member" as const,
    platformRole: "member" as const,
    teamIds: ["team-x2935"],
    projectGrants: [],
  },
};

/**
 * The write authority the launch carries. BUILT here, not minted: the mint
 * helpers are named consumers behind the org-write boundary gate, and widening
 * that allowlist for a test would trade a real perimeter for a convenience. The
 * kernel re-reads the organization itself, which is why this suite seeds a real
 * one. Same shape and same reasoning as the #2928 tier's.
 */
function writeAuthority() {
  return {
    orgId: ORG_ID,
    can: (capability: string) => capability === "run.execute",
  } as unknown as Parameters<typeof launchAgentRun>[0]["authority"];
}

/**
 * The MINIMAL public-schema floor the store's cross-schema foreign keys point
 * at. Better Auth owns these tables in production; a scratch database has none,
 * and the bootstrap's `REFERENCES public."user"(id)` clauses cannot be created
 * without them. Enough columns for the references to resolve, and nothing that
 * could stand in for the real auth schema — the same idea as
 * `scripts/check-fresh-schema-ddl.mjs`'s own precondition block, never a copy of
 * it: this list has always carried tables and columns that guard does not, and
 * `user` and `organization` here now also carry the columns the committed
 * snapshot declares NOT NULL, so the seeds below are accepted on a
 * snapshot-provisioned database too (see the note on those statements). That
 * guard needs none of that: it replays its DDL inside a transaction it always
 * rolls back and seeds no rows, so it never meets these constraints.
 */
const PUBLIC_FLOOR: readonly string[] = [
  // The three columns the repository's OWN schema snapshot
  // (tests/e2e/rbac/fixtures/public-schema.sql) declares NOT NULL with no
  // default — `name`, `email`, `emailVerified` — are part of the floor, so the
  // seed below states the same values whichever way the database was
  // provisioned. On a brand-new scratch database this statement creates them;
  // on a database provisioned the repository's own way
  // (`node scripts/apply-public-schema.mjs`, which is what CI runs) the table
  // already exists, `IF NOT EXISTS` makes this a no-op, and the snapshot's
  // constraints are the ones that apply. A floor NARROWER than the snapshot is
  // what made this tier die in `beforeAll` on a snapshot-provisioned database.
  `CREATE TABLE IF NOT EXISTS public."user" (id text PRIMARY KEY, username text, name text NOT NULL, email text NOT NULL, "emailVerified" boolean NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS public."organization" (id text PRIMARY KEY, slug text NOT NULL, name text NOT NULL, "createdAt" timestamptz NOT NULL, "archivedAt" timestamptz, "archiveEpoch" int)`,
  `CREATE TABLE IF NOT EXISTS public."team" (id text PRIMARY KEY, "organizationId" text, name text)`,
  `CREATE TABLE IF NOT EXISTS public."teamMember" (id text PRIMARY KEY, "teamId" text, "userId" text)`,
  `CREATE TABLE IF NOT EXISTS public."member" (id text PRIMARY KEY, "organizationId" text, "userId" text, "createdAt" timestamptz, role text)`,
  `CREATE TABLE IF NOT EXISTS public."oauthClient" (id text PRIMARY KEY, "clientId" text)`,
];

async function replayBootstrap(): Promise<void> {
  for (const stmt of PUBLIC_FLOOR) {
    await admin.query(stmt);
  }
  for (const stmt of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    await admin.query(stmt.text);
  }
}

describeDb("the named start's run, on a real database", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
    process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
    await replayBootstrap();
    // The person and their organization exist for real: the store's foreign keys
    // reference them, and a run owned by a user the database does not hold is
    // not a run this tier could claim anything about.
    await admin.query(
      `INSERT INTO public."user" (id, username, name, email, "emailVerified")
       VALUES ($1, $2, $3, $4, false) ON CONFLICT (id) DO NOTHING`,
      [PERSON_ID, "x2935", "x2935", "x2935@example.test"],
    );
    await admin.query(
      `INSERT INTO public."organization" (id, slug, name, "createdAt")
       VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
      [ORG_ID, "x2935", "x2935"],
    );
    // THE MEMBERSHIP IS THE POINT, not a fixture detail. Without this row the
    // run-scope gate refuses the launch `cross_org` — which is the shipped rule
    // working, and is why this suite seeds a real membership rather than a
    // stand-in: "under the person's own rights" is asserted against the gate
    // that actually reads them.
    await admin.query(
      `INSERT INTO public."member" (id, "organizationId", "userId", "createdAt", role)
       VALUES ($1, $2, $3, now(), $4) ON CONFLICT (id) DO NOTHING`,
      ["mem-x2935", ORG_ID, PERSON_ID, "member"],
    );
    await admin.query(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
         (id, name, package_name, source_nl, compiled_plan, input_schema, approval_policy, org_id, owner_level, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
      [
        TEMPLATE_ID,
        "x2935 agent",
        PACKAGE_NAME,
        "start the named agent",
        JSON.stringify({ steps: [] }),
        JSON.stringify({ type: "object", properties: {} }),
        "manual",
        ORG_ID,
        // THE INSTALL SCOPE IS PART OF "the agents the person may start". An
        // organization-scoped template is one every member of that org may run;
        // a template with no determinate scope is refused `unknown_scope`, which
        // is the shipped rule and is why this suite states one.
        "organization",
        ORG_ID,
      ],
    );
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
    await admin.query(`DELETE FROM public."member" WHERE id = $1`, ["mem-x2935"]);
    await admin.query(`DELETE FROM public."user" WHERE id = $1`, [PERSON_ID]);
    await admin.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG_ID]);
    await admin.end();
  }, 120_000);

  it("the envelope the start is made with carries the person's LIVE standing", () => {
    const envelope = buildStartActorEnvelope(
      { userId: PERSON_ID, orgId: ORG_ID },
      OWN_CREDENTIAL,
    );
    expect(envelope).toMatchObject({
      actorType: "human",
      userId: PERSON_ID,
      orgId: ORG_ID,
      orgRole: "member",
      platformRole: "member",
      teamIds: ["team-x2935"],
      launchOrigin: "chat",
    });
  });

  it("the run it produces is a REAL row owned by that person, in their org", async () => {
    const envelope = buildStartActorEnvelope(
      { userId: PERSON_ID, orgId: ORG_ID },
      OWN_CREDENTIAL,
    );
    const answer = await launchAgentRun({
      producer: "agent_named_start",
      frame: envelope,
      authority: writeAuthority(),
      dispatch: {
        kind: "caller_dispatches",
        why: "the database tier proves the ROW, not the queue — Redis is not this tier",
      },
      create: {
        kind: "full",
        input: {
          // The id the `agent_run` primitive mints for every start.
          id: randomUUID(),
          templateId: TEMPLATE_ID,
          inputParams: {},
          orgId: ORG_ID,
          runBy: PERSON_ID,
        },
      },
    });
    const runId = (answer as { carrier?: { run?: { id?: string } } }).carrier?.run?.id;
    expect(runId, JSON.stringify(answer)).toBeTruthy();

    const { rows } = await admin.query(
      `SELECT id, run_by, org_id, human_present, status FROM ${RUNS} WHERE id = $1`,
      [runId],
    );
    // READ BACK OFF THE ROW, never off the input: an owner the database does not
    // hold is an owner the later re-authorization cannot find.
    expect(rows).toHaveLength(1);
    expect(rows[0].run_by).toBe(PERSON_ID);
    expect(rows[0].org_id).toBe(ORG_ID);
    // THE ORIGIN IS THE CONVERSATION. `launchOrigin: "chat"` on the envelope
    // plus a resolvable human owner is what the coordinator reads as "a person
    // is present for this run", so it parks at the moment a person is there for
    // instead of running headless. Read off the row, like the owner.
    expect(rows[0].human_present).toBe(true);
    // WHICH moment that presence then produces is the coordinator's contract
    // (cinatra#2928, W2a) and has its own tier; what this slice owes is that the
    // run is stamped as one a person is present for at all.
  }, 120_000);

  it("a launch the authority refuses writes NO row at all", async () => {
    const before = await admin.query(`SELECT count(*)::int AS n FROM ${RUNS}`);
    const refusing = {
      orgId: ORG_ID,
      can: () => false,
    } as unknown as Parameters<typeof launchAgentRun>[0]["authority"];
    await expect(
      launchAgentRun({
        producer: "agent_named_start",
        frame: buildStartActorEnvelope({ userId: PERSON_ID, orgId: ORG_ID }, OWN_CREDENTIAL),
        authority: refusing,
        dispatch: { kind: "caller_dispatches", why: "refusal path" },
        create: {
          kind: "full",
          input: { id: randomUUID(), templateId: TEMPLATE_ID, inputParams: {}, orgId: ORG_ID, runBy: PERSON_ID },
        },
      }),
    ).rejects.toThrow();
    const after = await admin.query(`SELECT count(*)::int AS n FROM ${RUNS}`);
    // NOTHING WAS STARTED. The refusal is not a run that fails later.
    expect(after.rows[0].n).toBe(before.rows[0].n);
  }, 120_000);
});
