import "server-only";

// Verdaccio install path for `kind:"skill"` extensions (cinatra#793: unified
// content-addressed store).
//
// GitHub skill installs use `github:owner/repo` package refs, while Verdaccio
// skill packages use npm package names such as `@anthropics/skills`. The
// dispatch lives in `extension-handler.ts` via `resolveSkillPackageSource(ref)`.
//
// A verdaccio skill install no longer extracts its own tarball: the dispatcher
// fires the shared REAL-integrity install pipeline BEFORE this handler runs,
// which materializes + finalizes the SRI-verified payload into the unified
// extension store (`<CINATRA_EXTENSION_DATA_ROOT>/skill/<slug>/<digest>/`).
// This installer CONSUMES that finalized digest dir: it validates the
// manifest kind, then registers the catalog rows with `repositoryPath` (and
// per-skill `sourcePath`s) pointing INTO the store dir — the skills-store read
// allowlists admit the store's `skill/` subtree (`getExtensionStoreSkillRootPath`).
// On update the pipeline finalizes a NEW digest dir and GCs the superseded one;
// the re-upsert here repoints every row at the new digest.
//
// GitHub/local skill installs are UNCHANGED (handler-owned; the github.ts
// clone path) — the `isVerdaccioBackedRef` carve-out in the dispatcher means
// they never route through the store pipeline.
//
// Persisted-id shape invariant so install/archive/restore/uninstall flip the
// same row:
//   github   -> `github:${ref.packageName}`             e.g. github:owner/repo
//   verdaccio -> `verdaccio:${ref.packageName}`         e.g. verdaccio:@anthropics/skills

import * as fs from "node:fs";
import * as path from "node:path";
import {
  upsertRepositoryBackedSkillPackage,
  type PersistedSkill,
  type PersistedSkillPackage,
} from "./skills-store";
import { verdaccioSkillPackageId as buildVerdaccioId } from "./skill-package-source";

// Re-export the pure-fn id builder so callers that already import this
// module don't need to learn about ./skill-package-source.
export const verdaccioSkillPackageId = buildVerdaccioId;

export interface VerdaccioSkillInstallInput {
  /** Full scoped name, e.g. "@anthropics/skills". */
  packageName: string;
  /** Optional explicit semver (the dispatcher passes the registry-resolved
   *  concrete version it just finalized). */
  packageVersion?: string;
  /** The install's org scope (the canonical row the pipeline finalized binds
   *  it). `null` = platform scope; OMIT for platform-global resolution. */
  orgId?: string | null;
}

export interface VerdaccioSkillInstallResult {
  skillPackage: PersistedSkillPackage;
  skills: PersistedSkill[];
}

/**
 * Install a `kind:"skill"` package from the FINALIZED unified-store payload.
 * Validates the manifest, then persists a `skill_packages` row plus per-skill
 * rows via the same `upsertRepositoryBackedSkillPackage` path the GitHub
 * installer uses — with every registered path anchored in the store digest dir.
 *
 * Fails LOUD when no finalized store payload exists: the dispatcher pipeline
 * is ordered BEFORE this handler, so a missing payload is a real invariant
 * violation (or a mis-routed non-verdaccio ref), never a normal state.
 */
export async function installSkillPackageFromVerdaccio(
  input: VerdaccioSkillInstallInput,
): Promise<VerdaccioSkillInstallResult> {
  // Host read seam onto the unified store (dynamic: keeps this package's
  // static graph free of the host anchor/store modules).
  const { resolveFinalizedStorePayload } = await import("@/lib/extension-store-payload");
  const payload = await resolveFinalizedStorePayload({
    packageName: input.packageName,
    expectedKind: "skill",
    ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
  });
  if (!payload) {
    throw new Error(
      `installSkillPackageFromVerdaccio: no FINALIZED store payload for ${input.packageName}` +
        `${input.packageVersion ? `@${input.packageVersion}` : ""} — the dispatcher's store ` +
        `install pipeline materializes+finalizes a verdaccio skill BEFORE this handler runs; ` +
        `a missing payload means the pipeline did not finalize (or the ref is not verdaccio-backed).`,
    );
  }
  // The dispatcher dispatches the registry-resolved concrete version and the
  // pipeline finalized exactly that — a mismatch here means this handler is
  // reading a DIFFERENT install than the one just finalized. Fail closed.
  if (input.packageVersion && payload.version && payload.version !== input.packageVersion) {
    throw new Error(
      `installSkillPackageFromVerdaccio: the finalized store payload for ${input.packageName} ` +
        `is version ${payload.version}, but this install requested ${input.packageVersion} — ` +
        `refusing to register a different version's payload.`,
    );
  }

  const manifestPath = path.join(payload.storeDir, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    name?: string;
    version?: string;
    description?: string;
    cinatra?: { kind?: unknown };
    license?: string;
  };
  const kind = manifest.cinatra?.kind;
  if (kind !== "skill") {
    throw new Error(
      `installSkillPackageFromVerdaccio: ${input.packageName} has cinatra.kind=${String(
        kind,
      )}, expected "skill"`,
    );
  }

  const installedVersion = payload.version ?? manifest.version ?? "0.0.0";
  // Catalog display links: the anchor's recorded registry identity (the FINAL
  // registry URL — never a broker URL). The field is opaque to the matcher.
  const registryBase = payload.registryUrl ?? "";
  const detailUrl = registryBase
    ? `${registryBase}/-/web/detail/${encodeURIComponent(input.packageName)}`
    : `verdaccio:${input.packageName}@${installedVersion}`;

  // packageId omits version; the installed version is captured inside the
  // persisted payload.
  const packageId = verdaccioSkillPackageId(input.packageName);
  return await upsertRepositoryBackedSkillPackage({
    packageId,
    // Keep the row identifier separate from the catalog skill ID prefix.
    // Lifecycle dispatch uses `verdaccio:<packageName>`, while consumers
    // reference `@anthropics/skills:skill-creator` instead of
    // `verdaccio:@anthropics/skills:skill-creator`.
    catalogSkillIdPrefix: input.packageName,
    name: input.packageName,
    slug: slugifyForCatalog(input.packageName),
    description: manifest.description ?? `${input.packageName}@${installedVersion}`,
    repositoryUrl: detailUrl,
    // The FINALIZED store digest dir — registered sourcePaths stay readable
    // for exactly as long as this digest is the active install (an update
    // re-upserts against the new digest before the old one is GC'd).
    repositoryPath: payload.storeDir,
    sourceUrl: detailUrl,
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
