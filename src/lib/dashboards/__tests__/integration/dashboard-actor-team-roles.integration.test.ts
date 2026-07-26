/**
 * cinatra#1988 (updated for the #1898 Phase-2 ACL cutover) — the shared
 * dashboards session→actor builder must thread `teamRoles` + `teamIds`, so the
 * REAL resolver recognizes a team admin as an OWNER and a team member as a
 * MEMBER of a team-owned dashboard on the /dashboards list surface.
 *
 * REAL-STORE regression. It drives the shared builder END-TO-END: the team
 * membership + role is resolved from REAL, SEEDED store data via the REAL
 * `readTeamsForUser` (NOT a hand-built actor, and NOT the dashboards-package
 * Vitest stub of `@/lib/better-auth-db` that returns an empty membership list),
 * and the produced actor is passed through the REAL adapter (`toDashboardActor`)
 * and the REAL resolver (`resolveDashboardAccess`) via the canonical /dashboards
 * list consumer `filterReadableDashboards`.
 *
 * Phase-2 (cinatra#1898): a dashboard is ALWAYS visible to everyone in its scope,
 * so BOTH the team admin AND the plain team member READ a team-owned row (the
 * demoted `owners`/`private` column no longer restricts read — the admin-only
 * states deliberately WIDEN here). A stranger (no team, no org membership) is
 * still denied. The #1988 regression — the builder actually threads `teamRoles`
 * (owner recognition, which now governs WRITE) + `teamIds` (member recognition,
 * which governs READ) — is asserted directly against the real store.
 *
 * The library `/artifacts` surface no longer AUTHORIZES dashboard rows (Phase-2:
 * the single canonical `object.read` filter is its gate), so its agreement with
 * the /dashboards resolver is proven by the object-tuple property test
 * (`library-dashboard-agreement.test.ts`) and the core__0082 real-store proof —
 * not re-derived here.
 *
 * Only the unavoidable HTTP session boundary is mocked (`@/lib/auth` getSession +
 * next/headers/navigation) and the project-grant read is stubbed to `[]` (project
 * grants are IRRELEVANT to a team-owned, `projectId: null` verdict).
 * `readTeamsForUser` and `resolveOrgRoleForSession` run for REAL against the
 * seeded lane database.
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
import type { DashboardArtifactRow } from "@/lib/dashboards/dashboard-artifact-surface";
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
const STRANGER_USER = `user-stranger-1988-${randomUUID().slice(0, 8)}`;

// Fast-path session shape (avatar + non-"user" role + activeOrganizationId).
function sessionFor(userId: string) {
  return {
    user: { id: userId, image: "https://example.test/a.png", role: "member" },
    session: { activeOrganizationId: ORG },
  } as Record<string, unknown>;
}

// A team-owned dashboard row. `projectId: null` + `organizationId: ORG` (same
// active org) isolates the verdict to the team owner/member gate. The demoted
// `visibility` value is set to the most restrictive retired token ('private') to
// prove it no longer restricts read. `extensionId: null` + `isTemplate: false`
// keep it past the artifacts-surface renderability/template gates.
function teamRow(): DashboardArtifactRow & { visibility: string } {
  return {
    id: `dash-1988-${randomUUID().slice(0, 8)}`,
    name: "Team dashboard",
    ownerLevel: "team",
    ownerId: TEAM,
    organizationId: ORG,
    visibility: "private",
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

/** The canonical /dashboards list read verdict for a session user + row, via the
 *  shared-builder actor through the REAL adapter + resolver. */
async function canReadViaList(
  userId: string,
  row: DashboardArtifactRow,
): Promise<boolean> {
  state.session = sessionFor(userId);
  const { actor } = await buildDashboardActorFromSession();
  return filterReadableDashboards([row], actor).length === 1;
}

describe.skipIf(!HAS_REAL_DB)(
  "cinatra#1988/#1898 — shared builder threads teamRoles/teamIds end-to-end (real store)",
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
        // STRANGER_USER is intentionally NOT inserted into any team.
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

    it("team ADMIN reads a team-owned dashboard (owner)", async () => {
      expect(await canReadViaList(ADMIN_USER, teamRow())).toBe(true);
    });

    it("WIDENED: plain team MEMBER now reads the team-owned dashboard (was owner-only)", async () => {
      // Phase-2 (#1898): everyone in the team scope reads — the retired
      // 'private'/'owners' vocabulary no longer restricts a member's read.
      expect(await canReadViaList(MEMBER_USER, teamRow())).toBe(true);
    });

    it("a STRANGER (no team, no org membership) is still denied read", async () => {
      expect(await canReadViaList(STRANGER_USER, teamRow())).toBe(false);
    });

    it("the shared builder actually threads teamRoles + teamIds from the real store (admin='admin', member='member')", async () => {
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
