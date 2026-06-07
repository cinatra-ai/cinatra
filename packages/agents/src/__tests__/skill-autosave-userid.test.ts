/**
 * Tests for LOCAL_USER_ID replacement in skill autosave.
 *
 * skill-autosave.ts must call listCustomSkillsForCurrentUserAndAgent +
 * createOrUpdateCustomSkillForAgent with the run owner userId. The
 * personal-skills implementation falls back to LOCAL_USER_ID internally when
 * no userId is supplied, so omitting it would upsert every user's personal
 * skill onto the same `local-user` row instead of preserving per-user
 * ownership.
 *
 * Contract:
 *   - listCustomSkillsForCurrentUserAndAgent(agentId, userId?)
 *   - createOrUpdateCustomSkillForAgent({ ..., userId? })
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted so vi.mock factories can reference them.
// ---------------------------------------------------------------------------

const skillsMock = vi.hoisted(() => ({
  createOrUpdateCustomSkillForAgent: vi.fn(
    async (..._args: unknown[]) => ({
      id: "sk-out-1",
      name: "Test Skill",
      description: "desc",
      content: "content",
      basedOnSkillIds: ["b1"],
    }),
  ),
  listCustomSkillsForCurrentUserAndAgent: vi.fn(
    async (..._args: unknown[]) => [
      { id: "sk-existing", name: "Existing" },
    ],
  ),
  buildDefaultPersonalSkillName: vi.fn(
    (..._args: unknown[]) => "Default Skill Name",
  ),
}));
vi.mock("@cinatra-ai/skills", () => skillsMock);

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(),
  readAgentTemplateByPackageName: vi.fn(async () => ({ name: "Template" })),
  readHitlPromptsForRun: vi.fn(async () => [
    {
      id: "p1",
      message: "Some prompt content",
      stepKey: "step1",
      capturedAt: new Date(),
    },
  ]),
  readNonExcludedAgentIdsForRun: vi.fn(async () => ["agent-pkg-1"]),
}));
vi.mock("../store", () => storeMock);

vi.mock("@/lib/skill-autosave", () => ({
  readSkillAutosaveConfig: vi.fn(() => ({ enabled: true })),
}));

// skill-autosave resolves the runBy userId into a full ActorContext via
// resolveUserContextForUserId and threads it into createOrUpdateCustomSkillForAgent.
// The test mocks the lookup so we don't need a real Better Auth DB.
vi.mock("@/lib/auth-session", () => ({
  resolveUserContextForUserId: vi.fn(async (userId: string) => ({
    actorContext: {
      principalType: "User",
      principalId: userId,
      authSource: "ui",
      organizationId: "org-1",
      teamIds: [],
      projectIds: [],
      platformRole: "member",
      policyVersion: "v1",
    },
    platformRole: "member" as const,
    sessionOrgId: "org-1",
  })),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import { runSkillAutosaveOnRunCompletion } from "../skill-autosave";

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("runSkillAutosaveOnRunCompletion userId threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    skillsMock.createOrUpdateCustomSkillForAgent.mockResolvedValue({
      id: "sk-out-1",
      name: "Test Skill",
      description: "desc",
      content: "content",
      basedOnSkillIds: ["b1"],
    });
    skillsMock.listCustomSkillsForCurrentUserAndAgent.mockResolvedValue([
      { id: "sk-existing", name: "Existing" },
    ]);
    storeMock.readNonExcludedAgentIdsForRun.mockResolvedValue(["agent-pkg-1"]);
    storeMock.readHitlPromptsForRun.mockResolvedValue([
      {
        id: "p1",
        message: "Some prompt content",
        stepKey: "step1",
        capturedAt: new Date(),
      },
    ]);
    storeMock.readAgentTemplateByPackageName.mockResolvedValue({
      name: "Template",
    });
  });

  it("RED: passes runRecord.runBy as userId/ownerUserId (not LOCAL_USER_ID)", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-with-runby",
      title: "My Run",
      runBy: "real-user-42",
    });

    await runSkillAutosaveOnRunCompletion("run-with-runby");

    expect(skillsMock.createOrUpdateCustomSkillForAgent).toHaveBeenCalled();
    const arg = skillsMock.createOrUpdateCustomSkillForAgent.mock.calls[0]?.[0] as
      | {
          userId?: string;
          ownerUserId?: string;
          agentId?: string;
        }
      | undefined;
    const passedUserId = arg?.userId ?? arg?.ownerUserId;
    expect(passedUserId).toBe("real-user-42");
    // Defensive: must NOT be the legacy single-tenant constant.
    expect(passedUserId).not.toBe("local-user");
  });

  it("RED: passes runBy to listCustomSkillsForCurrentUserAndAgent as second arg", async () => {
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-with-runby",
      title: "My Run",
      runBy: "real-user-42",
    });

    await runSkillAutosaveOnRunCompletion("run-with-runby");

    expect(skillsMock.listCustomSkillsForCurrentUserAndAgent).toHaveBeenCalled();
    const callArgs = skillsMock.listCustomSkillsForCurrentUserAndAgent.mock.calls[0];
    // Contract: second arg is the user id.
    expect(callArgs?.[1]).toBe("real-user-42");
  });

  it("RED: skips personal-skill upsert when runRecord.runBy is null (multi-tenant safety)", async () => {
    // When runBy is null, we cannot attribute the skill, so skip rather than
    // write under LOCAL_USER_ID.
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-without-runby",
      title: "Anon Run",
      runBy: null,
    });

    await runSkillAutosaveOnRunCompletion("run-without-runby");

    expect(skillsMock.createOrUpdateCustomSkillForAgent).not.toHaveBeenCalled();
  });
});
