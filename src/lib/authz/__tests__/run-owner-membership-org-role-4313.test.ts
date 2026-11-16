/**
 * cinatra#4313: `resolveRunOwnerMembershipOrgRole` answers the run owner's
 * org role only from a real membership row of the run's org. No human owner,
 * no row (a departed user) and a lookup error answer `undefined`, never the
 * `member` floor of `buildActorContextFromRun`, and it never throws.
 *
 *   pnpm exec vitest run src/lib/authz/__tests__/run-owner-membership-org-role-4313.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ resolveOrgRoleForUser: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/better-auth-db", () => ({
  readOrgsWithTeamsForUser: vi.fn(async () => []),
  readProjectGrantsForUser: vi.fn(async () => []),
  readUserIsPlatformAdmin: vi.fn(async () => false),
}));
vi.mock("@/lib/auth-session", () => ({ resolveOrgRoleForUser: h.resolveOrgRoleForUser }));

import { resolveRunOwnerMembershipOrgRole } from "@/lib/authz/build-actor-context-from-run";

beforeEach(() => {
  h.resolveOrgRoleForUser.mockReset();
});

describe("cinatra#4313: the run owner's org role from a real membership row only", () => {
  it("answers the role of the run org's membership row", async () => {
    h.resolveOrgRoleForUser.mockResolvedValue("org_owner");
    await expect(
      resolveRunOwnerMembershipOrgRole({ orgId: "org-1", runBy: "user-1" }),
    ).resolves.toBe("org_owner");
    expect(h.resolveOrgRoleForUser).toHaveBeenCalledWith("org-1", "user-1");
  });

  it("answers undefined for a departed owner (no membership row)", async () => {
    h.resolveOrgRoleForUser.mockResolvedValue(undefined);
    await expect(
      resolveRunOwnerMembershipOrgRole({ orgId: "org-1", runBy: "user-1" }),
    ).resolves.toBeUndefined();
  });

  it("answers undefined on a lookup error and never throws", async () => {
    h.resolveOrgRoleForUser.mockRejectedValue(new Error("db down"));
    await expect(
      resolveRunOwnerMembershipOrgRole({ orgId: "org-1", runBy: "user-1" }),
    ).resolves.toBeUndefined();
  });

  it("answers undefined without a read for a run with no human owner", async () => {
    await expect(
      resolveRunOwnerMembershipOrgRole({ orgId: "org-1", runBy: null }),
    ).resolves.toBeUndefined();
    expect(h.resolveOrgRoleForUser).not.toHaveBeenCalled();
  });
});
