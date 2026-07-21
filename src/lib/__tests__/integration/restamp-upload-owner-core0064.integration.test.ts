/**
 * core__0064 re-stamp organization-wide UPLOAD rows to their uploader —
 * REAL-Postgres integration proof (epic cinatra#1883 C3, issue #1887).
 *
 * Drives the migration's exported SQL builders (`buildUpSql(schema)`) against a
 * fresh per-file schema built from the canonical DDL, seeded with:
 *   - default org-wide upload rows (with + without a project refinement) that
 *     MUST be re-stamped to their uploader (user/private, project_id kept);
 *   - an org-wide upload EXPLICITLY promoted to org (approved
 *     artifact_promotion_request) that MUST stay organization-visible;
 *   - an org-wide NON-upload (agent_generated) row that MUST NOT be touched;
 *   - an already-uploader-owned upload (a C1 write) — a no-op;
 *   - a team-promoted upload (visibility='team') — not org-visible, untouched;
 *   - a foreign-org default org upload — the backfill is org-agnostic, so it IS
 *     re-stamped.
 * Then re-runs to prove idempotency, and proves the FAIL-LOUD postcondition
 * RAISEs (rolling back) on a NULL-uploader org-visible upload anomaly.
 *
 * Gated by CINATRA_DB_INTEGRATION_TESTS=1 + a live SUPABASE_DB_URL (same
 * contract as the sibling integration/** suites; excluded from the default run).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connect, createTestSchema, dropSchema } from "./_fixture";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const ORG = "org-c3";
const ORG2 = "org-c3-other";

type Mod = {
  buildUpSql: (schema?: string) => string[];
  buildRestampSql: (schema?: string) => string;
  buildPostconditionSql: (schema?: string) => string;
};

let mod: Mod;
let client: Client;
let schema: string;

type SeedRow = {
  id?: string;
  orgId: string | null;
  ownerLevel: string;
  ownerId: string | null;
  visibility: string;
  projectId?: string | null;
  createdBy?: string | null;
  originKind?: string | null;
  type?: string;
};

async function seed(row: SeedRow): Promise<string> {
  const id = row.id ?? randomUUID();
  const data = row.originKind == null ? {} : { originKind: row.originKind };
  await client.query(
    `INSERT INTO "${schema}"."objects"
       (id, type, data, org_id, owner_level, owner_id, visibility, project_id, created_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      row.type ?? "@cinatra-ai/pdf-artifact:pdf",
      JSON.stringify(data),
      row.orgId,
      row.ownerLevel,
      row.ownerId,
      row.visibility,
      row.projectId ?? null,
      row.createdBy ?? null,
    ],
  );
  return id;
}

async function seedApprovedOrgPromotion(objectId: string, orgId: string): Promise<void> {
  await client.query(
    `INSERT INTO "${schema}"."artifact_promotion_request"
       (id, org_id, object_id, object_title, requested_by, from_visibility,
        to_visibility, to_owner_level, to_owner_id, row_version, status)
     VALUES ($1, $2, $3, 'seed', 'user-req', 'private',
        'organization', 'organization', $2, 1, 'approved')`,
    [randomUUID(), orgId, objectId],
  );
}

async function rowById(id: string): Promise<{
  owner_level: string;
  owner_id: string | null;
  visibility: string;
  project_id: string | null;
}> {
  const r = await client.query(
    `SELECT owner_level, owner_id, visibility, project_id
       FROM "${schema}"."objects" WHERE id = $1`,
    [id],
  );
  return r.rows[0];
}

/** Apply the migration's queued statements inside ONE transaction (mirrors the
 *  node-pg-migrate single-transaction wrap). Throws on any statement error
 *  after ROLLBACK — the fail-loud-on-partial-apply contract. */
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

// Seeded ids populated in beforeAll for the assertions.
const ids: Record<string, string> = {};

beforeAll(async () => {
  mod = (await import(
    path.join(
      REPO_ROOT,
      "migrations",
      "core",
      "core__0064_restamp-upload-rows-uploader-owned.mjs",
    )
  )) as unknown as Mod;

  client = await connect();
  schema = await createTestSchema(client);

  // a) default org-wide upload, no project → re-stamp to user/private.
  ids.defaultOrg = await seed({
    orgId: ORG, ownerLevel: "organization", ownerId: ORG, visibility: "organization",
    createdBy: "user-1", originKind: "upload",
  });
  // b) default org-wide upload WITH a project refinement → re-stamp, project kept.
  ids.projectRefined = await seed({
    orgId: ORG, ownerLevel: "organization", ownerId: ORG, visibility: "organization",
    projectId: "proj-x", createdBy: "user-2", originKind: "upload",
  });
  // c) org-wide upload EXPLICITLY promoted to org → MUST stay org-visible.
  ids.promoted = await seed({
    orgId: ORG, ownerLevel: "organization", ownerId: ORG, visibility: "organization",
    createdBy: "user-3", originKind: "upload",
  });
  await seedApprovedOrgPromotion(ids.promoted, ORG);
  // d) org-wide NON-upload (agent output) → MUST NOT be touched.
  ids.agentOrg = await seed({
    orgId: ORG, ownerLevel: "organization", ownerId: ORG, visibility: "organization",
    createdBy: "agent-run-1", originKind: "agent_generated",
  });
  // e) already uploader-owned upload (a C1 write) → no-op.
  ids.alreadyPrivate = await seed({
    orgId: ORG, ownerLevel: "user", ownerId: "user-4", visibility: "private",
    createdBy: "user-4", originKind: "upload",
  });
  // f) team-promoted upload (visibility='team') → not org-visible, untouched.
  ids.teamPromoted = await seed({
    orgId: ORG, ownerLevel: "team", ownerId: "team-a", visibility: "team",
    createdBy: "user-5", originKind: "upload",
  });
  // g) foreign-org default org upload → backfill is org-agnostic, re-stamped.
  ids.foreignOrg = await seed({
    orgId: ORG2, ownerLevel: "organization", ownerId: ORG2, visibility: "organization",
    createdBy: "user-9", originKind: "upload",
  });

  await applyMigration();
}, 60_000);

afterAll(async () => {
  if (client && schema) await dropSchema(client, schema);
  if (client) await client.end();
});

describe("core__0064 — re-stamp targets (real Postgres)", () => {
  it("re-stamps a default org-wide upload to its uploader (user/private)", async () => {
    const r = await rowById(ids.defaultOrg);
    expect(r).toMatchObject({ owner_level: "user", owner_id: "user-1", visibility: "private", project_id: null });
  });

  it("re-stamps a project-refined org upload and KEEPS project_id", async () => {
    const r = await rowById(ids.projectRefined);
    expect(r).toMatchObject({ owner_level: "user", owner_id: "user-2", visibility: "private", project_id: "proj-x" });
  });

  it("re-stamps a foreign-org default org upload too (org-agnostic backfill)", async () => {
    const r = await rowById(ids.foreignOrg);
    expect(r).toMatchObject({ owner_level: "user", owner_id: "user-9", visibility: "private" });
  });
});

describe("core__0064 — rows that MUST NOT be touched", () => {
  it("leaves an EXPLICITLY org-promoted upload organization-visible", async () => {
    const r = await rowById(ids.promoted);
    expect(r).toMatchObject({ owner_level: "organization", owner_id: ORG, visibility: "organization" });
  });

  it("leaves a NON-upload (agent_generated) org row untouched", async () => {
    const r = await rowById(ids.agentOrg);
    expect(r).toMatchObject({ owner_level: "organization", owner_id: ORG, visibility: "organization" });
  });

  it("leaves an already uploader-owned upload untouched (no-op)", async () => {
    const r = await rowById(ids.alreadyPrivate);
    expect(r).toMatchObject({ owner_level: "user", owner_id: "user-4", visibility: "private" });
  });

  it("leaves a team-promoted upload (visibility='team') untouched", async () => {
    const r = await rowById(ids.teamPromoted);
    expect(r).toMatchObject({ owner_level: "team", owner_id: "team-a", visibility: "team" });
  });
});

describe("core__0064 — acceptance invariant", () => {
  it("no upload-origin row remains organization-visible unless explicitly promoted", async () => {
    const r = await client.query(
      `SELECT o.id FROM "${schema}"."objects" o
        WHERE o.data->>'originKind' = 'upload'
          AND o.visibility = 'organization'
          AND o.id NOT IN (
            SELECT apr.object_id FROM "${schema}"."artifact_promotion_request" apr
             WHERE apr.status = 'approved' AND apr.to_visibility = 'organization')`,
    );
    expect(r.rows).toHaveLength(0);
  });
});

describe("core__0064 — idempotency", () => {
  it("a second run is a no-op (re-stamped rows already read private)", async () => {
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

describe("core__0064 — FAIL-LOUD on a NULL-uploader anomaly", () => {
  it("RAISEs and rolls back when an org-visible upload has no created_by", async () => {
    const anomalySchema = await createTestSchema(client);
    const anomalyId = randomUUID();
    await client.query(
      `INSERT INTO "${anomalySchema}"."objects"
         (id, type, data, org_id, owner_level, owner_id, visibility, created_by)
       VALUES ($1, 'up', '{"originKind":"upload"}'::jsonb, $2, 'organization', $2, 'organization', NULL)`,
      [anomalyId, ORG],
    );
    // Apply against the anomaly schema in one transaction — the postcondition
    // must RAISE, so the whole thing rolls back and the row is untouched.
    let threw = false;
    await client.query("BEGIN");
    try {
      for (const sql of mod.buildUpSql(anomalySchema)) {
        await client.query(sql);
      }
      await client.query("COMMIT");
    } catch (err) {
      threw = true;
      await client.query("ROLLBACK");
      expect(String((err as Error).message)).toMatch(/core__0064|remain/i);
    }
    expect(threw).toBe(true);
    // The anomaly row is unchanged (transaction rolled back).
    const r = await client.query(
      `SELECT visibility FROM "${anomalySchema}"."objects" WHERE id = $1`,
      [anomalyId],
    );
    expect(r.rows[0].visibility).toBe("organization");
    await dropSchema(client, anomalySchema);
  });
});
