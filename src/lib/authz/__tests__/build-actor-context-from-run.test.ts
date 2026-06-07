/**
 * TDD scaffold for the `buildActorContextFromRun(run)` authorization helper.
 *
 * Asserts the contract for `buildActorContextFromRun(run)` at
 * `src/lib/authz/build-actor-context-from-run.ts`.
 *
 * `buildActorContextFromRun({ orgId })` returns ctx with
 * `organizationId === run.orgId`.
 *
 * `buildActorContextFromRun` resolves project grants scoped to `run.orgId`,
 * not by the user's first-membership org. This prevents fallback to an
 * unrelated membership when the run already carries its organization.
 *
 * No backward compatibility. The helper hard-fails on null orgId via
 * `OrgIdRequiredError`. No fallback paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Indirection so `pnpm typecheck` stays clean while the production module is
// absent. The dynamic import still resolves at runtime, preserving the desired
// module-resolution behavior for this scaffold.
const MODULE_PATH = "@/lib/authz/build-actor-context-from-run";

// Mock the better-auth-db readers that buildActorContextFromRun composes.
// vi.hoisted ensures the spies are stable across test cases.
const betterAuthDb = vi.hoisted(() => ({
  readOrgsWithTeamsForUser: vi.fn(
    async (
      _userId: string,
    ): Promise<
      Array<{ id: string; name: string; teams: Array<{ id: string; name: string }> }>
    > => [],
  ),
  // Canonical project-grant resolver: owned ∪ accessed, role-by-authority,
  // active-org-anchored on run.orgId. Returns ProjectGrant[]; the actor-context
  // builder derives `projectIds` from each grant's `projectId`.
  readProjectGrantsForUser: vi.fn(
    async (
      _userId: string,
      _orgId: string,
      _hints: { teamIds: string[] },
    ): Promise<
      Array<{ projectId: string; effectiveRole: string; accessSource: string }>
    > => [],
  ),
}));
vi.mock("@/lib/better-auth-db", () => betterAuthDb);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildActorContextFromRun — organizationId from run.orgId", () => {
  it("returns ctx with organizationId === run.orgId", async () => {
    betterAuthDb.readOrgsWithTeamsForUser.mockResolvedValueOnce([
      { id: "org-A", name: "Org A", teams: [{ id: "team-1", name: "T1" }] },
    ]);
    betterAuthDb.readProjectGrantsForUser.mockResolvedValueOnce([]);
    const { buildActorContextFromRun } = await import(
      // Indirected via a variable to keep `pnpm typecheck` clean when TS cannot
      // resolve a missing module statically. The dynamic import still exercises
      // runtime module-resolution behavior.
      MODULE_PATH
    );
    const ctx = await buildActorContextFromRun({
      id: "run-1",
      runBy: "user-1",
      orgId: "org-A",
    });
    expect(ctx.organizationId).toBe("org-A");
  });

  it("calls readProjectGrantsForUser with run.orgId, not user's first-membership org", async () => {
    // The user has memberships in [org-A, org-X, org-B]; the run was created
    // in org-X. A first-membership fallback would use orgs[0] = org-A; the
    // correct implementation uses run.orgId = org-X.
    betterAuthDb.readOrgsWithTeamsForUser.mockResolvedValueOnce([
      { id: "org-A", name: "Org A", teams: [{ id: "team-A1", name: "TA1" }] },
      { id: "org-X", name: "Org X", teams: [{ id: "team-X1", name: "TX1" }] },
      { id: "org-B", name: "Org B", teams: [{ id: "team-B1", name: "TB1" }] },
    ]);
    betterAuthDb.readProjectGrantsForUser.mockResolvedValueOnce([
      { projectId: "proj-X1", effectiveRole: "admin", accessSource: "owner" },
    ]);
    const { buildActorContextFromRun } = await import(
      // Indirected via a variable to keep `pnpm typecheck` clean when TS cannot
      // resolve a missing module statically. The dynamic import still exercises
      // runtime module-resolution behavior.
      MODULE_PATH
    );
    const ctx = await buildActorContextFromRun({
      id: "run-2",
      runBy: "user-1",
      orgId: "org-X",
    });
    // organizationId comes from run.orgId, not orgs[0].
    expect(ctx.organizationId).toBe("org-X");
    // teamIds come from the org-X membership only.
    expect(ctx.teamIds).toEqual(["team-X1"]);
    // projectIds reflect the org-X-scoped readProjectGrantsForUser call.
    expect(ctx.projectIds).toEqual(["proj-X1"]);
    // The readProjectGrantsForUser call MUST be scoped to run.orgId, with the
    // org-X teamIds passed as resolver hints.
    expect(betterAuthDb.readProjectGrantsForUser).toHaveBeenCalledWith("user-1", "org-X", {
      teamIds: ["team-X1"],
    });
  });

  it("worker-originated run (runBy=null) returns InternalWorker ctx anchored on run.orgId", async () => {
    const { buildActorContextFromRun } = await import(
      // Indirected via a variable to keep `pnpm typecheck` clean when TS cannot
      // resolve a missing module statically. The dynamic import still exercises
      // runtime module-resolution behavior.
      MODULE_PATH
    );
    const ctx = await buildActorContextFromRun({
      id: "run-3",
      runBy: null,
      orgId: "org-A",
    });
    expect(ctx.principalType).toBe("InternalWorker");
    expect(ctx.principalId).toBe("run:run-3");
    expect(ctx.organizationId).toBe("org-A");
    expect(ctx.teamIds).toEqual([]);
    expect(ctx.projectIds).toEqual([]);
    // Worker path does NOT touch better-auth — no readers called.
    expect(betterAuthDb.readOrgsWithTeamsForUser).not.toHaveBeenCalled();
    expect(betterAuthDb.readProjectGrantsForUser).not.toHaveBeenCalled();
  });

  it("throws OrgIdRequiredError when run.orgId is null", async () => {
    const { buildActorContextFromRun, OrgIdRequiredError } = await import(
      // See MODULE_PATH note above.
      MODULE_PATH
    );
    let thrown: unknown = null;
    try {
      await buildActorContextFromRun({
        id: "run-4",
        runBy: "user-1",
        orgId: null,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OrgIdRequiredError);
    const err = thrown as Error & { code?: string };
    expect(err.code).toBe("ORG_ID_REQUIRED");
  });

  it("does NOT fall back to first-membership org when run.orgId differs", async () => {
    // Defense-in-depth assertion. Even if a buggy implementation reads orgs[0]
    // when run.orgId is set, this test catches it: the run is for org-X but
    // user's first membership is org-A. teamIds MUST come from org-X, not org-A.
    betterAuthDb.readOrgsWithTeamsForUser.mockResolvedValueOnce([
      { id: "org-A", name: "Org A", teams: [{ id: "team-A-only", name: "TA" }] },
      { id: "org-X", name: "Org X", teams: [{ id: "team-X-only", name: "TX" }] },
      { id: "org-B", name: "Org B", teams: [{ id: "team-B-only", name: "TB" }] },
    ]);
    betterAuthDb.readProjectGrantsForUser.mockResolvedValueOnce([]);
    const { buildActorContextFromRun } = await import(
      // Indirected via a variable to keep `pnpm typecheck` clean when TS cannot
      // resolve a missing module statically. The dynamic import still exercises
      // runtime module-resolution behavior.
      MODULE_PATH
    );
    const ctx = await buildActorContextFromRun({
      id: "run-5",
      runBy: "user-1",
      orgId: "org-X",
    });
    expect(ctx.organizationId).toBe("org-X");
    // CRITICAL: must be team-X-only, never team-A-only.
    expect(ctx.teamIds).toEqual(["team-X-only"]);
    expect(ctx.teamIds).not.toContain("team-A-only");
  });
});
