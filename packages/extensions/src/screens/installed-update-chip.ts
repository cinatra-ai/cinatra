// Pure derivation for the §III installed-card "Update available" chip
// (cinatra#1041 outcome 3). Sibling of `resolveMarketplaceCardCta`
// (marketplace-card-model.ts): a pure function mapping the cached update read
// model + the installed version to one of the five design-spec render states.
//
// The design spec §III defines
// FOUR user-facing states plus a fail-quiet nothing:
//
//   • update-available — a newer COMPATIBLE registry version is published →
//       the blue circular-arrow chip renders on the spec line.
//   • up-to-date       — installed is the latest (or newer) → no chip.
//   • incompatible     — a newer version exists but its declared ABI needs a
//       newer Cinatra → the spec line greys out under the §I ABI-compat
//       treatment and shows NO chip and NO text (the "Newer version needs a
//       newer Cinatra" wording surfaces on the §V settings page's
//       Maintenance · Update row, never on the card).
//   • non-comparable   — github refs, `0.0.0-dev.*` and local builds have no
//       registry version to compare, so they NEVER show a chip and NEVER fall
//       back to a string-equality guess (outcome 4).
//   • none             — FAIL-QUIET: the cached read model is stale, missing
//       (never synced), or carries no resolvable latest, so no verdict is
//       possible. Renders nothing (never a stale/wrong chip).
//
// This function is the whole verdict contract in one testable place; the
// screen computes `compatVerdict` from the read model's `latestSdkAbiRange`
// via the host's `deriveExtensionCompatState` (exactly as the marketplace CTA
// caller does) and passes it in structurally, so this module needs neither the
// host ABI constant nor a `src/lib` import.

import {
  comparePluginVersions,
  isExactVersion,
} from "@cinatra-ai/registries/src/version-compare";
import { isDevVersion } from "../dev-version";

/** The five render outcomes for the installed-card update affordance. */
export type InstalledUpdateChipState =
  | "update-available"
  | "up-to-date"
  | "incompatible"
  | "non-comparable"
  | "none";

/**
 * The ABI-compat verdict for the LATEST registry version, computed by the
 * caller from the read model's `latestSdkAbiRange` via
 * `deriveExtensionCompatState`. Structural (mirrors `ExtensionCompatState`) so
 * this pure module carries no dependency on the host compat helper.
 */
export type LatestCompatVerdict = "compatible" | "incompatible" | "unknown";

export type DeriveInstalledUpdateChipInput = {
  /**
   * The RAW installed version from source provenance (registry semver, a
   * `0.0.0-dev.*` dev build, or `null` for a non-registry source such as a
   * github ref / local install). Only an exact, non-dev semver is comparable.
   */
  installedVersion: string | null | undefined;
  /**
   * The latest COMPARABLE (semver) version the read model last observed, or
   * `null` when there is no resolvable semver latest. Never a range/dist-tag.
   */
  latestVersion: string | null | undefined;
  /** The ABI-compat verdict of `latestVersion` (see `LatestCompatVerdict`). */
  latestCompat: LatestCompatVerdict;
  /**
   * True when the cached read-model entry is stale, missing, or unparseable
   * (from `readUpdateModelForInstalled` — missing/expired all read stale). A
   * stale readout yields NO verdict (fail-quiet).
   */
  stale: boolean;
};

/**
 * Derive the installed-card update chip state. Precedence:
 *   1. Non-comparable installed source (null / non-semver / dev build) →
 *      `non-comparable`, regardless of read-model freshness — such a source
 *      never has a registry version to compare against.
 *   2. Fail-quiet — a stale/missing readout or no resolvable latest → `none`.
 *   3. Not semver-newer (current / installed-newer / equal) → `up-to-date`.
 *   4. Semver-newer but the newer version's declared ABI is incompatible with
 *      this host → `incompatible` (greyed, no chip).
 *   5. Semver-newer and compatible/unknown ABI → `update-available` (chip).
 */
export function deriveInstalledUpdateChipState(
  input: DeriveInstalledUpdateChipInput,
): InstalledUpdateChipState {
  const { installedVersion, latestVersion, latestCompat, stale } = input;

  // 1. Non-comparable installed source — github refs, local builds (no version
  //    provenance → null), dist-tags/ranges (not an exact semver), and
  //    `0.0.0-dev.*` dev builds. Never guessed via string equality (outcome 4).
  if (
    installedVersion == null ||
    !isExactVersion(installedVersion) ||
    isDevVersion(installedVersion)
  ) {
    return "non-comparable";
  }

  // 2. Fail-quiet — the gatekept read model has no trustworthy latest for this
  //    package (stale / never synced / no resolvable semver latest).
  if (stale || latestVersion == null) {
    return "none";
  }

  // 3. Nothing newer in the registry.
  if (comparePluginVersions(installedVersion, latestVersion) !== "update-available") {
    return "up-to-date";
  }

  // 4/5. A newer version exists — grey it out when its declared ABI is
  //      incompatible with this host (updating would hit the same activation
  //      gate that blocks the marketplace Update CTA); otherwise offer the chip.
  return latestCompat === "incompatible" ? "incompatible" : "update-available";
}
