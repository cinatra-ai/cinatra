import "server-only";

import type { MarketplaceVendorGetSelfOutput } from "@cinatra-ai/marketplace-mcp-client";

import type { RemoteRegistryConnection } from "@/lib/instance-identity-store";

/**
 * Map a marketplace vendor `state` to the app-local `remote.status` used by
 * the registries UI. The two state machines aren't identical (the marketplace
 * has tier/visibility/published-count; the app-local status is a coarser
 * connection-state for the operator), so the mapping is deliberate.
 */
export function mapVendorStateToRemoteStatus(
  state: string,
): RemoteRegistryConnection["status"] {
  switch (state) {
    case "active":
      return "connected";
    case "pending":
    case "unregistered":
      return "not_connected";
    case "suspended":
    case "rejected":
      return "error";
    default:
      // Unknown marketplace state — surface as error so the operator sees the
      // contract drift instead of a silent stale row.
      return "error";
  }
}

export interface ReconcileInput {
  /** Current persisted remote-registry connection (may be null/missing). */
  previous: RemoteRegistryConnection | undefined;
  /** Fresh marketplace self-record. */
  vendor: MarketplaceVendorGetSelfOutput;
  /** Namespace for this instance (== identity.instanceNamespace). */
  namespace: string;
  /** Wall-clock for the reconcile timestamp (override for tests). */
  nowIso?: string;
}

/**
 * Build the updated `RemoteRegistryConnection` from a fresh `vendor_get_self`
 * response. Caches the raw marketplace state alongside the mapped app-local
 * status so the UI can show the precise marketplace state when relevant.
 */
export function reconcileRemoteFromVendorGet(
  input: ReconcileInput,
): RemoteRegistryConnection {
  const now = input.nowIso ?? new Date().toISOString();
  const status = mapVendorStateToRemoteStatus(input.vendor.state);
  const base = input.previous ?? {
    url: input.vendor.registry_url,
    namespace: input.namespace,
    status,
  };
  return {
    ...base,
    url: input.vendor.registry_url || base.url,
    namespace: input.namespace,
    status,
    marketplaceState: input.vendor.state,
    marketplaceVendorId: input.vendor.vendor_id,
    marketplaceLastReconciledAt: now,
    // A successful reconcile clears any prior reconcile-error.
    marketplaceLastReconcileError: null,
    lastPolledAt: now,
  };
}

/**
 * Handle a failed `vendor_get_self` call WITHOUT degrading a currently-
 * connected row: preserve `status` AND the prior marketplace cache, only
 * record the error + timestamp. A row that was never connected stays
 * not_connected (no false-positive connection).
 */
export function reconcileRemoteOnFailure(
  input: {
    previous: RemoteRegistryConnection | undefined;
    error: string;
    namespace: string;
    nowIso?: string;
  },
): RemoteRegistryConnection | undefined {
  if (!input.previous) {
    return undefined; // never overwrite absent state into a synthetic "error" row
  }
  const now = input.nowIso ?? new Date().toISOString();
  return {
    ...input.previous,
    namespace: input.namespace,
    marketplaceLastReconciledAt: now,
    marketplaceLastReconcileError: input.error.slice(0, 500),
    lastPolledAt: now,
  };
}
