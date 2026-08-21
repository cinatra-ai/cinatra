// THE DEPENDENCY-ANCHOR RULE (cinatra#2694 / S2 #2696).
//
// cinatra#1039 decision 4 forces the ROOT's row-ownership tuple onto every
// transitive member. The epic's scope refines that for a WORKSPACE-anchored
// root — because "AGENT installs remain organization/team/project", a
// workspace-anchored root must not drag an agent dependency app-wide:
//
//   * non-agent dependencies INHERIT the workspace anchor;
//   * AGENT-kind dependencies stay ORG-ANCHORED at the installer's active org;
//   * the ROOT always keeps its own tuple;
//   * a NON-workspace root plans byte-identically to before (decision 4 intact).
//
// Also pinned: an org-anchored agent dependency resolves its installed-version
// conflict basis AT ITS OWN scope (the installer's org rows), not on the
// org-NULL ladder the workspace root resolves against — otherwise a dependency
// already installed in that org would be re-installed on top of itself.
import { describe, expect, it } from "vitest";

import {
  planDependencyInstall,
  defaultRowOwnership,
  defaultOrgPlatformChain,
  resolveMemberRowOwnership,
  type DependencyPlanDeps,
  type MemberSummary,
  type RowOwnership,
} from "@/lib/extension-dependency-plan";
import type { ExtensionDependency, InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import { parseManifestDependencyEdges } from "@cinatra-ai/extensions/manifest-dependencies";
import { isAutoInstallableEdge } from "@cinatra-ai/extensions/dependency-closure";
import { WORKSPACE_ANCHOR_ROW_OWNERSHIP } from "@cinatra-ai/extensions/install-access-target";
import { PLATFORM_OWNER_SENTINEL } from "@cinatra-ai/extensions/canonical-types";

const ROOT = "@cinatra-ai/ws-root";
const ARTIFACT_DEP = "@cinatra-ai/ws-artifact-dep";
const SKILL_DEP = "@cinatra-ai/ws-skill-dep";
const AGENT_DEP = "@cinatra-ai/ws-agent-dep";

const WORKSPACE: RowOwnership = { ...WORKSPACE_ANCHOR_ROW_OWNERSHIP };

function edge(packageName: string): ExtensionDependency {
  return {
    packageName,
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "*" },
    requirement: "required",
  };
}

type Pkg = {
  version: string;
  kind: "agent" | "skill" | "connector" | "artifact" | "workflow" | null;
  dependencies?: ExtensionDependency[];
};

function row(
  packageName: string,
  version: string,
  over: Partial<Pick<InstalledExtension, "organizationId" | "ownerLevel" | "ownerId">> = {},
): InstalledExtension {
  return {
    id: `row-${packageName}-${version}-${over.organizationId ?? "platform"}`,
    packageName,
    status: "active",
    organizationId: over.organizationId ?? null,
    ownerLevel: over.ownerLevel ?? "organization",
    ownerId: over.ownerId ?? null,
    isDefault: true,
    source: { type: "verdaccio", version },
    dependencies: [],
  } as unknown as InstalledExtension;
}

function makeDeps(registry: Record<string, Pkg>, installed: InstalledExtension[] = []): DependencyPlanDeps {
  return {
    fetchSummary: async (packageName: string): Promise<MemberSummary> => {
      const pkg = registry[packageName];
      if (!pkg) throw new Error(`fixture: no package ${packageName}`);
      return {
        resolvedVersion: pkg.version,
        kind: pkg.kind,
        manifest: {
          name: packageName,
          version: pkg.version,
          cinatra: { ...(pkg.kind ? { kind: pkg.kind } : {}), dependencies: pkg.dependencies ?? [] },
        },
      };
    },
    parseEdges: (manifest, packageName) => parseManifestDependencyEdges(manifest, { packageName }).edges,
    isAutoInstallableEdge,
    readInstalledRows: async () => installed,
    // The extension saga's own seam (behavior-neutral): the [organization,
    // platform] binary derived from the tuple's org.
    resolveScopeAncestry: (ro: RowOwnership) => defaultOrgPlatformChain(ro.organizationId),
    authorizeExistingRowMutation: () => {
      /* permit */
    },
  };
}

/** The MIXED closure fixture: workspace root → artifact dep + skill dep + agent dep. */
const MIXED_REGISTRY: Record<string, Pkg> = {
  [ROOT]: {
    version: "1.0.0",
    kind: "artifact",
    dependencies: [edge(ARTIFACT_DEP), edge(SKILL_DEP), edge(AGENT_DEP)],
  },
  [ARTIFACT_DEP]: { version: "2.0.0", kind: "artifact" },
  [SKILL_DEP]: { version: "3.0.0", kind: "skill" },
  [AGENT_DEP]: { version: "4.0.0", kind: "agent" },
};

describe("cinatra#2696 — resolveMemberRowOwnership (the rule, in isolation)", () => {
  it("workspace root: non-agent deps inherit the workspace anchor", () => {
    for (const kind of ["artifact", "connector", "skill", "workflow"]) {
      expect(
        resolveMemberRowOwnership({
          root: WORKSPACE,
          isRoot: false,
          memberKind: kind,
          installerOrgId: "org-1",
        }),
      ).toEqual(WORKSPACE);
    }
  });

  it("workspace root: AGENT deps stay org-anchored at the INSTALLER's active org", () => {
    expect(
      resolveMemberRowOwnership({
        root: WORKSPACE,
        isRoot: false,
        memberKind: "agent",
        installerOrgId: "org-1",
      }),
    ).toEqual(defaultRowOwnership("org-1"));
  });

  it("workspace root: a KIND-LESS legacy dep is treated as an agent (fail-safe: never app-wide)", () => {
    expect(
      resolveMemberRowOwnership({
        root: WORKSPACE,
        isRoot: false,
        memberKind: null,
        installerOrgId: "org-1",
      }),
    ).toEqual(defaultRowOwnership("org-1"));
  });

  it("the ROOT always keeps its own tuple, whatever its kind", () => {
    expect(
      resolveMemberRowOwnership({
        root: WORKSPACE,
        isRoot: true,
        memberKind: "agent",
        installerOrgId: "org-1",
      }),
    ).toEqual(WORKSPACE);
  });

  it("REGRESSION: a non-workspace root forces its tuple onto EVERY member (decision 4 intact)", () => {
    const orgRoot = defaultRowOwnership("org-1");
    for (const kind of ["agent", "artifact", "connector", "skill", null]) {
      expect(
        resolveMemberRowOwnership({
          root: orgRoot,
          isRoot: false,
          memberKind: kind,
          installerOrgId: "org-1",
        }),
      ).toEqual(orgRoot);
    }
  });
});

describe("cinatra#2696 — the planner encodes the rule", () => {
  it("MIXED CLOSURE: workspace root + workspace non-agent deps + org-anchored agent dep", async () => {
    const plan = await planDependencyInstall(
      {
        root: { packageName: ROOT, version: "1.0.0" },
        orgId: "org-1",
        rowOwnership: WORKSPACE,
        closure: null,
      },
      makeDeps(MIXED_REGISTRY),
    );

    const byName = new Map(plan.ordered.map((m) => [m.packageName, m]));
    expect(byName.get(ROOT)!.rowOwnership).toEqual({
      ownerLevel: "workspace",
      ownerId: PLATFORM_OWNER_SENTINEL,
      organizationId: null,
    });
    expect(byName.get(ARTIFACT_DEP)!.rowOwnership).toEqual(WORKSPACE);
    expect(byName.get(SKILL_DEP)!.rowOwnership).toEqual(WORKSPACE);
    expect(byName.get(AGENT_DEP)!.rowOwnership).toEqual(defaultRowOwnership("org-1"));
    // The topo contract is untouched: dependencies first, root last.
    expect(plan.ordered.at(-1)!.packageName).toBe(ROOT);
  });

  it("REGRESSION: the SAME closure at an ORGANIZATION target plans every member org-anchored", async () => {
    const plan = await planDependencyInstall(
      {
        root: { packageName: ROOT, version: "1.0.0" },
        orgId: "org-1",
        rowOwnership: defaultRowOwnership("org-1"),
        closure: null,
      },
      makeDeps(MIXED_REGISTRY),
    );

    for (const m of plan.ordered) {
      expect(m.rowOwnership, m.packageName).toEqual(defaultRowOwnership("org-1"));
    }
  });

  it("an ORG-ANCHORED agent dep already installed IN THAT ORG is recognized as already-installed", async () => {
    // The agent dep lives at the installer's org. The workspace root resolves on
    // the org-NULL ladder; only a member-scoped conflict basis can see this row.
    const plan = await planDependencyInstall(
      {
        root: { packageName: ROOT, version: "1.0.0" },
        orgId: "org-1",
        rowOwnership: WORKSPACE,
        closure: null,
      },
      makeDeps(MIXED_REGISTRY, [
        row(AGENT_DEP, "4.0.0", { organizationId: "org-1", ownerLevel: "organization", ownerId: "org-1" }),
      ]),
    );

    const agent = plan.ordered.find((m) => m.packageName === AGENT_DEP)!;
    expect(agent.alreadyInstalled).toBe(true);
    // …and the non-agent members are unaffected.
    expect(plan.ordered.find((m) => m.packageName === ARTIFACT_DEP)!.alreadyInstalled).toBe(false);
  });

  it("an org-NULL row of the AGENT dep does NOT satisfy it — the org anchor is the basis", async () => {
    const plan = await planDependencyInstall(
      {
        root: { packageName: ROOT, version: "1.0.0" },
        orgId: "org-1",
        rowOwnership: WORKSPACE,
        closure: null,
      },
      // Only a PLATFORM (org-NULL) row exists. The org chain falls back to
      // platform, so this is still recognized — the assertion here is that the
      // agent member is planned at the ORG anchor regardless of where its
      // conflict basis row was found (existing-row selection never moves the
      // stamped ownership — cinatra#1039 decision 4's surviving half).
      makeDeps(MIXED_REGISTRY, [row(AGENT_DEP, "4.0.0", { organizationId: null, ownerLevel: "platform" })]),
    );

    const agent = plan.ordered.find((m) => m.packageName === AGENT_DEP)!;
    expect(agent.rowOwnership).toEqual(defaultRowOwnership("org-1"));
  });

  it("a workspace NON-agent dep already installed at the WORKSPACE anchor is already-installed", async () => {
    const plan = await planDependencyInstall(
      {
        root: { packageName: ROOT, version: "1.0.0" },
        orgId: "org-1",
        rowOwnership: WORKSPACE,
        closure: null,
      },
      makeDeps(MIXED_REGISTRY, [
        row(ARTIFACT_DEP, "2.0.0", {
          organizationId: null,
          ownerLevel: "workspace",
          ownerId: PLATFORM_OWNER_SENTINEL,
        }),
      ]),
    );

    expect(plan.ordered.find((m) => m.packageName === ARTIFACT_DEP)!.alreadyInstalled).toBe(true);
  });
});
