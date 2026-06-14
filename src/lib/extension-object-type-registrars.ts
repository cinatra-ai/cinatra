import "server-only";

// Host-side resolution of `object-type-registrar` capability providers.
//
// An extension that ships object types (crm-connector's account/contact/list
// today) registers a registrar behind the `object-type-registrar` capability
// from its own `serverEntry` (`register(ctx)` →
// `ctx.capabilities.registerProvider(...)`). The host's
// `registerAllObjectTypes()` invokes every registered provider HERE instead
// of importing an extension package by name (the lazy/guarded host-access
// cutover). Registration is idempotent connector-side (replace-by-id on the
// object registry), so invoking on every `registerAllObjectTypes()` call is
// safe.
//
// Degraded mode: with no provider registered (extension absent / not yet
// activated) only the host-owned object types register — callers proceed.

import type { ObjectTypeRegistrarProvider } from "@cinatra-ai/sdk-extensions";
import { OBJECT_TYPE_REGISTRAR_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

// Structural guard: a capability impl is `unknown` by contract.
function isObjectTypeRegistrar(impl: unknown): impl is ObjectTypeRegistrarProvider {
  if (typeof impl !== "object" || impl === null) return false;
  return typeof (impl as { registerObjectTypes?: unknown }).registerObjectTypes === "function";
}

/**
 * Invoke every registered extension object-type registrar. Per-provider
 * failures are isolated (warn + continue) — one extension's registrar can
 * never block another's types, nor the host-owned registrations around it.
 */
export function runExtensionObjectTypeRegistrars(): void {
  for (const provider of resolveCapabilityProviders(OBJECT_TYPE_REGISTRAR_CAPABILITY)) {
    if (!isObjectTypeRegistrar(provider.impl)) continue;
    try {
      provider.impl.registerObjectTypes();
    } catch (err) {
      console.warn(
        `[object-type-registrar] ${provider.packageName} failed to register its object types: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
