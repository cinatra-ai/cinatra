import "server-only";

// ---------------------------------------------------------------------------
// cinatra#1039 Phase 2 — the AGENT-PATH seams for the unified dependency
// planner (`planDependencyInstall` in src/lib/extension-dependency-plan.ts).
//
// The legacy agent full-tree installer resolved its dependency graph through a
// SECOND resolver (@cinatra-ai/registries `resolveDependencyTree`, conflict
// policy "prefer-newer"), so install-conflict semantics forked by code path.
// This module supplies the planner deps the agent path injects instead, per
// the ratified decisions (issue thread, 2026-07-12):
//   1. The planner's scope-targeting seat is the canonical ownership tuple
//      (`rowOwnership` — NEVER confused with the access popup's accessTarget).
//   2. The conflict basis resolves along the REAL ownership ladder via
//      `resolveAgentScopeAncestry` (project→owning-team→org→platform) — an
//      EXPLICIT resolver, never a naive tuple walk (a project's owning team is
//      `project.ownerId` when `project.ownerLevel === "team"`, a DB lookup).
//   3. A dedupe-upward that MUTATES an existing shared row re-authorizes the
//      EXISTING ROW's exact scope (`assertCanInstallAtTarget` against the
//      row's `{level,id}`), fail-closed — NOT merely "satisfied at the root
//      scope". Deny → the planner keeps the evidence-carrying
//      INSTALLED_VERSION_CONFLICT refusal.
//   4. The ROOT install's tuple is forced immutably onto every transitive
//      member (the planner enforces this; the executor stamps it).
// ---------------------------------------------------------------------------

import type {
  DependencyPlanDeps,
  ResolvedScopeLevel,
  RowOwnership,
} from "@/lib/extension-dependency-plan";
import {
  PLATFORM_OWNER_SENTINEL,
  type InstalledExtension,
} from "@cinatra-ai/extensions/canonical-types";
// Leaf subpaths (manifest-dependencies imports only canonical-types;
// dependency-closure imports only @cinatra-ai/registries + canonical-types) —
// NOT the @cinatra-ai/extensions main entry, so the static agents→extensions
// index cycle does not apply (same posture as install-from-package.ts).
import { parseManifestDependencyEdges } from "@cinatra-ai/extensions/manifest-dependencies";
import { isAutoInstallableEdge } from "@cinatra-ai/extensions/dependency-closure";
import {
  getPublishedExtensionSummary,
  resolveExtensionDistIntegrity,
  resolveMaxSatisfyingVersion,
  isExactVersion,
  isValidVersionRange,
  type VerdaccioConfig,
} from "@cinatra-ai/registries";
import {
  assertCanInstallAtTarget,
  assertTargetBelongsToActiveOrg,
  type InstallActorRoleBag,
  type InstallScopeTarget,
} from "./install-target-authz";
import { readProjectById } from "@/lib/projects-store-dao";

/**
 * Derive the ROOT install's `rowOwnership` tuple from the agent installer's
 * input. An explicit owner tier (the InstallScopeDialog target threaded by
 * `installRegistryPackageAtScope`) is the tuple verbatim; absent, the
 * canonical default applies (an org install is organization-owned, a null-org
 * install platform-owned) — the same derivation the extension saga passes and
 * the planner falls back to, so an untargeted agent install plans at the
 * exact pre-#1039 scope.
 */
export function agentRowOwnershipFromInstallInput(input: {
  orgId?: string;
  ownerLevel?: "user" | "team" | "organization" | "workspace" | "project";
  ownerId?: string;
}): RowOwnership {
  if (input.ownerLevel !== undefined) {
    return {
      ownerLevel: input.ownerLevel,
      ownerId: input.ownerId ?? null,
      organizationId: input.orgId ?? null,
    };
  }
  return {
    ownerLevel: input.orgId ? "organization" : "platform",
    ownerId: input.orgId ?? null,
    organizationId: input.orgId ?? null,
  };
}

/** Injectable lookups for {@link resolveAgentScopeAncestry} (tests). */
export type ScopeAncestrySeams = {
  /** Default: `readProjectById` (src/lib/projects-store-dao). */
  readProject?: (projectId: string) => Promise<{
    organizationId: string;
    ownerLevel: string;
    ownerId: string | null;
  } | null>;
};

function levelOf(
  label: string,
  organizationId: string | null,
  matches: (row: InstalledExtension) => boolean,
): ResolvedScopeLevel {
  return { label, organizationId, matches };
}

/**
 * Decision 2 — the REAL agent-path scope-ancestry resolver. Returns the
 * ordered fallback chain the planner walks for the conflict/dedupe basis:
 *
 *   - platform      → [platform]
 *   - organization  → [organization, platform]
 *   - team          → [team, organization, platform]
 *   - project       → [project, owning-team (when the project is team-owned),
 *                      organization, platform]
 *   - user          → [user, organization, platform]
 *   - workspace     → [workspace, organization, platform]
 *
 * Each level matches rows OWNED at that scope (`row.ownerLevel` + `ownerId` +
 * `organizationId`) — a team-owned row and an org-owned row inside the same
 * org NEVER collapse into one basis (the exact split the #1039 fence named).
 * The PLATFORM level keeps the canonical null-org match (`organizationId ===
 * null`) so legacy platform rows resolve exactly as the extension binary does.
 *
 * Project→owning-team ancestry is a DB lookup (`project.ownerId` when
 * `project.ownerLevel === "team"`), which is why this is an injected resolver
 * seam and never a naive tuple walk. A project tuple naming an unreadable
 * project FAILS LOUD — planning against a half-resolved ladder could bind the
 * conflict basis to the wrong scope.
 */
export async function resolveAgentScopeAncestry(
  rowOwnership: RowOwnership,
  seams: ScopeAncestrySeams = {},
): Promise<ResolvedScopeLevel[]> {
  const { ownerLevel, ownerId, organizationId } = rowOwnership;
  const orgId = organizationId ?? null;

  const platform = levelOf("platform", null, (r) => (r.organizationId ?? null) === null);
  const organization =
    orgId === null
      ? null
      : levelOf(
          `organization:${orgId}`,
          orgId,
          (r) => r.ownerLevel === "organization" && (r.organizationId ?? null) === orgId,
        );
  const withTrunk = (own: ResolvedScopeLevel | null, mid?: ResolvedScopeLevel | null) =>
    [own, mid ?? null, organization, platform].filter(
      (l): l is ResolvedScopeLevel => l !== null,
    );

  const ownedAt =
    (level: string, id: string) =>
    (r: InstalledExtension): boolean =>
      (r.ownerLevel as string) === level &&
      (r.ownerId ?? null) === id &&
      (r.organizationId ?? null) === orgId;

  switch (ownerLevel) {
    case "platform":
      return [platform];
    case "organization":
      return withTrunk(null);
    case "team": {
      if (!ownerId) throw new Error("[resolveAgentScopeAncestry] team tuple without ownerId");
      return withTrunk(levelOf(`team:${ownerId}`, orgId, ownedAt("team", ownerId)));
    }
    case "user": {
      if (!ownerId) throw new Error("[resolveAgentScopeAncestry] user tuple without ownerId");
      return withTrunk(levelOf(`user:${ownerId}`, orgId, ownedAt("user", ownerId)));
    }
    case "workspace": {
      if (!ownerId) throw new Error("[resolveAgentScopeAncestry] workspace tuple without ownerId");
      return withTrunk(levelOf(`workspace:${ownerId}`, orgId, ownedAt("workspace", ownerId)));
    }
    case "project": {
      if (!ownerId) throw new Error("[resolveAgentScopeAncestry] project tuple without ownerId");
      const readProject = seams.readProject ?? readProjectById;
      const project = await readProject(ownerId);
      if (!project) {
        throw new Error(
          `[resolveAgentScopeAncestry] project ${ownerId} not found — cannot resolve the ` +
            `ownership ancestry chain for a project-scoped install (refusing to plan against ` +
            `a half-resolved ladder).`,
        );
      }
      const owningTeamId = project.ownerLevel === "team" ? project.ownerId : null;
      return withTrunk(
        levelOf(`project:${ownerId}`, orgId, ownedAt("project", ownerId)),
        owningTeamId
          ? levelOf(`team:${owningTeamId}`, orgId, ownedAt("team", owningTeamId))
          : null,
      );
    }
  }
}

/** Injectable authz seams for {@link buildAgentRowMutationAuthorizer} (tests). */
export type RowMutationAuthzSeams = {
  assertTargetBelongsToActiveOrg?: typeof assertTargetBelongsToActiveOrg;
  assertCanInstallAtTarget?: typeof assertCanInstallAtTarget;
};

/**
 * Decision 3 — the agent-path `authorizeExistingRowMutation` seam. A clean
 * dedupe-upward MUTATES an existing shared dependency row, so the requesting
 * principal must be INDEPENDENTLY authorized for THAT row's exact scope.
 * A throw here is converted by the planner into the evidence-carrying
 * INSTALLED_VERSION_CONFLICT refusal (fail-closed).
 *
 * Rules (deny = throw):
 *   - SAME-SCOPE fast path: the row's tuple equals the ROOT's requested tuple
 *     → permit. The caller's root authorization (`assertCanInstallAtTarget`
 *     at the action boundary) already ran against exactly this scope, so the
 *     re-authorization is definitionally satisfied.
 *   - Cross-scope WITHOUT an actor role bag → deny (fail-closed; the callers
 *     that cannot thread a role bag never get silent cross-scope mutation).
 *   - platform_admin → permit (the grid's short-circuit).
 *   - Row owned at platform/workspace scope → platform_admin only.
 *   - Row owned by a USER → only that user (their own row).
 *   - Row owned at organization/team/project scope → the shared
 *     `assertTargetBelongsToActiveOrg` (tenant boundary; loads project
 *     ownership) + `assertCanInstallAtTarget` grid against the ROW's scope.
 */
export function buildAgentRowMutationAuthorizer(opts: {
  rootRowOwnership: RowOwnership;
  actor: InstallActorRoleBag | null;
  seams?: RowMutationAuthzSeams;
}): (row: InstalledExtension) => Promise<void> {
  const assertTenant =
    opts.seams?.assertTargetBelongsToActiveOrg ?? assertTargetBelongsToActiveOrg;
  const assertGrid = opts.seams?.assertCanInstallAtTarget ?? assertCanInstallAtTarget;
  return async (row: InstalledExtension): Promise<void> => {
    const rowLevel = row.ownerLevel as string;
    // The canonical store persists PLATFORM_OWNER_SENTINEL ("__platform__")
    // where a null ownerId was written and returns it VERBATIM on reads —
    // normalize it back to null so scope comparisons never mistake the
    // sentinel for a real owner id.
    const rowOwnerId =
      row.ownerId === PLATFORM_OWNER_SENTINEL ? null : (row.ownerId ?? null);
    const rowOrgId = row.organizationId ?? null;
    const root = opts.rootRowOwnership;

    // Same-scope fast path (see contract above). Scope IDENTITY is per-level:
    // a platform scope is identified by the level alone, an organization scope
    // by its organizationId (the ownerId column is redundant there and often
    // carries the sentinel), and the narrower levels by their real ownerId.
    const sameScope =
      rowLevel === root.ownerLevel &&
      rowOrgId === (root.organizationId ?? null) &&
      (rowLevel === "platform" ||
        rowLevel === "organization" ||
        rowOwnerId === (root.ownerId ?? null));
    if (sameScope) return;

    const deny = (why: string): never => {
      throw new Error(
        `[agent-dependency-plan] not authorized to modify the ${rowLevel}-owned install of ` +
          `${row.packageName}: ${why}`,
      );
    };

    const actor = opts.actor;
    if (!actor) {
      deny("no actor role bag on this install path (cross-scope mutation is fail-closed)");
      return;
    }
    if (actor.platformRole === "platform_admin") return;

    if (rowLevel === "platform" || rowLevel === "workspace") {
      deny(`${rowLevel}-owned rows require platform admin`);
    }
    if (rowOrgId !== actor.organizationId) {
      // Tenant boundary FIRST: the grid's organization branch checks the
      // actor's role, not the target org id — never let an org_admin of org A
      // mutate org B's row.
      deny("the row belongs to a different organization");
    }
    if (rowLevel === "user") {
      if (rowOwnerId === actor.principalId) return;
      deny("user-owned rows may only be modified by their owner");
    }
    if (rowLevel !== "organization" && rowLevel !== "team" && rowLevel !== "project") {
      deny(`unrecognized owner level`);
    }
    const target: InstallScopeTarget =
      rowLevel === "organization"
        ? { level: "organization", id: rowOrgId! }
        : rowOwnerId
          ? { level: rowLevel as "team" | "project", id: rowOwnerId }
          : (deny("the row carries no owner id") as never);
    const { projectOwnership } = await assertTenant(actor, target, actor.organizationId);
    await assertGrid(actor, target, projectOwnership);
  };
}

/**
 * Build the full `DependencyPlanDeps` the agent full-tree installer injects
 * into `planDependencyInstall` — ONE resolver for both install paths.
 *
 * `fetchSummary` mirrors the batch saga's registry resolution EXACTLY (the
 * parity contract): exact version → packument read at that version; semver
 * RANGE → `resolveMaxSatisfyingVersion` (pacote resolves exact versions and
 * dist-tags but NOT ranges against Verdaccio — live-verify finding); dist-tag
 * → `resolveExtensionDistIntegrity`; "latest"/absent → the packument default.
 *
 * `parseEdges` keeps the direct agent path's vocabulary guard: a REQUIRED
 * cross-kind edge fails loud at plan time (this path installs each member via
 * `installAgentFromPackage`, an AGENT-only installer; cross-kind closures
 * route through the kind-aware batch saga).
 */
export function buildAgentDependencyPlanDeps(opts: {
  config: VerdaccioConfig;
  rowOwnership: RowOwnership;
  actor: InstallActorRoleBag | null;
  /** Test seams. */
  fetchSummary?: DependencyPlanDeps["fetchSummary"];
  readInstalledRows?: DependencyPlanDeps["readInstalledRows"];
  ancestrySeams?: ScopeAncestrySeams;
  authzSeams?: RowMutationAuthzSeams;
}): DependencyPlanDeps {
  return {
    fetchSummary:
      opts.fetchSummary ??
      (async (packageName, versionOrRange) => {
        const isExact = isExactVersion(versionOrRange);
        let exact = isExact ? versionOrRange : undefined;
        if (!isExact && versionOrRange !== "latest" && versionOrRange !== "") {
          if (isValidVersionRange(versionOrRange)) {
            const resolved = await resolveMaxSatisfyingVersion(
              { packageName, range: versionOrRange },
              opts.config,
            );
            if (!resolved) {
              throw new Error(
                `[agent-dependency-plan] no published version of ${packageName} satisfies "${versionOrRange}"`,
              );
            }
            exact = resolved;
          } else {
            const resolved = await resolveExtensionDistIntegrity(
              { packageName, packageVersion: versionOrRange },
              opts.config,
            );
            exact = resolved.resolvedVersion ?? undefined;
          }
        }
        const summary = await getPublishedExtensionSummary(
          { packageName, ...(exact ? { packageVersion: exact } : {}) },
          opts.config,
        );
        if (!summary.resolvedVersion) {
          throw new Error(
            `[agent-dependency-plan] no resolvable version for ${packageName}@${versionOrRange}`,
          );
        }
        return {
          resolvedVersion: summary.resolvedVersion,
          kind: summary.kind,
          manifest: summary.manifest,
        };
      }),
    parseEdges: (manifest, packageName) => {
      const { edges } = parseManifestDependencyEdges(manifest, { packageName });
      for (const edge of edges) {
        if (!isAutoInstallableEdge(edge)) continue;
        if (edge.kind !== undefined && edge.kind !== "agent") {
          throw new Error(
            `[installAgentPackageWithDependencies] ${packageName} declares a required ${edge.kind} ` +
              `dependency on ${edge.packageName}; the direct agent full-tree installer can only ` +
              `install agent dependencies. Install cross-kind closures through the batch install saga.`,
          );
        }
      }
      return edges;
    },
    isAutoInstallableEdge,
    readInstalledRows:
      opts.readInstalledRows ??
      (async () => {
        // Dynamic import: @cinatra-ai/agents → @cinatra-ai/extensions
        // canonical-store is the heavy DB-backed subpath (same posture as
        // install-from-package.ts's canonical-store reads).
        const { listInstalledExtensions } = await import(
          "@cinatra-ai/extensions/canonical-store"
        );
        return listInstalledExtensions({});
      }),
    resolveScopeAncestry: (rowOwnership) =>
      resolveAgentScopeAncestry(rowOwnership, opts.ancestrySeams ?? {}),
    authorizeExistingRowMutation: buildAgentRowMutationAuthorizer({
      rootRowOwnership: opts.rowOwnership,
      actor: opts.actor,
      ...(opts.authzSeams ? { seams: opts.authzSeams } : {}),
    }),
  };
}
