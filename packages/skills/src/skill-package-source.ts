// Pure-function source-kind dispatcher for skill extensions. Lives in its own
// file so unit tests can import it without pulling in the extension-handler's
// server-only sibling modules (agents-store, mcp-server credentials, etc.).
//
// THREE supported backends (cinatra#3204 D2 added `local`), and the router
// switches on DECLARED provenance (`PackageRef.provenance`) when the caller
// supplies it — the name-shape guess below survives only for refs that declare
// none:
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
//   local     -> `local:${ref.packageName}`
//
//   local     : a package the operator SUPPLIED as a file. Never inferable from
//               a name — it exists only as declared provenance.

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

export type SkillPackageSourceKind = "github" | "verdaccio" | "local";

export interface ResolvedSkillPackageSource {
  kind: SkillPackageSourceKind;
  /** The packageId persisted as the skill_packages row identifier. */
  packageId: string;
  /** Verdaccio-only: resolved semver after install. */
  version?: string;
  /**
   * Whether the source was DECLARED by the caller (cinatra#3204 D2) or inferred
   * from the package name. A declared source is provenance; an inferred one is a
   * guess kept for refs that predate the field.
   */
  declared: boolean;
}

/**
 * LEGACY name-shape guess, kept ONLY for a ref that declares no provenance.
 *
 * It reads a scoped name (`@scope/pkg`) or the presence of a version as
 * "verdaccio". Both signals are wrong in the same way: they describe how a
 * package is NAMED, not where it came from — so a scoped package supplied as a
 * file, or any supplied ref carrying a version, was routed to the registry
 * backend it never came from. `ref.provenance` is the fix; this function is what
 * remains for callers that have not been threaded yet, and it must never be
 * consulted when provenance IS declared.
 */
function guessSourceKindFromName(ref: PackageRef): SkillPackageSourceKind {
  if (ref.packageName.startsWith("@")) return "verdaccio";
  if (ref.version) return "verdaccio";
  return "github";
}

/** The persisted-id shape for a locally supplied skill package (cinatra#3204). */
export function localSkillPackageId(packageName: string): string {
  return `local:${packageName}`;
}

export function resolveSkillPackageSource(ref: PackageRef): ResolvedSkillPackageSource {
  // EXPLICIT PROVENANCE FIRST (cinatra#3204 D2). When the caller says where the
  // package came from, that is the answer — the name is never consulted.
  const declaredType = ref.provenance?.type;
  if (declaredType === "verdaccio") {
    return {
      kind: "verdaccio",
      // Version is intentionally NOT in the id (see verdaccioSkillPackageId
      // docstring). It's threaded into the install/update payload only.
      packageId: verdaccioSkillPackageId(ref.packageName),
      version: ref.version,
      declared: true,
    };
  }
  if (declaredType === "github") {
    return { kind: "github", packageId: `github:${ref.packageName}`, declared: true };
  }
  if (declaredType === "local") {
    // The LOCAL source kind (cinatra#3204 D2): a skill package the operator
    // supplied as a file. It had no routing at all before this — the two
    // backends were github and verdaccio — so a supplied skill could only ever
    // be misrouted to one of them.
    return { kind: "local", packageId: localSkillPackageId(ref.packageName), declared: true };
  }

  // No declared provenance: the legacy name-shape guess, unchanged in behaviour.
  const guessed = guessSourceKindFromName(ref);
  if (guessed === "verdaccio") {
    return {
      kind: "verdaccio",
      packageId: verdaccioSkillPackageId(ref.packageName),
      version: ref.version,
      declared: false,
    };
  }
  return { kind: "github", packageId: `github:${ref.packageName}`, declared: false };
}
