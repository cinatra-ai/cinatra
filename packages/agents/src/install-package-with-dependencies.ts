import "server-only";

// ---------------------------------------------------------------------------
// installAgentPackageWithDependencies — the agent FULL-TREE installer.
//
// cinatra#1039 Phase 2: this path now resolves its dependency graph through
// the UNIFIED dependency planner (`planDependencyInstall`,
// src/lib/extension-dependency-plan.ts) — the same resolver the batch-install
// saga plans with — instead of the deleted second resolver
// (@cinatra-ai/registries `installPackageWithDependencies`, conflict policy
// "prefer-newer"). ONE resolver, ONE dependency vocabulary, ONE conflict
// semantics; the agent path threads its REAL ownership tuple (rowOwnership)
// so the conflict/dedupe basis resolves along the ownership ladder instead of
// the org-binary (the ratified seams live below in this module).
//
// Execution stays agent-native: each planned member installs via
// `installAgentFromPackage` (upsert semantics), dependencies first, the root
// last (the planner's topo order). Members already installed at the exact pin
// are SKIPPED (the saga's semantics — the old path blindly reinstalled them);
// the ROOT always executes (installing/updating over an existing root is the
// flow the caller drives). A planned `action:"update"` member (a clean,
// authorized dedupe-upward) realizes as the same upsert — the agent path's
// native in-place update. An `action:"install-side-by-side"` member fails
// loud at execute-selection time: agent templates are keyed one-row-per
// package, so side-by-side rows can only be realized by the batch saga.
//
// The agent-path planner SEAMS (the ratified decisions 1-4: rowOwnership
// derivation, the real scope-ancestry ladder, and the decision-3 row-mutation
// re-authorization) live in THIS module too — deliberately ONE module, not a
// sibling file: the locked routes' dev-perf route-graph ratchet budgets one
// module for this surface (the deleted registries install-with-deps module
// freed exactly one slot).
// ---------------------------------------------------------------------------

import {
  ensureConfig,
  type VerdaccioConfig,
} from "@cinatra-ai/registries";
import { buildRegistryAuthArgs } from "./verdaccio/cli-flags";
import { withGlobalExtensionLifecycleLock } from "./materialize-agent-package";
import {
  triggerWayflowReload,
  type ReloadResult,
} from "./wayflow-reload-client";
import { installAgentFromPackage } from "./install-from-package";
import { readAgentTemplateByPackageName } from "./store";
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
 *   - ACTOR PRESENT → the ratified rule VERBATIM: the grid re-runs against
 *     the EXISTING row's `{level, id}` for EVERY mutation — including a
 *     same-scope one. (Never assume the caller's own gate covered the row's
 *     scope: e.g. `updateRegistryPackage` gates on the generic
 *     `registry.update` canDo, not the scope grid.)
 *       - Row owned at platform/workspace scope → platform_admin only.
 *       - Row owned by a USER → only that user (or platform_admin).
 *       - Row owned at organization/team/project scope → tenant boundary,
 *         then the shared `assertTargetBelongsToActiveOrg` (existence +
 *         project-ownership load) + `assertCanInstallAtTarget` grid against
 *         the ROW's scope (the grid short-circuits platform_admin AFTER the
 *         tenant gate).
 *   - NO actor role bag (paths that cannot thread one, e.g. the
 *     extension-handler flows): SAME-SCOPE rows permit — the mutation stays
 *     within the exact scope the flow already operates in (the saga-parity
 *     posture); anything cross-scope denies (fail-closed).
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

    const deny = (why: string): never => {
      throw new Error(
        `[agent-dependency-plan] not authorized to modify the ${rowLevel}-owned install of ` +
          `${row.packageName}: ${why}`,
      );
    };

    const actor = opts.actor;
    if (!actor) {
      // Actor-less path: same-scope permits, anything else is fail-closed
      // (see the contract above). Scope IDENTITY is per-level: a platform
      // scope is identified by the level alone, an organization scope by its
      // organizationId (the ownerId column is redundant there and often
      // carries the sentinel), and the narrower levels by their real ownerId.
      const sameScope =
        rowLevel === root.ownerLevel &&
        rowOrgId === (root.organizationId ?? null) &&
        (rowLevel === "platform" ||
          rowLevel === "organization" ||
          rowOwnerId === (root.ownerId ?? null));
      if (sameScope) return;
      deny("no actor role bag on this install path (cross-scope mutation is fail-closed)");
      return;
    }

    // Platform-authority scopes (no tenant relation to validate): platform-
    // and workspace-owned rows may only be mutated by a platform admin.
    if (rowLevel === "platform" || rowLevel === "workspace") {
      if (actor.platformRole === "platform_admin") return;
      deny(`${rowLevel}-owned rows require platform admin`);
    }
    // USER-owned rows: their owner (or a platform admin).
    if (rowLevel === "user") {
      if (actor.platformRole === "platform_admin") return;
      if (rowOwnerId === actor.principalId) return;
      deny("user-owned rows may only be modified by their owner");
    }
    if (rowLevel !== "organization" && rowLevel !== "team" && rowLevel !== "project") {
      deny(`unrecognized owner level`);
    }
    // TENANT BOUNDARY before the grid — mirrors the locked action ordering
    // (assertTargetBelongsToActiveOrg runs before assertCanInstallAtTarget and
    // platform_admin does NOT skip it): the grid's organization branch checks
    // the actor's role, not the target org id, so the org/existence validation
    // must run first for EVERY principal.
    if (rowOrgId !== actor.organizationId) {
      deny("the row belongs to a different organization");
    }
    const target: InstallScopeTarget =
      rowLevel === "organization"
        ? { level: "organization", id: rowOrgId! }
        : rowOwnerId
          ? { level: rowLevel as "team" | "project", id: rowOwnerId }
          : (deny("the row carries no owner id") as never);
    const { projectOwnership } = await assertTenant(actor, target, actor.organizationId);
    // The grid itself short-circuits platform_admin — AFTER the tenant gate.
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

export type InstallAgentPackageWithDependenciesInput = {
  packageName: string;
  packageVersion?: string;
  orgId?: string;
  /** cinatra#793: store-payload resolution scope for the ROOT node (see
   *  InstallAgentFromPackageInput.anchorOrgId). */
  anchorOrgId?: string | null;
  /** cinatra#793: require the ROOT node's finalized store payload (the
   *  dispatcher path); transitive dependency nodes always keep the registry
   *  extract (they never routed through the dispatcher pipeline). */
  requireStorePayloadForRoot?: boolean;
  creatorId?: string;
  // Includes "active"; mirrors InstallAgentFromPackageInput.
  status?: "draft" | "published" | "active";
  // Install-time owner tier. Forwarded to every transitive
  // installAgentFromPackage call so dependencies inherit the root install's
  // owner tuple (cinatra#1039 decision 4 — the tuple is forced immutably onto
  // every planned member). A team-owned root install means team-owned
  // dependencies; the team_admin who installed the root is, by extension,
  // allowed to take the dependencies into their team scope. The auth gate ran
  // ONCE for the root; the SOLE per-row re-check is the decision-3
  // mutate-existing-cross-scope-row gate below.
  ownerLevel?: "user" | "team" | "organization" | "workspace" | "project";
  ownerId?: string;
  /**
   * cinatra#1039 decision 3: the requesting principal's role bag, used ONLY to
   * re-authorize a dedupe-upward against the EXISTING row's exact scope when
   * that row's ownership differs from the root tuple. OPTIONAL — callers that
   * cannot thread it (e.g. the extension-handler flows) stay fail-closed:
   * same-scope dedupe-upward still executes, cross-scope refuses.
   */
  actor?: InstallActorRoleBag;
};

export type InstallAgentPackageWithDependenciesResult = {
  rootTemplateId: string;
  /** Template ids of the members this call actually installed/updated (the
   *  planner-skipped already-at-pin members are not re-installed). */
  installedTemplateIds: string[];
  /** The computed unified-planner members, dependencies first, root last. */
  plannedMembers: Array<{
    packageName: string;
    version: string;
    action: "install" | "update" | "install-side-by-side";
    alreadyInstalled: boolean;
  }>;
  /** WayFlow reload result, fired once per tree install. */
  wayflowReload?: ReloadResult;
};

/**
 * Full-tree installer — plans the dependency closure of `packageName` through
 * the unified dependency planner and installs each planned member via
 * installAgentFromPackage (which handles upsert-on-collision).
 */
export async function installAgentPackageWithDependencies(
  input: InstallAgentPackageWithDependenciesInput,
  config?: VerdaccioConfig,
): Promise<InstallAgentPackageWithDependenciesResult> {
  // GLOBAL lifecycle lock before dependency resolution/extraction; serialized
  // against extensions_purge. Re-entrant so installAgentFromPackage -> this
  // nested call does not deadlock.
  return withGlobalExtensionLifecycleLock(() =>
    _installAgentPackageWithDependenciesImpl(input, config),
  );
}

async function _installAgentPackageWithDependenciesImpl(
  input: InstallAgentPackageWithDependenciesInput,
  config?: VerdaccioConfig,
): Promise<InstallAgentPackageWithDependenciesResult> {
  const resolvedConfig = ensureConfig(config, "installAgentPackageWithDependencies");
  // Build the explicit-flag args from the resolved config. The install path
  // uses pacote (HTTP) via the planner's registry reads, so the flags are not
  // spliced into a spawn argv here. Constructing them validates that the
  // resolved config has a non-empty token early (the helper throws on empty
  // token at the install boundary, not just at the publish/unpublish boundary)
  // and keeps install-side flag construction co-located with the entry point.
  const _installAuthArgs = buildRegistryAuthArgs(resolvedConfig);
  void _installAuthArgs;

  // cinatra#1039 Phase 2 — ONE RESOLVER. Plan the closure through the unified
  // dependency planner with the agent path's REAL ownership tuple. The
  // dependency-confusion allowlist is derived INSIDE the planner from the ROOT
  // package's own vendor scope + the first-party base scope (issue #103: never
  // from the installing instance's namespace — the planner never even sees
  // `resolvedConfig.packageScope`). Dynamic import: the planner is a host-app
  // module (same posture as the other "@/lib/*" reads in this package).
  const { planDependencyInstall } = await import("@/lib/extension-dependency-plan");
  // The PLANNING scope: `orgId` when the caller threads it, else the
  // dispatcher anchor scope (`anchorOrgId` — the extension-handler flows pass
  // ONLY that; without the fallback an org-scoped update would plan at
  // PLATFORM scope and never see its own org rows). Deliberately decoupled
  // from the TEMPLATE-ROW stamping below, which keeps forwarding the caller's
  // literal `orgId`/owner tier so org/owner columns behave exactly as before.
  const scopeOrgId = input.orgId ?? input.anchorOrgId ?? null;
  const rowOwnership = agentRowOwnershipFromInstallInput({
    ...(scopeOrgId !== null ? { orgId: scopeOrgId } : {}),
    ...(input.ownerLevel !== undefined ? { ownerLevel: input.ownerLevel } : {}),
    ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
  });
  const planDeps = buildAgentDependencyPlanDeps({
    config: resolvedConfig,
    rowOwnership,
    actor: input.actor ?? null,
  });
  const plan = await planDependencyInstall(
    {
      root: {
        packageName: input.packageName,
        // The caller's version argument rides the planner's dev-path registry
        // resolution verbatim (exact version, semver range, or dist-tag).
        // Absent → "*": the deleted resolver's default range — the HIGHEST
        // stable version, NOT the "latest" dist-tag (they diverge when the
        // tag deliberately trails a newer stable release).
        version: input.packageVersion ?? "*",
      },
      orgId: scopeOrgId,
      rowOwnership,
      // The direct agent path is never the gatekept marketplace closure — root
      // authorization stays with the callers' authz gates (which ran before
      // this function), exactly as it did for the deleted resolver.
      closure: null,
    },
    planDeps,
  );

  // PREFLIGHT the WHOLE plan before executing anything: a member this
  // executor cannot realize must refuse while NOTHING has mutated (this
  // direct path has no compensation machinery — the batch saga owns that).
  for (const member of plan.ordered) {
    if (member.action === "install-side-by-side") {
      throw new Error(
        `[installAgentPackageWithDependencies] ${member.packageName}@${member.version} plans as a ` +
          `SIDE-BY-SIDE install (live dependents refuse the pin: ` +
          `${member.sideBySideEvidence?.dependents.join(", ") ?? "unknown"}) — the direct agent ` +
          `installer keeps one template row per package and cannot realize side-by-side rows. ` +
          `Install through the extension marketplace/batch path, or update the named dependents first.`,
      );
    }
    const kind = plan.memberKinds.get(member.packageName);
    if (kind !== undefined && kind !== null && kind !== "agent") {
      throw new Error(
        `[installAgentPackageWithDependencies] resolved dependency ${member.packageName}@` +
          `${member.version} is a ${kind} extension; the direct agent full-tree installer can ` +
          `only install agents. Install cross-kind closures through the batch install saga.`,
      );
    }
  }

  const installedTemplateIds: string[] = [];
  let rootTemplateId: string | null = null;
  for (const member of plan.ordered) {
    const isRootNode = member.packageName === input.packageName;
    // Saga semantics: a member already installed at the exact pin is skipped.
    // The ROOT always executes — installing/updating over an existing root is
    // the flow the caller chose (reinstall/refresh keeps working). SPLIT-STORE
    // HEAL: `alreadyInstalled` is judged on the CANONICAL row, but this path
    // executes into agent_templates — when the template row is missing (e.g.
    // uninstalled out-of-band while the canonical row survived), skipping
    // would leave the root referencing a dependency with no template, so the
    // member installs anyway (idempotent upsert).
    if (member.alreadyInstalled && !isRootNode) {
      const template = await readAgentTemplateByPackageName(member.packageName);
      // Skip only when the template row exists AT THE PLANNED PIN — a
      // version-drifted template (e.g. updated through this direct path while
      // the canonical row stayed behind) reinstalls, exactly as the old blind
      // path would have.
      if (template && template.packageVersion === member.version) continue;
    }
    const res = await installAgentFromPackage(
      {
        packageName: member.packageName,
        packageVersion: member.version,
        orgId: input.orgId,
        creatorId: input.creatorId,
        status: input.status,
        // cinatra#793: only the ROOT node is dispatcher-routed (its store
        // payload is finalized); transitive nodes keep the registry extract.
        ...(isRootNode && input.anchorOrgId !== undefined
          ? { anchorOrgId: input.anchorOrgId }
          : {}),
        ...(isRootNode && input.requireStorePayloadForRoot ? { requireStorePayload: true } : {}),
        // Decision 4 stamping: every member carries the ROOT's tuple
        // (member.rowOwnership === the derived root tuple — the planner forces
        // it), so the input owner tier is forwarded verbatim to every
        // transitive install, exactly as before the reroute.
        ownerLevel: input.ownerLevel,
        ownerId: input.ownerId,
      },
      resolvedConfig,
    );
    installedTemplateIds.push(res.templateId);
    if (isRootNode) rootTemplateId = res.templateId;
  }
  if (rootTemplateId === null) {
    throw new Error(`Root package ${input.packageName} not present in installed results`);
  }

  // Single reload trigger per full-tree install.
  // installAgentFromPackage does NOT reload on its own (to avoid N reloads
  // for an N-dep tree). This is the canonical single-shot trigger.
  // Failure is non-fatal: durable DB + disk writes have already succeeded;
  // the reload is best-effort and the caller surfaces the result.
  //
  // Log reload failures here so operators see them in container/server logs
  // even when the surrounding caller (extensionRegistry.install via
  // packages/extensions/actions.ts) discards the wayflowReload field on its
  // way to a `{ success: true }` response.
  // triggerWayflowReload is designed to return a typed { ok:false } instead of
  // throwing, but guard defensively (#157): a thrown reload (e.g. an
  // unexpected client error) must NEVER fail a completed full-tree install —
  // the durable DB + disk writes already landed. A throw is mapped to the
  // typed network-failure shape so the return contract is preserved.
  let wayflowReload: ReloadResult;
  try {
    wayflowReload = await triggerWayflowReload();
  } catch (reloadErr) {
    wayflowReload = {
      ok: false,
      reason: "network",
      detail: reloadErr instanceof Error ? reloadErr.message : String(reloadErr),
    };
  }
  if (!wayflowReload.ok) {
    console.warn(
      `[installAgentPackageWithDependencies] wayflow reload returned ok:false reason=${wayflowReload.reason} detail=${wayflowReload.detail ?? "—"} (extension ${input.packageName} is published+installed but the runtime may need a restart or another reload trigger)`,
    );
  }

  return {
    rootTemplateId,
    installedTemplateIds,
    plannedMembers: plan.ordered.map((m) => ({
      packageName: m.packageName,
      version: m.version,
      action: m.action,
      alreadyInstalled: m.alreadyInstalled,
    })),
    wayflowReload,
  };
}
