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

// ---------------------------------------------------------------------------
// SOURCE-AWARE INSTALL-ROW PRECEDENCE (the single shared policy).
//
// A package can hold TWO live default rows at once: the platform-scoped BUNDLED
// anchor row for the implementation shipped in the image, and a marketplace
// (verdaccio) row for a version an operator installed. Every row-selection seam
// used to treat that pair as ambiguity and fail closed, so the marketplace
// install activated nothing and the bundled implementation stopped being served
// as well. Nothing was addressable and every UI action 404'd.
//
// The policy is one sentence: a marketplace install OVERRIDES the bundled
// fallback, and the bundled row is the fallback that stays available underneath
// it. It is expressed ONCE, here, and applied by every seam that picks a row
// (install/anchor resolution, setup and action addressing, the installed
// Settings representative row, and the provider-connection writer) so those
// surfaces can never disagree about which row is the package.
//
// WHAT THIS IS NOT. Precedence only SELECTS a candidate. It never makes an
// untrusted row trusted, and it never relaxes an integrity, signature, digest or
// journal gate: the selected row still has to pass every one of them, and when
// it does not, the bundled implementation is what remains. Ambiguity among
// overrides still fails closed, because guessing between two operator installs
// is exactly the case where a wrong answer is unrecoverable.
// ---------------------------------------------------------------------------

/** The row shape the precedence policy reads. Structural on purpose: each seam
 *  carries its own richer row type and passes it through unchanged. */
export type InstallRowForPrecedence = {
  // Structurally loose: every seam carries its own richer row type (and some
  // test fixtures carry a narrowed source union), so the policy reads only the
  // discriminant it actually needs.
  source?: { type?: string } | null;
  isDefault?: boolean;
};

/** A live DEFAULT marketplace row: the override candidate. */
function isMarketplaceOverrideRow(row: InstallRowForPrecedence): boolean {
  return row.isDefault !== false && row.source?.type === "verdaccio";
}

/** A live BUNDLED anchor row: the fallback the image always provides. */
function isBundledFallbackRow(row: InstallRowForPrecedence): boolean {
  return isStaticBundleAnchorSource(row.source as ExtensionSource | null | undefined);
}

/**
 * Winnow a set of LIVE candidate rows for ONE package by source precedence.
 *
 * The caller filters to live rows first (each seam has its own liveness and
 * scope rules) and then applies its own "exactly one" rule to the result, so
 * this function only ever REMOVES candidates:
 *
 *   - exactly one live marketplace default + one or more bundled fallback rows
 *     → just the marketplace row (the override wins);
 *   - more than one live marketplace default → EVERY candidate is dropped, so
 *     the caller's own rule fails closed. Two operator installs competing for
 *     one package is not something to resolve by guessing;
 *   - no marketplace default → the input unchanged (bundled-only, the state
 *     before any marketplace install);
 *   - any candidate whose source is neither bundled nor marketplace → the input
 *     unchanged. Legacy and fixture rows keep their previous behaviour exactly.
 *
 * Order is preserved, because two seams depend on first-match order among
 * equally-ranked rows.
 */
export function applyInstallRowPrecedence<T extends InstallRowForPrecedence>(
  liveRows: readonly T[],
): readonly T[] {
  if (liveRows.length < 2) return liveRows;
  // Conservative: the policy speaks only about the bundled-versus-marketplace
  // pair. A candidate of any other provenance means we do not know the ranking,
  // so nothing is reordered or dropped.
  const classified = liveRows.every(
    (row) => isBundledFallbackRow(row) || row.source?.type === "verdaccio",
  );
  if (!classified) return liveRows;

  const overrides = liveRows.filter(isMarketplaceOverrideRow);
  if (overrides.length === 0) return liveRows;
  if (overrides.length > 1) return [];
  // Exactly one override. It outranks the bundled fallback rows, and any
  // NON-default marketplace sibling stays out of a single-row selection just as
  // it did before.
  return overrides;
}
