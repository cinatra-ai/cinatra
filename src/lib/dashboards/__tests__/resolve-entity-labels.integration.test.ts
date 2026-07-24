/**
 * cinatra#1897 B4 — REAL node-postgres betterAuthDb integration proof for
 * `resolveEntityLabels`.
 *
 * The bug this pins: `resolveEntityLabels` reads team + organization display
 * names from the Better-Auth `public."team"` / `public."organization"` tables
 * over `betterAuthDb` (drizzle node-postgres). The original code interpolated a
 * JS array as `id = ANY(${[...ids]})`; Drizzle spreads that to `ANY(($1, $2))`
 * (a row-expression) which Postgres rejects at runtime — `42809 op ANY/ALL
 * (array) requires array on right side` (a single id degrades to `ANY($1)` →
 * `malformed array literal`). That threw a `DrizzleQueryError` → unhandled 500
 * on (a) any Dashboards tab with a team/org-homed Listed row and (b) the
 * add-picker for every org/team-homed candidate. The unit + app-db migration
 * proofs never exercised betterAuthDb, so it escaped — THIS suite closes that
 * gap by driving the real node-postgres path with MULTIPLE team + org ids
 * (pre-fix: the query throws; post-fix: the labels resolve).
 *
 * Skips without a real SUPABASE_DB_URL (the `*.integration.test.ts` tier is
 * excluded from the default run and lifted only by CINATRA_DB_INTEGRATION_TESTS=1
 * against a live pg). Cleanup-safe: it probes for the two Better-Auth tables and
 * creates the minimal shape ONLY when absent, tracking that so `afterAll` DROPs
 * exactly the tables this test created (never a pre-existing Better-Auth table)
 * and otherwise only DELETEs its own rows. The seed provides the full Better-Auth
 * required-column set for `public."team"` / `public."organization"` (the exact
 * schema this Better-Auth-targeted query reads), so it round-trips against both a
 * fresh CI DB and a migrated Better-Auth DB.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");

const RUN = Date.now();
const ORG_A = `it-1897-orgA-${RUN}`;
const ORG_B = `it-1897-orgB-${RUN}`;
const TEAM_A = `it-1897-teamA-${RUN}`;
const TEAM_B = `it-1897-teamB-${RUN}`;
const ORG_A_NAME = "Acme Corp (it-1897)";
const ORG_B_NAME = "Globex (it-1897)";
const TEAM_A_NAME = "Growth (it-1897)";
const TEAM_B_NAME = "Product (it-1897)";

let client: Client;
let createdOrgTable = false;
let createdTeamTable = false;
let resolveEntityLabels: typeof import("@/lib/dashboards/scope-dashboards-service").resolveEntityLabels;

async function tableExists(qualified: string): Promise<boolean> {
  const r = await client.query<{ reg: string | null }>(
    `SELECT to_regclass($1) AS reg`,
    [qualified],
  );
  return r.rows[0]?.reg != null;
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  // betterAuthDb reads SUPABASE_DB_URL directly at first query; it is already the
  // live pg (this suite seeds the SAME database via the pg Client below).
  process.env.SUPABASE_DB_URL = DB_URL;

  client = new Client({ connectionString: DB_URL });
  await client.connect();

  // Probe BEFORE creating so afterAll can drop exactly what this test created and
  // never touch a pre-existing (migrated) Better-Auth table.
  createdOrgTable = !(await tableExists('public."organization"'));
  createdTeamTable = !(await tableExists('public."team"'));
  if (createdOrgTable) {
    await client.query(`
      CREATE TABLE public."organization" (
        id text PRIMARY KEY,
        name text NOT NULL,
        slug text,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }
  if (createdTeamTable) {
    await client.query(`
      CREATE TABLE public."team" (
        id text PRIMARY KEY,
        name text NOT NULL,
        "organizationId" text,
        slug text,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  // Seed two orgs + two teams (distinct ids → MULTIPLE-id ANY(...) binding).
  for (const [id, name, slug] of [
    [ORG_A, ORG_A_NAME, `it-1897-orga-${RUN}`],
    [ORG_B, ORG_B_NAME, `it-1897-orgb-${RUN}`],
  ] as const) {
    await client.query(
      `INSERT INTO public."organization" (id, name, slug, "createdAt")
       VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
      [id, name, slug],
    );
  }
  for (const [id, name, org, slug] of [
    [TEAM_A, TEAM_A_NAME, ORG_A, `it-1897-teama-${RUN}`],
    [TEAM_B, TEAM_B_NAME, ORG_A, `it-1897-teamb-${RUN}`],
  ] as const) {
    await client.query(
      `INSERT INTO public."team" (id, name, "organizationId", slug, "createdAt")
       VALUES ($1, $2, $3, $4, now()) ON CONFLICT (id) DO NOTHING`,
      [id, name, org, slug],
    );
  }

  ({ resolveEntityLabels } = await import(
    "@/lib/dashboards/scope-dashboards-service"
  ));
});

afterAll(async () => {
  if (!HAS_REAL_DB || !client) return;
  // Drop a table ONLY if this test created it; otherwise remove just our rows so a
  // pre-existing (migrated) Better-Auth table and its data are left intact.
  if (createdTeamTable) {
    await client.query(`DROP TABLE IF EXISTS public."team"`);
  } else {
    await client.query(`DELETE FROM public."team" WHERE id = ANY($1::text[])`, [
      [TEAM_A, TEAM_B],
    ]);
  }
  if (createdOrgTable) {
    await client.query(`DROP TABLE IF EXISTS public."organization"`);
  } else {
    await client.query(
      `DELETE FROM public."organization" WHERE id = ANY($1::text[])`,
      [[ORG_A, ORG_B]],
    );
  }
  await client.end();
});

describe.skipIf(!HAS_REAL_DB)(
  "resolveEntityLabels — real node-postgres betterAuthDb path",
  () => {
    it("resolves entity-named labels for MULTIPLE team ids (ANY(ARRAY[...]) binds, no runtime array error)", async () => {
      const labels = await resolveEntityLabels([
        { kind: "team", id: TEAM_A },
        { kind: "team", id: TEAM_B },
      ]);
      expect(labels.get(`team:${TEAM_A}`)).toBe(`Team: ${TEAM_A_NAME}`);
      expect(labels.get(`team:${TEAM_B}`)).toBe(`Team: ${TEAM_B_NAME}`);
    });

    it("resolves entity-named labels for MULTIPLE organization ids", async () => {
      const labels = await resolveEntityLabels([
        { kind: "organization", id: ORG_A },
        { kind: "organization", id: ORG_B },
      ]);
      expect(labels.get(`organization:${ORG_A}`)).toBe(
        `Organization: ${ORG_A_NAME}`,
      );
      expect(labels.get(`organization:${ORG_B}`)).toBe(
        `Organization: ${ORG_B_NAME}`,
      );
    });

    it("mixes team + org homes in one resolve, and falls back to the tier prefix for an unknown id", async () => {
      const labels = await resolveEntityLabels([
        { kind: "team", id: TEAM_A },
        { kind: "organization", id: ORG_A },
        { kind: "team", id: `${TEAM_A}-missing` },
      ]);
      expect(labels.get(`team:${TEAM_A}`)).toBe(`Team: ${TEAM_A_NAME}`);
      expect(labels.get(`organization:${ORG_A}`)).toBe(
        `Organization: ${ORG_A_NAME}`,
      );
      // A name that resolves to nothing degrades to the bare tier prefix.
      expect(labels.get(`team:${TEAM_A}-missing`)).toBe("Team");
    });
  },
);
