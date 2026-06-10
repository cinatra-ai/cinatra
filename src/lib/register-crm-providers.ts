import "server-only";

// CRM provider discovery bridge.
//
// Transport-registration cutover: the host no longer imports any concrete CRM provider package.
// A provider extension (twenty today, hubspot/salesforce later) registers its
// `CrmConnector` impl behind the `crm-provider` capability from its own
// `serverEntry` (`register(ctx)` → `ctx.capabilities.registerProvider(…)`).
// This module binds the SDK-hosted CRM provider registry's EXTERNAL resolver
// to the host capability registry, so `lookupCrmProvider(id)` resolves every
// capability-registered provider LAZILY — activation order never matters and
// a capability teardown is reflected immediately. Adding/removing a CRM
// provider extension requires no host edit.

import {
  setCrmProviderExternalResolver,
  CRM_PROVIDER_CAPABILITY,
  type CrmConnector,
} from "@cinatra-ai/sdk-extensions";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

// Structural guard: a capability registered under `crm-provider` carries an
// `impl: unknown`. Validate the CrmConnector shape before the SDK registry
// trusts it, so a mis-registered provider can never reach a CRM call.
function isCrmConnector(impl: unknown): impl is CrmConnector {
  if (typeof impl !== "object" || impl === null) return false;
  const candidate = impl as { providerId?: unknown };
  return typeof candidate.providerId === "string" && candidate.providerId.length > 0;
}

let _registered = false;

export function registerCrmProviders(): void {
  if (_registered) return;
  _registered = true;
  setCrmProviderExternalResolver(() =>
    resolveCapabilityProviders(CRM_PROVIDER_CAPABILITY)
      .map((p) => p.impl)
      .filter(isCrmConnector),
  );
}

// Self-invoke on import. Matches the pattern the register-* boot modules use
// so simply importing this module from the host wires everything up.
registerCrmProviders();
