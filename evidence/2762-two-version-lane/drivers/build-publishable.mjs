// -----------------------------------------------------------------------------
// Turn an IN-TREE extension package into a PUBLISHABLE one.
//
// The in-tree form of an extension is TypeScript source: its `exports` map and
// `cinatra.serverEntry` point at `./src/*.ts`, because inside this monorepo the
// host compiles the package itself. A package installed FROM a registry gets no
// such help — the runtime store refuses a TypeScript entry outright:
//
//   cinatra.serverEntry "./register" resolves to "./src/register.ts" — a
//   TypeScript source entry. The runtime store accepts BUILT artifacts only.
//
// So a lane that wants to install an extension the way an operator really does
// must first produce what a real publisher produces: built ESM, with the export
// map and `cinatra.serverEntry` pointing at the built files.
//
// This script does exactly that, in place, on an already-staged copy:
//   * every `exports` entry that names a `.ts` file is bundled to a sibling
//     `.mjs` at the package root with esbuild;
//   * host-internal SDK peers and the declared runtime dependencies stay
//     EXTERNAL — a bundled second copy of a host peer would break ABI identity,
//     and the runtime dependencies travel as bundled `node_modules` instead;
//   * `exports`, `main` and `cinatra.serverEntry` are rewritten to the built
//     files, and `files` is widened to carry them.
//
// Usage:
//   node build-publishable.mjs <stagedPkgDir>
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error("usage: build-publishable.mjs <stagedPkgDir>");
  process.exit(2);
}

const manifestPath = path.join(pkgDir, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// Anything the package declares as a peer or a runtime dependency stays
// external. Peers are resolved by the HOST at runtime (one instance only);
// runtime dependencies are shipped as bundled `node_modules`.
const external = [
  ...Object.keys(manifest.peerDependencies ?? {}),
  ...Object.keys(manifest.dependencies ?? {}),
];

/** `./src/mcp/module.ts` → `module.mjs`, kept unique across directories. */
const builtNameFor = (subpath, source) => {
  if (subpath === ".") return "index.mjs";
  const base = subpath.replace(/^\.\//, "").replaceAll("/", "-");
  return `${base}.mjs`;
};

const entries = [];
const nextExports = {};
for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
  if (typeof target !== "string" || !target.endsWith(".ts")) {
    nextExports[subpath] = target;
    continue;
  }
  const outFile = builtNameFor(subpath, target);
  entries.push({ in: path.join(pkgDir, target), out: outFile });
  nextExports[subpath] = `./${outFile}`;
}

if (entries.length === 0) {
  console.error("nothing to build — no TypeScript entries in the export map");
  process.exit(0);
}

// `server-only` is a BUILD-TIME guard, not a runtime API: importing it is how a
// package asserts "this module must never reach a client bundle", and the
// package itself exports a module that throws when it is loaded outside a
// server condition. Its import must therefore not survive into a published
// build — a real publisher's build drops it the same way. The package still
// stays declared in `dependencies` and bundled into the tarball, because the
// store reconciles the manifest against what the tarball carries.
const dropServerOnlyGuard = {
  name: "drop-server-only-guard",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^server-only$/ }, () => ({
      path: "server-only",
      namespace: "server-only-guard",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "server-only-guard" }, () => ({
      contents: "",
      loader: "js",
    }));
  },
};

for (const entry of entries) {
  await build({
    plugins: [dropServerOnlyGuard],
    entryPoints: [entry.in],
    outfile: path.join(pkgDir, entry.out),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external,
    logLevel: "warning",
    // Bundle the package's OWN source together (relative imports) and leave
    // every bare specifier as an import. An extension's non-relative imports
    // are either host-provided (the SDK peers, and framework modules the host
    // owns) or its own bundled `node_modules`; inlining a copy of any of them
    // would either break ABI identity or ship a second copy of a host module.
    packages: "external",
  });
}

manifest.exports = nextExports;
if (typeof manifest.main === "string" && manifest.main.endsWith(".ts")) {
  manifest.main = nextExports["."] ?? manifest.main;
}
// `cinatra.serverEntry` names an EXPORT SUBPATH, not a file, so it needs no
// rewrite as long as that subpath now resolves to a built file. It is
// re-asserted here only to fail loudly if the subpath vanished.
const serverEntry = manifest.cinatra?.serverEntry;
if (serverEntry && !nextExports[serverEntry]) {
  console.error(
    `cinatra.serverEntry ${JSON.stringify(serverEntry)} names no export after the build`,
  );
  process.exit(1);
}

const builtFiles = entries.map((e) => e.out);
manifest.files = [...new Set([...(manifest.files ?? []), ...builtFiles])];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.error(`built publishable ESM: ${builtFiles.join(", ")}`);
