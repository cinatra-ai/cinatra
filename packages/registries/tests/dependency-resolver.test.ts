import { describe, expect, it } from "vitest";
import {
  PluginDependencyConflictError,
  PluginDependencyCycleError,
  PluginDependencyLimitError,
  PluginDependencyResolutionError,
  PluginDependencyScopeError,
  resolveDependencyTree,
  type FetchPackument,
  type Packument,
  type PackumentVersionEntry,
  type PluginTypeConfig,
} from "@cinatra-ai/registries";

// Default type-config used by every call site below; covers the cases where
// the original tests assumed the @cinatra/ scope + agentDependencies key.
// Tests that exercise the @cinatra/ scope pass their own typeConfig.
const TYPE_CONFIG_CINATRA: PluginTypeConfig = {
  type: "agent",
  scopePrefixes: ["@cinatra/"],
  packumentDepKey: "agentDependencies",
};

const TYPE_CONFIG_AGENTS: PluginTypeConfig = {
  type: "agent",
  scopePrefixes: ["@cinatra/"],
  packumentDepKey: "agentDependencies",
};

type Spec = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
};

function makeVersionEntry(spec: Spec): PackumentVersionEntry {
  return {
    name: spec.name,
    version: spec.version,
    dist: {
      tarball: `https://registry.test/${spec.name}/-/${spec.version}.tgz`,
      integrity: `sha512-${spec.name}-${spec.version}`,
    },
    cinatra: spec.dependencies ? { agentDependencies: spec.dependencies } : undefined,
  };
}

function makePackuments(specs: Spec[]): Map<string, Packument> {
  const byName = new Map<string, Packument>();
  for (const spec of specs) {
    const existing = byName.get(spec.name);
    if (existing) {
      existing.versions[spec.version] = makeVersionEntry(spec);
    } else {
      byName.set(spec.name, {
        name: spec.name,
        versions: { [spec.version]: makeVersionEntry(spec) },
        "dist-tags": { latest: spec.version },
      });
    }
  }
  return byName;
}

function makeFetch(map: Map<string, Packument>): FetchPackument {
  return async (name: string) => {
    const p = map.get(name);
    if (!p) {
      const err = new Error(`E404 ${name}`) as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }
    return p;
  };
}

describe("resolveDependencyTree", () => {
  it("resolves a linear A->B->C chain and returns all three nodes pinned", async () => {
    const packs = makePackuments([
      { name: "@cinatra/a", version: "1.0.0", dependencies: { "@cinatra/b": "^1.0.0" } },
      { name: "@cinatra/b", version: "1.2.0", dependencies: { "@cinatra/c": "^1.0.0" } },
      { name: "@cinatra/c", version: "1.0.0" },
    ]);
    const tree = await resolveDependencyTree({
      rootPackageName: "@cinatra/a",
      rootRange: "^1.0.0",
      fetchPackument: makeFetch(packs),
      typeConfig: TYPE_CONFIG_CINATRA,
    });
    expect(tree.all.size).toBe(3);
    expect(tree.all.get("@cinatra/a")?.resolvedVersion).toBe("1.0.0");
    expect(tree.all.get("@cinatra/b")?.resolvedVersion).toBe("1.2.0");
    expect(tree.all.get("@cinatra/c")?.resolvedVersion).toBe("1.0.0");
    expect(tree.root.packageName).toBe("@cinatra/a");
    expect(tree.all.get("@cinatra/a")?.dependencies).toEqual({ "@cinatra/b": "^1.0.0" });
  });

  it("throws PluginDependencyCycleError on A->B->A", async () => {
    const packs = makePackuments([
      { name: "@cinatra/a", version: "1.0.0", dependencies: { "@cinatra/b": "^1.0.0" } },
      { name: "@cinatra/b", version: "1.0.0", dependencies: { "@cinatra/a": "^1.0.0" } },
    ]);
    await expect(
      resolveDependencyTree({
        rootPackageName: "@cinatra/a",
        rootRange: "^1.0.0",
        fetchPackument: makeFetch(packs),
        typeConfig: TYPE_CONFIG_CINATRA,
      }),
    ).rejects.toMatchObject({
      name: "PluginDependencyCycleError",
      cyclePath: expect.arrayContaining(["@cinatra/a", "@cinatra/b"]),
    });
  });

  it("throws PluginDependencyConflictError when two parents demand incompatible versions", async () => {
    const packs = makePackuments([
      {
        name: "@cinatra/root",
        version: "1.0.0",
        dependencies: { "@cinatra/x": "^1.0.0", "@cinatra/mid": "^1.0.0" },
      },
      {
        name: "@cinatra/mid",
        version: "1.0.0",
        dependencies: { "@cinatra/x": "^2.0.0" },
      },
      { name: "@cinatra/x", version: "1.5.0" },
      { name: "@cinatra/x", version: "2.1.0" },
    ]);
    await expect(
      resolveDependencyTree({
        rootPackageName: "@cinatra/root",
        rootRange: "^1.0.0",
        fetchPackument: makeFetch(packs),
        typeConfig: TYPE_CONFIG_CINATRA,
      }),
    ).rejects.toBeInstanceOf(PluginDependencyConflictError);
  });

  it("rejects a non-@cinatra root with PluginDependencyScopeError", async () => {
    const packs = makePackuments([{ name: "lodash", version: "4.17.0" }]);
    await expect(
      resolveDependencyTree({
        rootPackageName: "lodash",
        rootRange: "^4.0.0",
        fetchPackument: makeFetch(packs),
        typeConfig: TYPE_CONFIG_CINATRA,
      }),
    ).rejects.toBeInstanceOf(PluginDependencyScopeError);
  });

  it("rejects a transitive non-@cinatra dep with PluginDependencyScopeError", async () => {
    const packs = makePackuments([
      { name: "@cinatra/a", version: "1.0.0", dependencies: { lodash: "^4.0.0" } },
      { name: "lodash", version: "4.17.0" },
    ]);
    await expect(
      resolveDependencyTree({
        rootPackageName: "@cinatra/a",
        rootRange: "^1.0.0",
        fetchPackument: makeFetch(packs),
        typeConfig: TYPE_CONFIG_CINATRA,
      }),
    ).rejects.toBeInstanceOf(PluginDependencyScopeError);
  });

  it("throws PluginDependencyLimitError('depth', 20) on a chain of 21 packages", async () => {
    const specs: Spec[] = [];
    for (let i = 0; i < 22; i++) {
      const deps = i < 21 ? { [`@cinatra/p${i + 1}`]: "^1.0.0" } : undefined;
      specs.push({ name: `@cinatra/p${i}`, version: "1.0.0", dependencies: deps });
    }
    const packs = makePackuments(specs);
    await expect(
      resolveDependencyTree({
        rootPackageName: "@cinatra/p0",
        rootRange: "^1.0.0",
        fetchPackument: makeFetch(packs),
        typeConfig: TYPE_CONFIG_CINATRA,
        maxDepth: 20,
      }),
    ).rejects.toMatchObject({
      name: "PluginDependencyLimitError",
      kind: "depth",
      limit: 20,
    });
  });

  it("throws PluginDependencyLimitError('nodes', N) when exceeding maxNodes", async () => {
    // Fanout root with 6 children, cap at 5 nodes total.
    const rootDeps: Record<string, string> = {};
    const specs: Spec[] = [];
    for (let i = 0; i < 6; i++) {
      rootDeps[`@cinatra/c${i}`] = "^1.0.0";
      specs.push({ name: `@cinatra/c${i}`, version: "1.0.0" });
    }
    specs.push({ name: "@cinatra/root", version: "1.0.0", dependencies: rootDeps });
    const packs = makePackuments(specs);
    await expect(
      resolveDependencyTree({
        rootPackageName: "@cinatra/root",
        rootRange: "^1.0.0",
        fetchPackument: makeFetch(packs),
        typeConfig: TYPE_CONFIG_CINATRA,
        maxNodes: 5,
      }),
    ).rejects.toMatchObject({
      name: "PluginDependencyLimitError",
      kind: "nodes",
      limit: 5,
    });
  });

  it("throws PluginDependencyResolutionError when no version satisfies", async () => {
    const packs = makePackuments([{ name: "@cinatra/a", version: "1.0.0" }]);
    await expect(
      resolveDependencyTree({
        rootPackageName: "@cinatra/a",
        rootRange: "^99.0.0",
        fetchPackument: makeFetch(packs),
        typeConfig: TYPE_CONFIG_CINATRA,
      }),
    ).rejects.toBeInstanceOf(PluginDependencyResolutionError);
  });

  it("rejects pre-release ranges with a clear message", async () => {
    const packs = makePackuments([
      { name: "@cinatra/a", version: "1.0.0-beta.1" },
    ]);
    await expect(
      resolveDependencyTree({
        rootPackageName: "@cinatra/a",
        rootRange: "^1.0.0-beta.1",
        fetchPackument: makeFetch(packs),
        typeConfig: TYPE_CONFIG_CINATRA,
      }),
    ).rejects.toThrow(/pre-release/i);
  });
});

// ---------------------------------------------------------------------------
// Multi-prefix scope allowlist — regression coverage for issue #103.
// The allowlist is keyed on the root package's own vendor scope + the
// first-party base scope, so a vendor root may pull first-party deps and a
// first-party root resolves on ANY instance regardless of its namespace.
// ---------------------------------------------------------------------------

describe("scope-prefix allowlist (multi-prefix)", () => {
  const VENDOR_PLUS_FIRST_PARTY: PluginTypeConfig = {
    type: "agent",
    scopePrefixes: ["@acme/", "@cinatra-ai/"],
    packumentDepKey: "agentDependencies",
  };

  it("resolves a vendor root with first-party and own-scope deps", async () => {
    const packs = makePackuments([
      {
        name: "@acme/root",
        version: "1.0.0",
        dependencies: { "@cinatra-ai/base": "^1.0.0", "@acme/util": "^1.0.0" },
      },
      { name: "@cinatra-ai/base", version: "1.0.0" },
      { name: "@acme/util", version: "1.0.0" },
    ]);
    const tree = await resolveDependencyTree({
      rootPackageName: "@acme/root",
      rootRange: "^1.0.0",
      fetchPackument: makeFetch(packs),
      typeConfig: VENDOR_PLUS_FIRST_PARTY,
    });
    expect(tree.all.size).toBe(3);
    expect(tree.all.get("@cinatra-ai/base")?.resolvedVersion).toBe("1.0.0");
  });

  it("rejects a dep under a third vendor scope with PluginDependencyScopeError listing the allowlist", async () => {
    const packs = makePackuments([
      { name: "@acme/root", version: "1.0.0", dependencies: { "@evil/x": "^1.0.0" } },
      { name: "@evil/x", version: "1.0.0" },
    ]);
    await expect(
      resolveDependencyTree({
        rootPackageName: "@acme/root",
        rootRange: "^1.0.0",
        fetchPackument: makeFetch(packs),
        typeConfig: VENDOR_PLUS_FIRST_PARTY,
      }),
    ).rejects.toThrow(
      "Only @acme/*, @cinatra-ai/* packages may appear in dependencies; received: @evil/x",
    );
  });

  it("rejects an unscoped root even with a multi-prefix allowlist", async () => {
    const packs = makePackuments([{ name: "lodash", version: "4.17.0" }]);
    await expect(
      resolveDependencyTree({
        rootPackageName: "lodash",
        rootRange: "^4.0.0",
        fetchPackument: makeFetch(packs),
        typeConfig: VENDOR_PLUS_FIRST_PARTY,
      }),
    ).rejects.toBeInstanceOf(PluginDependencyScopeError);
  });

  it("does not let a prefix-shaped scope admit a lookalike scope (@acme/ vs @acme-evil/)", async () => {
    const packs = makePackuments([
      { name: "@acme/root", version: "1.0.0", dependencies: { "@acme-evil/x": "^1.0.0" } },
      { name: "@acme-evil/x", version: "1.0.0" },
    ]);
    await expect(
      resolveDependencyTree({
        rootPackageName: "@acme/root",
        rootRange: "^1.0.0",
        fetchPackument: makeFetch(packs),
        typeConfig: VENDOR_PLUS_FIRST_PARTY,
      }),
    ).rejects.toBeInstanceOf(PluginDependencyScopeError);
  });

  it("fails closed on an empty scopePrefixes allowlist", async () => {
    const packs = makePackuments([{ name: "@cinatra/a", version: "1.0.0" }]);
    await expect(
      resolveDependencyTree({
        rootPackageName: "@cinatra/a",
        rootRange: "^1.0.0",
        fetchPackument: makeFetch(packs),
        typeConfig: { type: "agent", scopePrefixes: [], packumentDepKey: "agentDependencies" },
      }),
    ).rejects.toThrow(/scopePrefixes must not be empty/);
  });

  it.each(["@cinatra-ai", "cinatra-ai/", "@/", "@a/b/"])(
    "fails closed on a malformed scope prefix: %s",
    async (badPrefix) => {
      const packs = makePackuments([{ name: "@cinatra/a", version: "1.0.0" }]);
      await expect(
        resolveDependencyTree({
          rootPackageName: "@cinatra/a",
          rootRange: "^1.0.0",
          fetchPackument: makeFetch(packs),
          typeConfig: {
            type: "agent",
            scopePrefixes: [badPrefix],
            packumentDepKey: "agentDependencies",
          },
        }),
      ).rejects.toThrow(/Malformed scope prefix/);
    },
  );
});

// ---------------------------------------------------------------------------
// Regression coverage — prefer-newer prunes stale consumer edges
// ---------------------------------------------------------------------------

describe("stale consumer-range pruning in prefer-newer", () => {
  // Diamond-dep scenario that requires stale-range pruning to resolve correctly.
  //
  // Packages:
  //   root@1.0.0:  { A: "^1.0.0", B: "^1.0.0" }
  //   A@1.0.0:     { C: "^1.0.0" }
  //   A@1.5.0:     { C: "^2.0.0" }   ← bumped C dep on major upgrade
  //   B@1.0.0:     { A: "^1.5.0" }   ← forces A to supersede
  //   C@1.0.0, C@2.0.0 (no deps)
  //
  // BFS order that exercises the bug:
  //   1. A@^1.0.0 first → fetchPackument returns only [1.0.0] → A resolves to 1.0.0
  //      → enqueue C@^1.0.0 (fromParent=A, fromParentVersion=1.0.0)
  //   2. C@^1.0.0 processed → resolves to 1.0.0; edge (A@1.0.0,"^1.0.0") recorded
  //   3. B@^1.5.0 enqueues A@^1.5.0; second fetchPackument now returns [1.0.0, 1.5.0]
  //      → prefer-newer supersedes A from 1.0.0 → 1.5.0 (1.5.0 satisfies root's ^1.0.0 ✓)
  //      → re-enqueue C@^2.0.0 (fromParent=A, fromParentVersion=1.5.0)
  //   4. C@^2.0.0 → prefer-newer tries to upgrade C from 1.0.0 → 2.0.0
  //      WITHOUT the fix: stale edge (A@1.0.0,"^1.0.0") still present →
  //        2.0.0 does NOT satisfy "^1.0.0" → PluginDependencyConflictError (wrong!)
  //      WITH the fix: stale edge pruned (A is now 1.5.0, not 1.0.0) →
  //        only "^2.0.0" remains → 2.0.0 satisfies "^2.0.0" → resolves correctly ✓
  it("upgrades leaf through a superseded parent without false conflict", async () => {
    const baseA: Packument = {
      name: "@cinatra/A",
      versions: {
        "1.0.0": makeVersionEntry({ name: "@cinatra/A", version: "1.0.0", dependencies: { "@cinatra/C": "^1.0.0" } }),
      },
    };
    const extendedA: Packument = {
      name: "@cinatra/A",
      versions: {
        "1.0.0": makeVersionEntry({ name: "@cinatra/A", version: "1.0.0", dependencies: { "@cinatra/C": "^1.0.0" } }),
        "1.5.0": makeVersionEntry({ name: "@cinatra/A", version: "1.5.0", dependencies: { "@cinatra/C": "^2.0.0" } }),
      },
    };
    const otherPacks = makePackuments([
      {
        name: "@cinatra/root",
        version: "1.0.0",
        dependencies: { "@cinatra/A": "^1.0.0", "@cinatra/B": "^1.0.0" },
      },
      { name: "@cinatra/B", version: "1.0.0", dependencies: { "@cinatra/A": "^1.5.0" } },
      { name: "@cinatra/C", version: "1.0.0" },
      { name: "@cinatra/C", version: "2.0.0" },
    ]);

    let aFetchCount = 0;
    const fetchPackument: FetchPackument = async (name) => {
      if (name === "@cinatra/A") {
        // First call: A only has 1.0.0 → resolver picks 1.0.0, enqueues C@^1.0.0
        // Second call: A also has 1.5.0 → prefer-newer supersedes A to 1.5.0
        return aFetchCount++ === 0 ? baseA : extendedA;
      }
      const p = otherPacks.get(name);
      if (!p) {
        const err = new Error(`E404 ${name}`) as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      }
      return p;
    };

    const tree = await resolveDependencyTree({
      rootPackageName: "@cinatra/root",
      rootRange: "^1.0.0",
      fetchPackument,
      typeConfig: TYPE_CONFIG_AGENTS,
      conflictPolicy: "prefer-newer",
    });

    expect(tree.all.get("@cinatra/A")?.resolvedVersion).toBe("1.5.0");
    expect(tree.all.get("@cinatra/C")?.resolvedVersion).toBe("2.0.0");
  });
});

// ---------------------------------------------------------------------------
// conflictPolicy: "prefer-newer"
// ---------------------------------------------------------------------------

describe("conflict resolution keep newer", () => {
  it("picks newer version when both consumer ranges overlap", async () => {
    // root depends on a@^1.0.0 and b@^1.0.0
    // a depends on leaf@^1.0.0 (enqueues first), b depends on leaf@^1.2.0
    // Two leaf versions are published: 1.0.0 and 1.3.0. With prefer-newer,
    // the resolver must upgrade leaf to 1.3.0 (satisfies both ^1.0.0 and ^1.2.0).
    const packs = makePackuments([
      {
        name: "@cinatra/root",
        version: "1.0.0",
        dependencies: {
          "@cinatra/a": "^1.0.0",
          "@cinatra/b": "^1.0.0",
        },
      },
      {
        name: "@cinatra/a",
        version: "1.0.0",
        dependencies: { "@cinatra/leaf": "^1.0.0" },
      },
      {
        name: "@cinatra/b",
        version: "1.0.0",
        dependencies: { "@cinatra/leaf": "^1.2.0" },
      },
      { name: "@cinatra/leaf", version: "1.0.0" },
      { name: "@cinatra/leaf", version: "1.3.0" },
    ]);

    const tree = await resolveDependencyTree({
      rootPackageName: "@cinatra/root",
      rootRange: "^1.0.0",
      fetchPackument: makeFetch(packs),
      typeConfig: TYPE_CONFIG_AGENTS,
      conflictPolicy: "prefer-newer",
    });

    expect(tree.all.get("@cinatra/leaf")?.resolvedVersion).toBe("1.3.0");
  });

  it("throws PluginDependencyConflictError when newer pick does not satisfy a prior consumer range", async () => {
    // root depends on a@^1.0.0 and b@^1.0.0
    // a depends on leaf@~1.0.0 (pins patch, accepts only 1.0.x)
    // b depends on leaf@^2.0.0
    // No version of leaf simultaneously satisfies both ranges — must throw.
    const packs = makePackuments([
      {
        name: "@cinatra/root",
        version: "1.0.0",
        dependencies: {
          "@cinatra/a": "^1.0.0",
          "@cinatra/b": "^1.0.0",
        },
      },
      {
        name: "@cinatra/a",
        version: "1.0.0",
        dependencies: { "@cinatra/leaf": "~1.0.0" },
      },
      {
        name: "@cinatra/b",
        version: "1.0.0",
        dependencies: { "@cinatra/leaf": "^2.0.0" },
      },
      { name: "@cinatra/leaf", version: "1.0.5" },
      { name: "@cinatra/leaf", version: "2.0.0" },
    ]);

    await expect(
      resolveDependencyTree({
        rootPackageName: "@cinatra/root",
        rootRange: "^1.0.0",
        fetchPackument: makeFetch(packs),
        typeConfig: TYPE_CONFIG_AGENTS,
        conflictPolicy: "prefer-newer",
      }),
    ).rejects.toBeInstanceOf(PluginDependencyConflictError);
  });
});
