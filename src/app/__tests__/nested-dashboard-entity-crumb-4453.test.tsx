// A nested dashboard publishes its entity's name (cinatra#4453).
//
// The components drawing, Breadcrumb section: "A crumb that stands for an entity
// id shows that entity's display name, at every position, not only the last."
// The screen published only the dashboard's own crumb, so a direct load of a team
// or organization dashboard left the entity as the id placeholder.
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  AccessError: class DashboardAccessErrorStub extends Error {},
  requireDashboardAccess: vi.fn(),
  readScopeSurfaceEntityName: vi.fn(),
  row: {} as Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/dashboards/dashboard-actor", () => ({
  buildDashboardActorFromSession: vi.fn(async () => ({ actor: {} })),
}));
vi.mock("@/lib/dashboards/authz", () => ({
  requireDashboardAccess: mocks.requireDashboardAccess,
  DashboardAccessError: mocks.AccessError,
}));
vi.mock("@/lib/owner-display-names", () => ({ readOwnerDisplayName: vi.fn(async () => null) }));
vi.mock("@/lib/artifacts/artifact-owner-label", () => ({ artifactOwnerLabel: () => "Team" }));
vi.mock("@/lib/dashboards/live-extension-oracle", () => ({
  resolveLiveExtensionPredicate: vi.fn(async () => () => true),
}));
vi.mock("@cinatra-ai/dashboards/canonical-path", () => ({
  canonicalDashboardPath: (row: { canonical: string }) => row.canonical,
}));
vi.mock("@cinatra-ai/dashboards/extension-dashboard-reads", () => ({
  readDashboardRowById: vi.fn(async () => mocks.row),
  isProjectTemplate: () => false,
  isDashboardRowRenderable: () => true,
}));
vi.mock("@cinatra-ai/dashboards/extension-materialization", () => ({
  validateDashboardConfigV12: () => ({ ok: false }),
}));
vi.mock("@/components/dashboards/portlet-host", () => ({ PortletHost: () => null }));
vi.mock("@/components/scope-badge", () => ({ ScopeBadge: () => null }));
vi.mock("@/lib/scope-surface-entity-name", () => ({
  readScopeSurfaceEntityName: mocks.readScopeSurfaceEntityName,
}));
vi.mock("@/components/layout/main", () => ({
  Main: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/page-content", () => ({
  PageContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/components/crumb-contributions", () => ({
  CrumbContributions: ({ entries }: { entries: unknown }) => (
    <span data-testid="crumbs">{JSON.stringify(entries)}</span>
  ),
}));

import { DashboardDetailScreen } from "../dashboards/[id]/dashboard-detail-screen";

const TEAM_ID = "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a";
const DASHBOARD_ID = "dash-1";
const TEAM_PATH = `/teams/${TEAM_ID}/dashboards/${DASHBOARD_ID}`;

function crumbsIn(tree: unknown): { prefix: string; label: string }[] {
  const html = renderToStaticMarkup(tree as React.ReactElement);
  const m = /data-testid="crumbs">([^<]*)</.exec(html);
  if (!m) throw new Error("no crumbs published");
  return JSON.parse(m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

const teamScreen = () =>
  DashboardDetailScreen({
    id: DASHBOARD_ID,
    currentPath: TEAM_PATH,
    expectedAnchor: { entityType: "team", entityId: TEAM_ID },
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.row = {
    id: DASHBOARD_ID,
    name: "Pipeline",
    entityType: "team",
    entityId: TEAM_ID,
    ownerLevel: "team",
    ownerId: TEAM_ID,
    canonical: TEAM_PATH,
  };
  mocks.requireDashboardAccess.mockResolvedValue(undefined);
  mocks.readScopeSurfaceEntityName.mockResolvedValue("Best Team Ever");
});

describe("the entity crumb of a nested dashboard", () => {
  it("publishes the team's name beside the dashboard's", async () => {
    expect(crumbsIn(await teamScreen())).toEqual([
      { prefix: `/teams/${TEAM_ID}`, label: "Best Team Ever" },
      { prefix: TEAM_PATH, label: "Pipeline" },
    ]);
    expect(mocks.readScopeSurfaceEntityName).toHaveBeenCalledWith({ kind: "team", id: TEAM_ID });
  });

  it("publishes the organization's name on an organization dashboard", async () => {
    const path = `/organizations/org-1/dashboards/${DASHBOARD_ID}`;
    mocks.row = { ...mocks.row, entityType: "organization", entityId: "org-1", canonical: path };
    mocks.readScopeSurfaceEntityName.mockResolvedValue("Northwind");
    const tree = await DashboardDetailScreen({
      id: DASHBOARD_ID,
      currentPath: path,
      expectedAnchor: { entityType: "organization", entityId: "org-1" },
    });
    expect(crumbsIn(tree)).toEqual([
      { prefix: "/organizations/org-1", label: "Northwind" },
      { prefix: path, label: "Pipeline" },
    ]);
  });

  it("shows the fixed word, with no part of the id, when the name read refuses", async () => {
    mocks.readScopeSurfaceEntityName.mockResolvedValue(null);
    const crumbs = crumbsIn(await teamScreen());
    expect(crumbs[0]).toEqual({ prefix: `/teams/${TEAM_ID}`, label: "Team" });
    expect(crumbs[0]!.label).not.toContain(TEAM_ID.slice(0, 8));
  });

  it("reads no entity name before the access check passes", async () => {
    mocks.requireDashboardAccess.mockRejectedValue(new mocks.AccessError("refused"));
    await expect(teamScreen()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.readScopeSurfaceEntityName).not.toHaveBeenCalled();
  });

  it("reads no entity name on the flat route, which has no anchor to name", async () => {
    mocks.row = { ...mocks.row, entityType: null, entityId: null, canonical: "/dashboards/dash-1" };
    const tree = await DashboardDetailScreen({
      id: DASHBOARD_ID,
      currentPath: "/dashboards/dash-1",
    });
    expect(crumbsIn(tree)).toEqual([{ prefix: "/dashboards/dash-1", label: "Pipeline" }]);
    expect(mocks.readScopeSurfaceEntityName).not.toHaveBeenCalled();
  });
});
