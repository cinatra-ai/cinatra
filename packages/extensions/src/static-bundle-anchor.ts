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
// Pure helpers — no DB, no host imports; testable in isolation.

import type { ExtensionSource, ExtensionSourceLocal } from "./canonical-types";

/** `source.path` prefix that marks a row as the static-bundle anchor. */
export const STATIC_BUNDLE_ANCHOR_PATH_PREFIX = "static-bundle:";

/** `resolvedCommitOrTreeHash` prefix carrying the bundled package version. */
const ANCHOR_VERSION_PREFIX = "bundled@";

/** The anchor row's `source.path` for a bundled package. */
export function staticBundleAnchorPath(packageName: string): string {
  return `${STATIC_BUNDLE_ANCHOR_PATH_PREFIX}${packageName}`;
}

/**
 * Build the anchor row's source block. The bundled package version is recorded
 * in `resolvedCommitOrTreeHash` (as `bundled@<version>`) so the required-in-prod
 * verifier can check the pin against a CONCRETE version instead of treating the
 * anchor as an unverifiable non-registry source.
 */
export function staticBundleAnchorSource(
  packageName: string,
  version: string,
): ExtensionSourceLocal {
  return {
    type: "local",
    path: staticBundleAnchorPath(packageName),
    resolvedCommitOrTreeHash: `${ANCHOR_VERSION_PREFIX}${version}`,
  };
}

/** Is this row's provenance the static-bundle anchor shape? */
export function isStaticBundleAnchorSource(
  source: ExtensionSource | null | undefined,
): source is ExtensionSourceLocal {
  return (
    !!source &&
    source.type === "local" &&
    typeof source.path === "string" &&
    source.path.startsWith(STATIC_BUNDLE_ANCHOR_PATH_PREFIX)
  );
}

/**
 * The bundled version recorded on an anchor row, or null when the source is
 * not an anchor (or carries no parseable version — fail closed: the
 * required-in-prod verifier then treats it as a mismatch, never a silent pass).
 */
export function staticBundleAnchorVersion(
  source: ExtensionSource | null | undefined,
): string | null {
  if (!isStaticBundleAnchorSource(source)) return null;
  const h = source.resolvedCommitOrTreeHash;
  if (typeof h !== "string" || !h.startsWith(ANCHOR_VERSION_PREFIX)) return null;
  const version = h.slice(ANCHOR_VERSION_PREFIX.length);
  return version.length > 0 ? version : null;
}
