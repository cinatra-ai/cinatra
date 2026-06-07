import "server-only";

/**
 * Production deps factory for `runVendorApplicationStateReconcile`. Wires the
 * vendor-application reconcile worker's injection points to live cinatra
 * services:
 *
 *   - `client` → typed HTTP marketplace MCP client constructed against the
 *     sync-worker bearer (STRICTLY PARTITIONED from the consumer + vendor +
 *     admin bearers — a leaked consumer/vendor/admin token must NEVER
 *     authenticate the sync worker, per the catalog-poisoning guard).
 *   - `getStuckApplications()` → bounded candidate set this run should
 *     attempt to recover. For the v0 single-instance shape this resolves
 *     to a 0-or-1 element list derived from the local
 *     `instance_identity.vendorApplicationId` slot when `vendorState ===
 *     "applied"`. Multi-instance / cm-side admin-queue iteration is a
 *     follow-up (would require admin-bearer access from the worker).
 *
 * Resolution / failure modes mirror `buildMarketplaceSyncDeps`:
 *   - Returns null when the marketplace sync-worker bearer is unavailable
 *     so the dispatcher can log + still re-delay the loop (catching this
 *     null inside the handler is what keeps the perpetual-loop doctrine).
 *   - getStuckApplications is allowed to throw; the worker catches and
 *     treats the candidate set as empty for that run.
 */

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type {
  ReconcileCandidate,
  ReconcileDeps,
} from "@cinatra-ai/marketplace-application-reconcile";
import { readInstanceIdentity, writeInstanceIdentity } from "@/lib/instance-identity-store";
import { invalidateInstanceIdentityCache } from "@/lib/instance-identity-cache";
import {
  VendorCredentialsMissingError,
  resolveMarketplaceSyncWorkerToken,
} from "@/lib/marketplace-credentials";

/**
 * Sync-worker bearer is STRICTLY PARTITIONED from every other bearer slot
 * (consumer, vendor, admin) — catalog-poisoning guard. A leaked
 * consumer/vendor/admin token must NEVER authenticate the reconcile worker,
 * which calls `vendor_application_complete_recovery`
 * (PRINCIPAL_SYNC_WORKER-only).
 *
 * Sync-worker bearer partitioning: the resolver is STRICT — no fallback
 * to consumer/vendor/admin tokens. When `MARKETPLACE_SYNC_WORKER_TOKEN`
 * is unset, return undefined; the caller builds null deps and the
 * dispatcher case in `background-jobs.ts` bails cleanly (no-op this run,
 * retry on the next 5-minute cycle).
 *
 * The `MARKETPLACE_INSTANCE_TOKEN` env fallback is intentionally absent —
 * it would violate the sync-worker bearer partition.
 */
function resolveMarketplaceToken(): string | undefined {
  try {
    return resolveMarketplaceSyncWorkerToken();
  } catch (e) {
    if (!(e instanceof VendorCredentialsMissingError)) {
      throw e;
    }
    warnSyncWorkerTokenMissing();
    return undefined;
  }
}

let warnedSyncWorkerTokenMissing = false;
function warnSyncWorkerTokenMissing(): void {
  if (warnedSyncWorkerTokenMissing) return;
  warnedSyncWorkerTokenMissing = true;
  console.warn(
    "[vendor-application-state-reconcile] MARKETPLACE_SYNC_WORKER_TOKEN is not set. " +
      "Skipping recovery runs until it is provisioned (no fallback to " +
      "consumer/vendor/admin tokens is permitted — the sync-worker bearer is " +
      "strictly partitioned to defend against catalog poisoning).",
  );
}

/**
 * Build the production dep bundle for `runVendorApplicationStateReconcile`.
 * Returns null when prerequisites (sync-worker bearer) are missing so
 * callers can decide whether to skip or hard-fail.
 *
 * v0 candidate detection — single-instance shape:
 *   Reads the local `instance_identity` row. Returns a 1-element list when
 *   `vendorState === "applied"` AND `vendorApplicationId` is set; the
 *   empty list otherwise. The next 5-minute tick re-reads, so once the
 *   recovery completes and the state flips to `approved`, the candidate
 *   set naturally empties.
 *
 * Multi-instance follow-up (out of scope for v0): swap the candidate
 * resolver for one that walks an admin-level `vendor_application_list_admin
 * ({ status: ["applied"] })` enumeration (requires the admin bearer
 * partition, not the sync-worker bearer) OR iterates per-org rows from a
 * cinatra-side reservation registry table. Either approach plugs into the
 * same `ReconcileDeps` shape without worker-side changes.
 */
export async function buildVendorApplicationReconcileDeps(): Promise<ReconcileDeps | null> {
  const token = resolveMarketplaceToken();
  if (!token) {
    return null;
  }

  // The HTTP marketplace client exposes a typed
  // `vendorApplicationCompleteRecovery` method (see http-client.ts), so
  // it structurally satisfies `VendorApplicationCompleteRecoveryCaller`
  // without an unsafe cast (no `as unknown as ...` escape hatch).
  const client = createHttpMarketplaceMcpClient({ token });

  return {
    client,
    getStuckApplications: async (): Promise<ReconcileCandidate[]> => {
      const identity = readInstanceIdentity();
      if (!identity) {
        return [];
      }
      const applicationId = identity.vendorApplicationId;
      const isOpenApplication =
        identity.vendorState === "applied" &&
        typeof applicationId === "string" &&
        applicationId.length > 0;
      if (!isOpenApplication) {
        // Clear-on-change: a non-`applied` state has no in-flight recovery to
        // be stuck on, so a lingering stuck flag is stale. Drop it so a future
        // re-apply starts clean.
        clearRepairStuckFlagIfSet(applicationId ?? null);
        return [];
      }
      // The marketplace has confirmed this application's recovery is terminally
      // stuck; do not keep hammering a dead saga. Admin intervention (or a new
      // application_id) is required to clear it.
      if (
        typeof identity.vendorApplicationRepairStuckAt === "string" &&
        identity.vendorApplicationRepairStuckAt.length > 0
      ) {
        return [];
      }
      return [{ application_id: applicationId as string }];
    },
    /**
     * Record the durable local stuck flag for `applicationId`. Re-reads inside
     * the write boundary and only persists when the current
     * `vendorApplicationId` still matches the application the marketplace
     * reported stuck — a concurrent re-apply that minted a fresh id must NOT
     * inherit the stale flag.
     */
    onStuck: (applicationId: string, repairStuckAt: string): void => {
      const fresh = readInstanceIdentity();
      if (!fresh) return;
      if (fresh.vendorApplicationId !== applicationId) return;
      // Only stamp the flag while the application is still open (`applied`).
      // A late onStuck call must not re-stamp a flag after a concurrent
      // refresh / approval already moved this same application id off
      // `applied` — otherwise the stale flag would resurface on an
      // approved/cancelled application.
      if (fresh.vendorState !== "applied") return;
      if (fresh.vendorApplicationRepairStuckAt === repairStuckAt) return;
      writeInstanceIdentity({
        ...fresh,
        vendorApplicationRepairStuckAt: repairStuckAt,
      });
      invalidateInstanceIdentityCache();
    },
  };
}

/**
 * Clear a previously-recorded stuck flag when the application it was tied to is
 * no longer the current open application (changed id, or state moved off
 * `applied`). A fresh application must never inherit a stale stuck flag.
 */
function clearRepairStuckFlagIfSet(_currentApplicationId: string | null): void {
  const fresh = readInstanceIdentity();
  if (!fresh) return;
  const stuckAt = fresh.vendorApplicationRepairStuckAt;
  if (typeof stuckAt !== "string" || stuckAt.length === 0) return;
  writeInstanceIdentity({
    ...fresh,
    vendorApplicationRepairStuckAt: null,
  });
  invalidateInstanceIdentityCache();
}
