import { describe, it, expect } from "vitest";
import { excludeProjectTemplates, isProjectTemplate } from "../store/extension-dashboard-reads";
import { filterReadableDashboards } from "../auth/require-dashboard-access";
import type { DashboardActor } from "../permissions";

// Minimal row factory (only the fields the filters + owner resolver read).
function row(over: Partial<Record<string, unknown>>): any {
  return {
    id: "d", name: "D", description: null, configJson: {}, configVersion: "v1.2",
    dashboardVersion: 1, publishedRevisionNumber: null,
    ownerLevel: "organization", ownerId: "org-1", organizationId: "org-1",
    visibility: "members", status: "published", createdBy: "u", updatedBy: null,
    createdAt: new Date(), updatedAt: new Date(), publishedAt: null, archivedAt: null,
    projectId: null, extensionId: "@cinatra-ai/x-workflow", isTemplate: false, templateScope: null,
    ...over,
  };
}

const orgMember: DashboardActor = { userId: "u", organizationId: "org-1", teamIds: [], orgRole: "member", teamRoles: {} };

describe("DASH-05 list/detail filters", () => {
  it("list EXCLUDES project-scope template rows (keeps instances + non-project templates)", () => {
    const projectTemplate = row({ isTemplate: true, templateScope: "project", projectId: null });
    const orgTemplate = row({ isTemplate: true, templateScope: "organization" });
    const instance = row({ isTemplate: false, projectId: "proj-1" });
    const kept = excludeProjectTemplates([projectTemplate, orgTemplate, instance]);
    expect(kept).toHaveLength(2);
    expect(kept.some((r) => r.isTemplate && r.templateScope === "project")).toBe(false);
  });

  it("isProjectTemplate: true for a project template, false for a per-project instance", () => {
    expect(isProjectTemplate({ isTemplate: true, templateScope: "project" })).toBe(true);
    expect(isProjectTemplate({ isTemplate: false, templateScope: null })).toBe(false);
    expect(isProjectTemplate({ isTemplate: true, templateScope: "organization" })).toBe(false);
  });

  it("list INCLUDES a per-project instance only for an actor WITH a grant on that project", () => {
    const instance = row({ isTemplate: false, projectId: "proj-1" });
    const withGrant = filterReadableDashboards([instance], orgMember, [{ projectId: "proj-1", effectiveRole: "read" }]);
    expect(withGrant).toHaveLength(1);
    const withoutGrant = filterReadableDashboards([instance], orgMember, []);
    expect(withoutGrant).toHaveLength(0); // owner gate passes (org member, members visibility) but no project grant
  });

  it("a non-project org row visible to a member is kept regardless of grants", () => {
    const orgRow = row({ isTemplate: false, projectId: null });
    expect(filterReadableDashboards([orgRow], orgMember, [])).toHaveLength(1);
  });
});
