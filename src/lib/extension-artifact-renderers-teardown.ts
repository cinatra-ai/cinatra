import "server-only";

// Host adapter: retire an extension's artifact-renderer registrations from the
// process-global arbitration registries on archive/uninstall teardown
// (cinatra#1629, epic #1620 S2, AC-3). Mirror of
// `invalidateObjectTypesForPackage` — the capability-teardown closure names a
// single host symbol rather than reaching into the objects registries directly.
//
// PROCESS-LOCAL + BEST-EFFORT by design: like every in-memory register-channel
// teardown, this clears the CURRENT process. A stale worker that never saw the
// registration renders the FLOOR (the never-blank generic view), never a broken
// renderer — the floor is the safety net, this retirement is the fast path.

import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";

/**
 * Deregister every artifact-renderer registration a package made — its semantic
 * detail renderers (across all its types) AND its representation providers
 * (across all orgs) — so an archived/uninstalled extension stops resolving to a
 * renderer in the running process without a restart. Returns what was removed so
 * the caller can guard the control-plane generation bump.
 */
export function invalidateArtifactRenderersForPackage(packageName: string): {
  removedSemanticTypes: string[];
  removedRepresentationProviders: number;
} {
  const removedSemanticTypes = semanticRendererRegistry.removeByPackage(packageName);
  const removedRepresentationProviders =
    representationProviderRegistry.retireProvidersByPackage(packageName);
  return { removedSemanticTypes, removedRepresentationProviders };
}
