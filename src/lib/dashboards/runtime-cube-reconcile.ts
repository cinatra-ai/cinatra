import "server-only";

// Host reconcile orchestrator for runtime cube / portlet contributions
// (cinatra#660 / PR-7). The workflow-install saga's WRITE-5 + its inverse call
// through here. This module owns the SIDE-EFFECTFUL host glue (bump the
// activation generation, mutate the runtime registries, then rebuild the cube
// platform + clear the MCP bridge) so the pure registries stay testable.
//
// Rebuild-whole-platform (codex-converged): there is no incremental
// re-registration window — clearing the platform singleton forces the next
// `getDashboardCubesPlatform()` to recompile the bundled ∪ active-runtime set,
// and clearing the MCP bridge forces it to rebind to the fresh layer (otherwise
// MCP would keep serving the OLD cube list).

import {
  parseRuntimeCubeDescriptors,
  registerRuntimeCubes,
  unregisterRuntimeCubesForPackage,
  type RuntimeCubeOwnerScope,
} from "@cinatra-ai/dashboards/runtime-cube-registry";
import {
  registerRuntimePortletKind,
  unregisterRuntimePortletKindsForPackage,
  hostBundledPortletKinds,
} from "@cinatra-ai/dashboards/extension-materialization";
import {
  basePublishedMembersAccessor,
  clearDashboardCubesPlatformForReconcile,
} from "@cinatra-ai/dashboards/cubes-platform";
import { clearMcpCubeToolsForReconcile } from "@cinatra-ai/dashboards/cubes-mcp-module";
import {
  getActivationGeneration,
  bumpActivationGeneration,
} from "@/lib/extension-activation-generation";

export type RuntimeCubeDescriptorInput = {
  readonly cubeId: string;
  readonly fromTable: string;
  readonly members: readonly string[];
};

export type RuntimePortletKindInput = {
  readonly kind: string;
  readonly version: string;
  readonly rendersAs: string;
};

/**
 * Rebuild the cube platform + MCP bridge after the runtime registries changed.
 * Bumps the process activation generation (the read-model surfaces it) at the
 * lifecycle OUTCOME point and clears BOTH singletons so the next resolve
 * recompiles. `transition` is `activate` on register / `teardown` on
 * unregister.
 */
function rebuildAfterReconcile(transition: "activate" | "teardown", packageName: string): void {
  bumpActivationGeneration(transition, packageName);
  clearDashboardCubesPlatformForReconcile();
  clearMcpCubeToolsForReconcile();
}

/**
 * Register a package's runtime cube descriptors + portlet kinds, then rebuild.
 *
 * Descriptors are RE-VALIDATED here against the live host allowlist (codex-
 * converged: validate every register, not only at preflight) — a descriptor
 * that no longer validates is rejected and NOTHING is registered (fail-closed,
 * all-or-nothing). Portlet kinds are gated through `registerRuntimePortletKind`
 * (rendersAs must resolve to a bundled component). On ANY failure the partial
 * registrations for this package are rolled back and the error re-thrown so the
 * saga compensates.
 */
export async function reconcileRegisterRuntimeContributions(input: {
  packageName: string;
  ownerScope: RuntimeCubeOwnerScope;
  cubeDescriptors: readonly RuntimeCubeDescriptorInput[];
  portletKinds: readonly RuntimePortletKindInput[];
}): Promise<void> {
  const generation = getActivationGeneration();
  // --- cubes ---
  if (input.cubeDescriptors.length > 0) {
    const parsed = parseRuntimeCubeDescriptors(
      input.cubeDescriptors,
      basePublishedMembersAccessor(),
    );
    if (!parsed.ok) {
      throw new Error(`runtime cube reconcile rejected: ${parsed.code}: ${parsed.reason}`);
    }
    const reg = registerRuntimeCubes({
      sourcePackageName: input.packageName,
      ownerScope: input.ownerScope,
      descriptors: parsed.descriptors,
      activationGeneration: generation,
    });
    if (!reg.ok) {
      throw new Error(`runtime cube reconcile rejected: ${reg.code}: ${reg.reason}`);
    }
  }
  // --- portlet kinds ---
  const bundledKinds = new Set(hostBundledPortletKinds());
  try {
    for (const pk of input.portletKinds) {
      const result = registerRuntimePortletKind(
        {
          kind: pk.kind,
          version: pk.version,
          rendersAs: pk.rendersAs,
          sourcePackageName: input.packageName,
          activationGeneration: generation,
        },
        { hasComponentFor: (kind) => bundledKinds.has(kind) },
      );
      if (!result.ok) {
        throw new Error(`runtime portlet kind reconcile rejected: ${result.code}: ${result.reason}`);
      }
    }
  } catch (e) {
    // Roll back this package's partial registrations before propagating.
    unregisterRuntimeCubesForPackage(input.packageName);
    unregisterRuntimePortletKindsForPackage(input.packageName);
    throw e;
  }
  rebuildAfterReconcile("activate", input.packageName);
}

/** Unregister a package's runtime cube/portlet contributions, then rebuild. */
export async function reconcileUnregisterRuntimeContributions(input: {
  packageName: string;
}): Promise<void> {
  const removedCubes = unregisterRuntimeCubesForPackage(input.packageName);
  const removedKinds = unregisterRuntimePortletKindsForPackage(input.packageName);
  if (removedCubes.length > 0 || removedKinds.length > 0) {
    rebuildAfterReconcile("teardown", input.packageName);
  }
}
