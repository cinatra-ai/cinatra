/**
 * cinatra#1898 / #2064 — the project READ surfaces gate on the CANONICAL
 * sealed-room grant. This is the BEHAVIORAL proof the structural source-greps
 * (`detail-not-found.test.ts`, `settings-surface-adoption-1733.test.ts`) could
 * never give: a real, non-owner org member with a real `project_access` grant
 * actually PASSES the gate, and a non-grantee is DENIED — driven end-to-end
 * through the REAL `readProjectGrantsForUser` (real SQL over `cinatra.projects`
 * + `cinatra.project_access` + `public.member`/`teamMember`) into the shared
 * `actorHoldsProjectGrant` gate the detail + settings pages call.
 *
 * The prior lane shipped the grant WRITE + display affordance but never wired
 * the grant to authorization on the read surfaces; the detail/settings pages
 * used the grant-less `actorFromSession` primitive + `enforceResourceAccess`,
 * whose kernel `can()` never consults `projectGrants`. This suite would have
 * caught that: it asserts the ALLOW/DENY verdict flips exactly with the grant.
 *
 * Runner (real DB required — else self-skips; NEVER fail-vacuous):
 *   CINATRA_DB_INTEGRATION_TESTS=1 \
 *   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:5634/postgres \
 *     pnpm exec vitest run \
 *       src/lib/authz/__tests__/integration/project-read-gate.integration.test.ts
 *
 * The suite CREATEs a lane-unique database off the shared base connection,
 * provisions the minimal tables the real resolver reads in its own `cinatra`
 * + `public` schemas, seeds them, and DROPs the lane database in afterAll — it
 * never touches a shared database or schema.
 */
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readProjectGrantsForUser } from "@/lib/better-auth-db";
import { actorHoldsProjectGrant } from "@/lib/authz/project-read-gate";
import { betterAuthPool } from "@/lib/better-auth-db";
import { projectsPool } from "@/lib/projects-store";
import { __resetPooledDbForTests } from "@/lib/db/pooled";

const BASE_DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = BASE_DB_URL !== "" && !BASE_DB_URL.includes("unused:unused@");

const LANE_DB = `verify_pa2064_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const SAFE_LANE_DB = /^verify_pa2064_[a-z0-9_]+$/;
const SHARED_DBS = new Set(["postgres", "template0", "template1", "cinatra"]);

function swapDbName(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const ORG = `org-pa2064-${randomUUID().slice(0, 8)}`;
const ALICE = `alice-${randomUUID().slice(0, 8)}`; // owner of the user-owned project
const BOB = `bob-${randomUUID().slice(0, 8)}`; // org member; gets a USER-level grant
const CAROL = `carol-${randomUUID().slice(0, 8)}`; // org member; only the ORG-level grant reaches her
const STRANGER = `stranger-${randomUUID().slice(0, 8)}`; // NOT an org member
const PROJECT = `proj-pa2064-${randomUUID().slice(0, 8)}`; // user-owned by ALICE, private

/** Resolve the REAL grant set for a user in ORG and run the sealed-room gate. */
async function canRead(
  userId: string,
  orgRole: "org_owner" | "member" | undefined,
): Promise<boolean> {
  const grants = await readProjectGrantsForUser(userId, ORG, {
    teamIds: [],
    ...(orgRole ? { orgRole } : {}),
  });
  return actorHoldsProjectGrant({ projectGrants: grants }, PROJECT);
}

async function insertOrgGrant(seed: Client): Promise<void> {
  await seed.query(
    `INSERT INTO cinatra.project_access
       (project_id, principal_level, principal_id, role, principal_org_id, granted_by)
     VALUES ($1,'organization',$2,'read',$2,$3)`,
    [PROJECT, ORG, ALICE],
  );
}
async function insertUserGrant(seed: Client, userId: string): Promise<void> {
  await seed.query(
    `INSERT INTO cinatra.project_access
       (project_id, principal_level, principal_id, role, principal_user_id, granted_by)
     VALUES ($1,'user',$2,'read',$2,$3)`,
    [PROJECT, userId, ALICE],
  );
}

describe.skipIf(!HAS_REAL_DB)(
  "cinatra#1898/#2064 — project read gate honors the canonical grant (real store)",
  () => {
    let laneUrl = "";

    beforeAll(async () => {
      if (!SAFE_LANE_DB.test(LANE_DB) || SHARED_DBS.has(LANE_DB)) {
        throw new Error(`refusing unsafe lane DB name: ${LANE_DB}`);
      }
      const admin = new Client({ connectionString: BASE_DB_URL });
      await admin.connect();
      try {
        await admin.query(`CREATE DATABASE "${LANE_DB}"`);
      } finally {
        await admin.end().catch(() => {});
      }

      laneUrl = swapDbName(BASE_DB_URL, LANE_DB);
      const seed = new Client({ connectionString: laneUrl });
      await seed.connect();
      try {
        await seed.query(`CREATE SCHEMA IF NOT EXISTS cinatra`);
        // Minimal shapes the real readers query. project_access carries plain
        // columns for the generated `principal_*` axes the SQL reads directly.
        await seed.query(`
          CREATE TABLE cinatra.projects (
            id text PRIMARY KEY,
            name text NOT NULL,
            description text,
            owner_level text NOT NULL,
            owner_id text NOT NULL,
            organization_id text,
            visibility text NOT NULL DEFAULT 'private',
            slug text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            archived_at timestamptz
          )`);
        await seed.query(`
          CREATE TABLE cinatra.project_access (
            project_id text NOT NULL,
            principal_level text NOT NULL,
            principal_id text NOT NULL,
            role text NOT NULL,
            principal_user_id text,
            principal_team_id text,
            principal_org_id text,
            granted_by text
          )`);
        await seed.query(`
          CREATE TABLE cinatra.project_co_owners (
            project_id text NOT NULL,
            user_id text NOT NULL,
            granted_by text,
            granted_at timestamptz DEFAULT now()
          )`);
        await seed.query(`
          CREATE TABLE public."member" (
            id text PRIMARY KEY,
            "organizationId" text NOT NULL,
            "userId" text NOT NULL,
            role text,
            "createdAt" timestamptz
          )`);
        await seed.query(`
          CREATE TABLE public."teamMember" (
            id text PRIMARY KEY,
            "teamId" text NOT NULL,
            "userId" text NOT NULL,
            "createdAt" timestamptz,
            role text
          )`);

        // The user-owned, PRIVATE project (owner = ALICE, tenant = ORG).
        await seed.query(
          `INSERT INTO cinatra.projects (id, name, owner_level, owner_id, organization_id, slug)
           VALUES ($1,$2,'user',$3,$4,$5)`,
          [PROJECT, "Project P", ALICE, ORG, `p-${PROJECT}`],
        );
        // Org memberships — ALICE/BOB/CAROL are members of ORG; STRANGER is not.
        for (const [u, role] of [
          [ALICE, "owner"],
          [BOB, "member"],
          [CAROL, "member"],
        ] as const) {
          await seed.query(
            `INSERT INTO public."member" (id, "organizationId", "userId", role) VALUES ($1,$2,$3,$4)`,
            [randomUUID(), ORG, u, role],
          );
        }
      } finally {
        await seed.end().catch(() => {});
      }

      // Point BOTH real pools (better-auth: public.member/teamMember; projects:
      // cinatra.projects/project_access) at the lane DB before the first query.
      process.env.SUPABASE_DB_URL = laneUrl;
      (globalThis as { __cinatraBetterAuthPool?: Pool }).__cinatraBetterAuthPool = undefined;
      __resetPooledDbForTests();
    }, 120_000);

    afterAll(async () => {
      try {
        await (betterAuthPool as unknown as Pool).end();
      } catch {
        /* pool may never have been created */
      }
      try {
        await (projectsPool as unknown as Pool).end();
      } catch {
        /* pool may never have been created */
      }
      __resetPooledDbForTests();
      process.env.SUPABASE_DB_URL = BASE_DB_URL;
      if (SAFE_LANE_DB.test(LANE_DB) && !SHARED_DBS.has(LANE_DB)) {
        const admin = new Client({ connectionString: BASE_DB_URL });
        await admin.connect().catch(() => {});
        await admin.query(`DROP DATABASE IF EXISTS "${LANE_DB}" WITH (FORCE)`).catch(() => {});
        await admin.end().catch(() => {});
      }
    }, 120_000);

    it("OWNER reads via the implicit owner grant (Source 1)", async () => {
      expect(await canRead(ALICE, "org_owner")).toBe(true);
    });

    it("NON-owner org member is DENIED with no grant (the sealed room is closed)", async () => {
      expect(await canRead(BOB, "member")).toBe(false);
      expect(await canRead(CAROL, "member")).toBe(false);
    });

    it("a USER-level grant lets THAT member read — and only that member", async () => {
      const seed = new Client({ connectionString: laneUrl });
      await seed.connect();
      try {
        await insertUserGrant(seed, BOB);
      } finally {
        await seed.end().catch(() => {});
      }
      // BOB (direct user-level grantee) now reads; CAROL still denied.
      expect(await canRead(BOB, "member")).toBe(true);
      expect(await canRead(CAROL, "member")).toBe(false);
    });

    it("an ORGANIZATION-level grant reaches EVERY org member — not a stranger", async () => {
      const seed = new Client({ connectionString: laneUrl });
      await seed.connect();
      try {
        await insertOrgGrant(seed);
      } finally {
        await seed.end().catch(() => {});
      }
      // The org-level grant expands to all members (Source 2 org branch).
      expect(await canRead(CAROL, "member")).toBe(true);
      expect(await canRead(BOB, "member")).toBe(true);
      // A non-member is fenced by the stale-membership guard (ORG ∉ their
      // accessible orgs) — Source 2/3 never run, so no grant, DENY.
      expect(await canRead(STRANGER, undefined)).toBe(false);
    });
  },
);
