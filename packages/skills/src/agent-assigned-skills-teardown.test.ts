/**
 * Pure-logic tests for the lifecycle teardown slice (cinatra#2350 S5, epic
 * #2345), driven entirely through injected `deps` — no real filesystem scan,
 * no real DB. The default-wiring (real `./extension-skill-resolver` +
 * `@/lib/agent-assigned-skills-store`) is pinned separately in
 * `agent-assigned-skills-teardown-default-deps.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  deriveOwnedAssignedSkillIds,
  sweepAssignedSkillsForSkillPackageId,
} from "./agent-assigned-skills-teardown";
import type { SkillExtensionDescriptor } from "./extension-skill-resolver";

function descriptor(
  over: Partial<SkillExtensionDescriptor> = {},
): SkillExtensionDescriptor {
  return {
    pkgDir: "/x",
    pkgName: "@vendor/pkg",
    pkgDirName: "pkg",
    kind: "skill",
    dependencies: [],
    capabilities: {},
    slugs: ["s1", "s2"],
    ...over,
  };
}

const identityDerive = vi.fn((pkgName: string, _dir: string, slug: string) => ({
  packageName: pkgName,
  skillId: `${pkgName}:${slug}`,
}));

describe("deriveOwnedAssignedSkillIds", () => {
  it("derives the exact catalog id for every slug this package owns", async () => {
    const ids = await deriveOwnedAssignedSkillIds("@vendor/pkg", {
      scanExtensions: vi.fn(async () => [descriptor()]),
      deriveSkillRegistration: identityDerive,
    });
    expect(ids).toEqual(["@vendor/pkg:s1", "@vendor/pkg:s2"]);
  });

  it("derives VIRTUAL chat-namespace ids for a chat successor package (the case a native catalog row cannot represent)", async () => {
    const scanExtensions = vi.fn(async () => [
      descriptor({
        pkgName: "@cinatra-ai/company-research-skill",
        pkgDirName: "company-research-skill",
        slugs: ["company-research"],
      }),
    ]);
    const deriveSkillRegistration = vi.fn(() => ({
      packageName: "@cinatra-ai/chat",
      skillId: "@cinatra-ai/chat:company-research",
    }));
    const ids = await deriveOwnedAssignedSkillIds("@cinatra-ai/company-research-skill", {
      scanExtensions,
      deriveSkillRegistration,
    });
    expect(ids).toEqual(["@cinatra-ai/chat:company-research"]);
  });

  it("returns [] when the scan carries no kind:'skill' descriptor for this package name — a normal outcome, not a failure", async () => {
    const ids = await deriveOwnedAssignedSkillIds("@vendor/absent", {
      scanExtensions: vi.fn(async () => [descriptor()]),
      deriveSkillRegistration: identityDerive,
    });
    expect(ids).toEqual([]);
  });

  it("ignores a non-skill-kind descriptor sharing the same package name", async () => {
    const ids = await deriveOwnedAssignedSkillIds("@vendor/pkg", {
      scanExtensions: vi.fn(async () => [descriptor({ kind: "agent" })]),
      deriveSkillRegistration: identityDerive,
    });
    expect(ids).toEqual([]);
  });

  it("a per-slug derivation throw (reserved-namespace impersonation) degrades ONLY that slug, mirroring buildSkillIdOwnership's fail-soft posture", async () => {
    const derive = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("deriveSkillRegistration: reserved namespace");
      })
      .mockImplementationOnce((pkgName: string, _dir: string, slug: string) => ({
        packageName: pkgName,
        skillId: `${pkgName}:${slug}`,
      }));
    const ids = await deriveOwnedAssignedSkillIds("@vendor/pkg", {
      scanExtensions: vi.fn(async () => [descriptor()]),
      deriveSkillRegistration: derive,
    });
    expect(ids).toEqual(["@vendor/pkg:s2"]);
  });

  it("returns [] for an empty package name WITHOUT even calling the scan", async () => {
    const scanExtensions = vi.fn(async () => [descriptor()]);
    const ids = await deriveOwnedAssignedSkillIds("", {
      scanExtensions,
      deriveSkillRegistration: identityDerive,
    });
    expect(ids).toEqual([]);
    expect(scanExtensions).not.toHaveBeenCalled();
  });

  it("a package with a skill descriptor but zero slugs derives zero ids (not an error)", async () => {
    const ids = await deriveOwnedAssignedSkillIds("@vendor/pkg", {
      scanExtensions: vi.fn(async () => [descriptor({ slugs: [] })]),
      deriveSkillRegistration: identityDerive,
    });
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
    const scanExtensions = vi.fn(async () => [
      descriptor({ pkgName: "octo/repo", pkgDirName: "repo" }),
    ]);
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
