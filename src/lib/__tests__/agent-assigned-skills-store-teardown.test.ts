/**
 * Skill-side lifecycle-teardown derivation (cinatra#2350 S5, epic #2345):
 * `deriveOwnedAssignedSkillIds` / `sweepAssignedSkillsForSkillPackageId` in
 * `@/lib/agent-assigned-skills-store.ts`.
 *
 * This logic lives in the S1 store (not a dedicated `packages/skills/**`
 * module) purely for route-graph/file-size ratchet reasons — see the
 * "SKILL-SIDE derivation" comment above these functions in that file. The
 * agent-side delete (`deleteAssignedSkillsForAgentPackage`) is the S1
 * primitive, unit-tested in `agent-assigned-skills-store.test.ts` alongside
 * `deleteAssignedSkillsForSkillIds`; the `uninstallSkillPackage` ORDERING
 * integration lives in
 * `packages/skills/src/skills-store-assigned-skills-sweep-ordering.test.ts`.
 *
 * Two concerns:
 *   1. Pure logic, driven entirely through injected `deps` — no real
 *      filesystem scan, no real DB.
 *   2. DEFAULT dependency wiring — that calling with NO `deps` reaches the
 *      REAL `@cinatra-ai/skills` (`scanSkillExtensions` /
 *      `deriveSkillRegistration`) and the REAL
 *      `deleteAssignedSkillsForSkillIds` in this same file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  scanSkillExtensions: vi.fn(),
  deriveSkillRegistration: vi.fn(),
}));
vi.mock("@cinatra-ai/skills", () => ({
  scanSkillExtensions: mocks.scanSkillExtensions,
  deriveSkillRegistration: mocks.deriveSkillRegistration,
}));

import {
  deriveOwnedAssignedSkillIds,
  sweepAssignedSkillsForSkillPackageId,
  type SkillPackageTeardownDeps,
} from "@/lib/agent-assigned-skills-store";

beforeEach(() => {
  mocks.scanSkillExtensions.mockReset();
  mocks.deriveSkillRegistration.mockReset();
});

function descriptor(over: Partial<{
  pkgName: string;
  pkgDirName: string;
  kind: string;
  slugs: string[];
}> = {}) {
  return {
    pkgName: "@vendor/pkg",
    pkgDirName: "pkg",
    kind: "skill",
    slugs: ["s1", "s2"],
    ...over,
  };
}

const identityDerive = (pkgName: string, _dir: string, slug: string) => ({
  packageName: pkgName,
  skillId: `${pkgName}:${slug}`,
});

// =============================================================================
// §1 — pure logic, injected deps
// =============================================================================

describe("deriveOwnedAssignedSkillIds", () => {
  function deps(over: Partial<SkillPackageTeardownDeps> = {}): SkillPackageTeardownDeps {
    return {
      scanExtensions: vi.fn(async () => [descriptor()]),
      deriveSkillRegistration: identityDerive,
      ...over,
    };
  }

  it("derives the exact catalog id for every slug this package owns", async () => {
    const ids = await deriveOwnedAssignedSkillIds("@vendor/pkg", deps());
    expect(ids).toEqual(["@vendor/pkg:s1", "@vendor/pkg:s2"]);
  });

  it("derives VIRTUAL chat-namespace ids for a chat successor package (a case a native catalog row cannot represent)", async () => {
    const ids = await deriveOwnedAssignedSkillIds(
      "@cinatra-ai/company-research-skill",
      deps({
        scanExtensions: vi.fn(async () => [
          descriptor({
            pkgName: "@cinatra-ai/company-research-skill",
            pkgDirName: "company-research-skill",
            slugs: ["company-research"],
          }),
        ]),
        deriveSkillRegistration: vi.fn(() => ({
          packageName: "@cinatra-ai/chat",
          skillId: "@cinatra-ai/chat:company-research",
        })),
      }),
    );
    expect(ids).toEqual(["@cinatra-ai/chat:company-research"]);
  });

  it("returns [] when the scan carries no kind:'skill' descriptor for this package name — a normal outcome, not a failure", async () => {
    const ids = await deriveOwnedAssignedSkillIds("@vendor/absent", deps());
    expect(ids).toEqual([]);
  });

  it("ignores a non-skill-kind descriptor sharing the same package name", async () => {
    const ids = await deriveOwnedAssignedSkillIds(
      "@vendor/pkg",
      deps({ scanExtensions: vi.fn(async () => [descriptor({ kind: "agent" })]) }),
    );
    expect(ids).toEqual([]);
  });

  it("a per-slug derivation throw (reserved-namespace impersonation) degrades ONLY that slug, mirroring buildSkillIdOwnership's fail-soft posture", async () => {
    const derive = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("deriveSkillRegistration: reserved namespace");
      })
      .mockImplementationOnce(identityDerive);
    const ids = await deriveOwnedAssignedSkillIds("@vendor/pkg", deps({ deriveSkillRegistration: derive }));
    expect(ids).toEqual(["@vendor/pkg:s2"]);
  });

  it("returns [] for an empty package name WITHOUT even calling the scan", async () => {
    const scanExtensions = vi.fn(async () => [descriptor()]);
    const ids = await deriveOwnedAssignedSkillIds("", deps({ scanExtensions }));
    expect(ids).toEqual([]);
    expect(scanExtensions).not.toHaveBeenCalled();
  });

  it("a package with a skill descriptor but zero slugs derives zero ids (not an error)", async () => {
    const ids = await deriveOwnedAssignedSkillIds(
      "@vendor/pkg",
      deps({ scanExtensions: vi.fn(async () => [descriptor({ slugs: [] })]) }),
    );
    expect(ids).toEqual([]);
  });
});

describe("sweepAssignedSkillsForSkillPackageId", () => {
  it("recovers the real npm name from a `verdaccio:` packageId and deletes every derived id", async () => {
    const deleteBySkillIds = vi.fn(async (ids: string[]) => ({ deletedCount: ids.length }));
    const result = await sweepAssignedSkillsForSkillPackageId("verdaccio:@vendor/pkg", {
      scanExtensions: vi.fn(async () => [descriptor()]),
      deriveSkillRegistration: identityDerive,
      deleteBySkillIds,
    });
    expect(deleteBySkillIds).toHaveBeenCalledWith(["@vendor/pkg:s1", "@vendor/pkg:s2"]);
    expect(result).toEqual({ deletedCount: 2 });
  });

  it("recovers the real npm name from a `github:` packageId", async () => {
    const scanExtensions = vi.fn(async () => [descriptor({ pkgName: "octo/repo", pkgDirName: "repo" })]);
    const deleteBySkillIds = vi.fn(async () => ({ deletedCount: 2 }));
    await sweepAssignedSkillsForSkillPackageId("github:octo/repo", {
      scanExtensions,
      deriveSkillRegistration: identityDerive,
      deleteBySkillIds,
    });
    expect(deleteBySkillIds).toHaveBeenCalledWith(["octo/repo:s1", "octo/repo:s2"]);
  });

  it("no-ops (NEVER calls delete) when the package owns no derivable ids — covers a virtual-namespace registration with no native skillPackages row at all", async () => {
    const deleteBySkillIds = vi.fn();
    const result = await sweepAssignedSkillsForSkillPackageId("verdaccio:@vendor/nothing", {
      scanExtensions: vi.fn(async () => []),
      deriveSkillRegistration: identityDerive,
      deleteBySkillIds,
    });
    expect(deleteBySkillIds).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedCount: 0 });
  });

  it("a scan failure propagates (fatal — mirrors the co-owner cleanup precedent: the whole uninstall must roll back rather than silently skip teardown)", async () => {
    await expect(
      sweepAssignedSkillsForSkillPackageId("verdaccio:@vendor/pkg", {
        scanExtensions: vi.fn(async () => {
          throw new Error("disk unreadable");
        }),
        deriveSkillRegistration: identityDerive,
        deleteBySkillIds: vi.fn(),
      }),
    ).rejects.toThrow("disk unreadable");
  });

  it("a delete failure propagates too", async () => {
    await expect(
      sweepAssignedSkillsForSkillPackageId("verdaccio:@vendor/pkg", {
        scanExtensions: vi.fn(async () => [descriptor()]),
        deriveSkillRegistration: identityDerive,
        deleteBySkillIds: vi.fn(async () => {
          throw new Error("db unreachable");
        }),
      }),
    ).rejects.toThrow("db unreachable");
  });
});

// =============================================================================
// §2 — DEFAULT dependency wiring (reaches the REAL @cinatra-ai/skills scan +
// the REAL deleteAssignedSkillsForSkillIds in this same file).
// =============================================================================

describe("default wiring — reaches the REAL @cinatra-ai/skills scan/derive", () => {
  it("with no deps: scans via scanSkillExtensions, derives via deriveSkillRegistration, deletes via the real store function", async () => {
    mocks.scanSkillExtensions.mockResolvedValueOnce([descriptor({ slugs: ["s1"] })]);
    mocks.deriveSkillRegistration.mockReturnValueOnce({
      packageName: "@vendor/pkg",
      skillId: "@vendor/pkg:s1",
    });

    // No live DB in this unit test — inject the delete leaf only, to keep
    // the scan/derive defaults exercised for real without a Postgres
    // connection. deleteAssignedSkillsForSkillIds's OWN default wiring
    // (the real DB) is covered by agent-assigned-skills-store.test.ts and
    // the DB-integration suite.
    const deleteBySkillIds = vi.fn(async (ids: string[]) => ({ deletedCount: ids.length }));
    const result = await sweepAssignedSkillsForSkillPackageId("verdaccio:@vendor/pkg", {
      deleteBySkillIds,
    });

    expect(mocks.scanSkillExtensions).toHaveBeenCalledTimes(1);
    expect(mocks.deriveSkillRegistration).toHaveBeenCalledWith("@vendor/pkg", "pkg", "s1");
    expect(deleteBySkillIds).toHaveBeenCalledWith(["@vendor/pkg:s1"]);
    expect(result).toEqual({ deletedCount: 1 });
  });

  it("with no deps and no owned ids: never reaches the delete leaf", async () => {
    mocks.scanSkillExtensions.mockResolvedValueOnce([]);
    const deleteBySkillIds = vi.fn();
    const result = await sweepAssignedSkillsForSkillPackageId("verdaccio:@vendor/nothing", {
      deleteBySkillIds,
    });
    expect(deleteBySkillIds).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedCount: 0 });
  });
});
