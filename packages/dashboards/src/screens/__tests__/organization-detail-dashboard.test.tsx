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
    getActorContext: vi.fn(),
    scopeSection: vi.fn(),
    buildScopeReferenceSource: vi.fn(
      (actor: unknown, scope: unknown): unknown => {
        void actor;
        void scope;
        return null;
      },
    ),
  };
});

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: h.getAuthSession,
  // cinatra#2474 PR2 — the screen now resolves the actor for the folded #1897
  // scope-collection panel (and fences it to the ACTIVE org).
  getActorContext: h.getActorContext,
}));
// The collection panel is a server component with its own I/O graph (the #1897
// service → objects store → artifact promotion). This screen's test is about the
// screen, so the panel is stubbed; its own behaviour is covered by
// `src/components/dashboards/__tests__/scope-dashboards-section-error-containment.test.ts`
// and the §IX conformance suite.
vi.mock("@/components/dashboards/scope-dashboards-section", () => ({
  ScopeDashboardsSection: (props: {
    scope: { orgId: string };
    entityLabel: string;
  }) => {
    h.scopeSection(props);
    // The stub renders the entity label the landing hands down, so the drawn
    // caption's own words ("The dashboards in Organization: Acme Inc.") are
    // readable back off this screen's markup without pulling the section's
    // whole I/O graph into this test.
    return <div data-testid="scope-dashboards-panel">{props.entityLabel}</div>;
  },
}));
// The §IX.1 add-to-scope binder (cinatra#2474 PR3) reaches the same #1897
// service graph the panel does (scope actions → service → objects store →
// artifact promotion). Stub it for the same reason; who it returns `null` for is
// covered by `src/components/dashboards/__tests__/scope-dashboards-conformance.test.ts`
// and the popup's behavioural test.
vi.mock("@/components/dashboards/scope-reference-binding", () => ({
  buildScopeReferenceSource: (actor: unknown, scope: unknown) =>
    h.buildScopeReferenceSource(actor, scope),
}));
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

function primeSession(userId = "u1", activeOrgId: string | undefined = "org-1") {
  h.getAuthSession.mockResolvedValue({ user: { id: userId } });
  // The actor's `organizationId` IS the session's active org — the axis the
  // folded collection panel is fenced on (cinatra#2474 PR2).
  h.getActorContext.mockResolvedValue({
    principalId: userId,
    organizationId: activeOrgId,
  });
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
  h.getActorContext.mockReset();
  h.scopeSection.mockReset();
  h.buildScopeReferenceSource.mockReset();
  h.buildScopeReferenceSource.mockReturnValue(null);
  h.state.queue = [];
});

describe("the Dashboards tab body on the organization landing (cinatra#2807 fix leg 5)", () => {
  // The retired `/organizations/[id]/dashboards` route refused any request whose
  // target org was not the session's ACTIVE org, and cinatra#2474 PR2 carried
  // that fence over the whole folded panel. The fourth proof round graded the
  // consequence: a member viewing an org that is not their active one gets NO
  // tab body at all — no caption, no empty reading, no Add — where personal,
  // team, project and Workspace all draw one.
  //
  // The drawing rules the read universal and gates only management: "A member
  // without write authority still sees the Dashboards tab and every row —
  // homed and listed alike — and opens any of them; they simply get no Add
  // affordance and no Remove control. Suppression, not a disabled control: a
  // management action the member cannot take is not rendered."
  //
  // So the fence stays exactly where the widening risk is — the §IX.1 add
  // source and the installed-catalog node, both of which BIND a mutation to the
  // ambient tenant — and comes off the read, which is already scoped by the
  // viewed org's own id behind the `readUserIsOrgMember` gate above.
  test("active org matches the target: the body renders, scoped to THIS org, naming the entity", async () => {
    primeSession("u1", "org-1");
    h.isMember.mockResolvedValue(true);
    h.state.queue = [[ACTIVE_ORG_ROW], MEMBER_ROWS];
    h.listTeams.mockResolvedValue([]);

    const html = await renderScreen();
    expect(html).toContain('data-testid="scope-dashboards-panel"');
    expect(h.scopeSection).toHaveBeenCalledTimes(1);
    expect(h.scopeSection.mock.calls[0]?.[0]).toMatchObject({
      scope: { kind: "organization", scopeId: "org-1", orgId: "org-1" },
      entityLabel: "Organization: Acme Inc",
    });
    expect(html).toContain("Organization: Acme Inc");
  });

  test("member of this org but ACTIVE elsewhere: the tab body STILL renders — only the add source is withheld", async () => {
    primeSession("u1", "org-2");
    h.isMember.mockResolvedValue(true);
    h.state.queue = [[ACTIVE_ORG_ROW], MEMBER_ROWS];
    h.listTeams.mockResolvedValue([]);

    const html = await renderScreen();
    // The read is universal to the scope's members: the body draws.
    expect(html).toContain('data-testid="scope-dashboards-panel"');
    expect(h.scopeSection).toHaveBeenCalledTimes(1);
    expect(h.scopeSection.mock.calls[0]?.[0]).toMatchObject({
      scope: { kind: "organization", scopeId: "org-1", orgId: "org-1" },
      entityLabel: "Organization: Acme Inc",
    });
    expect(html).toContain("Organization: Acme Inc");
    // cinatra#2474 PR3 — the unified popup's add source rides the tenant fence
    // still. An add path into a merely-member org would widen exactly what that
    // fence closes, so the binder is not even consulted: the Add is suppressed,
    // never rendered disabled.
    expect(h.buildScopeReferenceSource).not.toHaveBeenCalled();
    // The landing itself stays reachable for every member.
    expect(html).toContain("Acme Inc");
    expect(html).toContain('href="/organizations/org-1/settings"');
  });

  // CONVERGENCE round. Widening the READ must not also widen the WRITE surface.
  // `actorMayWriteScope` cannot be relied on to keep Remove suppressed out
  // here: its FIRST arm is `if (actor.platformRole === "platform_admin") return
  // true`, ahead of every tenant check, so a platform admin viewing a member
  // org that is not their active one would get `canRemove` true on every listed
  // row — an affordance this landing never offered, because the whole panel
  // used to be withheld. The mount therefore withholds the removal source
  // itself outside the active tenant: suppression, not a disabled control.
  test("ACTIVE elsewhere: the mount withholds removal, so no row can offer Remove", async () => {
    primeSession("u1", "org-2");
    h.isMember.mockResolvedValue(true);
    h.state.queue = [[ACTIVE_ORG_ROW], MEMBER_ROWS];
    h.listTeams.mockResolvedValue([]);

    await renderScreen();
    expect(h.scopeSection.mock.calls[0]?.[0]).toMatchObject({
      allowRemoval: false,
    });
  });

  test("ACTIVE elsewhere as a PLATFORM ADMIN: removal is still withheld", async () => {
    h.getAuthSession.mockResolvedValue({ user: { id: "u1" } });
    h.getActorContext.mockResolvedValue({
      principalId: "u1",
      organizationId: "org-2",
      // The cross-tenant writer the scope-ratchet convention grants. The read
      // widens for them like any member; the Remove affordance does not.
      platformRole: "platform_admin",
    });
    h.isMember.mockResolvedValue(true);
    h.state.queue = [[ACTIVE_ORG_ROW], MEMBER_ROWS];
    h.listTeams.mockResolvedValue([]);

    const html = await renderScreen();
    // The drawn read still lands — that is fix leg 5's whole point.
    expect(html).toContain('data-testid="scope-dashboards-panel"');
    expect(h.scopeSection.mock.calls[0]?.[0]).toMatchObject({
      allowRemoval: false,
    });
  });

  test("active org matches: removal IS offered (the shipped behaviour is untouched)", async () => {
    primeSession("u1", "org-1");
    h.isMember.mockResolvedValue(true);
    h.state.queue = [[ACTIVE_ORG_ROW], MEMBER_ROWS];
    h.listTeams.mockResolvedValue([]);

    await renderScreen();
    expect(h.scopeSection.mock.calls[0]?.[0]).toMatchObject({
      allowRemoval: true,
    });
  });

  test("active org matches: the §IX.1 add source IS built, for THIS org's scope (cinatra#2474 PR3)", async () => {
    primeSession("u1", "org-1");
    h.isMember.mockResolvedValue(true);
    h.state.queue = [[ACTIVE_ORG_ROW], MEMBER_ROWS];
    h.listTeams.mockResolvedValue([]);

    await renderScreen();
    expect(h.buildScopeReferenceSource).toHaveBeenCalledTimes(1);
    expect(h.buildScopeReferenceSource.mock.calls[0]?.[1]).toMatchObject({
      kind: "organization",
      scopeId: "org-1",
      orgId: "org-1",
    });
  });

  test("no resolvable actor: the panel is suppressed (fail-closed)", async () => {
    h.getAuthSession.mockResolvedValue({ user: { id: "u1" } });
    h.getActorContext.mockResolvedValue(undefined);
    h.isMember.mockResolvedValue(true);
    h.state.queue = [[ACTIVE_ORG_ROW], MEMBER_ROWS];
    h.listTeams.mockResolvedValue([]);

    const html = await renderScreen();
    expect(html).not.toContain('data-testid="scope-dashboards-panel"');
  });
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
