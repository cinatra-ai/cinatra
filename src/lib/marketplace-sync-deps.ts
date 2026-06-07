import "server-only";

/**
 * Production deps factory for `runMarketplaceSync`. Wires the
 * marketplace-sync worker's injection points to live cinatra services:
 *
 *   - `verdaccioPackageNames` → Verdaccio `/-/all` via the configured
 *     read token; either every visible package (full-sweep) or just the
 *     one named in the payload (single-package mode).
 *   - `getPackageSource` → packument fetch + README extraction via
 *     `@cinatra-ai/registries`'s `getPackageReadme`. Returns the raw
 *     package.json + the size-capped README + the version-list array
 *     the sync worker normalises.
 *   - `isScopeApproved` → defense-in-depth gate on top of Verdaccio ACL.
 *     P6d-B ships with a permissive `() => true` because the marketplace
 *     side already enforces vendor visibility on the receiving end of
 *     `marketplace_package_sync_from_registry` (unapproved scopes are
 *     rejected server-side). A cinatra-side approval check that calls a
 *     bulk `vendor_list_approved_scopes` ability is tracked separately;
 *     until that ships, the cinatra-side filter is a no-op.
 *   - marketplace MCP client → constructed against the instance token;
 *     returns null overall if the token isn't configured so the handler
 *     can re-delay (full sweep) or fail loud (single-package mode).
 */

import { loadVerdaccioConfigForServer } from "@/lib/verdaccio-config";
import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import {
  listExtensionPackages,
  getPublishedExtensionSummary,
  getPackageReadme,
  type VerdaccioConfig,
} from "@cinatra-ai/registries";
import type {
  PackageSourceInputs,
  SyncWorkerDeps,
} from "@cinatra-ai/marketplace-sync";
import {
  VendorCredentialsMissingError,
  resolveMarketplaceSyncWorkerToken,
} from "@/lib/marketplace-credentials";

/**
 * Sync-worker bearer is STRICTLY PARTITIONED from the consumer + vendor
 * bearer (catalog-poisoning guard). A leaked consumer or vendor token must
 * NEVER authenticate the sync worker.
 *
 * Resolution order:
 *   1. `MARKETPLACE_SYNC_WORKER_TOKEN` — preferred dedicated bearer.
 *   2. `MARKETPLACE_INSTANCE_TOKEN` — transition affordance for installs
 *      that haven't yet provisioned a dedicated sync-worker bearer.
 *      Emits a one-time warn so the operator notices.
 *
 * Returns undefined when neither is configured (the caller decides whether
 * to skip or hard-fail).
 */
function resolveMarketplaceToken(): string | undefined {
  try {
    return resolveMarketplaceSyncWorkerToken();
  } catch (e) {
    if (!(e instanceof VendorCredentialsMissingError)) {
      // Unexpected error — re-throw so it's loud.
      throw e;
    }
    // No dedicated sync-worker bearer; try the legacy fallback.
    const legacy = process.env.MARKETPLACE_INSTANCE_TOKEN?.trim();
    if (legacy && legacy.length > 0) {
      warnSyncWorkerLegacyFallback();
      return legacy;
    }
    return undefined;
  }
}

let warnedLegacySyncFallback = false;
function warnSyncWorkerLegacyFallback(): void {
  if (warnedLegacySyncFallback) return;
  warnedLegacySyncFallback = true;
  console.warn(
    "[marketplace-sync-deps] Falling back to MARKETPLACE_INSTANCE_TOKEN for " +
      "the sync worker because MARKETPLACE_SYNC_WORKER_TOKEN is not set. " +
      "Provision a dedicated sync-worker bearer to satisfy the catalog-" +
      "poisoning partition (a leaked consumer/vendor token should never " +
      "authenticate the sync worker).",
  );
}

/**
 * Build the production dep bundle for `runMarketplaceSync`. Returns null
 * when prerequisites (marketplace token, Verdaccio config) are missing
 * so callers can decide whether to skip or hard-fail.
 *
 * @param input.packageName     optional — when set, single-package mode:
 *                              `verdaccioPackageNames` returns ONLY this
 *                              name. When unset, full-sweep mode.
 * @param input.packageVersion  optional — when set alongside packageName,
 *                              pins the manifest + README fetch to that
 *                              EXACT version. Without this, the resolved
 *                              latest version could differ from the
 *                              just-approved target if a newer version
 *                              was published in-between.
 */
export async function buildMarketplaceSyncDeps(input: {
  packageName?: string;
  packageVersion?: string;
}): Promise<SyncWorkerDeps | null> {
  const token = resolveMarketplaceToken();
  if (!token) {
    return null;
  }
  let verdaccioConfig: VerdaccioConfig;
  try {
    verdaccioConfig = await loadVerdaccioConfigForServer();
  } catch {
    return null;
  }

  const client = createHttpMarketplaceMcpClient({ token });

  return {
    client,
    verdaccioPackageNames: async () => {
      if (input.packageName) {
        return [input.packageName];
      }
      // Full-sweep: every package the registry exposes. `allowedScopes:
      // undefined` drops the scope pre-prune (set in P6d-A). The list is
      // already deduplicated by package name.
      const summaries = await listExtensionPackages(
        { limit: 10_000, allowedScopes: undefined },
        verdaccioConfig,
      );
      return summaries.map((s) => s.packageName);
    },
    getPackageSource: async (packageName) => {
      // Kind-agnostic extraction. `getAgentPackage` would throw for
      // skill/connector/artifact/workflow packages (no agent.json
      // payload), silently dropping them from the catalog. Use the
      // kind-agnostic pair instead:
      //   - getPublishedExtensionSummary: packument fetch, returns the
      //     resolved version's full package.json manifest (the
      //     marketplace-sync package-mapper dispatches on
      //     `manifest.cinatra.kind`).
      //   - getPackageReadme: kind-agnostic tarball extraction +
      //     size-capped README read.
      //
      // When `input.packageVersion` is set (single-package mode after
      // an admin approve), pin BOTH fetches to that exact version —
      // without this, a freshly-approved 1.0.0 could be silently
      // replaced by a previously-published 2.0.0 if "latest" has moved.
      const pinnedVersion = input.packageVersion;
      const summary = await getPublishedExtensionSummary(
        { packageName, packageVersion: pinnedVersion },
        verdaccioConfig,
      );
      if (summary.resolvedVersion === null || summary.manifest === null) {
        throw new Error(
          `getPackageSource(${packageName}${pinnedVersion ? `@${pinnedVersion}` : ""}): no resolvable version in the registry`,
        );
      }
      const readmeResult = await getPackageReadme(
        { packageName, packageVersion: summary.resolvedVersion },
        verdaccioConfig,
      );

      // Version list — single-entry tuple of the resolved version. The
      // marketplace catalog tracks all versions it sees over time; each
      // periodic sweep adds whatever's resolved-latest now. A future
      // enhancement could expose the full packument version list via
      // getPublishedExtensionSummary, but for catalog freshness purposes
      // the resolved version is sufficient.
      const versions = [
        { version: summary.resolvedVersion, releasedAt: "" },
      ];
      // The manifest is a packument-version object (RawPackageJson shape
      // per packages/marketplace-sync). Cast via `unknown` because the
      // packument typings widen to Record<string, unknown> at this layer.
      const source: PackageSourceInputs = {
        packageJson: summary.manifest as unknown as PackageSourceInputs["packageJson"],
        readme: readmeResult.readme,
        versions,
      };
      return source;
    },
    isScopeApproved: async () => {
      // P6d-B permissive gate — marketplace-side filter is the real
      // authority for vendor approval. See file-level doc comment for
      // the follow-up that turns this into a real defense-in-depth check.
      return true;
    },
  };
}
