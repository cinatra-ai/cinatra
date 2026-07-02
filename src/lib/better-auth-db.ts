import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { toPgTextArrayLiteral } from "@/lib/pg-array";
import { projectsDb, projects } from "@/lib/projects-store";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { Pool } from "pg";

declare global {
  var __cinatraBetterAuthPool: Pool | undefined;
}

// Lazy pool + drizzle bootstrap. The pool is created on first use (not at
// module import) so `next build` page-data collection — and any other
// import-time evaluation without SUPABASE_DB_URL — does not throw. `new Pool()`
// never opens a connection until the first query, so deferring creation is free.
//
// The idle-error listener (registered at pool creation) keeps the process alive
// when Supabase drops idle connections: pg.Pool emits 'error' on an unexpected
// backend disconnect, which Node.js otherwise treats as an uncaught exception.
let betterAuthPoolInstance: Pool | undefined;
function getBetterAuthPool(): Pool {
  if (betterAuthPoolInstance) return betterAuthPoolInstance;
  if (globalThis.__cinatraBetterAuthPool) {
    return (betterAuthPoolInstance = globalThis.__cinatraBetterAuthPool);
  }
  const databaseUrl = process.env.SUPABASE_DB_URL;
  if (!databaseUrl) {
    throw new Error("Missing SUPABASE_DB_URL. Better Auth requires the Postgres database connection.");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      console.error("[better-auth] pg pool idle client error:", err.message);
    });
  }
  betterAuthPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraBetterAuthPool = pool;
  }
  return pool;
}

function createBetterAuthDb() {
  return drizzle(getBetterAuthPool());
}
let betterAuthDbInstance: ReturnType<typeof createBetterAuthDb> | undefined;
function getBetterAuthDb(): ReturnType<typeof createBetterAuthDb> {
  return (betterAuthDbInstance ??= createBetterAuthDb());
}

// `betterAuthPool` is passed to `betterAuth({ database })`, whose adapter
// detection shape-checks the value (instanceof / `"query" in` / `constructor`).
// This lazy proxy answers those shape checks from `Pool.prototype` WITHOUT
// creating the pool — so importing this module, and constructing the Better
// Auth instance at build time, never reads SUPABASE_DB_URL. The real pool is
// created only when a method is actually invoked (first query), at which point
// the idle-error listener and global cache are wired up.
export const betterAuthPool: Pool = new Proxy({} as Pool, {
  get(_t, prop) {
    if (prop === "constructor") return Pool;
    const target: any = getBetterAuthPool();
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(_t, prop) {
    return prop === "constructor" || prop in Pool.prototype;
  },
  getPrototypeOf() {
    return Pool.prototype;
  },
});

// `betterAuthDb` is only used for direct drizzle queries (never passed to an
// adapter), so a get-trap proxy that binds methods to the real db suffices.
export const betterAuthDb: ReturnType<typeof createBetterAuthDb> = new Proxy(
  {} as ReturnType<typeof createBetterAuthDb>,
  {
    get(_t, prop) {
      const target: any = getBetterAuthDb();
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  },
);

export const betterAuthUsers = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email"),
  username: text("username"),
  role: text("role"),
  image: text("image"),
  userType: text("userType"),
  clientId: text("clientId"),
});

export const betterAuthAccounts = pgTable("account", {
  id: text("id").primaryKey(),
  providerId: text("providerId"),
  userId: text("userId"),
  idToken: text("idToken"),
  createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }),
});

export const betterAuthSessions = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  activeOrganizationId: text("activeOrganizationId"),
});

export const betterAuthOrganizations = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name"),
  slug: text("slug"),
  createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }),
});

// The live Better Auth `member` table has organizationId and userId declared
// NOT NULL. Without notNull() in the Drizzle declaration, Drizzle infers
// `string | null` for those columns, every consumer must coalesce, and filters
// like eq(betterAuthMembers.organizationId, x) can silently fold null
// comparisons in some Drizzle versions and fall through. Aligning the Drizzle
// types to the live schema removes the laxity. `role` stays nullable because
// Better Auth permits NULL there (default is no extra role beyond org
// membership).
export const betterAuthMembers = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organizationId").notNull(),
  userId: text("userId").notNull(),
  role: text("role"),
  createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }),
});

// ---------------------------------------------------------------------------
// Better Auth team plugin Drizzle bridge.
// teamMember has ONLY id/teamId/userId/createdAt — NO organizationId, NO role.
// To get a user's teams scoped to an org, INNER JOIN team and filter by
// team.organizationId.
// ---------------------------------------------------------------------------

export const betterAuthTeams = pgTable("team", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // `slug` is NOT NULL in the live `public.team` table (CHECK-constrained,
  // unique per org); the binding must carry it or writes that omit it fail.
  slug: text("slug").notNull(),
  organizationId: text("organizationId").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updatedAt", { withTimezone: true, mode: "date" }),
});

export const betterAuthTeamMembers = pgTable("teamMember", {
  id: text("id").primaryKey(),
  teamId: text("teamId").notNull(),
  userId: text("userId").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true, mode: "date" }),
});

/**
 * Return the teams a user belongs to within a specific org.
 * INNER JOIN is required because public."teamMember" has no organizationId
 * column.
 */
export async function readTeamsForUser(
  userId: string,
  orgId: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await betterAuthDb
    .select({ id: betterAuthTeams.id, name: betterAuthTeams.name })
    .from(betterAuthTeamMembers)
    .innerJoin(
      betterAuthTeams,
      eq(betterAuthTeamMembers.teamId, betterAuthTeams.id),
    )
    .where(
      and(
        eq(betterAuthTeamMembers.userId, userId),
        eq(betterAuthTeams.organizationId, orgId),
      ),
    );
  return rows;
}

/**
 * Return EVERY team in an org (no membership filter).
 *
 * Admin-widening source for the teams dashboard visibility resolver:
 * `org_admin` / `org_owner` actors see every team in the active org, not
 * just direct memberships (`packages/dashboards/src/auth/team-visibility.ts`).
 * Callers MUST gate this behind a role check — it deliberately ignores the
 * caller's memberships. Named `listTeamsForOrg` (not `readTeamsForOrg`) to
 * avoid a near-collision with the singular `readTeamForOrg` below.
 */
export async function listTeamsForOrg(
  orgId: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await betterAuthDb
    .select({ id: betterAuthTeams.id, name: betterAuthTeams.name })
    .from(betterAuthTeams)
    .where(eq(betterAuthTeams.organizationId, orgId))
    // Deterministic helper output (name, then id as tiebreaker) — the cube
    // applies its own ordering, but stable output keeps tests and debugging
    // sane.
    .orderBy(betterAuthTeams.name, betterAuthTeams.id);
  return rows;
}

/**
 * Return every `organization.id` the user is a member of.
 * Used by `buildSecurityContextWithAccessibleOrgIds` to widen the cube
 * access predicate from active-org-only to multi-org membership.
 *
 * Returns an empty array if the user has no memberships (defensive — the
 * caller fails closed to active-org-only in that case).
 */
export async function listAccessibleOrgIdsForUser(userId: string): Promise<string[]> {
  const rows = await betterAuthDb
    .select({ orgId: betterAuthMembers.organizationId })
    .from(betterAuthMembers)
    .where(eq(betterAuthMembers.userId, userId));
  return rows.map((r) => r.orgId);
}

/**
 * Return all orgs the user belongs to, each with the teams they are a member
 * of within that org.
 *
 * Implementation notes:
 *  - INNER JOIN member → organization to get org id + name.
 *  - For each org, INNER JOIN teamMember → team (team.organizationId) to get
 *    teams. The teamMember table has NO organizationId column; the org filter
 *    comes from team.organizationId.
 *  - Orgs sorted case-insensitively by name; teams within each org sorted by
 *    name ascending.
 *  - Returns [] when the user has no memberships.
 */
export async function readOrgsWithTeamsForUser(
  userId: string,
): Promise<Array<{ id: string; name: string; teams: Array<{ id: string; name: string }> }>> {
  // Step 1 — fetch all orgs the user belongs to.
  const memberRows = await betterAuthDb
    .select({
      orgId: betterAuthOrganizations.id,
      orgName: betterAuthOrganizations.name,
    })
    .from(betterAuthMembers)
    .innerJoin(
      betterAuthOrganizations,
      eq(betterAuthMembers.organizationId, betterAuthOrganizations.id),
    )
    .where(eq(betterAuthMembers.userId, userId));

  if (memberRows.length === 0) return [];

  // Step 2 — for each org, fetch teams the user belongs to via JOIN onto team.organizationId.
  const orgIds = memberRows.map((r) => r.orgId);
  const teamRows = await betterAuthDb
    .select({
      orgId: betterAuthTeams.organizationId,
      teamId: betterAuthTeams.id,
      teamName: betterAuthTeams.name,
    })
    .from(betterAuthTeamMembers)
    .innerJoin(
      betterAuthTeams,
      eq(betterAuthTeamMembers.teamId, betterAuthTeams.id),
    )
    .where(
      and(
        eq(betterAuthTeamMembers.userId, userId),
        // Filter to only teams in orgs the user is a member of.
        // inArray is not imported here; use a subquery-free approach:
        // we do a JS-side filter after the join since orgIds is small.
      ),
    );

  // Build a map: orgId → teams[]
  const teamsByOrg = new Map<string, Array<{ id: string; name: string }>>();
  for (const row of teamRows) {
    if (!orgIds.includes(row.orgId)) continue;
    const existing = teamsByOrg.get(row.orgId) ?? [];
    existing.push({ id: row.teamId, name: row.teamName });
    teamsByOrg.set(row.orgId, existing);
  }

  // Step 3 — compose result, sort orgs and teams.
  const result = memberRows
    .map((r) => ({
      id: r.orgId,
      name: r.orgName ?? "",
      teams: (teamsByOrg.get(r.orgId) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    }))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

  return result;
}

export async function readTeamCreatableOrganizationsForUser(
  userId: string,
  userRole?: string | null,
): Promise<Array<{ id: string; name: string }>> {
  const isPlatformAdmin = String(userRole ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes("admin");

  const rows = await betterAuthDb
    .select({
      id: betterAuthOrganizations.id,
      name: betterAuthOrganizations.name,
      role: betterAuthMembers.role,
    })
    .from(betterAuthMembers)
    .innerJoin(
      betterAuthOrganizations,
      eq(betterAuthMembers.organizationId, betterAuthOrganizations.id),
    )
    .where(eq(betterAuthMembers.userId, userId));

  return rows
    .filter((row) => isPlatformAdmin || row.role === "owner" || row.role === "admin")
    .map((row) => ({ id: row.id, name: row.name ?? "" }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export async function userCanCreateTeams(
  userId: string,
  userRole?: string | null,
): Promise<boolean> {
  const organizations = await readTeamCreatableOrganizationsForUser(userId, userRole);
  return organizations.length > 0;
}

/**
 * Multi-org projects-by-membership read. Mirrors src/app/projects/page.tsx —
 * visibility by ownership union across ALL orgs the user belongs to:
 *   own (owner_level='user' AND owner_id=userId)
 *   ∪ team-owned (owner_level='team' AND owner_id IN user's team IDs across all orgs)
 *   ∪ org-owned (owner_level='organization' AND owner_id IN user's org IDs)
 */
export async function readProjectsForUser(
  userId: string,
  _orgId: string,
): Promise<Array<{ id: string; name: string }>> {
  const [teamRows, orgRows] = await Promise.all([
    betterAuthDb.execute<{ teamId: string }>(sql`
      SELECT tm."teamId" AS "teamId"
      FROM public."teamMember" tm
      WHERE tm."userId" = ${userId}
    `),
    betterAuthDb.execute<{ organizationId: string }>(sql`
      SELECT m."organizationId" AS "organizationId"
      FROM public.member m
      WHERE m."userId" = ${userId}
    `),
  ]);
  const teamIds = teamRows.rows.map((r) => r.teamId);
  const orgIds = orgRows.rows.map((r) => r.organizationId);

  const ownClause = and(
    eq(projects.ownerLevel, "user"),
    eq(projects.ownerId, userId),
  );
  const teamClause = teamIds.length > 0
    ? and(eq(projects.ownerLevel, "team"), inArray(projects.ownerId, teamIds))
    : undefined;
  const orgClause = orgIds.length > 0
    ? and(eq(projects.ownerLevel, "organization"), inArray(projects.ownerId, orgIds))
    : undefined;

  const rows = await projectsDb
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      or(
        ownClause,
        ...(teamClause ? [teamClause] : []),
        ...(orgClause ? [orgClause] : []),
      ),
    )
    .orderBy(projects.name);
  return rows;
}

// ---------------------------------------------------------------------------
// Probe whether a userId corresponds to a real human user row in the Better
// Auth users table. Used by the WayFlow callback actor resolution path in
// packages/agent-builder/src/mcp/handlers.ts.
// ---------------------------------------------------------------------------
export async function readUserById(userId: string): Promise<{ id: string } | null> {
  const rows = await betterAuthDb
    .select({ id: betterAuthUsers.id })
    .from(betterAuthUsers)
    .where(eq(betterAuthUsers.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Look up whether `userId` is a platform admin, reading Better Auth's
 * `user.role` column directly. Better Auth's admin plugin stores roles as a
 * comma-separated string ("user,admin"), so we apply the same comma-split
 * test used by `src/lib/auth-session.ts:isPlatformAdmin`.
 *
 * Used by the MCP cube-tools transport: the MCP identity chain carries only
 * `{userId, organizationId}` (no role), so the `llm_usage` cube's
 * platform-admin visibility gate needs this explicit by-userId lookup.
 * Returns `false` on any error or missing row (fail-closed).
 */
export async function readUserIsPlatformAdmin(userId: string): Promise<boolean> {
  try {
    const rows = await betterAuthDb
      .select({ role: betterAuthUsers.role })
      .from(betterAuthUsers)
      .where(eq(betterAuthUsers.id, userId))
      .limit(1);
    return String(rows[0]?.role ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .includes("admin");
  } catch {
    return false;
  }
}

/**
 * Count platform admins OTHER than `excludeUserId` — i.e. how many distinct
 * users (besides the given one) carry the global `admin` platform role.
 *
 * Used by the agent-creation approval flow (issue #392) to decide whether a
 * `platform_admin` approving their OWN authored proposal is the *only* possible
 * reviewer (single-admin instance → no segregation-of-duties available, so the
 * self-approval guard must yield) or whether another admin could review it
 * instead (multi-admin org → keep the guard, preserve SoD).
 *
 * The `user.role` column is GLOBAL (Better Auth's admin plugin has no org
 * dimension on it), so this count is instance-wide, matching the scope of
 * `isPlatformAdmin` / `readUserIsPlatformAdmin`. Roles are stored as a
 * comma-separated string ("user,admin"), so candidate rows are filtered with
 * the SAME comma-split token test rather than a LIKE (which would false-match
 * a hypothetical "nonadmin"). Returns a conservative HIGH count on error
 * (fail-closed: on a read failure we KEEP the self-approval guard rather than
 * silently bypass it).
 */
export async function countOtherPlatformAdmins(excludeUserId: string): Promise<number> {
  try {
    const rows = await betterAuthDb
      .select({ id: betterAuthUsers.id, role: betterAuthUsers.role })
      .from(betterAuthUsers)
      .where(and(ne(betterAuthUsers.id, excludeUserId), sql`${betterAuthUsers.role} IS NOT NULL`));
    return rows.filter((row) =>
      String(row.role ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .includes("admin"),
    ).length;
  } catch {
    // Fail-closed: pretend another reviewer exists so the SoD guard stays on.
    return 1;
  }
}

/**
 * Tenant-membership existence check for installRegistryPackageAtScope.
 *
 * Returns the team row if a team with `teamId` exists AND belongs to the
 * given organization. Returns null otherwise (including when the team
 * exists in a DIFFERENT org — caller treats both as "not accessible" with
 * the same 403 to avoid existence-leakage about cross-org teams).
 *
 * Used by assertTargetBelongsToActiveOrg in packages/agents/src/actions.ts.
 * platform_admin installs at team scope still need to confirm the team
 * exists in the active org (defence-in-depth before the install runs).
 */
// ===========================================================================
// Canonical project-grant resolver (UNION + role-by-authority)
//
// Replaces every user-owned-only `projectIds` producer with ONE resolver
// computing `owned ∪ accessed` with role-BY-AUTHORITY (never a blanket
// "owner"), active-org-anchored explicit access, max-not-last-wins merge.
//
// Relies on project_access generated columns, a same-org trigger, implicit
// owner access without project_access rows, and the invariant that project_id
// refines access but is never an ownership tier. `accessSource` is a SOURCE
// label, not an `OwnerLevel`.
//
// I/O is composed from injectable row-readers (default params = the real
// SQL). The unit test `src/lib/__tests__/authz-project-grants.test.ts`
// drives the full role-by-authority + merge + stale-guard logic with no live
// Postgres — same dependency-composition pattern as
// `src/lib/authz/build-actor-context-from-run.ts`.
// ===========================================================================

import type {
  ProjectGrant,
  ProjectRole,
  ProjectAccessSource,
} from "@/lib/authz/actor-context";

export type { ProjectGrant } from "@/lib/authz/actor-context";

/**
 * Resolver hints — the caller-resolved membership context. `teamRoles` /
 * `orgRole` are single/active-org-scoped (Better Auth resolves the role for
 * the actor's active org only). When a hint is unavailable the implicit role
 * degrades to `read` (safe — never over-grants).
 */
export type ProjectGrantHints = {
  teamIds?: string[];
  teamRoles?: Record<string, "team_admin" | "member">;
  orgRole?: "org_owner" | "org_admin" | "member";
};

/** Row shapes returned by the (injectable) source readers. */
export type ImplicitOwnedProjectRow = {
  projectId: string;
  ownerLevel: string; // 'user' | 'team' | 'organization' | (legacy/workspace)
  ownerId: string;
};
export type ProjectAccessRow = {
  projectId: string;
  role: "read" | "write" | "admin"; // LITERAL row role — never capped
  principalLevel: "user" | "team" | "organization" | "workspace";
};
export type ProjectCoOwnerRow = { projectId: string };

/**
 * Injectable I/O seam. Defaults (below) are the real SQL readers; tests
 * supply fakes. Keeping the resolver in this module keeps it unit-testable
 * without a live DB.
 */
export type ProjectGrantResolverDeps = {
  /**
   * Source 1 — implicit ownership. Multi-org owned uses the same predicate as
   * the legacy `readProjectsForUser` union, but the SELECT is widened to also
   * return owner_level/owner_id so role-by-authority can be computed.
   * Self-anchors via the owner clauses → unaffected by the stale-membership
   * guard.
   */
  readImplicitOwnedProjectRows: (
    userId: string,
  ) => Promise<ImplicitOwnedProjectRow[]>;
  /**
   * Source 2 — explicit project_access, ACTIVE-ORG-ANCHORED. UNION ALL over
   * the generated-column indexes + the workspace partial index. No `OR NULL`
   * (org-null projects only admit workspace — fail-closed).
   */
  readProjectAccessRows: (
    userId: string,
    actorOrgId: string,
    teamIds: string[],
  ) => Promise<ProjectAccessRow[]>;
  /**
   * Source 3 — back-compat project_co_owners, ACTIVE-ORG-ANCHORED (JOIN
   * projects WHERE organization_id = actorOrgId). Co-owner == admin.
   */
  readProjectCoOwnerRows: (
    userId: string,
    actorOrgId: string,
  ) => Promise<ProjectCoOwnerRow[]>;
  /** Current org memberships — the stale-membership guard. */
  listAccessibleOrgIdsForUser: (userId: string) => Promise<string[]>;
};

const ROLE_RANK: Record<ProjectRole, number> = {
  read: 0,
  write: 1,
  admin: 2,
  owner: 3,
};
const SOURCE_RANK: Record<ProjectAccessSource, number> = {
  owner: 0,
  user: 1,
  team: 2,
  organization: 3,
  workspace: 4,
};

/**
 * Source 1 role BY AUTHORITY (pure; exported for direct unit testing).
 *
 * - user-owned                         → {owner, owner}
 * - team-owned + team_admin            → {admin, team}; else/degrade → {read, team}
 * - org-owned, owner_id === actorOrgId → org_owner {owner} · org_admin {admin} · else {read} (source=organization)
 * - org-owned, owner_id !== actorOrgId → CAP {read, organization} because
 *   orgRole is single/active-org — an org_owner of A who is merely a member of
 *   B must NOT get `owner` on a B-owned project; the project still appears so
 *   binary projectIds back-compat is preserved
 *
 * Any other owner_level (legacy/workspace-tier owned project) → null; access
 * to it flows via Source 2/3 if granted.
 */
export function deriveImplicitOwnedRole(
  row: ImplicitOwnedProjectRow,
  userId: string,
  actorOrgId: string,
  hints: ProjectGrantHints,
): ProjectGrant | null {
  if (row.ownerLevel === "user" && row.ownerId === userId) {
    return { projectId: row.projectId, effectiveRole: "owner", accessSource: "owner" };
  }
  if (row.ownerLevel === "team") {
    const isTeamAdmin = hints.teamRoles?.[row.ownerId] === "team_admin";
    return {
      projectId: row.projectId,
      effectiveRole: isTeamAdmin ? "admin" : "read",
      accessSource: "team",
    };
  }
  if (row.ownerLevel === "organization") {
    if (row.ownerId !== actorOrgId) {
      // Non-active-org owned project (user is merely a member of that org).
      return { projectId: row.projectId, effectiveRole: "read", accessSource: "organization" };
    }
    const role: ProjectRole =
      hints.orgRole === "org_owner"
        ? "owner"
        : hints.orgRole === "org_admin"
          ? "admin"
          : "read";
    return { projectId: row.projectId, effectiveRole: role, accessSource: "organization" };
  }
  return null;
}

/**
 * Merge by projectId (pure; exported for direct unit testing).
 * `effectiveRole = max(owner>admin>write>read)`. On role tie, `accessSource`
 * by `owner>user>team>organization>workspace`. Never last-wins, never raises
 * a role beyond any contributing source. Sorted by projectId (deterministic).
 */
export function mergeProjectGrants(grants: ProjectGrant[]): ProjectGrant[] {
  const byProject = new Map<string, ProjectGrant>();
  for (const g of grants) {
    const cur = byProject.get(g.projectId);
    if (!cur) {
      byProject.set(g.projectId, g);
      continue;
    }
    const higherRole = ROLE_RANK[g.effectiveRole] > ROLE_RANK[cur.effectiveRole];
    const sameRole = ROLE_RANK[g.effectiveRole] === ROLE_RANK[cur.effectiveRole];
    if (higherRole) {
      byProject.set(g.projectId, g);
    } else if (
      sameRole &&
      SOURCE_RANK[g.accessSource] < SOURCE_RANK[cur.accessSource]
    ) {
      // Same role, more-authoritative source label → adopt the source but
      // keep the (identical) role.
      byProject.set(g.projectId, { ...cur, accessSource: g.accessSource });
    }
  }
  return [...byProject.values()].sort((a, b) =>
    a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0,
  );
}

// ---- default real SQL readers (Source 1/2/3 + membership) ----

/**
 * Source 1 default reader. Predicate is byte-identical to the legacy
 * `readProjectsForUser` multi-org union (own ∪ team-owned ∪ org-owned across
 * ALL the user's orgs/teams); the SELECT additionally returns owner_level/
 * owner_id so role-by-authority can be computed.
 */
async function readImplicitOwnedProjectRowsSql(
  userId: string,
): Promise<ImplicitOwnedProjectRow[]> {
  const [teamRows, orgRows] = await Promise.all([
    betterAuthDb.execute<{ teamId: string }>(sql`
      SELECT tm."teamId" AS "teamId"
      FROM public."teamMember" tm
      WHERE tm."userId" = ${userId}
    `),
    betterAuthDb.execute<{ organizationId: string }>(sql`
      SELECT m."organizationId" AS "organizationId"
      FROM public.member m
      WHERE m."userId" = ${userId}
    `),
  ]);
  const teamIds = teamRows.rows.map((r) => r.teamId);
  const orgIds = orgRows.rows.map((r) => r.organizationId);

  const ownClause = and(
    eq(projects.ownerLevel, "user"),
    eq(projects.ownerId, userId),
  );
  const teamClause =
    teamIds.length > 0
      ? and(eq(projects.ownerLevel, "team"), inArray(projects.ownerId, teamIds))
      : undefined;
  const orgClause =
    orgIds.length > 0
      ? and(
          eq(projects.ownerLevel, "organization"),
          inArray(projects.ownerId, orgIds),
        )
      : undefined;

  const rows = await projectsDb
    .select({
      projectId: projects.id,
      ownerLevel: projects.ownerLevel,
      ownerId: projects.ownerId,
    })
    .from(projects)
    .where(
      or(
        ownClause,
        ...(teamClause ? [teamClause] : []),
        ...(orgClause ? [orgClause] : []),
      ),
    )
    .orderBy(projects.id);
  return rows;
}

/**
 * Source 2 default reader — UNION ALL over the generated-column indexes
 * because a `(principal_level,principal_id)` predicate would NOT use the
 * partial indexes. Also includes the workspace partial index. Active-org
 * anchored on `projects.organization_id = $actorOrgId`. No `OR NULL` — an
 * org-null project only admits the workspace principal.
 *
 * Raw SQL (cross-schema reference into the cinatra schema's project_access).
 * `projectsDb` is bound to the cinatra schema pool.
 */
async function readProjectAccessRowsSql(
  userId: string,
  actorOrgId: string,
  teamIds: string[],
): Promise<ProjectAccessRow[]> {
  const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll(
    '"',
    '""',
  );
  // Drizzle's `sql` tag binds JS arrays via pg-node's parameter serializer.
  // Sending a single-element empty-string array makes pg-node stringify it to
  // `''` (a plain string, not a `text[]`), and Postgres rejects that with
  // "malformed array literal" 22P02 inside `ANY($3)`. Skip the team-id UNION
  // branch entirely when the actor is in no teams — it would match zero rows
  // anyway, so it's not just safer but strictly equivalent.
  const teamBranch = teamIds.length > 0
    ? sql`
    UNION ALL
    SELECT pa.project_id, pa.role, pa.principal_level
      FROM "${sql.raw(schema)}"."project_access" pa
      JOIN "${sql.raw(schema)}"."projects" p ON p.id = pa.project_id
     WHERE pa.principal_team_id = ANY(${toPgTextArrayLiteral(teamIds)}::text[])
       AND p.organization_id = ${actorOrgId}`
    : sql``;
  const result = await projectsDb.execute<{
    project_id: string;
    role: "read" | "write" | "admin";
    principal_level: "user" | "team" | "organization" | "workspace";
  }>(sql`
    SELECT pa.project_id, pa.role, pa.principal_level
      FROM "${sql.raw(schema)}"."project_access" pa
      JOIN "${sql.raw(schema)}"."projects" p ON p.id = pa.project_id
     WHERE pa.principal_user_id = ${userId}
       AND p.organization_id = ${actorOrgId}${teamBranch}
    UNION ALL
    SELECT pa.project_id, pa.role, pa.principal_level
      FROM "${sql.raw(schema)}"."project_access" pa
      JOIN "${sql.raw(schema)}"."projects" p ON p.id = pa.project_id
     WHERE pa.principal_org_id = ${actorOrgId}
       AND p.organization_id = ${actorOrgId}
    UNION ALL
    SELECT pa.project_id, pa.role, pa.principal_level
      FROM "${sql.raw(schema)}"."project_access" pa
      JOIN "${sql.raw(schema)}"."projects" p ON p.id = pa.project_id
     WHERE pa.principal_level = 'workspace'
       AND pa.principal_id = '__workspace__'
       AND p.organization_id IS NULL
  `);
  return result.rows.map((r) => ({
    projectId: r.project_id,
    role: r.role,
    principalLevel: r.principal_level,
  }));
}

/**
 * Source 3 default reader — back-compat project_co_owners, active-org
 * anchored (JOIN projects WHERE organization_id = $actorOrgId). Co-owner ==
 * admin (preserves the co-owner semantic).
 */
async function readProjectCoOwnerRowsSql(
  userId: string,
  actorOrgId: string,
): Promise<ProjectCoOwnerRow[]> {
  const schema = (process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra").replaceAll(
    '"',
    '""',
  );
  const result = await projectsDb.execute<{ project_id: string }>(sql`
    SELECT co.project_id
      FROM "${sql.raw(schema)}"."project_co_owners" co
      JOIN "${sql.raw(schema)}"."projects" p ON p.id = co.project_id
     WHERE co.user_id = ${userId}
       AND p.organization_id = ${actorOrgId}
  `);
  return result.rows.map((r) => ({ projectId: r.project_id }));
}

const DEFAULT_PROJECT_GRANT_DEPS: ProjectGrantResolverDeps = {
  readImplicitOwnedProjectRows: readImplicitOwnedProjectRowsSql,
  readProjectAccessRows: readProjectAccessRowsSql,
  readProjectCoOwnerRows: readProjectCoOwnerRowsSql,
  listAccessibleOrgIdsForUser,
};

/**
 * THE canonical project-grant resolver. Every `projectIds` producer routes
 * through this — owned ∪ accessed, role-by-authority, active-org-anchored
 * explicit access, max-not-last-wins merge.
 *
 * Sources 2+3 are gated on `actorOrgId ∈ listAccessibleOrgIdsForUser`
 * stale-membership guard: the same-org trigger only validates at GRANT time,
 * not after the principal is removed from the org. If `actorOrgId` is no
 * longer a current membership (session still carries a stale
 * activeOrganizationId), Sources 2+3 yield nothing and we do NOT even issue
 * their queries (fail-closed, no wasted round-trip). Source 1 (implicit owned)
 * is unaffected — it self-anchors via the owner clauses.
 *
 * @param hints caller-resolved membership context (single/active-org-scoped;
 *   missing teamRoles/orgRole → implicit role degrades to `read`, safe).
 * @param deps injectable I/O seam (defaults = real SQL).
 */
export async function readProjectGrantsForUser(
  userId: string,
  actorOrgId: string,
  hints: ProjectGrantHints,
  deps: ProjectGrantResolverDeps = DEFAULT_PROJECT_GRANT_DEPS,
): Promise<ProjectGrant[]> {
  const teamIds = hints.teamIds ?? [];

  // Source 1 — implicit owned (multi-org; role by authority). Self-anchored.
  const ownedRows = await deps.readImplicitOwnedProjectRows(userId);
  const collected: ProjectGrant[] = [];
  for (const row of ownedRows) {
    const g = deriveImplicitOwnedRole(row, userId, actorOrgId, hints);
    if (g) collected.push(g);
  }

  // Stale-membership guard. Sources 2+3 are anchored to `actorOrgId`; only
  // honor them when actorOrgId is a CURRENT membership.
  const accessibleOrgIds = await deps.listAccessibleOrgIdsForUser(userId);
  if (accessibleOrgIds.includes(actorOrgId)) {
    // Source 2 — explicit project_access (literal row role, active-org
    // anchored). NOT capped by org/team role.
    const accessRows = await deps.readProjectAccessRows(
      userId,
      actorOrgId,
      teamIds,
    );
    for (const r of accessRows) {
      collected.push({
        projectId: r.projectId,
        effectiveRole: r.role as ProjectRole,
        accessSource: r.principalLevel as ProjectAccessSource,
      });
    }
    // Source 3 — back-compat co-owner == admin (active-org anchored).
    const coOwnerRows = await deps.readProjectCoOwnerRows(userId, actorOrgId);
    for (const r of coOwnerRows) {
      collected.push({
        projectId: r.projectId,
        effectiveRole: "admin",
        accessSource: "user",
      });
    }
  }

  return mergeProjectGrants(collected);
}

export async function readTeamForOrg(
  teamId: string,
  organizationId: string,
): Promise<{ id: string; organizationId: string } | null> {
  const rows = await betterAuthDb
    .select({
      id: betterAuthTeams.id,
      organizationId: betterAuthTeams.organizationId,
    })
    .from(betterAuthTeams)
    .where(
      and(
        eq(betterAuthTeams.id, teamId),
        eq(betterAuthTeams.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
