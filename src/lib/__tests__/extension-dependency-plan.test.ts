// #180 PR-2: dependency-install PLANNER — closure semantics, range
// cross-checks, conflicts, and the test-pinned topo direction.
import { describe, expect, it, vi } from "vitest";

import {
  planDependencyInstall,
  DependencyPlanError,
  type DependencyPlanDeps,
  type MemberSummary,
} from "@/lib/extension-dependency-plan";
import type { ExtensionDependency, InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import { parseManifestDependencyEdges } from "@cinatra-ai/extensions/manifest-dependencies";
import { isAutoInstallableEdge } from "@cinatra-ai/extensions/dependency-closure";

function edge(packageName: string, over: Partial<ExtensionDependency> = {}): ExtensionDependency {
  return {
    packageName,
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "*" },
    requirement: "required",
    ...over,
  };
}

type Pkg = {
  version: string;
  kind?: "agent" | "skill" | "connector" | "artifact" | "workflow";
  dependencies?: ExtensionDependency[];
};

function makeDeps(
  registry: Record<string, Pkg>,
  installed: Array<{ packageName: string; version: string; organizationId?: string | null }> = [],
) {
  const fetched: string[] = [];
  const deps: DependencyPlanDeps = {
    fetchSummary: vi.fn(async (packageName: string, _v: string): Promise<MemberSummary> => {
      fetched.push(packageName);
      const pkg = registry[packageName];
      if (!pkg) throw new Error(`fixture: no package ${packageName}`);
      return {
        resolvedVersion: pkg.version,
        kind: pkg.kind ?? "connector",
        manifest: {
          name: packageName,
          version: pkg.version,
          cinatra: { kind: pkg.kind ?? "connector", dependencies: pkg.dependencies ?? [] },
        },
      };
    }),
    parseEdges: (manifest, packageName) =>
      parseManifestDependencyEdges(manifest, { packageName }).edges,
    isAutoInstallableEdge,
    readInstalledRows: async () =>
      installed.map(
        (i) =>
          ({
            id: `row-${i.packageName}`,
            packageName: i.packageName,
            status: "active",
            organizationId: i.organizationId ?? null,
            source: { type: "verdaccio", version: i.version },
            dependencies: [],
          }) as unknown as InstalledExtension,
      ),
  };
  return { deps, fetched };
}

const ROOT = "@cinatra-ai/root";

describe("planDependencyInstall — topo order (test-pinned direction)", () => {
  it("dependencies install FIRST, the root LAST; lexicographic tie-break", async () => {
    // root -> a, root -> b, a -> c  ⇒  order: c, a, b, root
    const { deps } = makeDeps({
      [ROOT]: { version: "1.0.0", dependencies: [edge("@cinatra-ai/a"), edge("@cinatra-ai/b")] },
      "@cinatra-ai/a": { version: "1.0.0", dependencies: [edge("@cinatra-ai/c")] },
      "@cinatra-ai/b": { version: "2.0.0" },
      "@cinatra-ai/c": { version: "3.0.0" },
    });
    const plan = await planDependencyInstall(
      { root: { packageName: ROOT, version: "1.0.0" }, orgId: null, closure: null },
      deps,
    );
    expect(plan.ordered.map((m) => m.packageName)).toEqual([
      // b and c are both dependency-free: lexicographic tie-break (b < c);
      // a waits for c; the root is last.
      "@cinatra-ai/b",
      "@cinatra-ai/c",
      "@cinatra-ai/a",
      ROOT,
    ]);
    expect(plan.ordered[plan.ordered.length - 1]!.packageName).toBe(ROOT);
    expect(plan.source).toBe("manifest-walk");
  });

  it("PEER and OPTIONAL edges are NEVER auto-installed (shared predicate)", async () => {
    const { deps, fetched } = makeDeps({
      [ROOT]: {
        version: "1.0.0",
        dependencies: [
          edge("@cinatra-ai/required-dep"),
          edge("@cinatra-ai/peer-dep", { edgeType: "peer" }),
          edge("@cinatra-ai/optional-dep", { requirement: "optional" }),
        ],
      },
      "@cinatra-ai/required-dep": { version: "1.0.0" },
    });
    const plan = await planDependencyInstall(
      { root: { packageName: ROOT, version: "1.0.0" }, orgId: null, closure: null },
      deps,
    );
    expect(plan.ordered.map((m) => m.packageName)).toEqual(["@cinatra-ai/required-dep", ROOT]);
    expect(fetched).not.toContain("@cinatra-ai/peer-dep");
    expect(fetched).not.toContain("@cinatra-ai/optional-dep");
  });
});

describe("planDependencyInstall — dev root version resolution (round-2 fix)", () => {
  it("a dev-path 'latest' root resolves to the concrete registry version (never treated as an exact pin)", async () => {
    const { deps } = makeDeps({
      [ROOT]: { version: "1.7.0", dependencies: [edge("@cinatra-ai/a")] },
      "@cinatra-ai/a": { version: "2.0.0" },
    });
    const plan = await planDependencyInstall(
      { root: { packageName: ROOT, version: "latest" }, orgId: null, closure: null },
      deps,
    );
    expect(plan.root.version).toBe("1.7.0");
    expect(plan.ordered.find((m) => m.packageName === ROOT)!.version).toBe("1.7.0");
  });
});

describe("planDependencyInstall — marketplace closure (authorization set)", () => {
  it("pins members at the closure's exact versions; a walked member missing from the closure is an AUTHORIZATION MISMATCH", async () => {
    const { deps } = makeDeps({
      [ROOT]: { version: "1.0.0", dependencies: [edge("@cinatra-ai/a")] },
      "@cinatra-ai/a": { version: "1.2.0" },
    });
    const plan = await planDependencyInstall(
      {
        root: { packageName: ROOT, version: "1.0.0" },
        orgId: null,
        closure: [{ name: "@cinatra-ai/a", version: "1.2.0" }],
      },
      deps,
    );
    expect(plan.source).toBe("marketplace-closure");
    expect(plan.ordered.map((m) => `${m.packageName}@${m.version}`)).toEqual([
      "@cinatra-ai/a@1.2.0",
      `${ROOT}@1.0.0`,
    ]);

    // Same graph, EMPTY closure → mismatch fail-loud.
    const { deps: deps2 } = makeDeps({
      [ROOT]: { version: "1.0.0", dependencies: [edge("@cinatra-ai/a")] },
      "@cinatra-ai/a": { version: "1.2.0" },
    });
    await expect(
      planDependencyInstall(
        { root: { packageName: ROOT, version: "1.0.0" }, orgId: null, closure: [] },
        deps2,
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_MISMATCH" });
  });
});

describe("planDependencyInstall — range cross-check matrix (item 7, v1)", () => {
  async function planWith(constraint: ExtensionDependency["versionConstraint"], pin: string) {
    const { deps } = makeDeps({
      [ROOT]: { version: "1.0.0", dependencies: [edge("@cinatra-ai/a", { versionConstraint: constraint })] },
      "@cinatra-ai/a": { version: pin },
    });
    return planDependencyInstall(
      {
        root: { packageName: ROOT, version: "1.0.0" },
        orgId: null,
        closure: [{ name: "@cinatra-ai/a", version: pin }],
      },
      deps,
    );
  }

  it("semver-range satisfied → ok; violated → RANGE_VIOLATION (fail-loud, no server-side re-resolution)", async () => {
    await expect(planWith({ kind: "semver-range", range: "^1.0.0" }, "1.4.0")).resolves.toBeTruthy();
    await expect(planWith({ kind: "semver-range", range: "^2.0.0" }, "1.4.0")).rejects.toMatchObject({
      code: "RANGE_VIOLATION",
    });
  });

  it("exact equal → ok; exact different → RANGE_VIOLATION", async () => {
    await expect(planWith({ kind: "exact", version: "1.4.0" }, "1.4.0")).resolves.toBeTruthy();
    await expect(planWith({ kind: "exact", version: "1.3.0" }, "1.4.0")).rejects.toMatchObject({
      code: "RANGE_VIOLATION",
    });
  });

  it("git-ref → UNSUPPORTED_CONSTRAINT (v1 = registry coordinates only)", async () => {
    await expect(planWith({ kind: "git-ref", ref: "main" }, "1.4.0")).rejects.toMatchObject({
      code: "UNSUPPORTED_CONSTRAINT",
    });
  });
});

describe("planDependencyInstall — installed-state interactions (item 7)", () => {
  it("already installed at the EXACT pin → alreadyInstalled (skipped by the saga), subtree not re-walked", async () => {
    const { deps, fetched } = makeDeps(
      {
        [ROOT]: { version: "1.0.0", dependencies: [edge("@cinatra-ai/a")] },
        "@cinatra-ai/a": { version: "1.2.0", dependencies: [edge("@cinatra-ai/sub")] },
      },
      [{ packageName: "@cinatra-ai/a", version: "1.2.0" }],
    );
    const plan = await planDependencyInstall(
      {
        root: { packageName: ROOT, version: "1.0.0" },
        orgId: null,
        closure: [{ name: "@cinatra-ai/a", version: "1.2.0" }],
      },
      deps,
    );
    const a = plan.ordered.find((m) => m.packageName === "@cinatra-ai/a")!;
    expect(a.alreadyInstalled).toBe(true);
    // Its own closure was guaranteed by ITS forward gate — never re-walked.
    expect(fetched).not.toContain("@cinatra-ai/sub");
  });

  it("installed at a DIFFERENT version → INSTALLED_VERSION_CONFLICT with the precise upgrade instruction", async () => {
    const { deps } = makeDeps(
      {
        [ROOT]: { version: "1.0.0", dependencies: [edge("@cinatra-ai/a")] },
        "@cinatra-ai/a": { version: "1.2.0" },
      },
      [{ packageName: "@cinatra-ai/a", version: "1.0.0" }],
    );
    try {
      await planDependencyInstall(
        {
          root: { packageName: ROOT, version: "1.0.0" },
          orgId: null,
          closure: [{ name: "@cinatra-ai/a", version: "1.2.0" }],
        },
        deps,
      );
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DependencyPlanError);
      expect((e as DependencyPlanError).code).toBe("INSTALLED_VERSION_CONFLICT");
      expect((e as Error).message).toContain("already installed at 1.0.0");
      expect((e as Error).message).toContain("needs it at 1.2.0");
      // The precise, copy-pinned instruction: explicit update first, then retry.
      expect((e as Error).message).toContain("update @cinatra-ai/a to 1.2.0 explicitly");
      expect((e as Error).message).toContain("retry this install");
    }
  });

  it("a live row scoped to ANOTHER org does not satisfy the install check (scope-aware)", async () => {
    const { deps } = makeDeps(
      {
        [ROOT]: { version: "1.0.0", dependencies: [edge("@cinatra-ai/a")] },
        "@cinatra-ai/a": { version: "1.2.0" },
      },
      [{ packageName: "@cinatra-ai/a", version: "1.2.0", organizationId: "org-OTHER" }],
    );
    const plan = await planDependencyInstall(
      {
        root: { packageName: ROOT, version: "1.0.0" },
        orgId: "org-1",
        closure: [{ name: "@cinatra-ai/a", version: "1.2.0" }],
      },
      deps,
    );
    const a = plan.ordered.find((m) => m.packageName === "@cinatra-ai/a")!;
    expect(a.alreadyInstalled).toBe(false); // org-OTHER's row never bleeds in
  });
});

describe("planDependencyInstall — kinds", () => {
  it("member typeIds derive from each member's OWN kind; kinds map populated for the grant context", async () => {
    const { deps } = makeDeps({
      [ROOT]: { version: "1.0.0", kind: "agent", dependencies: [edge("@cinatra-ai/a")] },
      "@cinatra-ai/a": { version: "1.0.0", kind: "connector" },
    });
    const plan = await planDependencyInstall(
      { root: { packageName: ROOT, version: "1.0.0" }, orgId: null, closure: null },
      deps,
    );
    expect(plan.ordered.find((m) => m.packageName === "@cinatra-ai/a")!.typeId).toBe("connector");
    expect(plan.ordered.find((m) => m.packageName === ROOT)!.typeId).toBe("agent");
    expect(plan.memberKinds.get("@cinatra-ai/a")).toBe("connector");
  });
});

describe("planDependencyInstall — #157 dependency-confusion scope gate", () => {
  it("REFUSES an out-of-scope dependency on the dev path (manifest-walk)", async () => {
    // Root is @cinatra-ai/*; a manifest edge points at an attacker-chosen scope.
    const { deps } = makeDeps({
      [ROOT]: { version: "1.0.0", dependencies: [edge("@evil/dep")] },
      "@evil/dep": { version: "9.9.9" },
    });
    await expect(
      planDependencyInstall(
        { root: { packageName: ROOT, version: "1.0.0" }, orgId: null, closure: null },
        deps,
      ),
    ).rejects.toMatchObject({ code: "DEPENDENCY_SCOPE" });
  });

  it("ALLOWS the root's OWN vendor scope and the first-party base scope", async () => {
    // A non-cinatra vendor root may depend on its own scope AND on @cinatra-ai/*.
    const VENDOR_ROOT = "@acme/root";
    const { deps } = makeDeps({
      [VENDOR_ROOT]: {
        version: "1.0.0",
        dependencies: [edge("@acme/lib"), edge("@cinatra-ai/base")],
      },
      "@acme/lib": { version: "1.0.0" },
      "@cinatra-ai/base": { version: "1.0.0" },
    });
    const plan = await planDependencyInstall(
      { root: { packageName: VENDOR_ROOT, version: "1.0.0" }, orgId: null, closure: null },
      deps,
    );
    // All three resolved (root + own-scope dep + first-party dep); the root is
    // ALWAYS last in the install order, deps precede it.
    expect(new Set(plan.ordered.map((m) => m.packageName))).toEqual(
      new Set(["@acme/lib", "@cinatra-ai/base", VENDOR_ROOT]),
    );
    expect(plan.ordered[plan.ordered.length - 1]!.packageName).toBe(VENDOR_ROOT);
  });

  it("REFUSES a vendor root depending on a DIFFERENT vendor's scope", async () => {
    const VENDOR_ROOT = "@acme/root";
    const { deps } = makeDeps({
      [VENDOR_ROOT]: { version: "1.0.0", dependencies: [edge("@other-vendor/dep")] },
      "@other-vendor/dep": { version: "1.0.0" },
    });
    await expect(
      planDependencyInstall(
        { root: { packageName: VENDOR_ROOT, version: "1.0.0" }, orgId: null, closure: null },
        deps,
      ),
    ).rejects.toMatchObject({ code: "DEPENDENCY_SCOPE" });
  });

  it("gates the LEGACY agentDependencies projection too (out-of-scope edge refused)", async () => {
    // Build a manifest that carries ONLY legacy cinatra.agentDependencies (no
    // canonical cinatra.dependencies) — the dual-read projects it to edges, and
    // the scope gate must still apply.
    const legacyDeps: DependencyPlanDeps = {
      fetchSummary: vi.fn(async (packageName: string): Promise<MemberSummary> => {
        if (packageName === ROOT) {
          return {
            resolvedVersion: "1.0.0",
            kind: "agent",
            manifest: {
              name: ROOT,
              version: "1.0.0",
              cinatra: { kind: "agent", agentDependencies: { "@evil/dep": "1.0.0" } },
            },
          };
        }
        return {
          resolvedVersion: "1.0.0",
          kind: "agent",
          manifest: { name: packageName, version: "1.0.0", cinatra: { kind: "agent" } },
        };
      }),
      parseEdges: (manifest, packageName) =>
        parseManifestDependencyEdges(manifest, { packageName }).edges,
      isAutoInstallableEdge,
      readInstalledRows: async () => [],
    };
    await expect(
      planDependencyInstall(
        { root: { packageName: ROOT, version: "1.0.0" }, orgId: null, closure: null },
        legacyDeps,
      ),
    ).rejects.toMatchObject({ code: "DEPENDENCY_SCOPE" });
  });
});
