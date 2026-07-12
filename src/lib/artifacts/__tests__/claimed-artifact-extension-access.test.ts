import { beforeEach, describe, expect, it, vi } from "vitest";

// Claim-scoped actor access gate (cinatra#1425). Unlike the disk-artifact
// path, a CLAIM is a positive DB assertion of governance — the gate FAILS
// CLOSED when no live install row governs the claim's exact scope, and it
// selects the CLAIM's install (installId first, then the scope-governing
// row), never an arbitrary live row of the same package.

vi.mock("server-only", () => ({}));

const readInstalledExtensionsByPackageName = vi.fn();
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...a: unknown[]) => readInstalledExtensionsByPackageName(...a),
}));

const canExtensionAccess = vi.fn();
vi.mock("@cinatra-ai/extensions/enforce-extension-access", () => ({
  canExtensionAccess: (...a: unknown[]) => canExtensionAccess(...a),
}));

vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: vi.fn(async () => null),
}));

import type { ActorContext } from "@/lib/authz/actor-context";
import { canActorAccessClaimedArtifactExtension } from "@/lib/artifacts/artifact-extension-access";

const actor = { principalId: "u1", principalType: "HumanUser", organizationId: "org-1" } as unknown as ActorContext;

function row(partial: Record<string, unknown>) {
  return {
    id: "inst1",
    packageName: "@vendor/pkg-artifact",
    kind: "artifact",
    status: "active",
    ownerLevel: "organization",
    ownerId: "org-1",
    organizationId: "org-1",
    ...partial,
  };
}

beforeEach(() => {
  readInstalledExtensionsByPackageName.mockReset();
  canExtensionAccess.mockReset().mockResolvedValue({ allowed: true });
});

describe("canActorAccessClaimedArtifactExtension", () => {
  it("FAILS CLOSED when the package has NO install rows (a claim is never 'ungoverned')", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([]);
    await expect(
      canActorAccessClaimedArtifactExtension(
        { extensionPackage: "@vendor/pkg-artifact", installId: "inst1", scope: "org:org-1" },
        actor,
        "read",
      ),
    ).resolves.toBe(false);
    expect(canExtensionAccess).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when only a DIFFERENT org's live row exists (no cross-scope bleed)", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([
      row({ id: "other", organizationId: "org-2", ownerId: "org-2" }),
    ]);
    await expect(
      canActorAccessClaimedArtifactExtension(
        { extensionPackage: "@vendor/pkg-artifact", installId: null, scope: "org:org-1" },
        actor,
        "read",
      ),
    ).resolves.toBe(false);
  });

  it("selects the claim's BOUND install row (installId match) for the access decision", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([
      row({ id: "decoy", organizationId: null, ownerLevel: "platform", ownerId: "__platform__" }),
      row({ id: "inst1" }),
    ]);
    await expect(
      canActorAccessClaimedArtifactExtension(
        { extensionPackage: "@vendor/pkg-artifact", installId: "inst1", scope: "org:org-1" },
        actor,
        "read",
      ),
    ).resolves.toBe(true);
    expect(canExtensionAccess).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "inst1" }),
      expect.anything(),
      "read",
    );
  });

  it("a platform claim resolves against an ambient (organizationId null) live row", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([
      row({ id: "amb", organizationId: null, ownerLevel: "platform", ownerId: "__platform__" }),
    ]);
    await expect(
      canActorAccessClaimedArtifactExtension(
        { extensionPackage: "@vendor/pkg-artifact", installId: null, scope: "platform" },
        actor,
        "read",
      ),
    ).resolves.toBe(true);
    expect(canExtensionAccess).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "amb" }),
      expect.anything(),
      "read",
    );
  });

  it("archived-only rows deny; a store read error FAILS CLOSED", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([row({ status: "archived" })]);
    await expect(
      canActorAccessClaimedArtifactExtension(
        { extensionPackage: "@vendor/pkg-artifact", installId: "inst1", scope: "org:org-1" },
        actor,
        "read",
      ),
    ).resolves.toBe(false);

    readInstalledExtensionsByPackageName.mockRejectedValue(new Error("store down"));
    await expect(
      canActorAccessClaimedArtifactExtension(
        { extensionPackage: "@vendor/pkg-artifact", installId: "inst1", scope: "org:org-1" },
        actor,
        "read",
      ),
    ).resolves.toBe(false);
  });
});
