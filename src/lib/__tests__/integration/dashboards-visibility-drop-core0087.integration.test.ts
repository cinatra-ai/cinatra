/**
 * core__0087 — DROP `dashboards.visibility` (ACL cutover Phase-3; epic
 * cinatra#1883 §D7, issue #1898) — REAL-Postgres integration proof.
 *
 * Drives the migration's exported SQL builders (`buildUpSql(schema)` /
 * `buildDownSql(schema)`) against a schema built from the canonical DDL, and
 * proves the four things a destructive DROP has to prove:
 *
 *   1. FRESH SHAPE — the post-drop bootstrap DDL already creates `dashboards`
 *      WITHOUT the column (a fresh install never grows it, so the ledger-faked
 *      chain is honest);
 *   2. UPGRADE PATH — on a schema shaped like an EXISTING deployment (the column
 *      re-added and populated with the retired vocabulary) the migration removes
 *      the column and its CHECK, while every other column and every row survives
 *      byte-identical;
 *   3. NO VERDICT CHANGE — the acceptance property. The canonical READ verdict
 *      (via `filterReadableDashboards`, the /dashboards list consumer, which
 *      wraps the real resolver plus the project-grant gate) for every (row,
 *      actor) pair is computed from rows SELECTed out of the real table BEFORE
 *      the drop and again AFTER it: the two matrices must be identical, which is
 *      what makes dropping the demoted column a pure shape change rather than an
 *      authorization change. (WRITE authority never consulted the column even
 *      pre-cutover — it is owner-axis only — and is unit-covered in
 *      packages/dashboards/src/__tests__/permissions.test.ts.);
 *   4. IDEMPOTENCY + FAIL-LOUD + DOWN — a second run is a no-op, the
 *      postcondition RAISEs if the column somehow survives, and `down()`
 *      restores the column shape and its CHECK for a Phase-2-era rollback.
 *
 * Gated by CINATRA_DB_INTEGRATION_TESTS=1 + a live SUPABASE_DB_URL (same
 * contract as the sibling integration/** suites; excluded from the default run).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connect, createTestSchema, dropSchema } from "./_fixture";
// The CANONICAL /dashboards list consumer — it wraps the real
// `resolveDashboardAccess` plus the project-grant gate, so a verdict computed
// here is the verdict the product surface computes.
import {
  filterReadableDashboards,
  type DashboardActor,
} from "@cinatra-ai/dashboards/require-dashboard-access";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const ORG = "org-1898-p3";

type Mod = {
  buildUpSql: (schema?: string) => string[];
  buildDownSql: (schema?: string) => string[];
  buildDropVisibilitySql: (schema?: string) => string;
  buildPostconditionSql: (schema?: string) => string;
};

let mod: Mod;
let client: Client;
let schema: string;

/** Does `<schema>.dashboards` currently carry a `visibility` column? */
async function hasVisibilityColumn(target = schema): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'dashboards' AND column_name = 'visibility'`,
    [target],
  );
  return r.rowCount === 1;
}

/** The CHECK constraints currently defined on `<schema>.dashboards`. */
async function checkConstraintNames(target = schema): Promise<string[]> {
  const r = await client.query(
    `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class cls ON cls.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = cls.relnamespace
      WHERE ns.nspname = $1 AND cls.relname = 'dashboards' AND con.contype = 'c'
      ORDER BY con.conname`,
    [target],
  );
  return r.rows.map((row) => row.conname as string);
}

/** Re-add the demoted column + its CHECK: the shape an EXISTING (pre-Phase-3)
 *  deployment carries. The bootstrap DDL no longer creates it, so the upgrade
 *  path has to be reconstructed explicitly. */
async function makePreMigrationShape(target = schema): Promise<void> {
  for (const sql of mod.buildDownSql(target)) await client.query(sql);
}

type SeedRow = {
  id: string;
  ownerLevel: string;
  ownerId: string;
  projectId: string | null;
  /** The retired vocabulary value the pre-migration row carries. */
  visibility: "private" | "owners" | "members";
};

const SEED: SeedRow[] = [
  { id: "d-user", ownerLevel: "user", ownerId: "u1", projectId: null, visibility: "private" },
  { id: "d-team", ownerLevel: "team", ownerId: "team-a", projectId: null, visibility: "private" },
  { id: "d-team-members", ownerLevel: "team", ownerId: "team-a", projectId: null, visibility: "members" },
  { id: "d-org", ownerLevel: "organization", ownerId: ORG, projectId: null, visibility: "owners" },
  { id: "d-workspace", ownerLevel: "workspace", ownerId: ORG, projectId: null, visibility: "private" },
  { id: "d-project", ownerLevel: "organization", ownerId: ORG, projectId: "p1", visibility: "private" },
];

async function seedDashboards(target = schema): Promise<void> {
  for (const row of SEED) {
    await client.query(
      // `config_version` is deliberately OMITTED — the canonical DDL's column
      // DEFAULT supplies it, so this fixture never has to restate the config
      // version literal (and stays correct when that default moves).
      `INSERT INTO "${target}"."dashboards"
         (id, name, config_json, owner_level, owner_id,
          organization_id, visibility, status, created_by, project_id)
       VALUES ($1, $2, '{}'::jsonb, $3, $4, $5, $6, 'published', 'seed', $7)`,
      [row.id, `dash ${row.id}`, row.ownerLevel, row.ownerId, ORG, row.visibility, row.projectId],
    );
  }
}

/** Read the dashboards rows back the way the app does — SELECT *, so whatever
 *  columns the table actually has is what the resolver sees. */
async function readRows(target = schema): Promise<Record<string, unknown>[]> {
  const r = await client.query(`SELECT * FROM "${target}"."dashboards" ORDER BY id`);
  return r.rows as Record<string, unknown>[];
}

type ResolverRow = { id: string; projectId: string | null } & Record<string, unknown>;

/** Map a raw SELECT * row onto the camelCase row shape the resolver consumes.
 *  Deliberately a SPREAD of whatever the table actually returned — so if the
 *  column were still there the resolver would receive it. */
function toResolverRow(raw: Record<string, unknown>): ResolverRow {
  return {
    ...raw,
    id: String(raw.id),
    ownerLevel: raw.owner_level,
    ownerId: raw.owner_id,
    organizationId: raw.organization_id,
    projectId: (raw.project_id ?? null) as string | null,
  } as ResolverRow;
}

const ACTORS: { name: string; actor: DashboardActor }[] = [
  { name: "owning user", actor: { userId: "u1", organizationId: ORG, teamIds: [], orgRole: "member", teamRoles: {} } },
  { name: "other user", actor: { userId: "u2", organizationId: ORG, teamIds: [], orgRole: "member", teamRoles: {} } },
  { name: "team member", actor: { userId: "u3", organizationId: ORG, teamIds: ["team-a"], orgRole: "member", teamRoles: { "team-a": "member" } } },
  { name: "team admin", actor: { userId: "u4", organizationId: ORG, teamIds: ["team-a"], orgRole: "member", teamRoles: { "team-a": "admin" } } },
  { name: "org member", actor: { userId: "u5", organizationId: ORG, teamIds: [], orgRole: "member", teamRoles: {} } },
  { name: "org admin", actor: { userId: "u6", organizationId: ORG, teamIds: [], orgRole: "admin", teamRoles: {} } },
  { name: "cross-org member", actor: { userId: "u7", organizationId: "org-other", teamIds: [], orgRole: "admin", teamRoles: {} } },
  { name: "project p1 grantee", actor: { userId: "u8", organizationId: ORG, teamIds: [], orgRole: "member", teamRoles: {} } },
];

/** Project grants per actor (only the p1 grantee holds one). */
function grantsFor(name: string) {
  return name === "project p1 grantee"
    ? ([{ projectId: "p1", effectiveRole: "read" }] as const)
    : ([] as const);
}

/** The full (row × actor) READ verdict matrix, computed off REAL rows through
 *  the canonical list consumer. */
function verdictMatrix(rows: Record<string, unknown>[]): Record<string, string> {
  const out: Record<string, string> = {};
  const resolverRows = rows.map(toResolverRow);
  for (const { name, actor } of ACTORS) {
    const readable = new Set(
      filterReadableDashboards(resolverRows, actor, [...grantsFor(name)]).map((r) => r.id),
    );
    for (const row of resolverRows) out[`${row.id}|${name}`] = readable.has(row.id) ? "R" : "-";
  }
  return out;
}

/** Apply the migration inside ONE transaction (mirrors node-pg-migrate's wrap). */
async function applyMigration(target = schema): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const sql of mod.buildUpSql(target)) await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

let beforeRows: Record<string, unknown>[] = [];
let beforeMatrix: Record<string, string> = {};

beforeAll(async () => {
  mod = (await import(
    path.join(REPO_ROOT, "migrations", "core", "core__0087_drop-dashboards-visibility.mjs")
  )) as unknown as Mod;

  client = await connect();
  schema = await createTestSchema(client);
}, 90_000);

afterAll(async () => {
  if (client && schema) await dropSchema(client, schema);
  if (client) await client.end();
});

describe("core__0087 — the FRESH-install shape already has no visibility column", () => {
  it("the canonical bootstrap DDL creates `dashboards` without `visibility`", async () => {
    // createTestSchema ran buildCreateStoreSchemaQueries — the post-drop shape.
    expect(await hasVisibilityColumn()).toBe(false);
    expect(await checkConstraintNames()).not.toContain("dashboards_visibility_check");
  });
});

describe("core__0087 — the operator UPGRADE path", () => {
  it("reconstructs the pre-migration shape, seeds it, and captures the pre-drop verdicts", async () => {
    await makePreMigrationShape();
    expect(await hasVisibilityColumn()).toBe(true);
    expect(await checkConstraintNames()).toContain("dashboards_visibility_check");
    await seedDashboards();
    beforeRows = await readRows();
    expect(beforeRows).toHaveLength(SEED.length);
    // The rows genuinely carry the retired vocabulary (the column is populated).
    expect(new Set(beforeRows.map((r) => r.visibility))).toEqual(
      new Set(["private", "owners", "members"]),
    );
    beforeMatrix = verdictMatrix(beforeRows);
  });

  it("drops the column and its CHECK", async () => {
    await applyMigration();
    expect(await hasVisibilityColumn()).toBe(false);
    expect(await checkConstraintNames()).not.toContain("dashboards_visibility_check");
  });

  it("preserves every row and every OTHER column byte-identically", async () => {
    const after = await readRows();
    expect(after).toHaveLength(SEED.length);
    const strip = (rows: Record<string, unknown>[]) =>
      rows.map((row) => {
        const rest = { ...row };
        delete rest.visibility;
        return rest;
      });
    expect(after).toEqual(strip(beforeRows));
    // The SCOPE axis — the surviving ACL input — is intact on every row.
    for (const row of after) {
      expect(row.owner_level).toBeTruthy();
      expect(row.owner_id).toBeTruthy();
      expect(row.organization_id).toBe(ORG);
    }
  });
});

describe("core__0087 — ACCEPTANCE: the drop changes NO authorization verdict", () => {
  it("the (row × actor) READ matrix is identical before and after the drop", async () => {
    const afterMatrix = verdictMatrix(await readRows());
    expect(afterMatrix).toEqual(beforeMatrix);
    // Sanity: the matrix actually discriminates (not all-deny / all-allow).
    const values = new Set(Object.values(afterMatrix));
    expect(values.has("-")).toBe(true);
    expect(values.has("R")).toBe(true);
  });

  it("the WIDENING stays in force with the column gone (a plain team member reads a formerly owner-only row)", async () => {
    const rows = (await readRows()).map(toResolverRow);
    const teamMember = ACTORS.find((a) => a.name === "team member")!.actor;
    const readable = filterReadableDashboards(rows, teamMember, []).map((r) => r.id);
    // 'd-team' was seeded `private` and 'd-team-members' `members`: pre-cutover
    // the first was admin-only. Both read now — the SCOPE is the whole gate.
    expect(readable).toEqual(expect.arrayContaining(["d-team", "d-team-members"]));
    // …and the project row still needs its grant (no leak rides the drop).
    expect(readable).not.toContain("d-project");
    const grantee = ACTORS.find((a) => a.name === "project p1 grantee")!.actor;
    expect(filterReadableDashboards(rows, grantee, [{ projectId: "p1", effectiveRole: "read" }]).map((r) => r.id))
      .toContain("d-project");
  });
});

describe("core__0087 — idempotency", () => {
  it("a second run is a no-op (DROP COLUMN IF EXISTS)", async () => {
    const before = await readRows();
    await applyMigration();
    expect(await hasVisibilityColumn()).toBe(false);
    expect(await readRows()).toEqual(before);
  });
});

describe("core__0087 — FAIL-LOUD postcondition", () => {
  it("RAISEs when the column is still present", async () => {
    const other = await createTestSchema(client);
    // Re-add the column so the postcondition's invariant is violated.
    for (const sql of mod.buildDownSql(other)) await client.query(sql);
    let threw = false;
    await client.query("BEGIN");
    try {
      await client.query(mod.buildPostconditionSql(other));
      await client.query("COMMIT");
    } catch (err) {
      threw = true;
      await client.query("ROLLBACK");
      expect(String((err as Error).message)).toMatch(/core__0087|still present/i);
    }
    expect(threw).toBe(true);
    await dropSchema(client, other);
  });
});

describe("core__0087 — down() restores the Phase-2-era column shape", () => {
  it("re-adds `visibility` NOT NULL DEFAULT 'private' plus its CHECK", async () => {
    const other = await createTestSchema(client);
    for (const sql of mod.buildDownSql(other)) await client.query(sql);
    expect(await hasVisibilityColumn(other)).toBe(true);
    expect(await checkConstraintNames(other)).toContain("dashboards_visibility_check");

    // A Phase-2-era writer (which writes the column but never reads it) works…
    await client.query(
      `INSERT INTO "${other}"."dashboards"
         (id, name, config_json, owner_level, owner_id, organization_id, visibility, status, created_by)
       VALUES ('d-down', 'down', '{}'::jsonb, 'team', 'team-a', $1, 'members', 'published', 'seed')`,
      [ORG],
    );
    // …and the restored CHECK still rejects a value outside the retired vocabulary.
    await expect(
      client.query(
        `INSERT INTO "${other}"."dashboards"
           (id, name, config_json, owner_level, owner_id, organization_id, visibility, status, created_by)
         VALUES ('d-bad', 'bad', '{}'::jsonb, 'team', 'team-a', $1, 'nonsense', 'published', 'seed')`,
        [ORG],
      ),
    ).rejects.toThrow(/dashboards_visibility_check/);

    // down() is idempotent too (ADD COLUMN IF NOT EXISTS + duplicate_object swallow).
    for (const sql of mod.buildDownSql(other)) await client.query(sql);
    expect(await hasVisibilityColumn(other)).toBe(true);
    await dropSchema(client, other);
  });
});
