// Generic in-memory extension capability registries (Inversion of Control caches).
//
// These invert the functional core->extension coupling: instead of host code (or
// a "generic" extension like the Nango gateway) importing a NAMED extension's
// functions, each extension REGISTERS its capability under a stable id, and the
// consumer looks it up by id. The consumer imports zero named extensions.
//
// IMPORTANT (true-IoC spine): a registry built here is a CACHE, never the
// authority. The DB-backed `installed_extension` gate + each kind's native store
// are the source of truth for "what exists and is active"; these in-memory maps
// are materialized projections that MUST support live `remove()`/invalidation so
// an uninstall is reflected immediately, not stranded until process restart.
//
// Every registry is anchored on `globalThis` via a namespaced + versioned Symbol
// (same cross-bundle reason as `action-guard.ts`): Next.js may compile
// `@cinatra-ai/sdk-extensions` into several module instances (server / RSC / route
// segments), and a plain module-level Map would leave the registrant's instance
// and the reader's instance unconnected. The Symbol slot is shared across all
// instances in a process.

interface ExtensionRegistry<T> {
  /** Register (or replace) the capability for `id`. Called once per extension at boot. */
  register(id: string, value: T): void;
  /** Look up by id. Returns undefined when no extension registered for `id`. */
  get(id: string): T | undefined;
  /** True when an extension registered for `id`. */
  has(id: string): boolean;
  /**
   * Remove the registration for `id` (uninstall/invalidate semantics). Returns
   * true if a registration was present. This is what makes the in-memory
   * registry a *cache* and not an append-only authority: when an extension is
   * uninstalled, its cached capability must be removable live, not stranded
   * until process restart.
   */
  remove(id: string): boolean;
  /** All registered entries (registration order not guaranteed). */
  list(): Array<{ id: string; value: T }>;
  /** @internal test-only — clear all registrations. */
  _resetForTests(): void;
}

/**
 * Build a globalThis-anchored registry. `name` must be unique across all
 * registries (it forms the Symbol key). The same `name` from any compiled
 * instance resolves to the same backing Map.
 */
export function createExtensionRegistry<T>(name: string): ExtensionRegistry<T> {
  const KEY = Symbol.for(`@cinatra-ai/sdk-extensions:registry:${name}/v1`);
  type Holder = { [k: symbol]: Map<string, T> | undefined };
  const holder = globalThis as unknown as Holder;
  function backing(): Map<string, T> {
    let map = holder[KEY];
    if (!map) {
      map = new Map<string, T>();
      holder[KEY] = map;
    }
    return map;
  }
  return {
    register(id, value) {
      backing().set(id, value);
    },
    get(id) {
      return backing().get(id);
    },
    has(id) {
      return backing().has(id);
    },
    remove(id) {
      return backing().delete(id);
    },
    list() {
      return [...backing().entries()].map(([id, value]) => ({ id, value }));
    },
    _resetForTests() {
      backing().clear();
    },
  };
}
