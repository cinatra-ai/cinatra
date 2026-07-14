/**
 * Regression coverage for createSkillExtensionHandler.
 *
 * createSkillExtensionHandler must dispatch install/update/uninstall to the
 * correct underlying skill functions: install/update rebuild the catalog then
 * re-run matching; uninstall removes the package then rebuilds the catalog
 * (matches for the removed package drop out of the canonical projection on the
 * next read — no separate match-store cleanup pass).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — registered BEFORE module-under-test imports
// ---------------------------------------------------------------------------

const { installMock, matchMock, uninstallMock, rebuildMock } =
  vi.hoisted(() => ({
    installMock: vi.fn().mockResolvedValue(undefined),
    matchMock: vi.fn().mockResolvedValue(undefined),
    uninstallMock: vi.fn().mockResolvedValue(undefined),
    rebuildMock: vi.fn().mockResolvedValue({ skillPackages: [], skills: [] }),
  }));

vi.mock("server-only", () => ({}));
vi.mock("../github", () => ({ installSkillPackageFromGitHub: installMock }));
vi.mock("../skills-store", () => ({ uninstallSkillPackage: uninstallMock }));
// Explicit catalog rebuild at lifecycle points (cinatra#1364). Mocked so the
// handler tests stay focused on dispatch; the real rebuild's lock/fence
// behavior is pinned by __tests__/catalog-rebuild-lock.test.ts.
vi.mock("../skill-packages", () => ({ rebuildSkillsCatalog: rebuildMock }));
vi.mock("@/lib/agents-store", () => ({
  matchAgentsToSkills: matchMock,
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
    // Explicit catalog rebuild (cinatra#1364): after the install, BEFORE
    // matching, so matching evaluates the merged catalog rows.
    expect(rebuildMock).toHaveBeenCalledTimes(1);
    expect(rebuildMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      installMock.mock.invocationCallOrder[0]
    );
    expect(rebuildMock.mock.invocationCallOrder[0]).toBeLessThan(
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

  it("uninstall() removes the package then rebuilds the catalog (no separate match-store cleanup)", async () => {
    await handler.uninstall(makeRef(), makeActor());
    expect(uninstallMock).toHaveBeenCalledWith("github:owner/repo");
    // Explicit catalog rebuild (cinatra#1364) after the uninstall's removal —
    // the rebuilt catalog is what drops the removed package's matches from the
    // canonical projection served by readAgentSkillMatches().
    expect(rebuildMock).toHaveBeenCalledTimes(1);
    expect(rebuildMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      uninstallMock.mock.invocationCallOrder[0]
    );
  });
});
