import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";

// Role-driven blog dashboard URL resolution (cinatra#151 Stage 6): the
// dashboard-owning extension comes from the manifest-declared
// "blog-operator-dashboard" role; absence (reduced universes) degrades to the
// `/artifacts` surface — never a hard-coded package name, never a throw. The
// workspace-wide `/dashboards` directory page was retired with no redirect
// (cinatra#2058), so the degrade target is `/artifacts`, not a dead index link.
vi.mock("@/lib/extension-roles", () => ({
  resolveExtensionRole: vi.fn(),
}));
vi.mock("@cinatra-ai/dashboards/extension-dashboard-reads", () => ({
  listOrgDashboardRows: vi.fn(),
  excludeProjectTemplates: (rows: Array<{ isTemplate?: boolean; templateScope?: string }>) =>
    rows.filter((r) => !(r.isTemplate === true && r.templateScope === "project")),
  // Faithful pure gate (cinatra#1628): operator rows always pass; an extension
  // row is dropped when archived OR non-live.
  filterRenderableDashboards: (
    rows: Array<{ extensionId?: string | null; status?: string }>,
    isLive: (id: string) => boolean,
  ) => rows.filter((r) => r.extensionId == null || (r.status !== "archived" && isLive(r.extensionId))),
}));
// The reader-gate liveness oracle (cinatra#1628) — controllable per test.
vi.mock("@/lib/dashboards/live-extension-oracle", () => ({
  resolveLiveExtensionPredicate: vi.fn(),
}));

import { resolveBlogDashboardUrl } from "@/lib/blog/dashboard-url";
import { resolveExtensionRole } from "@/lib/extension-roles";
import { listOrgDashboardRows } from "@cinatra-ai/dashboards/extension-dashboard-reads";
import { resolveLiveExtensionPredicate } from "@/lib/dashboards/live-extension-oracle";

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
  // Default: the resolved claimant is live (isolates the role-resolution tests
  // from the liveness gate; the gate is exercised explicitly below).
  vi.mocked(resolveLiveExtensionPredicate).mockReset();
  vi.mocked(resolveLiveExtensionPredicate).mockResolvedValue(() => true);
});

describe("resolveBlogDashboardUrl — role-resolved owner", () => {
  it("resolves the role claimant's project row first, then the org row", async () => {
    vi.mocked(resolveExtensionRole).mockReturnValue("@cinatra-ai/fixture-blog-workflow");
    expect(await resolveBlogDashboardUrl(actor, "proj-1")).toBe("/dashboards/row-blog-proj");
    expect(await resolveBlogDashboardUrl(actor)).toBe("/dashboards/row-blog-org");
  });

  it("degrades to the /artifacts fallback when NO present extension claims the role (reduced universe)", async () => {
    vi.mocked(resolveExtensionRole).mockReturnValue(undefined);
    expect(await resolveBlogDashboardUrl(actor, "proj-1")).toBe("/artifacts");
    // No row lookup needed when the role is unclaimed.
    expect(vi.mocked(listOrgDashboardRows)).not.toHaveBeenCalled();
  });

  it("degrades to the /artifacts fallback when the claimant has no materialized row", async () => {
    vi.mocked(resolveExtensionRole).mockReturnValue("@cinatra-ai/fixture-unmaterialized-workflow");
    expect(await resolveBlogDashboardUrl(actor)).toBe("/artifacts");
  });

  it("degrades to the /artifacts fallback when the claimant's rows are ORPHANED (reader gate, cinatra#1628)", async () => {
    vi.mocked(resolveExtensionRole).mockReturnValue("@cinatra-ai/fixture-blog-workflow");
    // Liveness oracle denies the (now-uninstalled) blog package → its rows are
    // orphaned + filtered, so the deep-link never resolves to a would-404 detail.
    vi.mocked(resolveLiveExtensionPredicate).mockResolvedValue(() => false);
    expect(await resolveBlogDashboardUrl(actor, "proj-1")).toBe("/artifacts");
    expect(await resolveBlogDashboardUrl(actor)).toBe("/artifacts");
  });
});
