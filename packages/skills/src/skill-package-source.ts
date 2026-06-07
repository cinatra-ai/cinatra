// Pure-function source-kind dispatcher for skill extensions. Lives in its own
// file so unit tests can import it without pulling in the extension-handler's
// server-only sibling modules (agents-store, mcp-server credentials, etc.).
//
// Two supported backends:
//
//   - github     : `github:owner/repo` or bare `owner/repo` for
//                  end-user-published GitHub skills. PackageRef.version
//                  is unused for this backend (a SHA pin is encoded in
//                  the package name when needed).
//
//   - verdaccio  : `@<scope>/<pkg>` with the package published to
//                  Cinatra's Verdaccio. PackageRef.version, when present,
//                  pins the installed version; otherwise the registry's
//                  dist-tag `latest` is used. Mandatory for vendored
//                  bundles like `@anthropics/skills`.
//
// Persisted-id shape locked here so install / update / uninstall / archive
// / restore all converge on the same skill_packages row:
//
//   github    -> `github:${ref.packageName}`
//   verdaccio -> `verdaccio:${ref.packageName}@${version}`

import type { PackageRef } from "@cinatra-ai/extension-types";

/**
 * Pure-fn id builder shared by extension-handler + verdaccio install.
 * Kept in this leaf module so unit tests can import it without dragging
 * server-only dependencies through.
 *
 * Deliberately EXCLUDES the version from the id so install -> archive ->
 * restore -> uninstall all flip the same row even when restore is called
 * without a version (the extensions_restore MCP handler + the form-action
 * callers omit it by design). The installed version is stored inside the
 * row's payload, not in the id. Matches the GitHub backend's
 * `github:owner/repo` shape.
 */
export function verdaccioSkillPackageId(packageName: string, _version?: string): string {
  void _version;
  return `verdaccio:${packageName}`;
}

export type SkillPackageSourceKind = "github" | "verdaccio";

export interface ResolvedSkillPackageSource {
  kind: SkillPackageSourceKind;
  /** The packageId persisted as the skill_packages row identifier. */
  packageId: string;
  /** Verdaccio-only: resolved semver after install. */
  version?: string;
}

function isVerdaccioPackageRef(ref: PackageRef): boolean {
  // Verdaccio targets carry an @<scope>/<pkg> shape (`@anthropics/skills`,
  // `@cinatra-ai/blog-skills`). GitHub targets are `owner/repo` (no leading
  // `@`). The presence of an explicit `version` field also signals
  // Verdaccio, since GitHub skill installs encode their pin in the
  // packageName string.
  if (ref.packageName.startsWith("@")) return true;
  if (ref.version) return true;
  return false;
}

export function resolveSkillPackageSource(ref: PackageRef): ResolvedSkillPackageSource {
  if (isVerdaccioPackageRef(ref)) {
    return {
      kind: "verdaccio",
      // Version is intentionally NOT in the id (see verdaccioSkillPackageId
      // docstring). It's threaded into the install/update payload only.
      packageId: verdaccioSkillPackageId(ref.packageName),
      version: ref.version,
    };
  }
  return {
    kind: "github",
    packageId: `github:${ref.packageName}`,
  };
}
