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
// Library + CLI:
//   import { buildServerEntryPack } from "./build-server-entry.mjs"
//   node scripts/extensions/build-server-entry.mjs <packageDir> --out <dir> [--json]

import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
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

const NODE_BUILTINS = new Set(builtinModules);

function isNodeBuiltin(specifier) {
  if (specifier.startsWith("node:")) return true;
  const base = specifier.split("/")[0];
  return NODE_BUILTINS.has(base);
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
 *                    node, externals = host ABI peers only, conditions
 *                    ["react-server"] + the next/<api> react-server aliasing
 *                    so the graph gets the same server-layer module views the
 *                    host's RSC compile produces) and rewrite the PACKED
 *                    manifest: `cinatra.serverEntry: "./register.mjs"`,
 *                    `register.mjs` appended to `files`, and `dependencies`
 *                    PRUNED — the bundle inlines the entry's whole runtime
 *                    graph, and the materializer's bundled-deps gate requires
 *                    every remaining `dependencies` entry to ship under
 *                    `node_modules` (which npm pack never includes), so a
 *                    published runtime artifact carries no `dependencies`.
 *                    UI-only deps play no role in the runtime store (UI stays
 *                    host-compiled via the static path — design §4.1).
 *
 * Fail-loud refusals (throws): declared exports key with an out-of-contract
 * target; entry escaping the package dir; entry file missing; extensionless /
 * unknown-extension resolution; a bundle that STILL imports anything beyond
 * node builtins (host peers must be type-only / ctx-resolved; runtime deps
 * must be inlinable).
 *
 * @param {{ packageDir: string, outDir?: string | null, esbuildDir?: string | null, quiet?: boolean }} options
 * @returns {Promise<{ mode: "none" | "passthrough" | "bundled", packDir: string, packageName: string, entryRel: string | null, inlinedPackages: string[], prunedDependencies: string[] }>}
 */
export async function buildServerEntryPack({ packageDir, outDir, esbuildDir, quiet = true } = {}) {
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

  const packDir = outDir
    ? path.resolve(outDir)
    : path.join(await mkdtemp(path.join(tmpdir(), "cinatra-server-entry-pack-")), "package");

  // -- no serverEntry: verbatim pack dir, nothing to build or rewrite.
  if (!serverEntry) {
    await copyPackageTree(pkgDir, packDir);
    return { mode: "none", packDir, packageName: name, entryRel: null, inlinedPackages: [], prunedDependencies: [] };
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
  if (cls === "importable") {
    await copyPackageTree(pkgDir, packDir);
    return { mode: "passthrough", packDir, packageName: name, entryRel: rel, inlinedPackages: [], prunedDependencies: [] };
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
  // Externals are the host ABI peers ONLY. Everything else reachable from the
  // entry is INLINED: the runtime store provides no module resolution beyond
  // node builtins, so any surviving bare import would fail activation with
  // ENOENT. react/react-dom (declared peers for the UI/static path) are
  // deliberately NOT external — a server-entry graph that reaches them gets
  // their react-server builds inlined, exactly the host RSC layer's view.
  const externals = [...HOST_PROVIDED_PEERS];
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

  // -- residual-import check: a correct server-entry bundle imports NOTHING
  // beyond node builtins. A surviving host-peer/peer import means the source
  // graph value-imports something the host provides per ABI through ctx — the
  // store's host-peer gate would refuse it at install; fail at BUILD time
  // with the same actionable direction.
  const outputKey = Object.keys(result.metafile.outputs).find((k) => k.endsWith("register.mjs"));
  const residual = (result.metafile.outputs[outputKey]?.imports ?? [])
    .filter((imp) => imp.external === true && !isNodeBuiltin(imp.path))
    .map((imp) => imp.path);
  if (residual.length > 0) {
    throw new Error(
      `[build-server-entry] ${name}: the bundled server entry still imports ${residual
        .map((s) => `"${s}"`)
        .join(", ")} at runtime. A publishable server entry may import only node builtins — ` +
        `host-provided peers must stay type-only (take values via ctx capabilities), and every ` +
        `runtime dependency must be inlinable into the bundle.`,
    );
  }

  // -- inlined packages (from the metafile input set) → the pruned-deps record.
  const inlinedPackages = [
    ...new Set(
      Object.keys(result.metafile.inputs)
        .map((p) => packageNameFromInputPath(p))
        .filter((n) => n !== null),
    ),
  ].sort();

  // -- manifest rewrite IN THE PACK DIR ONLY (design §4.1 step 3).
  const packedPkg = JSON.parse(manifestRaw);
  packedPkg.cinatra = { ...packedPkg.cinatra, serverEntry: "./register.mjs" };
  const prunedDependencies = Object.keys(packedPkg.dependencies ?? {}).sort();
  delete packedPkg.dependencies;
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
    packDir,
    packageName: name,
    entryRel: rel,
    inlinedPackages,
    prunedDependencies,
  };
}

// ---------------------------------------------------------------------------
// CLI shell
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { packageDir: null, out: null, esbuildDir: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--esbuild-dir") args.esbuildDir = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a.startsWith("--")) throw new Error(`[build-server-entry] unknown flag ${a}`);
    else if (!args.packageDir) args.packageDir = a;
    else throw new Error(`[build-server-entry] unexpected positional ${a}`);
  }
  if (!args.packageDir) {
    throw new Error(
      "usage: node build-server-entry.mjs <packageDir> [--out <packDir>] [--esbuild-dir <dir>] [--json]",
    );
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
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        `[build-server-entry] ${result.packageName}: mode=${result.mode} packDir=${result.packDir}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
