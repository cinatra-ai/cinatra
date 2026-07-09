// W3 (#1052) — OBO scope-ceiling adoption in requireResourceAccess (skills).
// The containment check runs BEFORE the platform_admin bypass AND before the
// owner short-circuit, so a delegated agent run stays confined to the agent's
// anchored scope even when the invoker is a platform admin or the skill's owner.

import { describe, it, expect } from "vitest";
import type { ActorContext } from "@/lib/authz";
import { requireResourceAccess } from "../auth-policy";
import type { SkillResourceRef } from "../auth-policy";
import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";

function actor(over: Partial<ActorContext> & { oboCeiling?: OboCeilingChain }): ActorContext {
  return {
    principalType: "ServiceAccount",
    principalId: "invoker",
    organizationId: "org-1",
    authSource: "mcp",
    policyVersion: "v1",
    platformRole: "member",
    ...over,
  } as unknown as ActorContext;
}

const skill = (over: Partial<SkillResourceRef>): SkillResourceRef => ({
  resourceType: "skill",
  resourceId: "s1",
  ...over,
});

const USER_ANCHOR: OboCeilingChain = [
  { tier: "user", id: "owner-u" },
  { tier: "organization", id: "org-1" },
];
const TEAM_ANCHOR: OboCeilingChain = [
  { tier: "team", id: "team-a" },
  { tier: "organization", id: "org-1" },
];
const ORG_ANCHOR: OboCeilingChain = [{ tier: "organization", id: "org-1" }];

describe("requireResourceAccess — OBO ceiling containment", () => {
  it("allows a personal skill when the invoker IS the anchored owner (ceiling ∩ invoker authority both admit)", () => {
    // effective access = invoker authority ∩ agent anchor: the personal-owner
    // gate needs principalId === ownerId AND the anchor must contain that user.
    expect(() =>
      requireResourceAccess(
        actor({ principalId: "owner-u", oboCeiling: USER_ANCHOR }),
        skill({ level: "personal", ownerId: "owner-u" }),
      ),
    ).not.toThrow();
  });

  it("denies a personal skill owned by a DIFFERENT user (outside the anchor)", () => {
    expect(() =>
      requireResourceAccess(
        actor({ oboCeiling: USER_ANCHOR }),
        skill({ level: "personal", ownerId: "someone-else" }),
      ),
    ).toThrow(expect.objectContaining({ statusCode: 403, reason: "forbidden" }));
  });

  it("denies even when the invoker is a PLATFORM ADMIN (ceiling before admin bypass)", () => {
    expect(() =>
      requireResourceAccess(
        actor({ platformRole: "platform_admin", oboCeiling: USER_ANCHOR }),
        skill({ level: "personal", ownerId: "someone-else" }),
      ),
    ).toThrow(expect.objectContaining({ statusCode: 403, reason: "forbidden" }));
  });

  it("denies even when the invoker IS the skill owner but the anchor is a different tier (ceiling before owner short-circuit)", () => {
    // principalId === skill.ownerId would normally allow via the owner
    // short-circuit; a team anchor must still deny (the row is user-owned).
    expect(() =>
      requireResourceAccess(
        actor({ principalId: "owner-u", oboCeiling: TEAM_ANCHOR }),
        skill({ level: "personal", ownerId: "owner-u" }),
      ),
    ).toThrow(expect.objectContaining({ statusCode: 403, reason: "forbidden" }));
  });

  it("allows a team skill when the invoker is a member AND the anchor is that team", () => {
    expect(() =>
      requireResourceAccess(
        actor({ teamIds: ["team-a"], oboCeiling: TEAM_ANCHOR }),
        skill({ level: "team", ownerId: "team-a" }),
      ),
    ).not.toThrow();
  });

  it("denies a team skill the invoker CAN reach but that is outside the anchor (ceiling isolates the denial)", () => {
    // Invoker is a member of team-z (their own authority admits), but the agent
    // is anchored to team-a — the ceiling denies before the team-membership gate.
    expect(() =>
      requireResourceAccess(
        actor({ teamIds: ["team-z"], oboCeiling: TEAM_ANCHOR }),
        skill({ level: "team", ownerId: "team-z" }),
      ),
    ).toThrow(expect.objectContaining({ statusCode: 403, reason: "forbidden" }));
  });

  it("org anchor admits in-org org/team skills but denies a cross-org org skill", () => {
    // org-level skill in the run org.
    expect(() =>
      requireResourceAccess(
        actor({ oboCeiling: ORG_ANCHOR }),
        skill({ level: "organization", organizationId: "org-1" }),
      ),
    ).not.toThrow();
    // org-level skill owned by a DIFFERENT org fails the ceiling's org floor.
    expect(() =>
      requireResourceAccess(
        actor({ oboCeiling: ORG_ANCHOR }),
        skill({ level: "organization", organizationId: "org-2" }),
      ),
    ).toThrow(expect.objectContaining({ statusCode: 403, reason: "forbidden" }));
  });

  it("denies a SYSTEM skill for any OBO run — even a platform-admin invoker", () => {
    // System skills are platform-global (no tenant/owner) ⇒ outside every anchor.
    expect(() =>
      requireResourceAccess(
        actor({ platformRole: "platform_admin", oboCeiling: ORG_ANCHOR }),
        skill({ level: "system" }),
      ),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it("is a no-op for a non-OBO actor (no oboCeiling): platform_admin still allowed on system", () => {
    expect(() =>
      requireResourceAccess(
        actor({ platformRole: "platform_admin", oboCeiling: undefined }),
        skill({ level: "system" }),
      ),
    ).not.toThrow();
  });
});
