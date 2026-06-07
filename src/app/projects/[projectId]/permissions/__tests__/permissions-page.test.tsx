/**
 * `/projects/[projectId]/permissions` route must:
 *   - 404-hide when actor lacks `project.read`
 *   - render ScopeBadge + AccessCombobox + ProjectSharingPanel when allowed
 *   - wrap content in Main / PageHeader / PageContent
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

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
  usePathname: () => "/projects/proj-1/permissions",
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

describe("permissions page RSC", () => {
  it("404-hides when actor lacks project.read", async () => {
    const { default: PermissionsPage } = await import("../page");

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
      PermissionsPage({ params: Promise.resolve({ projectId: userOwnedProject.id }) } as never),
    ).rejects.toThrow(/NEXT_NOT_FOUND/);
  });

  it("renders ScopeBadge + AccessCombobox + ProjectSharingPanel inside Main/PageHeader/PageContent when allowed", async () => {
    const { default: PermissionsPage } = await import("../page");

    const { requireAuthSession } = await import("@/lib/auth-session");
    (requireAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: OWNER },
      session: { activeOrganizationId: ORG_A },
    });
    const projectsStore = (await import("@/lib/projects-store")) as unknown as {
      readProjectById: ReturnType<typeof vi.fn>;
    };
    projectsStore.readProjectById.mockResolvedValue(userOwnedProject);

    const ui = (await PermissionsPage({
      params: Promise.resolve({ projectId: userOwnedProject.id }),
    } as never)) as ReactElement;
    const html = renderToStaticMarkup(ui);

    expect(html).toMatch(/<main/);
    expect(html).toMatch(/Demo project/);
    expect(html).toMatch(/data-testid="scope-badge"/);
    expect(html).toMatch(/data-testid="access-combobox"/);
    expect(html).toMatch(/data-testid="project-sharing-panel"/);
  });
});
