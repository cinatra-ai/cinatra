/**
 * Scope ratchet (ownership-level promotion) is irreversible and requires
 * the actor to hold the role required at the target level.
 */
import { describe, it, expect } from "vitest";

import { assertScopeRatchet } from "@/app/projects/scope-ratchet";
import { AuthzError } from "@/lib/authz/errors";

const TEAM_A = "team-A";
const ORG_A = "org-A";

const teamAdmin = {
  userId: "u-team-admin",
  orgId: ORG_A,
  roles: ["member"],
  teamRoles: { [TEAM_A]: "admin" },
};
const teamMember = {
  userId: "u-team-member",
  orgId: ORG_A,
  roles: ["member"],
  teamRoles: { [TEAM_A]: "member" },
};
const orgAdmin = { userId: "u-org-admin", orgId: ORG_A, roles: ["owner"] };
const orgMember = { userId: "u-org-member", orgId: ORG_A, roles: ["member"] };

describe("scope ratchet guard", () => {
  it("DENY user→team promotion when actor is not team admin at target", async () => {
    await expect(
      assertScopeRatchet({
        from: { ownerLevel: "user", ownerId: "u-team-member" },
        to: { ownerLevel: "team", ownerId: TEAM_A },
        actor: teamMember,
      }),
    ).rejects.toBeInstanceOf(AuthzError);
  });

  it("ALLOW user→team promotion when actor IS team admin at target team", async () => {
    await expect(
      assertScopeRatchet({
        from: { ownerLevel: "user", ownerId: "u-team-admin" },
        to: { ownerLevel: "team", ownerId: TEAM_A },
        actor: teamAdmin,
      }),
    ).resolves.toBeUndefined();
  });

  it("DENY user→organization promotion when actor not org admin", async () => {
    await expect(
      assertScopeRatchet({
        from: { ownerLevel: "user", ownerId: "u-org-member" },
        to: { ownerLevel: "organization", ownerId: ORG_A },
        actor: orgMember,
      }),
    ).rejects.toBeInstanceOf(AuthzError);
  });

  it("ALLOW user→organization promotion when actor is org admin", async () => {
    await expect(
      assertScopeRatchet({
        from: { ownerLevel: "user", ownerId: "u-org-admin" },
        to: { ownerLevel: "organization", ownerId: ORG_A },
        actor: orgAdmin,
      }),
    ).resolves.toBeUndefined();
  });

  it("DENY any downgrade because scope ratchets are irreversible", async () => {
    await expect(
      assertScopeRatchet({
        from: { ownerLevel: "organization", ownerId: ORG_A },
        to: { ownerLevel: "team", ownerId: TEAM_A },
        actor: orgAdmin,
      }),
    ).rejects.toBeInstanceOf(AuthzError);

    await expect(
      assertScopeRatchet({
        from: { ownerLevel: "team", ownerId: TEAM_A },
        to: { ownerLevel: "user", ownerId: "u-team-admin" },
        actor: teamAdmin,
      }),
    ).rejects.toBeInstanceOf(AuthzError);
  });
});
