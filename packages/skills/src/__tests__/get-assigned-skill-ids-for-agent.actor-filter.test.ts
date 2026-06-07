/**
 * getAssignedSkillIdsForAgent filters custom_skill_assignments rows by
 * ActorContext (principalId, teamIds, organizationId) and unions the result
 * with the existing system globals + agent self-match set.
 *
 * The read path must consume readCustomSkillAssignmentsForAgent so custom
 * assignments respect the caller's actor scope.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — registered BEFORE module-under-test imports
// ---------------------------------------------------------------------------

const {
  readCustomSkillAssignmentsForAgentMock,
  readSystemGlobalSkillIdsForAgentMock,
} = vi.hoisted(() => ({
  readCustomSkillAssignmentsForAgentMock: vi.fn(async () => [
    { skillId: "s1", ownerType: "team", ownerId: "t1" },
    { skillId: "s2", ownerType: "organization", ownerId: "org1" },
    { skillId: "s3", ownerType: "user", ownerId: "u-other" },
  ]),
  readSystemGlobalSkillIdsForAgentMock: vi.fn(async () => [] as string[]),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/database", () => ({
  // Mocked database readers consumed by the agents-store read path.
  readCustomSkillAssignmentsForAgent: readCustomSkillAssignmentsForAgentMock,
  readSystemGlobalSkillIdsForAgent: readSystemGlobalSkillIdsForAgentMock,
}));

// Module under test consumes readCustomSkillAssignmentsForAgent + ActorContext.
import { getAssignedSkillIdsForAgent } from "@/lib/agents-store";

type ActorContext = {
  principalId: string;
  principalType?: "HumanUser";
  organizationId?: string;
  teamIds?: string[];
};

beforeEach(() => {
  readCustomSkillAssignmentsForAgentMock.mockClear();
  readSystemGlobalSkillIdsForAgentMock.mockClear();
});

describe("getAssignedSkillIdsForAgent ActorContext filter", () => {
  it("team member sees team-owned rows but not other-user or different-org rows", async () => {
    const actor: ActorContext = {
      principalId: "u1",
      teamIds: ["t1"],
      organizationId: "orgX",
    };
    // Call through the ActorContext-aware overload shape used by the implementation.
    const ids = await (getAssignedSkillIdsForAgent as unknown as (
      agentId: string,
      actor: ActorContext,
    ) => Promise<string[]>)("a1", actor);
    expect(ids).toContain("s1");
    expect(ids).not.toContain("s2");
    expect(ids).not.toContain("s3");
  });

  it("org member sees org-owned rows", async () => {
    const actor: ActorContext = { principalId: "u1", organizationId: "org1" };
    const ids = await (getAssignedSkillIdsForAgent as unknown as (
      agentId: string,
      actor: ActorContext,
    ) => Promise<string[]>)("a1", actor);
    expect(ids).toContain("s2");
  });

  it("owner sees their own user-row", async () => {
    const actor: ActorContext = { principalId: "u-other" };
    const ids = await (getAssignedSkillIdsForAgent as unknown as (
      agentId: string,
      actor: ActorContext,
    ) => Promise<string[]>)("a1", actor);
    expect(ids).toContain("s3");
  });

  it("undefined teamIds/projectIds coerce to [] without crashing", async () => {
    const actor: ActorContext = { principalId: "u1" }; // no teamIds, no organizationId
    const ids = await (getAssignedSkillIdsForAgent as unknown as (
      agentId: string,
      actor: ActorContext,
    ) => Promise<string[]>)("a1", actor);
    expect(Array.isArray(ids)).toBe(true);
    // No team-row matches and no crash:
    expect(ids).not.toContain("s1");
  });

  it("result is a union with system globals + agent self-match (additive branch)", async () => {
    readSystemGlobalSkillIdsForAgentMock.mockResolvedValueOnce(["sys-1"]);
    const actor: ActorContext = {
      principalId: "u1",
      teamIds: ["t1"],
      organizationId: "org1",
    };
    const ids = await (getAssignedSkillIdsForAgent as unknown as (
      agentId: string,
      actor: ActorContext,
    ) => Promise<string[]>)("a1", actor);
    expect(ids).toContain("sys-1");
    // and the new branch is still additive
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
  });
});
