#!/usr/bin/env node
// THE DESIGN SUITE SELECTOR.
//
// The ruling this encodes: the design Playwright suite must check only the
// specific design spec of what was implemented, and must not run at all on a
// change that implements or changes no UI.
//
// Both halves are decided HERE, in front of Playwright, from the diff:
//
//   * NO UI            -> print "no UI change in <n> files — skipped" and exit
//                         0 WITHOUT starting Playwright.
//   * A NARROW CHANGE  -> run only the spec families whose own static graph
//                         (the spec file, the design-fixture route pages it
//                         drives, and everything those import, transitively)
//                         contains a changed file.
//   * A GLOBAL CHANGE  -> run every family, exactly as the suite runs today.
//
// A FALSE NEGATIVE — a family the diff really touches, not run — is the only
// unacceptable error, so every uncertainty widens to the whole suite:
//
//   * the branch is main, the event is a push / dispatch / merge group,
//   * the diff base does not resolve (a fetch-depth misconfiguration) or git
//     fails at all,
//   * an in-repo import inside a family's graph does not resolve (then the
//     graph is not trustworthy and NOTHING is judged against it, not even a
//     documentation-only diff),
//   * a shared primitive, a workspace-package source file, a stylesheet, a
//     token/theme file, a dependency, an app layout, a pinned conformance
//     manifest, the suite config, the generated extension manifest, or this
//     selector itself changed,
//   * DESIGN_SELECT=all is set (the documented override).
//
// The base-resolution road is the one the sibling design-pin gates already
// take (DESIGN_PIN_DRIFT_DIFF_BASE there, DESIGN_SELECT_DIFF_BASE here): verify
// the base resolves in THIS checkout, fetch it once if the checkout is shallow,
// and never diff against nothing.
//
// What this selector does NOT do: it never touches a pin gate. The pin
// freshness / drift / testid / ratchet gates are separate steps and separate
// jobs; narrowing the Playwright invocation cannot bypass one of them.
//
// Dependency-free (node builtins only) so a pure-node job runs it without an
// install. Its IO and its git are injectable so the unit suite can exercise the
// graph walk over a virtual repo.
//
// Usage:
//   node scripts/ci/design-select.mjs             # print the plan (dry run)
//   node scripts/ci/design-select.mjs --run       # run Playwright on the plan
//   node scripts/ci/design-select.mjs --out f.json
//   node scripts/ci/design-select.mjs --changed src/app/x.tsx   # dry run only
//   DESIGN_SELECT=all node scripts/ci/design-select.mjs --run

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DESIGN_SUITE_DIR = "tests/e2e/design";
const DESIGN_CONFIG = "tests/e2e/config/design.config.ts";
const FIXTURE_ROUTE_ROOT = "/design-fixtures";
const API_ROUTE_ROOT = "/api";
const ROUTE_LITERAL_PREFIXES = [FIXTURE_ROUTE_ROOT, API_ROUTE_ROOT];
const ROUTE_LEAF_NAMES = ["page", "route"];
const ROUTE_LEAF_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"];
const APP_DIR = "src/app";
const ROUTE_SUBTREE_DEPTH = 3;

// Aliases are READ from tsconfig.json, never assumed. "@/" is src/, but the
// workspace aliases matter too: packages/*/src modules import "@/..." back
// into src/, so a fixture that reaches src/lib/x.ts only through a workspace
// package would otherwise be invisible and a change to that helper would be
// classed "no UI". A tsconfig that cannot be read or parsed makes the graph
// untrustworthy (the caller widens); it never silently degrades to "@/" only.
const FALLBACK_ALIASES = { prefixes: [["@/", "src/"]], exact: new Map(), failed: null };
const TSCONFIG = "tsconfig.json";

/**
 * Comments and trailing commas out of a JSONC document. A CHARACTER scan, not a
 * regex: tsconfig carries end-of-line comments after a value, and a regex that
 * ignores string context would corrupt a path containing "//".
 */
export function stripJsonc(source) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
      out += source.slice(index, Math.min(end + 1, source.length));
      index = end + 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    out += char;
    index += 1;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** tsconfig "paths" as {prefixes:[[from,to]], exact:Map, failed:string|null}. */
export function parseAliases(source) {
  if (source == null) return { ...FALLBACK_ALIASES, failed: `${TSCONFIG} could not be read` };
  let paths;
  try {
    paths = JSON.parse(stripJsonc(source))?.compilerOptions?.paths ?? {};
  } catch (error) {
    return { ...FALLBACK_ALIASES, failed: `${TSCONFIG} could not be parsed (${error.message})` };
  }
  const prefixes = [];
  const exact = new Map();
  for (const [key, targets] of Object.entries(paths)) {
    const target = Array.isArray(targets) ? targets[0] : targets;
    if (typeof target !== "string") continue;
    const clean = target.replace(/^\.\//, "");
    if (key.endsWith("/*") && clean.endsWith("/*")) prefixes.push([key.slice(0, -1), clean.slice(0, -1)]);
    else if (!key.includes("*")) exact.set(key, clean);
  }
  if (!prefixes.some(([from]) => from === "@/")) prefixes.push(["@/", "src/"]);
  // Longest prefix first, so "@cinatra-ai/x/" beats a shorter overlapping one.
  prefixes.sort((a, b) => b[0].length - a[0].length);
  return { prefixes, exact, failed: null };
}

const aliasCache = new WeakMap();
export function aliasesFor(io) {
  if (!aliasCache.has(io)) aliasCache.set(io, parseAliases(io.read(TSCONFIG)));
  return aliasCache.get(io);
}

const RESOLVE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".svg",
];

/**
 * One widening rule: an id, the sentence the selector prints, and the predicate
 * that decides whether the rule applies to a changed path.
 *
 * @typedef {{id: string, why: string, applies: (path: string) => boolean}} WideningRule
 */

/**
 * A changed file in any of these classes cannot be attributed to a subset of
 * families, so it runs the whole suite. Each rule carries the sentence the
 * selector prints, because a widening decision the reader cannot check is a
 * decision the reader cannot trust.
 *
 * @type {WideningRule[]}
 */
export const WIDENING_RULES = [
  {
    id: "shared-primitive",
    why: "a shared primitive under src/components/ can render on any surface",
    applies: (p) => p.startsWith("src/components/"),
  },
  {
    id: "workspace-package",
    why: "a workspace package under packages/*/src/ can render on any surface",
    applies: (p) => /^packages\/[^/]+\/src\//.test(p),
  },
  {
    id: "global-style",
    why: "a stylesheet can restyle any surface",
    applies: (p) => p.endsWith(".css"),
  },
  {
    id: "app-layout",
    why: "an app layout wraps every route it encloses",
    applies: (p) => /^src\/app\/(?:.*\/)?layout\.tsx$/.test(p),
  },
  {
    id: "dependency",
    why: "a dependency change can change how anything renders",
    applies: (p) => p === "package.json" || p === "pnpm-lock.yaml" || p === "pnpm-workspace.yaml",
  },
  {
    id: "generated-extension-manifest",
    why: "the generated extension manifest changes what the app mounts",
    applies: (p) =>
      p.startsWith("src/lib/generated/") ||
      p === "cinatra-dev-extensions.lock.json" ||
      p === "cinatra-required-extensions.lock.json",
  },
  {
    id: "design-pin",
    why: "a pinned conformance manifest, allowlist or contract governs every surface",
    applies: (p) =>
      p.startsWith(`${DESIGN_SUITE_DIR}/conformance/manifests/`) ||
      p === `${DESIGN_SUITE_DIR}/conformance/allowlist.json` ||
      p === `${DESIGN_SUITE_DIR}/conformance/testid-contract.json` ||
      p === `${DESIGN_SUITE_DIR}/conformance/surface-readiness.json` ||
      p === `${DESIGN_SUITE_DIR}/conformance-pins.json`,
  },
  {
    id: "suite-config",
    why: "the suite or build configuration changes how every family runs",
    applies: (p) =>
      p.startsWith("tests/e2e/config/") ||
      p === "tsconfig.json" ||
      p === "components.json" ||
      /^(?:next|tailwind|postcss|playwright)\.config\.[cm]?[jt]s$/.test(p),
  },
  {
    id: "selector",
    why: "the selection logic itself changed, so it must not narrow its own proof",
    applies: (p) => p === "scripts/ci/design-select.mjs",
  },
];

/**
 * Widening reason for a changed path, or null.
 *
 * @param {string} path
 * @returns {WideningRule | null}
 */
export function wideningRuleFor(path) {
  return WIDENING_RULES.find((rule) => rule.applies(path)) ?? null;
}

/**
 * Paths that COUNT AS UI even when no family's graph reaches them. A file the
 * graph reaches is UI by construction; this list only decides the "is there any
 * UI in this diff at all" question for files outside every graph.
 */
export function isUiPath(path) {
  if (wideningRuleFor(path)) return true;
  if (path.startsWith(`${APP_DIR}/`)) return true;
  if (path.startsWith(`${DESIGN_SUITE_DIR}/`)) return true;
  return false;
}

const defaultIo = {
  read: (rel) => {
    try {
      return readFileSync(join(REPO_ROOT, rel), "utf8");
    } catch {
      return null;
    }
  },
  exists: (rel) => existsSync(join(REPO_ROOT, rel)),
  list: (rel) => {
    try {
      return readdirSync(join(REPO_ROOT, rel), { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      }));
    } catch {
      return [];
    }
  },
};

const defaultGit = (args) =>
  execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Comments out. A block comment that SHOWS an import (this repo has several,
 * e.g. a comment explaining a literal `import("...")` emission site) is not an
 * edge. The stripper is a regex, not a lexer, so it can also eat a real line
 * that merely CONTAINS a comment marker inside a string — which is why the
 * scan below reads the original source too and only ever uses the stripped
 * text to decide whether an UNRESOLVED specifier came from code or from prose.
 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, "");
}

const SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /^[ \t]*import\s+["']([^"']+)["']/gm,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

const scanSpecifiers = (text) => {
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of text.matchAll(pattern)) found.add(match[1]);
  }
  return found;
};

/** Prose that only LOOKS like a specifier: an ellipsis, a gloss, a placeholder. */
const isPlaceholder = (specifier) =>
  /\.{3}/.test(specifier) || /\s/.test(specifier) || specifier.includes("<");

/**
 * Every import/require/dynamic-import specifier in a source file, each marked
 * with whether it was still there after the comments came out. Nothing the
 * original source contains is ever dropped (a missed edge is the unacceptable
 * error); the mark only decides whether an unresolvable one poisons the graph.
 */
export function importSpecifiers(source) {
  const inCode = scanSpecifiers(stripComments(source));
  // The union: the raw scan keeps an import the regex stripper would have eaten,
  // and the stripped scan keeps one the raw scan cannot see because a comment
  // sits inside the statement (`import { X } from /* why */ "@/lib/x"`).
  return [...new Set([...scanSpecifiers(source), ...inCode])].map((specifier) => ({
    specifier,
    inCode: inCode.has(specifier),
  }));
}

/**
 * Route literals a family drives by URL rather than by import: the fixture
 * routes themselves and the API routes those pages and drivers call (the
 * conformance harness seeds over one). Query and fragment stripped.
 */
export function routeLiterals(source) {
  const found = new Set();
  for (const match of source.matchAll(/["'`](\/[A-Za-z0-9._\-[\]/]*)/g)) {
    const route = match[1].split("?")[0].split("#")[0].replace(/\/+$/, "");
    if (ROUTE_LITERAL_PREFIXES.some((prefix) => route === prefix || route.startsWith(`${prefix}/`))) {
      found.add(route);
    }
  }
  return [...found];
}

const joinRelative = (fromFile, specifier) => {
  const parts = dirname(fromFile).split("/").filter(Boolean);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
};

const resolveCandidate = (base, io) => {
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (candidate.endsWith("/")) continue;
    if (io.exists(candidate) && io.read(candidate) !== null) return candidate;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    if (ext === "") continue;
    const candidate = `${base}/index${ext}`;
    if (io.exists(candidate)) return candidate;
  }
  return null;
};

/**
 * Resolve one import specifier to a repo-relative file.
 * Returns {kind:"file"|"external"|"unresolved"}. An unresolved IN-REPO import
 * (relative or "@/") is never silently dropped — it fails the whole selection
 * open to the full suite.
 */
export function resolveSpecifier(specifier, fromFile, { io, aliases = aliasesFor(io) }) {
  const clean = specifier.split("?")[0];
  if (clean === "") return { kind: "external" };
  let base = null;
  if (clean.startsWith(".")) base = joinRelative(fromFile, clean);
  else if (aliases.exact.has(clean)) base = aliases.exact.get(clean);
  else {
    const alias = aliases.prefixes.find(([prefix]) => clean.startsWith(prefix));
    if (alias) base = `${alias[1]}${clean.slice(alias[0].length)}`;
  }
  if (base === null) return { kind: "external" };
  const file = resolveCandidate(base, io);
  return file ? { kind: "file", file } : { kind: "unresolved" };
}

/** The route page (and the layouts above it) a /design-fixtures route renders. */
const leavesIn = (dir, io, names = ROUTE_LEAF_NAMES) => {
  const files = [];
  for (const name of names) {
    for (const ext of ROUTE_LEAF_EXTENSIONS) {
      if (io.exists(`${dir}/${name}${ext}`)) files.push(`${dir}/${name}${ext}`);
    }
  }
  return files;
};

/** Every route/page implementation below a directory, dynamic segments included. */
const leavesBelow = (dir, io, depth = 0) => {
  const files = [];
  for (const entry of io.list?.(dir) ?? []) {
    if (!entry.directory) continue;
    const child = `${dir}/${entry.name}`;
    files.push(...leavesIn(child, io));
    if (depth < ROUTE_SUBTREE_DEPTH) files.push(...leavesBelow(child, io, depth + 1));
  }
  return files;
};

export function routeFiles(route, io) {
  const segments = route.split("/").filter(Boolean);
  const files = [];
  // Depth 0 is src/app itself: the ROOT layout wraps every route, and the modules
  // it imports (the providers, the theme) render on every fixture page.
  for (let depth = 0; depth <= segments.length; depth += 1) {
    const dir = [APP_DIR, ...segments.slice(0, depth)].join("/");
    for (const ext of ROUTE_LEAF_EXTENSIONS) {
      if (io.exists(`${dir}/layout${ext}`)) files.push(`${dir}/layout${ext}`);
    }
  }
  const dir = [APP_DIR, ...segments].join("/");
  // page.* for a rendered route, route.* for an endpoint a family calls — every
  // extension the app router accepts, not a hand-picked three.
  const exact = leavesIn(dir, io);
  files.push(...exact);
  // A URL built from a template truncates to its literal prefix (`/api/things/
  // ${id}` -> "/api/things"), so the implementation sits BELOW this directory in
  // a dynamic segment. When the prefix itself has no leaf, take every leaf
  // beneath it — over-selection is the safe direction, silence is not.
  // Only below a route that is already specific: enumerating a ROOT ("/api",
  // "/design-fixtures") would put every page in every family and narrow nothing.
  // A root literal is handled instead by routeCovers on the changed file itself,
  // and by the fixture-route fallback that widens for an unimported fixture file.
  if (exact.length === 0 && segments.length >= 2) files.push(...leavesBelow(dir, io));
  return files;
}

/**
 * One family per spec file: the set of repo files that family can render.
 * Seeded with the spec file, grown through its imports and through the
 * /design-fixtures route pages named anywhere in the growing set (a spec
 * navigates by URL, not by import, so the route literal IS the edge).
 */
export function buildFamilies({ specFiles, io = defaultIo }) {
  const families = new Map();
  const familyRoutes = new Map();
  const unresolved = [];
  const aliases = aliasesFor(io);
  if (aliases.failed) unresolved.push({ from: TSCONFIG, specifier: aliases.failed });
  for (const spec of specFiles) {
    const seen = new Set();
    const routes = new Set();
    const queue = [spec];
    while (queue.length > 0) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const source = io.read(file);
      if (source == null) continue;
      for (const { specifier, inCode } of importSpecifiers(source)) {
        const resolved = resolveSpecifier(specifier, file, { io, aliases });
        if (resolved.kind === "file") queue.push(resolved.file);
        else if (resolved.kind === "unresolved" && inCode && !isPlaceholder(specifier)) {
          unresolved.push({ from: file, specifier });
        }
      }
      for (const route of routeLiterals(source)) {
        routes.add(route);
        for (const routeFile of routeFiles(route, io)) queue.push(routeFile);
      }
    }
    families.set(spec, seen);
    familyRoutes.set(spec, routes);
  }
  return { families, routes: familyRoutes, unresolved };
}

/**
 * The app route a changed file lives on: src/app/api/things/[id]/route.ts is
 * "/api/things/[id]". Route groups "(x)" and parallel slots "@x" are not URL
 * segments and drop out.
 */
export function appRoutePath(path) {
  if (!path.startsWith(`${APP_DIR}/`)) return null;
  const parts = path.slice(APP_DIR.length + 1).split("/");
  parts.pop();
  const segments = parts.filter(
    (segment) => !(segment.startsWith("(") && segment.endsWith(")")) && !segment.startsWith("@"),
  );
  return `/${segments.join("/")}`;
}

/** Does a route literal a family drives cover the route a changed file is on? */
export function routeCovers(literal, route) {
  return route === literal || route.startsWith(`${literal}/`);
}

/**
 * The specs that own a suite file the import graph cannot see (a corpus, a
 * golden, an asset read at runtime): every spec under the NEAREST enclosing
 * directory that has one. Directories above the suite root are not "nearest" —
 * a file that lands there is nobody's, and the caller widens instead.
 */
export function specsUnderNearestDir(path, specs) {
  let dir = path.slice(0, path.lastIndexOf("/"));
  while (dir.length > DESIGN_SUITE_DIR.length) {
    const local = specs.filter((spec) => spec.startsWith(`${dir}/`));
    if (local.length > 0) return local;
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
  return [];
}

const allResult = (families, summary) => ({
  mode: "all",
  specs: [...families.keys()],
  reasons: [],
  summary,
});

/**
 * The decision. `changedFiles` are repo-relative paths from the diff.
 * mode "all" | "subset" | "none"; "none" means Playwright must not start.
 */
export function selectFamilies({ changedFiles, families, routes = new Map(), unresolved = [] }) {
  // An unresolved in-repo import means the walk does not know where that edge
  // went — so it cannot know that ANY changed file is outside the graph, not
  // even a documentation-only one. An untrustworthy graph widens first and
  // asks no further questions.
  if (unresolved.length > 0) {
    const first = unresolved[0];
    return allResult(
      families,
      `design suite: running ALL families — the import "${first.specifier}" in ${first.from} ` +
        `could not be resolved, so the graph is not trustworthy`,
    );
  }

  const inAnyFamily = (path) => [...families.values()].some((files) => files.has(path));
  const uiFiles = changedFiles.filter((path) => isUiPath(path) || inAnyFamily(path));
  if (uiFiles.length === 0) {
    return {
      mode: "none",
      specs: [],
      reasons: [],
      summary: `design suite: no UI change in ${changedFiles.length} files — skipped`,
    };
  }

  for (const path of uiFiles) {
    const rule = wideningRuleFor(path);
    if (rule) {
      return allResult(families, `design suite: running ALL families — ${path}: ${rule.why}`);
    }
  }

  const picked = new Map();
  const pick = (spec, because) => {
    if (!picked.has(spec)) picked.set(spec, because);
  };
  for (const path of uiFiles) {
    let matched = false;
    for (const [spec, files] of families) {
      if (files.has(path)) {
        pick(spec, path);
        matched = true;
      }
    }
    // NOT "continue" on a match: family A can reach this file by import while
    // family B reaches the same file only by URL. Both must be picked.
    // The graph walks IMPORTS; a family also reaches a route by URL, and a URL
    // built from a template (`/api/things/${id}`) truncates to its literal
    // prefix. So a changed app file whose own route sits under a route literal
    // a family drives belongs to that family, dynamic segment or not.
    const route = appRoutePath(path);
    if (route) {
      for (const [spec, driven] of routes) {
        if ([...driven].some((literal) => routeCovers(literal, route))) {
          pick(spec, path);
          matched = true;
        }
      }
    }
    if (matched) continue;
    // A file the graph cannot reach but that still belongs to the suite: a
    // corpus/golden/asset read at RUNTIME, not imported. Locality decides —
    // every spec at or below its own directory — and a file with no spec below
    // it, or a fixture-route asset, widens rather than disappears.
    if (path.startsWith(`${DESIGN_SUITE_DIR}/`)) {
      const local = specsUnderNearestDir(path, [...families.keys()]);
      if (local.length === 0) {
        return allResult(
          families,
          `design suite: running ALL families — ${path} is in the suite but no family imports it ` +
            `and no spec sits under its own directory`,
        );
      }
      for (const spec of local) pick(spec, path);
      continue;
    }
    if (path.startsWith(`${APP_DIR}/design-fixtures/`)) {
      return allResult(
        families,
        `design suite: running ALL families — ${path} is a fixture-route file no family imports`,
      );
    }
  }

  const reasons = [...families.keys()]
    .filter((spec) => picked.has(spec))
    .map((spec) => ({ family: spec, because: picked.get(spec) }));
  if (reasons.length === 0) {
    const noun = uiFiles.length === 1 ? "file" : "files";
    return {
      mode: "none",
      specs: [],
      reasons: [],
      summary:
        `design suite: ${uiFiles.length} changed UI ${noun}, but no design family renders ` +
        `${uiFiles.length === 1 ? "it" : "any of them"} — skipped`,
    };
  }
  return {
    mode: "subset",
    specs: reasons.map((reason) => reason.family),
    reasons,
    summary: `design suite: ${reasons.length} of ${families.size} spec families selected`,
  };
}

const MAIN_REFS = new Set(["main", "refs/heads/main"]);
const ALWAYS_ALL_EVENTS = new Set(["push", "workflow_dispatch", "schedule", "merge_group"]);

/**
 * The diff to classify. Returns {mode:"all", reason} whenever the diff cannot
 * be computed honestly, and {mode:"diff", files, reason} otherwise.
 */
export function resolveChangedFiles({ env = process.env, git = defaultGit } = {}) {
  if ((env.DESIGN_SELECT ?? "").trim() === "all") {
    return { mode: "all", files: [], reason: "DESIGN_SELECT=all (documented override)" };
  }
  // A refresh run rewrites baselines/goldens: it must see every family, or it
  // would leave the families it skipped stale.
  const refresh = ["RENDER_PARITY_UPDATE", "RENDER_PARITY_VISUAL"].find(
    (name) => (env[name] ?? "").trim() !== "",
  );
  if (refresh) {
    return { mode: "all", files: [], reason: `${refresh} is set (a golden refresh run)` };
  }
  const ref = env.GITHUB_REF_NAME ?? env.GITHUB_REF ?? "";
  if (MAIN_REFS.has(ref)) {
    return { mode: "all", files: [], reason: "the ref is main" };
  }
  const event = env.GITHUB_EVENT_NAME ?? "";
  if (ALWAYS_ALL_EVENTS.has(event)) {
    return { mode: "all", files: [], reason: `the event is ${event}` };
  }

  const configured = (env.DESIGN_SELECT_DIFF_BASE ?? "").trim();
  const baseBranch = (env.GITHUB_BASE_REF ?? "").trim() || "main";
  const base = configured || `origin/${baseBranch}`;

  const resolves = () => {
    try {
      git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  };

  try {
    if (!resolves()) {
      try {
        git(["fetch", "--no-tags", "--depth=200", "origin", baseBranch]);
      } catch {
        /* a shallow-fetch failure is not fatal on its own — the recheck decides */
      }
      if (!resolves()) {
        return {
          mode: "all",
          files: [],
          reason: `the diff base ${base} does not resolve in this checkout`,
        };
      }
    }
    const mergeBase = git(["merge-base", base, "HEAD"]).trim();
    if (mergeBase === "") {
      return { mode: "all", files: [], reason: `no merge base with ${base}` };
    }
    const files = new Set(
      git(["diff", "--name-only", mergeBase, "HEAD"])
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
    if (!env.CI) {
      // A local dry run should judge the working tree the developer actually
      // has, not only what is committed.
      for (const line of git(["status", "--porcelain"]).split("\n")) {
        const path = line.slice(3).trim();
        if (path) files.add(path.includes(" -> ") ? path.split(" -> ")[1] : path);
      }
    }
    return { mode: "diff", files: [...files], reason: `diff against ${base} (${mergeBase})` };
  } catch (error) {
    return { mode: "all", files: [], reason: `git could not compute the diff (${error.message})` };
  }
}

/** Every spec file in the design suite, sorted — one family each. */
export function discoverSpecFiles({ io = defaultIo, root = DESIGN_SUITE_DIR } = {}) {
  const specs = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(REPO_ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith("__")) continue;
        walk(rel);
      } else if (entry.name.endsWith(".spec.ts")) {
        specs.push(rel);
      }
    }
  };
  walk(root);
  void io;
  return specs;
}

/**
 * The Playwright invocation for a selection: the whole suite carries no file
 * filter (identical to the command this script replaced), a subset carries the
 * selected spec paths as positional filters.
 */
export function playwrightArgs(result) {
  return ["test", "-c", DESIGN_CONFIG, ...(result.mode === "all" ? [] : result.specs)];
}

function printPlan(result, diff) {
  console.log(result.summary);
  console.log(`  diff: ${diff.reason}`);
  for (const reason of result.reasons) {
    console.log(`  ${reason.family}  <-  ${reason.because}`);
  }
  if (result.mode === "all") {
    console.log(`  ${result.specs.length} families will run`);
  }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const shouldRun = argv.includes("--run");
  const outIndex = argv.indexOf("--out");
  const outPath = outIndex >= 0 ? argv[outIndex + 1] : null;
  // A dry-run aid: classify a hypothetical change list instead of the real
  // diff, so the selection can be shown for a change that is not checked out.
  // Never honoured together with --run, which must judge the real diff.
  const changedIndex = argv.indexOf("--changed");
  const hypothetical =
    changedIndex >= 0 && !shouldRun
      ? (argv[changedIndex + 1] ?? "").split(",").map((p) => p.trim()).filter(Boolean)
      : null;

  const specFiles = discoverSpecFiles();
  const { families, routes, unresolved } = buildFamilies({ specFiles });
  const diff = hypothetical
    ? { mode: "diff", files: hypothetical, reason: `--changed ${hypothetical.join(" ")}` }
    : resolveChangedFiles({ env });
  const result =
    diff.mode === "all"
      ? allResult(families, `design suite: running ALL families — ${diff.reason}`)
      : selectFamilies({ changedFiles: diff.files, families, routes, unresolved });

  printPlan(result, diff);

  if (outPath) {
    mkdirSync(dirname(resolve(REPO_ROOT, outPath)), { recursive: true });
    writeFileSync(
      resolve(REPO_ROOT, outPath),
      `${JSON.stringify({ ...result, diff: { mode: diff.mode, reason: diff.reason } }, null, 2)}\n`,
    );
  }

  if (!shouldRun) return 0;
  if (result.mode === "none") return 0;

  const args = playwrightArgs(result);
  console.log(`  playwright ${args.join(" ")}`);
  const local = join(REPO_ROOT, "node_modules", ".bin", "playwright");
  const bin = existsSync(local) ? local : "playwright";
  const run = spawnSync(bin, args, { cwd: REPO_ROOT, stdio: "inherit", env: process.env });
  if (run.error) {
    console.error(`design suite: could not start playwright (${run.error.message})`);
    return 1;
  }
  return run.status ?? 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main();
