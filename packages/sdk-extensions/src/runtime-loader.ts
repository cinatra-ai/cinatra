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


/** A materialized package discovered in the store. */
export type PackageStoreRecord = LoaderRecord & {
  /** Absolute dir holding the package's `package.json` + serverEntry. */
  storeDir: string;
  /** Digest segment from a digest-pinned store layout (`<pkg>/<digest>/`), if any. */
  declaredDigest?: string;
  /**
   * The `exports`-map RESOLUTION of `cinatra.serverEntry`, when the declared
   * value is an exports KEY (`"./register"` → `exports["./register"]` →
   * `"./register.mjs"`). Carried alongside the raw `serverEntry` (kept for
   * messages/back-compat); `resolveServerEntryPath` resolves
   * `serverEntryRel ?? serverEntry` — the SAME exports-aware semantics the
   * materialize-time scanner applies (cinatra#161, shared resolver).
   */
  serverEntryRel?: string;
  /**
   * True when the declared `cinatra.serverEntry` IS a declared `exports`-map
   * key whose target is OUTSIDE the pinned resolver language (array target,
   * wildcard pattern, nested conditions, `null`, non-`./`). Carried so the
   * loader REFUSES it fail-loud — falling back to the literal path would be
   * fail-open versus the materializer's install-time gate.
   */
  invalidExportsTargetDeclared?: boolean;
  /**
   * Declared node-pg-migrate migrations directory (`cinatra.migrationsDir`),
   * if any (#118). Host-run for `trusted-signed` records only.
   */
  migrationsDir?: string;
  /**
   * True when the RETIRED legacy `cinatra.migrations` JSON-DSL field is
   * present in the manifest. Carried so the host can reject it fail-closed
   * (a legacy declaration must never silently activate as "no migrations").
   */
  legacyMigrationsDeclared?: boolean;
  /**
   * True when `cinatra.migrationsDir` is PRESENT but malformed (non-string /
   * blank). Carried so a broken declaration still COUNTS as declaring host
   * migrations — the host preflight then rejects it with a precise error
   * instead of the package silently activating as "no migrations".
   */
  invalidMigrationsDirDeclared?: boolean;
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

/**
 * Does a store record declare host migrations at all — the NEW
 * `migrationsDir` field OR the RETIRED legacy `cinatra.migrations` field
 * (which the host rejects fail-closed, so it must still COUNT as a
 * declaration and can never silently activate as "no migrations")?
 */
export function recordDeclaresHostMigrations(rec: {
  migrationsDir?: string;
  legacyMigrationsDeclared?: boolean;
  invalidMigrationsDirDeclared?: boolean;
}): boolean {
  return (
    typeof rec.migrationsDir === "string" ||
    rec.legacyMigrationsDeclared === true ||
    rec.invalidMigrationsDirDeclared === true
  );
}

/** Minimal injected filesystem surface (so the core is testable with a fake fs). */
export type PackageStoreFs = {
  exists: (path: string) => Promise<boolean>;
  isDirectory: (path: string) => Promise<boolean>;
  readdir: (path: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
};

// LINEAR slash trims. The anchored greedy `/\/+$/` and `/^\/+|\/+$/g` are
// flagged polynomial-ReDoS on slash-heavy segment input (CodeQL
// js/polynomial-redos). These char-index scans are O(n) with no backtracking
// and are byte-for-byte equivalent to the old regexes (proven by the
// joinPath parity test in __tests__/runtime-loader-redos-parity.test.ts).
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--; // 47 = "/"
  return value.slice(0, end);
}

function trimSurroundingSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47) start++; // 47 = "/"
  while (end > start && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(start, end);
}

// POSIX-join (the store path is always a container/posix path). Avoids a
// node:path import so the pure module has zero runtime deps.
//
// Exported (host-internal; NOT re-exported through the public `index.ts`
// surface) so the loader-parity test can prove the linear rewrite matches the
// retired regexes.
export function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? trimTrailingSlashes(p) : trimSurroundingSlashes(p)))
    .filter((p) => p.length > 0)
    .join("/");
}

/**
 * Resolve an `exports`-map KEY (`"./register"`, `"."`) to its relative target —
 * the SINGLE source of truth for serverEntry exports resolution: the host
 * materializer imports THIS (so install-time scanning and activation-time
 * loading can never drift, cinatra#161).
 *
 * Pinned Cinatra resolver semantics (normative — NOT full Node `exports`
 * resolution): exact-key lookup only. A conditional entry is ONE level deep —
 * a plain object whose `import` → `default` → `require` value is a STRING.
 * Everything else resolves to null (and is refused downstream when serverEntry
 * depends on it): array targets, wildcard/`./*` patterns (no pattern matching —
 * exact keys only), nested condition objects, `null` targets, and any target
 * not starting with `./`. Wildcard support is explicitly out of contract until
 * the host-peer import scanner can follow the same forms — the resolver and the
 * scanner must always accept the same language.
 */
export function resolveExportsSubpath(exportsMap: unknown, key: string): string | null {
  if (!exportsMap || typeof exportsMap !== "object" || Array.isArray(exportsMap)) return null;
  const target = (exportsMap as Record<string, unknown>)[key];
  const asContractTarget = (t: unknown): string | null =>
    typeof t === "string" && t.startsWith("./") ? t : null;
  if (typeof target === "string") return asContractTarget(target);
  if (target && typeof target === "object" && !Array.isArray(target)) {
    const cond = target as Record<string, unknown>;
    return asContractTarget(cond.import ?? cond.default ?? cond.require);
  }
  return null;
}

/**
 * Three-way serverEntry resolution against the package `exports` map — the
 * shared semantics BOTH scanners apply (codex AB-r0 finding 1: a DECLARED
 * exports key whose target is outside the pinned resolver language must be
 * REFUSED, never silently fall back to the literal path):
 *   - key DECLARED and target valid  → `{ kind: "resolved", rel: target, viaExports: true }`;
 *   - key NOT declared               → `{ kind: "resolved", rel: serverEntry, viaExports: false }` (literal fallback);
 *   - key DECLARED but target outside the pinned language (array, wildcard
 *     pattern target, nested conditions, null, non-`./`) → `{ kind: "invalid-exports-target" }`.
 */
export type ServerEntryResolution =
  | { kind: "resolved"; rel: string; viaExports: boolean }
  | { kind: "invalid-exports-target" };

export function resolveDeclaredServerEntry(
  exportsMap: unknown,
  serverEntry: string,
): ServerEntryResolution {
  const isMap = !!exportsMap && typeof exportsMap === "object" && !Array.isArray(exportsMap);
  if (isMap && serverEntry in (exportsMap as Record<string, unknown>)) {
    const rel = resolveExportsSubpath(exportsMap, serverEntry);
    return rel === null
      ? { kind: "invalid-exports-target" }
      : { kind: "resolved", rel, viaExports: true };
  }
  return { kind: "resolved", rel: serverEntry, viaExports: false };
}

export type ServerEntryArtifactClass = "importable" | "source" | "unresolved";

/**
 * Classify a resolved serverEntry path by extension (the built-artifacts-only
 * contract, cinatra#161). `importable`: `.mjs`/`.cjs`/`.js` — a concrete
 * Node-importable ESM/CJS artifact; `source`: `.ts`/`.tsx`/`.mts`/`.cts` — a
 * source-mirror shape the runtime store refuses; `unresolved`: anything else
 * (extensionless, unknown extension). `.js` is accepted without consulting
 * `pkg.type` — the module normalizer handles a CJS default-object shape.
 */
export function classifyServerEntryArtifact(rel: string): ServerEntryArtifactClass {
  if (/\.(mjs|cjs|js)$/.test(rel)) return "importable";
  if (/\.(ts|tsx|mts|cts)$/.test(rel)) return "source";
  return "unresolved";
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
  // Exports awareness (cinatra#161): when the declared serverEntry is an
  // `exports`-map KEY, carry the resolved relative target on the record. The
  // raw serverEntry is kept for messages/back-compat; resolveServerEntryPath
  // prefers serverEntryRel. A key DECLARED with a target outside the pinned
  // resolver language is carried as a REFUSAL flag — it must never silently
  // fall back to the literal path (fail-open vs the materializer's gate).
  const entryResolution = serverEntry !== null ? resolveDeclaredServerEntry(pkg.exports, serverEntry) : null;
  const serverEntryRel =
    entryResolution?.kind === "resolved" && entryResolution.viaExports ? entryResolution.rel : null;
  const invalidExportsTargetDeclared = entryResolution?.kind === "invalid-exports-target";
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
  const migrationsDir =
    typeof cinatra.migrationsDir === "string" && cinatra.migrationsDir.trim().length > 0
      ? cinatra.migrationsDir
      : undefined;
  // A PRESENT-but-malformed migrationsDir still counts as a declaration —
  // fail-closed downstream, never silently "no migrations".
  const invalidMigrationsDirDeclared = cinatra.migrationsDir !== undefined && migrationsDir === undefined;
  const legacyMigrationsDeclared = cinatra.migrations !== undefined;
  return {
    packageName: name,
    serverEntry,
    requestedHostPorts,
    sdkAbiRange,
    storeDir,
    declaredDigest,
    ...(serverEntryRel !== null ? { serverEntryRel } : {}),
    ...(invalidExportsTargetDeclared ? { invalidExportsTargetDeclared } : {}),
    ...(uiSurface ? { uiSurface } : {}),
    ...(configSchema ? { configSchema } : {}),
    ...(migrationsDir ? { migrationsDir } : {}),
    ...(invalidMigrationsDirDeclared ? { invalidMigrationsDirDeclared } : {}),
    ...(legacyMigrationsDeclared ? { legacyMigrationsDeclared } : {}),
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
 * Resolve a record's serverEntry to an absolute store path, or null when there
 * is no entry OR the entry is UNSAFE. Resolution prefers the exports-map target
 * (`record.serverEntryRel`, carried by `recordFromManifest`) and falls back to
 * the literal declared `serverEntry` — the SAME semantics as the materialize-
 * time scanner. The abs/`..` safety guard applies to the RESULT of that
 * resolution, so it also guards a hostile exports TARGET
 * (`exports["./register"]: "../../x.mjs"`), not just a hostile literal. The
 * imported code must never escape the integrity-verified package dir, so an
 * absolute path or any parent-dir (`..`) segment is rejected. Callers
 * distinguish "no serverEntry" (skip) from "unsafe serverEntry" (refuse) via
 * `record.serverEntry`: a non-null serverEntry that resolves to null is unsafe.
 */
export function resolveServerEntryPath(record: PackageStoreRecord): string | null {
  if (!record.serverEntry) return null;
  const declared = record.serverEntryRel ?? record.serverEntry;
  const rel = declared.replace(/^\.\//, "");
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
      // A DECLARED exports key with an out-of-contract target is refused
      // BEFORE path resolution — the literal fallback would be fail-open
      // versus the materializer's install-time gate (codex AB-r0 finding 1).
      if (rec.invalidExportsTargetDeclared) {
        throw new Error(
          `[runtime-package-loader] serverEntry "${rec.serverEntry}" for ${packageName} is a declared ` +
            `exports key whose target is outside the supported exports forms (an exact key mapping to a ` +
            `"./"-relative string, or a one-level conditional whose import/default/require value is such a ` +
            `string). The runtime store activates BUILT artifacts only: publish a built ESM entry ` +
            `(e.g. cinatra.serverEntry "./register.mjs", or an exports["./register"] target under dist/) ` +
            `and reinstall the package from the marketplace.`,
        );
      }
      const abs = resolveServerEntryPath(rec);
      if (abs === null) {
        // serverEntry is set but resolved to null => unsafe (absolute / `..`).
        throw new Error(
          `[runtime-package-loader] unsafe serverEntry "${rec.serverEntry}" for ${packageName} ` +
            `(must be a ./-relative path inside the package dir; refusing to import)`,
        );
      }
      // Built-artifacts-only classification (cinatra#161, defense in depth for
      // store dirs written by OLDER installers — the materializer's install-time
      // gate is the primary refusal). A source-mirror / extensionless entry must
      // fail with an ACTIONABLE error here, never an opaque ENOENT later.
      const cls = classifyServerEntryArtifact(abs);
      if (cls !== "importable") {
        const rel = rec.serverEntryRel ?? rec.serverEntry;
        throw new Error(
          `[runtime-package-loader] serverEntry "${rec.serverEntry}" for ${packageName} resolves to ` +
            `"${rel}" which is ${cls === "source" ? "TypeScript source" : "not a concrete importable file"}. ` +
            `The runtime store activates BUILT artifacts only: publish a built ESM entry ` +
            `(e.g. cinatra.serverEntry "./register.mjs", or an exports["./register"] target under dist/) ` +
            `and reinstall the package from the marketplace.`,
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
