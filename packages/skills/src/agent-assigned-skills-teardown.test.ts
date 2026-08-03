// SKILL-SIDE lifecycle teardown (cinatra#2350 S5, epic #2345).
//
// The three properties the issue names, pinned here:
//   * the swept ids are the EXACT DERIVED catalog ids, virtual chat namespace
//     included, and a package never sweeps ids another package owns;
//   * the sweep runs under the SAME per-extension lifecycle lock the S1 assign
//     flow takes, and that lock is held for the WHOLE uninstall — not just the
//     DELETE — so an assign cannot land in the gap between the two;
//   * a scan or delete failure is FATAL and the uninstall never starts, because
//     a surviving row re-applies on reinstall.
import { describe, expect, it, vi } from "vitest";

import {
  deriveOwnedSkillIds,
  skillPackageName,
  withSkillAssignmentTeardown,
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
  return descriptor({ pkgName: `@cinatra-ai/${dirName}`, pkgDirName: dirName, slugs });
}

describe("skillPackageName — the persisted id shapes", () => {
  it("recovers the npm name from a verdaccio package id", () => {
    expect(skillPackageName("verdaccio:@cinatra-ai/blog-skills")).toBe("@cinatra-ai/blog-skills");
  });

  it("recovers owner/repo from a github package id — EXACTLY, with no npm twin", () => {
    // The npm-normalized twin (`@acme/skills`) is a DIFFERENT identity from a
    // different registry; offering it would let this uninstall sweep that
    // package's assignments. Codex round 1, adopted.
    expect(skillPackageName("github:acme/skills")).toBe("acme/skills");
  });

  it("accepts a RAW name with no source prefix", () => {
    expect(skillPackageName("@cinatra-ai/blog-skills")).toBe("@cinatra-ai/blog-skills");
  });

  it("yields NOTHING for an empty / prefix-only id", () => {
    expect(skillPackageName("")).toBeNull();
    expect(skillPackageName("   ")).toBeNull();
    expect(skillPackageName("verdaccio:")).toBeNull();
  });
});

describe("deriveOwnedSkillIds — the EXACT derived catalog ids", () => {
  it("derives `<pkg>:<slug>` for an ordinary skill package, for every slug", () => {
    const out = deriveOwnedSkillIds("@cinatra-ai/list-curation-skill", [
      descriptor({ slugs: ["list-curation", "list-scoring"] }),
    ]);
    expect(out.ownerPackageName).toBe("@cinatra-ai/list-curation-skill");
    expect(out.skillIds.sort()).toEqual([
      "@cinatra-ai/list-curation-skill:list-curation",
      "@cinatra-ai/list-curation-skill:list-scoring",
    ]);
  });

  it("derives the VIRTUAL chat-namespace id for a successor package — NOT `<pkg>:<slug>`", () => {
    const out = deriveOwnedSkillIds("@cinatra-ai/company-research-skill", [
      successorDescriptor("company-research-skill", ["company-research"]),
    ]);
    // The row an admin's assignment wrote carries the VIRTUAL id; sweeping
    // `@cinatra-ai/company-research-skill:company-research` would delete nothing.
    expect(out.skillIds).toEqual(["@cinatra-ai/chat:company-research"]);
    expect(out.skillIds).not.toContain("@cinatra-ai/company-research-skill:company-research");
    // …while the LOCK key stays the REAL package (the key S1's assign path uses).
    expect(out.ownerPackageName).toBe("@cinatra-ai/company-research-skill");
  });

  it("covers all FIVE chat successor packages", () => {
    for (const dir of CHAT_SUCCESSORS) {
      const out = deriveOwnedSkillIds(`@cinatra-ai/${dir}`, [successorDescriptor(dir, ["only-slug"])]);
      expect(out.skillIds).toEqual(["@cinatra-ai/chat:only-slug"]);
    }
  });

  it("NEVER sweeps a SIBLING successor's virtual ids", () => {
    const descriptors = [
      successorDescriptor("company-research-skill", ["company-research"]),
      successorDescriptor("blog-content-skill", ["blog-writing"]),
    ];
    const out = deriveOwnedSkillIds("@cinatra-ai/company-research-skill", descriptors);
    expect(out.skillIds).toEqual(["@cinatra-ai/chat:company-research"]);
    expect(out.skillIds).not.toContain("@cinatra-ai/chat:blog-writing");
  });

  it("REFUSES a COLLIDING virtual id another successor owns (codex round 1)", () => {
    // Two successors shipping the SAME slug derive the SAME virtual id. The
    // shared ownership map's first-seen rule awards it to ONE of them; the other
    // one's uninstall must not delete it, or an uninstall of a package that does
    // not own the id would drop a live assignment.
    const first = successorDescriptor("company-research-skill", ["shared-slug"]);
    const second = successorDescriptor("blog-content-skill", ["shared-slug"]);
    expect(deriveOwnedSkillIds("@cinatra-ai/company-research-skill", [first, second]).skillIds).toEqual(
      ["@cinatra-ai/chat:shared-slug"],
    );
    expect(deriveOwnedSkillIds("@cinatra-ai/blog-content-skill", [first, second]).skillIds).toEqual([]);
  });

  it("does NOT match an npm package by an UNSCOPED github-style name (codex round 1)", () => {
    // `github:acme/skills` and the npm package `@acme/skills` are unrelated
    // identities. Matching them would delete the npm package's assignments.
    const npm = descriptor({ pkgName: "@acme/skills", pkgDirName: "skills", slugs: ["a"] });
    expect(deriveOwnedSkillIds("acme/skills", [npm])).toEqual({
      ownerPackageName: null,
      skillIds: [],
    });
    // …and the exact npm name still resolves its own ids.
    expect(deriveOwnedSkillIds("@acme/skills", [npm]).skillIds).toEqual(["@acme/skills:a"]);
  });

  it("ignores NON-skill-kind extensions with the same name", () => {
    const out = deriveOwnedSkillIds("@cinatra-ai/list-curation-skill", [
      descriptor({ kind: "agent", slugs: ["list-curation"] }),
    ]);
    expect(out).toEqual({ ownerPackageName: null, skillIds: [] });
  });

  it("yields NOTHING for a package no scanned extension owns, or for the reserved namespace", () => {
    expect(deriveOwnedSkillIds("@vendor/absent", [descriptor({})])).toEqual({
      ownerPackageName: null,
      skillIds: [],
    });
    // Nothing installs `@cinatra-ai/chat`; accepting it as a needle would let a
    // single uninstall sweep every successor package's assignments at once.
    expect(
      deriveOwnedSkillIds("@cinatra-ai/chat", [
        successorDescriptor("company-research-skill", ["company-research"]),
      ]),
    ).toEqual({ ownerPackageName: null, skillIds: [] });
    expect(deriveOwnedSkillIds(null, [descriptor({})])).toEqual({
      ownerPackageName: null,
      skillIds: [],
    });
  });
});

describe("withSkillAssignmentTeardown — lock span, ordering, fatality", () => {
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
            removed: ids.map((skillId) => ({
              agentPackageName: "@cinatra-ai/web-scrape-agent",
              skillId,
            })),
          };
        },
      },
    };
  }

  it("holds the OWNING package's lock across the DELETE **and** the whole uninstall", async () => {
    const h = harness([descriptor({ slugs: ["list-curation"] })]);
    const out = await withSkillAssignmentTeardown(
      "verdaccio:@cinatra-ai/list-curation-skill",
      async () => {
        h.order.push("uninstall");
        return "done" as const;
      },
      h.deps,
    );

    // The lock is taken on the SAME key S1's assign flow uses, the delete
    // happens inside it, and `unlock` comes AFTER the uninstall — the gap an
    // earlier draft left open (sweep → unlock → assign → remove package).
    expect(h.order).toEqual([
      "lock:@cinatra-ai/list-curation-skill",
      "scan",
      "delete",
      "uninstall",
      "unlock",
    ]);
    expect(h.deleted).toEqual([["@cinatra-ai/list-curation-skill:list-curation"]]);
    expect(out).toBe("done");
  });

  it("locks on the REAL package for a VIRTUAL-namespace successor, and sweeps its virtual id", async () => {
    const h = harness([successorDescriptor("company-research-skill", ["company-research"])]);
    await withSkillAssignmentTeardown(
      "verdaccio:@cinatra-ai/company-research-skill",
      async () => undefined,
      h.deps,
    );
    expect(h.lockKeys).toEqual(["@cinatra-ai/company-research-skill"]);
    expect(h.deleted).toEqual([["@cinatra-ai/chat:company-research"]]);
  });

  it("still runs the uninstall — unlocked — when the package owns no assignable skills", async () => {
    const h = harness([descriptor({ pkgName: "@other/pkg", pkgDirName: "pkg" })]);
    const out = await withSkillAssignmentTeardown(
      "verdaccio:@vendor/absent",
      async () => "ran" as const,
      h.deps,
    );
    // The lock is taken BEFORE the scan and the uninstall runs inside it, even
    // when the package turns out to own nothing (codex round 2): the earlier
    // shape ran the whole destructive uninstall unlocked in exactly the case a
    // concurrent update could be changing what this package owns.
    expect(h.order).toEqual(["lock:@vendor/absent", "scan", "unlock"]);
    expect(out).toBe("ran");
  });

  it("does not even SCAN for an unusable package id, but still runs the uninstall", async () => {
    const h = harness([descriptor({})]);
    const out = await withSkillAssignmentTeardown("verdaccio:", async () => "ran" as const, h.deps);
    expect(h.order).toEqual([]);
    expect(out).toBe("ran");
  });

  it("PROPAGATES a scan failure, NEVER starts the uninstall (fatal), and releases the lock", async () => {
    const uninstall = vi.fn(async () => undefined);
    let released = false;
    await expect(
      withSkillAssignmentTeardown("verdaccio:@cinatra-ai/list-curation-skill", uninstall, {
        scanExtensions: async () => {
          throw new Error("scan exploded");
        },
        deleteBySkillIds: async () => ({ removed: [] }),
        withLifecycleLock: async (_p, fn) => {
          try {
            return await fn();
          } finally {
            released = true;
          }
        },
      }),
    ).rejects.toThrow(/scan exploded/);
    expect(uninstall).not.toHaveBeenCalled();
    expect(released).toBe(true);
  });

  it("PROPAGATES a delete failure, NEVER starts the uninstall, and releases the lock", async () => {
    let released = false;
    const uninstall = vi.fn(async () => undefined);
    await expect(
      withSkillAssignmentTeardown("verdaccio:@cinatra-ai/list-curation-skill", uninstall, {
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
    expect(uninstall).not.toHaveBeenCalled();
    // A fatal teardown must not wedge every later lifecycle op on this package.
    expect(released).toBe(true);
  });

  it("a CONCURRENT assign on the same key cannot land between the sweep and the package removal", async () => {
    // The real re-entrant queue semantics, modelled: one holder at a time per
    // key. The assign is admitted only after the uninstall's critical section
    // has finished, so there is no window in which it could revalidate against a
    // package the sweep has already passed.
    const events: string[] = [];
    let chain: Promise<unknown> = Promise.resolve();
    const withLifecycleLock = <T,>(_pkg: string, fn: () => Promise<T>): Promise<T> => {
      const next = chain.then(fn, fn);
      chain = next.catch(() => undefined);
      return next;
    };

    const uninstalling = withSkillAssignmentTeardown(
      "verdaccio:@cinatra-ai/list-curation-skill",
      async () => {
        events.push("remove-package:start");
        await new Promise((r) => setTimeout(r, 10));
        events.push("remove-package:end");
      },
      {
        scanExtensions: async () => [descriptor({})],
        withLifecycleLock,
        deleteBySkillIds: async (ids) => {
          events.push("sweep");
          await new Promise((r) => setTimeout(r, 5));
          return { removed: ids.map((skillId) => ({ agentPackageName: "@a/b", skillId })) };
        },
      },
    );
    const assigning = withLifecycleLock("@cinatra-ai/list-curation-skill", async () => {
      events.push("assign");
    });

    await Promise.all([uninstalling, assigning]);
    // Whichever critical section is admitted first runs to completion. What must
    // NEVER happen is an assign BETWEEN the sweep and the package removal, so
    // the assertion is adjacency, not a fixed winner.
    expect(events).toContain("assign");
    const sweep = events.indexOf("sweep");
    expect(events.slice(sweep, sweep + 3)).toEqual([
      "sweep",
      "remove-package:start",
      "remove-package:end",
    ]);
    // The whole critical section — scan included — is inside the lock, so the
    // competing assign cannot slip in during the scan either (codex round 2).
    expect(events.indexOf("assign")).not.toBe(sweep - 1);
  });

  it("logs the swept pairs with control characters stripped (a skill id cannot forge a record)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withSkillAssignmentTeardown(
        "verdaccio:@cinatra-ai/list-curation-skill",
        async () => undefined,
        {
          scanExtensions: async () => [descriptor({})],
          withLifecycleLock: async (_p, fn) => fn(),
          deleteBySkillIds: async () => ({
            removed: [{ agentPackageName: "a\nFORGED", skillId: "b%s" }],
          }),
        },
      );
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
      await withSkillAssignmentTeardown(
        "verdaccio:@cinatra-ai/list-curation-skill",
        async () => undefined,
        {
          scanExtensions: async () => [descriptor({})],
          withLifecycleLock: async (_p, fn) => fn(),
          deleteBySkillIds: async () => ({ removed: [] }),
        },
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
