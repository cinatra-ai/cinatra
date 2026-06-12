#!/usr/bin/env node
// Canonical serverEntry builder for publishable extension packages
// (cinatra#161 Stage C — design §4.1). Turns the in-tree source-mirror shape
// (`cinatra.serverEntry: "./register"` + `exports["./register"] →
// "./src/register.ts"`) into the runtime-store-installable BUILT shape: a
// staged temp pack dir whose top-level `register.mjs` is a self-contained ESM
// bundle and whose manifest declares `cinatra.serverEntry: "./register.mjs"`.
// `npm pack` (the release pipeline) then runs FROM the staged dir; every
// downstream consumer reads the PACKED manifest, never the source manifest —
// the source tree is NEVER touched.
//
// EXECUTION-CONTEXT CONTRACT (design §4.1): this file is
// fully SELF-CONTAINED — it must run standalone (release CI fetches it into a
// bare tools dir with no monorepo workspace), so the exports-key selection,
// the resolved-target safety guard, and the artifact classifier are INLINED
// here instead of imported from `@cinatra-ai/sdk-extensions` (which is
// TS-source-shaped and not Node-runnable outside the workspace). The monorepo
// parity test (`scripts/extensions/__tests__/build-server-entry.test.ts`) pins
// the inlined logic against the SDK exports over a shared case table — if
// either side changes, that test fails. Only dependency: `esbuild` (resolved
// from this file's location, overridable via --esbuild-dir / CINATRA_ESBUILD_DIR).
//
// BUILD-TIME INPUTS (explicit contract): the package's own declared
// dependencies must be installed next to it (its node_modules), and a server
// graph that imports `next/<api>` additionally needs `next` provisioned next
// to the package (devDependency in a standalone repo; the workspace provides
// it in the monorepo) — missing inputs fail LOUD with that direction.
// `server-only` is builder-shimmed (never an input).
//
// MODE SPLIT (design §4.1): the runtime store and the
// loader accept ONLY importable artifacts (.mjs/.cjs/.js); THIS builder
// accepts SOURCE input (.ts/.tsx/.mts/.cts) because its whole job is turning
// source into a built artifact. Already-built entries pass through verbatim
// (no rewrite); the SAME safety guard (inside-package, no abs/`..` segment)
// applies in both modes.
//
// DEPENDENCY MODES (cinatra#181 — library dependency closure):
//   - `cinatra.dependencyMode` absent or "inline" (the DEFAULT — today's
//     behavior, byte-identical): every runtime dependency reachable from the
//     entry is INLINED into the bundle and `dependencies` is PRUNED from the
//     packed manifest. The published artifact stands alone.
//   - `cinatra.dependencyMode: "closure"` (declare-and-closure): declared
//     runtime `dependencies` stay EXTERNAL in the bundle and are KEPT in the
//     packed manifest — at install time the host materializes them from the
//     package's SIGNED MATERIALIZATION PLAN (publish-time locked; the
//     installer executes it verbatim). The residual-import check relaxes to
//     "node builtins OR declared dependencies" (host ABI peers stay refused —
//     unchanged hazard class). An already-importable entry passes through
//     VERBATIM but its import graph is residual-VALIDATED (never re-bundled).
//     A closure package without a serverEntry is legal (its deps are covered
//     by the plan alone).
//   Built `register.mjs` + the packed-manifest self-check stay MANDATORY in
//   BOTH modes. Interim adoption is fail-closed by construction: a closure
//   tarball published before the host's relaxed install gate deploys is
//   refused by the bundled-deps gate, and no signed plan exists until the
//   publish-time signer ships.
//
// Library + CLI:
//   import { buildServerEntryPack } from "./build-server-entry.mjs"
//   node scripts/extensions/build-server-entry.mjs <packageDir> --out <dir> [--mode inline|closure] [--json]
//   (`--mode` overrides the manifest's cinatra.dependencyMode — TESTS ONLY;
//   release CI always builds from the manifest declaration.)

import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Inlined resolver — pinned Cinatra semantics (design §2). Kept in lockstep
// with `packages/sdk-extensions/src/runtime-loader.ts` by the parity test.
// ---------------------------------------------------------------------------

/**
 * Resolve an `exports`-map KEY (`"./register"`, `"."`) to its relative target.
 * Pinned semantics — NOT full Node `exports` resolution: exact-key lookup
 * only; a conditional entry is ONE level deep (a plain object whose
 * `import` → `default` → `require` value is a STRING). Arrays, wildcard
 * patterns, nested condition objects, `null` targets, and any target not
 * starting with `./` resolve to null.
 */
export function resolveExportsSubpath(exportsMap, key) {
  if (!exportsMap || typeof exportsMap !== "object" || Array.isArray(exportsMap)) return null;
  const target = exportsMap[key];
  const asContractTarget = (t) => (typeof t === "string" && t.startsWith("./") ? t : null);
  if (typeof target === "string") return asContractTarget(target);
  if (target && typeof target === "object" && !Array.isArray(target)) {
    return asContractTarget(target.import ?? target.default ?? target.require);
  }
  return null;
}

/**
 * Three-way serverEntry resolution against the package `exports` map — the
 * same shared semantics both host scanners apply: a DECLARED exports key whose
 * target is outside the pinned resolver language is REFUSED (never a silent
 * literal fallback); an UNDECLARED key falls back to the literal path.
 */
export function resolveDeclaredServerEntry(exportsMap, serverEntry) {
  const isMap = !!exportsMap && typeof exportsMap === "object" && !Array.isArray(exportsMap);
  if (isMap && serverEntry in exportsMap) {
    const rel = resolveExportsSubpath(exportsMap, serverEntry);
    return rel === null
      ? { kind: "invalid-exports-target" }
      : { kind: "resolved", rel, viaExports: true };
  }
  return { kind: "resolved", rel: serverEntry, viaExports: false };
}

/**
 * Classify a resolved serverEntry path by extension. `importable`
 * (.mjs/.cjs/.js) is what the runtime store accepts; `source`
 * (.ts/.tsx/.mts/.cts) is what THIS builder turns into a bundle; `unresolved`
 * (extensionless / unknown) is refused everywhere.
 */
export function classifyServerEntryArtifact(rel) {
  if (/\.(mjs|cjs|js)$/.test(rel)) return "importable";
  if (/\.(ts|tsx|mts|cts)$/.test(rel)) return "source";
  return "unresolved";
}

/**
 * The SAME segment-level safety rule the host materializer and loader apply:
 * absolute paths and ANY `..` segment are refused even when the path would
 * normalize back inside the package (install-time and activation-time must
 * agree, so the builder must refuse what the store would refuse).
 */
function entryEscapesPackageDir(rel) {
  const cleaned = rel.replace(/^\.\//, "");
  return cleaned.startsWith("/") || cleaned.split("/").some((seg) => seg === "..");
}

// ---------------------------------------------------------------------------
// Host-provided peers (externals). Inlined for the same standalone reason —
// keep in lockstep with `HOST_PROVIDED_PACKAGES` in
// `src/lib/extension-package-store-core.ts` (pinned by the parity test).
// These stay EXTERNAL so an accidental value import survives into the bundle
// as a visible `import` statement — the residual-import check below (and the
// host's materialize-time host-peer gate) then fails LOUD instead of silently
// inlining a second SDK instance and breaking ABI identity.
// ---------------------------------------------------------------------------
export const HOST_PROVIDED_PEERS = Object.freeze([
  "@cinatra-ai/sdk-extensions",
  "@cinatra-ai/sdk-ui",
  "@cinatra-ai/mcp-client",
]);

/**
 * EXACT builtin recognition (review r3 finding 1): `node:module`'s
 * `isBuiltin` matches only real builtin specifiers (`fs`, `fs/promises`,
 * `node:fs`, …) — never first-segment lookalikes like `fs/../left-pad`, which
 * Node resolves as PACKAGE `fs` with a traversing subpath. Strictly
 * fail-closed vs the previous first-segment check.
 */
function isNodeBuiltin(specifier) {
  return isBuiltin(specifier);
}

/**
 * Collapse a bare specifier to its base package (`@scope/name/sub` →
 * `@scope/name`, `pkg/sub` → `pkg`). Returns null for relative/absolute
 * specifiers. Inlined for the standalone contract — mirrors
 * `basePackageOfSpecifier` in `src/lib/extension-package-store-core.ts`.
 */
function basePackageOfSpecifier(spec) {
  if (typeof spec !== "string" || spec.length === 0) return null;
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return spec.split("/")[0];
}

// ---------------------------------------------------------------------------
// Dependency mode (cinatra#181) — inline-and-prune vs declare-and-closure.
// ---------------------------------------------------------------------------

export const DEPENDENCY_MODES = Object.freeze(["inline", "closure"]);

/**
 * Resolve the effective dependency mode: the `--mode` CLI override (TESTS
 * ONLY) wins, else the manifest's `cinatra.dependencyMode`, else "inline"
 * (today's behavior, byte-identical). Anything outside the two declared modes
 * is a fail-loud refusal — a typo must never silently build inline.
 */
export function resolveDependencyMode(cinatra, modeOverride, packageName) {
  const candidate = modeOverride ?? (cinatra && typeof cinatra === "object" ? cinatra.dependencyMode : undefined);
  if (candidate === undefined || candidate === null) return "inline";
  if (DEPENDENCY_MODES.includes(candidate)) return candidate;
  throw new Error(
    `[build-server-entry] ${packageName}: cinatra.dependencyMode ${JSON.stringify(candidate)} is not a ` +
      `supported mode (expected "inline" or "closure", or omit the field for the inline default).`,
  );
}

/**
 * Classify one residual EXTERNAL import of a CLOSURE-mode entry graph. Returns
 * null when the import is allowed, else the refusal reason. Shared by the
 * closure-mode bundle residual check and the closure-mode passthrough
 * validation so the two can never drift. (The inline-mode residual check is
 * untouched — its bundle may import node builtins ONLY, byte-identical to the
 * pre-mode builder.)
 *  - node builtins: allowed;
 *  - host ABI peers: ALWAYS refused (unchanged hazard class — the host
 *    provides the single shared instance; a runtime value import can never
 *    resolve from the store dir);
 *  - declared runtime dependencies: allowed (the signed materialization plan
 *    covers them at install);
 *  - anything else: refused. Self-references never surface here — both modes
 *    resolve them INTO the scanned graph (esbuild's native self-reference
 *    resolution in bundle mode; the pinned exports-map trace in the
 *    passthrough scan), so an unresolvable one is a build/scan error, never a
 *    silent allowance (review r0 finding 1).
 */
function classifyClosureResidualImport(specifier, { declaredDeps }) {
  if (isNodeBuiltin(specifier)) return null;
  const base = basePackageOfSpecifier(specifier);
  if (base !== null && HOST_PROVIDED_PEERS.includes(base)) {
    return (
      `imports host ABI peer "${specifier}" at runtime — host-provided peers must stay type-only ` +
      `(take values via ctx capabilities) in EVERY dependency mode`
    );
  }
  if (base !== null && declaredDeps.has(base)) {
    // Subpath-safety (review r2 finding 1): `dep/../left-pad/...` shares
    // the `dep` base but Node-resolves OUTSIDE the declared package. The
    // remainder after the base must be clean path segments — no `.`/`..`,
    // no empties, no backslashes, no percent-encoding (Node refuses encoded
    // separators in bare specifiers; we refuse `%` wholesale).
    const remainder = specifier.slice(base.length);
    const remainderUnsafe =
      remainder.length > 0 &&
      (/[\\%]/.test(remainder) ||
        remainder
          .replace(/^\//, "")
          .split("/")
          .some((seg) => seg === "" || seg === "." || seg === ".."));
    if (!remainderUnsafe) return null;
    return (
      `imports "${specifier}" at runtime — a traversal-unsafe subpath of declared dependency ` +
      `"${base}" (Node would resolve it outside that package)`
    );
  }
  return (
    `imports "${specifier}" at runtime, which is neither a node builtin nor a declared runtime ` +
    `dependency — declare it in "dependencies" (the signed materialization plan must cover it) ` +
    `or inline it`
  );
}

/** Valid npm package name (scoped or not) — the alias-target shape gate. */
const NPM_PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * ALLOWLIST test for a registry version spec (review r1 finding 1): a
 * semver range / x-range / hyphen range / `||` union / dist-tag. Every
 * non-registry source npm understands carries a protocol marker (`file:`,
 * `link:`, `workspace:`, `portal:`, `patch:`, `catalog:`, `git+…:`, `ssh:`,
 * `http(s):`) or a path separator (GitHub shorthand `user/repo`, relative
 * paths) — both are refused wholesale, so a NEW protocol npm grows is refused
 * by default instead of slipping through a denylist.
 */
function isRegistryRangeOrTag(spec) {
  return typeof spec === "string" && spec.trim().length > 0 && !/[:/\\]/.test(spec) && !spec.trim().startsWith(".");
}

/**
 * Closure-mode dependency-spec gate (review r0 finding 2, allowlisted per
 * r1 finding 1; aliases refused per the PR-2 merge-safe round): the declared
 * `dependencies` are the basis of the publish-time SIGNED materialization
 * plan, so in closure mode every spec must be a PLAIN registry spec — an
 * explicit range / x-range / union / dist-tag under the dependency's REAL
 * package name.
 *  - a host ABI peer as a dependency KEY is refused (never a closure library;
 *    the install gate refuses it too);
 *  - an `npm:` ALIAS whose target is a host ABI peer is refused (alias
 *    smuggling — the import would ride the alias key past the peer check);
 *  - every OTHER `npm:` alias is refused too: the signed plan format
 *    (`cinatra-materialization-plan/v1`) carries a SINGLE identity per node —
 *    the `node_modules` placement name IS the registry package name — so an
 *    aliased dependency (placement name != registry identity) is not
 *    expressible. Depend on the real name instead;
 *  - everything else (file/link/workspace/portal/patch/catalog/git/
 *    GitHub-shorthand/URL/non-string/empty) is refused — the plan derives
 *    from a committed lockfile with REGISTRY sources only (the signer side
 *    refuses these at plan computation; the builder fails the same class at
 *    build time, fail-closed by construction for anything new).
 */
function assertClosureDependencySpecs(packageName, deps) {
  const entries = Object.entries(deps ?? {});
  const hostPeerDeps = entries.filter(([dep]) => HOST_PROVIDED_PEERS.includes(dep)).map(([dep]) => dep);
  if (hostPeerDeps.length > 0) {
    throw new Error(
      `[build-server-entry] ${packageName}: host ABI peer(s) declared in "dependencies" ` +
        `(${hostPeerDeps.join(", ")}) — these are host-provided peers, never closure libraries. ` +
        `Declare them in "peerDependencies"; the install gate refuses this shape too.`,
    );
  }
  for (const [dep, rawSpec] of entries) {
    const spec = typeof rawSpec === "string" ? rawSpec.trim() : null;
    if (spec !== null && spec.startsWith("npm:")) {
      const aliasTarget = spec.slice("npm:".length);
      // Base package of the alias target: `@scope/name@range` → `@scope/name`,
      // `name@range` → `name` (the version separator is the first `@` past the
      // scope marker).
      const sepIdx = aliasTarget.startsWith("@") ? aliasTarget.indexOf("@", 1) : aliasTarget.indexOf("@");
      const aliasBase = sepIdx === -1 ? aliasTarget : aliasTarget.slice(0, sepIdx);
      if (HOST_PROVIDED_PEERS.includes(aliasBase)) {
        throw new Error(
          `[build-server-entry] ${packageName}: dependency "${dep}" is an npm alias of host ABI peer ` +
            `"${aliasBase}" (${spec}) — host-provided peers can never be closure libraries, aliased or not.`,
        );
      }
      throw new Error(
        `[build-server-entry] ${packageName}: dependency "${dep}" is an npm: alias (${spec}) — ` +
          `the SIGNED materialization plan format (cinatra-materialization-plan/v1) carries a ` +
          `single identity per node (the node_modules placement name IS the registry package ` +
          `name), so aliased dependencies are not expressible in closure mode. ` +
          `Depend on ${NPM_PACKAGE_NAME_RE.test(aliasBase) ? `"${aliasBase}"` : "the target package"} under its real name instead.`,
      );
    }
    if (spec === null || !isRegistryRangeOrTag(spec)) {
      throw new Error(
        `[build-server-entry] ${packageName}: dependency "${dep}" has a non-registry spec ` +
          `(${spec === null ? JSON.stringify(rawSpec) : spec}) — closure mode accepts ONLY plain ` +
          `registry ranges/tags; the SIGNED materialization plan derives from a committed ` +
          `lockfile with registry sources only (git/file/link/workspace/portal/patch/` +
          `catalog/URL/alias sources are refused at plan computation too).`,
      );
    }
  }
}

/** Map an esbuild metafile input path (`node_modules/...`) to its package name. */
function packageNameFromInputPath(inputPath) {
  const norm = inputPath.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("node_modules/");
  if (idx === -1) return null;
  const rest = norm.slice(idx + "node_modules/".length);
  // pnpm store layout: node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/...
  const parts = rest.split("/");
  if (parts[0] === ".pnpm") return null; // a deeper node_modules/ segment follows; lastIndexOf already skipped it
  if (parts[0]?.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}

async function loadEsbuild(esbuildDir) {
  const dir = esbuildDir ?? process.env.CINATRA_ESBUILD_DIR ?? null;
  if (dir) {
    const req = createRequire(pathToFileURL(path.join(path.resolve(dir), "noop.js")));
    return import(pathToFileURL(req.resolve("esbuild")).href);
  }
  return import("esbuild");
}

async function statOrNull(p) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

/** Recursive copy of the package dir, excluding never-published trees. */
async function copyPackageTree(packageDir, packDir) {
  await mkdir(packDir, { recursive: true });
  await cp(packageDir, packDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(packageDir, src);
      if (rel === "") return true;
      const top = rel.split(path.sep)[0];
      return top !== "node_modules" && top !== ".git";
    },
  });
}

/**
 * Build the staged temp pack dir for one extension package (design §4.1).
 *
 * Modes (returned as `mode`):
 *  - "none"        — no `cinatra.serverEntry`: verbatim copy, no rewrite
 *                    (agents/skills/artifacts/workflows pack unchanged);
 *  - "passthrough" — the declared entry already resolves to an importable
 *                    artifact (.mjs/.cjs/.js) that exists: verbatim copy,
 *                    manifest untouched;
 *  - "bundled"     — the declared entry resolves to TS source: esbuild-bundle
 *                    it to top-level `register.mjs` (format esm, platform
 *                    node, externals = host ABI peers — plus, in closure
 *                    dependency mode, the declared runtime dependencies —
 *                    conditions ["react-server"] + the next/<api> react-server
 *                    aliasing so the graph gets the same server-layer module
 *                    views the host's RSC compile produces) and rewrite the
 *                    PACKED manifest: `cinatra.serverEntry: "./register.mjs"`,
 *                    `register.mjs` appended to `files`. In INLINE dependency
 *                    mode (the default) `dependencies` is PRUNED — the bundle
 *                    inlines the entry's whole runtime graph, and the
 *                    materializer's bundled-deps gate requires every remaining
 *                    `dependencies` entry to ship under `node_modules` (which
 *                    npm pack never includes), so a published inline artifact
 *                    carries no `dependencies`. In CLOSURE mode `dependencies`
 *                    is KEPT — the host materializes it from the signed plan.
 *                    UI-only deps play no role in the runtime store (UI stays
 *                    host-compiled via the static path — design §4.1).
 *
 * Fail-loud refusals (throws): declared exports key with an out-of-contract
 * target; entry escaping the package dir; entry file missing; extensionless /
 * unknown-extension resolution; an unsupported `cinatra.dependencyMode`; a
 * host ABI peer declared in `dependencies` (closure mode — the install gate
 * refuses it too); a bundle that STILL imports anything beyond node builtins
 * (inline mode) or beyond node builtins + declared dependencies (closure
 * mode; host peers refused in both); a closure-mode PASSTHROUGH entry whose
 * import graph violates the same closure residual rule.
 *
 * @param {{ packageDir: string, outDir?: string | null, esbuildDir?: string | null, mode?: "inline" | "closure" | null, quiet?: boolean }} options
 * @returns {Promise<{ mode: "none" | "passthrough" | "bundled", dependencyMode: "inline" | "closure", packDir: string, packageName: string, entryRel: string | null, inlinedPackages: string[], prunedDependencies: string[], declaredDependencies: string[] }>}
 */
export async function buildServerEntryPack({ packageDir, outDir, esbuildDir, mode = null, quiet = true } = {}) {
  if (!packageDir) throw new Error("[build-server-entry] packageDir is required");
  const pkgDir = path.resolve(packageDir);
  const manifestPath = path.join(pkgDir, "package.json");
  const manifestRaw = await readFile(manifestPath, "utf8").catch(() => {
    throw new Error(`[build-server-entry] ${pkgDir}: no readable package.json`);
  });
  const pkg = JSON.parse(manifestRaw);
  const name = typeof pkg.name === "string" ? pkg.name : pkgDir;
  const cinatra = pkg.cinatra && typeof pkg.cinatra === "object" ? pkg.cinatra : null;
  const serverEntry =
    cinatra && typeof cinatra.serverEntry === "string" ? cinatra.serverEntry : null;

  // -- dependency mode (cinatra#181): manifest-declared, CLI-overridable for
  // tests only; absent → "inline" (today's behavior, byte-identical).
  const dependencyMode = resolveDependencyMode(cinatra, mode, name);
  const declaredDependencies = Object.keys(pkg.dependencies ?? {}).sort();
  if (dependencyMode === "closure") {
    assertClosureDependencySpecs(name, pkg.dependencies);
  }

  const packDir = outDir
    ? path.resolve(outDir)
    : path.join(await mkdtemp(path.join(tmpdir(), "cinatra-server-entry-pack-")), "package");

  // -- no serverEntry: verbatim pack dir, nothing to build or rewrite. Legal
  // in BOTH dependency modes (a closure package without a server entry keeps
  // its declared deps; the signed plan alone covers them).
  if (!serverEntry) {
    await copyPackageTree(pkgDir, packDir);
    return {
      mode: "none",
      dependencyMode,
      packDir,
      packageName: name,
      entryRel: null,
      inlinedPackages: [],
      prunedDependencies: [],
      declaredDependencies,
    };
  }

  // -- shared resolution + safety guard (identical semantics to the store).
  const resolution = resolveDeclaredServerEntry(pkg.exports, serverEntry);
  if (resolution.kind !== "resolved") {
    throw new Error(
      `[build-server-entry] ${name}: cinatra.serverEntry "${serverEntry}" is a declared exports key ` +
        `whose target is outside the supported exports forms (an exact key mapping to a "./"-relative ` +
        `string, or a one-level conditional whose import/default/require value is such a string). ` +
        `Fix the exports map — the runtime store refuses this shape too.`,
    );
  }
  const rel = resolution.rel;
  if (entryEscapesPackageDir(rel)) {
    throw new Error(
      `[build-server-entry] ${name}: cinatra.serverEntry "${serverEntry}" resolves to "${rel}" — ` +
        `escapes the package dir (absolute paths and ".." segments are refused, matching the store's rule).`,
    );
  }
  const entryAbs = path.join(pkgDir, rel.replace(/^\.\//, ""));
  const entryStat = await statOrNull(entryAbs);
  if (!entryStat || !entryStat.isFile()) {
    throw new Error(
      `[build-server-entry] ${name}: cinatra.serverEntry "${serverEntry}" resolves to "${rel}" — ` +
        `no such file in the package. The builder needs the build INPUT present.`,
    );
  }

  const cls = classifyServerEntryArtifact(rel);

  // -- already-built entry: pass through verbatim (mode split, design §4.1).
  // NEVER re-bundled — a publisher's built artifact is theirs. In closure
  // dependency mode the entry's import graph is additionally residual-
  // VALIDATED (node builtins / self-references / declared deps only; host
  // peers refused) so a closure passthrough that could never activate fails
  // HERE, at build time, with the same rule the bundle check applies.
  if (cls === "importable") {
    if (dependencyMode === "closure") {
      const esbuild = await loadEsbuild(esbuildDir);
      await validateClosureEntryImports({
        esbuild,
        entryAbs,
        pkgDir,
        packageName: name,
        entryRel: rel,
        declaredDeps: new Set(declaredDependencies),
        selfName: typeof pkg.name === "string" ? pkg.name : null,
        exportsMap: pkg.exports,
      });
    }
    await copyPackageTree(pkgDir, packDir);
    return {
      mode: "passthrough",
      dependencyMode,
      packDir,
      packageName: name,
      entryRel: rel,
      inlinedPackages: [],
      prunedDependencies: [],
      declaredDependencies,
    };
  }

  if (cls !== "source") {
    throw new Error(
      `[build-server-entry] ${name}: cinatra.serverEntry "${serverEntry}" resolves to "${rel}" — ` +
        `neither a built artifact (.mjs/.cjs/.js) nor buildable TypeScript source (.ts/.tsx/.mts/.cts). ` +
        `Declare an exports key targeting the concrete source entry (the in-tree convention is ` +
        `exports["./register"] → "./src/register.ts").`,
    );
  }

  // -- source entry: stage, bundle, rewrite (bundle resolves modules from the
  // SOURCE dir — that is where node_modules/workspace links live — and emits
  // into the staged pack dir).
  await copyPackageTree(pkgDir, packDir);
  const esbuild = await loadEsbuild(esbuildDir);
  // INLINE mode: externals are the host ABI peers ONLY. Everything else
  // reachable from the entry is INLINED: the runtime store provides no module
  // resolution beyond node builtins, so any surviving bare import would fail
  // activation with ENOENT. react/react-dom (declared peers for the UI/static
  // path) are deliberately NOT external — a server-entry graph that reaches
  // them gets their react-server builds inlined, exactly the host RSC layer's
  // view.
  // CLOSURE mode: declared runtime dependencies are ADDITIONALLY external
  // (`dep` + `dep/*` subpaths) — at install time the host materializes them
  // into the store dir's real nested node_modules from the signed
  // materialization plan, so Node's plain file:// resolution finds them.
  const externals = [...HOST_PROVIDED_PEERS];
  if (dependencyMode === "closure") {
    for (const dep of declaredDependencies) externals.push(dep, `${dep}/*`);
  }
  const outfile = path.join(packDir, "register.mjs");
  // HOST-RUNTIME MODULE VIEWS (the explicit build-time-input contract):
  //  - `server-only` is BUILDER-SHIMMED to an empty module — semantically
  //    identical to its `react-server` conditional build (an empty no-op);
  //    it is a marker package and never a build-time input.
  //  - Next has NO `exports` conditions — its server-layer view of
  //    `next/<api>` is produced by COMPILER aliasing (next/<api> →
  //    next/dist/api/<api>.react-server when that build exists). The host
  //    static path compiles serverEntry graphs in that layer, so the builder
  //    mirrors the exact same aliasing, resolving Next FROM THE PACKAGE DIR.
  //    A server graph that imports `next/...` therefore needs `next` (and
  //    whatever it pulls, e.g. react) PROVISIONED as an explicit build-time
  //    input next to the package (a devDependency in a standalone repo; the
  //    workspace root provides it in the monorepo) — when it is not, the
  //    builder fails LOUD with that exact direction instead of an opaque
  //    esbuild resolution error.
  const pkgRequire = createRequire(pathToFileURL(path.join(pkgDir, "noop.js")));
  const hostRuntimeModuleViews = {
    name: "host-runtime-module-views",
    setup(build) {
      build.onResolve({ filter: /^server-only$/ }, () => ({
        path: "server-only",
        namespace: "cinatra-server-only-shim",
      }));
      build.onLoad({ filter: /.*/, namespace: "cinatra-server-only-shim" }, () => ({
        contents: "// `server-only` marker — the react-server build is an empty module.\nexport {};\n",
        loader: "js",
      }));
      build.onResolve({ filter: /^next(\/.+)?$/ }, (args) => {
        const sub = args.path === "next" ? null : args.path.slice("next/".length);
        if (sub) {
          try {
            return { path: pkgRequire.resolve(`next/dist/api/${sub}.react-server.js`) };
          } catch {
            /* no react-server build for this subpath — fall through */
          }
        }
        try {
          return { path: pkgRequire.resolve(args.path) };
        } catch {
          return {
            errors: [
              {
                text:
                  `the server-entry graph imports "${args.path}" but \`next\` is not resolvable from ` +
                  `${pkgDir}. Next is a BUILD-TIME INPUT for server graphs that import it: declare ` +
                  `it as a devDependency (standalone repo) or build inside the workspace that provides it.`,
              },
            ],
          };
        }
      });
    },
  };
  const result = await esbuild.build({
    entryPoints: [entryAbs],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile,
    metafile: true,
    external: externals,
    // Inlined CJS deps `require()` node builtins; esbuild's ESM output guards
    // those calls behind `typeof require !== "undefined"`. Provide a real
    // module-scoped require so builtin requires work under plain Node ESM.
    banner: {
      js:
        'import { createRequire as __cinatraCreateRequire } from "node:module";\n' +
        "const require = __cinatraCreateRequire(import.meta.url);",
    },
    // `server-only` (and friends) carry a `react-server` condition pointing at
    // a server-side no-op; the host's static path compiles serverEntry graphs
    // under the same condition. Without it the default-condition entry THROWS
    // at import time and the built artifact could never activate.
    conditions: ["react-server"],
    plugins: [hostRuntimeModuleViews],
    logLevel: quiet ? "silent" : "warning",
  });

  // -- residual-import check. INLINE mode (byte-identical to the pre-mode
  // builder): a correct server-entry bundle imports NOTHING beyond node
  // builtins — a surviving host-peer/peer import means the source graph
  // value-imports something the host provides per ABI through ctx; the
  // store's host-peer gate would refuse it at install; fail at BUILD time
  // with the same actionable direction. CLOSURE mode: residual externals may
  // additionally be declared runtime dependencies (the signed plan covers
  // them); host peers stay refused.
  const outputKey = Object.keys(result.metafile.outputs).find((k) => k.endsWith("register.mjs"));
  const residualImports = (result.metafile.outputs[outputKey]?.imports ?? []).filter(
    (imp) => imp.external === true,
  );
  if (dependencyMode === "closure") {
    const declaredSet = new Set(declaredDependencies);
    for (const imp of residualImports) {
      const refusal = classifyClosureResidualImport(imp.path, { declaredDeps: declaredSet });
      if (refusal !== null) {
        throw new Error(`[build-server-entry] ${name}: the bundled server entry ${refusal}.`);
      }
    }
  } else {
    const residual = residualImports.filter((imp) => !isNodeBuiltin(imp.path)).map((imp) => imp.path);
    if (residual.length > 0) {
      throw new Error(
        `[build-server-entry] ${name}: the bundled server entry still imports ${residual
          .map((s) => `"${s}"`)
          .join(", ")} at runtime. A publishable server entry may import only node builtins — ` +
          `host-provided peers must stay type-only (take values via ctx capabilities), and every ` +
          `runtime dependency must be inlinable into the bundle.`,
      );
    }
  }

  // -- inlined packages (from the metafile input set) → the pruned-deps record.
  const inlinedPackages = [
    ...new Set(
      Object.keys(result.metafile.inputs)
        .map((p) => packageNameFromInputPath(p))
        .filter((n) => n !== null),
    ),
  ].sort();

  // -- manifest rewrite IN THE PACK DIR ONLY (design §4.1 step 3). INLINE
  // mode prunes `dependencies` (the bundle inlined the whole runtime graph);
  // CLOSURE mode KEEPS the declarations intact — they are the basis of the
  // publish-time signed materialization plan and of the host's relaxed
  // bundled-OR-planned install gate.
  const packedPkg = JSON.parse(manifestRaw);
  packedPkg.cinatra = { ...packedPkg.cinatra, serverEntry: "./register.mjs" };
  let prunedDependencies = [];
  if (dependencyMode !== "closure") {
    prunedDependencies = Object.keys(packedPkg.dependencies ?? {}).sort();
    delete packedPkg.dependencies;
  }
  if (Array.isArray(packedPkg.files) && !packedPkg.files.includes("register.mjs")) {
    packedPkg.files = [...packedPkg.files, "register.mjs"];
  }
  await writeFile(path.join(packDir, "package.json"), `${JSON.stringify(packedPkg, null, 2)}\n`);

  // -- self-check: the PACKED manifest must satisfy the runtime-store contract
  // (mirrors the §4.2 packed-manifest preflight — a builder bug fails HERE,
  // never at a customer's install).
  const packedResolution = resolveDeclaredServerEntry(packedPkg.exports, packedPkg.cinatra.serverEntry);
  if (
    packedResolution.kind !== "resolved" ||
    classifyServerEntryArtifact(packedResolution.rel) !== "importable" ||
    !(await statOrNull(path.join(packDir, packedResolution.rel.replace(/^\.\//, ""))))?.isFile()
  ) {
    throw new Error(
      `[build-server-entry] ${name}: internal error — the packed manifest does not satisfy the ` +
        `built-artifacts-only contract after rewrite. Refusing to emit a non-installable pack dir.`,
    );
  }

  return {
    mode: "bundled",
    dependencyMode,
    packDir,
    packageName: name,
    entryRel: rel,
    inlinedPackages,
    prunedDependencies,
    declaredDependencies,
  };
}

/**
 * CLOSURE-mode passthrough validation (cinatra#181): trace the PREBUILT
 * entry's import graph with esbuild in scan mode (`bundle` + `packages:
 * "external"`, `write: false` — nothing is emitted, the artifact is NEVER
 * re-bundled) and apply the SAME closure residual rule the bundle check
 * applies: every surviving bare import must be a node builtin or a declared
 * runtime dependency; host ABI peers are refused. Relative imports are
 * traversed (a missing local file fails the scan loudly), and SELF-references
 * (`<self>` / `<self>/sub`) are resolved INTO the scanned graph through the
 * pinned exports-map resolver — never blanket-allowed — so a self-referenced
 * file cannot smuggle a host-peer or undeclared import past the scan (review
 * r0 finding 1). An unresolvable self-reference fails the scan loudly.
 *
 * Residual blind spot (shared with every sibling host gate —
 * `parseModuleImports` documents the same class): a VARIABLE-indirected
 * dynamic `import(v)` / `require(v)` / `createRequire(...)(v)` is statically
 * unresolvable and is not represented in the metafile. LITERAL dynamic
 * `import("x")` IS captured (test-pinned). The install-time residual-coverage
 * check and the activation loader share the same static visibility, so the
 * builder neither weakens nor strengthens that boundary.
 *
 * Throws with the offending specifier on the first violation.
 */
async function validateClosureEntryImports({ esbuild, entryAbs, pkgDir, packageName, entryRel, declaredDeps, selfName, exportsMap }) {
  // Self-references resolve INTO the graph through the PINNED resolver
  // semantics (the same exact-key/one-level-conditional language the store
  // and loader apply) — esbuild's own (full-Node) exports resolution must not
  // accept what the runtime store would refuse.
  const selfReferenceTrace = {
    name: "cinatra-closure-self-reference-trace",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!selfName) return undefined;
        const base = basePackageOfSpecifier(args.path);
        if (base !== selfName) return undefined;
        const subpath = args.path === selfName ? "." : `.${args.path.slice(selfName.length)}`;
        const target = resolveExportsSubpath(exportsMap, subpath);
        if (target === null || entryEscapesPackageDir(target)) {
          return {
            errors: [
              {
                text:
                  `self-reference "${args.path}" does not resolve to a safe in-package file through the ` +
                  `pinned exports-map semantics — the runtime store could not resolve it either`,
              },
            ],
          };
        }
        return { path: path.join(pkgDir, target.replace(/^\.\//, "")) };
      });
    },
  };
  let result;
  try {
    result = await esbuild.build({
      entryPoints: [entryAbs],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      write: false,
      metafile: true,
      packages: "external",
      plugins: [selfReferenceTrace],
      logLevel: "silent",
    });
  } catch (err) {
    throw new Error(
      `[build-server-entry] ${packageName}: closure-mode validation could not trace the prebuilt ` +
        `server entry "${entryRel}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imp of output.imports ?? []) {
      if (imp.external !== true) continue;
      const refusal = classifyClosureResidualImport(imp.path, { declaredDeps });
      if (refusal !== null) {
        throw new Error(`[build-server-entry] ${packageName}: the prebuilt server entry "${entryRel}" ${refusal}.`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI shell
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { packageDir: null, out: null, esbuildDir: null, mode: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--esbuild-dir") args.esbuildDir = argv[++i];
    else if (a === "--mode") args.mode = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a.startsWith("--")) throw new Error(`[build-server-entry] unknown flag ${a}`);
    else if (!args.packageDir) args.packageDir = a;
    else throw new Error(`[build-server-entry] unexpected positional ${a}`);
  }
  if (!args.packageDir) {
    throw new Error(
      "usage: node build-server-entry.mjs <packageDir> [--out <packDir>] [--esbuild-dir <dir>] " +
        "[--mode inline|closure] [--json]   (--mode is a TEST-ONLY override of cinatra.dependencyMode)",
    );
  }
  if (args.mode !== null && !DEPENDENCY_MODES.includes(args.mode)) {
    throw new Error(`[build-server-entry] --mode ${args.mode} is not a supported mode (inline|closure)`);
  }
  return args;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await buildServerEntryPack({
      packageDir: args.packageDir,
      outDir: args.out,
      esbuildDir: args.esbuildDir,
      mode: args.mode,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `[build-server-entry] ${result.packageName}: mode=${result.mode} ` +
          `dependencyMode=${result.dependencyMode} packDir=${result.packDir}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
