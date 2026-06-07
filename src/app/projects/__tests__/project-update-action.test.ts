/**
 * Project update + delete server actions must:
 *   - throw AuthzError for non-owner / non-co-owner / non-admin
 *   - reject delete from co-owner (owner-only delete)
 *   - ignore client-supplied ownerLevel/ownerId (mass-assignment defense)
 */
import { describe, it, expect, vi } from "vitest";

import { updateProjectAction, deleteProjectAction } from "@/app/projects/actions";
import { AuthzError } from "@/lib/authz/errors";

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn(),
}));

const ORG_A = "org-A";
const OWNER = "user-owner";
const COOWNER = "user-coowner";
const STRANGER = "user-stranger";

const userOwnedProject = {
  id: "proj-1",
  name: "Project One",
  description: null,
  ownerLevel: "user" as const,
  ownerId: OWNER,
  organizationId: ORG_A,
  visibility: "private" as const,
  coOwnerUserIds: [COOWNER],
};

// Mock the DAOs the actions consume so the test runs without a live Postgres.
// Each action only needs read+write surface; the gate is what we are exercising.
vi.mock("@/lib/projects-store-dao", () => ({
  readProjectById: vi.fn(async () => ({
    id: userOwnedProject.id,
    name: userOwnedProject.name,
    description: userOwnedProject.description,
    ownerLevel: userOwnedProject.ownerLevel,
    ownerId: userOwnedProject.ownerId,
    visibility: userOwnedProject.visibility,
    organizationId: userOwnedProject.organizationId,
  })),
  updateProject: vi.fn(async () => undefined),
  deleteProject: vi.fn(async () => undefined),
}));

vi.mock("@/lib/project-co-owners-store", () => ({
  readProjectCoOwners: vi.fn(async () => [
    { projectId: "proj-1", userId: COOWNER, grantedBy: OWNER, grantedAt: new Date() },
  ]),
}));

describe("updateProjectAction authorization", () => {
  it("throws AuthzError for non-owner / non-co-owner / non-admin", async () => {
    const formData = new FormData();
    formData.set("projectId", userOwnedProject.id);
    formData.set("name", "renamed");

    // Mock session as stranger.
    const { requireAuthSession } = await import("@/lib/auth-session");
    (requireAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: STRANGER },
      session: { activeOrganizationId: ORG_A },
    });

    await expect(updateProjectAction(formData)).rejects.toBeInstanceOf(AuthzError);
  });

  it("ignores client-supplied ownerLevel (mass-assignment guard)", async () => {
    const formData = new FormData();
    formData.set("projectId", userOwnedProject.id);
    formData.set("ownerLevel", "organization"); // attacker tries to escalate
    formData.set("ownerId", ORG_A);
    formData.set("name", "renamed");

    const { requireAuthSession } = await import("@/lib/auth-session");
    (requireAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: OWNER },
      session: { activeOrganizationId: ORG_A },
    });

    // Action must succeed because the owner can rename, but the persisted
    // ownerLevel must remain "user". Here we only assert the call shape:
    // form-supplied ownerLevel is dropped.
    const result = await updateProjectAction(formData);
    expect((result as { ownerLevel: string }).ownerLevel).toBe("user");
  });
});

describe("deleteProjectAction is archive-only", () => {
  // Hard project deletion was removed: the project lifecycle is archive-only.
  // The action stays exported so stale client imports resolve, but throws on
  // every call regardless of the caller's relationship to the project.
  it("throws when caller is co-owner", async () => {
    const formData = new FormData();
    formData.set("projectId", userOwnedProject.id);

    const { requireAuthSession } = await import("@/lib/auth-session");
    (requireAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: COOWNER },
      session: { activeOrganizationId: ORG_A },
    });

    await expect(deleteProjectAction(formData)).rejects.toThrow(
      /project deletion removed/,
    );
  });

  it("throws for stranger", async () => {
    const formData = new FormData();
    formData.set("projectId", userOwnedProject.id);

    const { requireAuthSession } = await import("@/lib/auth-session");
    (requireAuthSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: STRANGER },
      session: { activeOrganizationId: ORG_A },
    });

    await expect(deleteProjectAction(formData)).rejects.toThrow(
      /project deletion removed/,
    );
  });
});
