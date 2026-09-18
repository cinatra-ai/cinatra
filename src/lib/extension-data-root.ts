// The ONE configurable extension data root (cinatra#790/#791).
//
// Replaces the hardcoded `DEFAULT_PACKAGE_STORE_PATH` ("/data/extensions/packages")
// as the root every runtime-store surface (materializer, boot loader, hot-install
// activation, read model, artifact rescan, install resolution) resolves against.
// The V2 content-addressed layout lives UNDER this root, kind-segregated:
// `<root>/<kind>/<slug>/<digest>/` (see extension-package-store-core.ts).
//
// Resolution precedence (ops-deploy determinism rationale, ops#436): the `CINATRA_EXTENSION_DATA_ROOT` env var,
// when set non-empty, WINS over the DB metadata key and the default. The deploy
// environment owns the on-disk runtime-store topology (the mounted data volume),
// and a stale `extension_data_root` row left in the DB must never split the host
// off the deploy-managed volume. Dev/unit contexts set neither and get the
// container default.

import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import { readMetadataValueFromDatabase, writeMetadataValueToDatabase } from "@/lib/database";
import type { ExtensionStoreKind } from "@/lib/extension-package-store-core";

/** Highest-precedence source (deploy determinism). */
export const EXTENSION_DATA_ROOT_ENV = "CINATRA_EXTENSION_DATA_ROOT";

/** DB metadata key (admin-configurable; loses to the env var). */
export const EXTENSION_DATA_ROOT_METADATA_KEY = "extension_data_root";

/** Default runtime data root inside the container's `/data` volume. */
export const DEFAULT_EXTENSION_DATA_ROOT = "/data/extensions";

/** The configured extension data root: env > DB metadata > default. */
export function readExtensionDataRoot(): string {
  const envValue = process.env[EXTENSION_DATA_ROOT_ENV];
  if (typeof envValue === "string") {
    const trimmedEnv = envValue.trim();
    if (trimmedEnv) return trimmedEnv;
  }
  // The DB metadata read degrades to the default when the store is not usable
  // in this context (very-early boot, schema not ready) — the root must always
  // resolve; a deploy that needs a non-default root pins it via the env var.
  let stored: string | null;
  try {
    stored = readMetadataValueFromDatabase<string | null>(EXTENSION_DATA_ROOT_METADATA_KEY, null);
  } catch {
    stored = null;
  }
  if (typeof stored !== "string") return DEFAULT_EXTENSION_DATA_ROOT;
  const trimmed = stored.trim();
  return trimmed || DEFAULT_EXTENSION_DATA_ROOT;
}

export function writeExtensionDataRoot(value: string): void {
  writeMetadataValueToDatabase(EXTENSION_DATA_ROOT_METADATA_KEY, value);
}

/** The configured root as an ABSOLUTE path (relative values resolve against cwd). */
export function resolveExtensionDataRoot(): string {
  const cfg = readExtensionDataRoot();
  return path.isAbsolute(cfg) ? cfg : path.join(process.cwd(), cfg);
}

// ---------------------------------------------------------------------------
// WHAT IS INSTALLED UNDER THE ROOT (cinatra#3204).
//
// Every package installed at RUNTIME — whether its bytes came from the registry
// or were supplied on the upload road — is materialized under this same root,
// kind-segregated:
//
//     <root>/<kind>/<slug>/<digest>/
//     <root>/<kind>/<slug>/current   (active digest mirror)
//
// The skill extension scan (`@cinatra-ai/skills`) reads packages OFF DISK, and
// it walks `<cwd>/extensions` — the git-native AUTHORING tree — plus the agent
// runtime mount, and nothing else. A store-installed skill package is therefore
// invisible to it: its catalog row exists, its canonical row exists — and no
// scanned descriptor owns its skill ids, so the assignability predicate is
// never even consulted for them and an agent's Skills offer answers "no
// matches" for a skill the catalog is listing. The walk below is that missing
// enumeration, and it lives HERE, beside the root it walks, so the root's env
// name and container default have exactly one definition.
//
// SYNCHRONOUS on purpose: the scan that consumes it runs on every
// assignable-skill query, and a second async road into it would be a second
// ordering to reason about.
//
// WHAT IT IS NOT: an authorization or lifecycle decision. It answers "which
// package payloads does this deployment hold on disk", exactly as the dev-root
// walk answers it for the authoring tree. Liveness (`installed_extension`),
// per-actor access and org claims stay with the gates that already own them —
// the skill scan's own tombstone filter, the assignability predicate's
// install-status conjunct, and `resolveActiveInstallForActor`.
//
// NOT THE ROAD FOR ARTIFACT PACKS. The object-type registry has no downstream
// liveness gate of its own, so a pack registered here would stay registered
// after teardown. That kind keeps its existing owner — the fail-closed
// `rescanArtifactBridgeFromStore`, which admits a store dir only while the
// package's canonical row is live and its trusted install anchor resolves.
// ---------------------------------------------------------------------------

/**
 * The deploy-owned root for the walk below, read from the ENVIRONMENT ONLY.
 *
 * `resolveExtensionDataRoot()` above falls back to a settings-store row, and
 * that read goes through the SYNCHRONOUS postgres bridge — which parks the whole
 * event loop until the query answers. The walk's caller is the skill extension
 * scan, which runs on every assignable-skill query, so a per-keystroke
 * frozen loop is not a trade this walk may make. The env var is also the source
 * that WINS in the resolver above and the one the deploy owns (it names the
 * mounted data volume), so this is the same answer for every deployment that
 * sets it.
 *
 * The remaining gap is named honestly: an instance that pins the root ONLY
 * through the admin setting, leaving the env var unset, is walked at the
 * container default.
 */
function resolveStoreDataRootFromEnv(): string {
  const raw = process.env[EXTENSION_DATA_ROOT_ENV];
  const configured =
    typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_EXTENSION_DATA_ROOT;
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

// The two store-layout facts the walk needs, restated as LEAF constants rather
// than imported. `extension-package-store-core` also carries the materializer's
// import classifier, which pulls the TypeScript compiler into whatever imports
// it — and the walk's caller is the skill extension SCAN, which runs on every
// assignable-skill query. Dragging a compiler into a typeahead's module
// graph is not a cost a path-shape constant is worth, and the type-only import
// below keeps the kind union itself shared. `extension-store-layout.test.ts`
// asserts both agree with the core module's own definitions, so a change there
// fails a test rather than silently splitting the two walks apart.

/** `<root>/<kind>/<slug>/current` — the plain-text active-digest mirror. */
export const STORE_CURRENT_FILENAME = "current";

/** True when `segment` is a well-formed hex tarball-digest path segment. */
export function isStoreDigestSegment(segment: string): boolean {
  return /^[0-9a-f]{64,128}$/.test(segment);
}

/** The digest a `current` mirror names, or `null` when its text is not one. */
export function parseCurrentFileText(raw: string): string | null {
  const trimmed = raw.trim();
  return isStoreDigestSegment(trimmed) ? trimmed : null;
}

/** One installed store package: its npm name and its ACTIVE payload dir. */
export type InstalledStorePackageDir = {
  /** The package name derived from the store path (`@scope/name` or `name`). */
  packageName: string;
  /** The directory holding the package's `package.json` (the digest dir). */
  dir: string;
};

function isReadableStoreDir(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The ACTIVE digest dir under one `<kind>/<slug>/` dir.
 *
 * The store writes a plain-text `current` mirror naming the live digest; it is
 * a MIRROR (the DB anchor owns selection), so it is consulted FIRST and then
 * verified on disk. When it is absent or stale — a store written before the
 * mirror existed, or a mirror lost to a partial write — the newest materialized
 * digest dir stands in rather than the walk reporting nothing: a package that is
 * physically present must not be invisible because an ops hint is missing.
 */
function resolveActiveDigestDir(slugDir: string): string | null {
  const currentPath = path.join(slugDir, STORE_CURRENT_FILENAME);
  if (existsSync(currentPath)) {
    try {
      const digest = parseCurrentFileText(readFileSync(currentPath, "utf8"));
      if (digest) {
        const dir = path.join(slugDir, digest);
        if (isReadableStoreDir(dir) && existsSync(path.join(dir, "package.json"))) return dir;
      }
    } catch {
      // Unreadable mirror — fall through to the newest-digest scan below.
    }
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(slugDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { dir: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isStoreDigestSegment(entry.name)) continue;
    const dir = path.join(slugDir, entry.name);
    if (!existsSync(path.join(dir, "package.json"))) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (best === null || mtimeMs > best.mtimeMs) best = { dir, mtimeMs };
  }
  return best?.dir ?? null;
}

/**
 * Every installed package of one kind, as `{packageName, dir}` pairs pointing at
 * the ACTIVE payload dir. Fail-soft throughout: an unreadable root, scope dir or
 * slug dir contributes nothing and never throws, because these readers register
 * what they find and one bad directory must never take the rest down with it.
 *
 * `dataRoot` is injectable for tests; production callers pass nothing and get
 * the deploy-owned root above.
 */
export function listInstalledStorePackageDirs(
  kind: ExtensionStoreKind,
  opts?: { dataRoot?: string },
): InstalledStorePackageDir[] {
  let kindRoot: string;
  try {
    kindRoot = path.join(opts?.dataRoot ?? resolveStoreDataRootFromEnv(), kind);
  } catch {
    return [];
  }
  if (!isReadableStoreDir(kindRoot)) return [];
  let top: Dirent[];
  try {
    top = readdirSync(kindRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: InstalledStorePackageDir[] = [];
  const addSlugDir = (packageName: string, slugDir: string): void => {
    const dir = resolveActiveDigestDir(slugDir);
    if (dir) out.push({ packageName, dir });
  };
  for (const entry of top) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    // `<kind>/@scope/<name>/<digest>/` for a scoped package, `<kind>/<name>/<digest>/`
    // for an unscoped one — the store's slug segments are the package name's own.
    if (entry.name.startsWith("@")) {
      const scopeDir = path.join(kindRoot, entry.name);
      let scoped: Dirent[];
      try {
        scoped = readdirSync(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const pkg of scoped) {
        if (!pkg.isDirectory() || pkg.name.startsWith(".")) continue;
        addSlugDir(`${entry.name}/${pkg.name}`, path.join(scopeDir, pkg.name));
      }
      continue;
    }
    addSlugDir(entry.name, path.join(kindRoot, entry.name));
  }
  return out;
}
