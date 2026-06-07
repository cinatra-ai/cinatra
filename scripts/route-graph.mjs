// route-graph.mjs — deterministic static "first-party graph pressure" analyzer.
//
// WHY: `.next/dev/trace` exposes per-route compile *time*
// (the `compile-path` span keyed by `tags.trigger`) but NO route-keyed module
// count. Turbopack dev-compiles a route's whole reachable module graph on first
// navigation; the size of that first-party graph is what narrowing barrel
// imports shrinks. This script measures that size DETERMINISTICALLY
// (zero variance, no running server) so it can be the PRIMARY acceptance metric.
//
// It is honest about what it is: a STATIC reachable FIRST-PARTY module count. It
// intentionally measures first-party graph pressure — it does NOT claim to mirror
// Turbopack's exact graph (no tree-shaking / "use client" boundary modelling).
// Cut-points: bare specifiers (node_modules), `node:` builtins, and
// `serverExternalPackages` are leaves and are not traversed or counted.
// Traversed + counted: first-party modules under src/**, packages/*/src/**,
// extensions/** — INCLUDING @cinatra-ai/* workspace packages (resolved via the
// root tsconfig `paths`), because those are first-party graph pressure.
//
// Zero dependencies (node: builtins only). Re-run safe; same input → same output.

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
// Canonicalize REPO_ROOT once so the containment guard (isInsideRepoRoot below),
// isFirstParty, and ownerOf all compare against the same PHYSICAL root — robust
// even on systems where the working tree is itself reached via a symlink
// (macOS `/var → /private/var`, etc.). Falls back to the syntactic resolve if
// realpath fails for any reason.
let REPO_ROOT = path.resolve(path.dirname(__filename), "..");
try {
  REPO_ROOT = realpathSync.native(REPO_ROOT);
} catch {
  /* keep the syntactic resolve */
}

// ---------------------------------------------------------------------------
// The LOCKED fixed route set (locked after the baseline; never re-pick "top
// routes" dynamically in later comparisons or the target moves). Each entry is
// the route's own page/route module (layouts are shared chrome and excluded so
// the count isolates the route-specific graph being edited).
// ---------------------------------------------------------------------------
const FIXED_ROUTES = [
  { route: "/sign-in", entry: "src/app/sign-in/page.tsx" },
  { route: "/api/mcp", entry: "src/app/api/mcp/route.ts" },
  { route: "/chat", entry: "src/app/chat/[[...slug]]/page.tsx" },
  { route: "/api/a2a", entry: "src/app/api/a2a/route.ts" },
  { route: "/api/llm-bridge", entry: "src/app/api/llm-bridge/route.ts" },
];

const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

// ---------------------------------------------------------------------------
// JSONC reader (tsconfig.json has comments + path wildcards like "@/*" whose
// "/*" must NOT be mistaken for a block comment — so this is string-aware).
// ---------------------------------------------------------------------------
function stripJsonc(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let inStr = false;
  let q = "";
  let inLine = false;
  let inBlock = false;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === "*" && d === "/") {
        inBlock = false;
        i += 2;
      } else i++;
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += d ?? "";
        i += 2;
        continue;
      }
      if (c === q) inStr = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = true;
      q = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && d === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === "/" && d === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function loadTsPaths() {
  const tc = JSON.parse(stripJsonc(readFileSync(path.join(REPO_ROOT, "tsconfig.json"), "utf8")));
  return (tc.compilerOptions && tc.compilerOptions.paths) || {};
}

function loadServerExternalPackages() {
  // Best-effort parse of the serverExternalPackages array from next.config.ts so
  // the report can name the explicit cut-points. (Functionally redundant — all
  // of them are bare specifiers and are cut as non-first-party regardless.)
  try {
    const src = readFileSync(path.join(REPO_ROOT, "next.config.ts"), "utf8");
    const m = src.match(/serverExternalPackages\s*:\s*\[([\s\S]*?)\]/);
    if (!m) return [];
    return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  } catch {
    return [];
  }
}

const TS_PATHS = loadTsPaths();
const SERVER_EXTERNAL = new Set(loadServerExternalPackages());

// ---------------------------------------------------------------------------
// Module resolution
// ---------------------------------------------------------------------------
// Containment guard — every file path this analyzer ever opens must be inside
// REPO_ROOT, BOTH syntactically (rejecting `../../../etc/passwd`-style traversal
// in tsconfig path values or --routes args) AND physically (rejecting any
// symlink under REPO_ROOT that points outside, via `realpathSync.native()`).
// Returning the realpath also unifies module-dedup keys when the same source
// is reached via different symlinks.
function isInsideRepoRoot(abs) {
  const rel = path.relative(REPO_ROOT, abs);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function acceptInsideRepo(candidate) {
  try {
    const real = realpathSync.native(candidate);
    return isInsideRepoRoot(real) ? real : null;
  } catch {
    return null;
  }
}

function tryFile(abs) {
  const resolved = path.resolve(abs);
  if (!isInsideRepoRoot(resolved)) return null;
  // exact file
  if (existsSync(resolved) && statSync(resolved).isFile()) return acceptInsideRepo(resolved);
  // with extension
  for (const ext of RESOLVE_EXTS) {
    if (existsSync(resolved + ext)) return acceptInsideRepo(resolved + ext);
  }
  // directory index
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    for (const ext of RESOLVE_EXTS) {
      const idx = path.join(resolved, "index" + ext);
      if (existsSync(idx)) return acceptInsideRepo(idx);
    }
  }
  return null;
}

// Resolve a tsconfig path key value (e.g. "./packages/foo/src/index.ts") to abs.
function resolveTsPathValue(value) {
  return tryFile(path.resolve(REPO_ROOT, value));
}

// Read a workspace package's "." entry from its package.json exports/module/main.
function pkgJsonEntry(pkgDir) {
  try {
    const pj = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const exp = pj.exports && (pj.exports["."] ?? pj.exports);
    let cand;
    if (typeof exp === "string") cand = exp;
    else if (exp && typeof exp === "object") cand = exp.import ?? exp.default ?? exp.types ?? exp.require;
    cand = cand ?? pj.module ?? pj.main;
    if (cand) return tryFile(path.resolve(pkgDir, cand));
  } catch {
    /* no package.json or unreadable */
  }
  return null;
}

// Resolve @cinatra-ai/<pkg>[/sub] across the two workspace roots (packages/ and
// extensions/cinatra-ai/), honoring package.json exports for the bare entry.
function resolveWorkspacePkg(pkg, sub) {
  for (const root of [path.join(REPO_ROOT, "packages", pkg), path.join(REPO_ROOT, "extensions", "cinatra-ai", pkg)]) {
    if (!existsSync(root)) continue;
    if (!sub) {
      const entry = pkgJsonEntry(root) || tryFile(path.join(root, "src", "index"));
      if (entry) return entry;
    } else {
      const abs = tryFile(path.join(root, "src", sub)) || tryFile(path.join(root, sub));
      if (abs) return abs;
    }
  }
  return null;
}

// Returns { kind: "first-party"|"external"|"missing", abs?: string }
function resolveSpecifier(spec, importerAbs) {
  if (spec.startsWith("node:")) return { kind: "external" };
  // serverExternalPackages + any exact-prefix external = cut-point (checked early
  // so vendored aliases like @modelcontextprotocol/server are not chased).
  if (SERVER_EXTERNAL.has(spec) || [...SERVER_EXTERNAL].some((e) => spec === e || spec.startsWith(e + "/"))) {
    return { kind: "external" };
  }
  // relative
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const abs = tryFile(path.resolve(path.dirname(importerAbs), spec));
    if (abs) return classify(abs);
    return { kind: "missing" };
  }
  // @/* alias → src/*
  if (spec === "@" || spec.startsWith("@/")) {
    const sub = spec === "@" ? "" : spec.slice(2);
    const abs = tryFile(path.join(REPO_ROOT, "src", sub));
    if (abs) return classify(abs);
    return { kind: "missing" };
  }
  // exact tsconfig path key (covers @cinatra-ai/<pkg> and its enumerated subpaths)
  if (Object.prototype.hasOwnProperty.call(TS_PATHS, spec)) {
    const abs = resolveTsPathValue(TS_PATHS[spec][0]);
    if (abs) return classify(abs);
    return { kind: "missing" };
  }
  // workspace package whose exact subpath isn't enumerated → resolve across
  // packages/ + extensions/cinatra-ai/ via package.json exports / src layout.
  if (spec.startsWith("@cinatra-ai/") || spec.startsWith("@cinatra/")) {
    const rest = spec.replace(/^@cinatra(?:-ai)?\//, ""); // <pkg>/<maybe/sub>
    const seg = rest.split("/");
    const abs = resolveWorkspacePkg(seg[0], seg.slice(1).join("/"));
    if (abs) return classify(abs);
    return { kind: "missing" };
  }
  // anything else → bare specifier (node_modules) = cut-point
  return { kind: "external" };
}

function isFirstParty(abs) {
  const rel = path.relative(REPO_ROOT, abs);
  if (rel.startsWith("..")) return false;
  if (rel === "src" || rel.startsWith("src" + path.sep)) return true;
  if (rel.startsWith("extensions" + path.sep)) return true;
  if (/^packages\/[^/]+\/src\//.test(rel.split(path.sep).join("/"))) return true;
  return false;
}

function classify(abs) {
  return isFirstParty(abs) ? { kind: "first-party", abs } : { kind: "external" };
}

// ---------------------------------------------------------------------------
// Import extraction (string-aware comment strip, then specifier regexes)
// ---------------------------------------------------------------------------
// True only for a named group where every member is `type X` and there is no
// default/namespace binding — the whole statement is type-only and erased.
function isInlineTypeOnly(clause) {
  const c = (clause || "").trim();
  if (!c.startsWith("{")) return false; // default / `* as ns` / bare → has a value binding
  const open = c.indexOf("{");
  const close = c.lastIndexOf("}");
  if (close <= open) return false;
  const members = c.slice(open + 1, close).split(",").map((s) => s.trim()).filter(Boolean);
  if (members.length === 0) return false;
  return members.every((mm) => /^type\s+/.test(mm));
}

function extractSpecifiers(source) {
  const code = stripJsonc(source); // reuse: strips // and /* */ comments, respects strings
  const specs = new Set();
  // import/export <clause> from "y". Skip statements the TS/Turbopack pipeline
  // fully erases (no module compiled), so they don't count as graph pressure:
  //   - statement-level `import type` / `export type` (group "typePrefix")
  //   - inline-only named groups where EVERY member is `type X` and there is no
  //     default/namespace binding, e.g. `export { type A, type B } from "./x"`.
  // A mixed `{ a, type B }` (any value binding) is KEPT (it still pulls "y").
  const fromRe = /\b(?:import|export)\s+(type\s+)?([^'"`;]*?)\bfrom\s*["']([^"']+)["']/g;
  let m;
  while ((m = fromRe.exec(code)) !== null) {
    if (m[1]) continue; // statement-level `import type` / `export type`
    if (isInlineTypeOnly(m[2])) continue; // `{ type A, type B }` only — erased
    specs.add(m[3]);
  }
  const other = [
    /\bimport\s*["']([^"']+)["']/g, // import "y" (side-effect)
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("y")
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require("y")
  ];
  for (const re of other) {
    let x;
    while ((x = re.exec(code)) !== null) specs.add(x[1]);
  }
  return [...specs];
}

// Which workspace package (or "app") does a first-party abs path belong to?
function ownerOf(abs) {
  const rel = path.relative(REPO_ROOT, abs).split(path.sep).join("/");
  let m = rel.match(/^packages\/([^/]+)\/src\//);
  if (m) return `@cinatra-ai/${m[1]}`;
  m = rel.match(/^extensions\/([^/]+)\/([^/]+)\//);
  if (m) return `extensions/${m[1]}/${m[2]}`;
  if (rel.startsWith("src/")) return "(app) src";
  return "(other)";
}

// BFS the first-party reachable graph from a set of entry files.
function reachableFrom(entryAbsList) {
  const visited = new Set();
  const missing = new Set();
  const queue = [...entryAbsList];
  for (const e of entryAbsList) visited.add(e);
  while (queue.length) {
    const cur = queue.shift();
    let source;
    try {
      source = readFileSync(cur, "utf8");
    } catch {
      continue;
    }
    if (cur.endsWith(".json")) continue; // json leaf, no imports to follow
    for (const spec of extractSpecifiers(source)) {
      const r = resolveSpecifier(spec, cur);
      if (r.kind === "missing") {
        missing.add(`${spec} (from ${path.relative(REPO_ROOT, cur)})`);
        continue;
      }
      if (r.kind !== "first-party") continue;
      if (!visited.has(r.abs)) {
        visited.add(r.abs);
        queue.push(r.abs);
      }
    }
  }
  return { visited, missing };
}

function analyzeRoute(entryRel) {
  const entryAbs = tryFile(path.join(REPO_ROOT, entryRel));
  if (!entryAbs) return { ok: false, error: `entry not found: ${entryRel}` };
  const { visited, missing } = reachableFrom([entryAbs]);
  // count excludes the entry itself? Include entry in graph but report both.
  const modules = [...visited];
  const byOwner = {};
  for (const abs of modules) {
    const o = ownerOf(abs);
    byOwner[o] = (byOwner[o] || 0) + 1;
  }
  const workspacePkgs = Object.keys(byOwner)
    .filter((o) => o.startsWith("@cinatra-ai/"))
    .sort();
  return {
    ok: true,
    entry: entryRel,
    moduleCount: modules.length,
    workspacePackageCount: workspacePkgs.length,
    workspacePackages: workspacePkgs,
    byOwner,
    missingCount: missing.size,
    missing: [...missing].slice(0, 25),
  };
}

// ---------------------------------------------------------------------------
// --all: discover every app route entry, rank workspace-package fan-in
// ---------------------------------------------------------------------------
function discoverAppRoutes() {
  const appDir = path.join(REPO_ROOT, "src", "app");
  const out = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (/^(page|route)\.(ts|tsx)$/.test(name)) {
        out.push(path.relative(REPO_ROOT, abs).split(path.sep).join("/"));
      }
    }
  }
  walk(appDir);
  return out.sort();
}

function runAll() {
  const entries = discoverAppRoutes();
  const fanIn = {}; // pkg -> route count
  const perRoute = [];
  for (const entry of entries) {
    const r = analyzeRoute(entry);
    if (!r.ok) continue;
    perRoute.push({ entry, moduleCount: r.moduleCount, workspacePackageCount: r.workspacePackageCount });
    for (const p of r.workspacePackages) fanIn[p] = (fanIn[p] || 0) + 1;
  }
  perRoute.sort((a, b) => b.moduleCount - a.moduleCount);
  const fanInSorted = Object.entries(fanIn).sort((a, b) => b[1] - a[1]);
  return { routeCount: perRoute.length, perRoute, fanIn: fanInSorted };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { all: false, routes: null, out: null, json: null, md: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--all") a.all = true;
    else if (x === "--routes") a.routes = argv[++i];
    else if (x === "--out") a.out = argv[++i];
    else if (x === "--json") a.json = argv[++i];
    else if (x === "--md") a.md = argv[++i];
    else if (x === "--help" || x === "-h") a.help = true;
  }
  return a;
}

function usage() {
  console.log(`route-graph.mjs — deterministic static first-party graph-pressure analyzer

Usage:
  node scripts/route-graph.mjs                 analyze the LOCKED fixed route set
  node scripts/route-graph.mjs --routes a,b    analyze ad-hoc routes (entry paths or known route labels)
  node scripts/route-graph.mjs --all           rank workspace-package fan-in across ALL app routes
  --out <dir>    write route-graph.json + route-graph.md to <dir>
  --json <path>  --md <path>   explicit output paths
  --help

Metric: count of distinct reachable FIRST-PARTY modules (src/**, packages/*/src/**,
extensions/**) from a route's own page/route entry. Cut-points: node_modules,
node: builtins, serverExternalPackages. @cinatra-ai/* workspace packages ARE traversed.

Known limitations (documented):
  - No tree-shaking / "use client" boundary modelling (this is a STATIC reachable
    first-party module count, not Turbopack's exact compiled graph).
  - Regex-based import extraction: literal "import 'x'" strings inside source
    code, or a hyphen-prefixed token like "re-import 'x'" (e.g. inside a comment
    or template string that survived comment-stripping) could match as a
    specifier. Vanishingly rare in this codebase; bare specifiers resolve to
    EXTERNAL and are silently dropped, so the realistic impact is bounded.`);
}

function fixedRouteEntry(token) {
  const known = FIXED_ROUTES.find((r) => r.route === token || r.entry === token);
  if (known) return { route: known.route, entry: known.entry };
  return { route: token, entry: token };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  let result;
  if (args.all) {
    // No timestamp in the persisted artifact: same input → byte-identical output.
    result = { mode: "all", repoRoot: REPO_ROOT, ...runAll() };
  } else {
    const routeTokens = args.routes ? args.routes.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const targets = routeTokens ? routeTokens.map(fixedRouteEntry) : FIXED_ROUTES;
    const routes = targets.map((t) => ({ route: t.route, ...analyzeRoute(t.entry) }));
    result = { mode: "routes", repoRoot: REPO_ROOT, routes };
  }

  const md = renderMd(result);
  console.log(md);

  const outDir = args.out || null;
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
  }
  const jsonPath = args.json || (outDir ? path.join(outDir, "route-graph.json") : null);
  const mdPath = args.md || (outDir ? path.join(outDir, "route-graph.md") : null);
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  if (mdPath) writeFileSync(mdPath, md);
}

function renderMd(result) {
  const lines = [];
  if (result.mode === "all") {
    lines.push(`# Route-graph fan-in (all ${result.routeCount} app routes)`);
    lines.push("");
    lines.push("");
    lines.push("## Workspace-package fan-in (routes whose graph reaches the package)");
    lines.push("");
    lines.push("| Package | Routes reaching it |");
    lines.push("|---|---|");
    for (const [p, c] of result.fanIn) lines.push(`| ${p} | ${c} |`);
    lines.push("");
    lines.push("## Top 15 routes by reachable first-party module count");
    lines.push("");
    lines.push("| Route entry | Modules | Workspace pkgs |");
    lines.push("|---|---|---|");
    for (const r of result.perRoute.slice(0, 15)) lines.push(`| ${r.entry} | ${r.moduleCount} | ${r.workspacePackageCount} |`);
  } else {
    lines.push("# Route-graph (static first-party reachable-module count)");
    lines.push("");
    lines.push("");
    lines.push("| Route | Entry | Modules | Workspace pkgs | Missing |");
    lines.push("|---|---|---|---|---|");
    for (const r of result.routes) {
      if (!r.ok) {
        lines.push(`| ${r.route} | — | ERROR | — | ${r.error} |`);
        continue;
      }
      lines.push(`| ${r.route} | ${r.entry} | ${r.moduleCount} | ${r.workspacePackageCount} | ${r.missingCount} |`);
    }
    for (const r of result.routes) {
      if (!r.ok) continue;
      lines.push("");
      lines.push(`### ${r.route} — ${r.moduleCount} modules`);
      const top = Object.entries(r.byOwner).sort((a, b) => b[1] - a[1]).slice(0, 18);
      lines.push("");
      lines.push("| Owner | Modules |");
      lines.push("|---|---|");
      for (const [o, c] of top) lines.push(`| ${o} | ${c} |`);
    }
  }
  return lines.join("\n");
}

main();
