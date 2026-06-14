// Provider-agnostic CRM provider REGISTRY — lives in the SDK.
//
// Hosting the Map in the SDK lets BOTH the crm-connector facade (which looks
// providers up) and the provider extensions (which register) depend only on
// @cinatra-ai/sdk-extensions, avoiding an sdkOnly coupling edge where every CRM
// provider extension (twenty-connector) would import @cinatra-ai/crm-connector by
// name to self-register.
//
// The host wiring is ADDITIVE: src/lib/register-crm-providers.ts calls
// twenty-connector's registerTwentyProvider() at boot, which registers into this
// SDK-hosted Map. crm-connector/src/registry.ts re-exports these for
// backward-compat.
//
// The Map is anchored on `globalThis` via a namespaced+versioned Symbol so the
// provider's boot-time registration and the facade's lookup resolve the SAME Map
// even when Next.js compiles @cinatra-ai/sdk-extensions into more than one module
// instance (server / RSC / route segments / the BullMQ worker). Same
// cross-compilation reasoning as the action-guard + a2a/google-oauth DI contracts.

import type { CrmConnector } from "./crm-connector-contract";
import { createHostDepsSlot } from "./dependencies";

const CRM_PROVIDER_REGISTRY_KEY = Symbol.for(
  "@cinatra-ai/sdk-extensions:crm-provider-registry/v1",
);
type RegistryHolder = { [k: symbol]: Map<string, CrmConnector> | undefined };
const _holder = globalThis as unknown as RegistryHolder;

function registry(): Map<string, CrmConnector> {
  let map = _holder[CRM_PROVIDER_REGISTRY_KEY];
  if (!map) {
    map = new Map<string, CrmConnector>();
    _holder[CRM_PROVIDER_REGISTRY_KEY] = map;
  }
  return map;
}

// Optional EXTERNAL resolver — the host binds this ONCE at boot to surface CRM
// providers that self-registered through the generic capability registry
// (a provider extension's serverEntry doing
// `ctx.capabilities.registerProvider("crm-provider", …)`). Pulled LAZILY on
// every lookup so teardown (capability invalidation) is reflected immediately
// and activation order never matters. Anchored on globalThis for the same
// cross-compilation reason as the Map above.
// The external-resolver slot is a single nullable value, so it uses the shared
// `createHostDepsSlot` primitive (see ./dependencies); the slot identity (the
// `Symbol.for` key) is unchanged. The provider Map above stays a hand-rolled
// registry (a keyed collection, not a single-value slot).
const _externalResolverSlot = createHostDepsSlot<() => readonly CrmConnector[]>(
  "@cinatra-ai/sdk-extensions:crm-provider-external-resolver/v1",
);

/**
 * Bind (or clear) the host's lazy external CRM-provider resolver. Called once
 * at boot by the host bootstrap; the resolver typically reads the host
 * capability registry and structurally validates each impl before returning it.
 */
export function setCrmProviderExternalResolver(
  resolver: (() => readonly CrmConnector[]) | null,
): void {
  _externalResolverSlot.set(resolver);
}

function externalProviders(): readonly CrmConnector[] {
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
 * Register a concrete CRM provider. Called at boot (host
 * register-crm-providers.ts → the provider extension's registerXProvider()).
 * Keyed by providerId — re-registering the same id replaces (idempotent boot).
 */
export function registerCrmProvider(provider: CrmConnector): void {
  registry().set(provider.providerId, provider);
}

/**
 * Resolve a registered provider by id, or null if none is registered. Direct
 * registrations win over external (capability-resolved) providers with the
 * same providerId.
 */
export function lookupCrmProvider(providerId: string): CrmConnector | null {
  const direct = registry().get(providerId);
  if (direct) return direct;
  return externalProviders().find((p) => p.providerId === providerId) ?? null;
}

/** All registered providers (boot diagnostics / multi-provider resolution). */
export function listCrmProviders(): CrmConnector[] {
  const out = new Map<string, CrmConnector>();
  for (const p of externalProviders()) out.set(p.providerId, p);
  // Direct registrations override external ones with the same id.
  for (const [id, p] of registry()) out.set(id, p);
  return Array.from(out.values());
}

/** @internal test-only — clear the registry so a fresh wiring is required. */
export function _resetCrmProviderRegistry(): void {
  registry().clear();
  _externalResolverSlot.reset();
}
