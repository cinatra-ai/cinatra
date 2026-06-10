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
 * Split-brain guard — the StaticBundleLoader lifecycle gate, now a STRICT
 * active|locked ALLOW-LIST. A bundled `serverEntry` record activates ONLY when
 * its package has at least one live canonical `installed_extension` row
 * (effective status `"active"` — i.e. an `active` or `locked` row exists).
 * Both an explicit ARCHIVE (tombstone row, effective `"archived"`) and a HARD
 * uninstall ("no row" — absent from the status map) are SKIPPED, so the two
 * retire paths converge on the same observable end-state (IOC-34/IOC-35).
 *
 * "No row" is readable as "retired" because bundled serverEntry packages are
 * now manifest-complete: the boot seeder
 * (static-bundle-lifecycle.ts, invoked below BEFORE the status read) ensures a
 * platform-scoped lifecycle ANCHOR row per bundled serverEntry package, and
 * `uninstall` of that anchor writes an archived tombstone instead of deleting
 * it (lifecycle-primitive.ts) — so absence only occurs when seeding failed (the
 * post-boot required-set activation assertion is the loud backstop) or on an
 * admin-grade factory reset (force_delete/purge, which deliberately re-seeds
 * live on the next boot).
 *
 * Records WITHOUT a serverEntry pass through ungated: they are not
 * activation-relevant (the shared driver skips them with reason
 * "no-server-entry") and are not lifecycle-seeded, so gating them would only
 * produce false "skipped" noise.
 *
 * Pure (testable in isolation). The fail-open path on a THROWING status read
 * (DB unavailable at boot) lives in the caller — never silently dropping live
 * extensions on infrastructure failure.
 */
export function gateStaticRecordsToLiveRows<
  T extends { packageName: string; serverEntry: string | null },
>(
  records: readonly T[],
  statusByPackage: Map<string, "active" | "archived">,
): { active: T[]; skipped: string[] } {
  const active: T[] = [];
  const skipped: string[] = [];
  for (const r of records) {
    const activationRelevant = typeof r.serverEntry === "string" && r.serverEntry.length > 0;
    if (!activationRelevant || statusByPackage.get(r.packageName) === "active") active.push(r);
    else skipped.push(r.packageName);
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

  // Manifest-completeness first: ensure every bundled serverEntry package has
  // its lifecycle anchor row, so the strict allow-list below reads "no row" as
  // a real retirement and never drops a merely-untracked live extension.
  // Soft-failing by design (per-package logging inside).
  try {
    const { ensureStaticBundleLifecycleAnchors } = await import(
      "@/lib/static-bundle-lifecycle"
    );
    await ensureStaticBundleLifecycleAnchors();
  } catch (err) {
    console.error(
      "[static-bundle-loader] lifecycle anchor seeding threw (continuing to the status read):",
      err instanceof Error ? err.message : err,
    );
  }

  // Apply the strict allow-list gate. FAIL-OPEN: a canonical status read that
  // throws (DB unavailable at boot) activates all records — never silently
  // dropping live extensions on infrastructure failure.
  let records = allRecords;
  try {
    const statusByPackage = await readEffectiveStatusByPackageNames(
      allRecords.map((r) => r.packageName),
    );
    const gated = gateStaticRecordsToLiveRows(allRecords, statusByPackage);
    if (gated.skipped.length > 0) {
      console.info(
        `[static-bundle-loader] skipping ${gated.skipped.length} static serverEntry ` +
          `extension(s) without a live installed_extension row (archived or uninstalled): ` +
          gated.skipped.join(", "),
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
