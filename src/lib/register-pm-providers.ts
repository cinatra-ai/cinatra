import "server-only";

// PM (project-management) provider discovery bridge (cinatra#317).
//
// Mirrors src/lib/register-crm-providers.ts: the host no longer imports any
// concrete PM provider package. A provider extension (plane-connector today;
// linear/jira later) registers its `PmConnector` impl behind the `pm-provider`
// capability from its own `serverEntry` (`register(ctx)` →
// `ctx.capabilities.registerProvider("pm-provider", …)`). This module binds the
// SDK-hosted PM provider registry's EXTERNAL resolver to the host capability
// registry, so `lookupPmProvider(id)` / `listPmProviders()` resolve every
// capability-registered provider LAZILY — activation order never matters and a
// capability teardown is reflected immediately. Adding/removing a PM provider
// extension requires no host edit.

import {
  setPmProviderExternalResolver,
  type PmConnector,
} from "@cinatra-ai/sdk-extensions";
import { PM_PROVIDER_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

// Structural guard: a capability registered under `pm-provider` carries an
// `impl: unknown`. Validate the PmConnector shape before the SDK registry
// trusts it, so a mis-registered provider can never reach a PM call.
function isPmConnector(impl: unknown): impl is PmConnector {
  if (typeof impl !== "object" || impl === null) return false;
  const candidate = impl as {
    providerId?: unknown;
    upsertTriggerTask?: unknown;
    deleteTriggerTask?: unknown;
  };
  return (
    typeof candidate.providerId === "string" &&
    candidate.providerId.length > 0 &&
    typeof candidate.upsertTriggerTask === "function" &&
    typeof candidate.deleteTriggerTask === "function"
  );
}

let _registered = false;

export function registerPmProviders(): void {
  if (_registered) return;
  _registered = true;
  setPmProviderExternalResolver(() =>
    resolveCapabilityProviders(PM_PROVIDER_CAPABILITY)
      .map((p) => p.impl)
      .filter(isPmConnector),
  );
}

// Self-invoke on import. Matches the pattern the register-* boot modules use
// so simply importing this module from the host wires everything up.
registerPmProviders();
