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
