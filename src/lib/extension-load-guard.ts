import "server-only";

// The standardized degraded-result guard for `guardedOptional` generated
// loader entries (cinatra#7).
//
// PRESENCE-AWARENESS LAYERING: the PRIMARY mechanism for an absent extension
// is regenerate-at-consumption — the generated maps are re-emitted against the
// extension tree actually present at every consuming surface (`make setup` /
// fresh clone, the prod image build stage), so an absent package/subpath is
// OMITTED from the maps and never even compiled. This guard is the SECONDARY
// net, for POST-BUILD legitimate absence only (e.g. a marketplace uninstall
// that removes an optional package after the maps were baked): a guarded
// loader whose target module is gone resolves to the standardized degraded
// `absent` result below instead of throwing, and the consuming surface
// degrades per entry.
//
// FAIL-LOUD BOUNDARY (deliberate): only a CONFIRMED "target module absent"
// failure degrades — a module-not-found error class whose message names the
// guarded package. Everything else RETHROWS: a present extension whose module
// throws at top level, or whose TRANSITIVE dependency is missing, is a real
// bug that must keep failing exactly as loudly as the unguarded import it
// replaced (the long-standing fail-loud contract of the map consumers).
//
// The generator (scripts/extensions/generate-extension-manifest.mjs) is the
// ONLY sanctioned producer of guarded loaders in the generated maps; the
// brands below are how the generated guarded-optional test proves every
// `guardedOptional` entry routes through this module (generator/guard-owned
// marking — never source-shape inference).

/** The discriminating status value of a degraded load result. */
export const EXTENSION_LOAD_ABSENT_STATUS = "absent" as const;

// Symbol.for — registry symbols, so the brand survives duplicated module
// instances across bundles/realms.
const DEGRADED_BRAND: unique symbol = Symbol.for("cinatra.extension-load-guard.degraded");
const GUARDED_BRAND: unique symbol = Symbol.for("cinatra.extension-load-guard.guarded");

/**
 * The standardized degraded result a guarded loader resolves to when its
 * target module is absent post-build. Consumers detect it with
 * `isDegradedExtensionLoad` and degrade their own surface per entry.
 */
export type DegradedExtensionLoad = {
  readonly [DEGRADED_BRAND]: true;
  readonly status: typeof EXTENSION_LOAD_ABSENT_STATUS;
  /** The literal import specifier the generator emitted (e.g. `@scope/pkg/mcp-module`). */
  readonly specifier: string;
  /** The owning package name (`@scope/pkg`). */
  readonly packageName: string;
  /** The underlying loader error message (diagnostic only). */
  readonly reason: string;
};

/** A guarded loader produced by `guardedExtensionImport` (brand + metadata). */
export type GuardedExtensionLoader = {
  (): Promise<unknown>;
  readonly [GUARDED_BRAND]: true;
  readonly specifier: string;
  readonly packageName: string;
};

/**
 * Typed "module absent" error for consumers that must convert a degraded
 * result back into a thrown, FAILURE-ISOLATED error (e.g. the
 * StaticBundleLoader's per-extension activation result, or the widget-stream
 * route's non-500 absent branch).
 */
export class ExtensionModuleAbsentError extends Error {
  readonly specifier: string;

  constructor(specifier: string, reason: string) {
    super(`extension module "${specifier}" is absent from this build: ${reason}`);
    this.name = "ExtensionModuleAbsentError";
    this.specifier = specifier;
  }
}

/** `@scope/pkg/subpath` → `@scope/pkg`; `pkg/subpath` → `pkg`. */
export function extensionPackageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// Node/webpack module-not-found error codes. ERR_PACKAGE_PATH_NOT_EXPORTED is
// included deliberately: a package PRESENT without the target subpath in its
// `exports` map is the same "this module is not shipped" class (the #110
// exports-map gap), not a broken present module.
const ABSENT_ERROR_CODES = new Set([
  "MODULE_NOT_FOUND",
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
]);

// The MISSING specifier, extracted from the not-found message's QUOTED form —
// never matched against the whole message: a missing TRANSITIVE dependency's
// error routinely names the guarded package elsewhere in the text (Node's
// `Require stack:` / ESM's `imported from <path inside the package>`), so a
// whole-message containment check would misclassify a present-but-broken
// extension as absent. Covered phrasings:
//   - Node CJS/ESM:  Cannot find module '<spec-or-abs-path>' …
//   - Node ESM pkg:  Cannot find package '<pkg>' imported from …
//   - webpack/Turbopack: Module not found: … Can't resolve '<spec>' …
const MISSING_SPECIFIER_RES = [
  /cannot find (?:module|package) '([^']+)'/i,
  /can't resolve '([^']+)'/i,
];

function missingSpecifierFrom(text: string): string | null {
  for (const re of MISSING_SPECIFIER_RES) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

// Does the MISSING specifier belong to the guarded package itself? Either the
// bare package/subpath specifier, or a resolved FILE path inside the package's
// own tree (node_modules install or the workspace extensions/<scope>/<name>/
// source dir) — the latter is the "package present, target file gone" subpath
// dangle of the #109/#110 class.
function specifierBelongsToPackage(spec: string, packageName: string): boolean {
  if (spec === packageName || spec.startsWith(`${packageName}/`)) return true;
  if (spec.includes(`/node_modules/${packageName}/`)) return true;
  const scoped = packageName.match(/^@([^/]+)\/(.+)$/);
  if (scoped && spec.includes(`/extensions/${scoped[1]}/${scoped[2]}/`)) return true;
  return false;
}

/**
 * TRUE only for a module-not-found failure of the GUARDED package itself:
 * a recognized not-found code/message AND a quoted MISSING specifier that
 * resolves to the guarded package (bare specifier, subpath, or a file path
 * inside the package's own tree). A missing TRANSITIVE dependency also raises
 * MODULE_NOT_FOUND but its quoted missing specifier names the OTHER package —
 * that rethrows (real bug, fail loud) even when the require stack / importer
 * path mentions the guarded package.
 */
export function isAbsentModuleError(error: unknown, packageName: string): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  const text = typeof message === "string" ? message : "";
  const codeMatches = typeof code === "string" && ABSENT_ERROR_CODES.has(code);
  // Bundler runtimes (webpack/Turbopack) throw plain Errors without a Node
  // error code; accept the canonical quoted not-found phrasings as the
  // code-less fallback.
  const messageMatches = /\b(cannot find module|module not found|cannot find package)\b/i.test(text);
  if (!codeMatches && !messageMatches) return false;
  // exports-map gap (#110 class): the message quotes the SUBPATH (not the
  // package) and identifies the package by its package.json path — require
  // exactly that identification.
  if (code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
    return text.includes(`${packageName}/package.json`);
  }
  const missing = missingSpecifierFrom(text);
  if (!missing) return false; // cannot CONFIRM the target — fail loud
  return specifierBelongsToPackage(missing, packageName);
}

function makeDegradedExtensionLoad(
  specifier: string,
  packageName: string,
  reason: string,
): DegradedExtensionLoad {
  return Object.freeze({
    [DEGRADED_BRAND]: true as const,
    status: EXTENSION_LOAD_ABSENT_STATUS,
    specifier,
    packageName,
    reason,
  });
}

/**
 * Wrap a literal dynamic import as a guarded loader: target-module absence
 * resolves to the standardized degraded result (loud console.error, never a
 * throw); every other failure rethrows unchanged. The importer stays a
 * LITERAL `() => import("...")` at the emission site (Turbopack only bundles
 * literal dynamic imports) — this wrapper never computes a specifier.
 */
export function guardedExtensionImport(
  specifier: string,
  importer: () => Promise<unknown>,
): GuardedExtensionLoader {
  const packageName = extensionPackageNameOf(specifier);
  const load = async (): Promise<unknown> => {
    try {
      return await importer();
    } catch (error) {
      if (!isAbsentModuleError(error, packageName)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `[extension-load-guard] optional extension module "${specifier}" is absent from this ` +
          `build — resolving the standardized degraded result (surface degrades per entry):`,
        reason,
      );
      return makeDegradedExtensionLoad(specifier, packageName, reason);
    }
  };
  return Object.assign(load, {
    [GUARDED_BRAND]: true as const,
    specifier,
    packageName,
  });
}

/** Brand check: was this loader produced by `guardedExtensionImport`? */
export function isGuardedExtensionLoader(value: unknown): value is GuardedExtensionLoader {
  return (
    typeof value === "function" &&
    (value as Partial<Record<typeof GUARDED_BRAND, unknown>>)[GUARDED_BRAND] === true
  );
}

/** Brand check: is this load result the standardized degraded `absent` result? */
export function isDegradedExtensionLoad(value: unknown): value is DegradedExtensionLoad {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<Record<typeof DEGRADED_BRAND, unknown>>)[DEGRADED_BRAND] === true
  );
}
