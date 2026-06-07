# @cinatra-ai/marketplace-sync

Catalog sync worker for the Cinatra marketplace. It reads published package metadata and READMEs from the registry, normalizes each into a contract-shaped record, verifies scope ownership, and posts `marketplace_package_sync_from_registry` per package to reconcile the marketplace catalog.

The mapping and ownership logic are pure (no I/O); all network access is injected by the caller, so the core is straightforward to unit-test.

## Public API

- `runMarketplaceSync` — process all packages and return a run summary
- `SyncWorkerDeps` — injected deps (client, package lister, fetcher, scope check)
- `PackageSourceInputs` — per-package source (package.json, README, versions)
- `PerPackageResult` — outcome for a single package
- `SyncRunSummary` — structured per-run telemetry
- `mapPackageMetadata` — normalize package.json + README into catalog metadata
- `RawPackageJson` / `MappedMetadataResult` — mapper input/output shapes
- `checkScopeOwnership` — verify a scope belongs to an approved active vendor
- `ScopeOwnershipCheckInput` / `ScopeOwnershipCheckResult` — ownership check shapes

Sub-entry points:

- `@cinatra-ai/marketplace-sync/mapper` — the metadata mapper
- `@cinatra-ai/marketplace-sync/worker` — the sync worker

## Usage

```ts
import { runMarketplaceSync } from "@cinatra-ai/marketplace-sync";

const summary = await runMarketplaceSync({
  client,
  verdaccioPackageNames: () => listPackageNames(),
  getPackageSource: (name) => fetchPackageSource(name),
  isScopeApproved: (scope) => scopeIsApproved(scope),
});

console.log(`synced ${summary.syncedCount}/${summary.totalPackages}`);
```

## Docs

See https://docs.cinatra.ai
