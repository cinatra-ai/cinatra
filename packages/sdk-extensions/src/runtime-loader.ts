// The PROD half of "dual loaders, single activation": the RuntimePackageLoader.
//
// The dev `StaticBundleLoader` (src/lib/static-bundle-loader.ts) activates
// build-bundled extensions through the shared, pure `runStaticBundleActivation`
// driver. This module activates extensions that were **materialized into a
// package store on disk** (e.g. a `/data` volume) — the path the live runtime
// installer writes to. It reuses the EXACT same driver,
// host-context factory, and ABI gate; it differs only in WHERE records + server
// entries come from (a filesystem store instead of a generated import map). That
// is what proves plug-and-play: a server-only extension dropped into the store is
// discovered + registered on boot WITHOUT rebuilding the image.
//
// This module is intentionally PURE — no `@/lib/*`, no real `fs`, no dynamic
// `import()` of its own, no `server-only`. The host wrapper injects the real
// filesystem + import + ctx factory + digest verifier. That keeps the
// discovery/activation logic exhaustively unit-testable.

import {
  runStaticBundleActivation,
  type LoaderDeps,
  type LoaderRecord,
} from "./loader";
import type { ActivationResult } from "./activate";
import { isSdkAbiRangeSatisfied, SDK_EXTENSIONS_ABI_VERSION } from "./register";
import { isUiSurfaceKind, type UiSurfaceKind } from "./manifest";

/** Default on-disk package store inside the container's `/data` volume. */
export const DEFAULT_PACKAGE_STORE_PATH = "/data/extensions/packages";

/** A declarative, extension-owned migration descriptor (within-package path). */
export type PackageStoreMigration = { id: string; path: string };

/** A materialized package discovered in the store. */
export type PackageStoreRecord = LoaderRecord & {
  /** Absolute dir holding the package's `package.json` + serverEntry. */
  storeDir: string;
  /** Digest segment from a digest-pinned store layout (`<pkg>/<digest>/`), if any. */
  declaredDigest?: string;
  /** Declarative extension-owned migrations (`cinatra.migrations[]`), if any. */
  migrations?: PackageStoreMigration[];
  /**
   * UI hot-pluggability classification (`cinatra.uiSurface`), if declared. A
   * MARKETPLACE-INSTALLED `schema-config` connector — discovered from the store,
   * not the static manifest — carries its surface here so the dispatch route can
   * branch on it without a rebuild.
   */
  uiSurface?: UiSurfaceKind | null;
  /**
   * The declared `cinatra.configSchema` DATA for a `schema-config` connector,
   * if any. The host renders the setup surface from it (model B: no React in the
   * package). Validated fail-closed at render/install time via `parseSchemaConfig`.
   */
  configSchema?: Record<string, unknown> | null;
};

/** Minimal injected filesystem surface (so the core is testable with a fake fs). */
export type PackageStoreFs = {
  exists: (path: string) => Promise<boolean>;
  isDirectory: (path: string) => Promise<boolean>;
  readdir: (path: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
};

// POSIX-join (the store path is always a container/posix path). Avoids a
// node:path import so the pure module has zero runtime deps.
function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .filter((p) => p.length > 0)
    .join("/");
}

/**
 * Build a store record from a package's raw `package.json` text. Returns null
 * when the JSON is invalid or the package is not a Cinatra extension (no
 * `cinatra` block or no `name`). A package WITHOUT a `serverEntry` is still a
 * valid record (serverEntry=null) — the driver skips it, matching the
 * StaticBundleLoader.
 */
export function recordFromManifest(
  storeDir: string,
  pkgJsonText: string,
  declaredDigest?: string,
): PackageStoreRecord | null {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(pkgJsonText) as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = typeof pkg.name === "string" ? pkg.name : null;
  const cinatra = (pkg.cinatra ?? null) as Record<string, unknown> | null;
  if (!name || !cinatra) return null;
  const serverEntry =
    typeof cinatra.serverEntry === "string" ? cinatra.serverEntry : null;
  const requestedHostPorts = Array.isArray(cinatra.requestedHostPorts)
    ? (cinatra.requestedHostPorts as LoaderRecord["requestedHostPorts"])
    : [];
  const sdkAbiRange =
    typeof cinatra.sdkAbiRange === "string" ? cinatra.sdkAbiRange : undefined;
  const uiSurface = isUiSurfaceKind(cinatra.uiSurface) ? cinatra.uiSurface : undefined;
  const configSchema =
    cinatra.configSchema &&
    typeof cinatra.configSchema === "object" &&
    !Array.isArray(cinatra.configSchema)
      ? (cinatra.configSchema as Record<string, unknown>)
      : undefined;
  const migrations = Array.isArray(cinatra.migrations)
    ? (cinatra.migrations as unknown[]).flatMap((m) =>
        m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" && typeof (m as { path?: unknown }).path === "string"
          ? [{ id: (m as { id: string }).id, path: (m as { path: string }).path }]
          : [],
      )
    : undefined;
  return {
    packageName: name,
    serverEntry,
    requestedHostPorts,
    sdkAbiRange,
    storeDir,
    declaredDigest,
    ...(uiSurface ? { uiSurface } : {}),
    ...(configSchema ? { configSchema } : {}),
    ...(migrations && migrations.length > 0 ? { migrations } : {}),
  };
}

/**
 * Discover materialized packages under `storeRoot`. Supports two layouts:
 *   - flat:          `<root>/<pkgDir>/package.json`
 *   - digest-pinned: `<root>/<pkgDir>/<digest>/package.json`
 * A missing store root yields `[]` (so a deployment with no `/data` volume is a
 * clean no-op, never an error). Unreadable/foreign dirs are skipped, not fatal.
 */
export async function discoverPackageStoreRecords(
  storeRoot: string,
  fs: PackageStoreFs,
): Promise<PackageStoreRecord[]> {
  if (!(await fs.exists(storeRoot))) return [];
  const out: PackageStoreRecord[] = [];
  for (const entry of await fs.readdir(storeRoot)) {
    const dir = joinPath(storeRoot, entry);
    if (!(await fs.isDirectory(dir))) continue;

    const directManifest = joinPath(dir, "package.json");
    if (await fs.exists(directManifest)) {
      const rec = recordFromManifest(dir, await fs.readFile(directManifest));
      if (rec) out.push(rec);
      continue;
    }

    // digest-pinned: one level down.
    for (const sub of await fs.readdir(dir)) {
      const subdir = joinPath(dir, sub);
      if (!(await fs.isDirectory(subdir))) continue;
      const manifest = joinPath(subdir, "package.json");
      if (await fs.exists(manifest)) {
        const rec = recordFromManifest(subdir, await fs.readFile(manifest), sub);
        if (rec) out.push(rec);
      }
    }
  }
  return out;
}

/**
 * Resolve a record's `serverEntry` (e.g. `./register`) to an absolute store path,
 * or null when there is no entry OR the entry is UNSAFE. The imported code must
 * never escape the integrity-verified package dir, so an absolute path or any
 * parent-dir (`..`) segment is rejected — `serverEntry: "../other/register"`
 * would otherwise hand the loader a path outside `storeDir`. Callers distinguish
 * "no serverEntry" (skip) from "unsafe serverEntry" (refuse) via
 * `record.serverEntry`: a non-null serverEntry that resolves to null is unsafe.
 */
export function resolveServerEntryPath(record: PackageStoreRecord): string | null {
  if (!record.serverEntry) return null;
  const rel = record.serverEntry.replace(/^\.\//, "");
  if (rel.startsWith("/") || rel.split("/").some((seg) => seg === "..")) {
    return null; // unsafe: absolute or parent-dir traversal
  }
  return joinPath(record.storeDir, rel);
}

export type RuntimeLoaderDeps = {
  fs: PackageStoreFs;
  /** Dynamically import a resolved server-entry path → module namespace. */
  importModule: (absPath: string, record: PackageStoreRecord) => Promise<unknown>;
  /** Build the grant-aware host ctx (host injects `createExtensionHostContext`). */
  makeContext: LoaderDeps["makeContext"];
  /**
   * Optional integrity gate: verify the materialized package matches its
   * expected digest BEFORE its code is imported. Returning false refuses
   * activation (the driver records an `error`). Omit to skip integrity checking
   * (acceptable for a trusted bundled store; required for untrusted installs).
   */
  verifyIntegrity?: (record: PackageStoreRecord) => Promise<boolean>;
  /** Records discovered (override for tests); defaults to discovering the store. */
  records?: readonly PackageStoreRecord[];
};

/**
 * Discover + activate every server-only package in the store through the SAME
 * `runStaticBundleActivation` driver the dev loader uses. The integrity gate and
 * the ABI gate both run BEFORE any extension code is imported.
 */
export async function runRuntimePackageActivation(
  storeRoot: string,
  deps: RuntimeLoaderDeps,
): Promise<ActivationResult[]> {
  const all =
    deps.records ?? (await discoverPackageStoreRecords(storeRoot, deps.fs));

  // FAIL-CLOSED on ambiguous identity: if the store holds more than one record
  // for the same packageName (e.g. two digest snapshots), we cannot safely
  // decide which one the ABI gate verified vs which one gets imported — that
  // could ABI-check record A while importing record B, and double-register. So
  // we refuse EVERY record for a duplicated name and surface one error per name,
  // rather than silently picking one.
  const countByName = new Map<string, number>();
  for (const r of all) {
    countByName.set(r.packageName, (countByName.get(r.packageName) ?? 0) + 1);
  }
  const duplicated = new Set(
    [...countByName].filter(([, n]) => n > 1).map(([name]) => name),
  );
  const records = all.filter((r) => !duplicated.has(r.packageName));
  const dupResults: ActivationResult[] = [...duplicated].map((packageName) => ({
    packageName,
    status: "failed",
    error: new Error(
      `[runtime-package-loader] refusing ambiguous package ${packageName}: ` +
        `multiple store records found (fail-closed)`,
    ),
  }));

  const byName = new Map(records.map((r) => [r.packageName, r] as const));

  const activated = await runStaticBundleActivation(records, {
    importServerEntry: async (packageName) => {
      const rec = byName.get(packageName);
      if (!rec || !rec.serverEntry) return undefined; // genuinely no server entry
      const abs = resolveServerEntryPath(rec);
      if (abs === null) {
        // serverEntry is set but resolved to null => unsafe (absolute / `..`).
        throw new Error(
          `[runtime-package-loader] unsafe serverEntry "${rec.serverEntry}" for ${packageName} ` +
            `(must be a ./-relative path inside the package dir; refusing to import)`,
        );
      }
      if (deps.verifyIntegrity && !(await deps.verifyIntegrity(rec))) {
        throw new Error(
          `[runtime-package-loader] integrity check failed for ${packageName} (refusing to import)`,
        );
      }
      return deps.importModule(abs, rec);
    },
    makeContext: deps.makeContext,
    // Identical ABI verdict to the StaticBundleLoader: the frozen host SDK ABI
    // must satisfy the record's declared range; refused before any code runs.
    abiCompatible: (rec) =>
      isSdkAbiRangeSatisfied(SDK_EXTENSIONS_ABI_VERSION, rec.sdkAbiRange),
  });

  return [...dupResults, ...activated];
}
