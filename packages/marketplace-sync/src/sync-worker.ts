/**
 * Marketplace catalog sync worker.
 *
 * Pulls every published package from Verdaccio, extracts its README,
 * normalises the metadata via `mapPackageMetadata`, checks scope ownership
 * via `checkScopeOwnership`, and POSTs `marketplace_package_sync_from_registry`
 * to the marketplace MCP for each package whose scope is owned.
 *
 * Composition:
 *   - `verdaccioPackageNames()` — fn returning the list of package names to
 *     consider this run. In production, listed via the existing
 *     `@cinatra-ai/registries` `listAgentPackages` helper for now;
 *     `listExtensionPackages` (kind-agnostic) when that ships.
 *   - `getPackageJsonAndReadme()` — per-package fetcher that returns the raw
 *     package.json + the size-capped README (via `getPackageReadme` from
 *     `@cinatra-ai/registries`).
 *   - `isScopeApproved()` — per-scope owner check, injected so the test
 *     suite can run against a fixture Set without touching the network.
 *   - `client.packageSyncFromRegistry()` — the typed MCP client call.
 *
 * Telemetry:
 *   - On every run, returns a structured `SyncRunSummary` the caller emits
 *     as a cinatra metric event. The caller (BullMQ job handler) wires
 *     this into the existing cinatra metrics surface.
 */

import type {
  MarketplaceMcpClient,
  PackageMetadata,
} from "@cinatra-ai/marketplace-mcp-client";
import { mapPackageMetadata, type RawPackageJson } from "./package-mapper";
import { checkScopeOwnership } from "./scope-ownership";

export interface PackageSourceInputs {
  packageJson: RawPackageJson;
  readme: string | null;
  versions: Array<{ version: string; releasedAt: string }>;
}

export interface SyncWorkerDeps {
  client: MarketplaceMcpClient;
  /** Returns the package names to process this run. */
  verdaccioPackageNames: () => Promise<string[]>;
  /** Per-package fetcher (package.json + README + version list). */
  getPackageSource: (packageName: string) => Promise<PackageSourceInputs>;
  /** Per-scope owner check (defense in depth on top of Verdaccio ACL). */
  isScopeApproved: (scope: string) => Promise<boolean>;
  /**
   * Generates a stable idempotency key for the sync POST. Default: `${packageName}@${version}`.
   * Tests override this to assert idempotency semantics.
   */
  idempotencyKeyFor?: (metadata: PackageMetadata) => string;
}

export interface PerPackageResult {
  packageName: string;
  status: "synced" | "scope-rejected" | "fetch-failed" | "map-failed" | "sync-failed";
  rejectionReason: string | null;
  warnings: string[];
}

export interface SyncRunSummary {
  startedAt: string;
  finishedAt: string;
  totalPackages: number;
  syncedCount: number;
  scopeRejectedCount: number;
  fetchFailedCount: number;
  mapFailedCount: number;
  syncFailedCount: number;
  perPackage: PerPackageResult[];
}

export async function runMarketplaceSync(deps: SyncWorkerDeps): Promise<SyncRunSummary> {
  const startedAt = new Date().toISOString();
  const packageNames = await deps.verdaccioPackageNames();
  const idempotencyKeyFor =
    deps.idempotencyKeyFor ?? ((m: PackageMetadata) => `${m.packageName}@${m.version}`);

  const perPackage: PerPackageResult[] = [];
  let syncedCount = 0;
  let scopeRejectedCount = 0;
  let fetchFailedCount = 0;
  let mapFailedCount = 0;
  let syncFailedCount = 0;

  for (const packageName of packageNames) {
    // Defense in depth — Verdaccio ACL is the primary gate but the sync
    // worker re-verifies the scope before sending data to the catalog.
    const ownership = await checkScopeOwnership({
      packageName,
      isScopeApproved: deps.isScopeApproved,
    });
    if (!ownership.ok) {
      scopeRejectedCount++;
      perPackage.push({
        packageName,
        status: "scope-rejected",
        rejectionReason: ownership.rejectionReason,
        warnings: [],
      });
      continue;
    }

    let source: PackageSourceInputs;
    try {
      source = await deps.getPackageSource(packageName);
    } catch (error) {
      fetchFailedCount++;
      perPackage.push({
        packageName,
        status: "fetch-failed",
        rejectionReason: `getPackageSource threw: ${error instanceof Error ? error.message : String(error)}`,
        warnings: [],
      });
      continue;
    }

    let mapped: ReturnType<typeof mapPackageMetadata>;
    try {
      // mapPackageMetadata fails closed (throws) when a package declares no
      // canonical cinatra.kind — contain that to a per-package failure rather
      // than aborting the whole run.
      mapped = mapPackageMetadata({
        packageJson: source.packageJson,
        readme: source.readme,
      });
    } catch (error) {
      mapFailedCount++;
      perPackage.push({
        packageName,
        status: "map-failed",
        rejectionReason: `mapPackageMetadata threw: ${error instanceof Error ? error.message : String(error)}`,
        warnings: [],
      });
      continue;
    }

    try {
      await deps.client.packageSyncFromRegistry({
        metadata: mapped.metadata,
        versions: source.versions,
        idempotencyKey: idempotencyKeyFor(mapped.metadata),
      });
      syncedCount++;
      perPackage.push({
        packageName,
        status: "synced",
        rejectionReason: null,
        warnings: mapped.warnings,
      });
    } catch (error) {
      syncFailedCount++;
      perPackage.push({
        packageName,
        status: "sync-failed",
        rejectionReason: `client.packageSyncFromRegistry threw: ${error instanceof Error ? error.message : String(error)}`,
        warnings: mapped.warnings,
      });
    }
  }

  const finishedAt = new Date().toISOString();
  return {
    startedAt,
    finishedAt,
    totalPackages: packageNames.length,
    syncedCount,
    scopeRejectedCount,
    fetchFailedCount,
    mapFailedCount,
    syncFailedCount,
    perPackage,
  };
}
