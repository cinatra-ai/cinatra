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
// imports publish (see register-host-connector-services.ts). Only extensions
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
import {
  ExtensionModuleAbsentError,
  isDegradedExtensionLoad,
} from "@/lib/extension-load-guard";

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
    // cinatra#982: threaded UNVALIDATED through to `makeContext` below, which
    // validates it (namespaced-vs-legacy security guard) before wiring the
    // settings/secrets ports.
    envOverrides: r.envOverrides ?? undefined,
    resolution: r.resolution,
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

  const results = await runStaticBundleActivation(records, staticActivationOptions());
  // cinatra#2762: record WHAT this pass put in service. At boot the bundled
  // records activate first and the RuntimePackageLoader's installs then replace
  // them, so the last successful writer per package is the truth — and a package
  // whose install never registers keeps the bundled record, which is exactly the
  // "installed but not in service" state the settings surface must name.
  await recordBundledActivations(records, results);
  return results;
}

/**
 * Record the bundled version of every record that actually REGISTERED. Never
 * throws: a descriptive record must not be able to fail a boot pass.
 *
 * The recorder is reached by DYNAMIC import, like the version-keyed serving
 * registry the RuntimePackageLoader retains through: this module is reachable
 * from the locked dev-perf routes whose static import graph is ratcheted
 * shrink-only (cinatra#732), and a descriptive side-signal must not spend a
 * static edge there.
 */
async function recordBundledActivations(
  records: readonly LoaderRecord[],
  results: readonly ActivationResult[],
): Promise<void> {
  try {
    const registered = new Set(
      results
        .filter((r) => r.status === "registered" || r.status === "bootstrapped")
        .map((r) => r.packageName),
    );
    if (registered.size === 0) return;
    // A package emits ONE result per phase, so a register-passes /
    // bootstrap-throws activation yields both a success and a failure. Only a
    // clean activation is serving (the `summarizeActivation` rule).
    const failed = new Set(
      results.filter((r) => r.status === "failed").map((r) => r.packageName),
    );
    const versionByPackage = new Map(
      STATIC_EXTENSION_RECORDS.map((r) => [r.packageName, r.version ?? null]),
    );
    const { recordServingImplementation } = await import("@/lib/extension-serving-record");
    for (const packageName of registered) {
      if (failed.has(packageName)) continue;
      if (!records.some((r) => r.packageName === packageName)) continue;
      recordServingImplementation({
        packageName,
        origin: "bundled",
        version: versionByPackage.get(packageName) ?? null,
      });
    }
  } catch (err) {
    console.warn(
      "[static-bundle-loader] could not record what the bundled pass put in service: %s",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** The activation options BOTH the boot pass and the targeted reactivation seam
 *  use, so a package reactivated on its own is wired exactly as boot wires it. */
function staticActivationOptions() {
  return {
    // A `guardedOptional` server entry whose module is absent post-build
    // resolves the standardized degraded result — convert it to a THROWN
    // typed error so the shared driver records a failure-isolated
    // per-extension ActivationResult ("failed"/"register-threw") instead of
    // normalizing a degraded sentinel as an entry-less module. Required
    // entries are emitted UNGUARDED, so their absence throws natively and the
    // post-boot required-set assertion keeps its loud contract (cinatra#7).
    importServerEntry: (packageName) => {
      const entry = GENERATED_EXTENSION_SERVER_ENTRIES[packageName];
      if (!entry) return undefined;
      return entry.load().then((ns) => {
        if (isDegradedExtensionLoad(ns)) {
          throw new ExtensionModuleAbsentError(ns.specifier, ns.reason);
        }
        return ns;
      });
    },
    // grantedPorts is passed straight through by the loader from each record's
    // requestedHostPorts — no side-map needed. Each ctx exposes only those ports.
    // `record` carries the manifest-declared env-override input (cinatra#982),
    // validated inside `createExtensionHostContext` before the settings/secrets
    // ports are wired.
    makeContext: (packageName, grantedPorts, record) =>
      createExtensionHostContext(packageName, grantedPorts, {
        envOverrides: record.envOverrides,
        resolution: record.resolution,
      }),
    // ABI verdict: does the frozen host SDK ABI satisfy the record's declared
    // sdkAbiRange? Unpinned ranges permit; a declared-but-incompatible range
    // (or a host below the range floor) is refused before any extension code runs.
    abiCompatible: (rec: LoaderRecord) =>
      isSdkAbiRangeSatisfied(SDK_EXTENSIONS_ABI_VERSION, rec.sdkAbiRange),
  };
}

// ---------------------------------------------------------------------------
// TARGETED BUNDLED REACTIVATION.
//
// Putting the image-bundled implementation back in service for ONE package,
// after a marketplace override was archived because it could not activate.
//
// Why this is its own seam and not a call to the activator or the boot loader:
//   - `activateInstalledPackageInProcess` resolves an exact-org RUNTIME anchor.
//     Once the override row is archived there is no anchor to resolve, and the
//     bundled implementation has no install anchor at all: its bytes ship in the
//     image. It simply cannot reach the bundled code.
//   - `loadStaticBundleExtensions` would re-run every bundled record in the
//     image. Re-registering dozens of unrelated packages to recover one is a
//     much larger blast radius than the failure being compensated.
//
// So this activates exactly one record, under the SAME per-package install lock
// every other lifecycle path holds, and tears down whatever partial runtime
// registrations the failed override left behind first: a half-registered
// override still owns global names, and activating the bundled module beneath it
// would leave two registrations racing for them.
// ---------------------------------------------------------------------------
export async function reactivateBundledFallbackInProcess(
  packageName: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { withInstallLock } = await import("@cinatra-ai/agents");
  return withInstallLock(packageName, async () => {
    const record = STATIC_EXTENSION_RECORDS.find((r) => r.packageName === packageName);
    if (!record) {
      return { ok: false as const, reason: "this package does not ship in the image" };
    }
    if (typeof record.serverEntry !== "string" || record.serverEntry.length === 0) {
      // Nothing to register: a metadata-only bundled record is served from the
      // manifest, so archiving the override already restored it.
      return { ok: true as const };
    }
    // Drop whatever the failed override registered before the bundled module
    // registers, so the two never coexist.
    //
    // VERIFIED, not assumed. The teardown hook swallows its own failures by
    // contract (it is best-effort for the purge path it was written for), so a
    // try/catch around it proves nothing. The registry is therefore re-read
    // afterwards: if the package still holds registrations, the teardown did not
    // take, and activating the bundled module on top would leave two
    // registrations serving one package. Refusing is the safe answer, because
    // the boot loader brings the bundled version back cleanly on the next start.
    try {
      const { fireExtensionCapabilityTeardown } = await import("@cinatra-ai/extensions");
      await fireExtensionCapabilityTeardown(packageName);
    } catch (err) {
      // CONSTANT format string with %s placeholders: the package name reaches the
      // log as an ARGUMENT, never in the format position. It is already bounded
      // here (it matched a bundled record above), and the repo keeps this shape
      // everywhere so no caller can turn a log line into a format string.
      console.warn(
        "[static-bundle-loader] capability teardown before bundled reactivation of %s threw (continuing): %s",
        record.packageName,
        err instanceof Error ? err.message : String(err),
      );
    }
    try {
      const { hasExtensionUiForPackage } = await import("@/lib/extension-ui-registry");
      if (hasExtensionUiForPackage(packageName)) {
        return {
          ok: false as const,
          reason:
            "the previous registrations for this package could not be torn down, so the " +
            "bundled version was not activated on top of them",
        };
      }
    } catch {
      /* the registry read is a safety check; its own failure must not block the
         recovery the operator asked for. */
    }
    const loaderRecord: LoaderRecord = {
      packageName: record.packageName,
      serverEntry: record.serverEntry,
      requestedHostPorts: record.requestedHostPorts,
      sdkAbiRange: record.sdkAbiRange ?? undefined,
      envOverrides: record.envOverrides ?? undefined,
      resolution: record.resolution,
    };
    let results: ActivationResult[];
    try {
      results = await runStaticBundleActivation([loaderRecord], staticActivationOptions());
    } catch (err) {
      return {
        ok: false as const,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    const result = results[0];
    // The driver reports `registered` (a register(ctx) that succeeded) or
    // `bootstrapped` (register plus a bootstrap hook). Anything else, including
    // `skipped`, means the bundled implementation is NOT serving.
    const activated = result?.status === "registered" || result?.status === "bootstrapped";
    if (!activated) {
      return {
        ok: false as const,
        reason: result?.reason ?? result?.status ?? "the bundled module did not activate",
      };
    }
    // The image's version is what serves this package now (cinatra#2762). The
    // teardown above already dropped whatever the failed override recorded, so
    // this replaces rather than races it. Dynamic import for the same reason the
    // boot pass above uses one; best-effort, because a descriptive record must
    // never turn a completed recovery into a reported failure.
    try {
      const { recordServingImplementation } = await import("@/lib/extension-serving-record");
      recordServingImplementation({
        packageName,
        origin: "bundled",
        version: record.version ?? null,
      });
    } catch {
      /* the record is descriptive; the bundled module IS serving either way. */
    }
    // The registries changed, so the generation-keyed caches must rebuild.
    try {
      const { bumpActivationGeneration } = await import("@/lib/extension-activation-generation");
      bumpActivationGeneration("activate");
    } catch {
      /* a missing generation bump only costs a stale cache read; never fatal here. */
    }
    return { ok: true as const };
  });
}
