import "server-only";

// Host-side resolution of the CRM integration capability providers
// (the lazy/guarded host-access cutover: the background-job dispatcher no
// longer dynamic-imports `@cinatra-ai/crm-connector` / the Twenty provider —
// it resolves these capabilities at job time).
//
//   - `crm-sync-bootstrap`: idempotent object-sync registrations (the
//     Twenty→Graphiti adapters) invoked before each projection-outbox cycle.
//     The Twenty CRM provider itself needs NO bootstrap call here: it
//     registers behind the `crm-provider` capability at its own activation
//     and resolves through the SDK registry's external resolver
//     (src/lib/register-crm-providers.ts).
//   - `crm-pointer-writer`: durable pointer writes; the impl owns the
//     register-types-before-write ordering.
//
// Degraded mode: with no provider registered (connector absent / inactive),
// `ensureCrmSyncRegistrations()` is a no-op and `resolveCrmPointerWriter()`
// returns null — callers warn and complete instead of crashing the worker.

import {
  CRM_SYNC_BOOTSTRAP_CAPABILITY,
  CRM_POINTER_WRITER_CAPABILITY,
  CRM_LIST_READER_CAPABILITY_ID,
  type CrmSyncBootstrapProvider,
  type CrmPointerWriterProvider,
  type CrmListReader,
} from "@cinatra-ai/sdk-extensions";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

// Structural guards: a capability impl is `unknown` by contract.
function isCrmSyncBootstrap(impl: unknown): impl is CrmSyncBootstrapProvider {
  if (typeof impl !== "object" || impl === null) return false;
  return typeof (impl as { ensureSyncRegistrations?: unknown }).ensureSyncRegistrations === "function";
}

function isCrmPointerWriter(impl: unknown): impl is CrmPointerWriterProvider {
  if (typeof impl !== "object" || impl === null) return false;
  return typeof (impl as { writePointer?: unknown }).writePointer === "function";
}

/**
 * Invoke every registered sync-bootstrap provider (idempotent connector-side).
 * Per-provider failures are isolated (warn + continue) so the outbox cycle
 * still runs — matching the projector's own per-entry failure semantics.
 */
export function ensureCrmSyncRegistrations(): void {
  for (const provider of resolveCapabilityProviders(CRM_SYNC_BOOTSTRAP_CAPABILITY)) {
    if (!isCrmSyncBootstrap(provider.impl)) continue;
    try {
      provider.impl.ensureSyncRegistrations();
    } catch (err) {
      console.warn(
        `[crm-sync-bootstrap] ${provider.packageName} failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** The live CRM pointer writer, or null when no provider is registered. */
export function resolveCrmPointerWriter(): CrmPointerWriterProvider | null {
  const match = resolveCapabilityProviders(CRM_POINTER_WRITER_CAPABILITY).find((p) =>
    isCrmPointerWriter(p.impl),
  );
  return (match?.impl as CrmPointerWriterProvider | undefined) ?? null;
}

function isCrmListReader(impl: unknown): impl is CrmListReader {
  if (typeof impl !== "object" || impl === null) return false;
  return typeof (impl as { searchLists?: unknown }).searchLists === "function";
}

/**
 * The live CRM list-read surface (cinatra#151 Stage 4: the agent-builder list
 * picker resolves `crm-list-reader` instead of value-importing the
 * crm-connector's facade), or null when no provider is registered (connector
 * absent/inactive — acquirable-on-demand, not required). The IMPL fails loud
 * when the connector is active but no CRM provider extension is registered;
 * the caller owns degraded-to-empty.
 */
export function resolveCrmListReader(): CrmListReader | null {
  const match = resolveCapabilityProviders(CRM_LIST_READER_CAPABILITY_ID).find((p) =>
    isCrmListReader(p.impl),
  );
  return (match?.impl as CrmListReader | undefined) ?? null;
}
