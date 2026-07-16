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
import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";

/**
 * Deregister every artifact-renderer registration a package made — its semantic
 * detail renderers (across all its types), its representation providers (across
 * all orgs), AND its main-realm dynamic runtime-asset bindings — so an
 * archived/uninstalled extension stops resolving to a renderer in the running
 * process without a restart. Returns what was removed so the caller can guard
 * the control-plane generation bump.
 *
 * REVOCATION-VIA-LIFECYCLE (owner ruling 8, plan §3.1 layer 4 / §5.1.4): the
 * runtime-asset retire is the dynamic-renderer half of this SAME chokepoint —
 * there is NO separate kill-switch / signer-revocation registry. Archiving or
 * deleting an extension drops its admitted runtime binding here; the generation
 * FLOOR is kept as a tombstone by `retireByPackage`, so a delayed straggler from
 * the torn-down epoch cannot resurrect it and a live mount degrades to the
 * never-blank floor on the next resolve (the fail-closed freshness preflight then
 * blocks a cached re-`import()` — `installedActive`/active-digest go false).
 */
export function invalidateArtifactRenderersForPackage(packageName: string): {
  removedSemanticTypes: string[];
  removedRepresentationProviders: number;
  removedRuntimeBindings: number;
} {
  const removedSemanticTypes = semanticRendererRegistry.removeByPackage(packageName);
  const removedRepresentationProviders =
    representationProviderRegistry.retireProvidersByPackage(packageName);
  const removedRuntimeBindings = runtimeAssetRegistry.retireByPackage(packageName);
  return { removedSemanticTypes, removedRepresentationProviders, removedRuntimeBindings };
}
