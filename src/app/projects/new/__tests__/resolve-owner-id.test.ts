import { describe, it, expect } from "vitest";
import { resolveOwnerId } from "@/app/projects/new/resolve-owner-id";

describe("resolveOwnerId owner_id resolution", () => {
  it("returns the session user id for ownerLevel 'user'", () => {
    expect(resolveOwnerId({ sessionUserId: "u1", ownerLevel: "user" })).toEqual({ ownerId: "u1" });
  });

  it("returns the supplied teamId for ownerLevel 'team'", () => {
    expect(resolveOwnerId({ sessionUserId: "u1", ownerLevel: "team", teamId: "t1" })).toEqual({ ownerId: "t1" });
  });

  it("returns error for ownerLevel 'team' without teamId", () => {
    expect(resolveOwnerId({ sessionUserId: "u1", ownerLevel: "team" })).toEqual({ error: "team-required" });
    expect(resolveOwnerId({ sessionUserId: "u1", ownerLevel: "team", teamId: "" })).toEqual({ error: "team-required" });
    expect(resolveOwnerId({ sessionUserId: "u1", ownerLevel: "team", teamId: "   " })).toEqual({ error: "team-required" });
  });

  it("returns the supplied organizationId for ownerLevel 'organization'", () => {
    expect(resolveOwnerId({ sessionUserId: "u1", ownerLevel: "organization", organizationId: "o1" })).toEqual({ ownerId: "o1" });
  });

  it("returns error for ownerLevel 'organization' without organizationId", () => {
    expect(resolveOwnerId({ sessionUserId: "u1", ownerLevel: "organization" })).toEqual({ error: "org-required" });
    expect(resolveOwnerId({ sessionUserId: "u1", ownerLevel: "organization", organizationId: "" })).toEqual({ error: "org-required" });
  });

  it("returns error for invalid ownerLevel", () => {
    expect(resolveOwnerId({ sessionUserId: "u1", ownerLevel: "workspace" as never })).toEqual({ error: "invalid-owner-level" });
    expect(resolveOwnerId({ sessionUserId: "u1", ownerLevel: "" as never })).toEqual({ error: "invalid-owner-level" });
  });

  it("ignores client-supplied ownerId for mass-assignment defense", () => {
    // @ts-expect-error — `ownerId` is not part of the input type; we ARE testing
    // that the function ignores the field even if a malicious client passed it.
    const result = resolveOwnerId({ sessionUserId: "u1", ownerLevel: "user", ownerId: "attacker-id" });
    expect(result).toEqual({ ownerId: "u1" });
  });
});
