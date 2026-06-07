import "server-only";
// Package-internal handler-registration fallback. purge-deps is the host seam
// loaded by BOTH the /api/extensions/purge route and the MCP dry-run, so
// registering here guarantees the 5 kind handlers exist before
// purgeExtension -> forceDelete (otherwise it would reach an EMPTY
// extensionRegistry AFTER Verdaccio unpublish already succeeded). register() is
// idempotent (Map.set by typeId), so this composes safely with the host wiring
// in `@/lib/extensions` — which the route ALSO imports for the
// capability-teardown hook (the package-side handler-bootstrap cannot set that
// hook because it cannot import `@/lib`).
import "./handler-bootstrap";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PurgeDeps } from "./purge";

// ---------------------------------------------------------------------------
// Host-bound wiring for the purge pipeline. Kept separate from purge.ts so the
// pipeline logic stays unit-testable with injected fakes (purge.ts has no
// host-binding imports). This module is host-bound (@/lib + @cinatra-ai/*).
// ---------------------------------------------------------------------------

/**
 * Scan on-disk source extensions for any whose `cinatra/oas.json` references
 * `packageName` (an embedded subflow / child agent that lives in the repo but
 * may not have a compiled DB row yet). Returns the dependents' package names.
 */
async function listOnDiskOasDependents(
  packageName: string,
): Promise<string[]> {
  const root = path.join(process.cwd(), "extensions", "cinatra-ai");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const dependents: string[] = [];
  for (const slug of entries) {
    const oasPath = path.join(root, slug, "cinatra", "oas.json");
    const pkgPath = path.join(root, slug, "package.json");
    let oasText: string;
    let ownName: string | null = null;
    try {
      oasText = await readFile(oasPath, "utf8");
    } catch {
      continue;
    }
    try {
      ownName = JSON.parse(await readFile(pkgPath, "utf8")).name ?? null;
    } catch {
      ownName = null;
    }
    if (ownName === packageName) continue; // the package itself
    if (oasText.includes(`"${packageName}"`) && ownName) {
      dependents.push(ownName);
    }
  }
  return dependents;
}

export async function defaultPurgeDeps(): Promise<PurgeDeps> {
  const { loadVerdaccioConfigForServer } = await import(
    "@/lib/verdaccio-config"
  );
  const { getAgentPackage } = await import("@cinatra-ai/registries");
  const {
    listAgentPackageVersions,
    unpublishAllAgentPackageVersions,
    downloadAgentPackageTarball,
    getRegistryPackageKind,
    getRegistryPackument,
  } = await import("@cinatra-ai/agents/verdaccio/client");
  const {
    readAgentTemplateByPackageName,
    readAgentTemplatesDependingOn,
    readAgentTemplatesReferencingChildPackage,
    purgeAgentTemplateAtomic,
  } = await import("@cinatra-ai/agents/store");
  const { withGlobalExtensionLifecycleLock } = await import(
    "@cinatra-ai/agents"
  );
  const {
    strictPurgeExtensionDir,
    restoreExtensionDirFromTarball,
    extensionDirPresent,
  } = await import("@cinatra-ai/agents/extension-handler-rollback");

  return {
    loadVerdaccioConfig: async () =>
      (await loadVerdaccioConfigForServer()) as unknown as {
        registryUrl: string;
        packageScope: string;
        token?: string | null;
      },
    resolvePackageKind: (packageName, config) =>
      getRegistryPackageKind(packageName, config as never),
    getAgentPackage: (input, config) =>
      getAgentPackage(input, config as never) as never,
    listVersions: (packageName, config) =>
      listAgentPackageVersions(packageName, config as never),
    readTemplateByPackageName: async (packageName) => {
      const t = await readAgentTemplateByPackageName(packageName);
      // FULL row for the audit/forensics trail (not used for rollback).
      return t ? ({ ...t } as { id: string } & Record<string, unknown>) : null;
    },
    // GLOBAL lock (not per-package): the whole purge saga is strictly
    // serialized against ALL install/update/uninstall/purge, closing the
    // dependency-tree-install race.
    withLifecycleLock: (_packageName, fn) => withGlobalExtensionLifecycleLock(fn),
    dbPurgeAtomic: async (packageName) => {
      const r = await purgeAgentTemplateAtomic(packageName);
      return { deleted: r.deleted, snapshot: r.snapshot };
    },
    extensionDirPresent: (packageName) => extensionDirPresent(packageName),
    strictDiskPurge: (packageName, options) =>
      strictPurgeExtensionDir(packageName, options),
    restoreDirFromTarball: (input) => restoreExtensionDirFromTarball(input),
    fetchPackument: (packageName, config) =>
      getRegistryPackument(packageName, config as never),
    readTemplatesDependingOn: async (packageName) => {
      const rows = await readAgentTemplatesDependingOn(packageName);
      return rows.map((r) => ({ packageName: r.packageName ?? "" }));
    },
    readTemplatesReferencingChild: async (packageName) => {
      const rows =
        await readAgentTemplatesReferencingChildPackage(packageName);
      return rows.map((r) => ({ packageName: r.packageName ?? "" }));
    },
    listOnDiskOasDependents,
    unpublishAllVersions: (input, config) =>
      unpublishAllAgentPackageVersions(input, config as never),
    downloadTarball: (input, config) =>
      downloadAgentPackageTarball(input, config as never),
  };
}
