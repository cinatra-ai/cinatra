// The `register(ctx)` activation contract.
//
// STATUS: ABI FROZEN. The author-facing ABI (this file + host-context.ts +
// manifest.ts + dependencies.ts) is stable: the port surface, the register/
// bootstrap/destroy lifecycle, and the manifest fields will not change without an
// SDK ABI MAJOR bump. Proven against real consumers (capabilities → resend;
// mcp.registerTool + settings round-trip → google-calendar) + dev-UAT.
//
// One activation path, two loaders: the dev `StaticBundleLoader` (generated
// manifest) and the prod `RuntimePackageLoader` (verified package store) both
// normalize to the same `ExtensionModule` and call the SAME
// `registerWithHost(ctx)`. A parity gate keeps them from diverging.
//
// Strapi split-entrypoint model: an extension exposes `server`, `admin`, and
// `config` entrypoints (mapped to the package `exports` contracts
// `./register`, `./setup-page`, `./settings-page`, `./mcp-module`) so server
// registrars never drag `server-only`/DB across the React `"use client"`
// boundary (the three-file split).

import type { ExtensionHostContext } from "./host-context";

/** The FROZEN SDK ABI version. Bump the MAJOR for any breaking change to the
 * author-facing contract (ports, lifecycle, manifest fields); MINOR for additive
 * OPTIONAL methods on existing ports.
 * 2.0.0: added the `telemetry` host port — see `host-context.ts`.
 * 2.1.0: added optional `mcp.getPublicBaseUrl`.
 * 2.2.0: added optional `nango` render-time getters (getStatus,
 *   getFrontendConfig, getPrimarySavedConnection(s), listConnectionRecords). */
export const SDK_EXTENSIONS_ABI_VERSION = "2.2.0" as const;

/**
 * The package `exports` subpaths every extension package must expose.
 * The extension-template scaffolds these; the loaders + manifest generator
 * resolve them. Not all kinds use every subpath
 * (`./setup-page`/`./settings-page` are connector/UI; `./mcp-module` is for
 * MCP-capability kinds) — `./register` is the one universal contract.
 */
export const EXTENSION_PACKAGE_EXPORT_CONTRACTS = [
  "./register",
  "./setup-page",
  "./settings-page",
  "./mcp-module",
] as const;

export type ExtensionPackageExportContract = (typeof EXTENSION_PACKAGE_EXPORT_CONTRACTS)[number];

/** Server-side activation: the privileged half. Runs under `server-only`. */
export type ExtensionServerEntry = {
  /** Called once at host activation with the granted port subset. */
  register(ctx: ExtensionHostContext): void | Promise<void>;
  /** Optional post-register hook (after all extensions registered). */
  bootstrap?(ctx: ExtensionHostContext): void | Promise<void>;
  /** Optional teardown for hot-reload / uninstall (runtime path). */
  destroy?(ctx: ExtensionHostContext): void | Promise<void>;
};

/** Admin/client-side activation: true client widgets only (no server-only). */
export type ExtensionAdminEntry = {
  /** Registers client surfaces (setup/settings pages) into the host admin. */
  register(host: unknown): void;
};

/** Config entrypoint: feature-flag + dynamic resolution (Strapi `config`). */
export type ExtensionConfigEntry = {
  /** Statically enabled? Host short-circuits activation when false. */
  enabled?: boolean;
  /** Optional dynamic resolution (e.g. enabled only when a dep is present). */
  resolve?(ctx: { installedPackages: ReadonlySet<string> }): boolean | Promise<boolean>;
};

/**
 * The normalized extension shape BOTH loaders produce. Either a unified module
 * exposing `register` directly, or the Strapi split (`server`/`admin`/`config`).
 */
export type ExtensionModule = {
  packageName: string;
  abiVersion: string;
  server?: ExtensionServerEntry;
  admin?: ExtensionAdminEntry;
  config?: ExtensionConfigEntry;
  /** Convenience: a top-level `register` is treated as `server.register`. */
  register?: ExtensionServerEntry["register"];
};

/** Author-facing helper: define a server entry with inferred typing. */
export function defineServerEntry(entry: ExtensionServerEntry): ExtensionServerEntry {
  return entry;
}

/** Author-facing helper: define a full module (split or unified). */
export function defineExtension(mod: Omit<ExtensionModule, "abiVersion">): ExtensionModule {
  return { abiVersion: SDK_EXTENSIONS_ABI_VERSION, ...mod };
}

/**
 * Host-side normalization helper used by both loaders before activation:
 * resolve a module's server entry whether it used the unified `register`
 * shortcut or the split `server` entrypoint.
 */
export function resolveServerEntry(mod: ExtensionModule): ExtensionServerEntry | null {
  if (mod.server) return mod.server;
  if (mod.register) return { register: mod.register };
  return null;
}

/**
 * Normalize a dynamically-imported `./register` module namespace into a full
 * `ExtensionModule`, used by BOTH loaders. CRITICAL: it preserves the WHOLE
 * activation shape — the split `server` entry, top-level `register`/`bootstrap`/
 * `destroy` exports, AND the `config` gate. (The earlier loader reduced an
 * import to just `{ register }`, silently dropping `bootstrap`/`destroy`/
 * `config` so the config gate never fired and post-register/teardown hooks never
 * ran.) Accepts either named exports (`export function register…`) or a
 * `defineExtension({...})` value on `default`. Returns null when no `register`
 * function is resolvable (the loader then records `no-server-entry`).
 */
export function normalizeServerModule(packageName: string, imported: unknown): ExtensionModule | null {
  if (!imported || typeof imported !== "object") return null;
  const ns = imported as Record<string, unknown>;
  // Support `export default defineExtension({...})` / a default ExtensionModule.
  const def = ns.default;
  const src =
    def && typeof def === "object" && ("register" in (def as object) || "server" in (def as object))
      ? (def as Record<string, unknown>)
      : ns;

  const config = (src.config ?? undefined) as ExtensionConfigEntry | undefined;
  let server = (src.server ?? undefined) as ExtensionServerEntry | undefined;
  if (!server) {
    const register = src.register as ExtensionServerEntry["register"] | undefined;
    if (typeof register === "function") {
      server = {
        register,
        bootstrap: typeof src.bootstrap === "function" ? (src.bootstrap as ExtensionServerEntry["bootstrap"]) : undefined,
        destroy: typeof src.destroy === "function" ? (src.destroy as ExtensionServerEntry["destroy"]) : undefined,
      };
    }
  }
  if (!server || typeof server.register !== "function") return null;
  return { packageName, abiVersion: SDK_EXTENSIONS_ABI_VERSION, server, config };
}

type SemverTriple = [number, number, number];

function parseSemverTriple(v: string): SemverTriple | null {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpTriple(a: SemverTriple, b: SemverTriple): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * Compute the [lower, upperExclusive) bounds a SUPPORTED range admits, or null if
 * the form is unsupported (→ fail closed). Supported forms (the ones extensions
 * realistically declare): exact `X.Y.Z`, bare/x-range `X` / `X.Y` / `X.x` /
 * `X.Y.x`, caret `^X[.Y[.Z]]`, tilde `~X[.Y[.Z]]`, and `>=X[.Y[.Z]]`. Major must
 * be ≥ 1 (the ABI's major-0 has different caret semantics; rejected). Comparators
 * other than `>=` (`<`, `>`, `<=`, `||`, hyphen ranges, pre-release) are rejected.
 */
function rangeBounds(range: string): { lower: SemverTriple; upper: SemverTriple | null } | null {
  const m = range.match(/^(\^|~|>=|=)?\s*(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/);
  if (!m) return null;
  const op = m[1] ?? "=";
  const maj = Number(m[2]);
  if (maj < 1) return null; // major-0 ABI semantics differ — fail closed
  const isWild = (t: string | undefined) => t === undefined || /^[xX*]$/.test(t);
  const min = isWild(m[3]) ? null : Number(m[3]);
  const pat = isWild(m[4]) ? null : Number(m[4]);
  const lower: SemverTriple = [maj, min ?? 0, pat ?? 0];
  if (op === ">=") return { lower, upper: null };
  if (op === "^") return { lower, upper: [maj + 1, 0, 0] };
  if (op === "~") return { lower, upper: min === null ? [maj + 1, 0, 0] : [maj, min + 1, 0] };
  // "=" / bare / x-range: the upper bound narrows with each specified component.
  if (min === null) return { lower, upper: [maj + 1, 0, 0] }; // "1" / "1.x"
  if (pat === null) return { lower, upper: [maj, min + 1, 0] }; // "1.2" / "1.2.x"
  return { lower, upper: [maj, min, pat + 1] }; // exact "1.2.3"
}

/**
 * SDK-ABI compatibility verdict the host injects as the loader's `abiCompatible`
 * for each record (consulting the manifest's declared `cinatra.sdkAbiRange`):
 * does the host's frozen ABI version SATISFY the extension's declared range?
 *  - absent / "" / "*"  → compatible (unpinned).
 *  - else: parse the range's [lower, upperExclusive) bounds and check the host is
 *    inside. FAIL CLOSED on an unsupported/malformed range OR a host outside the
 *    bounds (e.g. host 1.0.0 vs a range requiring ≥ 1.1.0 / 1.0.1 / ^2 → refused).
 * Host-generic: ^1.0.0 IS satisfied by a future host 1.5.0; ~1.0 / exact 1.0.0 are not.
 */
export function isSdkAbiRangeSatisfied(hostAbi: string, range: string | null | undefined): boolean {
  const r = (range ?? "").trim();
  if (r === "" || r === "*") return true;
  const host = parseSemverTriple(hostAbi);
  if (!host) return false;
  const bounds = rangeBounds(r);
  if (!bounds) return false; // unsupported / malformed → fail closed
  if (cmpTriple(host, bounds.lower) < 0) return false; // host below the floor
  if (bounds.upper && cmpTriple(host, bounds.upper) >= 0) return false; // host at/above the (exclusive) ceiling
  return true;
}
