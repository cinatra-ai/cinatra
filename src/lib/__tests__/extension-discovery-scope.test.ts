import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/better-auth-db", () => ({ readTeamsForUser: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({
  isPlatformAdmin: vi.fn(),
  resolveOrgRoleForSession: vi.fn(),
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  actorFromSession: vi.fn(),
}));

import { resolveExtensionDiscoveryContext } from "@/lib/extension-discovery-scope";
import { readTeamsForUser } from "@/lib/better-auth-db";
import { isPlatformAdmin, resolveOrgRoleForSession } from "@/lib/auth-session";
import { actorFromSession } from "@/lib/authz/build-actor-context";

function session(over: Record<string, unknown> = {}) {
  return {
    user: { id: "u1", role: null },
    session: { activeOrganizationId: "org-1" },
    ...over,
  } as never;
}

describe("resolveExtensionDiscoveryContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(actorFromSession).mockReturnValue({
      actorType: "human",
      source: "ui",
      userId: "u1",
      organizationId: "org-1",
    } as never);
    // Default: a plain member (no admin standing). Individual tests override.
    vi.mocked(resolveOrgRoleForSession).mockResolvedValue(undefined);
  });

  it("builds the scope from session + vendorScope + team membership", async () => {
    vi.mocked(readTeamsForUser).mockResolvedValue([{ id: "t1" }, { id: "t2" }] as never);
    vi.mocked(isPlatformAdmin).mockReturnValue(false);

    const { scope, actor } = await resolveExtensionDiscoveryContext(session(), "@acme");

    expect(scope).toEqual({
      userId: "u1",
      organizationId: "org-1",
      teamIds: ["t1", "t2"],
      vendorScope: "@acme",
      platformRole: "member",
    });
    expect(actor).toMatchObject({ actorType: "human", userId: "u1" });
    expect(readTeamsForUser).toHaveBeenCalledWith("u1", "org-1");
  });

  it("platform admins resolve platformRole=platform_admin", async () => {
    vi.mocked(readTeamsForUser).mockResolvedValue([] as never);
    vi.mocked(isPlatformAdmin).mockReturnValue(true);

    const { scope } = await resolveExtensionDiscoveryContext(session(), null);
    expect(scope.platformRole).toBe("platform_admin");
  });

  it("fails CLOSED with no active org: no team lookup, null org, empty teamIds", async () => {
    vi.mocked(isPlatformAdmin).mockReturnValue(false);

    const { scope } = await resolveExtensionDiscoveryContext(
      session({ session: {} }),
      null,
    );

    expect(scope.organizationId).toBeNull();
    expect(scope.teamIds).toEqual([]);
    expect(scope.vendorScope).toBeNull();
    // No org → no membership query (avoids an unfiltered/incorrect team read).
    expect(readTeamsForUser).not.toHaveBeenCalled();
  });

  it("normalizes an undefined vendorScope to null", async () => {
    vi.mocked(readTeamsForUser).mockResolvedValue([] as never);
    vi.mocked(isPlatformAdmin).mockReturnValue(false);

    const { scope } = await resolveExtensionDiscoveryContext(
      session(),
      undefined as unknown as string | null,
    );
    expect(scope.vendorScope).toBeNull();
  });

  it("threads the active-org role so an org_admin carries admin standing", async () => {
    vi.mocked(readTeamsForUser).mockResolvedValue([] as never);
    vi.mocked(isPlatformAdmin).mockReturnValue(false);
    vi.mocked(resolveOrgRoleForSession).mockResolvedValue("org_admin");

    const { scope } = await resolveExtensionDiscoveryContext(session(), null);
    expect(scope.orgRole).toBe("org_admin");
    expect(scope.platformRole).toBe("member");
    expect(resolveOrgRoleForSession).toHaveBeenCalledTimes(1);
  });

  it("omits orgRole for a plain member (no admin standing key)", async () => {
    vi.mocked(readTeamsForUser).mockResolvedValue([] as never);
    vi.mocked(isPlatformAdmin).mockReturnValue(false);
    // default mock resolves undefined

    const { scope } = await resolveExtensionDiscoveryContext(session(), null);
    expect(scope.orgRole).toBeUndefined();
    expect("orgRole" in scope).toBe(false);
  });
});
