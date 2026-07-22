/**
 * `/organizations/[id]/settings` screen (cinatra#1734) — the single
 * org-management surface:
 *   - fail-closed: non-member → notFound BEFORE any org read
 *   - read-only member: access-model panel ONLY — no manage panel, and the
 *     capability-gated loaders (invitations, delete blockers) are NEVER
 *     called (codex round: negative data-loading branches pinned)
 *   - manager: access model + manage panel (settings / members / danger zone
 *     composition itself is the manage-panel test's job)
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
    execute: vi.fn(),
    isMember: vi.fn(),
    listTeams: vi.fn(),
    resolveCaps: vi.fn(),
    countBlockers: vi.fn(),
    getAuthSession: vi.fn(),
  };
});

vi.mock("@/lib/auth-session", () => ({ getAuthSession: h.getAuthSession }));
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { select: h.select, execute: h.execute },
  betterAuthMembers: { id: "m.id", userId: "m.userId", role: "m.role", organizationId: "m.orgId" },
  betterAuthOrganizations: { id: "o.id", name: "o.name", slug: "o.slug" },
  betterAuthUsers: { id: "u.id", name: "u.name", email: "u.email" },
  listTeamsForOrg: h.listTeams,
  readUserIsOrgMember: h.isMember,
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  sql: Object.assign(() => ({}), { raw: (s: string) => s }),
}));
vi.mock("../../auth/security-context", () => ({
  buildSecurityContextFromSession: (session: unknown) =>
    session ? { userId: (session as { user: { id: string } }).user.id } : null,
}));
vi.mock("@/lib/authz/organization-manage-gate", () => ({
  resolveOrganizationManageCapabilities: h.resolveCaps,
}));
vi.mock("@/lib/organization-delete", () => ({
  countOrganizationDeleteBlockers: h.countBlockers,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (target: string) => {
    throw new Error(`NEXT_REDIRECT:${target}`);
  },
  usePathname: () => "/organizations/org-1/settings",
}));
// Stub the manage panel's interactive children (authClient / toast / router) —
// composition inside the panel is organization-manage-panel.test.tsx's job.
vi.mock("../../components/organization-settings-form", () => ({
  OrganizationSettingsForm: () => <div data-testid="settings-form" />,
}));
vi.mock("../../components/organization-members-manager", () => ({
  OrganizationMembersManager: () => <div data-testid="members-manager" />,
}));
vi.mock("../../components/organization-delete-danger-form", () => ({
  OrganizationDeleteDangerForm: () => <div data-testid="delete-danger-form" />,
}));

import { OrganizationSettingsPage } from "../organization-settings";

const ORG_ROW = { name: "Acme Inc", slug: "acme" };
const MEMBER_ROWS = [
  { id: "m1", userId: "u1", role: "owner", name: "Jane", email: "j@x.com" },
  { id: "m2", userId: "u2", role: "member", name: "Bob", email: "b@x.com" },
];
const NO_CAPS = {
  canManageSettings: false,
  canManageMembers: false,
  canDelete: false,
  canArchive: false,
};
const ALL_CAPS = {
  canManageSettings: true,
  canManageMembers: true,
  canDelete: true,
  canArchive: false,
};
const NO_BLOCKERS = { teams: 0, activeProjects: 0, connectors: 0, dashboards: 0, agents: 0 };

function primeSession(userId = "u1") {
  h.getAuthSession.mockResolvedValue({ user: { id: userId } });
}

async function renderScreen(): Promise<string> {
  const ui = (await OrganizationSettingsPage({
    params: Promise.resolve({ id: "org-1" }),
  })) as ReactElement;
  return renderToStaticMarkup(ui);
}

beforeEach(() => {
  h.select.mockClear();
  h.execute.mockReset();
  h.isMember.mockReset();
  h.listTeams.mockReset();
  h.resolveCaps.mockReset();
  h.countBlockers.mockReset();
  h.getAuthSession.mockReset();
  h.state.queue = [];
});

describe("organization settings screen (#1734)", () => {
  test("non-member 404s BEFORE any org read (fail closed)", async () => {
    primeSession();
    h.isMember.mockResolvedValue(false);
    await expect(renderScreen()).rejects.toThrow(/NEXT_NOT_FOUND/);
    expect(h.select).not.toHaveBeenCalled();
    expect(h.resolveCaps).not.toHaveBeenCalled();
  });

  test("read-only member: access model only, and the privileged loaders never run", async () => {
    primeSession();
    h.isMember.mockResolvedValue(true);
    h.state.queue = [[ORG_ROW], MEMBER_ROWS];
    h.listTeams.mockResolvedValue([{ id: "t1", name: "Team A" }]);
    h.resolveCaps.mockResolvedValue(NO_CAPS);

    const html = await renderScreen();
    expect(html).toContain("Organization settings — Acme Inc");
    expect(html).toContain('data-cinatra-org-permissions="true"');
    expect(html).not.toContain("data-cinatra-org-manage");
    expect(html).not.toContain("settings-form");
    expect(html).not.toContain("delete-danger-form");
    // Negative data-loading pins: no invitations read, no blocker count.
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.countBlockers).not.toHaveBeenCalled();
  });

  test("manager: access model + manage panel, capability-gated loads run", async () => {
    primeSession();
    h.isMember.mockResolvedValue(true);
    h.state.queue = [[ORG_ROW], MEMBER_ROWS];
    h.listTeams.mockResolvedValue([]);
    h.resolveCaps.mockResolvedValue(ALL_CAPS);
    h.execute.mockResolvedValue({ rows: [] });
    h.countBlockers.mockResolvedValue(NO_BLOCKERS);

    const html = await renderScreen();
    expect(html).toContain('data-cinatra-org-permissions="true"');
    expect(html).toContain('data-cinatra-org-manage="true"');
    expect(html).toContain("settings-form");
    expect(html).toContain("members-manager");
    expect(html).toContain("delete-danger-form");
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.countBlockers).toHaveBeenCalledTimes(1);
  });

  test("deleted org (membership row without an org row) 404s", async () => {
    primeSession();
    h.isMember.mockResolvedValue(true);
    h.state.queue = [[], MEMBER_ROWS];
    h.listTeams.mockResolvedValue([]);
    await expect(renderScreen()).rejects.toThrow(/NEXT_NOT_FOUND/);
  });
});
