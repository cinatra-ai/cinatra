/**
 * Workspace dashboards, the storage leg (cinatra#2811, per-scope surfaces S5).
 *
 * The issue's sentence: the entity ref `{ entityType:"workspace",
 * entityId:"__workspace__", ownerLevel:"user", ownerId:userId }` with
 * `organization_id NULL`, and org-NULL arms in `resolveDashboardAccess` and
 * `guardedDashboardsWrite`. The acceptance reading this file pins is "dashboards
 * identical under active-org switches": nothing a workspace row's identity or
 * access decision reads may depend on the session's active organization.
 *
 * The real-Postgres half (the CHECKs, the org-NULL index twins, the service
 * writers, the migration on an old shape) is the integration suite beside this
 * file.
 */
import { describe, expect, it } from "vitest";
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";

import { WORKSPACE_ENTITY_ID as MIGRATION_WORKSPACE_ENTITY_ID } from "../../../../migrations/core/core__0108_workspace-dashboards.mjs";
import type { DashboardActor } from "../permissions";
import { resolveDashboardAccess } from "../permissions";
import {
  DashboardOrgWriteAuthorityError,
  guardedDashboardsWrite,
} from "../org-write-seam";
import {
  DASHBOARD_ENTITY_TYPES,
  WORKSPACE_DASHBOARD_ENTITY_ID,
  WORKSPACE_ENTITY_TYPES,
  buildOverviewDashboardId,
  isKnownEntityType,
  isWorkspaceDashboardRef,
  isWorkspaceDashboardRow,
  parseCanonicalOverviewId,
  workspaceDashboardRef,
} from "../store/entity-identity";
import type { DashboardRow } from "../store/schema";

function row(overrides: Partial<DashboardRow>): DashboardRow {
  return {
    id: "w1",
    name: "Overview",
    description: null,
    configJson: {},
    configVersion: "1.2",
    dashboardVersion: 1,
    publishedRevisionNumber: null,
    ownerLevel: "user",
    ownerId: "u1",
    organizationId: null,
    status: "draft",
    createdBy: "u1",
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    publishedAt: null,
    archivedAt: null,
    projectId: null,
    extensionId: null,
    isTemplate: false,
    templateScope: null,
    entityType: "workspace",
    entityId: "__workspace__",
    isDefault: true,
    contributionId: null,
    appliedContributionVersion: null,
    appliedDefaultJson: null,
    appliedDefaultHash: null,
    archiveReason: null,
    ...overrides,
  };
}

function actor(overrides: Partial<DashboardActor> = {}): DashboardActor {
  return {
    userId: "u1",
    organizationId: "org-a",
    teamIds: [],
    orgRole: "member",
    teamRoles: {},
    ...overrides,
  };
}

describe("the workspace entity identity", () => {
  it("admits 'workspace' as a dashboard entity type, beside the six migratable and three instance kinds", () => {
    expect(WORKSPACE_ENTITY_TYPES).toEqual(["workspace"]);
    expect(isKnownEntityType("workspace")).toBe(true);
    expect(DASHBOARD_ENTITY_TYPES).toContain("workspace");
    expect(DASHBOARD_ENTITY_TYPES.length).toBe(10);
  });

  it("names the one '__workspace__' entity the migration's CHECKs pin", () => {
    expect(WORKSPACE_DASHBOARD_ENTITY_ID).toBe("__workspace__");
    expect(WORKSPACE_DASHBOARD_ENTITY_ID).toBe(MIGRATION_WORKSPACE_ENTITY_ID);
  });

  it("builds the user-owned workspace ref, carrying no organization at all", () => {
    const ref = workspaceDashboardRef("u1");
    expect(ref).toEqual({
      entityType: "workspace",
      entityId: "__workspace__",
      ownerLevel: "user",
      ownerId: "u1",
    });
    expect(Object.keys(ref)).not.toContain("organizationId");
    expect(isWorkspaceDashboardRef(ref)).toBe(true);
  });

  it("recognizes only the exact workspace shape as a workspace ref", () => {
    expect(isWorkspaceDashboardRef({ ...workspaceDashboardRef("u1"), entityId: "org-a" })).toBe(false);
    expect(isWorkspaceDashboardRef({ ...workspaceDashboardRef("u1"), ownerLevel: "team" })).toBe(false);
    expect(isWorkspaceDashboardRef({ ...workspaceDashboardRef("u1"), ownerId: "" })).toBe(false);
    expect(
      isWorkspaceDashboardRef({ entityType: "personal", entityId: "org-a", ownerLevel: "user", ownerId: "u1" }),
    ).toBe(false);
  });

  it("derives one Overview id per user, with no organization in it (identical under org switches)", () => {
    const id = buildOverviewDashboardId(workspaceDashboardRef("u1"));
    expect(id).toBe("dash:workspace:__workspace__:user:u1:overview");
    expect(id).not.toContain("org-");
    expect(buildOverviewDashboardId(workspaceDashboardRef("u2"))).not.toBe(id);
    // Never mistaken for a legacy per-org surface id.
    expect(parseCanonicalOverviewId(id)).toBeNull();
  });

  it("recognizes a workspace row only when it is org-NULL AND workspace-shaped", () => {
    expect(isWorkspaceDashboardRow(row({}))).toBe(true);
    expect(isWorkspaceDashboardRow(row({ organizationId: "org-a" }))).toBe(false);
    expect(isWorkspaceDashboardRow(row({ entityType: "personal" }))).toBe(false);
    expect(isWorkspaceDashboardRow(row({ entityId: "org-a" }))).toBe(false);
    expect(isWorkspaceDashboardRow(row({ ownerLevel: "team" }))).toBe(false);
    expect(isWorkspaceDashboardRow(row({ projectId: "p1" }))).toBe(false);
  });
});

describe("resolveDashboardAccess: the org-NULL workspace arm", () => {
  it("the owner reads and writes their own workspace dashboard whatever organization is active", () => {
    for (const organizationId of ["org-a", "org-b", null]) {
      expect(resolveDashboardAccess(row({}), actor({ organizationId }))).toEqual({
        canRead: true,
        canWrite: true,
      });
    }
  });

  it("another user never reads it: a user's own workspace dashboards stay private", () => {
    for (const orgRole of ["member", "admin", "owner"] as const) {
      expect(
        resolveDashboardAccess(row({}), actor({ userId: "u2", orgRole })),
      ).toEqual({ canRead: false, canWrite: false });
    }
  });

  it("an OBO-delegated agent actor is refused outright (the workspace sits above every anchor)", () => {
    const ceiling: OboCeilingChain = [
      { tier: "user", id: "u1" },
      { tier: "organization", id: "org-a" },
    ];
    expect(resolveDashboardAccess(row({}), actor({ oboCeiling: ceiling }))).toEqual({
      canRead: false,
      canWrite: false,
    });
  });

  it("an org-NULL row that is not workspace-shaped is refused (fail-closed)", () => {
    expect(resolveDashboardAccess(row({ entityType: "personal" }), actor())).toEqual({
      canRead: false,
      canWrite: false,
    });
    expect(resolveDashboardAccess(row({ entityType: null, entityId: null }), actor())).toEqual({
      canRead: false,
      canWrite: false,
    });
    expect(resolveDashboardAccess(row({ projectId: "p1" }), actor())).toEqual({
      canRead: false,
      canWrite: false,
    });
  });

  it("a workspace-typed row that carries an organization is refused (the CHECK's shape, in depth)", () => {
    expect(
      resolveDashboardAccess(row({ organizationId: "org-a" }), actor({ organizationId: "org-a" })),
    ).toEqual({ canRead: false, canWrite: false });
  });

  it("an actor with no active organization reads no organization row", () => {
    expect(
      resolveDashboardAccess(
        row({ organizationId: "org-a", entityType: "personal", entityId: "org-a", isDefault: false }),
        actor({ organizationId: null }),
      ),
    ).toEqual({ canRead: false, canWrite: false });
  });
});

describe("guardedDashboardsWrite: the org-NULL workspace tenancy", () => {
  const authorityFor = (orgId: string): OrgWriteAuthority => ({
    orgId,
    can: (capability) => capability === "content.write",
  });

  /** A db whose transaction just runs the body. The workspace arm takes no
   *  organization lock, so no kernel query may reach it. */
  function plainDb() {
    const executed: unknown[] = [];
    const tx = {
      execute: async (query: unknown) => {
        executed.push(query);
        return { rows: [] };
      },
    };
    return {
      executed,
      db: { transaction: async <R>(fn: (t: typeof tx) => Promise<R>) => fn(tx) },
    };
  }

  it("runs a workspace write with no organization and no org-write authority", async () => {
    const { db, executed } = plainDb();
    const out = await guardedDashboardsWrite(
      actor({ organizationId: null }),
      { schema: "cinatra", tenancy: "workspace", db: db as never },
      async () => "wrote",
    );
    expect(out).toBe("wrote");
    // No organization lock and no lifecycle read ran before the body.
    expect(executed).toEqual([]);
  });

  it("runs the same workspace write identically whichever organization is active", async () => {
    for (const organizationId of ["org-a", "org-b", null]) {
      const { db } = plainDb();
      await expect(
        guardedDashboardsWrite(
          actor({ organizationId, authority: organizationId ? authorityFor(organizationId) : undefined }),
          { schema: "cinatra", tenancy: "workspace", db: db as never },
          async () => "wrote",
        ),
      ).resolves.toBe("wrote");
    }
  });

  it("refuses a workspace write with no acting user (fail-closed)", async () => {
    const { db } = plainDb();
    await expect(
      guardedDashboardsWrite(
        actor({ userId: "", organizationId: null }),
        { schema: "cinatra", tenancy: "workspace", db: db as never },
        async () => "wrote",
      ),
    ).rejects.toThrow(/workspace/i);
  });

  it("keeps the organization arm exactly as it was: no authority still refuses", async () => {
    const { db } = plainDb();
    await expect(
      guardedDashboardsWrite(
        actor({ organizationId: "org-a" }),
        { schema: "cinatra", db: db as never },
        async () => "wrote",
      ),
    ).rejects.toBeInstanceOf(DashboardOrgWriteAuthorityError);
    await expect(
      guardedDashboardsWrite(
        actor({ organizationId: null, authority: authorityFor("org-a") }),
        { schema: "cinatra", db: db as never },
        async () => "wrote",
      ),
    ).rejects.toBeInstanceOf(DashboardOrgWriteAuthorityError);
  });
});
