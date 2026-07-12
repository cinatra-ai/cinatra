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
// the org-binary (see ./dependency-plan-adapter.ts for the ratified seams).
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
import {
  agentRowOwnershipFromInstallInput,
  buildAgentDependencyPlanDeps,
} from "./dependency-plan-adapter";
import type { InstallActorRoleBag } from "./install-target-authz";

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
  const rowOwnership = agentRowOwnershipFromInstallInput(input);
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
        // resolution verbatim (exact version, semver range, or dist-tag;
        // absent → latest). The old resolver's "*" default and "latest"
        // resolve to the same packument pick.
        version: input.packageVersion ?? "latest",
      },
      orgId: input.orgId ?? null,
      rowOwnership,
      // The direct agent path is never the gatekept marketplace closure — root
      // authorization stays with the callers' authz gates (which ran before
      // this function), exactly as it did for the deleted resolver.
      closure: null,
    },
    planDeps,
  );

  const installedTemplateIds: string[] = [];
  let rootTemplateId: string | null = null;
  for (const member of plan.ordered) {
    const isRootNode = member.packageName === input.packageName;
    // Saga semantics: a member already installed at the exact pin is skipped.
    // The ROOT always executes — installing/updating over an existing root is
    // the flow the caller chose (reinstall/refresh keeps working).
    if (member.alreadyInstalled && !isRootNode) continue;
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
