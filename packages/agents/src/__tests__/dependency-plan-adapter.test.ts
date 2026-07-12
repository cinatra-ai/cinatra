// cinatra#1039 Phase 2 — the agent-path planner seams + THE PARITY FIXTURE.
//
// The ratified Phase-2 contract: the duplicate registries "prefer-newer"
// resolver may be deleted only against a GREEN agent-plan == saga-plan parity
// fixture. That fixture lives here (first describe): for identical inputs,
// `planDependencyInstall` fed the AGENT seams (real ownership-ladder ancestry
// resolver + real row-mutation re-authorization) produces a plan SEMANTICALLY
// IDENTICAL to the saga seams (org-binary ancestry + permit) on the
// extension-default tuple — proving "no split semantics" rather than
// asserting it.
//
// The remaining describes lock the seams themselves:
//   - decision 2: `resolveAgentScopeAncestry` — the REAL ladder
//     (project→owning-team→org→platform; explicit resolver, never a naive
//     tuple walk; fail-loud on an unresolvable project).
//   - decision 3: `buildAgentRowMutationAuthorizer` — a dedupe-upward that
//     mutates a row owned at a DIFFERENT scope re-authorizes the EXISTING
//     row's exact scope (fail-closed without an actor role bag).
//   - decision 1/4: `agentRowOwnershipFromInstallInput` tuple derivation.

import { describe, expect, it, vi } from "vitest";

import {
  planDependencyInstall,
  defaultOrgPlatformChain,
  type DependencyPlanDeps,
  type MemberSummary,
  type PlannedMember,
  type RowOwnership,
} from "@/lib/extension-dependency-plan";
import type {
  ExtensionDependency,
  InstalledExtension,
} from "@cinatra-ai/extensions/canonical-types";
import { parseManifestDependencyEdges } from "@cinatra-ai/extensions/manifest-dependencies";
import { isAutoInstallableEdge } from "@cinatra-ai/extensions/dependency-closure";

import {
  agentRowOwnershipFromInstallInput,
  buildAgentDependencyPlanDeps,
  buildAgentRowMutationAuthorizer,
  resolveAgentScopeAncestry,
} from "../dependency-plan-adapter";
import type { InstallActorRoleBag } from "../install-target-authz";

const ROOT = "@cinatra-ai/root-agent";
const DEP = "@cinatra-ai/shared-dep-agent";

function edge(packageName: string, range: string): ExtensionDependency {
  return {
    packageName,
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range },
    requirement: "required",
  } as ExtensionDependency;
}

type Pkg = { version: string; dependencies?: ExtensionDependency[] };

function row(
  packageName: string,
  version: string,
  over: Partial<
    Pick<
      InstalledExtension,
      "organizationId" | "ownerLevel" | "ownerId" | "isDefault" | "dependencies"
    >
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

/** Fixture registry → the planner's fetchSummary seam. */
function fixtureFetchSummary(registry: Record<string, Pkg>): DependencyPlanDeps["fetchSummary"] {
  return async (packageName: string): Promise<MemberSummary> => {
    const pkg = registry[packageName];
    if (!pkg) throw new Error(`fixture: no package ${packageName}`);
    return {
      resolvedVersion: pkg.version,
      kind: "agent",
      manifest: {
        name: packageName,
        version: pkg.version,
        cinatra: { kind: "agent", dependencies: pkg.dependencies ?? [] },
      },
    };
  };
}

/** The batch saga's seam set (the extension path's behavior-neutral defaults). */
function sagaDeps(
  registry: Record<string, Pkg>,
  installed: InstalledExtension[],
): DependencyPlanDeps {
  return {
    fetchSummary: fixtureFetchSummary(registry),
    parseEdges: (manifest, packageName) =>
      parseManifestDependencyEdges(manifest, { packageName }).edges,
    isAutoInstallableEdge,
    readInstalledRows: async () => installed,
    resolveScopeAncestry: (ro: RowOwnership) => defaultOrgPlatformChain(ro.organizationId),
    authorizeExistingRowMutation: () => {
      /* permit — extension-path rows are org-uniform */
    },
  };
}

/** The agent path's seam set over the same fixtures. */
function agentDeps(
  registry: Record<string, Pkg>,
  installed: InstalledExtension[],
  rowOwnership: RowOwnership,
  actor: InstallActorRoleBag | null,
): DependencyPlanDeps {
  return buildAgentDependencyPlanDeps({
    config: { registryUrl: "https://r.test", packageScope: "@cinatra-ai", token: "t", uiUrl: null },
    rowOwnership,
    actor,
    fetchSummary: fixtureFetchSummary(registry),
    readInstalledRows: async () => installed,
  });
}

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

// A clean dedupe-upward scenario: root needs DEP@^0.2.3; DEP@0.2.1 installed
// (older); the only live dependent admits the pin; DEP@0.2.3 self-satisfiable.
const DEDUPE_REGISTRY: Record<string, Pkg> = {
  [ROOT]: { version: "1.0.0", dependencies: [edge(DEP, "^0.2.3")] },
  [DEP]: { version: "0.2.3" },
};
const orgUniformRows = (orgId: string) => [
  row(DEP, "0.2.1", { organizationId: orgId, ownerLevel: "organization" }),
  row("@cinatra-ai/consumer", "1.0.0", {
    organizationId: orgId,
    ownerLevel: "organization",
    dependencies: [edge(DEP, "^0.2.0")],
  }),
];

const ORG = "org-x";
const orgActor = (over: Partial<InstallActorRoleBag> = {}): InstallActorRoleBag => ({
  principalId: "user-1",
  organizationId: ORG,
  platformRole: "member",
  orgRole: "org_admin",
  ...over,
});

describe("cinatra#1039 Phase 2 — PARITY FIXTURE: agent-path plan == saga plan", () => {
  it("identical inputs produce SEMANTICALLY IDENTICAL plans through both seam sets (dedupe-upward executes on both)", async () => {
    const rowOwnership: RowOwnership = {
      ownerLevel: "organization",
      ownerId: ORG,
      organizationId: ORG,
    };
    const input = {
      root: { packageName: ROOT, version: "1.0.0" },
      orgId: ORG,
      closure: null,
      rowOwnership,
    };
    const viaAgent = await planDependencyInstall(
      input,
      agentDeps(DEDUPE_REGISTRY, orgUniformRows(ORG), rowOwnership, orgActor()),
    );
    const viaSaga = await planDependencyInstall(
      input,
      sagaDeps(DEDUPE_REGISTRY, orgUniformRows(ORG)),
    );

    expect(viaAgent.ordered.map(serialize)).toEqual(viaSaga.ordered.map(serialize));
    expect(viaAgent.root).toEqual(viaSaga.root);
    expect([...viaAgent.memberKinds.entries()]).toEqual([...viaSaga.memberKinds.entries()]);
    // The dedupe-upward executed identically on both paths.
    expect(viaAgent.ordered.find((m) => m.packageName === DEP)?.action).toBe("update");
  });

  it("fresh 2-level tree: identical ordered plans + root-last invariant on both paths", async () => {
    const registry: Record<string, Pkg> = {
      [ROOT]: { version: "1.0.0", dependencies: [edge(DEP, "*")] },
      [DEP]: { version: "0.2.3" },
    };
    const rowOwnership: RowOwnership = {
      ownerLevel: "organization",
      ownerId: ORG,
      organizationId: ORG,
    };
    const input = {
      root: { packageName: ROOT, version: "1.0.0" },
      orgId: ORG,
      closure: null,
      rowOwnership,
    };
    const viaAgent = await planDependencyInstall(
      input,
      agentDeps(registry, [], rowOwnership, orgActor()),
    );
    const viaSaga = await planDependencyInstall(input, sagaDeps(registry, []));
    expect(viaAgent.ordered.map(serialize)).toEqual(viaSaga.ordered.map(serialize));
    expect(viaAgent.ordered.map((m) => m.packageName)).toEqual([DEP, ROOT]);
  });
});

describe("cinatra#1039 decision 2 — resolveAgentScopeAncestry (the REAL ladder)", () => {
  it("org tuple → [organization, platform]; team tuple → [team, organization, platform]", async () => {
    const org = await resolveAgentScopeAncestry({
      ownerLevel: "organization",
      ownerId: ORG,
      organizationId: ORG,
    });
    expect(org.map((l) => l.label)).toEqual([`organization:${ORG}`, "platform"]);

    const team = await resolveAgentScopeAncestry({
      ownerLevel: "team",
      ownerId: "team-1",
      organizationId: ORG,
    });
    expect(team.map((l) => l.label)).toEqual(["team:team-1", `organization:${ORG}`, "platform"]);
  });

  it("project tuple walks project→owning-team→org→platform via the injected project reader", async () => {
    const readProject = vi.fn(async () => ({
      organizationId: ORG,
      ownerLevel: "team",
      ownerId: "team-9",
    }));
    const chain = await resolveAgentScopeAncestry(
      { ownerLevel: "project", ownerId: "proj-1", organizationId: ORG },
      { readProject },
    );
    expect(chain.map((l) => l.label)).toEqual([
      "project:proj-1",
      "team:team-9",
      `organization:${ORG}`,
      "platform",
    ]);
    expect(readProject).toHaveBeenCalledWith("proj-1");
  });

  it("a USER-owned project has no team level in the chain", async () => {
    const chain = await resolveAgentScopeAncestry(
      { ownerLevel: "project", ownerId: "proj-1", organizationId: ORG },
      { readProject: async () => ({ organizationId: ORG, ownerLevel: "user", ownerId: "user-7" }) },
    );
    expect(chain.map((l) => l.label)).toEqual(["project:proj-1", `organization:${ORG}`, "platform"]);
  });

  it("an unresolvable project FAILS LOUD (never a half-resolved ladder)", async () => {
    await expect(
      resolveAgentScopeAncestry(
        { ownerLevel: "project", ownerId: "proj-missing", organizationId: ORG },
        { readProject: async () => null },
      ),
    ).rejects.toThrow(/proj-missing not found/);
  });

  it("levels match rows OWNED at that scope — a team row and an org row in the same org never collapse", async () => {
    const [teamLevel, orgLevel] = await resolveAgentScopeAncestry({
      ownerLevel: "team",
      ownerId: "team-1",
      organizationId: ORG,
    });
    const teamRow = row(DEP, "0.2.1", { organizationId: ORG, ownerLevel: "team", ownerId: "team-1" });
    const otherTeamRow = row(DEP, "0.2.1", {
      organizationId: ORG,
      ownerLevel: "team",
      ownerId: "team-2",
    });
    const orgRow = row(DEP, "0.5.0", { organizationId: ORG, ownerLevel: "organization" });
    expect(teamLevel!.matches(teamRow)).toBe(true);
    expect(teamLevel!.matches(otherTeamRow)).toBe(false);
    expect(teamLevel!.matches(orgRow)).toBe(false);
    expect(orgLevel!.matches(orgRow)).toBe(true);
    expect(orgLevel!.matches(teamRow)).toBe(false);
  });

  it("plan-level: a TEAM tuple binds the conflict basis to the TEAM row, ignoring a newer org-owned row", async () => {
    const rowOwnership: RowOwnership = { ownerLevel: "team", ownerId: "team-1", organizationId: ORG };
    const installed = [
      row(DEP, "0.2.1", { organizationId: ORG, ownerLevel: "team", ownerId: "team-1" }),
      row(DEP, "0.5.0", { organizationId: ORG, ownerLevel: "organization" }),
    ];
    const plan = await planDependencyInstall(
      { root: { packageName: ROOT, version: "1.0.0" }, orgId: ORG, closure: null, rowOwnership },
      agentDeps(DEDUPE_REGISTRY, installed, rowOwnership, null),
    );
    // Basis = the team row (0.2.1, same scope as the root tuple → dedupe
    // permitted via the same-scope fast path even with no actor bag).
    const dep = plan.ordered.find((m) => m.packageName === DEP)!;
    expect(dep.action).toBe("update");
    expect(dep.version).toBe("0.2.3");
    expect(dep.rowOwnership).toEqual(rowOwnership);
  });
});

describe("cinatra#1039 decision 3 — cross-scope dedupe re-authorization (fail-closed)", () => {
  const teamTuple: RowOwnership = { ownerLevel: "team", ownerId: "team-1", organizationId: ORG };

  it("SAME-SCOPE row → permitted without an actor role bag (root auth covered exactly this scope)", async () => {
    const authorize = buildAgentRowMutationAuthorizer({ rootRowOwnership: teamTuple, actor: null });
    await expect(
      authorize(row(DEP, "0.2.1", { organizationId: ORG, ownerLevel: "team", ownerId: "team-1" })),
    ).resolves.toBeUndefined();
  });

  it("SAME-SCOPE identity is per-level: the persisted __platform__ ownerId sentinel never breaks it", async () => {
    // The canonical store persists "__platform__" where a null ownerId was
    // written (platform rows always; org rows written without ownerId) and
    // returns it verbatim — the fast path must compare scope identity, not
    // the raw column.
    const platformTuple: RowOwnership = {
      ownerLevel: "platform",
      ownerId: null,
      organizationId: null,
    };
    await expect(
      buildAgentRowMutationAuthorizer({ rootRowOwnership: platformTuple, actor: null })(
        row(DEP, "0.2.1", {
          organizationId: null,
          ownerLevel: "platform",
          ownerId: "__platform__",
        }),
      ),
    ).resolves.toBeUndefined();

    const orgTuple: RowOwnership = {
      ownerLevel: "organization",
      ownerId: ORG,
      organizationId: ORG,
    };
    await expect(
      buildAgentRowMutationAuthorizer({ rootRowOwnership: orgTuple, actor: null })(
        row(DEP, "0.2.1", {
          organizationId: ORG,
          ownerLevel: "organization",
          ownerId: "__platform__",
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("CROSS-SCOPE row without an actor role bag → deny (fail-closed)", async () => {
    const authorize = buildAgentRowMutationAuthorizer({ rootRowOwnership: teamTuple, actor: null });
    await expect(
      authorize(row(DEP, "0.2.1", { organizationId: ORG, ownerLevel: "organization" })),
    ).rejects.toThrow(/no actor role bag/);
  });

  it("org-owned row: org_admin of THAT org permits; plain member denies; other-org admin denies", async () => {
    const orgRow = row(DEP, "0.2.1", { organizationId: ORG, ownerLevel: "organization" });
    await expect(
      buildAgentRowMutationAuthorizer({ rootRowOwnership: teamTuple, actor: orgActor() })(orgRow),
    ).resolves.toBeUndefined();
    await expect(
      buildAgentRowMutationAuthorizer({
        rootRowOwnership: teamTuple,
        actor: orgActor({ orgRole: "member" }),
      })(orgRow),
    ).rejects.toThrow(/organization/);
    await expect(
      buildAgentRowMutationAuthorizer({
        rootRowOwnership: teamTuple,
        actor: orgActor({ organizationId: "org-OTHER" }),
      })(orgRow),
    ).rejects.toThrow(/different organization/);
  });

  it("platform-owned row → platform_admin only", async () => {
    const platformRow = row(DEP, "0.2.1", { organizationId: null, ownerLevel: "platform" });
    await expect(
      buildAgentRowMutationAuthorizer({ rootRowOwnership: teamTuple, actor: orgActor() })(
        platformRow,
      ),
    ).rejects.toThrow(/platform admin/);
    await expect(
      buildAgentRowMutationAuthorizer({
        rootRowOwnership: teamTuple,
        actor: orgActor({ platformRole: "platform_admin" }),
      })(platformRow),
    ).resolves.toBeUndefined();
  });

  it("user-owned row → only its owner (or platform_admin)", async () => {
    const userRow = row(DEP, "0.2.1", {
      organizationId: ORG,
      ownerLevel: "user",
      ownerId: "user-1",
    });
    await expect(
      buildAgentRowMutationAuthorizer({ rootRowOwnership: teamTuple, actor: orgActor() })(userRow),
    ).resolves.toBeUndefined(); // orgActor's principalId IS user-1
    await expect(
      buildAgentRowMutationAuthorizer({
        rootRowOwnership: teamTuple,
        actor: orgActor({ principalId: "user-2", orgRole: "org_admin" }),
      })(userRow),
    ).rejects.toThrow(/owner/);
  });

  it("team-owned row at a DIFFERENT team re-runs the grid against THAT team (team_admin of it permits)", async () => {
    const otherTeamRow = row(DEP, "0.2.1", {
      organizationId: ORG,
      ownerLevel: "team",
      ownerId: "team-2",
    });
    // The tenant check hits the DB (readTeamForOrg) — inject the seams.
    const seams = {
      assertTargetBelongsToActiveOrg: vi.fn(async () => ({})),
    };
    await expect(
      buildAgentRowMutationAuthorizer({
        rootRowOwnership: teamTuple,
        actor: orgActor({ orgRole: "member", teamRoles: { "team-2": "team_admin" as const } }),
        seams,
      })(otherTeamRow),
    ).resolves.toBeUndefined();
    expect(seams.assertTargetBelongsToActiveOrg).toHaveBeenCalledWith(
      expect.anything(),
      { level: "team", id: "team-2" },
      ORG,
    );
    // org_admin WITHOUT team_admin of team-2 → the grid denies (locked rule).
    await expect(
      buildAgentRowMutationAuthorizer({
        rootRowOwnership: teamTuple,
        actor: orgActor(),
        seams,
      })(otherTeamRow),
    ).rejects.toThrow(/team admin/);
  });

  it("plan-level: an unauthorized cross-scope dedupe keeps the evidence-carrying INSTALLED_VERSION_CONFLICT refusal", async () => {
    // Root tuple = team-1; the only live basis row is ORG-owned; the actor is
    // a plain member → the dedupe-upward must refuse, naming the scope.
    const installed = [row(DEP, "0.2.1", { organizationId: ORG, ownerLevel: "organization" })];
    await expect(
      planDependencyInstall(
        { root: { packageName: ROOT, version: "1.0.0" }, orgId: ORG, closure: null, rowOwnership: teamTuple },
        agentDeps(DEDUPE_REGISTRY, installed, teamTuple, orgActor({ orgRole: "member" })),
      ),
    ).rejects.toMatchObject({
      code: "INSTALLED_VERSION_CONFLICT",
      message: expect.stringContaining("not authorized to modify"),
    });
  });

  it("plan-level: the SAME cross-scope dedupe with an org_admin actor executes as an update", async () => {
    const installed = [row(DEP, "0.2.1", { organizationId: ORG, ownerLevel: "organization" })];
    const plan = await planDependencyInstall(
      { root: { packageName: ROOT, version: "1.0.0" }, orgId: ORG, closure: null, rowOwnership: teamTuple },
      agentDeps(DEDUPE_REGISTRY, installed, teamTuple, orgActor()),
    );
    const dep = plan.ordered.find((m) => m.packageName === DEP)!;
    expect(dep.action).toBe("update");
    // Decision 4: the member still carries the ROOT's tuple — existing-row
    // selection never overrides the stamp.
    expect(dep.rowOwnership).toEqual(teamTuple);
  });
});

describe("cinatra#1039 decision 1/4 — agentRowOwnershipFromInstallInput", () => {
  it("explicit owner tier → the tuple verbatim", () => {
    expect(
      agentRowOwnershipFromInstallInput({ orgId: ORG, ownerLevel: "project", ownerId: "proj-1" }),
    ).toEqual({ ownerLevel: "project", ownerId: "proj-1", organizationId: ORG });
  });
  it("no owner tier + org → the canonical organization default", () => {
    expect(agentRowOwnershipFromInstallInput({ orgId: ORG })).toEqual({
      ownerLevel: "organization",
      ownerId: ORG,
      organizationId: ORG,
    });
  });
  it("no owner tier + no org → the platform default", () => {
    expect(agentRowOwnershipFromInstallInput({})).toEqual({
      ownerLevel: "platform",
      ownerId: null,
      organizationId: null,
    });
  });
});

describe("cinatra#1039 Phase 2 — the agent-only dependency-vocabulary guard", () => {
  it("a REQUIRED cross-kind edge fails loud at plan time (cross-kind closures route through the saga)", async () => {
    const registry: Record<string, Pkg> = {
      [ROOT]: {
        version: "1.0.0",
        dependencies: [
          {
            packageName: "@cinatra-ai/some-connector",
            edgeType: "runtime",
            versionConstraint: { kind: "semver-range", range: "*" },
            requirement: "required",
            kind: "connector",
          } as ExtensionDependency,
        ],
      },
    };
    const rowOwnership: RowOwnership = {
      ownerLevel: "organization",
      ownerId: ORG,
      organizationId: ORG,
    };
    await expect(
      planDependencyInstall(
        { root: { packageName: ROOT, version: "1.0.0" }, orgId: ORG, closure: null, rowOwnership },
        agentDeps(registry, [], rowOwnership, orgActor()),
      ),
    ).rejects.toThrow(/can only install agent dependencies/);
  });
});
