/**
 * Regression tests for server-action userId threading.
 *
 * getAuditDrawerDataAction must call listCustomSkillsForCurrentUserAndAgent
 * and createOrUpdateCustomSkillForAgent with session.user.id. Without the
 * explicit userId, personal-skills.ts falls back to LOCAL_USER_ID, causing
 * users to share the same personal-skill owner.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const SESSION_USER_ID = "session-user-99";

const authSessionMock = vi.hoisted(() => ({
  requireAuthSession: vi.fn(async () => ({
    user: { id: "session-user-99", role: "user" },
    session: { activeOrganizationId: "org-A" },
  })),
  getAuthSession: vi.fn(async () => ({
    user: { id: "session-user-99", role: "user" },
    session: { activeOrganizationId: "org-A" },
  })),
  isPlatformAdmin: vi.fn(() => false),
  // Resolved human ActorContext consistent with the session mock above.
  // Shape mirrors @/lib/authz/actor-context (POLICY_VERSION = "v2").
  requireActorContext: vi.fn(async () => ({
    principalType: "HumanUser" as const,
    principalId: "session-user-99",
    organizationId: "org-A",
    platformRole: "member" as const,
    orgRole: "member" as const,
    projectGrants: [],
    projectIds: [],
    authSource: "ui" as const,
    policyVersion: "v2",
  })),
}));
vi.mock("@/lib/auth-session", () => authSessionMock);

const skillsMock = vi.hoisted(() => ({
  createOrUpdateCustomSkillForAgent: vi.fn(
    async (..._args: unknown[]) => ({
      id: "sk-out",
      name: "n",
      description: "d",
      content: "c",
      basedOnSkillIds: ["b1"],
    }),
  ),
  listCustomSkillsForCurrentUserAndAgent: vi.fn(
    async (..._args: unknown[]) => [{ id: "sk-existing" }],
  ),
  buildDefaultPersonalSkillName: vi.fn(
    (..._args: unknown[]) => "Default",
  ),
  // Used by getSkillsForAgentAction etc.
  parseFrontmatter: vi.fn((..._args: unknown[]) => ({
    attributes: {},
    body: "",
  })),
  upsertSkill: vi.fn(),
}));
vi.mock("@cinatra-ai/skills", () => skillsMock);

const storeMock = vi.hoisted(() => ({
  readAgentRunById: vi.fn(async () => ({
    id: "run-1",
    title: "Run",
    runBy: "session-user-99",
  })),
  readAgentTemplateByPackageName: vi.fn(async () => ({ name: "Tpl" })),
  readHitlPromptsForRun: vi.fn(async () => [
    { id: "p1", message: "msg", stepKey: "s", capturedAt: new Date() },
  ]),
  updateHitlPromptExcluded: vi.fn(async () => undefined),
}));
vi.mock("../store", () => storeMock);

vi.mock("@cinatra-ai/gmail-connector", () => ({
  getStoredGmailSendAsAddresses: vi.fn(async () => []),
  registerGmailConnector: vi.fn(),
}));
vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: vi.fn(async () => []),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import {
  getAuditDrawerDataAction,
} from "../server-actions";

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("getAuditDrawerDataAction server-action userId threading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    skillsMock.listCustomSkillsForCurrentUserAndAgent.mockResolvedValue([
      { id: "sk-existing" },
    ]);
    skillsMock.createOrUpdateCustomSkillForAgent.mockResolvedValue({
      id: "sk-out",
      name: "n",
      description: "d",
      content: "c",
      basedOnSkillIds: ["b1"],
    });
    storeMock.readAgentRunById.mockResolvedValue({
      id: "run-1",
      title: "Run",
      runBy: SESSION_USER_ID,
    });
    storeMock.readHitlPromptsForRun.mockResolvedValue([
      { id: "p1", message: "msg", stepKey: "s", capturedAt: new Date() },
    ]);
    storeMock.readAgentTemplateByPackageName.mockResolvedValue({ name: "Tpl" });
  });

  it("passes session.user.id to listCustomSkillsForCurrentUserAndAgent as second arg", async () => {
    await getAuditDrawerDataAction("run-1", "agent-pkg-1");

    expect(skillsMock.listCustomSkillsForCurrentUserAndAgent).toHaveBeenCalled();
    const callArgs =
      skillsMock.listCustomSkillsForCurrentUserAndAgent.mock.calls[0];
    expect(callArgs?.[0]).toBe("agent-pkg-1");
    // Contract: second arg is session.user.id. Omitting it lets the skills
    // helper fall back to LOCAL_USER_ID.
    expect(callArgs?.[1]).toBe(SESSION_USER_ID);
  });

  it("passes session.user.id as userId to createOrUpdateCustomSkillForAgent", async () => {
    await getAuditDrawerDataAction("run-1", "agent-pkg-1");

    expect(skillsMock.createOrUpdateCustomSkillForAgent).toHaveBeenCalled();
    const arg = skillsMock.createOrUpdateCustomSkillForAgent.mock.calls[0]?.[0] as
      | { userId?: string; ownerUserId?: string }
      | undefined;
    const passedUserId = arg?.userId ?? arg?.ownerUserId;
    expect(passedUserId).toBe(SESSION_USER_ID);
    expect(passedUserId).not.toBe("local-user");
  });
});
