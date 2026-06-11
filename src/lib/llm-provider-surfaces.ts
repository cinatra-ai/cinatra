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

import {
  LLM_PROVIDER_SURFACE_CAPABILITY,
  type LlmProviderSurface,
} from "@cinatra-ai/sdk-extensions";
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
