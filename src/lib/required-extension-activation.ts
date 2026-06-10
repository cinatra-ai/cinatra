import "server-only";

// Required-extension activation assertion (Loader hardening for the registration cutover).
//
// After the transport/provider cutover, the connectors that ship a
// `serverEntry` REGISTER THEMSELVES at loader activation — there is no longer
// a static host fallback wiring them. Both loaders are deliberately
// failure-isolated (a broken extension never blocks boot), which is correct
// for OPTIONAL extensions but would let a REQUIRED transport silently
// disappear (e.g. platform mail dead because the email facade never
// activated). This module closes that gap: after the boot loaders run,
// cross-check the activation results against the intersection of
//   (a) the `cinatra.requiredExtensions` set (required-in-prod), and
//   (b) the manifest records that declare a `serverEntry`
// and FAIL LOUDLY on any miss — console.error always; THROW outside
// development (prod boots must not come up half-wired), kill-switchable via
// CINATRA_DISABLE_REQUIRED_ACTIVATION_ASSERT=true for emergency operability.

import type { ActivationResult } from "@cinatra-ai/sdk-extensions";
import { readRequiredInProdPackages } from "@cinatra-ai/extensions/required-in-prod";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";

export type RequiredActivationFailure = {
  packageName: string;
  /** "missing" = no activation result at all; otherwise the failed status. */
  status: string;
  reason?: string;
};

/** Activation statuses that mean "this package's register(ctx) ran". */
const ACTIVATED_STATUSES: ReadonlySet<string> = new Set(["registered", "bootstrapped"]);

/**
 * Pure cross-check: every required package that declares a serverEntry must
 * have at least one activated (`registered`/`bootstrapped`) result. Exported
 * for unit testing.
 */
export function findRequiredActivationFailures(
  results: readonly ActivationResult[],
  requiredPackages: readonly string[],
  serverEntryPackages: ReadonlySet<string>,
): RequiredActivationFailure[] {
  const byPackage = new Map<string, ActivationResult[]>();
  for (const r of results) {
    const list = byPackage.get(r.packageName) ?? [];
    list.push(r);
    byPackage.set(r.packageName, list);
  }
  const failures: RequiredActivationFailure[] = [];
  for (const pkg of requiredPackages) {
    if (!serverEntryPackages.has(pkg)) continue;
    const rs = byPackage.get(pkg);
    if (!rs || rs.length === 0) {
      failures.push({ packageName: pkg, status: "missing" });
      continue;
    }
    const ok = rs.some((r) => ACTIVATED_STATUSES.has(r.status));
    if (!ok) {
      const worst = rs[0];
      failures.push({ packageName: pkg, status: worst.status, reason: worst.reason });
    }
  }
  return failures;
}

/** The manifest packages that declare a serverEntry (activation-expected). */
export function serverEntryPackagesFromManifest(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [pkg, record] of Object.entries(STATIC_EXTENSION_MANIFEST)) {
    if (typeof record.serverEntry === "string" && record.serverEntry.length > 0) {
      out.add(pkg);
    }
  }
  return out;
}

/**
 * Assert the boot loaders activated every required serverEntry package.
 * Call AFTER all boot loaders ran, with their combined results.
 */
export function assertRequiredExtensionActivations(results: readonly ActivationResult[]): void {
  if (process.env.CINATRA_DISABLE_REQUIRED_ACTIVATION_ASSERT === "true") return;
  let required: string[];
  try {
    required = readRequiredInProdPackages();
  } catch (err) {
    console.warn(
      "[required-extension-activation] could not read required-extension set (skipping assert):",
      err instanceof Error ? err.message : err,
    );
    return;
  }
  const failures = findRequiredActivationFailures(
    results,
    required,
    serverEntryPackagesFromManifest(),
  );
  if (failures.length === 0) return;
  const detail = failures
    .map((f) => `${f.packageName}: ${f.status}${f.reason ? ` (${f.reason})` : ""}`)
    .join("; ");
  const message =
    `[required-extension-activation] ${failures.length} REQUIRED serverEntry extension(s) ` +
    `did not activate — their registrations (transports/providers/capabilities) are NOT wired: ${detail}`;
  console.error(message);
  if (process.env.CINATRA_RUNTIME_MODE !== "development") {
    throw new Error(message);
  }
}
