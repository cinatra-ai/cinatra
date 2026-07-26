// §VIII "Dashboards as artifacts" — PURE surface unit tests (cinatra#1895,
// Phase-2 ACL cutover cinatra#1898). Exercises the pointer projection + the
// Phase-2 SINGLE-GATE selection on rows shaped like the #1894 twin writer's
// output (an `objects` row of type `@cinatra-ai/dashboard-artifact:dashboard`
// paired with its dashboards row). DB-FREE: the projection + the
// liveness/template selection are pure.
//
// Phase-2: the surface no longer AUTHORIZES. The canonical `object.read` filter
// (applied by `listArtifacts`) is the SOLE authorization gate — a row's presence
// in `artifactIds` already means the actor may read it. This module only projects
// the object-gated rows and drops the ones that are not an operational surface
// (orphaned/archived extensions, project-scope templates).
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
import type { ExtensionLivenessOracle } from "@cinatra-ai/dashboards/extension-dashboard-reads";

/** All extensions live EXCEPT a deliberately-dead package (orphan gate). */
const isPackageLive: ExtensionLivenessOracle = (id) => id !== "@x/dead";

function row(overrides: Partial<DashboardArtifactRow>): DashboardArtifactRow {
  return {
    id: "dash-x",
    name: "Untitled",
    ownerLevel: "team",
    ownerId: "team-growth",
    organizationId: "org-1",
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

// A team dashboard the object filter admitted (present in artifactIds).
const readable = row({ id: "dash-team", name: "Pipeline health — Q3" });
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

describe("§VIII — Phase-2 single-gate + liveness selection (cinatra#1898)", () => {
  it("projects the object-gated rows, dropping only orphan + project-template", () => {
    // artifactIds is the object.read-gated set (what listArtifacts returned) — its
    // membership IS the authorization. The surface keeps those, minus the rows
    // that are not an operational surface on either side.
    const allRows = [readable, orphan, template];
    const picked = selectReadableDashboardArtifactPointers({
      rows: allRows,
      artifactIds: new Set(allRows.map((r) => r.id)),
      isPackageLive,
    });
    expect([...picked.keys()]).toEqual(["dash-team"]);
    expect(picked.get("dash-orphan")).toBeUndefined(); // liveness gate drops
    expect(picked.get("dash-tmpl")).toBeUndefined(); // project template dropped
  });

  it("does NOT re-authorize: a row absent from artifactIds (object filter excluded it) is dropped", () => {
    // A dashboard the actor may NOT read is never in artifactIds — the object
    // filter excluded it upstream — so it never reaches a pointer here.
    const foreign = row({ id: "dash-foreign", ownerLevel: "user", ownerId: "user-other" });
    const picked = selectReadableDashboardArtifactPointers({
      rows: [readable, foreign],
      artifactIds: new Set(["dash-team"]), // foreign was object-gated OUT
      isPackageLive,
    });
    expect([...picked.keys()]).toEqual(["dash-team"]);
    expect(picked.has("dash-foreign")).toBe(false);
  });

  it("never surfaces a dashboard that is not on the page (keyed to artifactIds)", () => {
    const picked = selectReadableDashboardArtifactPointers({
      rows: [readable],
      artifactIds: new Set(["some-other-artifact"]),
      isPackageLive,
    });
    expect(picked.size).toBe(0);
  });
});
