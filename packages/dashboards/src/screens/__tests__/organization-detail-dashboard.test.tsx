/**
 * `/organizations/[id]` detail screen (cinatra#1942 V4):
 * "Archived — read-only" banner + LifecycleBadge, threaded from `archivedAt`
 * read directly off the org row (never the archive activation gate).
 */
import React from "react";
import { describe, expect, test, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const h = vi.hoisted(() => {
  const state: { queue: unknown[] } = { queue: [] };
  const builder: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "leftJoin"]) {
    builder[m] = () => builder;
  }
  (builder as { then: (resolve: (v: unknown) => void) => void }).then = (resolve) =>
    resolve(state.queue.shift());
  return {
    state,
    select: vi.fn(() => builder),
    isMember: vi.fn(),
    listTeams: vi.fn(),
    getAuthSession: vi.fn(),
  };
});

vi.mock("@/lib/auth-session", () => ({ getAuthSession: h.getAuthSession }));
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { select: h.select },
  betterAuthMembers: { id: "m.id", userId: "m.userId", role: "m.role", organizationId: "m.orgId" },
  betterAuthOrganizations: { id: "o.id", name: "o.name", slug: "o.slug", archivedAt: "o.archivedAt" },
  betterAuthUsers: { id: "u.id", name: "u.name", email: "u.email" },
  listTeamsForOrg: h.listTeams,
  readUserIsOrgMember: h.isMember,
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
}));
vi.mock("../../auth/security-context", () => ({
  buildSecurityContextFromSession: (session: unknown) =>
    session ? { userId: (session as { user: { id: string } }).user.id } : null,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (target: string) => {
    throw new Error(`NEXT_REDIRECT:${target}`);
  },
  usePathname: () => "/organizations/org-1",
}));
vi.mock("../../components/organization-dashboards", () => ({
  OrganizationDashboards: () => <div data-testid="org-dashboards" />,
}));
vi.mock("../organization-detail-actions", () => ({
  createOrganizationDashboardAction: vi.fn(),
  deleteOrganizationDashboardAction: vi.fn(),
  ensureAndListOrganizationDashboardsAction: vi.fn(),
  getOrganizationDashboardConfigAction: vi.fn(),
  renameOrganizationDashboardAction: vi.fn(),
  saveOrganizationDashboardConfigAction: vi.fn(),
}));

import { OrganizationDetailDashboardPage } from "../organization-detail-dashboard";

const ACTIVE_ORG_ROW = { name: "Acme Inc", slug: "acme", archivedAt: null };
const ARCHIVED_ORG_ROW = {
  name: "Acme Inc",
  slug: "acme",
  archivedAt: new Date("2026-01-01T00:00:00.000Z"),
};
const MEMBER_ROWS: unknown[] = [];

function primeSession(userId = "u1") {
  h.getAuthSession.mockResolvedValue({ user: { id: userId } });
}

async function renderScreen(): Promise<string> {
  const ui = (await OrganizationDetailDashboardPage({
    params: Promise.resolve({ id: "org-1" }),
  })) as ReactElement;
  return renderToStaticMarkup(ui);
}

beforeEach(() => {
  h.select.mockClear();
  h.isMember.mockReset();
  h.listTeams.mockReset();
  h.getAuthSession.mockReset();
  h.state.queue = [];
});

describe("org detail screen — archived read-only posture (cinatra#1942 V4)", () => {
  test("planted archived org: the banner AND the header LifecycleBadge render", async () => {
    primeSession();
    h.isMember.mockResolvedValue(true);
    h.state.queue = [[ARCHIVED_ORG_ROW], MEMBER_ROWS];
    h.listTeams.mockResolvedValue([]);

    const html = await renderScreen();
    expect(html).toContain('data-cinatra-archived-banner="true"');
    expect(html).toContain("Archived — read-only");
    // The copy claims read-only for settings/membership ONLY — the viewer's
    // own dashboards ABOUT the org stay editable, so the banner must never
    // overclaim them.
    expect(html).toContain(
      "This organization is archived. Its settings and membership can&#x27;t be changed until it&#x27;s unarchived.",
    );
    expect(html).not.toContain("Its dashboards");
    // The header badge (LifecycleBadge → StatusPill "Archived" label).
    expect(html).toContain("Archived");
    expect(html).toContain('data-lifecycle="archived"');
  });

  test("active org: no banner, no badge", async () => {
    primeSession();
    h.isMember.mockResolvedValue(true);
    h.state.queue = [[ACTIVE_ORG_ROW], MEMBER_ROWS];
    h.listTeams.mockResolvedValue([]);

    const html = await renderScreen();
    expect(html).not.toContain('data-cinatra-archived-banner="true"');
    expect(html).not.toContain('data-lifecycle="archived"');
  });

  test("non-member still 404s BEFORE any org read (unaffected by the archived posture)", async () => {
    primeSession();
    h.isMember.mockResolvedValue(false);
    await expect(renderScreen()).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(h.select).not.toHaveBeenCalled();
  });
});
