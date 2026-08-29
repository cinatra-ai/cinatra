/**
 * DECLARED TABLES UNDER THE EXTENSION'S PREFIX AND ROLE, ON A REAL POSTGRES
 * (cinatra#3031, epic #3023 W7).
 *
 * Acceptance item 1 in the issue's own words: "a signed fixture extension's
 * declared table exists under its prefix after install and its migration
 * touching another table is refused by the database".
 *
 * The plan sentence it serves — enabler 0.23: "The host, not the migration,
 * creates the declared tables and indexes, from the declaration, under the
 * prefix of item 0.24 and within the database's 63-byte identifier limit … An
 * extension's own migrations are data migrations on its declared tables: they
 * run under a database role of the extension's own that holds privileges on its
 * prefixed tables and nothing else, so a statement that touches another table,
 * another extension's table or the ledger is refused by the database itself,
 * transaction or no transaction, and the host records the refusal on the
 * migration's ledger row."
 *
 * WHY THIS TIER EXISTS AT ALL. Every claim above is a claim about what
 * PostgreSQL does. A stub would agree with whatever this code said about role
 * confinement, which is the one thing that must not be taken on trust: the
 * refusal has to be MEASURED BY THE DATABASE — `permission denied`, raised by
 * the server, on a statement the host really executed. So there is no double
 * here at all: a real database, the real host entry point both the install
 * pipeline and the boot pass call (`applyExtensionMigrationsFromStore`), a real
 * store directory with real node-pg-migrate modules, and the real shared
 * ledger.
 *
 * WHAT IS DRIVEN, AND WHAT IS NOT. The signature/trust gate that decides
 * WHETHER an extension's migrations run is upstream and unchanged by this
 * slice; the callers pass their already-trusted records into this one entry
 * point (see `applyMigrationsForTrustedRecords`). So the fixture is driven from
 * that entry point rather than through the marketplace install pipeline, which
 * would add a signature ceremony this slice does not touch and prove nothing
 * more about the database.
 *
 * DB-gated: self-skips without a real SUPABASE_DB_URL — except in the dedicated
 * lane, which refuses to skip.
 *   SUPABASE_DB_URL='<your scratch-database DSN>' pnpm test:extension-tables
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const IN_DEDICATED_LANE = process.env.CINATRA_EXTENSION_TABLES_REALDB === "1";

if (IN_DEDICATED_LANE && !HAS_DB) {
  throw new Error(
    "the #3031 declared-tables lane needs a live Postgres: set SUPABASE_DB_URL to a real " +
      "connection string. Refusing to skip — a skipped proof that the database refuses a " +
      "trespassing migration proves nothing.",
  );
}
const describeDb = HAS_DB ? describe : describe.skip;

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_x3031";
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;

const PACKAGE = "@cinatra-ai/w7-fixture";
const NAMESPACE = "ext_cinatra-ai_w7-fixture__";
const PREFIX = "ext_cinatra_ai_w7_fixture_";
const ROLE = "ext_cinatra_ai_w7_fixture";
const OWN_TABLE = `${PREFIX}idea_reservations`;
const HOST_ONLY_TABLE = "w7_host_only";

const DECLARED_TABLES = [
  {
    name: "idea_reservations",
    organizationColumn: "org_id",
    columns: [
      { name: "id", type: "text", notNull: true, primaryKey: true },
      { name: "org_id", type: "text", notNull: true },
      { name: "idea_artifact_id", type: "text", notNull: true },
      { name: "state", type: "text", notNull: true },
      { name: "created_at", type: "timestamptz", notNull: true, default: "now()" },
    ],
    indexes: [
      { name: "idea_reservations_live", columns: ["org_id", "idea_artifact_id"], unique: true },
    ],
  },
];

let admin: Client;
let storeDir: string;

async function writeFixtureStore(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "w7-store-"));
  const pkgDir = join(root, "w7-fixture");
  const migDir = join(pkgDir, "cinatra", "migrations");
  await mkdir(migDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: PACKAGE,
        version: "1.0.0",
        cinatra: {
          apiVersion: "v1",
          kind: "agent",
          migrationsDir: "cinatra/migrations",
          declaredTables: DECLARED_TABLES,
        },
      },
      null,
      2,
    ),
  );
  // A DATA migration on the extension's OWN declared table — what enabler 0.23
  // says an extension's migrations are.
  await writeFile(
    join(migDir, `${NAMESPACE}0001_seed-reservation.mjs`),
    `export const up = (pgm) => {\n` +
      `  pgm.sql("INSERT INTO ${OWN_TABLE} (id, org_id, idea_artifact_id, state) " +\n` +
      `    "VALUES ('seed', 'org-w7', 'artifact-w7', 'reserved')");\n` +
      `};\nexport const down = (pgm) => { pgm.sql("DELETE FROM ${OWN_TABLE} WHERE id = 'seed'"); };\n`,
  );
  // The fixture the fleet cannot supply (plan §8.8): "a signed extension whose
  // migration touches a table outside its prefix".
  await writeFile(
    join(migDir, `${NAMESPACE}0002_touch-another-table.mjs`),
    `export const up = (pgm) => {\n` +
      `  pgm.sql("INSERT INTO ${HOST_ONLY_TABLE} (id) VALUES ('trespass')");\n` +
      `};\nexport const down = (pgm) => {};\n`,
  );
  return pkgDir;
}

describeDb("declared tables under the extension's prefix and role (cinatra#3031 acceptance 1)", () => {
  let applied: string[] = [];
  let refusalError: string | null = null;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${q(SCHEMA)} CASCADE`);
    await admin.query(`CREATE SCHEMA ${q(SCHEMA)}`);
    await admin.query(`DROP ROLE IF EXISTS ${q(ROLE)}`);
    // A table that is NOT the extension's: the one its migration reaches for.
    await admin.query(`CREATE TABLE ${q(SCHEMA)}.${q(HOST_ONLY_TABLE)} (id text PRIMARY KEY)`);

    storeDir = await writeFixtureStore();
    process.env.SUPABASE_SCHEMA = SCHEMA;
    const { applyExtensionMigrationsFromStore } = await import("@/lib/extension-migration-host");
    try {
      const res = await applyExtensionMigrationsFromStore({ storeDir, packageName: PACKAGE });
      applied = res.applied;
    } catch (e) {
      refusalError = e instanceof Error ? e.message : String(e);
    }
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS ${q(SCHEMA)} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${q(ROLE)}`).catch(() => {});
    await admin.end().catch(() => {});
  });

  it("the declared table exists under the extension's prefix, created by the HOST", async () => {
    const res = await admin.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2",
      [SCHEMA, OWN_TABLE],
    );
    expect(res.rowCount).toBe(1);
  });

  it("the declared index exists under the prefix too", async () => {
    const res = await admin.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = $2",
      [SCHEMA, `${PREFIX}idea_reservations_live`],
    );
    expect(res.rowCount).toBe(1);
  });

  it("the extension's own database role exists and cannot log in", async () => {
    const res = await admin.query(
      "SELECT rolcanlogin, rolsuper FROM pg_roles WHERE rolname = $1",
      [ROLE],
    );
    expect(res.rowCount).toBe(1);
    expect((res.rows[0] as { rolcanlogin: boolean }).rolcanlogin).toBe(false);
    expect((res.rows[0] as { rolsuper: boolean }).rolsuper).toBe(false);
  });

  it("the role holds privileges on its OWN table and none on any other", async () => {
    const own = await admin.query(
      "SELECT privilege_type FROM information_schema.table_privileges " +
        "WHERE grantee = $1 AND table_schema = $2 AND table_name = $3 ORDER BY privilege_type",
      [ROLE, SCHEMA, OWN_TABLE],
    );
    expect((own.rows as { privilege_type: string }[]).map((r) => r.privilege_type)).toEqual([
      "DELETE",
      "INSERT",
      "SELECT",
      "UPDATE",
    ]);
    const others = await admin.query(
      "SELECT table_name FROM information_schema.table_privileges " +
        "WHERE grantee = $1 AND table_name <> $2",
      [ROLE, OWN_TABLE],
    );
    expect(others.rowCount).toBe(0);
  });

  it("the data migration on its OWN table ran, and its row is there", async () => {
    // `applied` is empty on purpose: the chain STOPS at the refusal and the
    // host entry point throws, which is what makes the caller record the whole
    // package as refused. What committed before the refusal committed for real,
    // in its own transaction — that is the thing to read back.
    expect(applied).toEqual([]);
    const res = await admin.query(
      `SELECT org_id, state FROM ${q(SCHEMA)}.${q(OWN_TABLE)} WHERE id = 'seed'`,
    );
    expect(res.rows[0]).toEqual({ org_id: "org-w7", state: "reserved" });
  });

  it("THE DATABASE ITSELF refuses the migration that touches another table", () => {
    expect(refusalError).toMatch(/permission denied/i);
    expect(refusalError).toMatch(new RegExp(HOST_ONLY_TABLE));
  });

  it("the trespassed table is untouched", async () => {
    const res = await admin.query(`SELECT count(*)::int AS n FROM ${q(SCHEMA)}.${q(HOST_ONLY_TABLE)}`);
    expect((res.rows[0] as { n: number }).n).toBe(0);
  });

  it("the host records the refusal on the migration's own ledger row", async () => {
    const res = await admin.query(
      `SELECT name, state, refused_reason FROM ${q(SCHEMA)}."pgmigrations" ORDER BY id`,
    );
    const rows = res.rows as { name: string; state: string | null; refused_reason: string | null }[];
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      [`${NAMESPACE}0001_seed-reservation`, "applied"],
      [`${NAMESPACE}0002_touch-another-table`, "refused"],
    ]);
    expect(rows[1]?.refused_reason).toMatch(/permission denied/i);
  });

  it("a refused row never reads as applied — a re-run retries it and is refused again", async () => {
    const { applyExtensionMigrationsFromStore } = await import("@/lib/extension-migration-host");
    await expect(
      applyExtensionMigrationsFromStore({ storeDir, packageName: PACKAGE }),
    ).rejects.toThrow(/permission denied/i);
    const res = await admin.query(
      `SELECT name FROM ${q(SCHEMA)}."pgmigrations" WHERE state = 'refused' ORDER BY id`,
    );
    // Both refusals name the module that was actually refused — the ledger must
    // never blame the one that succeeded a run earlier.
    expect((res.rows as { name: string }[]).map((r) => r.name)).toEqual([
      `${NAMESPACE}0002_touch-another-table`,
      `${NAMESPACE}0002_touch-another-table`,
    ]);
  }, 60_000);

  it("the role cannot create a table of its own — the host owns creation", async () => {
    const client = new Client({ connectionString: DB_URL });
    await client.connect();
    try {
      await client.query(`SET search_path TO ${q(SCHEMA)}`);
      await client.query(`SET ROLE ${q(ROLE)}`);
      await expect(client.query(`CREATE TABLE ${q(`${PREFIX}sneaky`)} (id text)`)).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await client.end().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// THE ROLE THE STATEMENTS RUN AS IS NOT THE EXTENSION'S TO CHANGE
// (cinatra#3031, convergence round; enabler 0.23: "they run under a database
// role of the extension's own that holds privileges on its prefixed tables and
// nothing else").
//
// `SET ROLE` is a SESSION switch, and an extension's statement runs in the very
// session the host switched. A migration whose statement begins `RESET ROLE;`
// would therefore have run everything after it under the HOST credential —
// which is the whole perimeter, undone by six characters. The host refuses such
// a statement before it reaches the database; this proves the refusal on the
// real surface and that the trespass never lands.
// ---------------------------------------------------------------------------
const ESCAPE_PACKAGE = "@cinatra-ai/w7-escape";
const ESCAPE_NAMESPACE = "ext_cinatra-ai_w7-escape__";
const ESCAPE_ROLE = "ext_cinatra_ai_w7_escape";
const ESCAPE_TABLE = "ext_cinatra_ai_w7_escape_notes";
const ESCAPE_HOST_TABLE = "w7_escape_host_only";

describeDb("a migration cannot step out of its own role (cinatra#3031)", () => {
  let admin2: Client;
  let escapeStore: string;
  let error: string | null = null;

  beforeAll(async () => {
    admin2 = new Client({ connectionString: DB_URL });
    await admin2.connect();
    await admin2.query(`DROP SCHEMA IF EXISTS ${q(SCHEMA)} CASCADE`);
    await admin2.query(`CREATE SCHEMA ${q(SCHEMA)}`);
    await admin2.query(`DROP ROLE IF EXISTS ${q(ESCAPE_ROLE)}`);
    await admin2.query(`CREATE TABLE ${q(SCHEMA)}.${q(ESCAPE_HOST_TABLE)} (id text PRIMARY KEY)`);

    const root = await mkdtemp(join(tmpdir(), "w7-escape-"));
    const pkgDir = join(root, "w7-escape");
    const migDir = join(pkgDir, "cinatra", "migrations");
    await mkdir(migDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: ESCAPE_PACKAGE,
        version: "1.0.0",
        cinatra: {
          apiVersion: "v1",
          kind: "agent",
          migrationsDir: "cinatra/migrations",
          declaredTables: [
            {
              name: "notes",
              organizationColumn: "org_id",
              columns: [
                { name: "id", type: "text", notNull: true, primaryKey: true },
                { name: "org_id", type: "text", notNull: true },
              ],
            },
          ],
        },
      }),
    );
    await writeFile(
      join(migDir, `${ESCAPE_NAMESPACE}0001_step-out-of-the-role.mjs`),
      `export const up = (pgm) => {\n` +
        `  pgm.sql("RESET ROLE; INSERT INTO ${ESCAPE_HOST_TABLE} (id) VALUES ('escaped')");\n` +
        `};\nexport const down = (pgm) => {};\n`,
    );
    escapeStore = pkgDir;
    process.env.SUPABASE_SCHEMA = SCHEMA;
    const { applyExtensionMigrationsFromStore } = await import("@/lib/extension-migration-host");
    try {
      await applyExtensionMigrationsFromStore({
        storeDir: escapeStore,
        packageName: ESCAPE_PACKAGE,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }, 120_000);

  afterAll(async () => {
    if (!admin2) return;
    await admin2.query(`DROP SCHEMA IF EXISTS ${q(SCHEMA)} CASCADE`).catch(() => {});
    await admin2.query(`DROP ROLE IF EXISTS ${q(ESCAPE_ROLE)}`).catch(() => {});
    await admin2.end().catch(() => {});
  });

  it("the host refuses the statement rather than running it", () => {
    expect(error).toMatch(/may not change the role it runs as/i);
  });

  it("the host-only table is untouched — the trespass never reached the database", async () => {
    const res = await admin2.query(
      `SELECT count(*)::int AS n FROM ${q(SCHEMA)}.${q(ESCAPE_HOST_TABLE)}`,
    );
    expect((res.rows[0] as { n: number }).n).toBe(0);
  });

  it("the refusal is on the ledger, against the module that was refused", async () => {
    const res = await admin2.query(
      `SELECT name, state, refused_reason FROM ${q(SCHEMA)}."pgmigrations" ORDER BY id`,
    );
    const rows = res.rows as { name: string; state: string | null; refused_reason: string | null }[];
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      [`${ESCAPE_NAMESPACE}0001_step-out-of-the-role`, "refused"],
    ]);
    expect(rows[0]?.refused_reason).toMatch(/may not change the role/i);
  });

  it("the extension's own declared table was still created by the host, under its prefix", async () => {
    const res = await admin2.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2",
      [SCHEMA, ESCAPE_TABLE],
    );
    expect(res.rowCount).toBe(1);
  });
});
