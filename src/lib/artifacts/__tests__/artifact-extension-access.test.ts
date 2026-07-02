// canAccessArtifactExtension: install-governed visibility with
// lifecycle-status semantics + fail-closed.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { readRowsMock, canAccessMock, resolveOrgRoleMock } = vi.hoisted(() => ({
  readRowsMock: vi.fn(),
  canAccessMock: vi.fn(async (): Promise<{ allowed: boolean }> => ({ allowed: true })),
  resolveOrgRoleMock: vi.fn(async (): Promise<string | undefined> => undefined),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: readRowsMock,
}));
vi.mock("@cinatra-ai/extensions/enforce-extension-access", () => ({
  canExtensionAccess: canAccessMock,
}));
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: resolveOrgRoleMock,
}));

import {
  canAccessArtifactExtension,
  isArtifactExtensionWriteAllowed,
} from "../artifact-extension-access";
import type { ActorContext } from "@/lib/authz/actor-context";

const actor: ActorContext = {
  principalType: "HumanUser",
  principalId: "u1",
  organizationId: "org-1",
  authSource: "mcp",
  policyVersion: "v2",
};

function row(over: Record<string, unknown> = {}) {
  return {
    id: "ie-1",
    kind: "artifact",
    status: "active",
    ownerLevel: "organization",
    ownerId: "org-1",
    organizationId: "org-1",
    ...over,
  };
}

describe("canAccessArtifactExtension", () => {
  beforeEach(() => {
    readRowsMock.mockReset();
    canAccessMock.mockReset().mockResolvedValue({ allowed: true });
    resolveOrgRoleMock.mockReset().mockResolvedValue(undefined);
  });

  it("ungoverned (no install row) → allowed", async () => {
    readRowsMock.mockResolvedValue([]);
    expect(await canAccessArtifactExtension("@x/a-artifact", actor, "list")).toBe(true);
    expect(canAccessMock).not.toHaveBeenCalled();
  });

  it("install row exists but all archived → DENIED", async () => {
    readRowsMock.mockResolvedValue([row({ status: "archived" })]);
    expect(await canAccessArtifactExtension("@x/a-artifact", actor, "read")).toBe(false);
    expect(canAccessMock).not.toHaveBeenCalled();
  });

  it("live row → delegates to canExtensionAccess", async () => {
    readRowsMock.mockResolvedValue([row({ status: "active" })]);
    canAccessMock.mockResolvedValue({ allowed: false });
    expect(await canAccessArtifactExtension("@x/a-artifact", actor, "execute")).toBe(false);
    expect(canAccessMock).toHaveBeenCalledOnce();
  });

  it("locked counts as live", async () => {
    readRowsMock.mockResolvedValue([row({ status: "locked" })]);
    canAccessMock.mockResolvedValue({ allowed: true });
    expect(await canAccessArtifactExtension("@x/a-artifact", actor, "use")).toBe(true);
  });

  it("DB read error → fail closed", async () => {
    readRowsMock.mockRejectedValue(new Error("db down"));
    expect(await canAccessArtifactExtension("@x/a-artifact", actor, "list")).toBe(false);
  });

  it("resolves orgRole for an MCP actor lacking it (owner-aware admin tier)", async () => {
    readRowsMock.mockResolvedValue([row({ status: "active" })]);
    resolveOrgRoleMock.mockResolvedValue("org_admin");
    canAccessMock.mockResolvedValue({ allowed: true });
    await canAccessArtifactExtension("@x/a-artifact", actor, "read");
    expect(resolveOrgRoleMock).toHaveBeenCalledWith("org-1", "u1");
    // the actor passed to canExtensionAccess carries the resolved orgRole
    const passedActor = (canAccessMock.mock.calls[0] as unknown[])[1] as ActorContext;
    expect(passedActor.orgRole).toBe("org_admin");
  });
});

describe("isArtifactExtensionWriteAllowed (CG-4 status-only write gate)", () => {
  beforeEach(() => {
    readRowsMock.mockReset();
    canAccessMock.mockReset();
  });

  it("ungoverned (no install row) → allowed (CG-1 bundled/disk artifact)", async () => {
    readRowsMock.mockResolvedValue([]);
    expect(await isArtifactExtensionWriteAllowed("@x/a-artifact")).toBe(true);
    // status-only: never delegates to the polymorphic actor-access check.
    expect(canAccessMock).not.toHaveBeenCalled();
  });

  it("active row → allowed", async () => {
    readRowsMock.mockResolvedValue([row({ status: "active" })]);
    expect(await isArtifactExtensionWriteAllowed("@x/a-artifact")).toBe(true);
  });

  it("locked row → allowed (platform-required host-trusted)", async () => {
    readRowsMock.mockResolvedValue([row({ status: "locked" })]);
    expect(await isArtifactExtensionWriteAllowed("@x/a-artifact")).toBe(true);
  });

  it("all rows archived → DENIED (the disable→write-refused negative)", async () => {
    readRowsMock.mockResolvedValue([row({ status: "archived" })]);
    expect(await isArtifactExtensionWriteAllowed("@x/a-artifact")).toBe(false);
  });

  it("a mix with one live row → allowed", async () => {
    readRowsMock.mockResolvedValue([
      row({ status: "archived", id: "ie-old" }),
      row({ status: "active", id: "ie-new" }),
    ]);
    expect(await isArtifactExtensionWriteAllowed("@x/a-artifact")).toBe(true);
  });

  it("ignores non-artifact rows of the same package name", async () => {
    readRowsMock.mockResolvedValue([
      row({ kind: "connector", status: "active" }),
    ]);
    // no ARTIFACT row → treated as ungoverned → allowed.
    expect(await isArtifactExtensionWriteAllowed("@x/a-artifact")).toBe(true);
  });

  it("DB read error → fail closed (DENIED)", async () => {
    readRowsMock.mockRejectedValue(new Error("db down"));
    expect(await isArtifactExtensionWriteAllowed("@x/a-artifact")).toBe(false);
  });

  // ORG-SCOPED: the writing org's GOVERNING row decides, never a foreign org's.
  it("org-scoped: package archived in the writing org but active platform-wide → allowed (platform governs)", async () => {
    readRowsMock.mockResolvedValue([
      row({ id: "ie-org", status: "archived", organizationId: "org-1" }),
      row({ id: "ie-plat", status: "active", organizationId: null }),
    ]);
    // The org-owned row is archived, but the ambient/platform install governs.
    expect(await isArtifactExtensionWriteAllowed("@x/a-artifact", "org-1")).toBe(true);
  });

  it("org-scoped: archived for the writing org's GOVERNING scope → DENIED even if another org is active", async () => {
    readRowsMock.mockResolvedValue([
      row({ id: "ie-a", status: "archived", organizationId: "org-1" }),
      row({ id: "ie-b", status: "active", organizationId: "org-2" }),
    ]);
    // org-1's own row is archived; org-2's active row is NOT a governing scope
    // for org-1, and there is no ambient install → DENY (no cross-org bleed).
    expect(await isArtifactExtensionWriteAllowed("@x/a-artifact", "org-1")).toBe(false);
  });

  it("org-scoped: only a foreign-org install exists → DENIED for the writing org", async () => {
    readRowsMock.mockResolvedValue([
      row({ id: "ie-b", status: "active", organizationId: "org-2" }),
    ]);
    // No org-1 row, no ambient row → no governing install for org-1 → DENY.
    expect(await isArtifactExtensionWriteAllowed("@x/a-artifact", "org-1")).toBe(false);
  });

  it("org-scoped: the org's own active row governs → allowed", async () => {
    readRowsMock.mockResolvedValue([
      row({ id: "ie-a", status: "active", organizationId: "org-1" }),
      row({ id: "ie-plat", status: "archived", organizationId: null }),
    ]);
    expect(await isArtifactExtensionWriteAllowed("@x/a-artifact", "org-1")).toBe(true);
  });

  it("org-scoped: no rows at all → ungoverned → allowed (CG-1)", async () => {
    readRowsMock.mockResolvedValue([]);
    expect(await isArtifactExtensionWriteAllowed("@x/a-artifact", "org-1")).toBe(true);
  });
});
