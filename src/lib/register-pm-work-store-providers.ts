import "server-only";

// PM WORK-ITEM STORE provider discovery bridge (cinatra#1031, EPIC #1030) — the
// host-side wiring for the "PmConnector v2" typed work-item CRUD seam.
//
// Mirrors src/lib/register-pm-providers.ts (the trigger-mirror bridge), but for
// a SEPARATE capability (`pm-work-store`, not `pm-provider`) and a SEPARATE SDK
// registry (`PmWorkStore`, not `PmConnector`). The host no longer imports any
// concrete PM provider package. A provider extension (plane-connector today; a
// github/linear/jira impl later) registers its `PmWorkStore` impl behind the
// `pm-work-store` capability from its own `serverEntry` (`register(ctx)` →
// `ctx.capabilities.registerProvider("pm-work-store", …)`). This module binds
// the SDK-hosted PM work-store registry's EXTERNAL resolver to the host
// capability registry, so `lookupPmWorkStore(id)` / `listPmWorkStores()` resolve
// every capability-registered provider LAZILY — activation order never matters
// and a capability teardown is reflected immediately. Adding/removing a PM
// work-store provider requires no host edit.
//
// This is the W1 (#1031) foundation seam. The CONSUMER — the generic project
// manager agent + its dispatch primitive, lease, and ledger — is W2 (#1032); it
// resolves providers through `lookupPmWorkStore` / `listPmWorkStores` and owns
// the resolution POLICY (which provider to pick, and the fail-closed-when-absent
// behavior at dispatch time). This bridge is deliberately POLICY-FREE: it only
// binds the resolver and structurally guards each impl.

import {
  setPmWorkStoreExternalResolver,
  type PmWorkStore,
} from "@cinatra-ai/sdk-extensions";
import { PM_WORK_STORE_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

// Structural guard: a capability registered under `pm-work-store` carries an
// `impl: unknown`. Validate the PmWorkStore shape before the SDK registry trusts
// it, so a mis-registered provider can never reach a store call. Exported for
// the structural-guard contract test (it must require EVERY PmWorkStore verb —
// a provider missing any op must be rejected so the W2 store discipline can
// never dispatch to a half-implemented store).
export function isPmWorkStore(impl: unknown): impl is PmWorkStore {
  if (typeof impl !== "object" || impl === null) return false;
  const candidate = impl as {
    providerId?: unknown;
    createWorkItem?: unknown;
    getWorkItemByKey?: unknown;
    getWorkItem?: unknown;
    listWorkItems?: unknown;
    updateWorkItem?: unknown;
    closeWorkItem?: unknown;
    addComment?: unknown;
    listComments?: unknown;
  };
  return (
    typeof candidate.providerId === "string" &&
    candidate.providerId.length > 0 &&
    typeof candidate.createWorkItem === "function" &&
    typeof candidate.getWorkItemByKey === "function" &&
    typeof candidate.getWorkItem === "function" &&
    typeof candidate.listWorkItems === "function" &&
    typeof candidate.updateWorkItem === "function" &&
    typeof candidate.closeWorkItem === "function" &&
    typeof candidate.addComment === "function" &&
    typeof candidate.listComments === "function"
  );
}

let _registered = false;

export function registerPmWorkStoreProviders(): void {
  if (_registered) return;
  _registered = true;
  setPmWorkStoreExternalResolver(() =>
    resolveCapabilityProviders(PM_WORK_STORE_CAPABILITY)
      .map((p) => p.impl)
      .filter(isPmWorkStore),
  );
}

// Self-invoke on import. Matches the pattern the register-* boot modules use
// so simply importing this module from the host wires everything up.
registerPmWorkStoreProviders();
