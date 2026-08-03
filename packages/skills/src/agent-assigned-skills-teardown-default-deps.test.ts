/**
 * Pins the DEFAULT dependency wiring of the lifecycle-teardown slice
 * (cinatra#2350 S5, epic #2345) — i.e. that calling the exported functions
 * with NO `deps` reaches the REAL `./extension-skill-resolver` scan/derive
 * and the REAL `@/lib/agent-assigned-skills-store` deletes, not just that the
 * injected-dep arms behave correctly (covered in
 * agent-assigned-skills-teardown.test.ts). Mirrors the "default binding"
 * guard pattern from the S2 PR (cinatra#2347).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  scanSkillExtensions: vi.fn(),
  deriveSkillRegistration: vi.fn(),
  deleteAssignedSkillsForSkillIds: vi.fn(),
  deleteAssignedSkillsForAgentPackage: vi.fn(),
}));

vi.mock("./extension-skill-resolver", () => ({
  scanSkillExtensions: mocks.scanSkillExtensions,
  deriveSkillRegistration: mocks.deriveSkillRegistration,
}));

vi.mock("@/lib/agent-assigned-skills-store", () => ({
  deleteAssignedSkillsForSkillIds: mocks.deleteAssignedSkillsForSkillIds,
  deleteAssignedSkillsForAgentPackage: mocks.deleteAssignedSkillsForAgentPackage,
}));

import {
  sweepAssignedSkillsForSkillPackageId,
  deleteAssignedSkillsForAgentPackage,
} from "./agent-assigned-skills-teardown";

beforeEach(() => {
  mocks.scanSkillExtensions.mockReset();
  mocks.deriveSkillRegistration.mockReset();
  mocks.deleteAssignedSkillsForSkillIds.mockReset();
  mocks.deleteAssignedSkillsForAgentPackage.mockReset();
});

describe("skill-side sweep — default wiring reaches the REAL extension-skill-resolver + store", () => {
  it("with no deps: scans via scanSkillExtensions, derives via deriveSkillRegistration, deletes via the store", async () => {
    mocks.scanSkillExtensions.mockResolvedValueOnce([
      {
        pkgDir: "/x",
        pkgName: "@vendor/pkg",
        pkgDirName: "pkg",
        kind: "skill",
        dependencies: [],
        capabilities: {},
        slugs: ["s1"],
      },
    ]);
    mocks.deriveSkillRegistration.mockReturnValueOnce({
      packageName: "@vendor/pkg",
      skillId: "@vendor/pkg:s1",
    });
    mocks.deleteAssignedSkillsForSkillIds.mockResolvedValueOnce({ deletedCount: 1 });

    const result = await sweepAssignedSkillsForSkillPackageId("verdaccio:@vendor/pkg");

    expect(mocks.scanSkillExtensions).toHaveBeenCalledTimes(1);
    expect(mocks.deriveSkillRegistration).toHaveBeenCalledWith("@vendor/pkg", "pkg", "s1");
    expect(mocks.deleteAssignedSkillsForSkillIds).toHaveBeenCalledWith(["@vendor/pkg:s1"]);
    expect(result).toEqual({ deletedCount: 1 });
  });

  it("with no deps and no owned ids: never reaches the store delete", async () => {
    mocks.scanSkillExtensions.mockResolvedValueOnce([]);

    const result = await sweepAssignedSkillsForSkillPackageId("verdaccio:@vendor/nothing");

    expect(mocks.deleteAssignedSkillsForSkillIds).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedCount: 0 });
  });
});

describe("agent-side delete — default wiring reaches the REAL @/lib/agent-assigned-skills-store", () => {
  it("delegates the agent package name to the real store primitive", async () => {
    mocks.deleteAssignedSkillsForAgentPackage.mockResolvedValueOnce({ deletedCount: 3 });

    const result = await deleteAssignedSkillsForAgentPackage("@vendor/agent-pkg");

    expect(mocks.deleteAssignedSkillsForAgentPackage).toHaveBeenCalledWith("@vendor/agent-pkg");
    expect(result).toEqual({ deletedCount: 3 });
  });
});
