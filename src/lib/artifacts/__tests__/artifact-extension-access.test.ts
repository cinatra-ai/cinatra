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

import { canAccessArtifactExtension } from "../artifact-extension-access";
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
