// §VIII "Dashboards as artifacts" — PURE surface unit tests (cinatra#1895).
// Exercises the projection + the Phase-1 DUAL AUTHORIZATION on rows shaped like
// the #1894 twin writer's output (an `objects` row of type
// `@cinatra-ai/dashboard-artifact:dashboard` paired with its dashboards row).
// DB-FREE: the dual-auth/liveness gates + the pointer projection are pure, so
// the "real-surface" row shape drives them directly.
import { describe, expect, it, vi } from "vitest";

// Hermetic import of the twin writer's own object-type constant (its substrate
// builders pull the postgres config trio) so the surface constant can be PINNED
// against the writer that produces the rows — the two must never drift.
vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: vi.fn() }));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import {
  DASHBOARD_ARTIFACT_OBJECT_TYPE,
  isDashboardArtifactType,
  buildDashboardArtifactPointer,
  selectReadableDashboardArtifactPointers,
  type DashboardArtifactRow,
} from "@/lib/dashboards/dashboard-artifact-surface";
import { DASHBOARD_OBJECT_TYPE } from "@/lib/dashboards/dashboard-artifact-twin-writer";
import type { DashboardAuthzActor } from "@/lib/dashboards/authz";
import type { ExtensionLivenessOracle } from "@cinatra-ai/dashboards/extension-dashboard-reads";

// A team MEMBER of "team-growth"; org "member" (not admin); one project grant.
const actor: DashboardAuthzActor = {
  userId: "user-me",
  organizationId: "org-1",
  teamIds: ["team-growth"],
  orgRole: "member",
  teamRoles: {},
  projectGrants: [{ projectId: "proj-open", effectiveRole: "write" }],
};

/** All extensions live EXCEPT a deliberately-dead package (orphan gate). */
const isPackageLive: ExtensionLivenessOracle = (id) => id !== "@x/dead";

function row(overrides: Partial<DashboardArtifactRow>): DashboardArtifactRow {
  return {
    id: "dash-x",
    name: "Untitled",
    ownerLevel: "team",
    ownerId: "team-growth",
    organizationId: "org-1",
    // "members" — the owner-entity's members may read (the gate intersects
    // ownership with the dashboard row's own visibility).
    visibility: "members",
    projectId: null,
    updatedAt: new Date("2026-07-20T12:00:00.000Z"),
    entityType: "team",
    entityId: "team-growth",
    extensionId: null,
    status: "published",
    isTemplate: false,
    templateScope: null,
    ...overrides,
  };
}

// A team dashboard the member CAN read (isMember team-growth).
const readable = row({ id: "dash-team", name: "Pipeline health — Q3" });
// A personal dashboard owned by someone else — the member CANNOT read it.
const foreign = row({
  id: "dash-foreign",
  name: "Someone else's board",
  ownerLevel: "user",
  ownerId: "user-other",
  entityType: null,
  entityId: null,
});
// An orphaned extension dashboard (its package is not live) — liveness drops it.
const orphan = row({
  id: "dash-orphan",
  name: "Dead package board",
  ownerLevel: "organization",
  ownerId: "org-1",
  entityType: "organization",
  entityId: "org-1",
  extensionId: "@x/dead",
});
// A project-scope TEMPLATE — never renders as an operational row.
const template = row({
  id: "dash-tmpl",
  name: "Template",
  isTemplate: true,
  templateScope: "project",
});

describe("§VIII — the dashboard-artifact object type", () => {
  it("matches the #1894 twin writer's own DASHBOARD_OBJECT_TYPE (pinned)", () => {
    expect(DASHBOARD_ARTIFACT_OBJECT_TYPE).toBe(DASHBOARD_OBJECT_TYPE);
    expect(DASHBOARD_ARTIFACT_OBJECT_TYPE).toBe(
      "@cinatra-ai/dashboard-artifact:dashboard",
    );
  });

  it("isDashboardArtifactType is exact (no partial / null match)", () => {
    expect(isDashboardArtifactType(DASHBOARD_ARTIFACT_OBJECT_TYPE)).toBe(true);
    expect(isDashboardArtifactType("@cinatra-ai/pdf-artifact:pdf")).toBe(false);
    expect(isDashboardArtifactType("dashboard")).toBe(false);
    expect(isDashboardArtifactType(null)).toBe(false);
    expect(isDashboardArtifactType(undefined)).toBe(false);
  });
});

describe("§VIII — the pointer projection (row → pointer)", () => {
  it("points at the canonical surface + one home scope chip for a team dashboard", () => {
    const p = buildDashboardArtifactPointer(readable);
    expect(p.dashboardId).toBe("dash-team");
    expect(p.name).toBe("Pipeline health — Q3");
    expect(p.ownerLevel).toBe("team");
    // canonical = the nested, entity-anchored route (cinatra#1738 D2).
    expect(p.canonicalHref).toBe("/teams/team-growth/dashboards/dash-team");
    expect(p.updatedAt).toBe("2026-07-20T12:00:00.000Z");
    expect(p.scopeChips).toHaveLength(1);
    expect(p.scopeChips[0]).toEqual({
      level: "team",
      label: "Team",
      href: "/teams/team-growth/dashboards/dash-team",
    });
  });

  it("reads a project-scoped dashboard as Project scope over the flat canonical route", () => {
    const p = buildDashboardArtifactPointer(
      row({
        id: "dash-proj",
        ownerLevel: "user",
        ownerId: "user-me",
        projectId: "proj-open",
        entityType: null,
        entityId: null,
      }),
    );
    expect(p.ownerLevel).toBe("project");
    expect(p.canonicalHref).toBe("/dashboards/dash-proj");
    expect(p.scopeChips[0]?.label).toBe("Project");
  });

  it("tolerates a null updatedAt", () => {
    expect(buildDashboardArtifactPointer(row({ updatedAt: null })).updatedAt).toBeNull();
  });
});

describe("§VIII — Phase-1 dual authorization + liveness selection", () => {
  const allRows = [readable, foreign, orphan, template];
  const artifactIds = new Set(allRows.map((r) => r.id));

  it("keeps ONLY the dashboard both gates admit (readable + live + not a template)", () => {
    const picked = selectReadableDashboardArtifactPointers({
      rows: allRows,
      artifactIds,
      actor,
      isPackageLive,
    });
    expect([...picked.keys()]).toEqual(["dash-team"]);
    expect(picked.get("dash-foreign")).toBeUndefined(); // owner+project gate denies
    expect(picked.get("dash-orphan")).toBeUndefined(); // liveness gate drops
    expect(picked.get("dash-tmpl")).toBeUndefined(); // project template dropped
  });

  it("never surfaces a readable dashboard that is not on the page (keyed to artifactIds)", () => {
    const picked = selectReadableDashboardArtifactPointers({
      rows: [readable],
      artifactIds: new Set(["some-other-artifact"]),
      actor,
      isPackageLive,
    });
    expect(picked.size).toBe(0);
  });

  it("owner-gate proof: an OWNERS-ONLY org dashboard denies a plain member, admits an org admin", () => {
    // visibility "owners" ⇒ only org owners/admins may read (a plain member may
    // BE in the org but is not an owner).
    const orgRow = row({
      id: "dash-org",
      ownerLevel: "organization",
      ownerId: "org-1",
      entityType: "organization",
      entityId: "org-1",
      visibility: "owners",
    });
    const ids = new Set(["dash-org"]);
    // The plain member (orgRole "member") is DENIED — a members-visibility
    // regression would wrongly admit them.
    const asMember = selectReadableDashboardArtifactPointers({
      rows: [orgRow],
      artifactIds: ids,
      actor,
      isPackageLive,
    });
    expect(asMember.has("dash-org")).toBe(false);
    // An org ADMIN (org_admin normalizes to admin) IS admitted.
    const adminActor: DashboardAuthzActor = { ...actor, orgRole: "org_admin" };
    const asAdmin = selectReadableDashboardArtifactPointers({
      rows: [orgRow],
      artifactIds: ids,
      actor: adminActor,
      isPackageLive,
    });
    expect(asAdmin.has("dash-org")).toBe(true);
  });

  it("denies a dashboard whose owner entity the actor does not belong to", () => {
    const otherTeam = row({
      id: "dash-other-team",
      ownerLevel: "team",
      ownerId: "team-secret",
      entityType: "team",
      entityId: "team-secret",
    });
    const denied = selectReadableDashboardArtifactPointers({
      rows: [otherTeam],
      artifactIds: new Set(["dash-other-team"]),
      actor,
      isPackageLive,
    });
    expect(denied.size).toBe(0);
  });
});
