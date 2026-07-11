/**
 * Proof for the M1 org-anchor backfill migration (cinatra-ai/cinatra#1125, P0
 * of the admin-extension-parity epic #1124):
 *
 *   migrations/core/core__0017_org-anchor-backfill.mjs
 *
 * The DB-gated suite seeds a real Postgres (per-test app schema + the committed
 * Better-Auth public schema) with every anchor class the migration must handle,
 * runs the REAL migration up() through an owned-transaction pgm shim, and
 * asserts the outcome, then re-runs up() to prove target-table idempotency:
 *
 *   A. connector org-anchor normalization — user/team-owned and malformed
 *      organization-tier connector rows become owner_level='organization',
 *      owner_id = organization_id; a platform bundle anchor is untouched;
 *   B. generic USER-owned backfill — org-less non-connector rows get their
 *      owning user's sole organization; a user with 0/>1 memberships is LEFT
 *      org-less (un-attributable);
 *   C. identity-collision merge — a backfill onto a taken identity merges the
 *      loser into the survivor (co-owners UNIONed, loser policy dropped in
 *      favor of the survivor's + audited, loser row deleted);
 *   D. nango_connection org backfill — live org-less identity rows get the
 *      owner's org; a soft-deleted or unresolvable row is untouched/left null.
 *
 * The no-DB shape assertions always run; the DB suite self-skips without a real
 * SUPABASE_DB_URL (same contract as the sibling integration tests). Locally:
 * point SUPABASE_DB_URL at a dev Postgres and run with
 * CINATRA_DB_INTEGRATION_TESTS=1.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
// the migration module is plain ESM — import the real artifact, no copy
import {
  REPORT_METADATA_KEY,
  up as backfillUp,
  down as backfillDown,
} from "../../../../migrations/core/core__0017_org-anchor-backfill.mjs";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused") &&
  !dbUrl.includes("build:build@127.0.0.1:5432/build");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PUBLIC_SCHEMA_SQL = path.join(REPO_ROOT, "tests/e2e/rbac/fixtures/public-schema.sql");

async function applyStoreDdl(client: Client, schema: string): Promise<void> {
  for (const q of buildCreateStoreSchemaQueries(schema)) {
    const head = q.text.trim().slice(0, 6).toUpperCase();
    if (
      head !== "CREATE" &&
      head !== "ALTER " &&
      head !== "DROP T" &&
      head !== "DROP S" &&
      head !== "DELETE" &&
      head !== "UPDATE" &&
      head !== "DO $$ " &&
      !head.startsWith("DO $$")
    ) {
      continue;
    }
    await client.query(q.text);
  }
}

/**
 * pgm shim for the migration's owned-transaction model: it uses ONLY
 * pgm.noTransaction() + pgm.db.query, so the test client suffices. Unqualified
 * table names in the migration ride the session search_path set by runBackfill.
 */
function pgmFor(client: Client) {
  return {
    noTransaction() {},
    db: { query: (text: string, values?: unknown[]) => client.query(text, values) },
  };
}

async function runBackfill(client: Client, schema: string): Promise<void> {
  await client.query(`SET search_path TO "${schema}"`);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await backfillUp(pgmFor(client) as any);
  } finally {
    await client.query(`SET search_path TO public`);
  }
}

const LOCAL_SOURCE = (pkg: string) =>
  JSON.stringify({ type: "local", path: `connector:${pkg}`, resolvedCommitOrTreeHash: "h" });

describe("core__0017 org-anchor backfill — artifact shape (no DB needed)", () => {
  it("exports up() + a NO-OP down() + the provenance report key", () => {
    expect(typeof backfillUp).toBe("function");
    expect(typeof backfillDown).toBe("function");
    expect(backfillDown()).toBeUndefined(); // NO-OP revert
    expect(REPORT_METADATA_KEY).toBe("org_anchor_backfill_report:v1");
  });

  it("ships its append-only ledger entry (migrations/manifest.json seq 0017)", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "migrations/manifest.json"), "utf8"));
    const entry = manifest.migrations.find((m: { seq: string }) => m.seq === "0017");
    expect(entry).toBeDefined();
    expect(entry.file).toBe("core/core__0017_org-anchor-backfill.mjs");
    expect(entry.destructive).toBe(true);
    expect(entry.tables).toContain("installed_extension");
    expect(entry.tables).toContain("nango_connection");
    expect(entry.tables).toContain("extension_access_policy");
    expect(entry.tables).toContain("extension_co_owners");
  });
});

describe.skipIf(!hasDb)("core__0017 org-anchor backfill — real Postgres (DB-gated)", () => {
  let client: Client;
  let schema: string;
  const t = randomUUID().replace(/-/g, "").slice(0, 10);

  // Unique ids (public schema is shared across parallel test files).
  const O1 = `org1_${t}`;
  const O2 = `org2_${t}`;
  const uSolo = `usolo_${t}`;
  const uMulti = `umulti_${t}`;
  const uNone = `unone_${t}`;
  const uCo1 = `uco1_${t}`;
  const uCo2 = `uco2_${t}`;
  const team1 = `team1_${t}`;
  const publicUserIds = [uSolo, uMulti, uNone, uCo1, uCo2];
  const publicOrgIds = [O1, O2];

  // installed_extension ids
  const A1 = `a1_${t}`;
  const A2 = `a2_${t}`;
  const A3 = `a3_${t}`;
  const A4S = `a4s_${t}`;
  const A4L = `a4l_${t}`;
  const A5 = `a5_${t}`;
  const B1 = `b1_${t}`;
  const B2S = `b2s_${t}`;
  const B2L = `b2l_${t}`;
  const B3 = `b3_${t}`;
  const B4 = `b4_${t}`;
  const B5S = `b5s_${t}`;
  const B5L = `b5l_${t}`;

  type Row = Record<string, unknown>;
  const iextById = async (): Promise<Map<string, Row>> => {
    const r = await client.query(`SELECT * FROM "${schema}".installed_extension ORDER BY id`);
    return new Map(r.rows.map((x: Row) => [x.id as string, x]));
  };
  const coOwnersOf = async (kind: string, resourceId: string): Promise<string[]> => {
    const r = await client.query(
      `SELECT user_id FROM "${schema}".extension_co_owners
        WHERE resource_kind = $1 AND resource_id = $2 ORDER BY user_id`,
      [kind, resourceId],
    );
    return r.rows.map((x: Row) => x.user_id as string);
  };
  const policyOf = async (kind: string, resourceId: string): Promise<Row | null> => {
    const r = await client.query(
      `SELECT policy, installed_by_user_id FROM "${schema}".extension_access_policy
        WHERE resource_kind = $1 AND resource_id = $2`,
      [kind, resourceId],
    );
    return r.rows[0] ?? null;
  };
  const nangoById = async (): Promise<Map<string, Row>> => {
    const r = await client.query(`SELECT * FROM "${schema}".nango_connection ORDER BY connection_id`);
    return new Map(r.rows.map((x: Row) => [x.connection_id as string, x]));
  };
  const readReport = async (): Promise<Row> => {
    const r = await client.query(`SELECT value FROM "${schema}".metadata WHERE key = $1`, [
      REPORT_METADATA_KEY,
    ]);
    return JSON.parse(r.rows[0].value as string);
  };

  const insertIext = async (
    id: string,
    pkg: string,
    ownerLevel: string,
    ownerId: string,
    orgId: string | null,
    kind: string,
  ) => {
    await client.query(
      // version is NOT NULL since cinatra#1040 S1 (version identity); these
      // legacy local-source rows carry no source.version, so they floor to
      // '0.0.0' (the backfill floor for version-less sources).
      // The dependencies jsonb column is GONE since cinatra#1040 S2 (edges
      // live in extension_dependency_edge; these fixture rows declare none).
      `INSERT INTO "${schema}".installed_extension
        (id, package_name, owner_level, owner_id, organization_id, kind, status, source, required_in_prod, manifest_hash, version)
        VALUES ($1,$2,$3,$4,$5,$6,'active',$7::jsonb,$8,null,'0.0.0')`,
      [id, pkg, ownerLevel, ownerId, orgId, kind, LOCAL_SOURCE(pkg), kind === "connector" && ownerLevel === "platform"],
    );
  };
  const insertPolicy = async (kind: string, resourceId: string, tag: string, installedBy: string | null) => {
    await client.query(
      `INSERT INTO "${schema}".extension_access_policy (resource_kind, resource_id, policy, installed_by_user_id)
       VALUES ($1,$2,$3::jsonb,$4)`,
      [kind, resourceId, JSON.stringify({ tag }), installedBy],
    );
  };
  const insertCoOwner = async (kind: string, resourceId: string, userId: string, grantedBy: string) => {
    await client.query(
      `INSERT INTO "${schema}".extension_co_owners (resource_kind, resource_id, user_id, granted_by)
       VALUES ($1,$2,$3,$4)`,
      [kind, resourceId, userId, grantedBy],
    );
  };
  const insertNango = async (
    orgId: string | null,
    ownerUserId: string,
    key: string,
    connectionId: string,
    deleted: boolean,
  ) => {
    await client.query(
      `INSERT INTO "${schema}".nango_connection
        (organization_id, connector_package_id, connector_key, connection_id, owner_user_id, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [orgId, `@cinatra-ai/${key}-connector`, key, connectionId, ownerUserId, deleted ? new Date() : null],
    );
  };

  beforeAll(async () => {
    client = new Client({ connectionString: dbUrl });
    await client.connect();
    // Provision the Better-Auth public schema (the app DDL FKs reference it).
    await client.query(readFileSync(PUBLIC_SCHEMA_SQL, "utf8"));

    schema = `cinatra_orgbf_${t}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await applyStoreDdl(client, schema);

    // --- public fixtures (unique ids; deleted in afterAll) ---
    for (const o of publicOrgIds) {
      await client.query(
        `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1,$2,$3, now())`,
        [o, `Org ${o}`, o],
      );
    }
    for (const u of publicUserIds) {
      await client.query(
        `INSERT INTO public."user" (id, name, email, "emailVerified") VALUES ($1,$2,$3,true)`,
        [u, `User ${u}`, `${u}@example.test`],
      );
    }
    await client.query(
      `INSERT INTO public."team" (id, name, "organizationId", slug) VALUES ($1,'T1',$2,$3)`,
      [team1, O1, `team-${t}`],
    );
    const member = async (org: string, user: string, role: string) =>
      client.query(
        `INSERT INTO public."member" (id, "organizationId", "userId", role, "createdAt") VALUES ($1,$2,$3,$4, now())`,
        [`m_${org}_${user}`, org, user, role],
      );
    await member(O1, uSolo, "owner"); // uSolo: sole org O1
    await member(O1, uMulti, "admin"); // uMulti: two orgs → unresolvable
    await member(O2, uMulti, "admin");
    // uNone: no membership → unresolvable

    // --- A: connectors ---
    await insertIext(A1, "@scope/a-conn", "user", uSolo, null, "connector");
    await insertCoOwner("connector", A1, uCo1, uSolo); // must survive the re-anchor
    await insertIext(A2, "@scope/b-conn", "user", uSolo, O1, "connector"); // user level WITH org
    await insertIext(A3, "@scope/c-conn", "organization", uSolo, O1, "connector"); // malformed: owner_id!=org
    await insertIext(A4S, "@scope/d-conn", "organization", O1, O1, "connector"); // valid survivor
    await insertPolicy("connector", A4S, "survivor", uSolo);
    await insertCoOwner("connector", A4S, uCo1, uSolo);
    await insertIext(A4L, "@scope/d-conn", "user", uSolo, null, "connector"); // loser → merges into A4S
    await insertPolicy("connector", A4L, "loser", uSolo);
    await insertCoOwner("connector", A4L, uCo2, uSolo);
    await insertIext(A5, "@scope/e-conn", "platform", "__platform__", null, "connector"); // bundle anchor: untouched

    // --- B: generic user-owned ---
    await insertIext(B1, "@scope/f-art", "user", uSolo, null, "artifact");
    await insertCoOwner("artifact", B1, uCo1, uSolo); // resource_id stable across backfill
    await insertIext(B2S, "@scope/g-art", "user", uSolo, O1, "artifact"); // survivor (org set → not a candidate)
    await insertPolicy("artifact", B2S, "survivor2", uSolo);
    await insertIext(B2L, "@scope/g-art", "user", uSolo, null, "artifact"); // loser → merges into B2S
    await insertCoOwner("artifact", B2L, uCo2, uSolo);
    await insertIext(B3, "@scope/h-agent", "user", uMulti, null, "agent"); // unresolvable (2 orgs)
    await insertIext(B4, "@scope/i-agent", "user", uNone, null, "agent"); // unresolvable (0 orgs)
    // B5: agent (a NON-installed-extension-anchored kind) collision → the merge
    // is delete-only (no policy/co-owner reconciliation by installed_extension.id).
    await insertIext(B5S, "@scope/j-agent", "user", uSolo, O1, "agent"); // survivor (org set → not a candidate)
    await insertIext(B5L, "@scope/j-agent", "user", uSolo, null, "agent"); // loser → merges (delete-only)

    // --- C: nango ---
    await insertNango(null, uSolo, "github", `cid1_${t}`, false); // → O1
    await insertNango(null, uMulti, "gmail", `cid2_${t}`, false); // → left null
    await insertNango(null, uSolo, "linkedin", `cid3_${t}`, true); // deleted → untouched
    await insertNango(O1, uSolo, "apollo", `cid4_${t}`, false); // already org → untouched
  });

  afterAll(async () => {
    if (schema) await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    // remove the seeded public rows (app schema is gone → no FK back-references)
    await client.query(`DELETE FROM public."member" WHERE "organizationId" = ANY($1::text[])`, [publicOrgIds]);
    await client.query(`DELETE FROM public."team" WHERE id = $1`, [team1]);
    await client.query(`DELETE FROM public."user" WHERE id = ANY($1::text[])`, [publicUserIds]);
    await client.query(`DELETE FROM public."organization" WHERE id = ANY($1::text[])`, [publicOrgIds]);
    await client.end();
  });

  it("normalizes connectors, backfills user rows, merges collisions, and backfills nango — then re-runs as a no-op", async () => {
    await runBackfill(client, schema);
    const after = await iextById();

    // A1: user connector, no org → org anchor; its co-owner survives (resource_id stable)
    expect(after.get(A1)).toMatchObject({ owner_level: "organization", owner_id: O1, organization_id: O1 });
    expect(await coOwnersOf("connector", A1)).toEqual([uCo1]);
    // A2: user connector WITH org → org anchor
    expect(after.get(A2)).toMatchObject({ owner_level: "organization", owner_id: O1, organization_id: O1 });
    // A3: malformed org connector (owner_id != org) → owner_id fixed to org
    expect(after.get(A3)).toMatchObject({ owner_level: "organization", owner_id: O1, organization_id: O1 });

    // A4: loser merged into survivor
    expect(after.has(A4L)).toBe(false); // loser deleted
    expect(after.get(A4S)).toMatchObject({ owner_level: "organization", owner_id: O1, organization_id: O1 });
    expect(await coOwnersOf("connector", A4S)).toEqual([uCo1, uCo2]); // unioned
    expect(await policyOf("connector", A4S)).toMatchObject({ policy: { tag: "survivor" } }); // survivor wins
    expect(await policyOf("connector", A4L)).toBeNull(); // loser policy dropped

    // A5: platform bundle anchor untouched
    expect(after.get(A5)).toMatchObject({ owner_level: "platform", owner_id: "__platform__", organization_id: null });

    // B1: generic user backfill — owner stays user, org set; co-owner survives
    expect(after.get(B1)).toMatchObject({ owner_level: "user", owner_id: uSolo, organization_id: O1 });
    expect(await coOwnersOf("artifact", B1)).toEqual([uCo1]);
    // B2: loser merged into survivor
    expect(after.has(B2L)).toBe(false);
    expect(after.get(B2S)).toMatchObject({ owner_level: "user", owner_id: uSolo, organization_id: O1 });
    expect(await coOwnersOf("artifact", B2S)).toContain(uCo2);
    expect(await policyOf("artifact", B2S)).toMatchObject({ policy: { tag: "survivor2" } });
    // B5: non-anchored (agent) collision → loser deleted, survivor intact (delete-only merge)
    expect(after.has(B5L)).toBe(false);
    expect(after.get(B5S)).toMatchObject({ owner_level: "user", owner_id: uSolo, organization_id: O1 });
    // B3/B4: unresolvable → left org-less
    expect(after.get(B3)).toMatchObject({ organization_id: null });
    expect(after.get(B4)).toMatchObject({ organization_id: null });

    // C: nango
    const nango = await nangoById();
    expect(nango.get(`cid1_${t}`)).toMatchObject({ organization_id: O1 }); // resolvable → set
    expect(nango.get(`cid2_${t}`)).toMatchObject({ organization_id: null }); // unresolvable
    expect(nango.get(`cid3_${t}`)).toMatchObject({ organization_id: null }); // deleted → untouched
    expect(nango.get(`cid4_${t}`)).toMatchObject({ organization_id: O1 }); // already had → untouched

    // provenance report
    const report = await readReport();
    expect(report.counts).toMatchObject({
      connectorReanchored: 3, // A1, A2, A3
      connectorMerged: 1, // A4
      userBackfilled: 1, // B1
      userMerged: 2, // B2 (artifact), B5 (agent)
      nangoBackfilled: 1, // C1
      skippedUnresolvable: 3, // B3, B4, C2
    });
    const a4merge = (report.merges as Row[]).find((m) => m.loserId === A4L);
    expect(a4merge).toMatchObject({ survivorId: A4S, policyOutcome: "dropped-survivor-wins" });
    expect((a4merge as Row).droppedLoserPolicy).toMatchObject({ policy: { tag: "loser" } }); // recoverable
    // the non-anchored (agent) merge records the delete-only outcome
    const b5merge = (report.merges as Row[]).find((m) => m.loserId === B5L);
    expect(b5merge).toMatchObject({ survivorId: B5S, policyOutcome: "not-anchored-kind" });

    // --- IDEMPOTENCY: a second up() mutates NO target table ---
    const beforeRerun = {
      iext: await iextById(),
      nango: await nangoById(),
      a4co: await coOwnersOf("connector", A4S),
      b2co: await coOwnersOf("artifact", B2S),
    };
    await runBackfill(client, schema);
    const afterRerun = await iextById();
    expect([...afterRerun.keys()].sort()).toEqual([...beforeRerun.iext.keys()].sort());
    for (const [id, row] of afterRerun) expect(row).toEqual(beforeRerun.iext.get(id));
    const nangoRerun = await nangoById();
    for (const [cid, row] of nangoRerun) expect(row).toEqual(beforeRerun.nango.get(cid));
    expect(await coOwnersOf("connector", A4S)).toEqual(beforeRerun.a4co);
    expect(await coOwnersOf("artifact", B2S)).toEqual(beforeRerun.b2co);
  });
});
