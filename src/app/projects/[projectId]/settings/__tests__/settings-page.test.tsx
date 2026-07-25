/**
 * `/projects/[projectId]/settings` — the single project-management surface
 * (cinatra#1733, the #1693 teams ruling) — must:
 *   - 404-hide when actor lacks `project.read` (same gate the absorbed
 *     /permissions page ran)
 *   - render ScopeBadge + ProjectSharingPanel + the Project access grants
 *     section when allowed (everything the former Permissions tab showed)
 *   - wrap content in Main / PageHeader / PageContent, with NO ProjectSubnav
 *     (removed in #1733) and the "Settings" crumb leaf pinned
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// guest-actions imports @/lib/auth (top-level-await better-auth boot) — that
// module is always mocked in the vitest sandbox, so mock the actions surface.
vi.mock("../../permissions/guest-actions", () => ({
  inviteGuestByEmailAction: async () => ({ ok: false, error: "unknown" }),
  revokeGuestAction: async () => ({ ok: false }),
  listGuestRows: async () => [],
}));

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn(),
  requireActorContext: vi.fn(),
  getActorContext: vi.fn(),
  isPlatformAdmin: vi.fn(() => false),
}));

// The sealed-room read gate (#1898) consults `requireActorContext().projectGrants`.
// This helper wires BOTH the session (isPlatformAdmin probe) and the resolved
// actor (the grant gate) for a given user + optional grant on proj-1.
async function primeActor(userId: string, opts: { granted: boolean }) {
  const authSession = await import("@/lib/auth-session");
  (authSession.requireAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { id: userId },
    session: { activeOrganizationId: ORG_A },
  });
  (authSession.requireActorContext as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    principalId: userId,
    organizationId: ORG_A,
    projectGrants: opts.granted
      ? [{ projectId: "proj-1", effectiveRole: "owner", accessSource: "owner" }]
      : [],
  });
}
vi.mock("@/lib/projects-store", () => ({
  readProjectById: vi.fn(),
  readProjectCoOwners: vi.fn().mockResolvedValue([]),
  // The archived-parity read (badge only) — default: not archived.
  projectsDb: { execute: vi.fn().mockResolvedValue({ rows: [] }) },
}));
// Owner-name resolution (#1905) — default: unresolved (level-only badge).
vi.mock("@/lib/owner-display-names", () => ({
  readOwnerDisplayName: vi.fn().mockResolvedValue(null),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/projects/proj-1/settings",
}));

const ORG_A = "org-A";
const OWNER = "user-owner";
const STRANGER = "user-stranger";

const userOwnedProject = {
  id: "proj-1",
  name: "Demo project",
  ownerLevel: "user",
  ownerId: OWNER,
  organizationId: ORG_A,
};

describe("project settings page RSC (#1733)", () => {
  it("404-hides when actor lacks project.read", async () => {
    const { default: SettingsPage } = await import("../page");

    await primeActor(STRANGER, { granted: false });
    const projectsStore = (await import("@/lib/projects-store")) as unknown as {
      readProjectById: ReturnType<typeof vi.fn>;
    };
    projectsStore.readProjectById.mockResolvedValue(userOwnedProject);

    await expect(
      SettingsPage({ params: Promise.resolve({ projectId: userOwnedProject.id }) } as never),
    ).rejects.toThrow(/NEXT_NOT_FOUND/);
  });

  it("renders ScopeBadge + ProjectSharingPanel + grants section when allowed — no subnav, Settings crumb pinned", async () => {
    const { default: SettingsPage } = await import("../page");

    await primeActor(OWNER, { granted: true });
    const projectsStore = (await import("@/lib/projects-store")) as unknown as {
      readProjectById: ReturnType<typeof vi.fn>;
    };
    projectsStore.readProjectById.mockResolvedValue(userOwnedProject);

    const ui = (await SettingsPage({
      params: Promise.resolve({ projectId: userOwnedProject.id }),
    } as never)) as ReactElement;
    const html = renderToStaticMarkup(ui);

    expect(html).toMatch(/<main/);
    // The entity page h1 is the project name + kind label (spec §IX); "settings"
    // is communicated by the active Settings tab, not the heading.
    expect(html).toMatch(/Demo project/);
    expect(html).toMatch(/data-testid="scope-badge"/);
    expect(html).not.toMatch(/data-testid="access-combobox"/);
    expect(html).toMatch(/data-testid="project-sharing-panel"/);
    expect(html).toMatch(/data-testid="project-access-section"/);
    // Not archived → no lifecycle badge.
    expect(html).not.toMatch(/>Archived</);
    // The route-based subnav died with the standalone permissions page.
    expect(html).not.toMatch(/Permissions<\/a>/);
  });

  it("names the owner in the badge when resolution succeeds (#1905)", async () => {
    const { default: SettingsPage } = await import("../page");

    await primeActor(OWNER, { granted: true });
    const projectsStore = (await import("@/lib/projects-store")) as unknown as {
      readProjectById: ReturnType<typeof vi.fn>;
    };
    projectsStore.readProjectById.mockResolvedValue(userOwnedProject);
    const ownerNames = (await import("@/lib/owner-display-names")) as unknown as {
      readOwnerDisplayName: ReturnType<typeof vi.fn>;
    };
    ownerNames.readOwnerDisplayName.mockResolvedValueOnce("Jane Doe");

    const ui = (await SettingsPage({
      params: Promise.resolve({ projectId: userOwnedProject.id }),
    } as never)) as ReactElement;
    const html = renderToStaticMarkup(ui);

    expect(html).toContain("— Jane Doe");
    expect(html).toMatch(/Ownership: user — Jane Doe/);
  });

  it("shows the Archived badge on an archived project (detail-header parity)", async () => {
    const { default: SettingsPage } = await import("../page");

    await primeActor(OWNER, { granted: true });
    const projectsStore = (await import("@/lib/projects-store")) as unknown as {
      readProjectById: ReturnType<typeof vi.fn>;
      projectsDb: { execute: ReturnType<typeof vi.fn> };
    };
    projectsStore.readProjectById.mockResolvedValue(userOwnedProject);
    projectsStore.projectsDb.execute.mockResolvedValueOnce({
      rows: [{ archived_at: new Date("2026-01-01T00:00:00Z") }],
    });

    const ui = (await SettingsPage({
      params: Promise.resolve({ projectId: userOwnedProject.id }),
    } as never)) as ReactElement;
    const html = renderToStaticMarkup(ui);

    expect(html).toMatch(/>Archived</);
    expect(html).toMatch(/data-testid="project-sharing-panel"/);
  });
});
