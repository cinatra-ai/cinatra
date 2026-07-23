/**
 * cinatra#1988 — the shared dashboards session→actor builder must thread
 * `teamRoles`, so a team admin is recognized as an "owner" of a team-owned,
 * `owners`/`private`-visibility dashboard on every read surface that resolves
 * its actor through the shared builder's adapter path.
 *
 * REAL-STORE regression (AC2/AC3). It drives the shared builder END-TO-END: the
 * team membership + role is resolved from REAL, SEEDED store data via the REAL
 * `readTeamsForUser` (NOT a hand-built actor, and NOT the dashboards-package
 * Vitest stub of `@/lib/better-auth-db` that returns an empty membership list),
 * and the produced actor is passed through the REAL adapter (`toDashboardActor`)
 * and the REAL resolver (`resolveDashboardAccess`) via the two shared-builder
 * consumers that exist on `origin/main` today:
 *   - the canonical `/dashboards` list  → `filterReadableDashboards`
 *   - the `/artifacts` pointer surface (#1895) → `selectReadableDashboardArtifactPointers`
 * (the detail screen resolves the SAME actor through the SAME adapter path).
 *
 * Only the unavoidable HTTP session boundary is mocked (`@/lib/auth`
 * getSession + next/headers/navigation — the session-actor-teamids pattern) and
 * the project-grant read is stubbed to `[]` (project grants are IRRELEVANT to a
 * team-owned, `projectId: null` verdict — the denied case is engineered so only
 * the team-role owner gate is in play). `readTeamsForUser` and
 * `resolveOrgRoleForSession` run for REAL against the seeded lane database.
 *
 * RED on `origin/main` (before the fix): `buildDashboardActorFromSession` drops
 * the role — the actor's `teamRoles` is undefined → the adapter normalizes it to
 * `{}` → `isOwner` is false for the team-owned row → the team admin is DENIED
 * read of BOTH the `owners` and the `private` row. GREEN after the fix: the
 * builder threads `teamRoles` from the same `readTeamsForUser` rows, the resolver
 * recognizes the team admin as an owner, and read is GRANTED — identically on
 * both surfaces (parity).
 *
 * Runner (real DB required — else the suite self-skips; NEVER fail-vacuous):
 *   CINATRA_DB_INTEGRATION_TESTS=1 \
 *   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:5634/postgres \
 *     pnpm exec vitest run \
 *       src/lib/dashboards/__tests__/integration/dashboard-actor-team-roles.integration.test.ts
 * The suite CREATEs a lane-unique database, provisions the minimal Better-Auth
 * tables it reads (team / teamMember-with-role / member) in its own public
 * schema, seeds them, and DROPs the lane database in afterAll — it never touches
 * a shared database or schema.
 */
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocked HTTP session boundary (no request in a vitest run) + the one DB read
// that is irrelevant to a team-owned verdict. Everything else is REAL.
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
// Controllable session; the fast-path shape (avatar + non-"user" role +
// activeOrganizationId) means getAuthSession returns it without any enrichment
// DB read.
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => state.session } },
  ensureGoogleAvatarSync: async () => undefined,
  ensureInitialAdminBootstrap: async () => undefined,
  ensureDefaultOrganizationMembership: async () => undefined,
  ensureAssistantBootstrap: async () => undefined,
}));
// Keep @/lib/better-auth-db REAL — `readTeamsForUser` (and its
// `teamMemberRoleColumnExists` probe) hit the seeded lane DB. Only the
// project-grant read is stubbed to [] so no @/lib/projects-store connection is
// required; project grants never enter a team-owned, projectId:null verdict.
vi.mock("@/lib/better-auth-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/better-auth-db")>();
  return { ...actual, readProjectGrantsForUser: async () => [] };
});

// Imports of the code under test MUST follow the mocks (vi.mock is hoisted, but
// the module graph is evaluated with the mocks in place).
import { buildDashboardActorFromSession } from "@/lib/dashboards/dashboard-actor";
import { filterReadableDashboards } from "@/lib/dashboards/authz";
import {
  selectReadableDashboardArtifactPointers,
  type DashboardArtifactRow,
} from "@/lib/dashboards/dashboard-artifact-surface";
import { betterAuthPool } from "@/lib/better-auth-db";

// ---------------------------------------------------------------------------
// Lane-unique DB fencing. SUPABASE_DB_URL points at the shared verify pg's base
// `postgres` DB; the suite CREATEs a lane-unique DB off it and DROPs only that.
// Fail-closed: no real DB (or the unused sentinel) → self-skip (never
// fail-vacuous).
// ---------------------------------------------------------------------------
const BASE_DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB =
  BASE_DB_URL !== "" && !BASE_DB_URL.includes("unused:unused@");

// Identifier-safe, lane-owned DB name (the regex IS the identifier escape) with
// a defensive denylist so a DROP can never hit a shared database.
const LANE_DB = `verify_1988_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const SAFE_LANE_DB = /^verify_1988_[a-z0-9_]+$/;
const SHARED_DBS = new Set(["postgres", "template0", "template1", "cinatra"]);

function swapDbName(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const ORG = `org-1988-${randomUUID().slice(0, 8)}`;
const TEAM = `team-1988-${randomUUID().slice(0, 8)}`;
const ADMIN_USER = `user-admin-1988-${randomUUID().slice(0, 8)}`;
const MEMBER_USER = `user-member-1988-${randomUUID().slice(0, 8)}`;

// Fast-path session shape (avatar + non-"user" role + activeOrganizationId).
function sessionFor(userId: string) {
  return {
    user: { id: userId, image: "https://example.test/a.png", role: "member" },
    session: { activeOrganizationId: ORG },
  } as Record<string, unknown>;
}

// A team-owned dashboard row at the given visibility. `projectId: null` +
// `organizationId: ORG` (same active org) isolates the verdict to the team-role
// owner gate. `extensionId: null` + `isTemplate: false` keep it past the
// artifacts-surface renderability/template gates so the two surfaces compare on
// the owner gate alone.
function teamRow(visibility: "owners" | "private"): DashboardArtifactRow {
  return {
    id: `dash-1988-${visibility}-${randomUUID().slice(0, 8)}`,
    name: `Team ${visibility} dashboard`,
    ownerLevel: "team",
    ownerId: TEAM,
    organizationId: ORG,
    visibility,
    projectId: null,
    updatedAt: new Date("2026-07-20T00:00:00.000Z"),
    entityType: null,
    entityId: null,
    extensionId: null,
    status: "active",
    isTemplate: false,
    templateScope: null,
  };
}

// The two shared-builder read surfaces, each fed the SAME builder-produced actor
// and the SAME row. Both must agree (parity, AC3).
function listSurfaceCanRead(
  row: DashboardArtifactRow,
  actor: Awaited<ReturnType<typeof buildDashboardActorFromSession>>["actor"],
): boolean {
  return filterReadableDashboards([row], actor).length === 1;
}
function artifactSurfaceCanRead(
  row: DashboardArtifactRow,
  actor: Awaited<ReturnType<typeof buildDashboardActorFromSession>>["actor"],
): boolean {
  const map = selectReadableDashboardArtifactPointers({
    rows: [row],
    artifactIds: new Set([row.id]),
    actor,
    isPackageLive: () => true,
  });
  return map.has(row.id);
}

/** Resolve BOTH shared-builder surfaces for a session user + row, asserting the
 *  two surfaces agree, and return that agreed verdict. */
async function canReadOnBothSurfaces(
  userId: string,
  row: DashboardArtifactRow,
): Promise<boolean> {
  state.session = sessionFor(userId);
  const { actor } = await buildDashboardActorFromSession();
  const list = listSurfaceCanRead(row, actor);
  const artifacts = artifactSurfaceCanRead(row, actor);
  // Parity (AC3): both derive their actor solely from the shared builder, so a
  // divergence would be a real regression, not a test artifact.
  expect(artifacts, "list vs artifacts surface parity").toBe(list);
  return list;
}

describe.skipIf(!HAS_REAL_DB)(
  "cinatra#1988 — shared builder threads teamRoles end-to-end (real store)",
  () => {
    let laneBetterAuthPool: Pool | undefined;

    beforeAll(async () => {
      if (!SAFE_LANE_DB.test(LANE_DB) || SHARED_DBS.has(LANE_DB)) {
        throw new Error(`refusing unsafe lane DB name: ${LANE_DB}`);
      }
      // 1) CREATE the lane DB off the shared base connection.
      const admin = new Client({ connectionString: BASE_DB_URL });
      await admin.connect();
      try {
        await admin.query(`CREATE DATABASE "${LANE_DB}"`);
      } finally {
        await admin.end().catch(() => {});
      }

      // 2) Provision the minimal Better-Auth tables the builder reads in the
      //    lane DB's own public schema. Column names are the live camelCase
      //    (quoted → case preserved) the drizzle bindings target; `teamMember`
      //    carries the app-owned `role` column (so teamMemberRoleColumnExists()
      //    resolves true and readTeamsForUser returns the role).
      const laneUrl = swapDbName(BASE_DB_URL, LANE_DB);
      const seed = new Client({ connectionString: laneUrl });
      await seed.connect();
      try {
        await seed.query(`
          CREATE TABLE public."team" (
            id text PRIMARY KEY,
            name text NOT NULL,
            slug text,
            "organizationId" text NOT NULL,
            "createdAt" timestamptz,
            "updatedAt" timestamptz
          )`);
        await seed.query(`
          CREATE TABLE public."teamMember" (
            id text PRIMARY KEY,
            "teamId" text NOT NULL,
            "userId" text NOT NULL,
            "createdAt" timestamptz,
            role text
          )`);
        // resolveOrgRoleForSession (kept REAL) reads public.member; an empty
        // table resolves orgRole to undefined — correct for a team-owned verdict.
        await seed.query(`
          CREATE TABLE public."member" (
            id text PRIMARY KEY,
            "organizationId" text NOT NULL,
            "userId" text NOT NULL,
            role text,
            "createdAt" timestamptz
          )`);

        await seed.query(
          `INSERT INTO public."team" (id, name, slug, "organizationId") VALUES ($1,$2,$3,$4)`,
          [TEAM, "Owner team", `owner-team-${TEAM}`, ORG],
        );
        await seed.query(
          `INSERT INTO public."teamMember" (id, "teamId", "userId", role) VALUES ($1,$2,$3,$4)`,
          [randomUUID(), TEAM, ADMIN_USER, "admin"],
        );
        await seed.query(
          `INSERT INTO public."teamMember" (id, "teamId", "userId", role) VALUES ($1,$2,$3,$4)`,
          [randomUUID(), TEAM, MEMBER_USER, "member"],
        );
      } finally {
        await seed.end().catch(() => {});
      }

      // 3) Point the REAL Better-Auth pool at the lane DB. Set BEFORE any
      //    builder call (the pool is lazy — created on first query), and clear
      //    the dev-mode global cache so the first query binds to the lane DB.
      process.env.SUPABASE_DB_URL = laneUrl;
      (globalThis as { __cinatraBetterAuthPool?: Pool }).__cinatraBetterAuthPool =
        undefined;
    }, 120_000);

    afterAll(async () => {
      // Release the Better-Auth pool's connections before dropping the DB.
      try {
        await (betterAuthPool as unknown as Pool).end();
      } catch {
        /* pool may never have been created */
      }
      // Restore the base URL and drop the lane DB (FORCE terminates any residual
      // backend so the DROP always lands).
      process.env.SUPABASE_DB_URL = BASE_DB_URL;
      if (SAFE_LANE_DB.test(LANE_DB) && !SHARED_DBS.has(LANE_DB)) {
        const admin = new Client({ connectionString: BASE_DB_URL });
        await admin.connect().catch(() => {});
        await admin
          .query(`DROP DATABASE IF EXISTS "${LANE_DB}" WITH (FORCE)`)
          .catch(() => {});
        await admin.end().catch(() => {});
      }
      void laneBetterAuthPool;
    }, 120_000);

    it("team ADMIN can read a team-owned 'owners' row (RED before fix: denied)", async () => {
      expect(await canReadOnBothSurfaces(ADMIN_USER, teamRow("owners"))).toBe(
        true,
      );
    });

    it("team ADMIN can read a team-owned 'private' row (owners≡private for the kernel)", async () => {
      expect(await canReadOnBothSurfaces(ADMIN_USER, teamRow("private"))).toBe(
        true,
      );
    });

    it("plain team MEMBER cannot read the team-owned 'owners' row", async () => {
      expect(await canReadOnBothSurfaces(MEMBER_USER, teamRow("owners"))).toBe(
        false,
      );
    });

    it("plain team MEMBER cannot read the team-owned 'private' row", async () => {
      expect(await canReadOnBothSurfaces(MEMBER_USER, teamRow("private"))).toBe(
        false,
      );
    });

    it("the shared builder actually threads teamRoles from the real store (admin='admin', member='member')", async () => {
      state.session = sessionFor(ADMIN_USER);
      const { actor: adminActor } = await buildDashboardActorFromSession();
      expect(adminActor.teamIds).toContain(TEAM);
      expect(adminActor.teamRoles?.[TEAM]).toBe("admin");

      state.session = sessionFor(MEMBER_USER);
      const { actor: memberActor } = await buildDashboardActorFromSession();
      expect(memberActor.teamIds).toContain(TEAM);
      expect(memberActor.teamRoles?.[TEAM]).toBe("member");
    });
  },
);
