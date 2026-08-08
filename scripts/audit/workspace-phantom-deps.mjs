#!/usr/bin/env node
/**
 * Workspace phantom-dependency gate (no-new-rot ratchet).
 *
 * A "phantom dependency" is a source import of a package that the importer's
 * own `package.json` does NOT declare in any dependency bucket. It resolves
 * today only via pnpm's hoisted `node_modules` (+ tsconfig path aliases for
 * the first-party case), so it is invisible to `tsgo`/`next build` — but
 * breaks under isolated `node_modules`, a clean `pnpm install
 * --frozen-lockfile` (the CI default), or extraction of the package to its
 * own repo. No existing gate catches this class (the import-ban /
 * instance-coupling / dispatcher gates target core<->extension *coupling*, not
 * dependency *completeness*; `scripts/extensions/inventory.mjs --check` is non-failing).
 *
 * Two phantom classes, both scanned in one pass:
 *
 *  1. FIRST-PARTY (`phantomDeps`): a source import of another pnpm WORKSPACE
 *     member (e.g. `@cinatra-ai/llm`) not declared by the importer. Scanned
 *     across every workspace member (`packages/*` + every synced
 *     `extensions/*` tree).
 *
 *  2. THIRD-PARTY (`thirdPartyPhantomDeps`, cinatra#2480): a production-value
 *     import of an npm-registry package not declared by the importer. Scoped
 *     to SYNCED-EXTENSION members only (`extensions/<vendor>/<name>` — each
 *     materialized from its own standalone repo via
 *     cinatra-{dev,required}-extensions.lock.json). `packages/*` is
 *     deliberately out of scope: those packages live and are consumed
 *     entirely inside this monorepo, so a `packages/*` import resolving via
 *     the root's own declared deps is not the extraction-breakage class this
 *     leg guards — a synced extension is periodically pulled out to its own
 *     repo + its own `pnpm install`, at which point the host's hoisted
 *     `node_modules` is gone and an undeclared import 404s
 *     (MODULE_NOT_FOUND). This is the exact class found by hand in
 *     drupal-mcp-connector#82 (`@modelcontextprotocol/sdk`) and #83
 *     (`zod`) before this gate could see it.
 *
 *     Gated import universe (the minimum production-value class):
 *       - INCLUDED: any non-relative, non-workspace-internal import that
 *         resolves to a runtime binding — named/default/namespace imports,
 *         side-effect imports, dynamic `import()`, `require()`. A subpath
 *         import (`radix-ui/themes`, `next/link`) is counted against its
 *         OWNING package (`resolveSpecifierToPackage`).
 *       - EXCLUDED, explicitly:
 *         - type-only imports — a WHOLE `import type ... from "x"` /
 *           `export type ... from "x"` declaration is erased by the TS
 *           compiler and never reaches the runtime module graph, so it can't
 *           break a frozen install. A MIXED import that pairs an inline
 *           `type` specifier with a real binding (`import { type Foo, bar }
 *           from "x"`) still counts — `bar` is a real runtime import.
 *         - test-tool / dev-only imports — any import inside a test file
 *           (the same `TEST_RE` the first-party leg already excludes); a
 *           package used ONLY from test files (e.g. a test framework) never
 *           reaches this scan at all.
 *         - Node built-ins (`fs`, `node:fs`, `fs/promises`, …) — never an
 *           npm package.
 *         - already-declared peer/optional deps — `declared` (below) already
 *           unions all four manifest buckets (`dependencies`,
 *           `devDependencies`, `peerDependencies`, `optionalDependencies`),
 *           matching the first-party leg's existing semantics.
 *         - generated output — covered by the same `SKIP_DIRS` the
 *           first-party leg already excludes (`dist`, `build`, `.next`,
 *           `coverage`, `.turbo`); no synced-extension repo is known to emit
 *           generated SOURCE outside those dirs today, so no extra carve-out
 *           is added — a future one would need its own follow-up.
 *     A commented-out import is a known false-positive risk across ~100+
 *     externally-authored repos this leg can't hand-audit, so (unlike the
 *     first-party leg) it runs the shared lexical comment stripper
 *     (`lib/strip-comments.mjs`) before extracting specifiers.
 *
 *     KNOWN, ACCEPTED false-negative (codex review, cinatra#2480): a fully
 *     dynamic specifier — `import(pkgVar)`, or one built from a template
 *     literal / concatenation (`` import(`${pkg}`) ``) — is invisible to this
 *     leg (and to the pre-existing first-party leg, which shares the same
 *     quoted-literal-only regex set). Statically resolving an arbitrary JS
 *     expression to a package name is undecidable in general; this is a
 *     heuristic static scanner, not a bundler. No such pattern is known in
 *     any synced-extension source today.
 *
 * Both classes share the SAME ratchet mechanism: a JSON baseline records the
 * CURRENT (tolerated) misses per class; the gate fails only on NEW or GROWN
 * misses in EITHER class. The baseline is the version-controlled, reasoned
 * exemption record — `thirdPartyPhantomDepsNotes` documents WHY each
 * grandfathered (member, package) pair is tolerated (a tracking issue, an
 * in-flight upstream fix, etc.) and is not itself gate-diffed. Regenerate the
 * data (it should only ever SHRINK) with `--write-baseline`; keep the notes
 * for anything real that gets re-baselined this way.
 *
 * The base-ref growth guard (`WORKSPACE_PHANTOM_DEPS_BASE`, which blocks the
 * regenerate-to-pass bypass) is CLASS-AWARE: a bootstrap-eligible class
 * entirely ABSENT from the base-branch baseline is being introduced by this PR,
 * and its one-time grandfathered write is reported ("class bootstrap: N
 * grandfathered entries") rather than read as baseline growth. Growth in a
 * class that ALREADY exists on the base branch fails unchanged — so once an
 * introducing PR merges, the class exists on main and the ratchet applies to it
 * from the next commit on. The first-party class is NOT bootstrap-eligible, so
 * its guard is untouched. See `BOOTSTRAPPABLE_CLASSES` / `classGrowth` for the
 * exact rule and its accepted residuals.
 *
 * Exit codes: 0 = clean (no new phantom deps), 1 = findings, 2 = scanner error.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";

const REPO_ROOT = process.cwd();
const WORKSPACE_FILE = join(REPO_ROOT, "pnpm-workspace.yaml");
const EXTENSIONS_ROOT = join(REPO_ROOT, "extensions");
const BASELINE_FILE = join(REPO_ROOT, "scripts/audit/workspace-phantom-deps.baseline.json");

// Node built-in module names (bare form, e.g. "fs", "fs/promises" -> "fs" once
// resolved through resolveSpecifierToPackage). The `node:`-prefixed form is
// already excluded upstream in resolveSpecifierToPackage.
const BUILTIN_MODULE_NAMES = new Set(builtinModules.filter((m) => !m.startsWith("_")));

const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo", ".git"]);
const TEST_RE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?\//;
// THIRD-PARTY leg only (see the file header's dev-only-import classification):
// build/test-tooling CONFIG files (`vitest.config.ts`, `eslint.config.mjs`,
// …). Never part of a package's shipped `files` payload and conventionally
// devDependency-scoped; a synced extension's own config commonly imports a
// tool (observed: `vitest.config.ts` importing `vitest/config`, undeclared)
// that its OWN `__tests__/` files never re-import directly. Matched against
// an EXPLICIT allowlist of known dev-tooling names, not a blanket
// `*.config.*` — the blanket form would also swallow a hypothetical shipped
// production config MODULE with real runtime imports (codex review flagged
// this). Extend the list, never widen the pattern, when a new tool's config
// shows up undeclared. Basename-matched so it fires regardless of depth.
const CONFIG_TOOL_NAMES = [
  "vitest", "eslint", "playwright", "jest", "tailwind", "postcss",
  "tsup", "rollup", "webpack", "vite", "babel", "prettier", "next",
  "commitlint", "lint-staged",
];
const CONFIG_FILE_RE = new RegExp(`(^|/)(?:${CONFIG_TOOL_NAMES.join("|")})\\.config\\.[cm]?[jt]sx?$`);

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in __tests__/workspace-phantom-deps.test.mjs)
// ---------------------------------------------------------------------------

/** Parse the `packages:` glob list out of pnpm-workspace.yaml (no YAML dep). */
export function parseWorkspaceGlobs(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const globs = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (inPackages && /^\S/.test(line)) break; // next top-level key
    if (!inPackages) continue;
    const m = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
    if (m) globs.push(m[1].trim());
  }
  return globs;
}

/** Map an import specifier to its owning package name, or null for relative /
 * builtin / non-package specifiers. `@scope/name/sub` -> `@scope/name`; for
 * unscoped, `name/sub` -> `name`. */
export function resolveSpecifierToPackage(spec) {
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#")) return null;
  if (spec.startsWith("node:")) return null;
  const parts = spec.split("/");
  if (spec.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0];
}

/** Extract the set of OTHER-workspace package names imported by `source`.
 * Covers `from "x"`, side-effect `import "x"`, `import("x")`, `require("x")`,
 * and `export ... from "x"`. `internalNames` is the Set of workspace member
 * names; `selfName` is excluded. */
export function extractInternalImports(source, internalNames, selfName) {
  const found = new Set();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,            // import/export ... from "x"
    /\bimport\s*\(\s*["']([^"']+)["']/g,      // dynamic import("x")
    /\brequire\s*\(\s*["']([^"']+)["']/g,     // require("x")
    /\bimport\s+["']([^"']+)["']/g,           // side-effect import "x"
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      const pkg = resolveSpecifierToPackage(m[1]);
      if (pkg && pkg !== selfName && internalNames.has(pkg)) found.add(pkg);
    }
  }
  return found;
}

/** True iff `pkg` (already resolved via resolveSpecifierToPackage) names a
 * Node.js built-in module. */
export function isBuiltinPackage(pkg) {
  return BUILTIN_MODULE_NAMES.has(pkg);
}

// Matches a WHOLE `import type ... from "x"` / `export type ... from "x"`
// declaration (the erased-at-compile-time form), non-greedy so it stops at the
// first `from` clause. Deliberately requires `type` immediately after
// `import`/`export` (a word boundary + whitespace before AND after) so a
// default import literally named e.g. `typeStuff` (`import typeStuff from
// "x"`) does NOT match — there is no whitespace between "type" and "Stuff".
// Bounded to `[^;]*?` (no semicolon crossing), NOT `[\s\S]*?`: `export type`
// is AMBIGUOUS — it opens both a re-export (`export type { X } from "y"`,
// which has a `from` clause) and a plain type-alias declaration (`export type
// X = {...};`, which never does. An unbounded scan for the next `from "..."`
// after a type-alias keyword would run past its own terminating `;` into
// unrelated later code looking for someone else's `from` clause, silently
// deleting everything in between (observed: a `export type X = {...}` earlier
// in a real file swallowed 40+ intervening lines up to the next unrelated
// import). Bounding to the current statement trades a narrow residual (a
// string literal inside the alias body whose value is literally the word
// `from` immediately followed by a quote) for eliminating that unbounded-span
// class entirely.
const TYPE_ONLY_IMPORT_RE = /\b(?:import|export)\s+type\s+[^;]*?\bfrom\s*["'][^"']+["']\s*;?/g;

// A real import specifier's package-name segment never contains whitespace,
// template-literal interpolation syntax, or other JS-expression punctuation.
// `stripComments` deliberately preserves string/template CONTENTS (see its
// header), so source text that merely DESCRIBES an import inside a string —
// e.g. an error message literally containing `import "${h}"` — is present in
// `cleaned` and would otherwise be captured as if it were a real static
// import. Observed directly in this tree (an audit-gate's own error-message
// template). Reject anything shaped like JS-expression content rather than a
// module specifier.
const IMPLAUSIBLE_SPECIFIER_RE = /[\s$`{}()<>;,"']/;
function isPlausibleImportSpecifier(spec) {
  return spec.length > 0 && spec.length <= 300 && !IMPLAUSIBLE_SPECIFIER_RE.test(spec) && !spec.includes("://");
}

/** Extract the set of THIRD-PARTY (non-relative, non-builtin,
 * non-workspace-internal) package names imported by `source` for a
 * RUNTIME/value binding. Covers `from "x"`, side-effect `import "x"`,
 * `import("x")`, `require("x")`, and `export ... from "x"` — the same forms
 * `extractInternalImports` covers — but first strips comments (this leg
 * scans externally-authored source it can't hand-audit for false positives)
 * and whole-declaration `import type` / `export type` statements (erased at
 * compile time, never reach the runtime module graph — see the file header).
 * A subpath (`radix-ui/themes`) resolves to its owning package. `internalNames`
 * (workspace member names) and Node built-ins are excluded; so is `selfName`. */
export function extractThirdPartyImports(source, internalNames, selfName) {
  const cleaned = stripComments(source).replace(TYPE_ONLY_IMPORT_RE, "");
  const found = new Set();
  const patterns = [
    /\bfrom\s*["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\n]+)["']/g,
    /\brequire\s*\(\s*["']([^"'\n]+)["']/g,
    /\bimport\s+["']([^"'\n]+)["']/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      if (!isPlausibleImportSpecifier(m[1])) continue;
      const pkg = resolveSpecifierToPackage(m[1]);
      if (!pkg || pkg === selfName || internalNames.has(pkg) || isBuiltinPackage(pkg) || pkg.includes(":")) continue;
      found.add(pkg);
    }
  }
  return found;
}

function diffFindingsAgainstMap(findings, knownMap) {
  const newViolations = {};
  for (const [pkg, deps] of Object.entries(findings)) {
    const known = new Set(knownMap[pkg] ?? []);
    const fresh = deps.filter((d) => !known.has(d));
    if (fresh.length) newViolations[pkg] = fresh.sort();
  }
  return { newViolations };
}

/** Compare findings against a baseline. Returns { newViolations: {pkg:[deps]} }.
 * A (pkg, dep) pair is a NEW violation iff it is not present in the baseline. */
export function diffAgainstBaseline(findings, baseline) {
  return diffFindingsAgainstMap(findings, baseline?.phantomDeps ?? {});
}

/** Same as diffAgainstBaseline, for the THIRD-PARTY (`thirdPartyPhantomDeps`)
 * baseline section. */
export function diffThirdPartyAgainstBaseline(findings, baseline) {
  return diffFindingsAgainstMap(findings, baseline?.thirdPartyPhantomDeps ?? {});
}

function growthOfMaps(baseMap, committedMap) {
  const basePairs = new Set();
  for (const [pkg, deps] of Object.entries(baseMap ?? {})) for (const d of deps) basePairs.add(`${pkg} :: ${d}`);
  const grew = [];
  for (const [pkg, deps] of Object.entries(committedMap ?? {})) for (const d of deps) {
    const key = `${pkg} :: ${d}`;
    if (!basePairs.has(key)) grew.push(key);
  }
  return grew.sort();
}

function countPairs(map) {
  return Object.values(map ?? {}).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0);
}

// The ONLY baseline classes whose one-time introduction is bootstrap-exempt
// from the growth guard (see `classGrowth`). Deliberately an EXPLICIT
// allowlist, not "any absent class": the first-party `phantomDeps` section has
// existed in the committed baseline since this gate landed, so an absent
// first-party section is never a legitimate bootstrap — it is a corrupted
// baseline or a delete-and-re-add laundering attempt, and both must keep
// failing closed EXACTLY as they did before this carve-out existed (codex
// review, cinatra#2521). A future new class is added to this line in the same
// PR that introduces it — one explicit, reviewable token.
const BOOTSTRAPPABLE_CLASSES = new Set(["thirdPartyPhantomDeps"]);

/** True iff `key` names a bootstrap-ELIGIBLE baseline CLASS (top-level section,
 * per BOOTSTRAPPABLE_CLASSES) that is ENTIRELY ABSENT from the base-branch
 * baseline object — the section key does not exist at all. An EMPTY-but-PRESENT
 * section (`"thirdPartyPhantomDeps": {}`) is NOT absent: the class already
 * exists on the base branch, so anything added to it is ordinary growth. A
 * missing / non-object base baseline is NOT a bootstrap either (fail-closed: it
 * takes the normal growth path, which reports every committed pair). */
export function isClassBootstrap(baseBaseline, key) {
  if (!BOOTSTRAPPABLE_CLASSES.has(key)) return false;
  if (!baseBaseline || typeof baseBaseline !== "object" || Array.isArray(baseBaseline)) return false;
  return !(key in baseBaseline);
}

/** Base-ref ratchet for ONE baseline class. Returns
 * `{ grew: string[], bootstrap: number|null }`.
 *
 * `grew` = (pkg, dep) pairs in the COMMITTED baseline that are ABSENT from the
 * BASE-branch baseline — i.e. a regenerate-to-pass bypass that added new
 * tolerated misses in the same PR. Mirrors the sibling no-new-rot gates so the
 * baseline can only ever SHRINK.
 *
 * CLASS BOOTSTRAP (the one carve-out): when a bootstrap-ELIGIBLE class
 * (BOOTSTRAPPABLE_CLASSES) is entirely absent from the base baseline
 * (`isClassBootstrap`), the PR that INTRODUCES the class
 * necessarily writes all of its grandfathered entries in one go. Reading that
 * one-time write as "the baseline GREW" makes the growth guard fail on the very
 * PR that adds the class — which is exactly what happened to the third-party
 * class (cinatra#2480/#2521). That single write is therefore exempt and
 * REPORTED (`bootstrap` = its entry count) instead of failed. The ratchet is
 * not weakened: the moment such a PR merges, the class EXISTS on the base
 * branch, so every later addition to it takes the normal `grew` path and fails.
 * `bootstrap` is null when the class is not a bootstrap, and also when the
 * committed baseline has no such section either (nothing to report).
 *
 * Residual, accepted: deleting an ELIGIBLE class from the baseline on the base
 * branch and re-bootstrapping it in a follow-up PR would re-open the carve-out
 * once — that takes two merged PRs, the first of which is a visible
 * whole-section deletion of the version-controlled exemption record. Renaming
 * the class key, or adding a class to BOOTSTRAPPABLE_CLASSES, has the same
 * shape and, like any gate bypass, requires editing this gate itself. */
export function classGrowth(baseBaseline, committedBaseline, key) {
  const committedMap = committedBaseline?.[key];
  if (isClassBootstrap(baseBaseline, key)) {
    return { grew: [], bootstrap: committedMap ? countPairs(committedMap) : null };
  }
  return { grew: growthOfMaps(baseBaseline?.[key], committedMap), bootstrap: null };
}

/** Base-ref ratchet growth for the FIRST-PARTY (`phantomDeps`) baseline
 * section. Byte-identical to its pre-carve-out behaviour for EVERY input:
 * `phantomDeps` is not in BOOTSTRAPPABLE_CLASSES, so it can never take the
 * bootstrap branch — an absent first-party section still reports every
 * committed pair as growth. */
export function baselineGrowth(baseBaseline, committedBaseline) {
  return classGrowth(baseBaseline, committedBaseline, "phantomDeps").grew;
}

/** Same as baselineGrowth, for the THIRD-PARTY (`thirdPartyPhantomDeps`)
 * baseline section. */
export function thirdPartyBaselineGrowth(baseBaseline, committedBaseline) {
  return classGrowth(baseBaseline, committedBaseline, "thirdPartyPhantomDeps").grew;
}

// ---------------------------------------------------------------------------
// Filesystem scan
// ---------------------------------------------------------------------------

function expandGlob(pattern) {
  // One-level-per-segment glob: supports `*` (and prefix*/*-suffix) within a
  // single path segment; no `**`. Returns existing directories.
  const segs = pattern.split("/");
  let dirs = [REPO_ROOT];
  for (const seg of segs) {
    const next = [];
    const hasWild = seg.includes("*");
    const re = hasWild ? new RegExp("^" + seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$") : null;
    for (const d of dirs) {
      if (!hasWild) { const p = join(d, seg); if (existsSync(p) && statSync(p).isDirectory()) next.push(p); continue; }
      let entries;
      try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) if (e.isDirectory() && re.test(e.name)) next.push(join(d, e.name));
    }
    dirs = next;
  }
  return dirs;
}

/** True iff `dir` is a descendant of `extensionsRoot` (any depth) — the
 * scope test for the THIRD-PARTY leg. `extensionsRoot` is injected (defaults
 * to the real EXTENSIONS_ROOT) so this stays a pure, unit-testable helper.
 * Deliberately depth-agnostic: the ONLY caller (`readPackage`, via
 * `discoverMembers`) invokes this exclusively on directories the pnpm
 * workspace globs already matched, which are always exactly
 * `extensions/<vendor>/<name>/` (see pnpm-workspace.yaml — every
 * `extensions/*` glob is a fixed two-segment pattern); this function does not
 * itself re-derive or enforce that shape. */
export function isSyncedExtensionDir(dir, extensionsRoot = EXTENSIONS_ROOT) {
  const rel = relative(extensionsRoot, dir);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function readPackage(dir) {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pj, "utf8"));
    if (!pkg.name) return null;
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);
    return { name: pkg.name, dir, declared, synced: isSyncedExtensionDir(dir) };
  } catch { return null; }
}

function* walkSource(root) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walkSource(join(root, e.name));
    } else if (e.isFile()) {
      const dot = e.name.lastIndexOf(".");
      if (dot >= 0 && SOURCE_EXT.has(e.name.slice(dot))) yield join(root, e.name);
    }
  }
}

/** Discover workspace members (the extractable/publishable packages matched by
 * the pnpm-workspace globs). The ROOT app (`.`) is intentionally excluded — both
 * as an importer AND from the internal-name set: it consumes workspace packages
 * via Next.js `transpilePackages` + tsconfig `paths`, not package.json
 * `dependencies`, and is deployed as a standalone build (never installed or
 * extracted as an npm package), so an undeclared `@cinatra-ai/*` import in its
 * `src/` is not the frozen-install / extraction breakage class this gate guards.
 * No published package depends on the app, so omitting it loses no signal. */
function discoverMembers() {
  const globs = parseWorkspaceGlobs(readFileSync(WORKSPACE_FILE, "utf8"));
  const byDir = new Map();
  for (const g of globs) for (const dir of expandGlob(g)) {
    const pkg = readPackage(dir);
    if (pkg) byDir.set(dir, pkg);
  }
  return [...byDir.values()];
}

function scan() {
  const members = discoverMembers();
  const internalNames = new Set(members.map((m) => m.name));
  const findings = {};
  const thirdPartyFindings = {};
  for (const m of members) {
    const scanRoot = m.scanRoot ?? m.dir;
    if (!existsSync(scanRoot)) continue;
    const missing = new Set();
    const missingThirdParty = new Set();
    for (const file of walkSource(scanRoot)) {
      const relFile = relative(REPO_ROOT, file);
      if (TEST_RE.test(relFile)) continue;
      const source = readFileSync(file, "utf8");
      const imported = extractInternalImports(source, internalNames, m.name);
      for (const dep of imported) if (!m.declared.has(dep)) missing.add(dep);
      // THIRD-PARTY leg is scoped to synced-extension members only (see the
      // file header) — packages/* is deliberately not scanned for this class.
      // Build/test-tooling config files are also excluded (dev-only class).
      if (m.synced && !CONFIG_FILE_RE.test(relFile)) {
        const thirdParty = extractThirdPartyImports(source, internalNames, m.name);
        for (const dep of thirdParty) if (!m.declared.has(dep)) missingThirdParty.add(dep);
      }
    }
    if (missing.size) findings[m.name] = [...missing].sort();
    if (missingThirdParty.size) thirdPartyFindings[m.name] = [...missingThirdParty].sort();
  }
  return { findings, thirdPartyFindings, memberCount: members.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write-baseline");
  const report = args.includes("--report");
  let result;
  try { result = scan(); } catch (err) {
    console.error(`[workspace-phantom-deps] scanner error: ${err?.stack ?? err}`);
    process.exit(2);
  }
  const { findings, thirdPartyFindings, memberCount } = result;
  const totalPairs = Object.values(findings).reduce((n, a) => n + a.length, 0);
  const totalThirdPartyPairs = Object.values(thirdPartyFindings).reduce((n, a) => n + a.length, 0);

  if (write) {
    const existing = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : {};
    const baseline = {
      note: "Workspace phantom-dependency baseline (no-new-rot ratchet). `phantomDeps` = a source import of a first-party workspace package NOT declared in the importing package's package.json (resolves only via pnpm hoisting). `thirdPartyPhantomDeps` = a production-value import of a THIRD-PARTY (npm-registry) package NOT declared in the importing package's package.json, scoped to SYNCED-EXTENSION members only (extensions/<vendor>/<name> — see the gate's file header for the gated-import-universe definition; cinatra#2480). `thirdPartyPhantomDepsNotes` carries the REASON each grandfathered (member, package) pair is tolerated — a manual, version-controlled record; NOT diffed by the gate. These are CURRENT tolerated misses; the gate fails on NEW/GROWN entries. Regenerate the data with `node scripts/audit/workspace-phantom-deps.mjs --write-baseline` — every data entry should only ever be REMOVED (declare the dep), never added; carry `thirdPartyPhantomDepsNotes` forward by hand for anything re-baselined this way.",
      phantomDeps: findings,
      thirdPartyPhantomDeps: thirdPartyFindings,
      thirdPartyPhantomDepsNotes: existing.thirdPartyPhantomDepsNotes ?? {},
    };
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`[workspace-phantom-deps] wrote baseline: ${Object.keys(findings).length} packages / ${totalPairs} phantom deps, ${Object.keys(thirdPartyFindings).length} packages / ${totalThirdPartyPairs} third-party phantom deps (scanned ${memberCount} members).`);
    return;
  }

  if (report) {
    console.log(`[workspace-phantom-deps] ${memberCount} members scanned; ${totalPairs} phantom deps across ${Object.keys(findings).length} packages; ${totalThirdPartyPairs} third-party phantom deps across ${Object.keys(thirdPartyFindings).length} synced-extension packages:`);
    for (const [pkg, deps] of Object.entries(findings).sort()) console.log(`  ${pkg}\n    - ${deps.join("\n    - ")}`);
    if (totalThirdPartyPairs) {
      console.log(`  third-party:`);
      for (const [pkg, deps] of Object.entries(thirdPartyFindings).sort()) console.log(`    ${pkg}\n      - ${deps.join("\n      - ")}`);
    }
    return;
  }

  const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : { phantomDeps: {}, thirdPartyPhantomDeps: {} };

  // Base-ref ratchet: block the regenerate-to-pass bypass (adding a phantom
  // import + `--write-baseline` in the same PR). When WORKSPACE_PHANTOM_DEPS_BASE
  // is set (wired from the CI base ref), fail if the committed baseline contains
  // any (pkg, dep) pair absent from the base-branch baseline, in EITHER the
  // first-party or third-party section. Mirrors the sibling no-new-rot gates;
  // fail-closed if the ref can't be resolved.
  const baseRef = process.env.WORKSPACE_PHANTOM_DEPS_BASE;
  if (baseRef) {
    if (baseRef.startsWith("-")) {
      console.error(`[workspace-phantom-deps] FAIL — WORKSPACE_PHANTOM_DEPS_BASE="${baseRef}" is flag-like.`);
      process.exit(1);
    }
    let refResolves = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "ignore"] });
      refResolves = true;
    } catch { refResolves = false; }
    if (!refResolves) {
      console.error(`[workspace-phantom-deps] FAIL — WORKSPACE_PHANTOM_DEPS_BASE="${baseRef}" did not resolve (shallow checkout / misconfig?). Failing closed — ensure the base ref is fetched (fetch-depth: 0).`);
      process.exit(1);
    }
    let baseText = null;
    try {
      baseText = execFileSync("git", ["show", `${baseRef}:scripts/audit/workspace-phantom-deps.baseline.json`], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      baseText = null; // ref resolves but file absent → introducing PR, no constraint
    }
    if (baseText) {
      const baseJson = JSON.parse(baseText);
      // Class-aware: a class ENTIRELY ABSENT from the base baseline is being
      // bootstrapped by this PR — its one-time grandfathered write is reported,
      // not failed (see classGrowth). Growth in a class that already exists on
      // the base branch fails exactly as before.
      const firstParty = classGrowth(baseJson, baseline, "phantomDeps");
      const thirdParty = classGrowth(baseJson, baseline, "thirdPartyPhantomDeps");
      for (const [label, res] of [["first-party", firstParty], ["third-party", thirdParty]]) {
        if (res.bootstrap !== null) {
          console.log(`[workspace-phantom-deps] ${label} class bootstrap: ${res.bootstrap} grandfathered entries (class absent from ${baseRef}; the one-time introducing write is exempt from the growth guard — every later addition to it fails).`);
        }
      }
      const grew = firstParty.grew;
      const grewThirdParty = thirdParty.grew;
      if (grew.length || grewThirdParty.length) {
        console.error(`[workspace-phantom-deps] FAIL — committed baseline GREW vs ${baseRef} (regenerate-to-pass bypass):`);
        grew.forEach((e) => console.error("  + " + e));
        grewThirdParty.forEach((e) => console.error("  + [third-party] " + e));
        process.exit(1);
      }
    }
  }

  const { newViolations } = diffAgainstBaseline(findings, baseline);
  const { newViolations: newThirdPartyViolations } = diffThirdPartyAgainstBaseline(thirdPartyFindings, baseline);
  const newCount = Object.values(newViolations).reduce((n, a) => n + a.length, 0);
  const newThirdPartyCount = Object.values(newThirdPartyViolations).reduce((n, a) => n + a.length, 0);

  if (newCount === 0 && newThirdPartyCount === 0) {
    console.log(`[workspace-phantom-deps] OK — no new phantom deps (scanned ${memberCount} members; ${totalPairs} first-party + ${totalThirdPartyPairs} third-party baselined).`);
    process.exit(0);
  }
  const totalNew = newCount + newThirdPartyCount;
  console.error(`[workspace-phantom-deps] FAIL — ${totalNew} NEW phantom dependenc${totalNew === 1 ? "y" : "ies"}:`);
  for (const [pkg, deps] of Object.entries(newViolations)) {
    console.error(`  ${pkg} imports but does not declare:`);
    for (const d of deps) console.error(`    - ${d}  (add "${d}": "workspace:*" to ${pkg}'s package.json, then run pnpm install)`);
  }
  for (const [pkg, deps] of Object.entries(newThirdPartyViolations)) {
    console.error(`  ${pkg} imports but does not declare (third-party):`);
    for (const d of deps) console.error(`    - ${d}  (declare "${d}" in ${pkg}'s package.json — dependencies/devDependencies/peerDependencies as appropriate)`);
  }
  console.error(`\nIf this is intentional debt, regenerate the baseline with --write-baseline (it should only ever shrink) and, for a third-party entry, add a reason to thirdPartyPhantomDepsNotes.`);
  process.exit(1);
}

// Only run the gate when executed directly — importing for unit tests must not
// trigger the scan or process.exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
