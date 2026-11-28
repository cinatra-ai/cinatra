#!/usr/bin/env node
// Declared text core gate — stages 1 and 2 (cinatra#4533).
//
// THE RULE. An extension supplies its own user-facing text and core renders
// it. Core code must not spell, word for word, a sentence that a pinned
// extension declares.
//
// WHAT THE GATE READS.
//   CORE SIDE — application code (`src/` and every `packages/*/src`), with the
//     scope and the exemptions of the application border gate (its own
//     `isInScope`, `isExemptFile` and `listScanFiles`; no second list). Each
//     module is parsed with the TypeScript parser; a module that does not
//     parse is a scanner error. The texts read are: a string literal, a
//     template literal without a substitution, and a JSX text, in any
//     position.
//   EXTENSION SIDE — the JSON declarations of every package the two locks and
//     `cinatra.devExtensions` pin (lib/border-words.mjs `pinnedPackageNames`),
//     found under `extensions/` by its manifest name (the produces gate's
//     `discoverExtensionDirs`): `package.json` `description` and every string
//     value under its `cinatra` field; every string value of `cinatra/**/*.json`
//     and of every `*.oas.json` in the package (HITL steps included). A test or
//     fixture path is not read (`isExtensionTestOrFixturePath`: a directory
//     segment `test`, `tests`, `__tests__`, `fixtures`, `__fixtures__`,
//     `__mocks__` or `__stubs__`, or a base name `*.test.json`, `*.spec.json`,
//     `*.fixture.json`, also before `.oas.json`), and neither is `node_modules/`
//     or a dot directory. The package's own `package.json` is always read.
//   EXTENSION CODE (stage 2) — in the same packages, the code files
//     (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) under the package's `src/` and
//     `cinatra/` folders (`isExtensionCodePath`), parsed with the TypeScript
//     parser, with the core side's reading: a string literal, a template
//     literal without a substitution, a JSX text. A test or fixture path is not
//     read (the same `isExtensionTestOrFixturePath`, which also knows the code
//     test forms the pinned tree has: `*.test.ts`, `*.test.tsx`); declaration
//     files (`.d.ts`, `.d.mts`, `.d.cts`) are not read. A code file that does
//     not parse is a scanner error naming it.
//
// THE COMPARISON. Both sides collapse every run of whitespace to one space and
// trim. A text counts only with at least 20 characters, at least 4 words, a
// capital letter and no template syntax (`{{`, `}}`, `${`, `{%`, `%}`, `<%`,
// `%>`). A core text matches when it EQUALS a counted declared text.
//
// FAIL CLOSED (exit 2, never a pass): no pinned package, an absent extension
// tree, a pinned package not found under `extensions/` by its manifest name,
// two directories naming one pinned package, an unreadable manifest or
// directory, a declaration file that does not parse, a pinned tree that
// declares no counted text, a core module that does not parse.
//
// THE FLOOR (declared-text-core-gate.baseline.json) holds today's matches,
// key `<file> :: <text>` with its count, in two sections: `matches` (the core
// text equals a text of the JSON declarations, stage 1) and `codeMatches` (the
// core text equals a literal of the extension code and no JSON declaration,
// stage 2). Each section only shrinks: a new key or a grown count fails; a key
// whose count fell is STALE and fails until `--write-baseline` ratchets it
// down; `--write-baseline` never writes a grown floor. DECLARED_TEXT_FLOOR_BASE
// =<ref> (or the pull request's base branch) also refuses a committed floor
// that grew against the base, with the shared floor base guard
// (lib/floor-base-guard.mjs). A base floor without the `codeMatches` section
// (a base whose gate does not read extension code) seeds that section once, in
// the change that adds it; a head that drops the section after it reached the
// base fails. `matches` is compared with the base in every case.
//
// Usage:
//   node scripts/audit/declared-text-core-gate.mjs                  # check
//   node scripts/audit/declared-text-core-gate.mjs --write-baseline # ratchet the floor down
// Exit 0 = clean, 1 = findings, 2 = scanner error.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import tsDefault from "typescript";
import { isExemptFile, isInScope, listScanFiles } from "./application-border-gate.mjs";
import { discoverExtensionDirs } from "./extension-produces-deps-gate.mjs";
import { pinnedPackageNames } from "./lib/border-words.mjs";
import { compareFloorWithBase, raisedCounts, readFileAtBase, reportFloorGuard } from "./lib/floor-base-guard.mjs";

const ts = tsDefault;
const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..");
export const FLOOR_REL = "scripts/audit/declared-text-core-gate.baseline.json";
export const GATE_REL = "scripts/audit/declared-text-core-gate.mjs";
export const FLOOR_BASE_VAR = "DECLARED_TEXT_FLOOR_BASE";
const GATE = "declared-text-core-gate";
const SYNC_HINT =
  "clone the extension tree back first (scripts/ci/sync-dev-extensions.mjs --pinned; CI: the clone-extensions action)";

export const MIN_CHARS = 20;
export const MIN_WORDS = 4;
export const TEMPLATE_SYNTAX_RE = /\{\{|\}\}|\$\{|\{%|%\}|<%|%>/;
const CAPITAL_RE = /\p{Lu}/u;

const FLOOR_NOTE =
  "declared-text-core-gate (cinatra#4533) — core string literals and JSX texts equal to a user-facing text a " +
  "pinned extension declares (`matches`: its JSON declarations; `codeMatches`: its own code literals). Each section " +
  "only shrinks: a new or grown entry fails. Lower it with " +
  "`node scripts/audit/declared-text-core-gate.mjs --write-baseline` once the text leaves core.";

export class DeclaredTextScanError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeclaredTextScanError";
  }
}

/** Every run of whitespace collapsed to one space, trimmed. */
export function collapseWhitespace(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

/** Does a collapsed text count (length, words, a capital, no template syntax)? */
export function isCountedText(text) {
  return (
    text.length >= MIN_CHARS &&
    text.split(" ").length >= MIN_WORDS &&
    CAPITAL_RE.test(text) &&
    !TEMPLATE_SYNTAX_RE.test(text)
  );
}

function readJsonOrThrow(path, what) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new DeclaredTextScanError(`${what} is unreadable: ${path}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new DeclaredTextScanError(`${what} does not parse: ${path} (${err?.message ?? err})`);
  }
}

/**
 * The pinned packages, found under `extensionsRoot` by their manifest name.
 * Returns [{ name, dir }] sorted by name. Throws DeclaredTextScanError on an
 * absent or partial tree, an unreadable manifest, or a pinned name found twice.
 */
export function locatePinnedPackages(repoRoot, extensionsRoot = join(repoRoot, "extensions")) {
  const pinned = pinnedPackageNames(repoRoot);
  if (pinned.size === 0) {
    throw new DeclaredTextScanError("no pinned extension package (the locks and cinatra.devExtensions name none).");
  }
  const dirs = discoverExtensionDirs(extensionsRoot);
  if (dirs.length === 0) {
    throw new DeclaredTextScanError(`no extension package under ${extensionsRoot} — ${SYNC_HINT}.`);
  }
  const found = new Map();
  for (const dir of dirs) {
    const pkg = readJsonOrThrow(join(dir, "package.json"), "an extension manifest");
    if (!pkg || typeof pkg.name !== "string" || !pkg.name) {
      throw new DeclaredTextScanError(`the extension manifest at ${dir} names no package — ${SYNC_HINT}.`);
    }
    if (!pinned.has(pkg.name)) continue;
    if (found.has(pkg.name)) {
      throw new DeclaredTextScanError(`two extension directories name the pinned package ${pkg.name}: ${found.get(pkg.name)} and ${dir}.`);
    }
    found.set(pkg.name, dir);
  }
  const missing = [...pinned].filter((n) => !found.has(n)).sort();
  if (missing.length) {
    throw new DeclaredTextScanError(
      `${missing.length} pinned package(s) not found under ${extensionsRoot}: ${missing.join(", ")} — ${SYNC_HINT}.`,
    );
  }
  return [...found.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, dir]) => ({ name, dir }));
}

/** Directory segments that make a package-relative path a test or fixture path. */
export const TEST_FIXTURE_DIRS = new Set(["test", "tests", "__tests__", "fixtures", "__fixtures__", "__mocks__", "__stubs__"]);
/** Base names of a test or fixture JSON file (also before `.oas.json`). */
const TEST_FIXTURE_JSON_RE = /\.(?:test|spec|fixture)(?:\.oas)?\.json$/;
/** Base names of a test code file: the forms the pinned tree has (`*.test.ts`, `*.test.tsx`). */
const TEST_CODE_RE = /\.test\.tsx?$/;

/**
 * Is a package-relative path a test or fixture path (extension side only)?
 * True when any directory segment is in TEST_FIXTURE_DIRS, or when the base
 * name is `*.test.json`, `*.spec.json`, `*.fixture.json` (also `*.test.oas.json`,
 * `*.spec.oas.json`, `*.fixture.oas.json`), `*.test.ts` or `*.test.tsx`.
 */
export function isExtensionTestOrFixturePath(rel) {
  const segments = rel.split("/");
  const base = segments.pop();
  return segments.some((s) => TEST_FIXTURE_DIRS.has(s)) || TEST_FIXTURE_JSON_RE.test(base) || TEST_CODE_RE.test(base);
}

const CODE_FILE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION_TYPES_RE = /\.d\.(?:ts|mts|cts)$/;

/**
 * Is a package-relative path an extension code file stage 2 reads? A code
 * file (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) under the package's `src/` or
 * `cinatra/` folder, not a declaration file (`.d.ts`, `.d.mts`, `.d.cts`) and
 * not a test or fixture path.
 */
export function isExtensionCodePath(rel) {
  if (!(rel.startsWith("src/") || rel.startsWith("cinatra/"))) return false;
  if (!CODE_FILE_RE.test(rel) || DECLARATION_TYPES_RE.test(rel)) return false;
  return !isExtensionTestOrFixturePath(rel);
}

/** Is a package-relative JSON path a declaration stage 1 reads (beside package.json)? */
export function isDeclarationPath(rel) {
  if (!rel.endsWith(".json") || isExtensionTestOrFixturePath(rel)) return false;
  return rel.startsWith("cinatra/") || rel.endsWith(".oas.json");
}

/** The declaration files of one package, package-relative, sorted. */
export function declarationFiles(packDir) {
  return packageFiles(packDir, isDeclarationPath);
}

/** The extension code files of one package (stage 2), package-relative, sorted. */
export function extensionCodeFiles(packDir) {
  return packageFiles(packDir, isExtensionCodePath);
}

/** The files of one package whose package-relative path `keep` accepts, sorted; no node_modules, no dot directory. */
function packageFiles(packDir, keep) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      throw new DeclaredTextScanError(`an extension directory is unreadable: ${abs}`);
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(abs, e.name), childRel);
      else if (e.isFile() && keep(childRel)) out.push(childRel);
    }
  };
  walk(packDir, "");
  return out.sort();
}

/** Every string value (not key) under `value`, appended to `out`. */
export function stringValues(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringValues(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringValues(v, out);
  return out;
}

/**
 * The counted declared texts of the given packages.
 * Returns Map<collapsed text, sorted package names>.
 */
export function readDeclaredTexts(packages) {
  const owners = new Map();
  const add = (raw, name) => {
    const text = collapseWhitespace(raw);
    if (!isCountedText(text)) return;
    const set = owners.get(text) ?? new Set();
    set.add(name);
    owners.set(text, set);
  };
  for (const { name, dir } of packages) {
    const manifest = readJsonOrThrow(join(dir, "package.json"), "an extension manifest");
    for (const s of stringValues([manifest.description, manifest.cinatra])) add(s, name);
    for (const rel of declarationFiles(dir)) {
      for (const s of stringValues(readJsonOrThrow(join(dir, rel), "an extension declaration"))) add(s, name);
    }
  }
  return new Map([...owners.entries()].map(([t, s]) => [t, [...s].sort()]));
}

function scriptKindOf(rel) {
  if (/\.tsx$/.test(rel)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(rel)) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(rel)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * The collapsed texts of one core module's string literals, substitution-free
 * template literals and JSX texts, with their counts. Throws
 * DeclaredTextScanError when the module does not parse.
 */
export function coreTexts(rel, source) {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, scriptKindOf(rel));
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length > 0) {
    const d = diags[0];
    const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    throw new DeclaredTextScanError(`${rel}:${line + 1} does not parse (${ts.flattenDiagnosticMessageText(d.messageText, " ")})`);
  }
  const counts = new Map();
  const visit = (node) => {
    let raw = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) raw = node.text;
    else if (ts.isJsxText(node)) raw = node.text;
    if (raw !== null) {
      const text = collapseWhitespace(raw);
      if (text) counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return counts;
}

/**
 * The counted texts of the given packages' own code (stage 2): the string
 * literals, substitution-free template literals and JSX texts of
 * `extensionCodeFiles`. Returns Map<collapsed text, sorted package names>.
 * Throws DeclaredTextScanError naming a code file that is unreadable or does
 * not parse.
 */
export function readExtensionCodeTexts(packages) {
  const owners = new Map();
  for (const { name, dir } of packages) {
    for (const rel of extensionCodeFiles(dir)) {
      const abs = join(dir, rel);
      let source;
      try {
        source = readFileSync(abs, "utf8");
      } catch {
        throw new DeclaredTextScanError(`an extension code file is unreadable: ${abs}`);
      }
      let texts;
      try {
        texts = coreTexts(rel, source);
      } catch (err) {
        if (!(err instanceof DeclaredTextScanError)) throw err;
        throw new DeclaredTextScanError(`an extension code file of ${name}: ${abs.replace(/\\/g, "/")} — ${err.message}`);
      }
      for (const text of texts.keys()) {
        if (!isCountedText(text)) continue;
        const set = owners.get(text) ?? new Set();
        set.add(name);
        owners.set(text, set);
      }
    }
  }
  return new Map([...owners.entries()].map(([t, s]) => [t, [...s].sort()]));
}

/**
 * Scan core against the declared texts. Options (injectable for tests):
 * `files` (repo-relative), `extensionsRoot`, `declared`, `codeTexts` (an
 * injected `declared` without `codeTexts` reads no extension code).
 * A core text equal to a JSON-declared text is a `matches` entry; one equal
 * only to an extension code literal is a `codeMatches` entry.
 * Returns { matches, codeMatches: {key: count}, owners: {key: package names},
 * packageCount, declaredCount, codeTextCount }.
 */
export function scanDeclaredTextCore(repoRoot = REPO_ROOT, options = {}) {
  let declared = options.declared;
  let codeTexts = options.codeTexts ?? (declared ? new Map() : null);
  let packageCount = null;
  if (!declared || !codeTexts) {
    const packages = locatePinnedPackages(repoRoot, options.extensionsRoot);
    packageCount = packages.length;
    if (!declared) {
      declared = readDeclaredTexts(packages);
      if (declared.size === 0) {
        throw new DeclaredTextScanError(`the ${packages.length} pinned package(s) declare no counted text — ${SYNC_HINT}.`);
      }
    }
    if (!codeTexts) codeTexts = readExtensionCodeTexts(packages);
  }
  const files = options.files ?? listScanFiles(repoRoot);
  const matches = {};
  const codeMatches = {};
  const owners = {};
  for (const rel of [...files].sort()) {
    if (!isInScope(rel) || isExemptFile(rel)) continue;
    const abs = join(repoRoot, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    for (const [text, n] of coreTexts(rel, readFileSync(abs, "utf8"))) {
      const key = `${rel} :: ${text}`;
      if (declared.has(text)) {
        matches[key] = n;
        owners[key] = declared.get(text);
      } else if (codeTexts.has(text)) {
        codeMatches[key] = n;
        owners[key] = codeTexts.get(text);
      }
    }
  }
  return {
    matches: sortKeys(matches),
    codeMatches: sortKeys(codeMatches),
    owners,
    packageCount,
    declaredCount: declared.size,
    codeTextCount: codeTexts.size,
  };
}

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Parse a floor text: `{ note, matches: { key: positive integer } }`. Throws on any other shape. */
export function parseFloor(text) {
  return parseFloorDocument(text).matches;
}

function checkSection(doc, section) {
  const value = doc[section];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`the floor has no \`${section}\` object`);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`the floor entry "${k}" has no positive integer count`);
    out[k] = v;
  }
  return out;
}

/**
 * Parse a floor text with both sections: `{ matches, codeMatches }`.
 * `codeMatches` is null when the floor has no such section (a floor written
 * before stage 2); present, it has the shape of `matches`. Throws otherwise.
 */
export function parseFloorDocument(text) {
  const doc = JSON.parse(text);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("the floor has no `matches` object");
  const matches = checkSection(doc, "matches");
  const codeMatches = Object.prototype.hasOwnProperty.call(doc, CODE_SECTION) ? checkSection(doc, CODE_SECTION) : null;
  return { matches, codeMatches };
}

/** The floor section of the stage 2 source (extension code literals). */
export const CODE_SECTION = "codeMatches";

/** Compare live matches with the floor: { grown: [lines], stale: [lines] }. */
export function checkFloor(floor, live) {
  const grown = raisedCounts(floor, live);
  const stale = [];
  for (const [k, c] of Object.entries(floor)) {
    const now = Object.prototype.hasOwnProperty.call(live, k) ? live[k] : 0;
    if (now < c) stale.push(`${k} (${c} -> ${now})`);
  }
  return { grown, stale: stale.sort() };
}

/** The floor `--write-baseline` writes: each committed count lowered to the live one, never raised. */
export function ratchetFloor(floor, live) {
  const out = {};
  for (const [k, c] of Object.entries(floor)) {
    const now = Object.prototype.hasOwnProperty.call(live, k) ? live[k] : 0;
    const v = Math.min(c, now);
    if (v > 0) out[k] = v;
  }
  return sortKeys(out);
}

/** The floor file's text; `codeMatches` undefined writes a floor without that section (a stage 1 floor). */
export function floorDocument(matches, codeMatches) {
  const doc = { note: FLOOR_NOTE, matches: sortKeys(matches) };
  if (codeMatches !== undefined) doc[CODE_SECTION] = sortKeys(codeMatches);
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Growth of a head floor against a base floor, both `{ matches, codeMatches }`.
 * `matches` grows by a new key or a raised count. `codeMatches` the same, with
 * two cases of its own: a base without the section (its gate does not read
 * extension code) seeds it, so nothing in it is growth; a head without the
 * section after the base has it is growth (the section is never removed).
 */
export function floorGrowth(base, head) {
  const lines = raisedCounts(base.matches, head.matches);
  if (base.codeMatches === null) return lines;
  if (head.codeMatches === null) {
    lines.push(`${CODE_SECTION}: the section is removed (it is on the base; a section is never removed)`);
    return lines;
  }
  for (const g of raisedCounts(base.codeMatches, head.codeMatches)) lines.push(`${CODE_SECTION}: ${g}`);
  return lines;
}

/**
 * The committed floor against the base (lib/floor-base-guard.mjs). A base that
 * holds neither the floor nor this script is the introducing change and passes.
 * `headFloor` is the head's `matches`; `headCodeFloor` its `codeMatches`
 * (undefined or null: the head has no such section).
 */
export function checkFloorAgainstBase({ repoRoot = REPO_ROOT, env = process.env, headFloor, headCodeFloor = null }) {
  const head = { matches: headFloor, codeMatches: headCodeFloor ?? null };
  const result = compareFloorWithBase({
    gate: GATE,
    envVar: FLOOR_BASE_VAR,
    floorPath: FLOOR_REL,
    headFloor: head,
    parse: (text) => parseFloorDocument(text),
    grown: (base, h) => floorGrowth(base, h),
    repoRoot,
    env,
  });
  if (result.ok && result.baseFloor && result.baseFloor.codeMatches === null && head.codeMatches !== null) {
    result.lines.push(
      `[${GATE}] floor base guard: the base floor has no ${CODE_SECTION} section — this change seeds it with ` +
        `${Object.keys(head.codeMatches).length} entr(ies); once on the base it only shrinks.`,
    );
  }
  if (result.status !== "unreadable" || !result.ref) return result;
  const floorAtBase = readFileAtBase(repoRoot, result.ref, FLOOR_REL);
  const gateAtBase = readFileAtBase(repoRoot, result.ref, GATE_REL);
  if (floorAtBase.ok || gateAtBase.ok) return result;
  if (/did not resolve/.test(floorAtBase.reason ?? "")) return result;
  return {
    status: "introducing",
    ok: true,
    ref: result.ref,
    lines: [`[${GATE}] floor base guard: the base "${result.ref}" holds neither ${FLOOR_REL} nor ${GATE_REL} — this change introduces the gate.`],
  };
}

/**
 * The check of the test of record: the live matches against the committed
 * floor, and the committed floor against the base (on a pull request's run the
 * base is origin/<GITHUB_BASE_REF>; a base that cannot be read fails closed;
 * no pull request and no base named passes the guard). Throws on a scanner
 * error or an unreadable floor. Returns `{ grown, stale, guard }`.
 */
export function checkRecord({ repoRoot = REPO_ROOT, env = process.env } = {}) {
  const floor = parseFloorDocument(readFileSync(join(repoRoot, FLOOR_REL), "utf8"));
  const scan = scanDeclaredTextCore(repoRoot);
  const { grown, stale } = checkBothSections(floor, scan);
  const guard = checkFloorAgainstBase({ repoRoot, env, headFloor: floor.matches, headCodeFloor: floor.codeMatches });
  return { grown, stale, guard };
}

/**
 * Both sections against the live scan: `matches` unprefixed, `codeMatches`
 * lines prefixed `codeMatches: `. A floor without the code section holds none
 * of its entries. Returns `{ grown, stale }`.
 */
export function checkBothSections(floor, scan) {
  const first = checkFloor(floor.matches, scan.matches);
  const code = checkFloor(floor.codeMatches ?? {}, scan.codeMatches);
  const tag = (l) => `${CODE_SECTION}: ${l}`;
  return { grown: [...first.grown, ...code.grown.map(tag)], stale: [...first.stale, ...code.stale.map(tag)] };
}

/** The owners of a grown or stale line's key. */
function ownersOf(scan, line) {
  const key = line.replace(new RegExp(`^${CODE_SECTION}: `), "").replace(/ \(\d+ -> \d+\)$/, "");
  return (scan.owners[key] ?? []).join(", ");
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/** The command line. Returns the exit code. */
export function main(argv = process.argv.slice(2), { env = process.env, out = console } = {}) {
  const repoRoot = resolve(argValue(argv, "--repo-root") ?? REPO_ROOT);
  const floorPath = join(repoRoot, FLOOR_REL);
  let scan;
  try {
    scan = scanDeclaredTextCore(repoRoot);
  } catch (err) {
    out.error(`[${GATE}] SCANNER ERROR — ${err instanceof DeclaredTextScanError ? err.message : err?.stack ?? err}`);
    return 2;
  }
  let floor = null;
  if (existsSync(floorPath)) {
    try {
      floor = parseFloorDocument(readFileSync(floorPath, "utf8"));
    } catch (err) {
      out.error(`[${GATE}] SCANNER ERROR — ${FLOOR_REL} is not a readable floor (${err?.message ?? err})`);
      return 2;
    }
  }
  if (argv.includes("--write-baseline")) {
    // Each section is ratcheted down; a section the floor does not hold yet
    // (no floor, or a floor without `codeMatches`) is written from the live
    // scan. The base guard admits such a seed only where the base lacks it.
    const next = floor === null ? scan.matches : ratchetFloor(floor.matches, scan.matches);
    const nextCode = floor?.codeMatches ? ratchetFloor(floor.codeMatches, scan.codeMatches) : scan.codeMatches;
    writeFileSync(floorPath, floorDocument(next, nextCode));
    const refused =
      floor === null
        ? []
        : checkBothSections({ matches: floor.matches, codeMatches: floor.codeMatches ?? scan.codeMatches }, scan).grown;
    out.log(
      `[${GATE}] wrote ${FLOOR_REL} (${Object.keys(next).length} + ${Object.keys(nextCode).length} ${CODE_SECTION} entries).`,
    );
    if (refused.length) {
      out.error(`[${GATE}] FAIL — the floor is never raised; these stay refused:`);
      for (const g of refused) out.error(`  + ${g}  (declared by ${ownersOf(scan, g)})`);
      return 1;
    }
    return 0;
  }
  if (floor === null) {
    out.error(`[${GATE}] SCANNER ERROR — ${FLOOR_REL} is missing.`);
    return 2;
  }
  let failed = false;
  const { grown, stale } = checkBothSections(floor, scan);
  if (grown.length) {
    failed = true;
    out.error(`[${GATE}] FAIL — core spells a text an extension declares (the extension supplies its own text):`);
    for (const g of grown) out.error(`  + ${g}  (declared by ${ownersOf(scan, g)})`);
  }
  if (stale.length) {
    failed = true;
    out.error(`[${GATE}] FAIL — stale floor entries; lower the floor with --write-baseline:`);
    for (const s of stale) out.error(`  - ${s}`);
  }
  const guard = checkFloorAgainstBase({ repoRoot, env, headFloor: floor.matches, headCodeFloor: floor.codeMatches });
  if (!reportFloorGuard(guard, out)) failed = true;
  if (failed) return 1;
  const total = Object.keys(scan.matches).length + Object.keys(scan.codeMatches).length;
  out.log(
    `[${GATE}] OK — ${total} recorded match(es) (${Object.keys(scan.matches).length} declaration, ` +
      `${Object.keys(scan.codeMatches).length} extension code) over ${scan.packageCount} pinned package(s), ` +
      `${scan.declaredCount} counted declared text(s), ${scan.codeTextCount} counted extension code text(s); no new or grown match.`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
