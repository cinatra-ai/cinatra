// cinatra#1039 Phase 1 — the ROW-OWNERSHIP tuple SEAT (behavior-neutral enabler).
//
// Proves the four ratified decisions land under test BEFORE any agent-path
// traffic (Phase 2) hits them:
//   1. Semantic parity — the extension-saga seams (derived-default rowOwnership +
//      the [organization, platform] ancestry resolver + a permissive row-mutation
//      authorizer) produce a plan SEMANTICALLY IDENTICAL to the pre-#1039
//      fallback, modulo the new rowOwnership field asserted to equal the default.
//   2. Ladder-aware conflict basis via the INJECTED scope-ancestry resolver seam
//      (never a naive tuple walk): a team-level resolver binds the conflict basis
//      to the team row, ignoring a newer org-scoped row the org-binary would trip
//      over — proving the seam is load-bearing.
//   3. Cross-scope dedupe re-authorization (fail-closed): a dedupe-upward that
//      MUTATES an existing shared row re-authorizes the EXISTING ROW's scope;
//      deny → the evidence-carrying INSTALLED_VERSION_CONFLICT refusal.
//   4. Root-tuple IMMUTABLE inheritance: every transitive member carries the
//      ROOT's tuple; existing-row selection (even a platform-scoped basis row)
//      never overrides the member's stamped ownership.
import { describe, expect, it, vi } from "vitest";

import {
  planDependencyInstall,
  defaultRowOwnership,
  defaultOrgPlatformChain,
  DependencyPlanError,
  type DependencyPlanDeps,
  type MemberSummary,
  type PlannedMember,
  type RowOwnership,
  type ResolvedScopeLevel,
} from "@/lib/extension-dependency-plan";
import type { ExtensionDependency, InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import { parseManifestDependencyEdges } from "@cinatra-ai/extensions/manifest-dependencies";
import { isAutoInstallableEdge } from "@cinatra-ai/extensions/dependency-closure";

const ROOT = "@cinatra-ai/root";
const DEP = "@cinatra-ai/shared-dep";
const MID = "@cinatra-ai/mid";

function edge(packageName: string, over: Partial<ExtensionDependency> = {}): ExtensionDependency {
  return {
    packageName,
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "*" },
    requirement: "required",
    ...over,
  };
}

type Pkg = { version: string; dependencies?: ExtensionDependency[] };

/** A live canonical row with a real (organizationId, ownerLevel, ownerId) tuple. */
function row(
  packageName: string,
  version: string,
  over: Partial<
    Pick<InstalledExtension, "organizationId" | "ownerLevel" | "ownerId" | "isDefault" | "dependencies">
  > = {},
): InstalledExtension {
  return {
    id: `row-${packageName}-${version}-${over.ownerLevel ?? "org"}-${over.ownerId ?? "x"}`,
    packageName,
    status: "active",
    organizationId: over.organizationId ?? null,
    ownerLevel: over.ownerLevel ?? "organization",
    ownerId: over.ownerId ?? null,
    isDefault: over.isDefault ?? true,
    source: { type: "verdaccio", version },
    dependencies: over.dependencies ?? [],
  } as unknown as InstalledExtension;
}

function makeDeps(
  registry: Record<string, Pkg>,
  installed: InstalledExtension[],
  seams: Partial<
    Pick<DependencyPlanDeps, "resolveScopeAncestry" | "authorizeExistingRowMutation">
  > = {},
): DependencyPlanDeps {
  return {
    fetchSummary: async (packageName: string): Promise<MemberSummary> => {
      const pkg = registry[packageName];
      if (!pkg) throw new Error(`fixture: no package ${packageName}`);
      return {
        resolvedVersion: pkg.version,
        kind: "connector",
        manifest: {
          name: packageName,
          version: pkg.version,
          cinatra: { kind: "connector", dependencies: pkg.dependencies ?? [] },
        },
      };
    },
    parseEdges: (manifest, packageName) => parseManifestDependencyEdges(manifest, { packageName }).edges,
    isAutoInstallableEdge,
    readInstalledRows: async () => installed,
    ...seams,
  };
}

/** The extension-saga's explicit seam set (behavior-neutral defaults). */
function extensionSagaSeams(): Pick<
  DependencyPlanDeps,
  "resolveScopeAncestry" | "authorizeExistingRowMutation"
> {
  return {
    resolveScopeAncestry: (ro: RowOwnership) => defaultOrgPlatformChain(ro.organizationId),
    authorizeExistingRowMutation: () => {
      /* permit */
    },
  };
}

/** Compare-serialize a member EXCLUDING edges (function-free structural view). */
function serialize(m: PlannedMember) {
  return {
    packageName: m.packageName,
    version: m.version,
    typeId: m.typeId,
    action: m.action,
    alreadyInstalled: m.alreadyInstalled,
    rowOwnership: m.rowOwnership,
  };
}

// A clean dedupe-upward scenario: root needs DEP@^0.2.3; DEP@0.2.1 is installed
// (older), every live dependent admits it, DEP@0.2.3 is self-satisfiable → the
// dev/non-gatekept path emits an action:"update" (committed dedupe-upward).
const DEDUPE_REGISTRY: Record<string, Pkg> = {
  [ROOT]: {
    version: "1.0.0",
    dependencies: [edge(DEP, { versionConstraint: { kind: "semver-range", range: "^0.2.3" } })],
  },
  [DEP]: { version: "0.2.3" },
};
const dedupeInstalled = (orgId: string | null) => [
  row(DEP, "0.2.1", { organizationId: orgId }),
  row("@cinatra-ai/consumer", "1.0.0", {
    organizationId: orgId,
    dependencies: [edge(DEP, { versionConstraint: { kind: "semver-range", range: "^0.2.0" } })],
  }),
];

describe("cinatra#1039 Phase 1 — decision 1: semantic parity (extension-saga seams == fallback)", () => {
  it("an org install with the explicit seams plans IDENTICALLY to the pre-#1039 fallback", async () => {
    const orgId = "org-x";
    const installed = dedupeInstalled(orgId);
    const rowOwnership = defaultRowOwnership(orgId);

    const withSeams = await planDependencyInstall(
      { root: { packageName: ROOT, version: "1.0.0" }, orgId, closure: null, rowOwnership },
      makeDeps(DEDUPE_REGISTRY, installed, extensionSagaSeams()),
    );
    const fallback = await planDependencyInstall(
      // No rowOwnership, no seams — the planner derives the default + org-binary.
      { root: { packageName: ROOT, version: "1.0.0" }, orgId, closure: null },
      makeDeps(DEDUPE_REGISTRY, installed),
    );

    // Same ordered plan, member-for-member (structural, edges excluded).
    expect(withSeams.ordered.map(serialize)).toEqual(fallback.ordered.map(serialize));
    // The dedupe-upward executed on both paths.
    expect(withSeams.ordered.find((m) => m.packageName === DEP)?.action).toBe("update");
    // Every member carries the derived-default tuple (asserted equal, not excluded).
    for (const m of withSeams.ordered) {
      expect(m.rowOwnership).toEqual({
        ownerLevel: "organization",
        ownerId: orgId,
        organizationId: orgId,
      });
    }
  });

  it("a platform install (orgId null) derives the platform tuple; seams == fallback", async () => {
    const installed = dedupeInstalled(null);
    const withSeams = await planDependencyInstall(
      {
        root: { packageName: ROOT, version: "1.0.0" },
        orgId: null,
        closure: null,
        rowOwnership: defaultRowOwnership(null),
      },
      makeDeps(DEDUPE_REGISTRY, installed, extensionSagaSeams()),
    );
    const fallback = await planDependencyInstall(
      { root: { packageName: ROOT, version: "1.0.0" }, orgId: null, closure: null },
      makeDeps(DEDUPE_REGISTRY, installed),
    );
    expect(withSeams.ordered.map(serialize)).toEqual(fallback.ordered.map(serialize));
    for (const m of withSeams.ordered) {
      expect(m.rowOwnership).toEqual({ ownerLevel: "platform", ownerId: null, organizationId: null });
    }
  });
});

describe("cinatra#1039 Phase 1 — decision 4: root-tuple IMMUTABLE inheritance", () => {
  it("every transitive member carries the ROOT's tuple, never a dep manifest's own", async () => {
    const orgId = "org-x";
    const rowOwnership = defaultRowOwnership(orgId);
    // root -> mid -> dep (a 3-level fresh install, nothing installed).
    const registry: Record<string, Pkg> = {
      [ROOT]: { version: "1.0.0", dependencies: [edge(MID)] },
      [MID]: { version: "1.0.0", dependencies: [edge(DEP)] },
      [DEP]: { version: "0.2.3" },
    };
    const plan = await planDependencyInstall(
      { root: { packageName: ROOT, version: "1.0.0" }, orgId, closure: null, rowOwnership },
      makeDeps(registry, [], extensionSagaSeams()),
    );
    expect(plan.ordered.length).toBe(3);
    for (const m of plan.ordered) {
      expect(m.rowOwnership).toEqual(rowOwnership);
    }
  });

  it("existing-row selection never overrides the stamp: a PLATFORM basis row still stamps the org tuple", async () => {
    const orgId = "org-x";
    const rowOwnership = defaultRowOwnership(orgId);
    // DEP@0.2.1 exists ONLY at PLATFORM scope (org falls back to it). The org
    // install dedupes it upward — but the emitted member is stamped with the
    // ROOT's ORG tuple, NOT the platform basis row's ownership.
    const installed = [
      row(DEP, "0.2.1", { organizationId: null, ownerLevel: "platform" }),
    ];
    const plan = await planDependencyInstall(
      { root: { packageName: ROOT, version: "1.0.0" }, orgId, closure: null, rowOwnership },
      makeDeps(DEDUPE_REGISTRY, installed, extensionSagaSeams()),
    );
    const depMember = plan.ordered.find((m) => m.packageName === DEP)!;
    expect(depMember.action).toBe("update"); // dedupe-upward of the platform basis row
    expect(depMember.rowOwnership).toEqual({
      ownerLevel: "organization",
      ownerId: orgId,
      organizationId: orgId,
    });
  });
});

describe("cinatra#1039 Phase 1 — decision 3: cross-scope dedupe RE-AUTHORIZATION (fail-closed)", () => {
  const orgId = "org-x";
  const rowOwnership = defaultRowOwnership(orgId);

  it("authorizer PERMITS → the dedupe-upward emits action:'update' and is called with the EXISTING row", async () => {
    const authorizeExistingRowMutation = vi.fn((_row: InstalledExtension) => {
      /* permit */
    });
    const plan = await planDependencyInstall(
      { root: { packageName: ROOT, version: "1.0.0" }, orgId, closure: null, rowOwnership },
      makeDeps(DEDUPE_REGISTRY, dedupeInstalled(orgId), {
        resolveScopeAncestry: (ro) => defaultOrgPlatformChain(ro.organizationId),
        authorizeExistingRowMutation,
      }),
    );
    expect(plan.ordered.find((m) => m.packageName === DEP)?.action).toBe("update");
    // Re-authorized against the EXISTING row (the installed 0.2.1), not the pin.
    expect(authorizeExistingRowMutation).toHaveBeenCalledTimes(1);
    const arg = authorizeExistingRowMutation.mock.calls[0]![0] as InstalledExtension;
    expect(arg.packageName).toBe(DEP);
    expect((arg.source as { version: string }).version).toBe("0.2.1");
  });

  it("authorizer DENIES (throws) → the evidence-carrying INSTALLED_VERSION_CONFLICT refusal", async () => {
    const deny = () => {
      throw new Error("forbidden");
    };
    await expect(
      planDependencyInstall(
        { root: { packageName: ROOT, version: "1.0.0" }, orgId, closure: null, rowOwnership },
        makeDeps(DEDUPE_REGISTRY, dedupeInstalled(orgId), {
          resolveScopeAncestry: (ro) => defaultOrgPlatformChain(ro.organizationId),
          authorizeExistingRowMutation: deny,
        }),
      ),
    ).rejects.toMatchObject({
      name: "DependencyPlanError",
      code: "INSTALLED_VERSION_CONFLICT",
      message: expect.stringContaining("not authorized to modify"),
    });
  });

  it("a DependencyPlanError thrown by the authorizer PROPAGATES unchanged (planner-domain error)", async () => {
    const domainError = new DependencyPlanError("DEPENDENCY_SCOPE", "planner-domain failure");
    await expect(
      planDependencyInstall(
        { root: { packageName: ROOT, version: "1.0.0" }, orgId, closure: null, rowOwnership },
        makeDeps(DEDUPE_REGISTRY, dedupeInstalled(orgId), {
          resolveScopeAncestry: (ro) => defaultOrgPlatformChain(ro.organizationId),
          authorizeExistingRowMutation: () => {
            throw domainError;
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "DEPENDENCY_SCOPE", message: "planner-domain failure" });
  });

  it("NO authorizer injected → permits (pre-#1039 back-compat) — the dedupe-upward still emits update", async () => {
    const plan = await planDependencyInstall(
      { root: { packageName: ROOT, version: "1.0.0" }, orgId, closure: null, rowOwnership },
      // resolveScopeAncestry present, authorizeExistingRowMutation ABSENT.
      makeDeps(DEDUPE_REGISTRY, dedupeInstalled(orgId), {
        resolveScopeAncestry: (ro) => defaultOrgPlatformChain(ro.organizationId),
      }),
    );
    expect(plan.ordered.find((m) => m.packageName === DEP)?.action).toBe("update");
  });

  it("the denied dedupe names the existing row's OWNERSHIP scope in the refusal", async () => {
    // A platform-scoped basis row denied at re-auth → the refusal names it.
    const installed = [row(DEP, "0.2.1", { organizationId: null, ownerLevel: "platform" })];
    await expect(
      planDependencyInstall(
        { root: { packageName: ROOT, version: "1.0.0" }, orgId, closure: null, rowOwnership },
        makeDeps(DEDUPE_REGISTRY, installed, {
          resolveScopeAncestry: (ro) => defaultOrgPlatformChain(ro.organizationId),
          authorizeExistingRowMutation: () => {
            throw new Error("forbidden");
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "INSTALLED_VERSION_CONFLICT",
      message: expect.stringContaining("owner-level platform"),
    });
  });
});

describe("cinatra#1039 Phase 1 — decision 2: INJECTED ancestry resolver drives the basis (never a tuple walk)", () => {
  const orgId = "org-x";
  // TWO live DEP rows in the SAME org: a TEAM-owned older row and an ORG-owned
  // NEWER row. The tuple alone cannot distinguish them — only the injected
  // resolver's chain does.
  const installed = [
    row(DEP, "0.2.1", { organizationId: orgId, ownerLevel: "team", ownerId: "team-1", isDefault: true }),
    row(DEP, "0.5.0", { organizationId: orgId, ownerLevel: "organization", ownerId: null, isDefault: true }),
  ];
  // A team-level chain: team-1 rows first, then org, then platform.
  const teamChain: ResolvedScopeLevel[] = [
    {
      label: "team:team-1",
      organizationId: orgId,
      matches: (r) => r.ownerLevel === "team" && r.ownerId === "team-1" && r.organizationId === orgId,
    },
    {
      label: `organization:${orgId}`,
      organizationId: orgId,
      matches: (r) => r.ownerLevel === "organization" && r.organizationId === orgId,
    },
    { label: "platform", organizationId: null, matches: (r) => (r.organizationId ?? null) === null },
  ];

  it("a TEAM-level resolver binds the conflict basis to the TEAM row → dedupe-upward, ignoring the newer org row", async () => {
    const rowOwnership: RowOwnership = { ownerLevel: "team", ownerId: "team-1", organizationId: orgId };
    const plan = await planDependencyInstall(
      { root: { packageName: ROOT, version: "1.0.0" }, orgId, closure: null, rowOwnership },
      makeDeps(DEDUPE_REGISTRY, installed, {
        resolveScopeAncestry: () => teamChain,
        authorizeExistingRowMutation: () => {
          /* permit */
        },
      }),
    );
    // Basis = the team row 0.2.1 (older) → clean dedupe-upward to 0.2.3.
    expect(plan.ordered.find((m) => m.packageName === DEP)?.action).toBe("update");
    expect(plan.ordered.find((m) => m.packageName === DEP)?.version).toBe("0.2.3");
  });

  it("the org-binary FALLBACK (no injected resolver) does NOT resolve the team basis — it trips the cross-owner ambiguity", async () => {
    // Same two rows, but NO resolver → the org-binary sees BOTH as org-x rows,
    // two defaults, no single basis → fail-closed MEMBER_UNRESOLVABLE. This is
    // exactly the "naive tuple walk splits semantics" the seam prevents.
    await expect(
      planDependencyInstall(
        { root: { packageName: ROOT, version: "1.0.0" }, orgId, closure: null },
        makeDeps(DEDUPE_REGISTRY, installed),
      ),
    ).rejects.toMatchObject({ code: "MEMBER_UNRESOLVABLE" });
  });
});
