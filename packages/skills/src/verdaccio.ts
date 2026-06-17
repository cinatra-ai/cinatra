import "server-only";

// Verdaccio install path for `kind:"skill"` extensions.
//
// GitHub skill installs use `github:owner/repo` package refs, while Verdaccio
// skill packages use npm package names such as `@anthropics/skills`. This
// module provides the parallel Verdaccio extractor + registration path; the
// dispatch lives in `extension-handler.ts` via `resolveSkillPackageSource(ref)`.
//
// Persisted-id shape invariant so install/archive/restore/uninstall flip the
// same row:
//   github   -> `github:${ref.packageName}`             e.g. github:owner/repo
//   verdaccio -> `verdaccio:${ref.packageName}@${version}` e.g.
//             verdaccio:@anthropics/skills@1.0.0

import * as fs from "node:fs";
import * as path from "node:path";
import {
  extractExtensionPackage,
  loadVerdaccioConfig,
  type ExtractedExtensionPackage,
} from "@cinatra-ai/registries";
import {
  upsertRepositoryBackedSkillPackage,
  getSkillsDataRootPath,
  assertSkillDirectoryInsideRoot,
  isRealpathContained,
  type PersistedSkill,
  type PersistedSkillPackage,
} from "./skills-store";
import { verdaccioSkillPackageId as buildVerdaccioId } from "./skill-package-source";

// Re-export the pure-fn id builder so callers that already import this
// module don't need to learn about ./skill-package-source.
export const verdaccioSkillPackageId = buildVerdaccioId;

// Persistent install location for Verdaccio-fetched skill bundles.
// Registered skill sourcePath values must point at durable files because
// skills_installed_get + buildSkillTools throw if a registered skill's
// sourcePath points at a deleted file. Bundles live under
// <skills-data-root>/_verdaccio-installs/<scope-slug>/<pkg-slug>/<version>/.
//
// Legacy carve-out: Verdaccio installs intentionally STAY on the
// legacy `data/skills` root (alongside github.ts clones and the relocate
// worker). Both legacy-package install paths — github clone + verdaccio
// extract — are deferred to the store migration, which migrates the existing
// trees and retargets the install paths together.
const VERDACCIO_INSTALL_SUBDIR = "_verdaccio-installs";

// Exported for unit testing of the #300 version-segment traversal containment
// (pure path fn — no fs/network/DB). Not part of the install lifecycle surface.
export function persistInstallDir(packageName: string, version: string): string {
  // Slugify @scope/pkg -> scope__pkg so it nests in a single dir level safely.
  const safe = packageName.replace(/^@/, "").replace(/[^a-zA-Z0-9._-]+/g, "_");
  // The version segment flows in from the resolved package and was NOT
  // slugified (#300). `path.join` collapses a `../../escape` version into a
  // path that still resolves UNDER the skills root but OUTSIDE the verdaccio
  // install subroot — letting the destructive `rmSync`/`renameSync` clobber
  // arbitrary `data/skills` descendants (e.g. another package's install).
  // Sanitize the version with the SAME charset as the name and collapse any
  // residual `.`/`..`-only segment, so the leaf can never traverse.
  const safeVersion =
    version.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+$/, "_") || "unversioned";
  const installSubroot = path.join(getSkillsDataRootPath(), VERDACCIO_INSTALL_SUBDIR);
  const installDir = path.join(installSubroot, safe, safeVersion);
  // Strict-subroot assertion (two layers). The resolved install dir must be
  // STRICTLY inside the verdaccio install subroot (not merely inside the skills
  // data root — `assertSkillDirectoryInsideRoot` at the call site only confines
  // to `data/skills`).
  //   1. Lexical: rejects residual intra-root traversal in the slugified segments.
  //   2. Realpath (#300): a SYMLINKED ancestor under `_verdaccio-installs`
  //      (e.g. `_verdaccio-installs/<name> -> ../other-package`) passes the
  //      lexical prefix check but resolves into another `data/skills` subtree —
  //      the destructive `rmSync`/`renameSync` would then clobber it. Re-assert
  //      on the real paths (nearest-existing-ancestor realpath for the
  //      not-yet-created version leaf).
  const resolvedSubroot = path.resolve(installSubroot);
  const resolvedInstallDir = path.resolve(installDir);
  if (
    !resolvedInstallDir.startsWith(resolvedSubroot + path.sep) ||
    !isRealpathContained(resolvedInstallDir, resolvedSubroot)
  ) {
    throw new Error(
      `installSkillPackageFromVerdaccio: resolved install dir escapes the verdaccio install subroot (name="${packageName}", version="${version}").`,
    );
  }
  return installDir;
}

export interface VerdaccioSkillInstallInput {
  /** Full scoped name, e.g. "@anthropics/skills". */
  packageName: string;
  /** Optional explicit semver; resolves dist-tags `latest` when omitted. */
  packageVersion?: string;
}

export interface VerdaccioSkillInstallResult {
  skillPackage: PersistedSkillPackage;
  skills: PersistedSkill[];
}

/**
 * Install a `kind:"skill"` package from Cinatra's Verdaccio. Extracts the
 * tarball, validates the manifest, walks `skills/<slug>/SKILL.md`, and
 * persists a `skill_packages` row plus per-skill rows via the same
 * `upsertRepositoryBackedSkillPackage` path the GitHub installer uses.
 */
export async function installSkillPackageFromVerdaccio(
  input: VerdaccioSkillInstallInput,
): Promise<VerdaccioSkillInstallResult> {
  // Use the sync env-only loader here. The DI-async loader requires the
  // host-app's identity + decrypt helpers, which we don't want to pull into
  // this package's graph. Skill installs from Verdaccio happen via
  // extensions_install, which is admin-gated and already authorizes the env-
  // backed loader path.
  const config = loadVerdaccioConfig();

  let extracted: ExtractedExtensionPackage | null = null;
  // Extract to temp, then move to a persistent install dir before registering.
  // sourcePaths in skill_packages are absolute filesystem paths, and
  // skills_installed_get + buildSkillTools throw if the path is missing. We
  // never delete the temp dir here; we move-then-cleanup at the very end.
  extracted = await extractExtensionPackage(
    { packageName: input.packageName, packageVersion: input.packageVersion },
    config,
  );

  const manifest = (extracted.manifest ?? {}) as {
    name?: string;
    version?: string;
    description?: string;
    cinatra?: { kind?: unknown };
    license?: string;
  };
  const kind = (manifest.cinatra as { kind?: unknown } | undefined)?.kind;
  if (kind !== "skill") {
    fs.rmSync(extracted.tempDir, { recursive: true, force: true });
    throw new Error(
      `installSkillPackageFromVerdaccio: ${input.packageName} has cinatra.kind=${String(
        kind,
      )}, expected "skill"`,
    );
  }

  // Move extracted tree to the persistent install dir. Overwrite an existing
  // dir at the same path (re-install with the same version).
  //
  // Fail-closed containment barrier (#300). `persistInstallDir` slugifies the
  // package name but the `version` segment flows in VERBATIM — a crafted
  // version like `../../escape` (or a symlinked ancestor under the install
  // subdir) would otherwise let the destructive `rmSync`/`mkdirSync`/
  // `renameSync` below escape the skills data root. `assertSkillDirectoryInsideRoot`
  // rejects any `.`/`..` traversal segment AND realpath-confines the resolved
  // dir to the allowed skill roots; reassign so the confined value feeds the
  // sinks. A legitimate `@scope/pkg@1.0.0` never trips this.
  const installDir = assertSkillDirectoryInsideRoot(
    persistInstallDir(extracted.packageName, extracted.packageVersion),
  );
  if (fs.existsSync(installDir)) {
    fs.rmSync(installDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(installDir), { recursive: true });
  fs.renameSync(extracted.tempDir, installDir);

  // packageId omits version; the installed version is captured inside the
  // persisted payload.
  const packageId = verdaccioSkillPackageId(extracted.packageName);
  return await upsertRepositoryBackedSkillPackage({
    packageId,
    // Keep the row identifier separate from the catalog skill ID prefix.
    // Lifecycle dispatch uses `verdaccio:<packageName>`, while consumers
    // reference `@anthropics/skills:skill-creator` instead of
    // `verdaccio:@anthropics/skills:skill-creator`.
    catalogSkillIdPrefix: extracted.packageName,
    name: extracted.packageName,
    slug: slugifyForCatalog(extracted.packageName),
    description: manifest.description ?? `${extracted.packageName}@${extracted.packageVersion}`,
    // The Verdaccio install lacks an upstream GitHub repository URL; the
    // canonical link for these packages is the Cinatra Verdaccio entry. The
    // `repositoryUrl` field is opaque to the matcher — only used for catalog
    // display — so the Verdaccio package-URL is the right value.
    repositoryUrl: `${config.registryUrl}/-/web/detail/${encodeURIComponent(extracted.packageName)}`,
    // Use the persistent install dir so registered sourcePaths stay readable.
    repositoryPath: installDir,
    sourceUrl: `${config.registryUrl}/-/web/detail/${encodeURIComponent(extracted.packageName)}`,
    license: manifest.license,
  });
}

function slugifyForCatalog(packageName: string): string {
  return packageName
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}
