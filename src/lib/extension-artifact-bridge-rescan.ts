import "server-only";

// ---------------------------------------------------------------------------
// Production artifact-bridge package-store rescan (cinatra#661).
//
// The bundled artifact-bridge scan (`registerArtifactExtensions`, driven from
// `register-all-object-types.ts`) only ever scanned the IMAGE-bundled tree
// (`process.cwd()/extensions/cinatra-ai`). A RUNTIME-installed artifact package
// is metadata-only (no serverEntry), so the runtime activator returns
// `no-server-entry` and never registers its object type in-process — the
// artifact type therefore never appeared after a marketplace install, even
// after a restart, because nothing scanned `/data/extensions/packages`.
//
// This adapter closes that gap: it scans the on-disk package store and
// registers each materialized `kind:"artifact"` package's generic object type
// (WITH package provenance, so teardown can later reach it), giving metadata-
// only artifacts a registration path PARALLEL to the server-entry activator.
//
// SECURITY (unsigned-code-execution invariant preserved): this NEVER imports or
// executes any package code. It reads `package.json` only (via the bridge's own
// `registerArtifactExtensionDir`, which parses + validates the semantic
// manifest) and registers a pure-DATA object-type descriptor. There is no
// server entry to import for an artifact, and we do not resolve one.
//
// FAIL-CLOSED against the canonical store: a store dir is registered ONLY when
// the package's canonical `installed_extension` row is `active|locked` (or it is
// an ungoverned bundled/disk artifact with no row — CG-1). A deliberately
// archived install in the store is NOT re-registered, so the rescan can never
// resurrect a torn-down artifact type. The status check is
// `isArtifactExtensionWriteAllowed` — the SAME DB-status gate the write paths
// use, so discovery and write authz can never diverge.
// ---------------------------------------------------------------------------

import { readdir, readFile, stat } from "node:fs/promises";
import {
  discoverPackageStoreRecords,
  DEFAULT_PACKAGE_STORE_PATH,
  type PackageStoreFs,
} from "@cinatra-ai/sdk-extensions";
import { registerArtifactExtensionDir } from "@cinatra-ai/objects/register-artifact-extensions";
import { isArtifactExtensionWriteAllowed } from "@/lib/artifacts/artifact-extension-access";

/** Real node:fs surface for the pure store-discovery walk (read-only). */
const realFs: PackageStoreFs = {
  exists: async (p) => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory: async (p) => {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  },
  readdir: async (p) => {
    try {
      return await readdir(p);
    } catch {
      return [];
    }
  },
  readFile: (p) => readFile(p, "utf8"),
};

/** True iff a materialized store record's `package.json` declares an artifact
 *  kind. Read-only `package.json` probe; never imports package code. Any read
 *  error → false (skip, never fatal). */
async function recordIsArtifactKind(storeDir: string): Promise<boolean> {
  try {
    const raw = await realFs.readFile(`${storeDir}/package.json`);
    const pkg = JSON.parse(raw) as { cinatra?: { kind?: unknown } };
    return pkg?.cinatra?.kind === "artifact";
  } catch {
    return false;
  }
}

export type RescanArtifactBridgeOptions = {
  /** Override the package store root (defaults to the `/data` volume path).
   *  Tests pass a temp dir. */
  storeRoot?: string;
  /** Limit the rescan to a single package (the activate-hook path passes the
   *  just-installed package so an install registers only its own type). */
  onlyPackage?: string;
};

export type RescanArtifactBridgeResult = {
  /** The package names whose artifact object type was (re)registered. */
  registered: string[];
  /** The package names found in the store as `kind:"artifact"` but SKIPPED
   *  because their install row is archived/absent-and-governed (fail-closed). */
  skippedNotActive: string[];
};

/**
 * Rescan the on-disk package store and register every materialized,
 * install-active `kind:"artifact"` package's object type WITH provenance.
 *
 * Idempotent: the object registry is replace-by-id, so re-running across
 * web/worker restarts (or after a same-digest re-activate) is a clean no-op for
 * an already-registered type. A missing store root yields an empty result (a
 * deployment with no `/data` volume is a clean no-op, never an error) — matching
 * `discoverPackageStoreRecords`'s own semantics. Every per-dir step is
 * best-effort: an unreadable/foreign dir is skipped, never fatal.
 */
export async function rescanArtifactBridgeFromStore(
  opts: RescanArtifactBridgeOptions = {},
): Promise<RescanArtifactBridgeResult> {
  const storeRoot = opts.storeRoot ?? DEFAULT_PACKAGE_STORE_PATH;
  const registered: string[] = [];
  const skippedNotActive: string[] = [];

  let records: Awaited<ReturnType<typeof discoverPackageStoreRecords>>;
  try {
    records = await discoverPackageStoreRecords(storeRoot, realFs);
  } catch (err) {
    // A discovery failure must NOT crash boot or an install — degrade to a
    // no-op rescan (the bundled built-ins are already registered separately).
    console.warn(
      "[artifact-bridge-rescan] store discovery failed — skipping rescan:",
      err instanceof Error ? err.message : err,
    );
    return { registered, skippedNotActive };
  }

  for (const rec of records) {
    if (opts.onlyPackage && rec.packageName !== opts.onlyPackage) continue;
    // Read-only probe: only `kind:"artifact"` packages have a bridge type.
    if (!(await recordIsArtifactKind(rec.storeDir))) continue;

    // FAIL-CLOSED against the canonical store: never re-register an archived
    // install. An ungoverned (no-row) bundled/disk artifact is allowed (CG-1).
    if (!(await isArtifactExtensionWriteAllowed(rec.packageName))) {
      skippedNotActive.push(rec.packageName);
      continue;
    }

    try {
      if (registerArtifactExtensionDir(rec.storeDir)) {
        registered.push(rec.packageName);
      }
    } catch (err) {
      console.warn(
        `[artifact-bridge-rescan] failed to register ${rec.packageName} from ${rec.storeDir}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (registered.length || skippedNotActive.length) {
    console.info(
      `[artifact-bridge-rescan] store=${storeRoot} registered=[${registered.join(", ")}]` +
        (skippedNotActive.length ? ` skipped(not-active)=[${skippedNotActive.join(", ")}]` : ""),
    );
  }
  return { registered, skippedNotActive };
}
