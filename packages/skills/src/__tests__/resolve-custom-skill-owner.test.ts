/**
 * Unit tests for the pure resolver `resolveCustomSkillOwner`,
 * exported from @cinatra-ai/skills/skills-store.
 *
 * Workspace ownership is intentionally ignored by this resolver: the write
 * path never emits workspace-owned custom skills, and the reader emits no
 * workspace clause. Current writes target user, team, project, and organization
 * owners.
 */
import { describe, it, expect } from "vitest";

// Resolver export under test.
import { resolveCustomSkillOwner } from "../skills-store";

type Actor = {
  principalId: string;
  principalType?: "HumanUser";
  organizationId?: string;
  teamIds?: string[];
};

type AgentLike = {
  ownerTeamId?: string;
  ownerOrganizationId?: string;
  ownerWorkspaceId?: string;
};

type RunLike = { projectId?: string } | undefined;

describe("resolveCustomSkillOwner", () => {
  it("user-owned: no team/project/org -> {ownerType:'user', ownerId: principalId}", () => {
    const actor: Actor = { principalId: "u1", principalType: "HumanUser" };
    const agent: AgentLike = {};
    const run: RunLike = undefined;
    expect(resolveCustomSkillOwner({ actor, agent, run })).toEqual({
      ownerType: "user",
      ownerId: "u1",
    });
  });

  it("team-owned agent -> {ownerType:'team', ownerId: agent.ownerTeamId}", () => {
    const actor: Actor = { principalId: "u1" };
    const agent: AgentLike = { ownerTeamId: "t1" };
    expect(resolveCustomSkillOwner({ actor, agent, run: undefined })).toEqual({
      ownerType: "team",
      ownerId: "t1",
    });
  });

  it("project-scoped run wins over team", () => {
    const actor: Actor = { principalId: "u1" };
    const agent: AgentLike = { ownerTeamId: "t1" };
    const run: RunLike = { projectId: "p1" };
    expect(resolveCustomSkillOwner({ actor, agent, run })).toEqual({
      ownerType: "project",
      ownerId: "p1",
    });
  });

  it("org-owned agent (no project, no team) -> {ownerType:'organization', ownerId}", () => {
    const actor: Actor = { principalId: "u1" };
    const agent: AgentLike = { ownerOrganizationId: "org1" };
    expect(resolveCustomSkillOwner({ actor, agent, run: undefined })).toEqual({
      ownerType: "organization",
      ownerId: "org1",
    });
  });

  it("workspace guard: agent has only ownerWorkspaceId -> falls back to user", () => {
    // Workspace ownership is ignored by this resolver: the write path never
    // emits it, and the reader emits no workspace clause. The enum value exists
    // for future use.
    const actor: Actor = { principalId: "u1" };
    const agent: AgentLike = { ownerWorkspaceId: "ws1" };
    expect(resolveCustomSkillOwner({ actor, agent, run: undefined })).toEqual({
      ownerType: "user",
      ownerId: "u1",
    });
  });
});
