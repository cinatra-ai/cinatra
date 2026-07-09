// cinatra#1039 — dedupe-upward CONFLICT CLASSIFICATION (install-time). The
// analysis half: given a member already installed at a version different from
// the required pin, classify it as a clean upward-dedupe opportunity, a
// disjoint refusal (naming the blocking dependents + ranges — outcome 5), a
// not-self-satisfiable case, or an out-of-scope newer/downgrade — and prove the
// planner's INSTALLED_VERSION_CONFLICT refusal now CARRIES that evidence.
//
// Auto-EXECUTING the upgrade (an `action:"update"` batch member) is a separate,
// spec-deviation-gated step (durable prior-state compensation); this file
// covers the non-deviating analysis + enriched refusal only.
import { describe, expect, it, vi } from "vitest";

import {
  planDependencyInstall,
  classifyInstalledVersionConflict,
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

/** A live (active, verdaccio-sourced) canonical row with declared dependents. */
function row(
  packageName: string,
  version: string,
  dependencies: ExtensionDependency[] = [],
  organizationId: string | null = null,
): InstalledExtension {
  return {
    id: `row-${packageName}`,
    packageName,
    status: "active",
    organizationId,
    source: { type: "verdaccio", version },
    dependencies,
  } as unknown as InstalledExtension;
}

const D = "@cinatra-ai/shared-dep";

describe("classifyInstalledVersionConflict — dedupe-upward eligibility (#1039)", () => {
  it("installed NEWER than the pin → installed-newer (downgrade/side-by-side, out of scope)", () => {
    const c = classifyInstalledVersionConflict({
      packageName: D,
      installedVersion: "0.3.0",
      pin: "0.2.3",
      newEdges: [],
      installedRows: [row(D, "0.3.0")],
      orgId: null,
      isAutoInstallableEdge,
    });
    expect(c).toEqual({ kind: "installed-newer" });
  });

  it("installed OLDER, every dependent admits the pin, no new deps → upgradable-clean", () => {
    const c = classifyInstalledVersionConflict({
      packageName: D,
      installedVersion: "0.2.1",
      pin: "0.2.3",
      newEdges: [],
      installedRows: [
        row(D, "0.2.1"),
        // A live dependent whose required edge admits ^0.2.0 (so 0.2.3 is fine).
        row("@cinatra-ai/consumer", "1.0.0", [
          edge(D, { versionConstraint: { kind: "semver-range", range: "^0.2.0" } }),
        ]),
      ],
      orgId: null,
      isAutoInstallableEdge,
    });
    expect(c).toEqual({ kind: "upgradable-clean" });
  });

  it("installed OLDER but a dependent pins OUTSIDE the pin → disjoint-dependents naming it (outcome 5)", () => {
    const c = classifyInstalledVersionConflict({
      packageName: D,
      installedVersion: "0.2.1",
      pin: "0.3.0",
      newEdges: [],
      installedRows: [
        row(D, "0.2.1"),
        // This dependent's edge admits only ~0.2.x — 0.3.0 would break it.
        row("@cinatra-ai/pinned-consumer", "1.0.0", [
          edge(D, { versionConstraint: { kind: "semver-range", range: "~0.2.0" } }),
        ]),
      ],
      orgId: null,
      isAutoInstallableEdge,
    });
    expect(c.kind).toBe("disjoint-dependents");
    if (c.kind === "disjoint-dependents") {
      expect(c.dependents).toContain("@cinatra-ai/pinned-consumer");
      // The evidence carries the dependent + its violated constraint.
      expect(c.detail).toContain("@cinatra-ai/pinned-consumer");
      expect(c.detail).toContain("0.2.0");
    }
  });

  it("multiple disjoint dependents are ALL named", () => {
    const c = classifyInstalledVersionConflict({
      packageName: D,
      installedVersion: "0.2.1",
      pin: "0.3.0",
      newEdges: [],
      installedRows: [
        row(D, "0.2.1"),
        row("@cinatra-ai/consumer-a", "1.0.0", [
          edge(D, { versionConstraint: { kind: "exact", version: "0.2.1" } }),
        ]),
        row("@cinatra-ai/consumer-b", "1.0.0", [
          edge(D, { versionConstraint: { kind: "semver-range", range: "0.2.x" } }),
        ]),
      ],
      orgId: null,
      isAutoInstallableEdge,
    });
    expect(c.kind).toBe("disjoint-dependents");
    if (c.kind === "disjoint-dependents") {
      expect(c.dependents).toEqual(
        expect.arrayContaining(["@cinatra-ai/consumer-a", "@cinatra-ai/consumer-b"]),
      );
    }
  });

  it("installed OLDER, dependents admit, but the NEW version needs an UNINSTALLED dep → upgradable-needs-own-deps", () => {
    const c = classifyInstalledVersionConflict({
      packageName: D,
      installedVersion: "0.2.1",
      pin: "0.2.3",
      // 0.2.3 of D newly requires a dep that is not installed.
      newEdges: [edge("@cinatra-ai/new-transitive")],
      installedRows: [row(D, "0.2.1")],
      orgId: null,
      isAutoInstallableEdge,
    });
    expect(c).toEqual({ kind: "upgradable-needs-own-deps", unmetDeps: ["@cinatra-ai/new-transitive"] });
  });

  it("NEW version's required dep is installed but at a VIOLATING version → upgradable-needs-own-deps", () => {
    const c = classifyInstalledVersionConflict({
      packageName: D,
      installedVersion: "0.2.1",
      pin: "0.2.3",
      newEdges: [
        edge("@cinatra-ai/transitive", {
          versionConstraint: { kind: "semver-range", range: "^2.0.0" },
        }),
      ],
      installedRows: [
        row(D, "0.2.1"),
        row("@cinatra-ai/transitive", "1.5.0"), // present but does NOT satisfy ^2.0.0
      ],
      orgId: null,
      isAutoInstallableEdge,
    });
    expect(c).toEqual({ kind: "upgradable-needs-own-deps", unmetDeps: ["@cinatra-ai/transitive"] });
  });

  it("NEW version's required dep is installed AND satisfying → upgradable-clean", () => {
    const c = classifyInstalledVersionConflict({
      packageName: D,
      installedVersion: "0.2.1",
      pin: "0.2.3",
      newEdges: [
        edge("@cinatra-ai/transitive", {
          versionConstraint: { kind: "semver-range", range: "^2.0.0" },
        }),
      ],
      installedRows: [row(D, "0.2.1"), row("@cinatra-ai/transitive", "2.4.0")],
      orgId: null,
      isAutoInstallableEdge,
    });
    expect(c).toEqual({ kind: "upgradable-clean" });
  });

  it("a PEER/OPTIONAL new edge is not a self-satisfiability blocker (only auto-installable edges count)", () => {
    const c = classifyInstalledVersionConflict({
      packageName: D,
      installedVersion: "0.2.1",
      pin: "0.2.3",
      newEdges: [
        edge("@cinatra-ai/peer-only", { edgeType: "peer" }),
        edge("@cinatra-ai/optional-only", { requirement: "optional" }),
      ],
      installedRows: [row(D, "0.2.1")],
      orgId: null,
      isAutoInstallableEdge,
    });
    expect(c).toEqual({ kind: "upgradable-clean" });
  });
});

// The planner-level integration: the same evidence lands in the refusal.
type Pkg = { version: string; kind?: "connector"; dependencies?: ExtensionDependency[] };
function makeDeps(
  registry: Record<string, Pkg>,
  installed: InstalledExtension[],
): DependencyPlanDeps {
  return {
    fetchSummary: vi.fn(async (packageName: string): Promise<MemberSummary> => {
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
    parseEdges: (manifest, packageName) => parseManifestDependencyEdges(manifest, { packageName }).edges,
    isAutoInstallableEdge,
    readInstalledRows: async () => installed,
  };
}

const ROOT = "@cinatra-ai/root";

describe("planDependencyInstall — INSTALLED_VERSION_CONFLICT carries dedupe evidence (#1039)", () => {
  it("disjoint refusal names the blocking dependent + its range (outcome 5)", async () => {
    const deps = makeDeps(
      {
        [ROOT]: { version: "1.0.0", dependencies: [edge(D, { versionConstraint: { kind: "semver-range", range: "^0.3.0" } })] },
        [D]: { version: "0.3.0" },
      },
      [
        row(D, "0.2.1"),
        row("@cinatra-ai/pinned-consumer", "1.0.0", [
          edge(D, { versionConstraint: { kind: "semver-range", range: "~0.2.0" } }),
        ]),
      ],
    );
    await expect(
      planDependencyInstall({ root: { packageName: ROOT, version: "1.0.0" }, orgId: null, closure: null }, deps),
    ).rejects.toMatchObject({ code: "INSTALLED_VERSION_CONFLICT" });
    try {
      await planDependencyInstall({ root: { packageName: ROOT, version: "1.0.0" }, orgId: null, closure: null }, deps);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("already installed at 0.2.1");
      expect(msg).toContain("would break");
      expect(msg).toContain("@cinatra-ai/pinned-consumer");
    }
  });

  it("clean dedupe-upward candidate refusal states it is resolvable by an explicit update", async () => {
    const deps = makeDeps(
      {
        [ROOT]: { version: "1.0.0", dependencies: [edge(D, { versionConstraint: { kind: "semver-range", range: "^0.2.3" } })] },
        [D]: { version: "0.2.3" },
      },
      [
        row(D, "0.2.1"),
        row("@cinatra-ai/consumer", "1.0.0", [
          edge(D, { versionConstraint: { kind: "semver-range", range: "^0.2.0" } }),
        ]),
      ],
    );
    try {
      await planDependencyInstall({ root: { packageName: ROOT, version: "1.0.0" }, orgId: null, closure: null }, deps);
      expect.unreachable("should refuse in the analysis-only foundation");
    } catch (e) {
      expect(e).toBeInstanceOf(DependencyPlanError);
      const msg = (e as Error).message;
      expect(msg).toContain("every installed dependent admits 0.2.3");
      expect(msg).toContain(`extensions_update ${D}@0.2.3`);
    }
  });

  it("org-scoped install conflicting with a PLATFORM row evaluates dependents at the PLATFORM scope (scope-fallback regression)", async () => {
    // The install runs at org "org-1", but D is installed only at the PLATFORM
    // scope (organizationId null). A PLATFORM dependent pins ~0.2.0. The
    // conflict row resolves (org-fallback) to the platform D — so admissibility
    // MUST be checked at platform scope, catching the platform dependent. A
    // naive check at org-1 scope would see no target row and MISS it.
    const deps = makeDeps(
      {
        [ROOT]: {
          version: "1.0.0",
          dependencies: [edge(D, { versionConstraint: { kind: "semver-range", range: "^0.3.0" } })],
        },
        [D]: { version: "0.3.0" },
      },
      [
        row(D, "0.2.1", [], null), // platform-scoped install of D
        row(
          "@cinatra-ai/platform-consumer",
          "1.0.0",
          [edge(D, { versionConstraint: { kind: "semver-range", range: "~0.2.0" } })],
          null, // platform-scoped dependent
        ),
      ],
    );
    try {
      await planDependencyInstall(
        { root: { packageName: ROOT, version: "1.0.0" }, orgId: "org-1", closure: null },
        deps,
      );
      expect.unreachable("should refuse — the platform dependent blocks 0.3.0");
    } catch (e) {
      expect(e).toBeInstanceOf(DependencyPlanError);
      const msg = (e as Error).message;
      // Proves the platform dependent was NOT missed under the org-scoped install.
      expect(msg).toContain("would break");
      expect(msg).toContain("@cinatra-ai/platform-consumer");
    }
  });
});
