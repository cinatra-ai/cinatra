// Static-bundle lifecycle ANCHOR provenance.
//
// A bundled (image-compiled) `serverEntry` extension has no install pipeline:
// its bytes ship with the host image, so without a canonical row the
// StaticBundleLoader cannot distinguish "never lifecycle-tracked" from
// "hard-uninstalled" (both read as "no `installed_extension` row"). The host
// boot seeder (src/lib/static-bundle-lifecycle.ts) therefore ensures ONE
// platform-scoped ANCHOR row per bundled serverEntry package, keyed by the
// provenance shape built here. The anchor is the durable "this package is
// lifecycle-tracked" memory:
//
//   - the loader's strict allow-list gate activates a bundled package only
//     when a live (active|locked) row exists;
//   - `uninstall` of the anchor row writes an archived TOMBSTONE instead of
//     deleting it (see lifecycle-primitive.ts), so a hard uninstall and an
//     archive converge on the same observable end-state and the boot seeder
//     can never resurrect an operator's uninstall decision.
//
// Provenance is carried IN the row (not via a host-injected predicate) so the
// tombstone decision is process-independent: any process that can run the
// lifecycle primitive tombstones correctly without host wiring.
//
// cinatra#792: the anchor is the TYPED `source.type === "bundled"` discriminant
// (`ExtensionSourceBundled`). The former stringly encoding — `type:"local"`
// with `path:"static-bundle:<name>"` and the version packed into
// `resolvedCommitOrTreeHash` as `bundled@<version>` — is RETIRED with no
// legacy-row reader shims: a legacy anchor row no longer matches
// `isStaticBundleAnchorSource`, so the boot seeder's platform-row adoption
// branch idempotently rewrites it to the typed shape (status preserved).
//
// Pure helpers — no DB, no host imports; testable in isolation.

import type { ExtensionSource, ExtensionSourceBundled } from "./canonical-types";

/**
 * Build the anchor row's typed source block. The bundled package version is a
 * first-class field so the required-in-prod verifier checks the pin against a
 * CONCRETE version instead of treating the anchor as an unverifiable
 * non-registry source. `digest` is the image-recorded content hash of the
 * sealed payload (cinatra#795: recorded at image build by
 * scripts/extensions/record-bundled-digests.mjs and stamped at boot by the
 * lifecycle seeder) — it completes the `<kind>/<slug>/<digest>` identity
 * parity with store-installed packages. Omitted (never an empty string) when
 * no digest is known: every dev boot, and rows seeded before the image
 * recorded one.
 */
export function staticBundleAnchorSource(
  packageName: string,
  version: string,
  digest?: string,
): ExtensionSourceBundled {
  return {
    type: "bundled",
    packageName,
    version,
    ...(typeof digest === "string" && digest.length > 0 ? { digest } : {}),
  };
}

/** Is this row's provenance the static-bundle anchor shape? */
export function isStaticBundleAnchorSource(
  source: ExtensionSource | null | undefined,
): source is ExtensionSourceBundled {
  return !!source && source.type === "bundled";
}

/**
 * The bundled version recorded on an anchor row, or null when the source is
 * not an anchor (or carries no version — fail closed: the required-in-prod
 * verifier then treats it as a mismatch, never a silent pass).
 */
export function staticBundleAnchorVersion(
  source: ExtensionSource | null | undefined,
): string | null {
  if (!isStaticBundleAnchorSource(source)) return null;
  const version = source.version;
  return typeof version === "string" && version.length > 0 ? version : null;
}
