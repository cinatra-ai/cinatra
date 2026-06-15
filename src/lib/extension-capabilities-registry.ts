import "server-only";

import type {
  KnownCapabilityId,
  ResolvedCapabilityProvider,
} from "@cinatra-ai/sdk-extensions";

// Generic, host-owned capability-provider registry.
//
// A connector advertises what it can DO behind a CAPABILITY facade (e.g. the
// `email-send` capability is served by `resend` OR `gmail`) instead of dependents
// importing a concrete sibling package. At `register(ctx)` an extension calls
// `ctx.capabilities.registerProvider(capability, { packageName, impl })`; a
// consumer calls `ctx.capabilities.resolveProviders(capability)` to get the live
// providers — neither side imports the other's package.
//
// This registry is HOST-OWNED and imports NO connector. It REPLACES the prototype
// `makeCapabilities` that hardcoded the `email-send` capability and imported
// `@cinatra-ai/email-connector` directly (the host itself was violating the
// extension-boundary rule). Providers are now data, registered at activation —
// never baked into the host.
//
// Active-manifest gating is realized by the LIFECYCLE — not a resolve-time DB
// read (`resolveProviders` is synchronous by ABI):
//   - REGISTRATION is activation-gated: an archived/uninstalled extension never
//     activates (the StaticBundleLoader archived-row tombstone gate), so it never
//     calls `registerProvider` — its provider is never in the registry.
//   - TEARDOWN: `invalidateProvidersForPackage(pkg)` drops every provider a
//     package registered, across all capabilities. The host wires it into the
//     extension capability-teardown hook (`src/lib/extensions.ts`), which the
//     purge saga fires after the DB delete commits.
// Therefore the set of registered providers IS the set of live providers, and
// `resolveProviders` returns exactly that — mirroring the proven
// `extension-mcp-registry` (register-on-activate / removeByPackage-on-teardown)
// model. (Live archive-without-restart of a compiled extension is a
// runtime-installer concern; there is no such transition for a compiled extension.)

export type CapabilityProvider = {
  packageName: string;
  impl: unknown;
};

// capability -> (packageName -> provider). One provider per package per
// capability; a re-registration REPLACES (idempotent — boot may re-activate).
//
// CROSS-COMPILATION SINGLETON: Next.js 16 builds separate bundler compilations
// (instrumentation / route / RSC), each with its own module cache. Extensions
// register providers at boot/activation (instrumentation compilation); consumers
// resolve them at request time (route / RSC compilation) — so the registry MUST
// be a true per-process singleton, anchored on a namespaced+versioned
// `Symbol.for(...)` key (same pattern as `extension-mcp-registry`). A plain
// module-level `const` Map would be re-instantiated per compilation, so post-boot
// registrations would be invisible to the compilation that resolves them.
const CAPABILITY_REGISTRY_KEY = Symbol.for(
  "@cinatra-ai/host:extension-capabilities-registry/v1",
);
type CapabilityRegistryHolder = {
  [k: symbol]: Map<string, Map<string, CapabilityProvider>> | undefined;
};
const _holder = globalThis as unknown as CapabilityRegistryHolder;
const registry: Map<string, Map<string, CapabilityProvider>> =
  _holder[CAPABILITY_REGISTRY_KEY] ??
  (_holder[CAPABILITY_REGISTRY_KEY] = new Map<string, Map<string, CapabilityProvider>>());

/**
 * Register (or idempotently replace) a provider for a capability. Keyed by
 * `packageName` so re-activation of the same package is a no-op replace, never
 * a duplicate.
 */
export function registerCapabilityProvider(
  capability: string,
  provider: CapabilityProvider,
): void {
  if (!provider?.packageName) {
    throw new Error(
      `[capabilities] a provider for "${capability}" was registered with no packageName`,
    );
  }
  let byPackage = registry.get(capability);
  if (!byPackage) {
    byPackage = new Map<string, CapabilityProvider>();
    registry.set(capability, byPackage);
  }
  byPackage.set(provider.packageName, provider);
}

/**
 * Resolve the live providers for a capability. The registered set IS the live
 * set (registration is activation-gated; teardown invalidates), so this returns
 * a fresh array of the registered providers (callers may sort/filter without
 * mutating the registry).
 *
 * ADDITIVE typed overload (mirrors `HostCapabilitiesPort.resolveProviders`): for
 * a first-party capability id KNOWN to `CapabilityContractMap` the returned
 * `impl` is typed to the mapped surface, so the host's resolver modules stop
 * hand-writing `impl as Partial<TSurface>`. The open `string` overload is kept
 * (returns `impl: unknown`). This narrows the COMPILE type only — the registry
 * still stores `unknown`, so the structural `isXSurface` guards in those modules
 * remain the runtime trust boundary.
 */
export function resolveCapabilityProviders<Id extends KnownCapabilityId>(
  capability: Id,
): ResolvedCapabilityProvider<Id>[];
export function resolveCapabilityProviders(capability: string): CapabilityProvider[];
export function resolveCapabilityProviders(capability: string): CapabilityProvider[] {
  const byPackage = registry.get(capability);
  if (!byPackage) return [];
  return [...byPackage.values()];
}

/**
 * Remove every provider a package registered, across all capabilities. The host
 * wires this into the extension capability-teardown hook
 * (`src/lib/extensions.ts`), which the purge saga fires after the DB delete
 * commits — so a removed extension leaves no stale provider.
 */
export function invalidateProvidersForPackage(packageName: string): void {
  for (const byPackage of registry.values()) {
    byPackage.delete(packageName);
  }
}

/** Test/teardown helper — clears all providers. */
export function __resetCapabilityRegistry(): void {
  registry.clear();
}
