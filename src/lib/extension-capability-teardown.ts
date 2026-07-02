import "server-only";

// Single source of truth for the in-memory capability teardown closure the host
// wires into `setExtensionCapabilityTeardownHook` (see src/lib/extensions.ts).
//
// Kept in its own LIGHTWEIGHT module so the invariant test can import the EXACT
// production closure WITHOUT pulling `src/lib/extensions.ts`'s heavy handler graph
// (agents/skills/workflows + separate-repo connector packages). It depends only
// on the host-owned `invalidate*ForPackage` registries — the kinds that have an
// in-process `register(ctx)` channel: { MCP tools, capability providers,
// ctx.ui surfaces/actions, object types, runtime dashboard cubes/portlet kinds }.
// If a new in-memory register-channel kind is ever added, THIS closure must grow.
// The per-kind-teardown invariant test asserts this exact function's current
// contract — it catches a DROPPED kind; a newly-added un-wired register-channel
// would need the test expanded too.

import { removeExtensionMcpToolsForPackage } from "@/lib/extension-mcp-registry";
import {
  invalidateProvidersForPackage,
  hasCapabilityProvidersForPackage,
} from "@/lib/extension-capabilities-registry";
import { invalidateExtensionUiForPackage, hasExtensionUiForPackage } from "@/lib/extension-ui-registry";
import { invalidateObjectTypesForPackage } from "@/lib/extension-object-types-teardown";
import { bumpActivationGeneration } from "@/lib/extension-activation-generation";
// Runtime dashboard-cube + portlet-kind registries (cinatra#660). These are pure
// in-memory maps; unregistering is cheap and importing them does NOT build the
// pg-backed cube platform (that stays lazy). Clearing the platform + MCP bridge
// singletons (also cheap — just globalThis ref clears) forces the next resolve
// to recompile WITHOUT the torn-down cubes.
import { unregisterRuntimeCubesForPackage } from "@cinatra-ai/dashboards/runtime-cube-registry";
import { unregisterRuntimePortletKindsForPackage } from "@cinatra-ai/dashboards/extension-materialization";
import { clearDashboardCubesPlatformForReconcile } from "@cinatra-ai/dashboards/cubes-platform";
import { clearMcpCubeToolsForReconcile } from "@cinatra-ai/dashboards/cubes-mcp-module";

/** Tear down ALL in-memory register(ctx) registrations a purged/archived/uninstalled
 *  package made — its MCP tools, capability providers, ctx.ui surfaces/actions, and
 *  object types — so it is no longer listable/invocable/resolvable in the running
 *  process without a restart. Wired as the host capability teardown hook.
 *
 *  CONTROL-PLANE GENERATION (#310): this hook is the single in-process chokepoint
 *  for ALL four retire paths (archive / uninstall / force-delete / purge), so a
 *  generation bump here covers them all with one truthful `teardown` transition.
 *  But the hook also fires DEFENSIVELY before a clean install / re-activate (so a
 *  re-activate REPLACES rather than stacks), where nothing was actually registered
 *  yet — so the bump is GUARDED on actual removals: it only fires when the package
 *  truly had a live registration of ANY of the four kinds (MCP tools, capability
 *  providers, ctx.ui surfaces/actions, object types) in the registry. All four are
 *  in the operator control-plane snapshot, so removing any of them IS an observable
 *  control-plane change. This keeps a no-op defensive teardown from emitting a
 *  spurious generation while still invalidating the generation-keyed caches the
 *  moment a package's registrations actually leave the live surface. */
export function teardownExtensionCapabilities(packageName: string): {
  removedTools: string[];
  removedTypes: string[];
  removedCubes: string[];
  removedPortletKinds: string[];
} {
  // Capture the void-delete kinds' presence BEFORE invalidating (those
  // `invalidate*` calls return no count of their own, so probe up front).
  const hadUi = hasExtensionUiForPackage(packageName);
  const hadProviders = hasCapabilityProvidersForPackage(packageName);
  const removedTools = removeExtensionMcpToolsForPackage(packageName);
  invalidateProvidersForPackage(packageName);
  invalidateExtensionUiForPackage(packageName);
  // Deregister the package's object types so an archived/uninstalled extension's
  // types stop resolving/listing in the running process without a restart.
  const removedTypes = invalidateObjectTypesForPackage(packageName);
  // Runtime dashboard cubes + portlet kinds (cinatra#660): unregister so a
  // disabled/uninstalled extension's runtime cube stops serving (the serve-gate
  // also denies it via the now-non-live install row) and its portlet kind stops
  // resolving. Rebuild the platform + MCP bridge so the catalog reflects it.
  const removedCubes = unregisterRuntimeCubesForPackage(packageName);
  const removedPortletKinds = unregisterRuntimePortletKindsForPackage(packageName);
  if (removedCubes.length > 0 || removedPortletKinds.length > 0) {
    clearDashboardCubesPlatformForReconcile();
    clearMcpCubeToolsForReconcile();
  }

  // GUARDED bump: only when this teardown actually removed a live registration of
  // ANY kind (covers a provider-only or cube-only package too).
  if (
    removedTools.length > 0 ||
    removedTypes.length > 0 ||
    hadUi ||
    hadProviders ||
    removedCubes.length > 0 ||
    removedPortletKinds.length > 0
  ) {
    bumpActivationGeneration("teardown", packageName);
  }
  return { removedTools, removedTypes, removedCubes, removedPortletKinds };
}
