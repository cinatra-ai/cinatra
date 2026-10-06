// @vitest-environment jsdom
//
// cinatra#2811 (per-scope surfaces S5), acceptance: "Personal is proven
// unchanged by a behavioral regression fixture, not a source-presence claim."
//
// The workspace slice widens the listing kinds, the tab row type and the
// dashboards store (org-NULL workspace rows, workspace references). This
// fixture RENDERS the personal Dashboards tab body through its real server
// section, with the store read stood in, and asserts the behavior the personal
// scope has on the default branch: the acting user's own rows under the
// "The dashboards you own." caption, each with Open only, and no Add, no
// reference section, no Remove and no everyone mark. It also pins the read the
// section makes: the org-fenced own-rows read, never the workspace store.
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("server-only", () => ({}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement("a", { href, ...rest }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

const store = vi.hoisted(() => ({
  listUserHomedDashboards: vi.fn(),
  listUserWorkspaceDashboards: vi.fn(),
  listWorkspaceReferenceRows: vi.fn(),
}));
vi.mock("@cinatra-ai/dashboards/entity-links", () => ({
  listUserHomedDashboards: store.listUserHomedDashboards,
  listUserWorkspaceDashboards: store.listUserWorkspaceDashboards,
  listWorkspaceReferenceRows: store.listWorkspaceReferenceRows,
  listScopeHomedDashboards: vi.fn(async () => []),
  listScopeListedDashboards: vi.fn(async () => []),
  listScopePresentDashboardIds: vi.fn(async () => new Set()),
  addDashboardEntityLink: vi.fn(),
  removeDashboardEntityLink: vi.fn(),
  dashboardNamesByIds: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/objects-store", () => ({ readObjectsByType: () => [] }));
vi.mock("@/lib/artifacts/artifact-promotion-request", () => ({ requestArtifactPromotion: vi.fn() }));
vi.mock("@/lib/derived-store-ownership", () => ({ actorMaySeeRow: () => false }));

import { PersonalDashboardsSection } from "@/components/dashboards/personal-dashboards-section";

const NOW = new Date("2026-09-22T10:00:00Z");

beforeEach(() => {
  store.listUserHomedDashboards.mockReset();
  store.listUserWorkspaceDashboards.mockReset();
  store.listWorkspaceReferenceRows.mockReset();
  store.listUserHomedDashboards.mockResolvedValue([
    {
      dashboardId: "p-weekly",
      name: "Weekly focus",
      updatedAt: NOW,
      extensionId: null,
      ownerLevel: "user",
      ownerId: "u1",
      projectId: null,
      entityType: "personal",
      entityId: "org-a",
      organizationId: "org-a",
      relation: "home",
    },
    {
      dashboardId: "p-reading",
      name: "Reading queue",
      updatedAt: NOW,
      extensionId: null,
      ownerLevel: "user",
      ownerId: "u1",
      projectId: null,
      entityType: "personal",
      entityId: "org-a",
      organizationId: "org-a",
      relation: "home",
    },
  ]);
});

afterEach(cleanup);

describe("the personal Dashboards tab keeps its landed shape", () => {
  it("lists the acting user's own dashboards, org-fenced, under its own caption", async () => {
    render(await PersonalDashboardsSection({ orgId: "org-a", userId: "u1" }));
    expect(store.listUserHomedDashboards).toHaveBeenCalledWith({ orgId: "org-a", userId: "u1" });
    // The workspace store is never consulted for the personal scope.
    expect(store.listUserWorkspaceDashboards).not.toHaveBeenCalled();
    expect(store.listWorkspaceReferenceRows).not.toHaveBeenCalled();
    expect(screen.getByTestId("scope-dashboards-caption").textContent).toBe("The dashboards you own.");
    expect(document.querySelectorAll("li").length).toBe(2);
  });

  it("draws each row with Open alone: no Remove, no everyone mark", async () => {
    render(await PersonalDashboardsSection({ orgId: "org-a", userId: "u1" }));
    for (const name of ["Weekly focus", "Reading queue"]) {
      const row = screen.getByText(name).closest("li") as HTMLElement;
      expect(within(row).getByRole("link", { name: "Open" })).toBeTruthy();
      expect(within(row).queryByRole("button")).toBeNull();
      expect(within(row).queryByRole("switch")).toBeNull();
    }
    expect(document.body.textContent).not.toContain("Visible to everyone");
  });

  it("carries no Add affordance and no reference section", async () => {
    render(await PersonalDashboardsSection({ orgId: "org-a", userId: "u1" }));
    expect(screen.queryByRole("button", { name: /Add dashboard/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Reference/);
    expect(document.querySelector('[data-action="open-add-picker -> add-picker-open"]')).toBeNull();
  });
});
