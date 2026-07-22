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
}));
vi.mock("@/lib/projects-store", () => ({
  readProjectById: vi.fn(),
  readProjectCoOwners: vi.fn().mockResolvedValue([]),
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

    const { requireAuthSession } = await import("@/lib/auth-session");
    (requireAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: STRANGER },
      session: { activeOrganizationId: ORG_A },
    });
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

    const { requireAuthSession } = await import("@/lib/auth-session");
    (requireAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: OWNER },
      session: { activeOrganizationId: ORG_A },
    });
    const projectsStore = (await import("@/lib/projects-store")) as unknown as {
      readProjectById: ReturnType<typeof vi.fn>;
    };
    projectsStore.readProjectById.mockResolvedValue(userOwnedProject);

    const ui = (await SettingsPage({
      params: Promise.resolve({ projectId: userOwnedProject.id }),
    } as never)) as ReactElement;
    const html = renderToStaticMarkup(ui);

    expect(html).toMatch(/<main/);
    expect(html).toMatch(/Project settings — Demo project/);
    expect(html).toMatch(/data-testid="scope-badge"/);
    expect(html).not.toMatch(/data-testid="access-combobox"/);
    expect(html).toMatch(/data-testid="project-sharing-panel"/);
    expect(html).toMatch(/data-testid="project-access-section"/);
    // The route-based subnav died with the standalone permissions page.
    expect(html).not.toMatch(/Permissions<\/a>/);
  });
});
