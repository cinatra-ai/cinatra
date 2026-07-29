/**
 * core__0082 dashboard-twin scope-tuple backfill — REAL-Postgres integration
 * proof (epic cinatra#1883 §D7 Phase-2 ACL cutover, issue #1898).
 *
 * Drives the migration's exported SQL builders (`buildUpSql(schema)`) against a
 * fresh per-file schema built from the canonical DDL, seeded with PRE-cutover
 * dashboard-twin `objects` rows (the old conservative floor):
 *   - a project twin still carrying owner_level='team' → re-owned to the
 *     organization (private), so the object filter admits it ONLY via the project
 *     clause (the LEAK the cutover would otherwise open);
 *   - a workspace twin at visibility='private' → flipped to 'public' (org-local),
 *     so it does not DISAPPEAR from the library;
 *   - already-canonical user/team/org/project twins → untouched (no-op);
 *   - a NON-dashboard object row shaped like the leak class → untouched.
 * Then proves, via the REAL `buildOwnershipFilter`, that after the backfill the
 * library and the dashboard resolver AGREE on the re-mapped rows; proves
 * idempotency; and proves the FAIL-LOUD postcondition RAISEs on a surviving leak.
 *
 * Gated by CINATRA_DB_INTEGRATION_TESTS=1 + a live SUPABASE_DB_URL (same contract
 * as the sibling integration/** suites; excluded from the default unit run).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connect, createTestSchema, dropSchema } from "./_fixture";
import { buildOwnershipFilter } from "@/lib/derived-store-ownership";
import type { ActorContext } from "@/lib/authz/actor-context";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const ORG = "org-1898";
const DASH_TYPE = "@cinatra-ai/dashboard-artifact:dashboard";

type Mod = {
  buildUpSql: (schema?: string) => string[];
  buildProjectReownSql: (schema?: string) => string;
  buildWorkspacePublicSql: (schema?: string) => string;
  buildPostconditionSql: (schema?: string) => string;
};

let mod: Mod;
let client: Client;
let schema: string;

async function seed(row: {
  id?: string;
  type?: string;
  orgId: string;
  ownerLevel: string;
  ownerId: string;
  visibility: string;
  projectId?: string | null;
}): Promise<string> {
  const id = row.id ?? randomUUID();
  await client.query(
    `INSERT INTO "${schema}"."objects"
       (id, type, data, org_id, owner_level, owner_id, visibility, project_id, created_by)
     VALUES ($1, $2, '{}'::jsonb, $3, $4, $5, $6, $7, 'seed')`,
    [id, row.type ?? DASH_TYPE, row.orgId, row.ownerLevel, row.ownerId, row.visibility, row.projectId ?? null],
  );
  return id;
}

async function rowById(id: string): Promise<{
  owner_level: string;
  owner_id: string | null;
  visibility: string;
  project_id: string | null;
}> {
  const r = await client.query(
    `SELECT owner_level, owner_id, visibility, project_id FROM "${schema}"."objects" WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

/** Apply the migration's queued statements inside ONE transaction (mirrors the
 *  node-pg-migrate single-transaction wrap). Throws on any statement error after
 *  ROLLBACK — the fail-loud-on-partial-apply contract. */
async function applyMigration(): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const sql of mod.buildUpSql(schema)) {
      await client.query(sql);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/** IDs visible to `actor` among `<schema>.objects` via the REAL object filter. */
async function visibleIds(actor: ActorContext): Promise<Set<string>> {
  const frag = buildOwnershipFilter(actor);
  // Remap $1..$N → $2..$N+1 ($1 is a NULL org-slot placeholder, bypassed).
  const remapped = frag.sql.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + 1}`);
  const res = await client.query(
    `SELECT id FROM "${schema}"."objects"
      WHERE (org_id = $1 OR $1 IS NULL) AND deleted_at IS NULL AND ${remapped}`,
    [null, ...frag.params],
  );
  return new Set(res.rows.map((r) => r.id as string));
}

function actor(overrides: Partial<ActorContext>): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "u",
    authSource: "ui",
    organizationId: ORG,
    teamIds: [],
    projectIds: [],
    platformRole: "member",
    ...overrides,
  } as unknown as ActorContext;
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  mod = (await import(
    path.join(REPO_ROOT, "migrations", "core", "core__0082_dashboard-twin-scope-tuple-backfill.mjs")
  )) as unknown as Mod;

  client = await connect();
  schema = await createTestSchema(client);

  // LEAK class: a project twin still carrying the underlying team owner tier.
  ids.projTeam = await seed({ orgId: ORG, ownerLevel: "team", ownerId: "team-a", visibility: "private", projectId: "p1" });
  // DISAPPEAR class: a workspace twin still at the conservative 'private' floor.
  ids.workspace = await seed({ orgId: ORG, ownerLevel: "workspace", ownerId: ORG, visibility: "private" });
  // Already-canonical rows → untouched no-ops.
  ids.user = await seed({ orgId: ORG, ownerLevel: "user", ownerId: "u1", visibility: "private" });
  ids.team = await seed({ orgId: ORG, ownerLevel: "team", ownerId: "team-b", visibility: "team" });
  ids.org = await seed({ orgId: ORG, ownerLevel: "organization", ownerId: ORG, visibility: "organization" });
  ids.projOrg = await seed({ orgId: ORG, ownerLevel: "organization", ownerId: ORG, visibility: "private", projectId: "p2" });
  // A NON-dashboard object shaped like the leak class → MUST NOT be touched.
  ids.nonDash = await seed({ type: "@cinatra-ai/pdf-artifact:pdf", orgId: ORG, ownerLevel: "team", ownerId: "team-a", visibility: "private", projectId: "p1" });

  await applyMigration();
}, 60_000);

afterAll(async () => {
  if (client && schema) await dropSchema(client, schema);
  if (client) await client.end();
});

describe("core__0082 — re-mapping targets (real Postgres)", () => {
  it("re-owns a team-owned project twin to organization + private (project_id kept)", async () => {
    expect(await rowById(ids.projTeam)).toMatchObject({
      owner_level: "organization",
      owner_id: ORG,
      visibility: "private",
      project_id: "p1",
    });
  });

  it("flips a workspace twin to org-local public (owner axis untouched)", async () => {
    expect(await rowById(ids.workspace)).toMatchObject({
      owner_level: "workspace",
      owner_id: ORG,
      visibility: "public",
      project_id: null,
    });
  });
});

describe("core__0082 — rows that MUST NOT be touched", () => {
  it("leaves already-canonical user/team/org/project twins untouched", async () => {
    expect(await rowById(ids.user)).toMatchObject({ owner_level: "user", owner_id: "u1", visibility: "private" });
    expect(await rowById(ids.team)).toMatchObject({ owner_level: "team", owner_id: "team-b", visibility: "team" });
    expect(await rowById(ids.org)).toMatchObject({ owner_level: "organization", owner_id: ORG, visibility: "organization" });
    expect(await rowById(ids.projOrg)).toMatchObject({ owner_level: "organization", owner_id: ORG, visibility: "private", project_id: "p2" });
  });

  it("leaves a NON-dashboard object shaped like the leak class untouched", async () => {
    expect(await rowById(ids.nonDash)).toMatchObject({ owner_level: "team", owner_id: "team-a", visibility: "private", project_id: "p1" });
  });
});

describe("core__0082 — post-backfill library agreement (real object filter)", () => {
  it("a team member WITHOUT a project grant no longer sees the re-owned project twin (leak closed)", async () => {
    const teamMemberNoGrant = actor({ principalId: "u2", teamIds: ["team-a"], projectIds: [] });
    const seen = await visibleIds(teamMemberNoGrant);
    expect(seen.has(ids.projTeam)).toBe(false);
  });

  it("a project-p1 member DOES see the re-owned project twin", async () => {
    const projMember = actor({ principalId: "u3", teamIds: [], projectIds: ["p1"] });
    const seen = await visibleIds(projMember);
    expect(seen.has(ids.projTeam)).toBe(true);
  });

  it("a plain org member sees the now-public workspace twin", async () => {
    const orgMember = actor({ principalId: "u4", teamIds: [], projectIds: [] });
    const seen = await visibleIds(orgMember);
    expect(seen.has(ids.workspace)).toBe(true);
  });
});

describe("core__0082 — idempotency", () => {
  it("a second run is a no-op (re-mapped rows already on the canonical tuple)", async () => {
    const before = await client.query(
      `SELECT id, owner_level, owner_id, visibility, project_id FROM "${schema}"."objects" ORDER BY id`,
    );
    await applyMigration();
    const after = await client.query(
      `SELECT id, owner_level, owner_id, visibility, project_id FROM "${schema}"."objects" ORDER BY id`,
    );
    expect(after.rows).toEqual(before.rows);
  });
});

describe("core__0082 — FAIL-LOUD on a surviving leak", () => {
  it("the postcondition RAISEs when a project twin still carries a user/team owner clause", async () => {
    const leakSchema = await createTestSchema(client);
    const leakId = randomUUID();
    await client.query(
      `INSERT INTO "${leakSchema}"."objects"
         (id, type, data, org_id, owner_level, owner_id, visibility, project_id, created_by)
       VALUES ($1, $2, '{}'::jsonb, $3, 'team', 'team-x', 'private', 'p9', 'seed')`,
      [leakId, DASH_TYPE, ORG],
    );
    // Run the postcondition ALONE (skip the re-owning UPDATEs) so the leak survives
    // — the DO block must RAISE, rolling the transaction back.
    let threw = false;
    await client.query("BEGIN");
    try {
      await client.query(mod.buildPostconditionSql(leakSchema));
      await client.query("COMMIT");
    } catch (err) {
      threw = true;
      await client.query("ROLLBACK");
      expect(String((err as Error).message)).toMatch(/core__0082|owner clause/i);
    }
    expect(threw).toBe(true);
    await dropSchema(client, leakSchema);
  });
});
