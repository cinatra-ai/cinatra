// Shared loader activation driver — both loaders, one activation path.
//
// The pure, dependency-injected core that BOTH loaders run: the dev
// `StaticBundleLoader` (generated manifest + literal import map) and the prod
// `RuntimePackageLoader` (verified package store). Given the normalized
// records + a way to import each server entry + a host-ctx factory + an
// ABI-compat verdict, it drives the passes via `activateExtensionModule` /
// `bootstrapExtensionModule`: register-all (failure-isolated) THEN bootstrap-all.
// Pure (no IO, no host imports) so it's exhaustively unit-testable; the host
// wrapper injects the real generated data + ctx factory.

import type { ExtensionHostContext, HostPortName } from "./host-context";
import { normalizeServerModule, type ExtensionModule } from "./register";
import { activateExtensionModule, bootstrapExtensionModule, type ActivationResult } from "./activate";

/** The minimal record the loader needs (a subset of NormalizedExtensionRecord). */
export type LoaderRecord = {
  packageName: string;
  serverEntry: string | null;
  sdkAbiRange?: string;
  requestedHostPorts?: HostPortName[];
  /**
   * RAW `cinatra.envOverrides` pass-through (cinatra#982), or absent when the
   * package declares none. Threaded to `makeContext` UNVALIDATED — the host ctx
   * factory validates it (namespaced-vs-legacy security guard) before wiring
   * the settings/secrets ports.
   */
  envOverrides?: Record<string, string> | null;
  /**
   * Generator-owned presence classification (`"required"` = the host-locked
   * `systemExtensions` set; see `./manifest`). Absent/unknown MUST be treated
   * as NOT required by any consumer (fail-closed for the legacy-env-name
   * grandfathering guard) — only the static-bundle loader (which sources this
   * from the generated manifest) ever sets it to `"required"`.
   */
  resolution?: "required" | "guardedOptional";
  /**
   * The package VERSION this record activates (cinatra#1040 S4). Set by the host
   * wrapper from the TRUSTED install anchor (the DB row's `source.version`), NOT
   * the on-disk manifest — so it is part of the (packageName, version) activation
   * identity the duplicate fence keys on. Absent for legacy/un-versioned records
   * (the fence then falls back to whole-package fail-closed).
   */
  version?: string;
  /**
   * Whether this version is the DEFAULT for its package (cinatra#1040 S4). Set
   * from the anchor's `isDefault`. The DEFAULT version alone owns the package's
   * unversioned GLOBAL names (MCP tool names, capability providers, connector
   * routes, agent mounts); a NON-DEFAULT sibling version (`isDefault === false`)
   * activates side-by-side against a side-effect-free host context and its
   * bootstrap pass is skipped. Absent counts as default (single-version/legacy).
   */
  isDefault?: boolean;
};

export type LoaderDeps = {
  /**
   * Import a package's server entry module, or undefined if there is no importer.
   * The full `record` is passed alongside the name (cinatra#1040 S4) so the
   * importer can resolve the exact SIDE-BY-SIDE version record — two records may
   * share a `packageName` (different versions/digests), so the name alone no
   * longer uniquely identifies the entry to import. The dev loader (one manifest
   * per name) may ignore `record` and key on `packageName`.
   */
  importServerEntry: (packageName: string, record: LoaderRecord) => Promise<unknown> | undefined;
  /** Build the (least-privilege) host ctx for a package, given the ports it
   * declared in `requestedHostPorts` (passed straight through so the host factory
   * is grant-aware without the loader maintaining a side-map) and the full
   * record (so the factory can read `envOverrides`/`resolution`). */
  makeContext: (
    packageName: string,
    grantedPorts: readonly HostPortName[],
    record: LoaderRecord,
  ) => ExtensionHostContext;
  /** The host's ABI-compat verdict for a record (semver, host-computed). */
  abiCompatible: (record: LoaderRecord) => boolean;
  /** Installed package set for `config.resolve`; defaults to all record names. */
  installedPackages?: ReadonlySet<string>;
};

/**
 * Activate every record that declares a `serverEntry`. Register-all (register
 * pass, failure-isolated) then bootstrap-all (bootstrap pass) — honoring
 * "bootstrap runs after all extensions registered". Returns one result per
 * register attempt + one per bootstrap attempt; never throws.
 */
export async function runStaticBundleActivation(
  records: readonly LoaderRecord[],
  deps: LoaderDeps,
): Promise<ActivationResult[]> {
  const toLoad = records.filter((r) => typeof r.serverEntry === "string" && r.serverEntry.length > 0);
  const installedPackages = deps.installedPackages ?? new Set(records.map((r) => r.packageName));
  const results: ActivationResult[] = [];
  const registered: { mod: ExtensionModule; ctx: ExtensionHostContext; isDefault: boolean }[] = [];

  // Register pass — ABI gate → import → register (failure-isolated).
  for (const rec of toLoad) {
    // ABI gate FIRST, BEFORE importing — importing runs the module's top-level
    // code, so an ABI-incompatible extension must be refused before load
    // (security model §9: enforce ABI before any extension code runs).
    if (!deps.abiCompatible(rec)) {
      results.push({ packageName: rec.packageName, status: "skipped", reason: "abi-incompatible" });
      continue;
    }
    const importPromise = deps.importServerEntry(rec.packageName, rec);
    if (importPromise === undefined) {
      results.push({ packageName: rec.packageName, status: "skipped", reason: "no-server-entry" });
      continue;
    }
    let serverModule: unknown;
    try {
      serverModule = await importPromise;
    } catch (error) {
      results.push({ packageName: rec.packageName, status: "failed", reason: "register-threw", error });
      continue;
    }
    // Preserve the WHOLE imported shape (server/config/bootstrap/destroy), not
    // just `register` — otherwise the config gate never fires + bootstrap/destroy
    // are silently dropped.
    const mod = normalizeServerModule(rec.packageName, serverModule);
    if (!mod) {
      results.push({ packageName: rec.packageName, status: "skipped", reason: "no-server-entry" });
      continue;
    }
    const ctx = deps.makeContext(rec.packageName, rec.requestedHostPorts ?? [], rec);
    // ABI already gated above (before import); pass `true` as defense-in-depth.
    const r = await activateExtensionModule(mod, ctx, { abiCompatible: true, installedPackages });
    results.push(r);
    if (r.status === "registered") registered.push({ mod, ctx, isDefault: rec.isDefault !== false });
  }

  // Bootstrap pass — bootstrap every registered module (after all registers),
  // EXCEPT non-default side-by-side versions (cinatra#1040 S4). A non-default
  // version registers only (against a side-effect-free host context) to prove it
  // activates without claiming the default's global names; running its bootstrap
  // could duplicate package-keyed side effects (settings/secrets writes, job/
  // notification emission) that belong to the DEFAULT version. Edge-bound serving
  // of a non-default version is threaded in a later slice (S5).
  for (const { mod, ctx, isDefault } of registered) {
    if (!isDefault) continue;
    results.push(await bootstrapExtensionModule(mod, ctx));
  }
  return results;
}
