/**
 * Proof for the core__0033 ownership-vocabulary one-shot normalization
 * (cinatra#1428, epic #1424) + the #1428 acceptance-criterion-1 round-trip:
 *
 *   migrations/core/core__0033_objects-ownership-vocabulary.mjs
 *
 * The DB-gated suite seeds a real Postgres schema with rows in BOTH retired
 * vocabularies — composite-string visibility values as the pre-cutover
 * artifact path wrote them ('org', 'workspace', 'team:<id>', 'user:<id>',
 * 'project:<id>', 'owner', junk) and legacy lazy-backfill owner_type tuples —
 * alongside canonical object-save rows, runs the REAL migration up() through
 * an owned-connection pgm shim, and asserts:
 *
 *   A. every composite row lands on the FIXED mapping (column model);
 *   B. canonical rows are byte-untouched;
 *   C. re-running up() is a no-op (idempotency);
 *   D. round-trip (AC1): for actors at every owner level (user / team /
 *      organization / workspace incl. team ids / project refinement), the
 *      shared ownership filter — the ONE SQL path both the objects read
 *      surface and the artifact read surface splice — returns the SAME
 *      visibility verdict for object-save-written rows and (formerly
 *      composite) artifact-written rows.
 *
 * The no-DB shape assertions always run; the DB suite self-skips without a
 * real SUPABASE_DB_URL (same contract as the sibling integration tests).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import type { Client } from "pg";

import { buildOwnershipFilter } from "@/lib/derived-store-ownership";
import type { ActorContext } from "@/lib/authz/actor-context";
// the migration module is plain ESM — import the real artifact, no copy
import {
  up as vocabUp,
  down as vocabDown,
} from "../../../../migrations/core/core__0033_objects-ownership-vocabulary.mjs";
// The ledger every consumer sees is the manifest.json + manifest.d/ union.
import { readManifestUnion } from "../../../../migrations/manifest-reader.mjs";
import {
  connect,
  createTestSchema,
  dropSchema,
  insertObject,
  selectVisibleIds,
} from "./_fixture";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused") &&
  !dbUrl.includes("build:build@127.0.0.1:5432/build");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

/**
 * pgm shim for the migration: core__0033 uses ONLY `await pgm.db.query`, so
 * the test client suffices. Unqualified table names ride the session
 * search_path set by runVocabularyMigration.
 */
function pgmFor(client: Client) {
  return {
    db: { query: (text: string, values?: unknown[]) => client.query(text, values) },
  };
}

async function runVocabularyMigration(client: Client, schema: string): Promise<void> {
  await client.query(`SET search_path TO "${schema}"`);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await vocabUp(pgmFor(client) as any);
  } finally {
    await client.query(`SET search_path TO public`);
  }
}

type OwnershipRow = {
  owner_level: string;
  owner_id: string | null;
  visibility: string | null;
  project_id: string | null;
};

async function readOwnership(
  client: Client,
  schema: string,
  id: string,
): Promise<OwnershipRow> {
  const res = await client.query(
    `SELECT owner_level, owner_id, visibility, project_id
       FROM "${schema}"."objects" WHERE id = $1`,
    [id],
  );
  return res.rows[0] as OwnershipRow;
}

describe("core__0033 ownership-vocabulary — artifact shape (no DB needed)", () => {
  it("exports up() + a refusing down() (one-shot cutover, not reversible)", async () => {
    expect(typeof vocabUp).toBe("function");
    expect(typeof vocabDown).toBe("function");
    await expect(vocabDown()).rejects.toThrow(/one-shot ownership-vocabulary cutover/);
  });

  it("ships its append-only ledger fragment (union ledger seq 0033)", () => {
    const { entries, errors } = readManifestUnion(path.join(REPO_ROOT, "migrations")) as {
      entries: Array<{ seq: string; file: string; destructive: boolean; tables: string[] }>;
      errors: string[];
    };
    expect(errors).toEqual([]);
    const entry = entries.find((m) => m.seq === "0033");
    expect(entry).toBeDefined();
    expect(entry?.file).toBe("core/core__0033_objects-ownership-vocabulary.mjs");
    expect(entry?.destructive).toBe(true);
    expect(entry?.tables).toEqual(["objects"]);
  });
});

describe.skipIf(!hasDb)(
  "core__0033 ownership-vocabulary — real Postgres (DB-gated)",
  () => {
    let client: Client;
    let schema: string;

    const orgA = "org-A";
    const orgB = "org-B";
    const U1 = "user-U1";
    const T1 = "team-T1";
    const P1 = "proj-P1";

    // Pre-cutover composite rows (as the old artifact path wrote them).
    let cOrg = "";
    let cWorkspace = "";
    let cTeam = "";
    let cUser = "";
    let cProject = "";
    let cOwnerLegacy = "";
    let cJunk = "";
    // Adversarial mixed row: composite visibility AND a conflicting legacy
    // owner_type. The fixed mapping must win on run 1 AND the owner axis
    // must stay settled on a re-run (sequence idempotency — owner_type is
    // retired by the final pass, so pass 0 can never re-fire).
    let cMixed = "";
    // Canonical object-save rows (must be untouched + round-trip).
    let kUser = "";
    let kTeam = "";
    let kOrg = "";
    let kPublic = "";
    let kProject = "";
    // Cross-org control (must never surface to orgA actors).
    let kOrgB = "";

    beforeAll(async () => {
      client = await connect();
      schema = await createTestSchema(client);

      // ---- retired composite vocabulary (pre-cutover artifact writes)
      cOrg = await insertObject(client, schema, {
        orgId: orgA,
        ownerLevel: "organization",
        ownerId: orgA,
        visibility: "org",
      });
      cWorkspace = await insertObject(client, schema, {
        orgId: orgA,
        ownerLevel: "workspace",
        ownerId: "workspace",
        visibility: "workspace",
      });
      cTeam = await insertObject(client, schema, {
        orgId: orgA,
        ownerLevel: "team",
        ownerId: T1,
        visibility: `team:${T1}`,
      });
      cUser = await insertObject(client, schema, {
        orgId: orgA,
        ownerLevel: "user",
        ownerId: U1,
        visibility: `user:${U1}`,
      });
      cProject = await insertObject(client, schema, {
        orgId: orgA,
        ownerLevel: "organization",
        ownerId: orgA,
        visibility: `project:${P1}`,
      });
      // Legacy lazy-backfill tuple: owner_type recorded, owner_level left at
      // the bare column default, composite 'owner' visibility.
      cOwnerLegacy = await insertObject(client, schema, {
        orgId: orgA,
        ownerLevel: "organization",
        ownerId: U1,
        visibility: "owner",
        legacyOwnerType: "user",
      });
      cJunk = await insertObject(client, schema, {
        orgId: orgA,
        ownerLevel: "organization",
        ownerId: orgA,
        visibility: "definitely-not-a-visibility",
      });
      cMixed = await insertObject(client, schema, {
        orgId: orgA,
        ownerLevel: "organization",
        ownerId: orgA,
        visibility: `project:${P1}`,
        legacyOwnerType: "user",
      });

      // ---- canonical column vocabulary (object-save writes)
      kUser = await insertObject(client, schema, {
        orgId: orgA,
        ownerLevel: "user",
        ownerId: U1,
        visibility: "private",
      });
      kTeam = await insertObject(client, schema, {
        orgId: orgA,
        ownerLevel: "team",
        ownerId: T1,
        visibility: "team",
      });
      kOrg = await insertObject(client, schema, {
        orgId: orgA,
        ownerLevel: "organization",
        ownerId: orgA,
        visibility: "organization",
      });
      kPublic = await insertObject(client, schema, {
        orgId: orgA,
        ownerLevel: "workspace",
        ownerId: "workspace",
        visibility: "public",
      });
      kProject = await insertObject(client, schema, {
        orgId: orgA,
        ownerLevel: "organization",
        ownerId: orgA,
        visibility: "private",
        projectId: P1,
      });
      kOrgB = await insertObject(client, schema, {
        orgId: orgB,
        ownerLevel: "organization",
        ownerId: orgB,
        visibility: "organization",
      });

      await runVocabularyMigration(client, schema);
    }, 30_000);

    afterAll(async () => {
      if (client && schema) await dropSchema(client, schema);
      if (client) await client.end();
    });

    // ---- A. fixed mapping ------------------------------------------------

    it("'org' → (organization, org_id, 'organization')", async () => {
      expect(await readOwnership(client, schema, cOrg)).toEqual({
        owner_level: "organization",
        owner_id: orgA,
        visibility: "organization",
        project_id: null,
      });
    });

    it("'workspace' → (workspace, 'public')", async () => {
      const r = await readOwnership(client, schema, cWorkspace);
      expect(r.owner_level).toBe("workspace");
      expect(r.visibility).toBe("public");
    });

    it("'team:<id>' → (team, <id>, 'team')", async () => {
      expect(await readOwnership(client, schema, cTeam)).toEqual({
        owner_level: "team",
        owner_id: T1,
        visibility: "team",
        project_id: null,
      });
    });

    it("'user:<id>' → (user, <id>, 'private')", async () => {
      expect(await readOwnership(client, schema, cUser)).toEqual({
        owner_level: "user",
        owner_id: U1,
        visibility: "private",
        project_id: null,
      });
    });

    it("'project:<id>' → project_id refinement + 'private', owner axis untouched", async () => {
      expect(await readOwnership(client, schema, cProject)).toEqual({
        owner_level: "organization",
        owner_id: orgA,
        visibility: "private",
        project_id: P1,
      });
    });

    it("legacy owner_type tuple adopts owner_type; 'owner' collapses to 'private'", async () => {
      expect(await readOwnership(client, schema, cOwnerLegacy)).toEqual({
        owner_level: "user",
        owner_id: U1,
        visibility: "private",
        project_id: null,
      });
    });

    it("junk visibility collapses fail-closed to 'private'", async () => {
      const r = await readOwnership(client, schema, cJunk);
      expect(r.visibility).toBe("private");
      expect(r.owner_level).toBe("organization");
    });

    it("mixed composite+owner_type row: the fixed mapping wins over pass 0", async () => {
      expect(await readOwnership(client, schema, cMixed)).toEqual({
        owner_level: "organization",
        owner_id: orgA,
        visibility: "private",
        project_id: P1,
      });
    });

    it("retires the legacy owner_type data (sequence-idempotency guarantee)", async () => {
      const res = await client.query(
        `SELECT count(*)::int AS n FROM "${schema}"."objects" WHERE owner_type IS NOT NULL`,
      );
      expect(res.rows[0].n).toBe(0);
    });

    // ---- B + C. canonical rows untouched, re-run is a no-op ---------------

    it("canonical rows are untouched, and a re-run changes nothing (idempotency)", async () => {
      const before = await Promise.all(
        [kUser, kTeam, kOrg, kPublic, kProject, cOrg, cWorkspace, cTeam, cUser, cProject, cMixed, cOwnerLegacy].map(
          (id) => readOwnership(client, schema, id),
        ),
      );
      expect(before[0]).toEqual({
        owner_level: "user",
        owner_id: U1,
        visibility: "private",
        project_id: null,
      });
      expect(before[3].visibility).toBe("public");
      await runVocabularyMigration(client, schema); // second run
      const after = await Promise.all(
        [kUser, kTeam, kOrg, kPublic, kProject, cOrg, cWorkspace, cTeam, cUser, cProject, cMixed, cOwnerLegacy].map(
          (id) => readOwnership(client, schema, id),
        ),
      );
      expect(after).toEqual(before);
    });

    // ---- D. AC1 round-trip across owner levels ----------------------------

    function actor(overrides: Partial<ActorContext>): ActorContext {
      return {
        principalType: "HumanUser",
        principalId: "someone-else",
        organizationId: orgA,
        teamIds: [],
        projectIds: [],
        platformRole: "member",
        authSource: "ui",
        policyVersion: "v2",
        ...overrides,
      } as ActorContext;
    }

    async function visibleTo(a: ActorContext): Promise<Set<string>> {
      const ids = await selectVisibleIds(client, schema, buildOwnershipFilter(a));
      return new Set(ids);
    }

    it("user level: owner sees BOTH origins' user-owned rows; others see neither", async () => {
      const owner = await visibleTo(actor({ principalId: U1 }));
      expect(owner.has(kUser)).toBe(true); // object-save origin
      expect(owner.has(cUser)).toBe(true); // migrated artifact origin
      expect(owner.has(cOwnerLegacy)).toBe(true); // migrated legacy tuple

      const stranger = await visibleTo(actor({ principalId: "user-Z" }));
      expect(stranger.has(kUser)).toBe(false);
      expect(stranger.has(cUser)).toBe(false);
      expect(stranger.has(cOwnerLegacy)).toBe(false);
    });

    it("team level (incl. team ids): members see BOTH origins' team rows; non-members neither", async () => {
      const member = await visibleTo(actor({ teamIds: [T1] }));
      expect(member.has(kTeam)).toBe(true);
      expect(member.has(cTeam)).toBe(true);

      const nonMember = await visibleTo(actor({ teamIds: ["team-other"] }));
      expect(nonMember.has(kTeam)).toBe(false);
      expect(nonMember.has(cTeam)).toBe(false);
    });

    it("organization level: org members see BOTH origins' org rows; cross-org never leaks", async () => {
      const orgMember = await visibleTo(actor({}));
      expect(orgMember.has(kOrg)).toBe(true);
      expect(orgMember.has(cOrg)).toBe(true);
      expect(orgMember.has(kOrgB)).toBe(false);

      const orgBMember = await visibleTo(actor({ organizationId: orgB }));
      expect(orgBMember.has(kOrg)).toBe(false);
      expect(orgBMember.has(cOrg)).toBe(false);
      expect(orgBMember.has(kOrgB)).toBe(true);
    });

    it("workspace level: owning-org members see BOTH origins' public rows; other orgs do not", async () => {
      const orgMember = await visibleTo(actor({}));
      expect(orgMember.has(kPublic)).toBe(true);
      expect(orgMember.has(cWorkspace)).toBe(true);

      const orgBMember = await visibleTo(actor({ organizationId: orgB }));
      expect(orgBMember.has(kPublic)).toBe(false);
      expect(orgBMember.has(cWorkspace)).toBe(false);
    });

    it("project refinement: room members see BOTH origins' project rows; non-members neither", async () => {
      const member = await visibleTo(actor({ projectIds: [P1] }));
      expect(member.has(kProject)).toBe(true);
      expect(member.has(cProject)).toBe(true);

      const nonMember = await visibleTo(actor({ projectIds: ["proj-other"] }));
      expect(nonMember.has(kProject)).toBe(false);
      expect(nonMember.has(cProject)).toBe(false);
    });
  },
);
