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
};

export type LoaderDeps = {
  /** Import a package's server entry module, or undefined if there is no importer. */
  importServerEntry: (packageName: string) => Promise<unknown> | undefined;
  /** Build the (least-privilege) host ctx for a package, given the ports it
   * declared in `requestedHostPorts` (passed straight through so the host factory
   * is grant-aware without the loader maintaining a side-map). */
  makeContext: (packageName: string, grantedPorts: readonly HostPortName[]) => ExtensionHostContext;
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
  const registered: { mod: ExtensionModule; ctx: ExtensionHostContext }[] = [];

  // Register pass — ABI gate → import → register (failure-isolated).
  for (const rec of toLoad) {
    // ABI gate FIRST, BEFORE importing — importing runs the module's top-level
    // code, so an ABI-incompatible extension must be refused before load
    // (security model §9: enforce ABI before any extension code runs).
    if (!deps.abiCompatible(rec)) {
      results.push({ packageName: rec.packageName, status: "skipped", reason: "abi-incompatible" });
      continue;
    }
    const importPromise = deps.importServerEntry(rec.packageName);
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
    const ctx = deps.makeContext(rec.packageName, rec.requestedHostPorts ?? []);
    // ABI already gated above (before import); pass `true` as defense-in-depth.
    const r = await activateExtensionModule(mod, ctx, { abiCompatible: true, installedPackages });
    results.push(r);
    if (r.status === "registered") registered.push({ mod, ctx });
  }

  // Bootstrap pass — bootstrap every registered module (after all registers).
  for (const { mod, ctx } of registered) {
    results.push(await bootstrapExtensionModule(mod, ctx));
  }
  return results;
}
