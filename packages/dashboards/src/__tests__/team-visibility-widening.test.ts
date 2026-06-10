/**
 * Authz tests for the teams-dashboard visibility widening policy (#69).
 *
 * `resolveVisibleTeamIds` is the pure, dependency-injected core behind
 * `DASHBOARD_VISIBILITY_RESOLVERS.getVisibleTeamIds`. These tests pin the
 * RBAC contract:
 *
 *   - missing identity            -> []           (fail closed)
 *   - role `member`               -> direct only  (fail-closed default)
 *   - role undefined (no row)     -> direct only
 *   - unknown role string         -> direct only
 *   - role `org_admin`            -> direct ∪ ALL active-org teams
 *   - role `org_owner`            -> direct ∪ ALL active-org teams
 *   - role-resolution failure     -> direct only  (degrade, never wider)
 *   - org-listing failure         -> direct only  (degrade, never wider)
 *   - direct-lookup failure       -> propagates   (caller fails cube closed)
 *   - widening stays active-org-scoped (deps receive ctx.organizationId)
 *   - non-privileged path never issues the org-wide query
 */
import { describe, expect, it, vi } from "vitest";

import {
  resolveVisibleTeamIds,
  TEAM_WIDENING_ORG_ROLES,
  type TeamVisibilityDeps,
} from "../auth/team-visibility";

const DIRECT_TEAMS = [
  { id: "team-a", name: "Alpha" },
  { id: "team-b", name: "Beta" },
];
const ORG_TEAMS = [
  { id: "team-a", name: "Alpha" },
  { id: "team-b", name: "Beta" },
  { id: "team-c", name: "Gamma" },
  { id: "team-d", name: "Delta" },
];
const IDENTITY = { userId: "user-1", organizationId: "org-1" };

function makeDeps(
  role: "org_owner" | "org_admin" | "member" | undefined,
): TeamVisibilityDeps & {
  readTeamsForUser: ReturnType<typeof vi.fn>;
  listTeamsForOrg: ReturnType<typeof vi.fn>;
  resolveOrgRole: ReturnType<typeof vi.fn>;
} {
  return {
    readTeamsForUser: vi.fn(async () => DIRECT_TEAMS),
    listTeamsForOrg: vi.fn(async () => ORG_TEAMS),
    resolveOrgRole: vi.fn(async () => role),
  };
}

describe("resolveVisibleTeamIds — fail-closed defaults", () => {
  it("returns [] when userId is missing", async () => {
    const deps = makeDeps("org_admin");
    await expect(
      resolveVisibleTeamIds({ userId: "", organizationId: "org-1" }, deps),
    ).resolves.toEqual([]);
    await expect(
      resolveVisibleTeamIds({ organizationId: "org-1" }, deps),
    ).resolves.toEqual([]);
    expect(deps.readTeamsForUser).not.toHaveBeenCalled();
    expect(deps.listTeamsForOrg).not.toHaveBeenCalled();
  });

  it("returns [] when organizationId is missing", async () => {
    const deps = makeDeps("org_owner");
    await expect(
      resolveVisibleTeamIds({ userId: "user-1", organizationId: "" }, deps),
    ).resolves.toEqual([]);
    await expect(
      resolveVisibleTeamIds({ userId: "user-1" }, deps),
    ).resolves.toEqual([]);
    expect(deps.readTeamsForUser).not.toHaveBeenCalled();
  });

  it("role `member` stays on direct membership and never issues the org-wide query", async () => {
    const deps = makeDeps("member");
    await expect(resolveVisibleTeamIds(IDENTITY, deps)).resolves.toEqual([
      "team-a",
      "team-b",
    ]);
    expect(deps.listTeamsForOrg).not.toHaveBeenCalled();
  });

  it("undefined role (no membership row) stays on direct membership", async () => {
    const deps = makeDeps(undefined);
    await expect(resolveVisibleTeamIds(IDENTITY, deps)).resolves.toEqual([
      "team-a",
      "team-b",
    ]);
    expect(deps.listTeamsForOrg).not.toHaveBeenCalled();
  });

  it("an unknown role string stays on direct membership (explicit allowlist)", async () => {
    const deps = makeDeps("member");
    deps.resolveOrgRole.mockResolvedValueOnce("superuser" as never);
    await expect(resolveVisibleTeamIds(IDENTITY, deps)).resolves.toEqual([
      "team-a",
      "team-b",
    ]);
    expect(deps.listTeamsForOrg).not.toHaveBeenCalled();
  });
});

describe("resolveVisibleTeamIds — admin/org-level widening", () => {
  it.each(TEAM_WIDENING_ORG_ROLES)(
    "role `%s` widens to every team in the active org (deduplicated union)",
    async (role) => {
      const deps = makeDeps(role);
      const ids = await resolveVisibleTeamIds(IDENTITY, deps);
      expect(ids.slice().sort()).toEqual(["team-a", "team-b", "team-c", "team-d"]);
      // Direct duplicates (team-a/team-b appear in both sources) collapse.
      expect(new Set(ids).size).toBe(ids.length);
    },
  );

  it("widened set still includes direct memberships not present in the org listing (defensive union)", async () => {
    const deps = makeDeps("org_admin");
    deps.listTeamsForOrg.mockResolvedValueOnce([{ id: "team-z", name: "Zeta" }]);
    const ids = await resolveVisibleTeamIds(IDENTITY, deps);
    expect(ids.slice().sort()).toEqual(["team-a", "team-b", "team-z"]);
  });

  it("widening is scoped to the SecurityContext's active org (all deps receive ctx ids)", async () => {
    const deps = makeDeps("org_owner");
    await resolveVisibleTeamIds(IDENTITY, deps);
    expect(deps.readTeamsForUser).toHaveBeenCalledExactlyOnceWith(
      "user-1",
      "org-1",
    );
    expect(deps.resolveOrgRole).toHaveBeenCalledExactlyOnceWith(
      "org-1",
      "user-1",
    );
    expect(deps.listTeamsForOrg).toHaveBeenCalledExactlyOnceWith("org-1");
  });
});

describe("resolveVisibleTeamIds — failure semantics (never amplify)", () => {
  it("degrades to direct membership when role resolution throws", async () => {
    const deps = makeDeps("org_admin");
    deps.resolveOrgRole.mockRejectedValueOnce(new Error("DB unreachable"));
    await expect(resolveVisibleTeamIds(IDENTITY, deps)).resolves.toEqual([
      "team-a",
      "team-b",
    ]);
    expect(deps.listTeamsForOrg).not.toHaveBeenCalled();
  });

  it("degrades to direct membership when the org-wide listing throws", async () => {
    const deps = makeDeps("org_owner");
    deps.listTeamsForOrg.mockRejectedValueOnce(new Error("DB unreachable"));
    await expect(resolveVisibleTeamIds(IDENTITY, deps)).resolves.toEqual([
      "team-a",
      "team-b",
    ]);
  });

  it("propagates a direct-membership lookup failure (caller fails the cube closed)", async () => {
    const deps = makeDeps("org_admin");
    deps.readTeamsForUser.mockRejectedValueOnce(new Error("DB unreachable"));
    await expect(resolveVisibleTeamIds(IDENTITY, deps)).rejects.toThrow(
      "DB unreachable",
    );
    expect(deps.listTeamsForOrg).not.toHaveBeenCalled();
  });
});
