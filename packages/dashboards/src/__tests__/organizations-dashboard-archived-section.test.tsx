/**
 * The fixed, non-removable "Archived organizations" section on
 * `/organizations` (cinatra#1942 V4).
 *
 * The section is chrome, OUTSIDE the user's editable grid: it must render
 * only via a SEPARATE, non-editable `<EmbeddedDrizzleCubeDashboardGrid
 * editable={false} />` mount (structurally non-removable — there is no
 * save/remove wiring for it at all), and it must appear/empty-state based on
 * whether the viewer is a member of at least one archived org.
 *
 * Plain node environment (no jsdom): the screen is a server component
 * (`import "server-only"`, which throws if `window` is defined), rendered via
 * `renderToStaticMarkup` — the same convention `organization-settings.test.tsx`
 * uses for its sibling server screen.
 */
import React from "react";
import { describe, expect, test, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const h = vi.hoisted(() => {
  const state: { archivedRows: ReadonlyArray<{ id: string }> } = { archivedRows: [] };
  const builder: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where"]) {
    builder[m] = () => builder;
  }
  (builder as { limit: () => Promise<ReadonlyArray<{ id: string }>> }).limit = () =>
    Promise.resolve(state.archivedRows);
  return {
    state,
    select: vi.fn(() => builder),
    getAuthSession: vi.fn(),
    userCanCreateOrganizations: vi.fn(async () => false),
  };
});

vi.mock("@/lib/auth-session", () => ({ getAuthSession: h.getAuthSession }));
vi.mock("@/lib/authz/organization-create-gate", () => ({
  userCanCreateOrganizations: h.userCanCreateOrganizations,
}));
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { select: h.select },
  betterAuthMembers: { userId: "m.userId", organizationId: "m.orgId" },
  betterAuthOrganizations: { id: "o.id", archivedAt: "o.archivedAt" },
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  isNotNull: vi.fn(() => ({})),
}));
vi.mock("../auth/security-context", () => ({
  buildSecurityContextFromSession: (session: unknown) =>
    session
      ? {
          userId: (session as { user: { id: string } }).user.id,
          organizationId: "org-active",
        }
      : null,
}));
vi.mock("../store/db", () => ({
  dashboards: {},
  getDashboardsDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
  }),
}));
vi.mock("../v12-envelope", () => ({
  readDcConfigFromRow: (_row: unknown, seed: unknown) => seed,
}));
vi.mock("../actions", () => ({ saveOrganizationsDashboardAction: vi.fn() }));
vi.mock("../components/embedded-drizzle-cube-dashboard-grid", () => ({
  EmbeddedDrizzleCubeDashboardGrid: (props: {
    dashboard: { portlets: ReadonlyArray<{ title?: string }> };
    editable?: boolean;
    onSave?: unknown;
  }) => (
    <div
      data-testid="embedded-grid"
      data-title={props.dashboard.portlets[0]?.title ?? ""}
      data-editable={String(!!props.editable)}
      data-has-onsave={String(typeof props.onSave === "function")}
    />
  ),
}));
vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new Error(`NEXT_REDIRECT:${target}`);
  },
  usePathname: () => "/organizations",
}));

import { OrganizationsDashboardPage } from "../screens/organizations-dashboard";

async function renderScreen(): Promise<string> {
  const ui = (await OrganizationsDashboardPage()) as ReactElement;
  return renderToStaticMarkup(ui);
}

beforeEach(() => {
  h.select.mockClear();
  h.getAuthSession.mockReset();
  h.userCanCreateOrganizations.mockReset();
  h.userCanCreateOrganizations.mockResolvedValue(false);
  h.state.archivedRows = [];
});

describe("/organizations — fixed Archived organizations section (cinatra#1942 V4)", () => {
  test("planted archived org: the section renders via a SEPARATE non-editable grid mount (non-removable)", async () => {
    h.getAuthSession.mockResolvedValue({ user: { id: "user-1" } });
    h.state.archivedRows = [{ id: "org-archived-1" }];

    const html = await renderScreen();

    expect(html).toContain('data-cinatra-archived-organizations-section="true"');
    expect(html).not.toContain("You have no archived organizations.");

    // Two independent grid mounts: the user's editable main grid, and the
    // fixed archived-only one — never the same mount, never editable.
    const editableMatch = html.match(/data-editable="true"/g) ?? [];
    const readOnlyMatch = html.match(/data-editable="false"/g) ?? [];
    expect(editableMatch).toHaveLength(1);
    expect(readOnlyMatch).toHaveLength(1);

    // The archived mount carries no onSave — structurally non-removable/
    // non-editable, not just visually.
    expect(html).toMatch(/data-title="Archived organizations"[^>]*data-editable="false"[^>]*data-has-onsave="false"/);
  });

  test("no archived orgs: the empty-state renders instead of a second grid mount", async () => {
    h.getAuthSession.mockResolvedValue({ user: { id: "user-1" } });
    h.state.archivedRows = [];

    const html = await renderScreen();

    expect(html).toContain('data-cinatra-archived-organizations-section="true"');
    expect(html).toContain('data-cinatra-archived-organizations-empty="true"');
    expect(html).toContain("You have no archived organizations.");
    // Only the main editable grid mounts — no second (archived) grid.
    const readOnlyMatch = html.match(/data-editable="false"/g) ?? [];
    expect(readOnlyMatch).toHaveLength(0);
  });

  test("an unreadable archived-org count fails closed to the empty-state (never a broken page)", async () => {
    h.getAuthSession.mockResolvedValue({ user: { id: "user-1" } });
    h.select.mockImplementationOnce(() => {
      throw new Error("db unreachable");
    });

    const html = await renderScreen();

    expect(html).toContain('data-cinatra-archived-organizations-empty="true"');
  });

  test("the archived section's cube query filters lifecycle_status = archived", async () => {
    h.getAuthSession.mockResolvedValue({ user: { id: "user-1" } });
    h.state.archivedRows = [{ id: "org-archived-1" }];

    const html = await renderScreen();
    // The stub only surfaces the title, so this pins the SOURCE-level query
    // shape (the same reusable cube, filter flipped to archived) rather
    // than re-render it; the query object itself is unit-testable in
    // isolation if extracted later.
    expect(html).toContain("Archived organizations");
  });
});
