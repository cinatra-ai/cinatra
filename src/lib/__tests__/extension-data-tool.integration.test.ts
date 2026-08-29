/**
 * A FLOW READS AND WRITES ITS OWN TABLE THROUGH THE TOOL AND NOTHING ELSE,
 * ON A REAL POSTGRES (cinatra#3031, epic #3023 W7).
 *
 * Acceptance item 2 in the issue's own words: "a flow reads and writes its own
 * table through the tool and nothing else".
 *
 * The plan sentence it serves — enabler 0.25: "one tool on the passthrough and
 * the self-served tool set, operating only on the calling extension's declared
 * tables and declared columns — select, insert, update and delete on the
 * caller's own rows — with the caller derived from the run's extension
 * identity, the organisation column injected by the host, parameters only, no
 * raw statement, and every write recorded with the table and the row keys."
 *
 * "AND NOTHING ELSE" HAS TWO HALVES, and only one of them is ours. The builder
 * refuses an undeclared table or column — that half is proved in the unit tier,
 * where the compiled statement is readable. The other half is the database's:
 * the extension's own role holds privileges on its prefixed tables and nothing
 * else, so even a statement that got past the builder is refused by PostgreSQL.
 * That half can only be measured against a real server, which is what this tier
 * is for.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const IN_DEDICATED_LANE = process.env.CINATRA_EXTENSION_TABLES_REALDB === "1";

if (IN_DEDICATED_LANE && !HAS_DB) {
  throw new Error(
    "the #3031 extension-data lane needs a live Postgres: set SUPABASE_DB_URL to a real " +
      "connection string. Refusing to skip — a skipped proof that the database confines a role " +
      "proves nothing.",
  );
}
const describeDb = HAS_DB ? describe : describe.skip;

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_x3031";
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;

const PACKAGE = "@cinatra-ai/w7-data-fixture";
const ROLE = "ext_cinatra_ai_w7_data_fixture";
const OWN_TABLE = "ext_cinatra_ai_w7_data_fixture_idea_reservations";
const HOST_ONLY_TABLE = "w7_data_host_only";
const ORG = "org-w7-data";
const OTHER_ORG = "org-w7-other";
const RUN_ID = "run-w7-data";

const DECLARED = [
  {
    name: "idea_reservations",
    organizationColumn: "org_id",
    columns: [
      { name: "id", type: "text", notNull: true, primaryKey: true },
      { name: "org_id", type: "text", notNull: true },
      { name: "idea_artifact_id", type: "text", notNull: true },
      { name: "state", type: "text", notNull: true },
    ],
  },
];

let admin: Client;
let client: Client;
let tables: import("@cinatra-ai/sdk-extensions/manifest").DeclaredTable[];
const auditEvents: Record<string, unknown>[] = [];

async function run(request: Record<string, unknown>) {
  const { runExtensionDataOperation } = await import("@/lib/extension-data-tool");
  return runExtensionDataOperation({
    client: client as never,
    schemaName: SCHEMA,
    packageName: PACKAGE,
    tables,
    orgId: ORG,
    runId: RUN_ID,
    request: request as never,
    audit: async (e) => {
      auditEvents.push(e);
    },
  });
}

describeDb("the extension-data tool on a real store (cinatra#3031 acceptance 2)", () => {
  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${q(SCHEMA)} CASCADE`);
    await admin.query(`CREATE SCHEMA ${q(SCHEMA)}`);
    await admin.query(`DROP ROLE IF EXISTS ${q(ROLE)}`);
    await admin.query(`CREATE TABLE ${q(SCHEMA)}.${q(HOST_ONLY_TABLE)} (id text PRIMARY KEY)`);
    await admin.query(`INSERT INTO ${q(SCHEMA)}.${q(HOST_ONLY_TABLE)} (id) VALUES ('kept')`);

    const { planExtensionDeclaredTables, ensureExtensionDatabaseObjects } = await import(
      "@/lib/extension-migration-host"
    );
    const plan = planExtensionDeclaredTables({ packageName: PACKAGE, declaredTables: DECLARED });
    if (!plan) throw new Error("the fixture declares tables — the plan must not be null");
    tables = plan.tables;
    await ensureExtensionDatabaseObjects({ client: admin as never, schemaName: SCHEMA, plan });

    // Another organisation's row, written by the HOST — the tool must never see it.
    await admin.query(
      `INSERT INTO ${q(SCHEMA)}.${q(OWN_TABLE)} (id, org_id, idea_artifact_id, state) ` +
        `VALUES ('other', $1, 'artifact-other', 'reserved')`,
      [OTHER_ORG],
    );

    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query(`SET search_path TO ${q(SCHEMA)}`);
  }, 120_000);

  afterAll(async () => {
    await client?.end().catch(() => {});
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${q(SCHEMA)} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${q(ROLE)}`).catch(() => {});
    await admin.end().catch(() => {});
  });

  it("writes a row of its own, with the organisation the host injected", async () => {
    const res = await run({
      operation: "insert",
      table: "idea_reservations",
      values: { id: "r1", idea_artifact_id: "a1", state: "reserved" },
    });
    expect(res.rowCount).toBe(1);
    expect(res.rows[0]).toMatchObject({ id: "r1", org_id: ORG, state: "reserved" });
  });

  it("reads back only its own organisation's rows", async () => {
    const res = await run({ operation: "select", table: "idea_reservations" });
    expect(res.rows.map((r) => r.id)).toEqual(["r1"]);
  });

  it("updates and deletes only inside its own organisation", async () => {
    const up = await run({
      operation: "update",
      table: "idea_reservations",
      values: { state: "drafted" },
      where: { id: "r1" },
    });
    expect(up.rows[0]).toMatchObject({ state: "drafted" });

    // The same key in ANOTHER organisation is untouchable through the tool.
    const miss = await run({
      operation: "update",
      table: "idea_reservations",
      values: { state: "drafted" },
      where: { id: "other" },
    });
    expect(miss.rowCount).toBe(0);
    const other = await admin.query(
      `SELECT state FROM ${q(SCHEMA)}.${q(OWN_TABLE)} WHERE id = 'other'`,
    );
    expect(other.rows[0]).toEqual({ state: "reserved" });

    const del = await run({ operation: "delete", table: "idea_reservations", where: { id: "r1" } });
    expect(del.rowCount).toBe(1);
    const left = await admin.query(`SELECT id FROM ${q(SCHEMA)}.${q(OWN_TABLE)} ORDER BY id`);
    expect((left.rows as { id: string }[]).map((r) => r.id)).toEqual(["other"]);
  });

  it("records every operation with the calling extension, the table and the row keys", () => {
    const allowed = auditEvents.filter((e) => e.decision === "allowed");
    expect(allowed.length).toBeGreaterThanOrEqual(4);
    const insert = allowed.find((e) => e.operation === "extension_data.insert");
    expect(insert).toMatchObject({
      organizationId: ORG,
      resourceType: "extension_table",
      resourceId: OWN_TABLE,
      runId: RUN_ID,
    });
    expect((insert?.metadata as Record<string, unknown>).extension).toBe(PACKAGE);
    expect((insert?.metadata as Record<string, unknown>).rowKeys).toMatchObject({ id: "r1" });
  });

  it("refuses a table the calling extension does not declare, and records the refusal", async () => {
    auditEvents.length = 0;
    await expect(run({ operation: "select", table: HOST_ONLY_TABLE })).rejects.toThrow(
      /does not declare a table named/,
    );
    expect(auditEvents[0]).toMatchObject({ decision: "denied" });
    expect((auditEvents[0]?.metadata as Record<string, unknown>).reason).toBe("table-not-declared");
  });

  it("AND NOTHING ELSE: the database itself refuses the role on a table it does not own", async () => {
    const probe = new Client({ connectionString: DB_URL });
    await probe.connect();
    try {
      await probe.query(`SET search_path TO ${q(SCHEMA)}`);
      await probe.query("BEGIN");
      await probe.query(`SET LOCAL ROLE ${q(ROLE)}`);
      await expect(
        probe.query(`SELECT id FROM ${q(SCHEMA)}.${q(HOST_ONLY_TABLE)}`),
      ).rejects.toThrow(/permission denied/i);
      await probe.query("ROLLBACK");
      // …and the row it reached for is still there.
      const kept = await admin.query(
        `SELECT count(*)::int AS n FROM ${q(SCHEMA)}.${q(HOST_ONLY_TABLE)}`,
      );
      expect((kept.rows[0] as { n: number }).n).toBe(1);
    } finally {
      await probe.end().catch(() => {});
    }
  });

  it("hands the pooled connection back without the extension's identity on it", async () => {
    const res = await client.query("SELECT current_user AS u");
    expect((res.rows[0] as { u: string }).u).not.toBe(ROLE);
  });
});
