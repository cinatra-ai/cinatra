#!/usr/bin/env node
// Vendor-token core gate (cinatra#973 — epic cinatra-ai/cinatra#978).
//
// DOCTRINE (epic #978): core owns integration MECHANISM, never integration
// VENDOR CODE. The pinned-empty lexeme gates (core-extension-import-ban,
// core-extension-instance-coupling-ban) block core from importing/naming
// extension PACKAGES — but nothing failed a PR that added a new
// vendor-specific FILE, ROUTE SEGMENT, or IMPORT EDGE in core that names the
// vendor directly rather than its extension package (PR #969 proved the gap:
// a vendor-literal route mirroring a superseded twin passed every gate).
//
// WHAT THIS GATE SCANS. Core source under `src/` + `packages/` for the vendor
// words (see THE WORDS below), in exactly the three surfaces the gap analysis named:
//   - FILE PATHS (filenames AND directory/route segments — a Next.js route
//     dir like `src/app/api/webhooks/<vendor>/` is a path segment hit for
//     every file under it);
//   - IMPORT SPECIFIERS (static import/export-from, side-effect imports,
//     dynamic `import()`, `require()`) after lexical comment stripping.
// It deliberately does NOT scan arbitrary string/JSX/prompt literals — the
// instance-coupling gate owns extension-package lexemes there, and vendor
// WORDS in UI copy ("Publish to WordPress") are not code coupling.
//
// SHAPE. The same shrink-only no-new-rot ratchet the repo uses elsewhere
// (exdev-rename-gate, host-peer-value-import-ban): a committed baseline
// enumerates TODAY'S residual vendor floor (the epic #978 clusters — the
// vendor API-client layer, vendor-literal routes/pages, the blog vendor
// lifecycles, the wp-drupal wire-contract residue, dev-auto-setup blocks).
// The floor only ever SHRINKS:
//   - a NEW vendor-token occurrence (new key, or a grown count on an existing
//     key) fails CI immediately;
//   - a REMOVED occurrence makes the committed baseline STALE and fails CI
//     until `--write-baseline` ratchets the floor down (no silent headroom a
//     later PR could grow back into);
//   - `--write-baseline` REFUSES to write a baseline that grows any key vs
//     the committed one;
//   - the VENDOR_TOKEN_BASE monotonic guard refuses a committed baseline that
//     grew vs the base branch (no regenerate-to-pass), failing CLOSED on
//     flag-like or unresolvable refs.
// ONE growth is admitted, by `--write-baseline` run with VENDOR_TOKEN_BASE set
// and by the base guard (the application border gate's class 1 admission): a
// NEW key whose file is BYTE-IDENTICAL at the base reference — the code did
// not change, only the words did (a pinned pack newly declaring a word core
// already spells). A key already on the floor never grows this way.
//
// SANCTIONED SURFACES (enumerated in scripts/audit/extension-coupling-gates.md,
// per the epic #978 categories (a)-(e)) are excluded from the scan:
//   - the generator-emitted manifest tree (the EXPLICIT file list shared with
//     the coupling gates — never a directory prefix);
//   - `packages/sdk-extensions/` (frozen ABI type contracts, e.g. the
//     google-oauth-connection / nango-system wire contracts; its own gates
//     pin that surface);
//   - `packages/connectors-catalog/` (the ONE sanctioned hand-maintained
//     slug -> packageId identity catalog);
//   - `packages/agents/src/reserved-workspace-slugs.ts` (reserved-slug
//     identity data);
//   - tests/mocks and docs (`*.md`) — category (d), the surfaces that police
//     and document the boundary.
// The dev/required extension locks live at the repo root and `docker/`
// fixtures outside the scan roots, so they need no carve-out here.
//
// THE WORDS (cinatra#4848). This gate names no word. It reads the `vendor`
// list of lib/border-words.mjs: the union of the `cinatra.borderWords.vendor`
// words the pinned extensions declare in their own manifests and the
// temporary, shrink-only bridge scripts/audit/border-words-bridge.json (the
// words no pack declares yet). A malformed declaration, a word both in the
// bridge and declared, a bridge that grew against VENDOR_TOKEN_BASE, a word
// that left the bridge against it without a pinned pack declaring it as a
// vendor word, a pinned pack without the declaration that the bridge's
// shrink-only `packages` list does not name (a newly pinned or renamed pack,
// or one that dropped its declaration), and a `packages` list that grew
// against VENDOR_TOKEN_BASE each fail; an absent extension tree or a pinned package not
// found in it is a scanner error (exit 2). The
// non-goals of epic #978 stay non-goals by declaration: `nango` (the
// credential-broker MECHANISM) and the LLM-provider names are words no pack
// declares as a vendor word.
//
// THE SDK'S EXPORTED NAMES (cinatra#4875, class `sdk-name-with-extension-word`).
// `packages/sdk-extensions/` is excluded from the path scan above, so a port
// contract named for a family or a vendor passed every gate. This class reads
// the names a pack can import from the two SDK packages the conformance gate
// lets a pack depend on (SDK_PACKAGE_DIRS). The scope is deliberately narrow
// and fails closed: of each package's `exports` map it reads only the two
// entry forms the SDK packages use:
//  (A) a string target to a TypeScript source file (`./src/x.ts`, `.tsx`;
//      not a declaration file) that exists: that file is the entry;
//  (B) a conditions object with exactly the keys `types` then `default`, both
//      string targets to existing files, `types` a declaration file (`.d.ts`,
//      `.d.mts`, `.d.cts`): the `types` file is the entry.
// Every other form (a root conditions object, another condition name, a
// fallback array, a null, a subpath pattern, an extensionless or JavaScript
// string target, a missing file) is a scanner error "export form not read yet"
// naming the package and the subpath (exit 2): a form the rule does not read
// never passes unread. For form (B) the names come from the declaration file;
// names that only the JavaScript file exports at run time are not read.
// The entry files are read by the TypeScript type checker
// (`getExportsOfModule`) in a program with the root tsconfig.json's compiler
// options: named exports, re-exports by their exported name, the names
// `export *` brings, a namespace export by its own name only, a default export
// by its declared name, type-only exports; a declaration file that is no
// module is read through the ambient modules it declares. Only TOP-LEVEL names
// are read, never members. A name is split into words (camelCase, PascalCase,
// acronym runs, digits, `_` and `-`) and is a finding when one word, or a run
// of consecutive words written together, equals a border word of either list
// (whole words, case-insensitive). An `export ... from` or an exported name
// that does not resolve is a scanner error. Today's findings are recorded, one
// per entry specifier and name, each with a reason, in the baseline's
// `sdkNames`; a new name fails, a recorded name no longer found fails (stale),
// and the record only shrinks against VENDOR_TOKEN_BASE through the shared
// floor base guard (lib/floor-base-guard.mjs). The section is never removed: a
// head baseline without the `sdkNames` property fails, also when it would be
// empty (an empty section is `{}`). The one-time seed applies only when the
// BASE baseline has no `sdkNames` property, so it cannot recur.
//
// Usage:
//   node scripts/audit/vendor-token-core-gate.mjs                  # --check (default)
//   node scripts/audit/vendor-token-core-gate.mjs --write-baseline # ratchet the floor down
//   VENDOR_TOKEN_BASE=<ref> node ...   # also fail if the committed baseline GREW vs <ref>

import { readFileSync, writeFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";
import { compareFloorWithBase, isPermitReason, newKeys } from "./lib/floor-base-guard.mjs";
import { PERMANENT_EXEMPT_FILES } from "./lib/extension-reference-classification.mjs";
import {
  BorderWordsError,
  bridgeAtRef,
  bridgeGrowth,
  bridgeShrinkProblems,
  fileUnchangedAtRef,
  loadBorderWords,
} from "./lib/border-words.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const BASELINE_PATH = join(__dirname, "vendor-token-core-gate.baseline.json");

const SCAN_ROOTS = ["src/", "packages/"];

// How a word matches (the words themselves: THE WORDS above). Words shorter
// than SUBSTRING_MIN_LEN match path/specifier sub-tokens EXACTLY (so a
// two-letter word matches `<word>-contract.ts` but never the same letters
// inside a longer token); longer words also match as a SUBSTRING of a segment
// (so a squashed `<word>api.ts` evasion is caught).
const SUBSTRING_MIN_LEN = 5;

/** The vendor words the gate reads under `repoRoot` (declared ∪ bridge). Exported for tests and sibling guards. */
export function vendorWords(repoRoot = REPO_ROOT) {
  return loadBorderWords(repoRoot).words.vendor;
}

// Sanctioned-surface exclusions — enumerated (with rationale) in
// scripts/audit/extension-coupling-gates.md. Prefixes are directory scopes;
// files are exact.
export const EXCLUDED_PREFIXES = Object.freeze([
  "packages/sdk-extensions/",
  "packages/connectors-catalog/",
]);
export const EXCLUDED_FILES = new Set([
  "packages/agents/src/reserved-workspace-slugs.ts",
]);

// Sanctioned IMPORT SPECIFIERS (exact) / specifier prefixes. These are the
// enumerated third-party-package edges that are NOT vendor integration code:
//   - `next/font/google` — the Next.js framework font loader;
//   - `@google/genai` — the LLM-provider SDK consumed by the core-owned
//     packages/llm provider layer (the epic #978 LLM non-goal: LLM providers
//     are core mechanism, not connector vendor code);
//   - `@icons-pack/react-simple-icons/` — brand LOGOS (presentation identity
//     data, the same spirit as the identity-surface exempt class — never
//     logic).
// Everything else keeps counting: a vendor-named FILE added next to these
// imports still fails. Growing these sets is a reviewed change to this gate.
export const SANCTIONED_IMPORT_SPECIFIERS = new Set([
  "next/font/google",
  "@google/genai",
]);
export const SANCTIONED_IMPORT_SPECIFIER_PREFIXES = Object.freeze([
  "@icons-pack/react-simple-icons/",
]);

/** Is an import specifier a sanctioned third-party edge? Exported for tests. */
export function isSanctionedSpecifier(spec) {
  return (
    SANCTIONED_IMPORT_SPECIFIERS.has(spec) ||
    SANCTIONED_IMPORT_SPECIFIER_PREFIXES.some((p) => spec.startsWith(p))
  );
}

const TEST_PATH_RE =
  /(?:\.(?:test|spec)\.[mc]?[tj]sx?$|\/__tests__\/|\/__mocks__\/|\/tests?\/)/;
const CODE_FILE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

// Static import / export-from, side-effect import, dynamic import(), require().
// Single/double-quoted specifiers only (a template-literal specifier is not a
// resolvable static edge).
const IMPORT_SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

/** Is `rel` excluded as a sanctioned surface / test / doc? Exported for tests. */
export function isExemptFile(rel) {
  return (
    PERMANENT_EXEMPT_FILES.has(rel) ||
    EXCLUDED_FILES.has(rel) ||
    EXCLUDED_PREFIXES.some((p) => rel.startsWith(p)) ||
    TEST_PATH_RE.test(rel) ||
    rel.endsWith(".md")
  );
}

/**
 * Split a path segment / specifier segment into lowercase sub-tokens on
 * non-alphanumeric AND camelCase boundaries (`acmeApi` -> ["acme",
 * "api"]). Exported for tests.
 */
export function subTokens(segment) {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Does one path/specifier segment carry the vendor token? Exported for tests. */
export function segmentMatchesToken(segment, token) {
  const lower = segment.toLowerCase();
  if (token.length >= SUBSTRING_MIN_LEN && lower.includes(token)) return true;
  return subTokens(segment).includes(token);
}

/** Vendor tokens present in a slash-separated path/specifier, with per-token segment counts. */
export function tokenHits(pathLike, tokens) {
  const segments = pathLike.split("/").filter(Boolean);
  const hits = new Map();
  for (const token of tokens) {
    let n = 0;
    for (const seg of segments) if (segmentMatchesToken(seg, token)) n += 1;
    if (n > 0) hits.set(token, n);
  }
  return hits;
}

/** Import/require/export-from specifiers in comment-stripped source. Exported for tests. */
export function extractImportSpecifiers(source) {
  const specs = [];
  IMPORT_SPECIFIER_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_SPECIFIER_RE.exec(source)) !== null) specs.push(m[1]);
  return specs;
}

function listFiles(repoRoot = REPO_ROOT) {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SCAN_ROOTS],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split("\0").filter(Boolean);
}

/**
 * Scan core for vendor-token occurrences. Returns
 * { [`<file> :: path :: <token>` | `<file> :: import :: <specifier>`]: count }.
 * `files` is injectable for tests (repo-relative, forward-slash).
 */
export function scanVendorTokens(repoRoot = REPO_ROOT, files = listFiles(repoRoot), tokens = vendorWords(repoRoot)) {
  const occ = {};
  for (const rel of files) {
    if (isExemptFile(rel)) continue;
    // `git ls-files --cached` still lists a file DELETED from the worktree but
    // not yet committed — scan the worktree truth so a removal shows up as a
    // stale baseline entry immediately, not only after the commit.
    if (!existsSync(join(repoRoot, rel))) continue;

    // Surface 1+2: filename + directory/route segments.
    for (const [token, count] of tokenHits(rel, tokens)) {
      occ[`${rel} :: path :: ${token}`] = count;
    }

    // Surface 3: import specifiers (code files only).
    if (!CODE_FILE_RE.test(rel)) continue;
    let source;
    try {
      source = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    const specCounts = new Map();
    for (const spec of extractImportSpecifiers(stripComments(source))) {
      if (isSanctionedSpecifier(spec)) continue;
      if (tokenHits(spec, tokens).size === 0) continue;
      specCounts.set(spec, (specCounts.get(spec) ?? 0) + 1);
    }
    for (const [spec, count] of specCounts) {
      occ[`${rel} :: import :: ${spec}`] = count;
    }
  }
  return occ;
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** Keys whose CURRENT count exceeds the baseline count, or are entirely new. */
export function diffGrown(baseline, current) {
  const grown = [];
  for (const [k, c] of Object.entries(current)) {
    const base = baseline[k] ?? 0;
    if (c > base) grown.push(`${k} (${base} -> ${c})`);
  }
  return grown.sort();
}

/**
 * Growth of `committed` against `base` minus the one admission: a NEW key
 * whose file is byte-identical at the base (`isUnchangedAtBase(file)`) — the
 * words moved, the code did not. A key already in `base` never grows this way.
 */
export function admittedGrowth(base, committed, { isUnchangedAtBase }) {
  const grown = [];
  for (const entry of diffGrown(base, committed)) {
    const key = entry.replace(/ \(\d+ -> \d+\)$/, "");
    if (!Object.prototype.hasOwnProperty.call(base, key) && isUnchangedAtBase(key.split(" :: ")[0])) continue;
    grown.push(entry);
  }
  return grown;
}

/** Baseline keys whose CURRENT count fell below the baseline count (stale floor). */
export function diffShrunk(baseline, current) {
  const shrunk = [];
  for (const [k, c] of Object.entries(baseline)) {
    const cur = current[k] ?? 0;
    if (cur < c) shrunk.push(`${k} (${c} -> ${cur})`);
  }
  return shrunk.sort();
}

// ---------------------------------------------------------------------------
// The SDK's exported names (cinatra#4875) — see THE SDK'S EXPORTED NAMES above.
// ---------------------------------------------------------------------------

export const SDK_NAME_CLASS = "sdk-name-with-extension-word";

/** The SDK packages a pack may import (scripts/extensions/conformance-gate.mjs, rule `imports`). */
export const SDK_PACKAGE_DIRS = Object.freeze(["packages/sdk-extensions", "packages/sdk-ui"]);

const BASELINE_REL = "scripts/audit/vendor-token-core-gate.baseline.json";
/** An SDK entry or export that cannot be read: a scanner error (exit 2), never a pass. */
export class SdkNamesError extends Error {
  constructor(message) {
    super(message);
    this.name = "SdkNamesError";
  }
}

function loadTypeScript() {
  try {
    return createRequire(import.meta.url)("typescript");
  } catch {
    throw new SdkNamesError("the TypeScript compiler is not installed (run pnpm install first)");
  }
}

/**
 * The lower-case words of an exported name: split on `_`, `-` and every other
 * non-alphanumeric, on camelCase, between an acronym run and the next word
 * (`CRMConnector` -> crm, connector) and between letters and digits.
 */
export function nameTokens(name) {
  return String(name)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The border words a name carries: a word matches one token, or a run of
 * consecutive tokens written together (a word with digits, or one written as
 * two words in the name). Whole words only: a word is never found inside a
 * longer token. Sorted.
 */
export function nameWordHits(name, words) {
  const set = words instanceof Set ? words : new Set(words);
  const tokens = nameTokens(name);
  const hits = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    let run = "";
    for (let j = i; j < tokens.length; j += 1) {
      run += tokens[j];
      if (set.has(run)) hits.add(run);
    }
  }
  return [...hits].sort();
}

const DECLARATION_FILE = /\.d\.(ts|mts|cts)$/;
const SOURCE_FILE = /\.tsx?$/;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * A target this rule reads names a file inside the package: it starts with
 * `./`, holds no empty, `.`, `..` or `node_modules` segment, and names an
 * existing regular file whose real path stays inside the package. Returns the
 * absolute path, or null.
 */
function containedTargetFile(pkgAbs, target) {
  if (typeof target !== "string" || !target.startsWith("./")) return null;
  const segments = target.slice(2).split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s === "node_modules")) return null;
  const file = join(pkgAbs, ...segments);
  try {
    if (!statSync(file).isFile()) return null;
    return realpathSync(file).startsWith(`${realpathSync(pkgAbs)}${sep}`) ? file : null;
  } catch {
    return null;
  }
}

/**
 * The entry points of one SDK package: `[{ specifier, file }]`, one per key of
 * its `exports` map. The rule reads exactly the two entry forms the SDK
 * packages use, and no other (see THE SDK'S EXPORTED NAMES above):
 *  (A) a string target to a TypeScript source file (`.ts` or `.tsx`, not a
 *      declaration file): that file is the entry;
 *  (B) a conditions object with exactly the keys `types` and `default`, in
 *      that order, both string targets, `types` a declaration file (`.d.ts`,
 *      `.d.mts`, `.d.cts`): the `types` file is the entry (the names a
 *      TypeScript consumer gets).
 * Every target must name an existing file inside the package. Any other form
 * (a root conditions object, another condition name, a fallback array, a
 * null, a subpath pattern, an extensionless or JavaScript string target, a
 * missing file) throws SdkNamesError "export form not read yet", naming the
 * package and the subpath: a form the rule does not read never passes unread.
 */
export function sdkEntryPoints(repoRoot, pkgDir) {
  const abs = join(repoRoot, pkgDir);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(abs, "package.json"), "utf8"));
  } catch {
    throw new SdkNamesError(`${pkgDir}/package.json is unreadable`);
  }
  if (typeof pkg?.name !== "string" || !pkg.name) throw new SdkNamesError(`${pkgDir}/package.json names no package`);
  const notRead = (subpath, why) => new SdkNamesError(`export form not read yet: ${pkg.name} "${subpath}": ${why}`);
  const map = pkg.exports;
  if (!isPlainObject(map) || Object.keys(map).length === 0) {
    throw notRead(".", "the exports field is not an object of subpaths");
  }
  const keys = Object.keys(map);
  if (!keys.every((k) => k === "." || k.startsWith("./"))) {
    throw notRead(".", "a conditions object at the root of the exports field");
  }
  const entries = [];
  for (const key of keys) {
    if (key.includes("*") || key.endsWith("/")) throw notRead(key, "a subpath pattern");
    const specifier = key === "." ? pkg.name : `${pkg.name}/${key.slice(2)}`;
    const target = map[key];
    if (typeof target === "string") {
      if (!SOURCE_FILE.test(target) || DECLARATION_FILE.test(target)) {
        throw notRead(key, `a string target that is no TypeScript source file (${target})`);
      }
      const file = containedTargetFile(abs, target);
      if (!file) throw notRead(key, `the target names no file inside the package (${target})`);
      entries.push({ specifier, file });
      continue;
    }
    if (target === null) throw notRead(key, "a null target");
    if (Array.isArray(target)) throw notRead(key, "a fallback array");
    if (!isPlainObject(target)) throw notRead(key, `a target of type ${typeof target}`);
    const conditions = Object.keys(target);
    if (conditions.length !== 2 || conditions[0] !== "types" || conditions[1] !== "default") {
      throw notRead(key, `the conditions ${JSON.stringify(conditions)} (only "types" then "default" are read)`);
    }
    const { types, default: impl } = target;
    if (typeof types !== "string" || typeof impl !== "string") throw notRead(key, "a condition whose target is no string");
    if (!DECLARATION_FILE.test(types)) throw notRead(key, `a "types" target that is no declaration file (${types})`);
    const file = containedTargetFile(abs, types);
    if (!file) throw notRead(key, `the "types" target names no file inside the package (${types})`);
    if (!containedTargetFile(abs, impl)) throw notRead(key, `the "default" target names no file inside the package (${impl})`);
    entries.push({ specifier, file });
  }
  return entries;
}

/**
 * The compiler options of the repository's own root tsconfig.json (module
 * resolution, `baseUrl` and `paths` included), so a name resolves as in the
 * product's typecheck. Its `include` files are not read: the program's root
 * files are the SDK entry files only. Throws SdkNamesError when unreadable.
 */
function repoCompilerOptions(ts, repoRoot) {
  const path = join(repoRoot, "tsconfig.json");
  const read = ts.readConfigFile(path, ts.sys.readFile);
  if (read.error) {
    throw new SdkNamesError(`tsconfig.json is unreadable: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
  }
  const host = { ...ts.sys, readDirectory: () => [] };
  const parsed = ts.parseJsonConfigFileContent(read.config, host, repoRoot, undefined, path);
  const errors = parsed.errors.filter((d) => d.code !== 18003); // 18003: no input files (include is not read)
  if (errors.length) {
    throw new SdkNamesError(`tsconfig.json is invalid: ${ts.flattenDiagnosticMessageText(errors[0].messageText, " ")}`);
  }
  return {
    ...parsed.options,
    allowJs: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    incremental: false,
    composite: false,
    tsBuildInfoFile: undefined,
    plugins: undefined,
  };
}

/** The ambient external modules (`declare module "x" { ... }`) a file that is no module declares. */
function ambientModulesOf(ts, sf) {
  return sf.statements.filter((s) => ts.isModuleDeclaration(s) && ts.isStringLiteral(s.name) && s.body && ts.isModuleBlock(s.body));
}

const symbolDeclName = (sym) => {
  const decl = sym?.declarations?.[0];
  return decl?.name && typeof decl.name.text === "string" ? decl.name.text : undefined;
};

/**
 * The SDK's top-level exported names that carry a border word:
 * `{ "<entry specifier> :: <name>": [words] }` (a namespace export by its own
 * name, its members not read; a default export by its declared name, keyed
 * `default`; an ambient module a non-module target declares is keyed by its
 * module name). The program uses the root tsconfig.json's compiler options.
 * Throws SdkNamesError when the tsconfig, an entry, an `export ... from` module or an
 * exported name does not resolve.
 */
export function scanSdkExportNames(repoRoot = REPO_ROOT, words = [], { packages = SDK_PACKAGE_DIRS } = {}) {
  const ts = loadTypeScript();
  const wordSet = new Set(words);
  const found = {};
  let options;
  for (const pkgDir of packages) {
    options ??= repoCompilerOptions(ts, repoRoot);
    const entries = sdkEntryPoints(repoRoot, pkgDir);
    const program = ts.createProgram(entries.map((e) => e.file), options);
    const checker = program.getTypeChecker();
    const resolveAlias = (sym) => (sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym);
    for (const entry of entries) {
      // Every `export ... from` the entry reaches must resolve: a missing
      // module drops its names from getExportsOfModule without a word.
      const seenFiles = new Set();
      const queue = [program.getSourceFile(entry.file)];
      while (queue.length) {
        const sf = queue.shift();
        if (!sf) throw new SdkNamesError(`${entry.specifier}: an entry file could not be read by the TypeScript program`);
        if (seenFiles.has(sf.fileName)) continue;
        seenFiles.add(sf.fileName);
        // A file that is no module is read through the ambient modules it declares.
        const isModule = Boolean(checker.getSymbolAtLocation(sf));
        const stmts = isModule ? sf.statements : ambientModulesOf(ts, sf).flatMap((m) => m.body.statements);
        for (const stmt of stmts) {
          if (!ts.isExportDeclaration(stmt) || !stmt.moduleSpecifier) continue;
          const mod = checker.getSymbolAtLocation(stmt.moduleSpecifier);
          const text = stmt.moduleSpecifier.text;
          if (!mod) {
            throw new SdkNamesError(
              `${entry.specifier}: \`export ... from "${text}"\` in ${relative(repoRoot, sf.fileName)} does not resolve`,
            );
          }
          const next = mod.declarations?.find((d) => ts.isSourceFile(d));
          if (next && !next.fileName.includes("/node_modules/")) queue.push(next);
        }
      }
      // The exported name is what a pack imports (a renamed re-export is read
      // by its new name, a string export name as written); a default export is
      // read by its declared name. Only the top-level names of the entry are
      // read: a namespace export by its own name, never its members.
      const readModule = (moduleSym, specifier) => {
        for (const sym of checker.getExportsOfModule(moduleSym)) {
          const target = resolveAlias(sym);
          if (!target?.declarations?.length) {
            throw new SdkNamesError(`${specifier}: the exported name "${sym.name}" does not resolve`);
          }
          const read = sym.name === "default" ? symbolDeclName(target) ?? symbolDeclName(sym) ?? "" : sym.name;
          const hits = nameWordHits(read, wordSet);
          if (hits.length) found[`${specifier} :: ${sym.name}`] = hits;
        }
      };
      const sf = program.getSourceFile(entry.file);
      const moduleSym = sf && checker.getSymbolAtLocation(sf);
      if (moduleSym) {
        readModule(moduleSym, entry.specifier);
        continue;
      }
      // A file with no import or export is no module: what it makes
      // importable are the ambient modules it declares, each read under the
      // module name a pack imports. A file that declares none exports nothing.
      for (const decl of sf ? ambientModulesOf(ts, sf) : []) {
        const ambient = checker.getSymbolAtLocation(decl.name);
        if (!ambient) throw new SdkNamesError(`${entry.specifier}: the ambient module "${decl.name.text}" does not resolve`);
        readModule(ambient, decl.name.text);
      }
    }
  }
  return sortKeys(found);
}

/**
 * The `sdkNames` section of a baseline document. The section is never
 * removed: a document without the property throws "the section is removed"
 * (an empty section is written as `{}` and stays), as
 * agent-extension-code-gate.mjs fails a removed class. Throws when malformed.
 */
export function readSdkNamesFloor(doc) {
  if (!isPlainObject(doc) || !hasOwn(doc, "sdkNames")) {
    throw new Error('the "sdkNames" section is removed (a section is never removed; an empty one is written as {})');
  }
  const floor = doc.sdkNames;
  if (!isPlainObject(floor)) throw new Error('"sdkNames" is not an object');
  return floor;
}

/**
 * The class `sdk-name-with-extension-word` against the committed record and
 * the base. Returns `{ ok, lines, found }`; `lines` are failures when not ok.
 * Throws SdkNamesError / BorderWordsError on a scanner error.
 */
export function checkSdkNames(repoRoot = REPO_ROOT, { words, env = process.env, packages = SDK_PACKAGE_DIRS } = {}) {
  const all = words ?? (() => {
    const loaded = loadBorderWords(repoRoot).words;
    return [...loaded.vendor, ...loaded.domain];
  })();
  const found = scanSdkExportNames(repoRoot, all, { packages });
  let floor;
  try {
    floor = readSdkNamesFloor(JSON.parse(readFileSync(join(repoRoot, BASELINE_REL), "utf8")));
  } catch (err) {
    return { ok: false, found, lines: [`[vendor-token-core-gate] FAIL — ${BASELINE_REL}: ${err?.message ?? err}.`] };
  }
  const lines = [];
  const added = Object.keys(found).filter((k) => !Object.prototype.hasOwnProperty.call(floor, k));
  if (added.length) {
    lines.push(
      `[vendor-token-core-gate] FAIL — ${added.length} ${SDK_NAME_CLASS}: an SDK export a pack can import is named with a word an extension declares ` +
        `(name the contract for what it does, or move it into the extension that owns the word; cinatra#4875):`,
      ...added.map((k) => `  + ${k} (${found[k].join(", ")})`),
    );
  }
  const stale = Object.keys(floor).filter((k) => !Object.prototype.hasOwnProperty.call(found, k));
  if (stale.length) {
    lines.push(
      `[vendor-token-core-gate] FAIL — ${stale.length} stale "sdkNames" entr${stale.length === 1 ? "y" : "ies"} in ${BASELINE_REL} (the name is gone or carries no border word; remove the entry):`,
      ...stale.map((k) => `  - ${k}`),
    );
  }
  const unreasoned = Object.keys(floor).filter((k) => !isPermitReason(floor[k]));
  if (unreasoned.length) {
    lines.push(
      `[vendor-token-core-gate] FAIL — "sdkNames" entr${unreasoned.length === 1 ? "y" : "ies"} without a reason (a sentence of six words or more):`,
      ...unreasoned.map((k) => `  ! ${k}`),
    );
  }
  const guard = compareFloorWithBase({
    gate: "vendor-token-core-gate",
    envVar: "VENDOR_TOKEN_BASE",
    floorPath: BASELINE_REL,
    headFloor: floor,
    repoRoot,
    env,
    parse: (text) => {
      const doc = JSON.parse(text);
      // The one-time seed: only a base list without the `sdkNames` property
      // (before cinatra#4875). The head must always carry the property
      // (readSdkNamesFloor above), so the seed cannot recur.
      return isPlainObject(doc) && !hasOwn(doc, "sdkNames") ? null : readSdkNamesFloor(doc);
    },
    grown: (base, head) => {
      if (base === null) return [];
      return newKeys(Object.keys(base), Object.keys(head));
    },
  });
  if (!guard.ok) lines.push(...guard.lines);
  return { ok: lines.length === 0, found, lines, guardLines: guard.ok ? guard.lines : [] };
}

function writeBaselineFile(occurrences) {
  const total = Object.values(occurrences).reduce((a, b) => a + b, 0);
  // The `sdkNames` record (cinatra#4875) carries a reason per entry and is
  // edited by hand; the floor writer keeps it as committed.
  const committed = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        note:
          "Vendor-token core-gate residual floor (cinatra#973 — epic cinatra-ai/cinatra#978: " +
          "core owns integration MECHANISM, never vendor CODE). Each key is a CURRENT tolerated " +
          "vendor-token occurrence in core (src/ + packages/) — a vendor-named file/route " +
          "path segment or a vendor-named import specifier — outside the sanctioned surfaces " +
          "enumerated in scripts/audit/extension-coupling-gates.md. SHRINK-ONLY: regenerate with " +
          "`node scripts/audit/vendor-token-core-gate.mjs --write-baseline` (it refuses growth); " +
          "the floor ratchets down as the epic waves evict each cluster into its owning extension.",
        occurrences: sortKeys(occurrences),
        ...(committed.sdkNamesNote !== undefined ? { sdkNamesNote: committed.sdkNamesNote } : {}),
        ...(committed.sdkNames !== undefined ? { sdkNames: committed.sdkNames } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  return total;
}

function main() {
  const args = process.argv.slice(2);
  const baseRef = process.env.VENDOR_TOKEN_BASE;
  let words;
  try {
    words = loadBorderWords(REPO_ROOT);
  } catch (err) {
    const why = err instanceof BorderWordsError ? err.message : err?.stack ?? String(err);
    console.error(`[vendor-token-core-gate] scanner error: ${why}`);
    process.exit(2);
  }
  if (words.problems.length) {
    console.error(`[vendor-token-core-gate] FAIL — ${words.problems.length} border-word problem(s) (cinatra#4848):`);
    words.problems.forEach((p) => console.error("  ! " + p));
    process.exit(1);
  }
  words.warnings.forEach((w) => console.warn(`[vendor-token-core-gate] warning: ${w}`));
  const current = scanVendorTokens(REPO_ROOT, listFiles(REPO_ROOT), words.words.vendor);
  const totalOcc = Object.values(current).reduce((a, b) => a + b, 0);
  const totalFiles = new Set(Object.keys(current).map((k) => k.split(" :: ")[0])).size;

  if (args.includes("--write-baseline")) {
    // SHRINK-ONLY: refuse to write a baseline that grows any key vs the
    // committed one. Move the vendor-specific code into its owning extension
    // (connector repos materialize under extensions/<scope>/<name> in dev)
    // instead of re-baselining it.
    if (existsSync(BASELINE_PATH)) {
      const committed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).occurrences ?? {};
      // Byte identity is read at the base reference only: without VENDOR_TOKEN_BASE
      // nothing is admitted (a file committed with a new edge is identical at HEAD).
      const isUnchangedAtBase =
        baseRef && !baseRef.startsWith("-") ? (rel) => fileUnchangedAtRef(REPO_ROOT, baseRef, rel) : () => false;
      const grown = admittedGrowth(committed, current, { isUnchangedAtBase });
      if (grown.length) {
        console.error(
          `[vendor-token-core-gate] FAIL — refusing to write a GROWN baseline (the floor is shrink-only; ` +
            `evict the vendor-specific code into its owning extension instead of re-baselining it — epic cinatra-ai/cinatra#978):`,
        );
        grown.forEach((e) => console.error("  + " + e));
        process.exit(1);
      }
    }
    const total = writeBaselineFile(current);
    console.log(
      `[vendor-token-core-gate] baseline written — ${total} occurrence(s) across ${totalFiles} file(s).`,
    );
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error("[vendor-token-core-gate] FAIL — no baseline. Run with --write-baseline first.");
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).occurrences ?? {};

  // Monotonic guard: the committed baseline must be a subset of the base
  // branch's (it may only shrink — no regenerate-to-pass) except the admitted
  // word-born key, and the bridge's vendor list may only shrink. Fails CLOSED
  // on flag-like or unresolvable refs.
  if (baseRef) {
    if (baseRef.startsWith("-")) {
      console.error(`[vendor-token-core-gate] FAIL — VENDOR_TOKEN_BASE="${baseRef}" is flag-like.`);
      process.exit(1);
    }
    let refResolves = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "ignore", "ignore"],
      });
      refResolves = true;
    } catch {
      refResolves = false;
    }
    if (!refResolves) {
      console.error(
        `[vendor-token-core-gate] FAIL — VENDOR_TOKEN_BASE="${baseRef}" did not resolve ` +
          `(shallow checkout / misconfig?). Failing closed. Ensure the base ref is fetched (fetch-depth: 0).`,
      );
      process.exit(1);
    }
    let baseText = null;
    try {
      baseText = execFileSync(
        "git",
        ["show", `${baseRef}:scripts/audit/vendor-token-core-gate.baseline.json`],
        { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      baseText = null; // ref resolves but file absent → introducing PR, no constraint
    }
    let baseBridge;
    try {
      baseBridge = bridgeAtRef(REPO_ROOT, baseRef);
    } catch (err) {
      console.error(`[vendor-token-core-gate] FAIL — ${err.message}`);
      process.exit(1);
    }
    const bridgeGrew = baseBridge ? bridgeGrowth(baseBridge, words.bridge).filter((g) => g.startsWith("vendor: ") || g.startsWith("packages: ")) : [];
    if (bridgeGrew.length) {
      console.error(
        `[vendor-token-core-gate] FAIL — the border-word bridge GREW vs ${baseRef} (shrink-only: a pack declares its own words, and a newly pinned pack declares; cinatra#4848):`,
      );
      bridgeGrew.forEach((e) => console.error("  + " + e));
      process.exit(1);
    }
    const bridgeDropped = baseBridge ? bridgeShrinkProblems(baseBridge, words).filter((g) => g.startsWith("vendor: ")) : [];
    if (bridgeDropped.length) {
      console.error(
        `[vendor-token-core-gate] FAIL — word(s) left the border-word bridge vs ${baseRef} without a pinned pack declaring them ` +
          `in the same list (a word leaves the bridge only into a cinatra.borderWords declaration; cinatra#4848):`,
      );
      bridgeDropped.forEach((e) => console.error("  - " + e));
      process.exit(1);
    }
    if (baseText) {
      const grew = admittedGrowth(JSON.parse(baseText).occurrences ?? {}, baseline, {
        isUnchangedAtBase: (rel) => fileUnchangedAtRef(REPO_ROOT, baseRef, rel),
      });
      if (grew.length) {
        console.error(
          `[vendor-token-core-gate] FAIL — committed baseline GREW vs ${baseRef} ` +
            `(shrink-only: the residual floor only ratchets down — no regenerate can raise it):`,
        );
        grew.forEach((e) => console.error("  + " + e));
        process.exit(1);
      }
    }
  }

  const grown = diffGrown(baseline, current);
  if (grown.length) {
    console.error(
      `[vendor-token-core-gate] FAIL — ${grown.length} NEW vendor-token occurrence(s) in core:`,
    );
    grown.forEach((e) => console.error("  + " + e));
    console.error("");
    console.error(
      "Core owns integration MECHANISM, never vendor CODE (epic cinatra-ai/cinatra#978).\n" +
        "Do not add vendor-specific files, route segments, or import edges under src/ or\n" +
        "packages/: move the code into its owning extension (connector repos materialize\n" +
        "as editable workspace source under extensions/<scope>/<name> in dev — same\n" +
        "checkout, same `pnpm dev`), and reach it through the manifest/registry/capability\n" +
        "mechanism (the nango-system model: register at activation, resolve lazily,\n" +
        "fail-loud degradation). A genuinely sanctioned identity surface must be\n" +
        "enumerated in scripts/audit/extension-coupling-gates.md via a reviewed change to\n" +
        "this gate — the committed baseline cannot grow.",
    );
    process.exit(1);
  }

  const stale = diffShrunk(baseline, current);
  if (stale.length) {
    console.error(
      `[vendor-token-core-gate] FAIL — ${stale.length} STALE baseline entr${stale.length === 1 ? "y" : "ies"} ` +
        `(the floor shrank — ratchet it down so the headroom cannot be re-spent):\n` +
        `  node scripts/audit/vendor-token-core-gate.mjs --write-baseline`,
    );
    stale.forEach((e) => console.error("  - " + e));
    process.exit(1);
  }

  // The SDK's exported names (cinatra#4875): both word lists.
  let sdk;
  try {
    sdk = checkSdkNames(REPO_ROOT, { words: [...words.words.vendor, ...words.words.domain] });
  } catch (err) {
    const why = err instanceof SdkNamesError ? err.message : err?.stack ?? String(err);
    console.error(`[vendor-token-core-gate] scanner error (${SDK_NAME_CLASS}): ${why}`);
    process.exit(2);
  }
  if (!sdk.ok) {
    sdk.lines.forEach((l) => console.error(l));
    process.exit(1);
  }
  sdk.guardLines.forEach((l) => console.log(l));
  console.log(
    `[vendor-token-core-gate] OK — ${Object.keys(sdk.found).length} recorded ${SDK_NAME_CLASS} name(s) in ${SDK_PACKAGE_DIRS.join(", ")}; 0 new.`,
  );

  console.log(
    `[vendor-token-core-gate] OK — ${totalOcc} tolerated vendor-token occurrence(s) across ${totalFiles} file(s); 0 new; ` +
      `${words.words.vendor.length} vendor word(s) (${words.bridge.vendor.length} from the bridge) over ${words.packCount} pinned pack(s) ` +
      `(shrink-only residual floor — epic cinatra-ai/cinatra#978; sanctioned surfaces enumerated in scripts/audit/extension-coupling-gates.md).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
