/**
 * Installer AUTHORITY on the upload road (cinatra#3204, acceptance criterion 14).
 *
 * The picker on the Upload screen is an affordance: the rows it disables are the
 * UX shadow of a decision the SERVER owns. This suite pins that the upload road
 * runs the same server-side sequence a store install runs — the same tenancy
 * gate, the same authority assertion, in the same order — and that it does so
 * BEFORE anything is written.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/upload-install-authorization.test.ts
 */
import { describe, expect, it, vi } from "vitest";

import { authorizeUploadInstallScope } from "../upload-install-authorization";
import { UploadInstallScopeError } from "../upload-install-scope";

const ORG = "org_1";

function session(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: "user_1", role: "user" },
    session: { activeOrganizationId: ORG },
    ...overrides,
  } as never;
}

function fakes(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const deps = {
    buildCanDoOptsFromSession: async () => {
      calls.push("roles");
      return { orgRole: "org_admin" as const };
    },
    readActorRolesForInstall: (...args: unknown[]) => {
      calls.push("roleBag");
      return { platformRole: "user", orgRole: "org_admin", __args: args } as never;
    },
    assertTargetBelongsToActiveOrg: async () => {
      calls.push("tenancy");
      return { projectOwnership: undefined };
    },
    assertCanInstallAtTarget: async () => {
      calls.push("authority");
    },
    ...over,
  };
  return { deps: deps as never, calls };
}

describe("the upload road authorizes the chosen scope server-side", () => {
  it("runs the tenancy gate BEFORE the authority assertion", async () => {
    const { deps, calls } = fakes();
    await authorizeUploadInstallScope(session(), "team:t1", deps);
    expect(calls).toEqual(["roles", "roleBag", "tenancy", "authority"]);
  });

  it("returns the anchor and the audience policy the install then uses", async () => {
    const { deps } = fakes();
    const decision = await authorizeUploadInstallScope(session(), "workspace", deps);
    expect(decision.rowAnchor.ownerLevel).toBe("workspace");
    expect(decision.policy?.runListVisibility).toEqual(["workspace"]);
  });

  it("refuses a value that is not an installable scope BEFORE any authority call", async () => {
    const { deps, calls } = fakes();
    await expect(authorizeUploadInstallScope(session(), "owner", deps)).rejects.toThrow(
      UploadInstallScopeError,
    );
    expect(calls).toEqual([]);
  });

  it("refuses when the session carries no active organization", async () => {
    const { deps, calls } = fakes();
    await expect(
      authorizeUploadInstallScope(session({ session: { activeOrganizationId: null } }), "workspace", deps),
    ).rejects.toThrow(/active organization/);
    expect(calls).toEqual([]);
  });

  it("RE-DERIVES the workspace/admin tenant id from the session and discards a forged one", async () => {
    const seen: unknown[] = [];
    const { deps } = fakes({
      assertCanInstallAtTarget: async (_bag: unknown, target: unknown) => {
        seen.push(target);
      },
    });
    // `pickerValueToInstallTarget` stamps the ACTIVE org id, but the value could
    // arrive from anywhere; the target the server acts on must carry the id the
    // SESSION says, never one the client chose.
    const decision = await authorizeUploadInstallScope(session(), "admin", deps);
    expect(decision.target).toEqual({ level: "admin", id: ORG });
    expect(seen[0]).toEqual({ level: "admin", id: ORG });
  });

  it("propagates an authority denial — a target the actor lacks authority for installs nothing", async () => {
    const denial = new Error("Install at whole-workspace scope requires platform admin.");
    const { deps } = fakes({
      assertCanInstallAtTarget: async () => {
        throw denial;
      },
    });
    await expect(authorizeUploadInstallScope(session(), "workspace", deps)).rejects.toBe(denial);
  });

  it("propagates a tenancy denial without ever reaching the authority assertion", async () => {
    const authority = vi.fn();
    const { deps } = fakes({
      assertTargetBelongsToActiveOrg: async () => {
        throw new Error("target does not belong to the active organization");
      },
      assertCanInstallAtTarget: authority,
    });
    await expect(authorizeUploadInstallScope(session(), "team:t1", deps)).rejects.toThrow(
      /active organization/,
    );
    expect(authority).not.toHaveBeenCalled();
  });

  it("threads the project-ownership context the tenancy gate resolved", async () => {
    const ownership = { ownerUserIds: new Set(["user_1"]), owningTeamId: null };
    let threaded: unknown;
    const { deps } = fakes({
      assertTargetBelongsToActiveOrg: async () => ({ projectOwnership: ownership }),
      assertCanInstallAtTarget: async (_b: unknown, _t: unknown, ctx: unknown) => {
        threaded = ctx;
      },
    });
    await authorizeUploadInstallScope(session(), "project:p1", deps);
    expect(threaded).toBe(ownership);
  });
});
