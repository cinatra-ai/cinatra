/**
 * Regression coverage for createSkillExtensionHandler.
 *
 * createSkillExtensionHandler must dispatch install/update/uninstall
 * to the correct underlying skill functions and filter the agent_skill_matches
 * blob on uninstall.
 *
 * The handler must wire skill lifecycle operations through catalog install, matching, and match cleanup behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — registered BEFORE module-under-test imports
// ---------------------------------------------------------------------------

const { installMock, matchMock, uninstallMock, readMatchesMock, saveMatchesMock } =
  vi.hoisted(() => ({
    installMock: vi.fn().mockResolvedValue(undefined),
    matchMock: vi.fn().mockResolvedValue(undefined),
    uninstallMock: vi.fn().mockResolvedValue(undefined),
    readMatchesMock: vi.fn().mockResolvedValue({
      matches: [
        {
          id: "agent1:github:owner/repo:skill-a",
          agentId: "agent1",
          skillId: "github:owner/repo:skill-a",
          score: 50,
          rationale: "",
        },
        {
          id: "agent1:other:pkg:skill-b",
          agentId: "agent1",
          skillId: "other:pkg:skill-b",
          score: 50,
          rationale: "",
        },
      ],
      matchedAt: "2026-01-01",
    }),
    saveMatchesMock: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("server-only", () => ({}));
vi.mock("../github", () => ({ installSkillPackageFromGitHub: installMock }));
vi.mock("../skills-store", () => ({ uninstallSkillPackage: uninstallMock }));
vi.mock("@/lib/agents-store", () => ({
  matchAgentsToSkills: matchMock,
  readAgentSkillMatches: readMatchesMock,
  saveAgentSkillMatches: saveMatchesMock,
}));

import { createSkillExtensionHandler } from "../extension-handler";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const makeRef = (packageName = "owner/repo") => ({
  registryUrl: "https://registry.example.com",
  packageName,
});
const makeActor = () => ({
  actorType: "system" as const,
  userId: "u1",
  source: "worker" as const,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSkillExtensionHandler", () => {
  let handler: ReturnType<typeof createSkillExtensionHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = createSkillExtensionHandler();
  });

  it('typeId is "skill"', () => {
    expect(handler.typeId).toBe("skill");
  });

  it("install() calls installSkillPackageFromGitHub with repoRef and then matchAgentsToSkills", async () => {
    await handler.install(makeRef(), makeActor());
    expect(installMock).toHaveBeenCalledWith("owner/repo");
    expect(matchMock).toHaveBeenCalledTimes(1);
    expect(installMock.mock.invocationCallOrder[0]).toBeLessThan(
      matchMock.mock.invocationCallOrder[0]
    );
  });

  it("update() calls installSkillPackageFromGitHub (upsert) and then matchAgentsToSkills", async () => {
    await handler.update(makeRef(), makeActor());
    expect(installMock).toHaveBeenCalledWith("owner/repo");
    expect(matchMock).toHaveBeenCalledTimes(1);
    expect(installMock.mock.invocationCallOrder[0]).toBeLessThan(
      matchMock.mock.invocationCallOrder[0]
    );
  });

  it("uninstall() calls uninstallSkillPackage and filters stale match entries from the blob", async () => {
    await handler.uninstall(makeRef(), makeActor());
    expect(uninstallMock).toHaveBeenCalledWith("github:owner/repo");
    expect(readMatchesMock).toHaveBeenCalledTimes(1);
    expect(saveMatchesMock).toHaveBeenCalledWith([
      expect.objectContaining({ skillId: "other:pkg:skill-b" }),
    ]);
    expect(saveMatchesMock).not.toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ skillId: "github:owner/repo:skill-a" }),
      ])
    );
    // uninstall must remove catalog entries before reconciling the matches blob
    expect(uninstallMock.mock.invocationCallOrder[0]).toBeLessThan(
      saveMatchesMock.mock.invocationCallOrder[0]
    );
  });
});
