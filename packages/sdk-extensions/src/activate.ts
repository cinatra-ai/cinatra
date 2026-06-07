// The single activation path ("dual loaders, single activation").
//
// Both loaders — the dev `StaticBundleLoader` (generated manifest) and the prod
// `RuntimePackageLoader` (verified package store) — normalize an extension
// to the same `ExtensionModule` and drive it through these passes. Keeping the
// sequence in one pure, host-agnostic place (no IO, no host imports — the host
// `ctx` and the ABI-compat verdict are passed in) is what guarantees the two
// loaders can't diverge, and makes it exhaustively unit-testable.
//
// THREE PASSES, host-orchestrated across the WHOLE extension set:
//   1. Register pass — `activateExtensionModule` per module: ABI gate → config
//      gate → register(ctx). Does NOT bootstrap.
//   2. Capability-recording pass — host records capabilities for the registered set.
//   3. Bootstrap pass — `bootstrapExtensionModule` per module: runs AFTER all
//      modules have registered (the `bootstrap` lifecycle contract: "after all
//      extensions registered"), so a module's bootstrap can rely on its peers'
//      capabilities.
// `destroyExtensionModule` is the hot-reload/uninstall teardown.
//
// The host owns the steps AROUND these: manifest validation, ABI semver
// computation (it passes the verdict in), least-privilege port granting, and
// capability recording between the register and bootstrap passes.

import type { ExtensionHostContext } from "./host-context";
import { resolveServerEntry, type ExtensionModule } from "./register";

export type ActivationStatus = "registered" | "bootstrapped" | "destroyed" | "skipped" | "failed";

export type ActivationReason =
  | "abi-incompatible"
  | "config-disabled"
  | "config-resolve-false"
  | "config-resolve-threw"
  | "no-server-entry"
  | "register-threw"
  | "no-bootstrap"
  | "bootstrap-threw"
  | "no-destroy"
  | "destroy-threw";

export type ActivationResult = {
  packageName: string;
  status: ActivationStatus;
  /** Machine-readable reason for "skipped"/"failed". */
  reason?: ActivationReason;
  /** The error, when status==="failed". */
  error?: unknown;
};

export type ActivateOptions = {
  /**
   * Whether the module's `sdkAbiRange` is compatible with the host SDK ABI.
   * REQUIRED + fail-closed: the host computes the semver check and MUST pass an
   * explicit verdict; an incompatible module is refused BEFORE any of its code
   * (incl. `config.resolve`) runs (security model §9 — enforce ABI before load).
   */
  abiCompatible: boolean;
  /** Installed package set for a module's `config.resolve` dynamic gate. */
  installedPackages?: ReadonlySet<string>;
};

/**
 * Register pass — gate + register one module. ABI gate runs FIRST (no extension
 * code, including `config.resolve`, runs for an incompatible module). Returns a
 * structured result rather than throwing, so a loader activating many extensions
 * isolates per-module failures (one bad extension never aborts the boot).
 * Does NOT call `bootstrap` — that is the bootstrap pass (`bootstrapExtensionModule`).
 */
export async function activateExtensionModule(
  mod: ExtensionModule,
  ctx: ExtensionHostContext,
  opts: ActivateOptions,
): Promise<ActivationResult> {
  const packageName = mod.packageName;

  // 1. ABI-compatibility gate — refuse incompatible code BEFORE running anything.
  if (!opts.abiCompatible) {
    return { packageName, status: "skipped", reason: "abi-incompatible" };
  }

  // 2. config gate (Strapi `config.enabled` / `config.resolve`).
  if (mod.config?.enabled === false) {
    return { packageName, status: "skipped", reason: "config-disabled" };
  }
  if (mod.config?.resolve) {
    let enabled: boolean;
    try {
      enabled = await mod.config.resolve({ installedPackages: opts.installedPackages ?? new Set<string>() });
    } catch (error) {
      return { packageName, status: "failed", reason: "config-resolve-threw", error };
    }
    if (!enabled) return { packageName, status: "skipped", reason: "config-resolve-false" };
  }

  // 3. resolve the server entry (unified `register` shortcut OR split `server`).
  const server = resolveServerEntry(mod);
  if (!server) return { packageName, status: "skipped", reason: "no-server-entry" };

  // 4. register(ctx) — isolated.
  try {
    await server.register(ctx);
  } catch (error) {
    return { packageName, status: "failed", reason: "register-threw", error };
  }
  return { packageName, status: "registered" };
}

/**
 * Bootstrap pass — bootstrap one module. The host calls this for every
 * successfully-registered module AFTER all modules have registered + capabilities
 * are recorded, honoring the "bootstrap runs after all extensions registered"
 * contract.
 */
export async function bootstrapExtensionModule(
  mod: ExtensionModule,
  ctx: ExtensionHostContext,
): Promise<ActivationResult> {
  const packageName = mod.packageName;
  const server = resolveServerEntry(mod);
  if (!server?.bootstrap) return { packageName, status: "skipped", reason: "no-bootstrap" };
  try {
    await server.bootstrap(ctx);
  } catch (error) {
    return { packageName, status: "failed", reason: "bootstrap-threw", error };
  }
  return { packageName, status: "bootstrapped" };
}

/**
 * Teardown (hot-reload / uninstall — runtime path). Calls `destroy(ctx)`
 * if present. Pure; per-module failure-isolated with distinct reasons.
 */
export async function destroyExtensionModule(
  mod: ExtensionModule,
  ctx: ExtensionHostContext,
): Promise<ActivationResult> {
  const packageName = mod.packageName;
  const server = resolveServerEntry(mod);
  if (!server?.destroy) return { packageName, status: "skipped", reason: "no-destroy" };
  try {
    await server.destroy(ctx);
  } catch (error) {
    return { packageName, status: "failed", reason: "destroy-threw", error };
  }
  return { packageName, status: "destroyed" };
}
