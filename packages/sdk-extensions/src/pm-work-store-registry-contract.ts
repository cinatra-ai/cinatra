// Provider-agnostic PM WORK-STORE provider REGISTRY — lives in the SDK.
//
// Hosting the Map in the SDK lets BOTH the host PM store bridge (which looks
// providers up) and the provider extensions (which register) depend only on
// @cinatra-ai/sdk-extensions, avoiding a coupling edge where every PM store
// provider extension (plane-connector) would import a host facade by name to
// self-register. Same design as pm-provider-registry-contract.ts and
// crm-provider-registry-contract.ts — but a SEPARATE registry, keyed by a
// SEPARATE capability (`pm-work-store`, not `pm-provider`), so the two PM seams
// (the trigger-mirror `PmConnector` and this work-item CRUD `PmWorkStore`)
// evolve independently and a CRUD-only provider need not implement the mirror.
//
// The host wiring is ADDITIVE: src/lib/register-pm-work-store-providers.ts binds
// this registry's external resolver to the host capability registry at boot, so
// a provider extension's `register(ctx)` doing
// `ctx.capabilities.registerProvider("pm-work-store", …)` is surfaced LAZILY on
// every lookup — activation order never matters and a capability teardown is
// reflected immediately.
//
// The Map is anchored on `globalThis` via a namespaced+versioned Symbol so the
// provider's boot-time registration and the host's lookup resolve the SAME Map
// even when Next.js compiles @cinatra-ai/sdk-extensions into more than one module
// instance (server / RSC / route segments / the BullMQ worker). Same
// cross-compilation reasoning as the PM/CRM provider registries.

import type { PmWorkStore } from "./pm-work-store-contract";
import { createHostDepsSlot } from "./dependencies";

const PM_WORK_STORE_REGISTRY_KEY = Symbol.for(
  "@cinatra-ai/sdk-extensions:pm-work-store-registry/v1",
);
type RegistryHolder = { [k: symbol]: Map<string, PmWorkStore> | undefined };
const _holder = globalThis as unknown as RegistryHolder;

function registry(): Map<string, PmWorkStore> {
  let map = _holder[PM_WORK_STORE_REGISTRY_KEY];
  if (!map) {
    map = new Map<string, PmWorkStore>();
    _holder[PM_WORK_STORE_REGISTRY_KEY] = map;
  }
  return map;
}

// Optional EXTERNAL resolver — the host binds this ONCE at boot to surface PM
// work-store providers that self-registered through the generic capability
// registry (a provider extension's serverEntry doing
// `ctx.capabilities.registerProvider("pm-work-store", …)`). Pulled LAZILY on
// every lookup so teardown (capability invalidation) is reflected immediately
// and activation order never matters. Anchored on globalThis for the same
// cross-compilation reason as the Map above.
const _externalResolverSlot = createHostDepsSlot<() => readonly PmWorkStore[]>(
  "@cinatra-ai/sdk-extensions:pm-work-store-external-resolver/v1",
);

/**
 * Bind (or clear) the host's lazy external PM work-store resolver. Called once
 * at boot by the host bootstrap; the resolver typically reads the host
 * capability registry and structurally validates each impl before returning it.
 */
export function setPmWorkStoreExternalResolver(
  resolver: (() => readonly PmWorkStore[]) | null,
): void {
  _externalResolverSlot.set(resolver);
}

function externalProviders(): readonly PmWorkStore[] {
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
 * Register a concrete PM work-store provider. Called at boot (host
 * register-pm-work-store-providers.ts → the provider extension's
 * registerXProvider()). Keyed by providerId — re-registering the same id
 * replaces (idempotent boot).
 */
export function registerPmWorkStore(provider: PmWorkStore): void {
  registry().set(provider.providerId, provider);
}

/**
 * Resolve a registered work-store provider by id, or null if none is
 * registered. Direct registrations win over external (capability-resolved)
 * providers with the same providerId.
 */
export function lookupPmWorkStore(providerId: string): PmWorkStore | null {
  const direct = registry().get(providerId);
  if (direct) return direct;
  return externalProviders().find((p) => p.providerId === providerId) ?? null;
}

/** All registered work-store providers (boot diagnostics / multi-provider). */
export function listPmWorkStores(): PmWorkStore[] {
  const out = new Map<string, PmWorkStore>();
  for (const p of externalProviders()) out.set(p.providerId, p);
  // Direct registrations override external ones with the same id.
  for (const [id, p] of registry()) out.set(id, p);
  return Array.from(out.values());
}

/** @internal test-only — clear the registry so a fresh wiring is required. */
export function _resetPmWorkStoreRegistry(): void {
  registry().clear();
  _externalResolverSlot.reset();
}
