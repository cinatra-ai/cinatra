import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";

// Role-driven blog dashboard URL resolution (cinatra#151 Stage 6): the
// dashboard-owning extension comes from the manifest-declared
// "blog-operator-dashboard" role; absence (reduced universes) degrades to the
// dashboards index — never a hard-coded package name, never a throw.
vi.mock("@/lib/extension-roles", () => ({
  resolveExtensionRole: vi.fn(),
}));
vi.mock("@cinatra-ai/dashboards/extension-dashboard-reads", () => ({
  listOrgDashboardRows: vi.fn(),
  excludeProjectTemplates: (rows: Array<{ isTemplate?: boolean; templateScope?: string }>) =>
    rows.filter((r) => !(r.isTemplate === true && r.templateScope === "project")),
}));

import { resolveBlogDashboardUrl } from "@/lib/blog/dashboard-url";
import { resolveExtensionRole } from "@/lib/extension-roles";
import { listOrgDashboardRows } from "@cinatra-ai/dashboards/extension-dashboard-reads";

const actor = { organizationId: "org-1" } as ActorContext;
const rows = [
  { id: "row-blog-org", extensionId: "@cinatra-ai/fixture-blog-workflow", projectId: null },
  { id: "row-blog-proj", extensionId: "@cinatra-ai/fixture-blog-workflow", projectId: "proj-1" },
  { id: "row-other", extensionId: "@cinatra-ai/fixture-other-workflow", projectId: null },
];

beforeEach(() => {
  vi.mocked(resolveExtensionRole).mockReset();
  vi.mocked(listOrgDashboardRows).mockReset();
  vi.mocked(listOrgDashboardRows).mockResolvedValue(rows as never);
});

describe("resolveBlogDashboardUrl — role-resolved owner", () => {
  it("resolves the role claimant's project row first, then the org row", async () => {
    vi.mocked(resolveExtensionRole).mockReturnValue("@cinatra-ai/fixture-blog-workflow");
    expect(await resolveBlogDashboardUrl(actor, "proj-1")).toBe("/dashboards/row-blog-proj");
    expect(await resolveBlogDashboardUrl(actor)).toBe("/dashboards/row-blog-org");
  });

  it("degrades to the dashboards index when NO present extension claims the role (reduced universe)", async () => {
    vi.mocked(resolveExtensionRole).mockReturnValue(undefined);
    expect(await resolveBlogDashboardUrl(actor, "proj-1")).toBe("/dashboards");
    // No row lookup needed when the role is unclaimed.
    expect(vi.mocked(listOrgDashboardRows)).not.toHaveBeenCalled();
  });

  it("degrades to the dashboards index when the claimant has no materialized row", async () => {
    vi.mocked(resolveExtensionRole).mockReturnValue("@cinatra-ai/fixture-unmaterialized-workflow");
    expect(await resolveBlogDashboardUrl(actor)).toBe("/dashboards");
  });
});
