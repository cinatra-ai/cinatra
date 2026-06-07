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

/**
 * Register a concrete CRM provider. Called at boot (host
 * register-crm-providers.ts → the provider extension's registerXProvider()).
 * Keyed by providerId — re-registering the same id replaces (idempotent boot).
 */
export function registerCrmProvider(provider: CrmConnector): void {
  registry().set(provider.providerId, provider);
}

/** Resolve a registered provider by id, or null if none is registered. */
export function lookupCrmProvider(providerId: string): CrmConnector | null {
  return registry().get(providerId) ?? null;
}

/** All registered providers (boot diagnostics / multi-provider resolution). */
export function listCrmProviders(): CrmConnector[] {
  return Array.from(registry().values());
}

/** @internal test-only — clear the registry so a fresh wiring is required. */
export function _resetCrmProviderRegistry(): void {
  registry().clear();
}
