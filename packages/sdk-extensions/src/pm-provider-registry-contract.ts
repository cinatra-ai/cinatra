// Provider-agnostic PM provider REGISTRY — lives in the SDK.
//
// Hosting the Map in the SDK lets BOTH the host PM bridge (which looks providers
// up) and the provider extensions (which register) depend only on
// @cinatra-ai/sdk-extensions, avoiding an sdkOnly coupling edge where every PM
// provider extension (plane-connector) would import a host facade by name to
// self-register. Same design as crm-provider-registry-contract.ts.
//
// The host wiring is ADDITIVE: src/lib/register-pm-providers.ts binds this
// registry's external resolver to the host capability registry at boot, so a
// provider extension's `register(ctx)` doing
// `ctx.capabilities.registerProvider("pm-provider", …)` is surfaced LAZILY on
// every lookup — activation order never matters and a capability teardown is
// reflected immediately.
//
// The Map is anchored on `globalThis` via a namespaced+versioned Symbol so the
// provider's boot-time registration and the host's lookup resolve the SAME Map
// even when Next.js compiles @cinatra-ai/sdk-extensions into more than one module
// instance (server / RSC / route segments / the BullMQ worker). Same
// cross-compilation reasoning as the CRM provider registry + the action-guard /
// a2a / google-oauth DI contracts.

import type { PmConnector } from "./pm-connector-contract";
import { createHostDepsSlot } from "./dependencies";

const PM_PROVIDER_REGISTRY_KEY = Symbol.for(
  "@cinatra-ai/sdk-extensions:pm-provider-registry/v1",
);
type RegistryHolder = { [k: symbol]: Map<string, PmConnector> | undefined };
const _holder = globalThis as unknown as RegistryHolder;

function registry(): Map<string, PmConnector> {
  let map = _holder[PM_PROVIDER_REGISTRY_KEY];
  if (!map) {
    map = new Map<string, PmConnector>();
    _holder[PM_PROVIDER_REGISTRY_KEY] = map;
  }
  return map;
}

// Optional EXTERNAL resolver — the host binds this ONCE at boot to surface PM
// providers that self-registered through the generic capability registry
// (a provider extension's serverEntry doing
// `ctx.capabilities.registerProvider("pm-provider", …)`). Pulled LAZILY on
// every lookup so teardown (capability invalidation) is reflected immediately
// and activation order never matters. Anchored on globalThis for the same
// cross-compilation reason as the Map above. The single-value slot uses the
// shared `createHostDepsSlot` primitive (see ./dependencies); the provider Map
// above stays a hand-rolled keyed registry.
const _externalResolverSlot = createHostDepsSlot<() => readonly PmConnector[]>(
  "@cinatra-ai/sdk-extensions:pm-provider-external-resolver/v1",
);

/**
 * Bind (or clear) the host's lazy external PM-provider resolver. Called once at
 * boot by the host bootstrap; the resolver typically reads the host capability
 * registry and structurally validates each impl before returning it.
 */
export function setPmProviderExternalResolver(
  resolver: (() => readonly PmConnector[]) | null,
): void {
  _externalResolverSlot.set(resolver);
}

function externalProviders(): readonly PmConnector[] {
  const resolver = _externalResolverSlot.get();
  if (!resolver) return [];
  try {
    return resolver();
  } catch {
    // A broken external resolver must never take down direct registrations.
    return [];
  }
}

/**
 * Register a concrete PM provider. Called at boot (host
 * register-pm-providers.ts → the provider extension's registerXProvider()).
 * Keyed by providerId — re-registering the same id replaces (idempotent boot).
 */
export function registerPmProvider(provider: PmConnector): void {
  registry().set(provider.providerId, provider);
}

/**
 * Resolve a registered provider by id, or null if none is registered. Direct
 * registrations win over external (capability-resolved) providers with the
 * same providerId.
 */
export function lookupPmProvider(providerId: string): PmConnector | null {
  const direct = registry().get(providerId);
  if (direct) return direct;
  return externalProviders().find((p) => p.providerId === providerId) ?? null;
}

/** All registered providers (boot diagnostics / multi-provider resolution). */
export function listPmProviders(): PmConnector[] {
  const out = new Map<string, PmConnector>();
  for (const p of externalProviders()) out.set(p.providerId, p);
  // Direct registrations override external ones with the same id.
  for (const [id, p] of registry()) out.set(id, p);
  return Array.from(out.values());
}

/** @internal test-only — clear the registry so a fresh wiring is required. */
export function _resetPmProviderRegistry(): void {
  registry().clear();
  _externalResolverSlot.reset();
}
