#!/usr/bin/env node
// Declared text core gate — stage 1 (cinatra#4533).
//
// THE RULE. An extension supplies its own user-facing text and core renders
// it. Core code must not spell, word for word, a sentence that a pinned
// extension declares.
//
// WHAT STAGE 1 READS.
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
//     and of every `*.oas.json` in the package (HITL steps included). A path the
//     application border gate exempts (tests, fixtures, doubles) is not read,
//     and neither is `node_modules/` or a dot directory.
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
// key `<file> :: <text>` with its count, and only shrinks: a new key or a
// grown count fails; a key whose count fell is STALE and fails until
// `--write-baseline` ratchets it down; `--write-baseline` never writes a
// grown floor. DECLARED_TEXT_FLOOR_BASE=<ref> (or the pull request's base
// branch) also refuses a committed floor that grew against the base, with the
// shared floor base guard (lib/floor-base-guard.mjs).
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
  "pinned extension declares. It only shrinks: a new or grown entry fails. Lower it with " +
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

/** Is a package-relative JSON path a declaration stage 1 reads (beside package.json)? */
export function isDeclarationPath(rel) {
  if (!rel.endsWith(".json") || isExemptFile(rel)) return false;
  return rel.startsWith("cinatra/") || rel.endsWith(".oas.json");
}

/** The declaration files of one package, package-relative, sorted. */
export function declarationFiles(packDir) {
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
      else if (e.isFile() && isDeclarationPath(childRel)) out.push(childRel);
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
 * Scan core against the declared texts. Options (injectable for tests):
 * `files` (repo-relative), `extensionsRoot`, `declared`.
 * Returns { matches: {key: count}, owners: {key: package names}, packageCount, declaredCount }.
 */
export function scanDeclaredTextCore(repoRoot = REPO_ROOT, options = {}) {
  let declared = options.declared;
  let packageCount = null;
  if (!declared) {
    const packages = locatePinnedPackages(repoRoot, options.extensionsRoot);
    packageCount = packages.length;
    declared = readDeclaredTexts(packages);
    if (declared.size === 0) {
      throw new DeclaredTextScanError(`the ${packages.length} pinned package(s) declare no counted text — ${SYNC_HINT}.`);
    }
  }
  const files = options.files ?? listScanFiles(repoRoot);
  const matches = {};
  const owners = {};
  for (const rel of [...files].sort()) {
    if (!isInScope(rel) || isExemptFile(rel)) continue;
    const abs = join(repoRoot, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    for (const [text, n] of coreTexts(rel, readFileSync(abs, "utf8"))) {
      if (!declared.has(text)) continue;
      const key = `${rel} :: ${text}`;
      matches[key] = n;
      owners[key] = declared.get(text);
    }
  }
  return { matches: sortKeys(matches), owners, packageCount, declaredCount: declared.size };
}

function sortKeys(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Parse a floor text: `{ note, matches: { key: positive integer } }`. Throws on any other shape. */
export function parseFloor(text) {
  const doc = JSON.parse(text);
  if (!doc || typeof doc !== "object" || !doc.matches || typeof doc.matches !== "object" || Array.isArray(doc.matches)) {
    throw new Error("the floor has no `matches` object");
  }
  for (const [k, v] of Object.entries(doc.matches)) {
    if (!Number.isInteger(v) || v < 1) throw new Error(`the floor entry "${k}" has no positive integer count`);
  }
  return doc.matches;
}

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

export function floorDocument(matches) {
  return `${JSON.stringify({ note: FLOOR_NOTE, matches: sortKeys(matches) }, null, 2)}\n`;
}

/**
 * The committed floor against the base (lib/floor-base-guard.mjs). A base that
 * holds neither the floor nor this script is the introducing change and passes.
 */
export function checkFloorAgainstBase({ repoRoot = REPO_ROOT, env = process.env, headFloor }) {
  const result = compareFloorWithBase({
    gate: GATE,
    envVar: FLOOR_BASE_VAR,
    floorPath: FLOOR_REL,
    headFloor,
    parse: (text) => parseFloor(text),
    grown: (base, head) => raisedCounts(base, head),
    repoRoot,
    env,
  });
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
  const floor = parseFloor(readFileSync(join(repoRoot, FLOOR_REL), "utf8"));
  const scan = scanDeclaredTextCore(repoRoot);
  const { grown, stale } = checkFloor(floor, scan.matches);
  const guard = checkFloorAgainstBase({ repoRoot, env, headFloor: floor });
  return { grown, stale, guard };
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
  const live = scan.matches;
  let floor = null;
  if (existsSync(floorPath)) {
    try {
      floor = parseFloor(readFileSync(floorPath, "utf8"));
    } catch (err) {
      out.error(`[${GATE}] SCANNER ERROR — ${FLOOR_REL} is not a readable floor (${err?.message ?? err})`);
      return 2;
    }
  }
  if (argv.includes("--write-baseline")) {
    const next = floor === null ? live : ratchetFloor(floor, live);
    writeFileSync(floorPath, floorDocument(next));
    const refused = floor === null ? [] : checkFloor(floor, live).grown;
    out.log(`[${GATE}] wrote ${FLOOR_REL} (${Object.keys(next).length} entries).`);
    if (refused.length) {
      out.error(`[${GATE}] FAIL — the floor is never raised; these stay refused:`);
      for (const g of refused) out.error(`  + ${g}  (declared by ${(scan.owners[g.replace(/ \(\d+ -> \d+\)$/, "")] ?? []).join(", ")})`);
      return 1;
    }
    return 0;
  }
  if (floor === null) {
    out.error(`[${GATE}] SCANNER ERROR — ${FLOOR_REL} is missing.`);
    return 2;
  }
  let failed = false;
  const { grown, stale } = checkFloor(floor, live);
  if (grown.length) {
    failed = true;
    out.error(`[${GATE}] FAIL — core spells a text an extension declares (the extension supplies its own text):`);
    for (const g of grown) out.error(`  + ${g}  (declared by ${(scan.owners[g.replace(/ \(\d+ -> \d+\)$/, "")] ?? []).join(", ")})`);
  }
  if (stale.length) {
    failed = true;
    out.error(`[${GATE}] FAIL — stale floor entries; lower the floor with --write-baseline:`);
    for (const s of stale) out.error(`  - ${s}`);
  }
  if (!reportFloorGuard(checkFloorAgainstBase({ repoRoot, env, headFloor: floor }), out)) failed = true;
  if (failed) return 1;
  out.log(
    `[${GATE}] OK — ${Object.keys(live).length} recorded match(es) over ${scan.packageCount} pinned package(s), ` +
      `${scan.declaredCount} counted declared text(s); no new or grown match.`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
