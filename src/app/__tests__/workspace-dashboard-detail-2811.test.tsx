// @vitest-environment jsdom
//
// cinatra#2811 (per-scope surfaces S5): a workspace dashboard's canonical
// surface, `/workspace/dashboards/<id>`.
//
// "Open navigates to the dashboard's canonical surface ... the tab points, it
// never renders a dashboard inline" (§IX). A workspace dashboard lives under
// the workspace page, and this route renders it:
//   - the non-removable Overview renders the workspace Overview FRESH (the
//     issue's `buildWorkspaceOverviewConfig`: the instance's display name and
//     namespace, and the viewer's counts), never a persisted summary;
//   - any other workspace dashboard renders its stored config;
//   - the route serves ONLY workspace rows, and only to their owner: any other
//     id, or another user's row, is not found (no existence leak).
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown>>,
  crumbs: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
  usePathname: () => "/workspace/dashboards/w-ov",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: async () => ({
    user: { id: "u1", role: "" },
    session: { activeOrganizationId: "org-a" },
  }),
  isPlatformAdmin: () => false,
}));
vi.mock("@/lib/dashboards/dashboard-actor", () => ({
  buildDashboardActorFromSession: async () => ({
    actor: { userId: "u1", orgId: "org-a", organizationId: "org-a" },
    orgId: "org-a",
    userId: "u1",
  }),
}));
vi.mock("@/lib/dashboards/authz", () => {
  class DashboardAccessError extends Error {
    readonly code = "dashboard_forbidden";
  }
  return {
    DashboardAccessError,
    requireDashboardAccess: async (actor: { userId: string }, id: string) => {
      const row = state.rows[id];
      if (!row || row.ownerId !== actor.userId) throw new DashboardAccessError("denied");
      return row;
    },
  };
});
vi.mock("@cinatra-ai/dashboards/extension-dashboard-reads", () => ({
  readDashboardRowById: async (id: string) => state.rows[id],
}));
vi.mock("@/lib/dashboards/workspace-dashboards.server", () => ({
  buildWorkspaceViewer: async () => ({ userId: "u1" }),
  readWorkspaceOverviewSummary: async () => ({
    instanceName: "Northwind Cinatra",
    namespace: "northwind",
    organizationCount: 2,
    teamCount: 3,
    projectCount: 1,
  }),
}));
vi.mock("@/components/dashboards/portlet-host", () => ({
  PortletHost: ({ portlets }: { portlets: unknown[] }) =>
    createElement("pre", { "data-testid": "portlets" }, JSON.stringify(portlets)),
}));
vi.mock("@/components/crumb-contributions", () => ({
  CrumbContributions: ({ entries }: { entries: unknown[] }) => {
    state.crumbs = entries;
    return null;
  },
}));

import { DASHBOARD_CONFIG_V12_VERSION } from "@cinatra-ai/dashboards/dashboard-config-v12";
import WorkspaceDashboardPage from "../workspace/dashboards/[dashboardId]/page";

const V12 = { apiVersion: DASHBOARD_CONFIG_V12_VERSION, scopeLevel: "user", portlets: [] };
const wsRow = (over: Record<string, unknown>) => ({
  id: "w",
  name: "N",
  description: null,
  configJson: V12,
  configVersion: "1.2",
  organizationId: null,
  ownerLevel: "user",
  ownerId: "u1",
  projectId: null,
  entityType: "workspace",
  entityId: "__workspace__",
  isDefault: false,
  isTemplate: false,
  templateScope: null,
  extensionId: null,
  status: "draft",
  ...over,
});

beforeEach(() => {
  state.rows = {
    "w-ov": wsRow({ id: "w-ov", name: "Overview", isDefault: true }),
    "w-mine": wsRow({ id: "w-mine", name: "Mine" }),
    "w-theirs": wsRow({ id: "w-theirs", name: "Theirs", ownerId: "u2" }),
    "o-dash": wsRow({
      id: "o-dash",
      name: "Org dash",
      organizationId: "org-a",
      entityType: "organization",
      entityId: "org-a",
      ownerLevel: "organization",
      ownerId: "u1",
    }),
  };
  state.crumbs = [];
});
afterEach(cleanup);

async function open(id: string) {
  const tree = await WorkspaceDashboardPage({ params: Promise.resolve({ dashboardId: id }) });
  render(tree as ReactNode);
}

describe("the workspace Overview renders fresh", () => {
  it("draws the instance's name and namespace and the viewer's counts, not the stored config", async () => {
    await open("w-ov");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Overview");
    const portlets = JSON.parse(screen.getByTestId("portlets").textContent ?? "[]") as Array<{
      kind: string;
      config: { items: unknown[] };
    }>;
    expect(portlets.map((p) => p.kind)).toEqual(["entity-metadata", "entity-count"]);
    expect(portlets[0].config.items).toEqual([
      { label: "Name", value: "Northwind Cinatra" },
      { label: "Namespace", value: "northwind" },
    ]);
    expect(portlets[1].config.items).toEqual([
      { label: "Organizations", value: 2 },
      { label: "Teams", value: 3 },
      { label: "Projects", value: 1 },
    ]);
  });

  it("publishes the workspace crumb, a non-linking Dashboards crumb, and the name", async () => {
    await open("w-ov");
    expect(state.crumbs).toEqual([
      { prefix: "/workspace", label: "Workspace" },
      { prefix: "/workspace/dashboards", label: "Dashboards", nonNavigable: true },
      { prefix: "/workspace/dashboards/w-ov", label: "Overview" },
    ]);
  });
});

describe("any other workspace dashboard renders its stored config", () => {
  it("hands the stored portlets to the host", async () => {
    await open("w-mine");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Mine");
    expect(screen.getByTestId("portlets").textContent).toBe("[]");
  });
});

describe("the route serves only workspace rows, and only to their owner", () => {
  it("is not found for an organization dashboard", async () => {
    await expect(open("o-dash")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is not found for another user's workspace dashboard, or an unknown id", async () => {
    await expect(open("w-theirs")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(open("nope")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
