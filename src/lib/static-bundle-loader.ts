import "server-only";

// The host StaticBundleLoader (the BUNDLED half of
// "dual loaders, single activation"). Thin wrapper that injects the real
// generated manifest + literal server-entry import map + the host ctx factory
// into the shared, pure `runStaticBundleActivation` driver. The
// RuntimePackageLoader injects the package-store equivalents into the
// SAME driver — that's what keeps the two loaders from diverging.
//
// Transport-registration cutover: this IS the registration source of truth for the bundled
// `serverEntry` extensions in every runtime mode — the transport/provider
// connectors bind their host deps and register their capability providers
// inside `register(ctx)`, adapted from the per-concern host services the boot
// imports publish (see register-transport-connectors.ts). Only extensions
// that declare `cinatra.serverEntry` are activated; required-set activation
// is asserted post-boot (src/lib/required-extension-activation.ts).

import {
  runStaticBundleActivation,
  isSdkAbiRangeSatisfied,
  SDK_EXTENSIONS_ABI_VERSION,
  type ActivationResult,
  type LoaderRecord,
} from "@cinatra-ai/sdk-extensions";
import { readEffectiveStatusByPackageNames } from "@cinatra-ai/extensions";
import {
  STATIC_EXTENSION_RECORDS,
  GENERATED_EXTENSION_SERVER_ENTRIES,
} from "@/lib/generated/extensions.server";
import { createExtensionHostContext } from "@/lib/extension-host-context";

/**
 * Split-brain guard — the StaticBundleLoader explicit-retired-row
 * (tombstone) gate. Drop a bundled record from activation ONLY when its package
 * has canonical `installed_extension` rows AND none are live (effective status
 * `"archived"`) — i.e. it was explicitly ARCHIVED (a tombstone row survives). A
 * package with NO rows (absent from the status map) is KEPT: bundled image
 * extensions are not necessarily lifecycle-tracked yet (today neither
 * `serverEntry` connector has a manifest row), so "no row" must NOT be read as
 * "retired". Pure (testable in isolation).
 *
 * HONEST SCOPE: this is an ARCHIVED-ROW guard, not a complete uninstall guard. A
 * HARD uninstall DELETES the `installed_extension` rows (see
 * `lifecycle-primitive` uninstall), leaving "no row" — which this gate KEEPS, so
 * a hard-uninstalled static `serverEntry` package WOULD still re-register on
 * boot. The gate cannot distinguish "never lifecycle-tracked" from "hard-deleted
 * manifest row". Closing that gap (target = strict active|locked allow-list, or
 * an archived tombstone on static-package uninstall) is gated on reconciling
 * connector manifests so `serverEntry` packages become manifest-complete.
 */
export function gateRetiredStaticRecords<T extends { packageName: string }>(
  records: readonly T[],
  statusByPackage: Map<string, "active" | "archived">,
): { active: T[]; skipped: string[] } {
  const active: T[] = [];
  const skipped: string[] = [];
  for (const r of records) {
    if (statusByPackage.get(r.packageName) === "archived") skipped.push(r.packageName);
    else active.push(r);
  }
  return { active, skipped };
}

export async function loadStaticBundleExtensions(): Promise<ActivationResult[]> {
  const allRecords: LoaderRecord[] = STATIC_EXTENSION_RECORDS.map((r) => ({
    packageName: r.packageName,
    serverEntry: r.serverEntry,
    requestedHostPorts: r.requestedHostPorts,
    sdkAbiRange: r.sdkAbiRange ?? undefined,
  }));

  // Apply the explicit-retired-row gate. FAIL-OPEN: a canonical status read that
  // throws (DB unavailable at boot) activates all records — the pre-gate
  // behavior — never silently dropping live extensions.
  let records = allRecords;
  try {
    const statusByPackage = await readEffectiveStatusByPackageNames(
      allRecords.map((r) => r.packageName),
    );
    const gated = gateRetiredStaticRecords(allRecords, statusByPackage);
    if (gated.skipped.length > 0) {
      console.info(
        `[static-bundle-loader] skipping ${gated.skipped.length} archived (tombstoned) ` +
          `static extension(s): ${gated.skipped.join(", ")}`,
      );
    }
    records = gated.active;
  } catch (err) {
    console.warn(
      "[static-bundle-loader] canonical status read failed — activating all bundled " +
        "records (fail-open):",
      err instanceof Error ? err.message : err,
    );
  }

  return runStaticBundleActivation(records, {
    importServerEntry: (packageName) => GENERATED_EXTENSION_SERVER_ENTRIES[packageName]?.(),
    // grantedPorts is passed straight through by the loader from each record's
    // requestedHostPorts — no side-map needed. Each ctx exposes only those ports.
    makeContext: (packageName, grantedPorts) => createExtensionHostContext(packageName, grantedPorts),
    // ABI verdict: does the frozen host SDK ABI satisfy the record's declared
    // sdkAbiRange? Unpinned ranges permit; a declared-but-incompatible range
    // (or a host below the range floor) is refused before any extension code runs.
    abiCompatible: (rec) => isSdkAbiRangeSatisfied(SDK_EXTENSIONS_ABI_VERSION, rec.sdkAbiRange),
  });
}
