import "server-only";

// Host-side resolution of `llm-provider-surface` capability providers (the
// lazy/guarded host-access cutover): each LLM connector registers its
// settings/status/catalog surface (readers, writers, gated actions) from its
// own `register(ctx)`; the host's consumers — campaign actions, the
// setup/telemetry/logging pages, the connection-status and llm-access test
// routes, the setup wizard, dev auto-connect — resolve them HERE at call time,
// never by value-importing a connector package.
//
// Degraded mode: surface absent (connector not installed/active) → null /
// omitted from lists; each consumer degrades per feature (a 400/disabled row/
// not-ready state/descriptive error — never a crash).

import type {
  LlmProviderSurface,
  LlmProviderAdapterSurface,
  LlmSkillDeliveryAdapterSurface,
} from "@cinatra-ai/sdk-extensions";
// llm-providers S4 (cinatra#1715) / S4.x (cinatra#1964): the adapter-surface
// ABI-version literals are author-facing PUBLIC (like `LLM_PROVIDER_ABI_VERSION`
// / `SDK_EXTENSIONS_ABI_VERSION`); the capability-id constants stay host-fenced
// behind ./internal.
import {
  LLM_PROVIDER_ADAPTER_ABI_VERSION,
  LLM_SKILL_DELIVERY_ADAPTER_ABI_VERSION,
} from "@cinatra-ai/sdk-extensions";
import {
  LLM_PROVIDER_SURFACE_CAPABILITY,
  LLM_PROVIDER_ADAPTER_CAPABILITY,
  LLM_SKILL_DELIVERY_ADAPTER_CAPABILITY,
} from "@cinatra-ai/sdk-extensions/internal";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

// Structural guard: a capability impl is `unknown` by contract. Members are
// all-optional by design — consumers optional-chain what they use.
function isLlmProviderSurface(impl: unknown): impl is LlmProviderSurface {
  if (typeof impl !== "object" || impl === null) return false;
  const candidate = impl as { providerId?: unknown };
  return typeof candidate.providerId === "string" && candidate.providerId.length > 0;
}

/** All live LLM provider surfaces (order = registration order). */
export function listLlmProviderSurfaces(): LlmProviderSurface[] {
  return resolveCapabilityProviders(LLM_PROVIDER_SURFACE_CAPABILITY)
    .map((p) => p.impl)
    .filter(isLlmProviderSurface);
}

/** The live surface for ONE provider id, or null when absent (degraded). */
export function getLlmProviderSurface(providerId: string): LlmProviderSurface | null {
  return listLlmProviderSurfaces().find((s) => s.providerId === providerId) ?? null;
}

/** Fail-loud variant for actions that cannot proceed without the provider. */
export function requireLlmProviderSurface(providerId: string): LlmProviderSurface {
  const surface = getLlmProviderSurface(providerId);
  if (!surface) {
    throw new Error(
      `The "${providerId}" LLM provider connector is not installed/active — ` +
        `install/activate it before using this setting.`,
    );
  }
  return surface;
}

// ===========================================================================
// LLM provider ADAPTER surface (llm-providers S4 — cinatra#1715, epic #1711).
//
// The runtime DISPATCH-ADAPTER channel — DISTINCT from `llm-provider-surface`
// above (settings/status/catalog). Co-located here (rather than a new module)
// so it adds NO net-new route-reachable module to the locked FIXED_ROUTES graph
// — every import it needs is already reachable from this file, so the
// route-graph-ratchet baseline is unchanged.
//
// Each LLM connector will register its request-translation adapter FACTORY at
// activation under `LLM_PROVIDER_ADAPTER_CAPABILITY`; core's `packages/llm`
// (`resolveProviderAdapter`) resolves the provider adapter from the CONNECTOR
// instead of value-importing an in-core `providers/*` module — the strict
// core/extension border the epic ratifies (core keeps only the vocabulary,
// resolvers, and enforcement). TRANSITIONAL in this first slice: no connector
// registers this surface yet, so `getLlmProviderAdapterSurface` returns null for
// every provider and `resolveProviderAdapter` takes its legacy in-core fallback
// (ZERO behavior change).
//
// TRUST BOUNDARY (squatting mitigation) is enforced UPSTREAM, at the
// `ctx.capabilities` port: `LLM_PROVIDER_ADAPTER_CAPABILITY` is a
// RESERVED_SYSTEM_CAPABILITY (extension-host-context.ts), so a NON-first-party
// extension registering it THROWS (anti-poisoning — the shadow adapter never
// enters the registry) and resolving it gets [] — the LLM data plane is
// first-party only (epic #1711 v1 non-goal: no runtime-installed third-party
// provider adapters). This resolver therefore trusts that every registrant is
// first-party and enforces the two remaining fail-closed rules:
//   1. VERSIONED: a surface must declare the exact `abiVersion` this host knows
//      (`LLM_PROVIDER_ADAPTER_ABI_VERSION`) — an unknown version is refused, not
//      silently downgraded to the legacy factory.
//   2. MALFORMED / COLLISION != ABSENT: if ANY registration that CLAIMS a
//      provider is malformed, or MORE THAN ONE claims the same provider
//      (ambiguous ownership), resolution FAILS CLOSED (throws) — it must never
//      collapse into "absent" and re-activate the legacy in-core fallback (that
//      would mask a real connector bug or let one registration silently mask a
//      broken/duplicate sibling). Only a genuine ABSENCE (no registration claims
//      the provider) falls back.

/** Does this impl CLAIM `providerId` (structurally an object with that exact
 * providerId string)? Decides whether a registration is even ABOUT this provider
 * before it is validated in full. */
function adapterSurfaceClaimsProvider(impl: unknown, providerId: string): boolean {
  return (
    typeof impl === "object" &&
    impl !== null &&
    (impl as { providerId?: unknown }).providerId === providerId
  );
}

/** Full structural + version validity of a claimed adapter surface. A claimed-
 * but-invalid surface is a hard error (never treated as absent). */
function isValidLlmProviderAdapterSurface(impl: unknown): impl is LlmProviderAdapterSurface {
  if (typeof impl !== "object" || impl === null) return false;
  const c = impl as { providerId?: unknown; abiVersion?: unknown; createAdapter?: unknown };
  return (
    typeof c.providerId === "string" &&
    c.providerId.length > 0 &&
    c.abiVersion === LLM_PROVIDER_ADAPTER_ABI_VERSION &&
    typeof c.createAdapter === "function"
  );
}

/**
 * The live adapter surface for one provider id, or `null` when ABSENT (no
 * registration claims it — the caller falls back to the legacy in-core factory).
 *
 * FAIL-CLOSED (never returns a masking result): if ANY registration that claims
 * this provider is malformed (wrong `abiVersion` / non-callable `createAdapter`),
 * or MORE THAN ONE registration claims it (ambiguous ownership), this THROWS
 * rather than returning a surface — a registered-but-broken or duplicate adapter
 * must never silently resolve (and a valid sibling must never mask a malformed
 * one). Trust (first-party-only) is enforced upstream by the
 * RESERVED_SYSTEM_CAPABILITY port fence, so every claimant here is first-party.
 */
export function getLlmProviderAdapterSurface(providerId: string): LlmProviderAdapterSurface | null {
  const claimants = resolveCapabilityProviders(LLM_PROVIDER_ADAPTER_CAPABILITY).filter((p) =>
    adapterSurfaceClaimsProvider(p.impl, providerId),
  );

  if (claimants.length === 0) return null; // genuinely ABSENT -> caller falls back

  // Fail closed on ANY malformed claimant — a valid sibling must NOT mask it
  // (Codex round-2 finding).
  const malformed = claimants.filter((p) => !isValidLlmProviderAdapterSurface(p.impl));
  if (malformed.length > 0) {
    throw new Error(
      `The "${providerId}" llm-provider-adapter surface is registered but malformed ` +
        `(expected abiVersion ${LLM_PROVIDER_ADAPTER_ABI_VERSION} and a callable createAdapter) — ` +
        `refusing to resolve it (fail closed).`,
    );
  }
  // Ambiguous ownership: exactly one connector may own a provider's adapter.
  if (claimants.length > 1) {
    const owners = claimants.map((p) => p.packageName).join(", ");
    throw new Error(
      `Multiple llm-provider-adapter surfaces claim provider "${providerId}" (${owners}) — ` +
        `ambiguous ownership; refusing to resolve (fail closed).`,
    );
  }
  return claimants[0].impl as LlmProviderAdapterSurface;
}

// ===========================================================================
// LLM SKILL-DELIVERY adapter surface (llm-providers S4.x — cinatra#1964).
//
// A SIBLING channel to `llm-provider-adapter` above, resolved by the SAME
// fail-closed rules. Co-located here (rather than a new module) so it adds NO
// net-new route-reachable module to the locked FIXED_ROUTES graph — every
// import it needs is already reachable from this file.
//
// Each LLM connector will register its provider-specific SKILL-DELIVERY adapter
// FACTORY at activation under `LLM_SKILL_DELIVERY_ADAPTER_CAPABILITY`; core's
// `packages/llm` (`selectSkillDeliveryAdapter`) resolves the adapter from the
// CONNECTOR instead of the hardcoded in-core switch. TRANSITIONAL in this first
// slice: no connector registers this surface yet, so
// `getLlmSkillDeliveryAdapterSurface` returns null for every provider and
// `selectSkillDeliveryAdapter` takes its legacy in-core fallback (ZERO behavior
// change).
//
// TRUST + FAIL-CLOSED rules are IDENTICAL to `llm-provider-adapter`:
//   - first-party-only is enforced UPSTREAM at the `ctx.capabilities`
//     RESERVED_SYSTEM_CAPABILITY port (`LLM_SKILL_DELIVERY_ADAPTER_CAPABILITY`
//     in extension-host-context.ts): a non-first-party REGISTER throws and
//     RESOLVE gets []. Every claimant here is therefore first-party.
//   - VERSIONED: a surface must declare the exact
//     `LLM_SKILL_DELIVERY_ADAPTER_ABI_VERSION` — unknown is refused, never
//     silently downgraded to the legacy in-core adapter.
//   - MALFORMED / COLLISION != ABSENT: any malformed claimant, or more than one
//     claimant for the same provider, FAILS CLOSED (throws) — a valid sibling
//     must never mask a malformed one, and only a genuine ABSENCE (no claimant)
//     falls back to the legacy in-core adapter.

/** Does this impl CLAIM `providerId`? Decides whether a registration is even
 * ABOUT this provider before it is validated in full. */
function skillDeliverySurfaceClaimsProvider(impl: unknown, providerId: string): boolean {
  return (
    typeof impl === "object" &&
    impl !== null &&
    (impl as { providerId?: unknown }).providerId === providerId
  );
}

/** Full structural + version validity of a claimed skill-delivery surface. A
 * claimed-but-invalid surface is a hard error (never treated as absent). */
function isValidLlmSkillDeliveryAdapterSurface(
  impl: unknown,
): impl is LlmSkillDeliveryAdapterSurface {
  if (typeof impl !== "object" || impl === null) return false;
  const c = impl as {
    providerId?: unknown;
    abiVersion?: unknown;
    createSkillDeliveryAdapter?: unknown;
  };
  return (
    typeof c.providerId === "string" &&
    c.providerId.length > 0 &&
    c.abiVersion === LLM_SKILL_DELIVERY_ADAPTER_ABI_VERSION &&
    typeof c.createSkillDeliveryAdapter === "function"
  );
}

/**
 * The live skill-delivery adapter surface for one provider id, or `null` when
 * ABSENT (no registration claims it — the caller falls back to the legacy
 * in-core adapter).
 *
 * FAIL-CLOSED (never returns a masking result): if ANY registration that claims
 * this provider is malformed (wrong `abiVersion` / non-callable
 * `createSkillDeliveryAdapter`), or MORE THAN ONE registration claims it
 * (ambiguous ownership), this THROWS rather than returning a surface. Trust
 * (first-party-only) is enforced upstream by the RESERVED_SYSTEM_CAPABILITY
 * port fence, so every claimant here is first-party.
 */
export function getLlmSkillDeliveryAdapterSurface(
  providerId: string,
): LlmSkillDeliveryAdapterSurface | null {
  const claimants = resolveCapabilityProviders(LLM_SKILL_DELIVERY_ADAPTER_CAPABILITY).filter((p) =>
    skillDeliverySurfaceClaimsProvider(p.impl, providerId),
  );

  if (claimants.length === 0) return null; // genuinely ABSENT -> caller falls back

  // Fail closed on ANY malformed claimant — a valid sibling must NOT mask it.
  const malformed = claimants.filter((p) => !isValidLlmSkillDeliveryAdapterSurface(p.impl));
  if (malformed.length > 0) {
    throw new Error(
      `The "${providerId}" llm-skill-delivery-adapter surface is registered but malformed ` +
        `(expected abiVersion ${LLM_SKILL_DELIVERY_ADAPTER_ABI_VERSION} and a callable ` +
        `createSkillDeliveryAdapter) — refusing to resolve it (fail closed).`,
    );
  }
  // Ambiguous ownership: exactly one connector may own a provider's adapter.
  if (claimants.length > 1) {
    const owners = claimants.map((p) => p.packageName).join(", ");
    throw new Error(
      `Multiple llm-skill-delivery-adapter surfaces claim provider "${providerId}" (${owners}) — ` +
        `ambiguous ownership; refusing to resolve (fail closed).`,
    );
  }
  return claimants[0].impl as LlmSkillDeliveryAdapterSurface;
}
