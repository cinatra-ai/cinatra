import "server-only";

// Host adapter: deregister an extension's object types from the process-global
// objectTypeRegistry on archive/uninstall teardown.
//
// The registry lives in `@cinatra-ai/objects` and is keyed by type id; package
// provenance is recorded at registration time (via the optional `packageName`
// arg passed by `ctx.objects.registerType`). This wrapper exists so the extension
// teardown hook (`src/lib/extensions.ts`) can name a single host symbol — mirror
// of `invalidateProvidersForPackage` / `invalidateExtensionUiForPackage` — rather
// than reaching into the objects registry directly.

import { objectTypeRegistry, matcherManifestRegistry } from "@cinatra-ai/objects";

/**
 * Remove every object type the package registered (across all categories),
 * returning the removed type ids. Safe no-op for a package that registered no
 * types (or registered without provenance — built-in/host types are never
 * touched). In-memory only: the running process stops resolving/listing the
 * types without a restart; durable rows (if any) are handled separately.
 */
export function invalidateObjectTypesForPackage(packageName: string): string[] {
  return objectTypeRegistry.removeByPackage(packageName);
}

/**
 * Remove the package's MEANING-SURFACE channel entry (cinatra#1891 A3) — the
 * pack-wide matcher manifest the matcher runtime discovers candidates from and
 * the presentation host resolves thresholds + matcher liveness from. Returns
 * true iff an entry was removed. Wired into the central capability teardown at
 * PARITY with the object-type reap: a matcher-ONLY pack (no own object type)
 * registers nothing in the object-type registry, so WITHOUT this a leaked
 * channel entry would keep its matcher draft auto-surfacing after uninstall. In-
 * memory only; the org-scoped install-status gate is the durable backstop.
 */
export function invalidateMatcherManifestForPackage(packageName: string): boolean {
  return matcherManifestRegistry.removeByPackage(packageName);
}

/**
 * A read-only diagnostic snapshot of the registered object types — type id +
 * category only (never the descriptor / ioSpec). For the operator control-plane
 * endpoint. Lists ALL registered types (host built-ins + extension types); the ids
 * are namespaced so a reader can tell extension types from host ones.
 */
export function snapshotObjectTypes(): { type: string; category?: string }[] {
  return objectTypeRegistry.list().map((def) => ({
    type: def.type,
    ...(def.category !== undefined ? { category: def.category as string } : {}),
  }));
}
