// SKILL-SIDE lifecycle teardown (cinatra#2350 S5, epic #2345).
//
// The three properties the issue names, pinned here:
//   * the swept ids are the EXACT DERIVED catalog ids, virtual chat namespace
//     included, and a successor package never sweeps its siblings';
//   * the sweep runs under the SAME per-extension lifecycle lock the S1 assign
//     flow takes, on the same key, BEFORE the delete;
//   * a scan or delete failure is FATAL (it propagates), because a surviving
//     row re-applies on reinstall.
import { describe, expect, it, vi } from "vitest";

import {
  deriveOwnedSkillIds,
  skillPackageNameCandidates,
  teardownAgentAssignmentsForSkillPackage,
} from "./agent-skill-assignability";
import type { SkillExtensionDescriptor } from "./extension-skill-resolver";

function descriptor(overrides: Partial<SkillExtensionDescriptor>): SkillExtensionDescriptor {
  return {
    pkgDir: "/x",
    pkgName: "@cinatra-ai/list-curation-skill",
    pkgDirName: "list-curation-skill",
    kind: "skill",
    dependencies: [],
    capabilities: {},
    slugs: ["list-curation"],
    ...overrides,
  } as SkillExtensionDescriptor;
}

/** The five allowlisted chat successor packages (exact dir + scoped name pairs). */
const CHAT_SUCCESSORS = [
  "chat-assistant-core-skill",
  "extension-authoring-skill",
  "automation-authoring-skill",
  "company-research-skill",
  "blog-content-skill",
] as const;

function successorDescriptor(dirName: string, slugs: string[]): SkillExtensionDescriptor {
  return descriptor({
    pkgName: `@cinatra-ai/${dirName}`,
    pkgDirName: dirName,
    slugs,
  });
}

describe("skillPackageNameCandidates — the persisted id shapes", () => {
  it("recovers the npm name from a verdaccio package id", () => {
    expect(skillPackageNameCandidates("verdaccio:@cinatra-ai/blog-skills")).toEqual([
      "@cinatra-ai/blog-skills",
    ]);
  });

  it("recovers owner/repo from a github package id, and offers the npm-normalized twin", () => {
    expect(skillPackageNameCandidates("github:acme/skills")).toEqual(["acme/skills", "@acme/skills"]);
  });

  it("accepts a RAW name with no source prefix", () => {
    expect(skillPackageNameCandidates("@cinatra-ai/blog-skills")).toEqual([
      "@cinatra-ai/blog-skills",
    ]);
  });

  it("yields NOTHING for an empty / prefix-only id", () => {
    expect(skillPackageNameCandidates("")).toEqual([]);
    expect(skillPackageNameCandidates("   ")).toEqual([]);
    expect(skillPackageNameCandidates("verdaccio:")).toEqual([]);
  });
});

describe("deriveOwnedSkillIds — the EXACT derived catalog ids", () => {
  it("derives `<pkg>:<slug>` for an ordinary skill package, for every slug", () => {
    const out = deriveOwnedSkillIds(
      ["@cinatra-ai/list-curation-skill"],
      [descriptor({ slugs: ["list-curation", "list-scoring"] })],
    );
    expect(out.ownerPackageName).toBe("@cinatra-ai/list-curation-skill");
    expect(out.skillIds.sort()).toEqual([
      "@cinatra-ai/list-curation-skill:list-curation",
      "@cinatra-ai/list-curation-skill:list-scoring",
    ]);
  });

  it("derives the VIRTUAL chat-namespace id for a successor package — NOT `<pkg>:<slug>`", () => {
    const out = deriveOwnedSkillIds(
      ["@cinatra-ai/company-research-skill"],
      [successorDescriptor("company-research-skill", ["company-research"])],
    );
    // The row an admin's assignment wrote carries the VIRTUAL id; sweeping
    // `@cinatra-ai/company-research-skill:company-research` would delete nothing.
    expect(out.skillIds).toEqual(["@cinatra-ai/chat:company-research"]);
    expect(out.skillIds).not.toContain("@cinatra-ai/company-research-skill:company-research");
    // …while the LOCK key stays the REAL package (the key S1's assign path uses).
    expect(out.ownerPackageName).toBe("@cinatra-ai/company-research-skill");
  });

  it("covers all FIVE chat successor packages", () => {
    for (const dir of CHAT_SUCCESSORS) {
      const out = deriveOwnedSkillIds(
        [`@cinatra-ai/${dir}`],
        [successorDescriptor(dir, ["only-slug"])],
      );
      expect(out.skillIds).toEqual(["@cinatra-ai/chat:only-slug"]);
    }
  });

  it("NEVER sweeps a SIBLING successor's virtual ids", () => {
    const descriptors = [
      successorDescriptor("company-research-skill", ["company-research"]),
      successorDescriptor("blog-content-skill", ["blog-writing"]),
    ];
    const out = deriveOwnedSkillIds(["@cinatra-ai/company-research-skill"], descriptors);
    expect(out.skillIds).toEqual(["@cinatra-ai/chat:company-research"]);
    expect(out.skillIds).not.toContain("@cinatra-ai/chat:blog-writing");
  });

  it("REFUSES the reserved virtual namespace as a match key", () => {
    // Nothing installs `@cinatra-ai/chat`; accepting it as a needle would let a
    // single uninstall sweep every successor package's assignments at once.
    const out = deriveOwnedSkillIds(
      ["@cinatra-ai/chat"],
      [
        successorDescriptor("company-research-skill", ["company-research"]),
        successorDescriptor("blog-content-skill", ["blog-writing"]),
      ],
    );
    expect(out).toEqual({ ownerPackageName: null, skillIds: [] });
  });

  it("matches an UNSCOPED scanned name through npm normalization", () => {
    const out = deriveOwnedSkillIds(
      ["acme/skills", "@acme/skills"],
      [descriptor({ pkgName: "acme/skills", pkgDirName: "skills", slugs: ["a"] })],
    );
    expect(out.ownerPackageName).toBe("acme/skills");
    expect(out.skillIds).toEqual(["@acme/skills:a"]);
  });

  it("ignores NON-skill-kind extensions with the same name", () => {
    const out = deriveOwnedSkillIds(
      ["@cinatra-ai/list-curation-skill"],
      [descriptor({ kind: "agent", slugs: ["list-curation"] })],
    );
    expect(out).toEqual({ ownerPackageName: null, skillIds: [] });
  });

  it("yields NOTHING for a package no scanned extension owns", () => {
    expect(deriveOwnedSkillIds(["@vendor/absent"], [descriptor({})])).toEqual({
      ownerPackageName: null,
      skillIds: [],
    });
  });

  it("yields NOTHING for an EMPTY candidate list", () => {
    expect(deriveOwnedSkillIds([], [descriptor({})])).toEqual({
      ownerPackageName: null,
      skillIds: [],
    });
  });
});

describe("teardownAgentAssignmentsForSkillPackage — lock ordering + sweep", () => {
  function harness(descriptors: SkillExtensionDescriptor[]) {
    const order: string[] = [];
    const lockKeys: string[] = [];
    const deleted: string[][] = [];
    return {
      order,
      lockKeys,
      deleted,
      deps: {
        scanExtensions: async () => {
          order.push("scan");
          return descriptors;
        },
        withLifecycleLock: async <T>(pkg: string, fn: () => Promise<T>) => {
          order.push(`lock:${pkg}`);
          lockKeys.push(pkg);
          const out = await fn();
          order.push("unlock");
          return out;
        },
        deleteBySkillIds: async (ids: string[]) => {
          order.push("delete");
          deleted.push(ids);
          return {
            removed: ids.map((skillId) => ({ agentPackageName: "@cinatra-ai/web-scrape-agent", skillId })),
          };
        },
      },
    };
  }

  it("takes the OWNING package's lifecycle lock BEFORE deleting, and reports what it swept", async () => {
    const h = harness([descriptor({ slugs: ["list-curation"] })]);
    const out = await teardownAgentAssignmentsForSkillPackage(
      "verdaccio:@cinatra-ai/list-curation-skill",
      h.deps,
    );

    // The lock is taken on the SAME key S1's assign flow uses (the predicate's
    // `ownerPackageName`), and the delete happens INSIDE it.
    expect(h.order).toEqual(["scan", "lock:@cinatra-ai/list-curation-skill", "delete", "unlock"]);
    expect(h.deleted).toEqual([["@cinatra-ai/list-curation-skill:list-curation"]]);
    expect(out.removed).toEqual([
      {
        agentPackageName: "@cinatra-ai/web-scrape-agent",
        skillId: "@cinatra-ai/list-curation-skill:list-curation",
      },
    ]);
  });

  it("locks on the REAL package for a VIRTUAL-namespace successor, and sweeps its virtual id", async () => {
    const h = harness([successorDescriptor("company-research-skill", ["company-research"])]);
    await teardownAgentAssignmentsForSkillPackage(
      "verdaccio:@cinatra-ai/company-research-skill",
      h.deps,
    );
    expect(h.lockKeys).toEqual(["@cinatra-ai/company-research-skill"]);
    expect(h.deleted).toEqual([["@cinatra-ai/chat:company-research"]]);
  });

  it("takes NO lock and issues NO delete when the package owns no skills", async () => {
    const h = harness([descriptor({ pkgName: "@other/pkg", pkgDirName: "pkg" })]);
    const out = await teardownAgentAssignmentsForSkillPackage("verdaccio:@vendor/absent", h.deps);
    expect(h.order).toEqual(["scan"]);
    expect(out).toEqual({ ownerPackageName: null, skillIds: [], removed: [] });
  });

  it("does not even SCAN for an unusable package id", async () => {
    const h = harness([descriptor({})]);
    const out = await teardownAgentAssignmentsForSkillPackage("verdaccio:", h.deps);
    expect(h.order).toEqual([]);
    expect(out).toEqual({ ownerPackageName: null, skillIds: [], removed: [] });
  });

  it("PROPAGATES a scan failure (fatal — an unswept row re-applies on reinstall)", async () => {
    await expect(
      teardownAgentAssignmentsForSkillPackage("verdaccio:@cinatra-ai/list-curation-skill", {
        scanExtensions: async () => {
          throw new Error("scan exploded");
        },
        deleteBySkillIds: async () => ({ removed: [] }),
        withLifecycleLock: async (_p, fn) => fn(),
      }),
    ).rejects.toThrow(/scan exploded/);
  });

  it("PROPAGATES a delete failure (fatal), from INSIDE the lock", async () => {
    let released = false;
    await expect(
      teardownAgentAssignmentsForSkillPackage("verdaccio:@cinatra-ai/list-curation-skill", {
        scanExtensions: async () => [descriptor({})],
        deleteBySkillIds: async () => {
          throw new Error("delete exploded");
        },
        withLifecycleLock: async (_p, fn) => {
          try {
            return await fn();
          } finally {
            released = true;
          }
        },
      }),
    ).rejects.toThrow(/delete exploded/);
    // The lock is released on the failure path — a fatal teardown must not
    // wedge every later lifecycle operation on this package.
    expect(released).toBe(true);
  });

  it("logs the swept pairs with control characters stripped (a skill id cannot forge a record)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await teardownAgentAssignmentsForSkillPackage("verdaccio:@cinatra-ai/list-curation-skill", {
        scanExtensions: async () => [descriptor({})],
        withLifecycleLock: async (_p, fn) => fn(),
        deleteBySkillIds: async () => ({
          removed: [{ agentPackageName: "a\nFORGED", skillId: "b%s" }],
        }),
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const args = warn.mock.calls[0] ?? [];
      // The format string is a constant; every caller-influenced value is an
      // ARGUMENT, and the newline is gone.
      expect(String(args[0])).not.toContain("%s");
      expect(args.some((a) => String(a).includes("\n"))).toBe(false);
      expect(args.some((a) => String(a).includes("a FORGED"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("stays SILENT when nothing was swept", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await teardownAgentAssignmentsForSkillPackage("verdaccio:@cinatra-ai/list-curation-skill", {
        scanExtensions: async () => [descriptor({})],
        withLifecycleLock: async (_p, fn) => fn(),
        deleteBySkillIds: async () => ({ removed: [] }),
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
