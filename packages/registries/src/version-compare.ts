// Pure helper returning a 4-state enum classifying an installed vs. latest version pair.

import * as semver from "semver";

export type VersionComparisonResult =
  | "not-installed"
  | "current"
  | "update-available"
  | "installed-newer";

export function comparePluginVersions(
  installed: string | null | undefined,
  latest: string,
): VersionComparisonResult {
  if (installed == null) return "not-installed";
  if (!semver.valid(installed) || !semver.valid(latest)) {
    // Fallback — strict string equality for malformed versions.
    return installed === latest ? "current" : "update-available";
  }
  if (semver.gt(latest, installed)) return "update-available";
  if (semver.gt(installed, latest)) return "installed-newer";
  return "current";
}

/**
 * Range-satisfaction primitive for the host's dependency planner (#180): the
 * host app deliberately has no direct semver dependency — version semantics
 * live HERE, next to the resolver that already owns them. Prereleases are
 * included (an explicitly pinned prerelease must satisfy the range that
 * pinned it).
 */
export function satisfiesVersionRange(version: string, range: string): boolean {
  return semver.satisfies(version, range, { includePrerelease: true });
}

/** True when `v` is a concrete semver version (not a range/dist-tag). */
export function isExactVersion(v: string): boolean {
  return semver.valid(v) !== null;
}
