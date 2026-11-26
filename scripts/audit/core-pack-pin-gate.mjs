#!/usr/bin/env node
// Core test pack-pin check (cinatra#4853, part of cinatra#3087: every extension
// draws its own work).
//
// THE RULE IS LEXICAL. Every git-tracked core test or JSON fixture (under
// `src/`, `packages/` or `docker/`, in a test or fixture directory or named
// `*.test.*`, `*.spec.*` or `*.fixture.*`) is read for its strings: a
// TypeScript/JavaScript file through the TypeScript parser (string literals
// and the cooked text of template parts; comments are dropped), a JSON fixture
// parsed (every string value and every key). A string is a finding when it
// CONTAINS, without case and at a token boundary, a pinned extension's package
// name `@scope/name`, its tree path `extensions/scope/name` (`/` or `\`), or 7
// or more leading hex digits of a pinned commit (`resolvedSha`). The pinned
// extensions are the rows of the two committed locks.
//
// One exemption, by structure: the module specifier of an `import type` /
// `export type` declaration and of an `import("...")` type. Nothing else is
// read from the syntax tree. A name or path that code assembles from separate
// strings is NOT seen (scripts/audit/extension-coupling-gates.md lists the
// limits). A tracked symbolic link is a finding by itself (a linked fixture
// cannot be judged); a file that does not parse fails the check.
//
// THE LIST (core-pack-pin-gate.baseline.json) holds, per file, the count of
// findings per pinned package. It only shrinks: a count above the list fails;
// a count below it fails until --write-baseline lowers it; the writer never
// raises a count; the list is compared with the base branch through
// lib/floor-base-guard.mjs (CORE_PACK_PIN_BASE, else GITHUB_BASE_REF).
//
// Exit 0 clean, 1 raised / stale / grown list, 2 scanner error. Flags: --report, --write-baseline.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { PULL_REQUEST_BASE_VAR, compareFloorWithBase, raisedCounts, readFileAtBase } from "./lib/floor-base-guard.mjs";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const GATE_REL = "scripts/audit/core-pack-pin-gate.mjs";
export const BASELINE_REL = "scripts/audit/core-pack-pin-gate.baseline.json";
export const FLOOR_BASE_VAR = "CORE_PACK_PIN_BASE";
export const LOCKS = ["cinatra-required-extensions.lock.json", "cinatra-dev-extensions.lock.json"];
export const CORE_ROOTS = ["src", "packages", "docker"];
export const TEST_DIRS = new Set(["__tests__", "__fixtures__", "__mocks__", "tests", "test", "fixtures"]);
export const SHA_PREFIX_MIN = 7;
export const LINK = "(symbolic link)";
const TAG = "[core-pack-pin-gate]";
const NOTE =
  "Shrink-only list of findings in core tests and JSON fixtures: per file, the count of mentions of each pinned pack (cinatra#4853). " +
  "Lower it with `node scripts/audit/core-pack-pin-gate.mjs --write-baseline`; never raise it.";

export class ScannerError extends Error {}

/** The pinned packs: `[{ name: "@scope/name", sha }]`, lower case. Fails closed on a missing or empty lock. */
export function loadPinnedPacks(root = REPO_ROOT) {
  const rows = [];
  for (const lock of LOCKS) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(root, lock), "utf8"));
    } catch (e) {
      throw new ScannerError(`${TAG} the lock ${lock} cannot be read (${e.message}); the check fails closed`);
    }
    const named = (doc?.packages ?? []).filter((r) => /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(r?.packageName ?? ""));
    if (named.length === 0) throw new ScannerError(`${TAG} the lock ${lock} names no package; the check fails closed`);
    for (const r of named) {
      const sha = /^[0-9a-f]{40}$/i.test(r.resolvedSha ?? "") ? r.resolvedSha.toLowerCase() : null;
      rows.push({ name: r.packageName.toLowerCase(), sha });
    }
  }
  return rows;
}

/** True when the repo-relative path is a core test or JSON fixture file. */
export function isCoreTestPath(rel) {
  const parts = rel.split("/");
  const base = parts[parts.length - 1];
  if (!CORE_ROOTS.includes(parts[0]) || !/\.(?:[cm]?[jt]sx?|json)$/.test(base) || base.endsWith(".d.ts")) return false;
  return parts.slice(0, -1).some((p) => TEST_DIRS.has(p)) || /\.(?:test|spec)\.[^.]+$/.test(base) || /\.fixture\./.test(base);
}

/** Every git-tracked core test and fixture: `[{ rel, link }]`, sorted. */
export function listCoreTestFiles(root = REPO_ROOT) {
  let out;
  try {
    out = execFileSync("git", ["ls-files", "-s", "-z", "--", ...CORE_ROOTS], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    throw new ScannerError(`${TAG} git ls-files failed (${e.message}); the check fails closed`);
  }
  const files = new Map();
  for (const entry of out.split("\0")) {
    const m = /^(\d+) [0-9a-f]+ \d+\t(.+)$/.exec(entry);
    if (!m || m[1] === "160000" || !isCoreTestPath(m[2])) continue; // 160000: a submodule, no file
    files.set(m[2], { rel: m[2], link: m[1] === "120000" });
  }
  return [...files.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// A character that continues a package or path name. A `.` continues one only
// when a name character follows it (`demo-agent.json`), not at a sentence end.
const BEFORE = "(?<![a-z0-9._-])";
const AFTER = "(?![a-z0-9_-]|\\.[a-z0-9_-])";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The matchers of a pinned set: one regex per package, one for sha prefixes. */
export function matchersOf(pinned) {
  const names = [...new Set(pinned.map((r) => r.name))];
  return {
    names: names.map((name) => {
      const [scope, short] = name.slice(1).split("/");
      return { name, re: new RegExp(`${BEFORE}(?:${esc(name)}|extensions[/\\\\]${esc(scope)}[/\\\\]${esc(short)})${AFTER}`, "gi") };
    }),
    sha: new RegExp(`${BEFORE}[0-9a-f]{${SHA_PREFIX_MIN},40}${AFTER}`, "gi"),
    shas: /* one row per (package, commit): both locks may pin it */ [...new Map(pinned.filter((r) => r.sha).map((r) => [`${r.name} ${r.sha}`, r])).values()],
  };
}

/** The findings in ONE string: `Map<package, count>` added into `into`. */
export function mentionsIn(text, matchers, into = new Map()) {
  const add = (name, n) => n && into.set(name, (into.get(name) ?? 0) + n);
  for (const { name, re } of matchers.names) add(name, [...text.matchAll(re)].length);
  for (const m of text.matchAll(matchers.sha)) {
    const prefix = m[0].toLowerCase();
    for (const r of matchers.shas) if (r.sha.startsWith(prefix)) add(r.name, 1);
  }
  return into;
}

/** The strings of a TypeScript/JavaScript file, except a type-only load's specifier. Throws when it does not parse. */
export function stringsOfScript(rel, text) {
  const kind = /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : /\.jsx$/.test(rel) ? ts.ScriptKind.JSX : /\.[cm]?ts$/.test(rel) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const diag = sf.parseDiagnostics ?? [];
  if (diag.length) {
    const d = diag[0];
    throw new ScannerError(`${TAG} ${rel} does not parse (${ts.flattenDiagnosticMessageText(d.messageText, " ")} at offset ${d.start}); the check fails closed`);
  }
  const out = [];
  const visit = (node) => {
    const typeOnlyLoad =
      (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) ||
      (ts.isExportDeclaration(node) && node.isTypeOnly) ||
      (ts.isImportEqualsDeclaration(node) && node.isTypeOnly) ||
      ts.isImportTypeNode(node);
    if (typeOnlyLoad) return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every string value and every key of a JSON fixture. Throws when it does not parse. */
export function stringsOfJson(rel, text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new ScannerError(`${TAG} ${rel} does not parse as JSON (${e.message}); the check fails closed`);
  }
  const out = [];
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); stack.push(x); }
  }
  return out;
}

/** The live findings: `{ "<file> :: <package>": count }`. */
export function scanCorePins(root = REPO_ROOT, { pinned = loadPinnedPacks(root), files = listCoreTestFiles(root) } = {}) {
  const matchers = matchersOf(pinned);
  const counts = {};
  for (const { rel, link } of files) {
    if (link) {
      counts[keyOf(rel, LINK)] = 1;
      continue;
    }
    let text;
    try {
      text = readFileSync(join(root, rel), "utf8");
    } catch (e) {
      throw new ScannerError(`${TAG} ${rel} cannot be read (${e.code ?? e.message}); the check fails closed`);
    }
    const strings = rel.endsWith(".json") ? stringsOfJson(rel, text) : stringsOfScript(rel, text);
    const found = new Map();
    for (const s of strings) mentionsIn(s, matchers, found);
    for (const [name, n] of found) counts[keyOf(rel, name)] = n;
  }
  return counts;
}

export const keyOf = (file, pack) => `${file} :: ${pack}`;
/** The list as `{ key: count }`; throws on a list that is not one. */
export function parseFloor(text) {
  const doc = JSON.parse(text);
  if (!doc?.files || typeof doc.files !== "object" || Array.isArray(doc.files)) throw new Error("the list has no `files` object");
  const flat = {};
  for (const [file, packs] of Object.entries(doc.files)) {
    if (!packs || typeof packs !== "object" || Array.isArray(packs)) throw new Error(`the list entry of ${file} is not { package: count }`);
    for (const [pack, n] of Object.entries(packs)) {
      if (!Number.isInteger(n) || n < 1) throw new Error(`the count of ${keyOf(file, pack)} is not a positive integer`);
      flat[keyOf(file, pack)] = n;
    }
  }
  return flat;
}

function floorDoc(flat) {
  const files = {};
  for (const k of Object.keys(flat).sort()) {
    const i = k.lastIndexOf(" :: ");
    (files[k.slice(0, i)] ??= {})[k.slice(i + 4)] = flat[k];
  }
  return { note: NOTE, files };
}

/** Counts above the list (`added`) and below it (`stale`), as `key (list -> live)` lines. */
export function checkFloor(floor, live) {
  const stale = [];
  for (const [k, n] of Object.entries(floor)) if ((live[k] ?? 0) < n) stale.push(`${k} (${n} -> ${live[k] ?? 0})`);
  return { added: raisedCounts(floor, live), stale: stale.sort() };
}

/** The list compared with its copy on the base; a base without the list and the check is the introducing change. */
export function checkBaseGuard({ root = REPO_ROOT, env = process.env, headFloor }) {
  const result = compareFloorWithBase({
    gate: "core-pack-pin-gate",
    envVar: FLOOR_BASE_VAR,
    floorPath: BASELINE_REL,
    headFloor,
    parse: parseFloor,
    grown: raisedCounts,
    repoRoot: root,
    env,
  });
  if (result.status === "unreadable" && result.ref && !readFileAtBase(root, result.ref, BASELINE_REL).ok) {
    const gateAtBase = readFileAtBase(root, result.ref, GATE_REL);
    if (!gateAtBase.ok && /is not on the base/.test(gateAtBase.reason)) {
      return {
        status: "introducing",
        ok: true,
        ref: result.ref,
        lines: [`${TAG} floor base guard: the base "${result.ref}" holds neither ${BASELINE_REL} nor the check — the introducing change; nothing to compare.`],
      };
    }
  }
  return result;
}

function readHeadFloor(root) {
  const p = join(root, BASELINE_REL);
  if (!existsSync(p)) return { problem: `the list ${BASELINE_REL} is missing; an absent list is not an empty one` };
  try {
    return { floor: parseFloor(readFileSync(p, "utf8")) };
  } catch (e) {
    return { problem: `the list ${BASELINE_REL} is not a readable list (${e.message})` };
  }
}

/** The whole check: `{ ok, lines, live, added, stale }`. */
export function runGate({ root = REPO_ROOT, env = process.env } = {}) {
  const head = readHeadFloor(root);
  if (head.problem) return { ok: false, lines: [`${TAG} FAIL — ${head.problem}.`] };
  const guard = checkBaseGuard({ root, env, headFloor: head.floor });
  const lines = [...guard.lines];
  const live = scanCorePins(root);
  const { added, stale } = checkFloor(head.floor, live);
  if (added.length) {
    lines.push(
      `${TAG} FAIL — ${added.length} core test or fixture count(s) above the shrink-only list: a string names a pinned pack. ` +
        "Use a made-up pack in a neutral scope; a proof of one pack belongs in that pack's own CI (scripts/audit/extension-coupling-gates.md):",
      ...added.map((k) => `  + ${k}`),
    );
  }
  if (stale.length) lines.push(`${TAG} FAIL — ${stale.length} count(s) fell below the list; run --write-baseline to lower it:`, ...stale.map((k) => `  - ${k}`));
  const ok = guard.ok && !added.length && !stale.length;
  const total = Object.values(live).reduce((a, b) => a + b, 0);
  if (ok) lines.push(`${TAG} OK — ${total} finding(s) in ${new Set(Object.keys(live).map((k) => k.split(" :: ")[0])).size} file(s), all inside the shrink-only list.`);
  return { ok, lines, live, added, stale };
}

/**
 * The shrink-only writer: each count becomes the least of the live count, the
 * committed list's and (when a base is named) the base list's. A missing,
 * unreadable, `null` or malformed list is refused, except on the introducing
 * change (the base holds neither the list nor the check), whose live counts
 * seed it. A live count above what may be written is refused: the run fails.
 */
export function writeBaseline({ root = REPO_ROOT, env = process.env } = {}) {
  const refuse = (...why) => ({ ok: false, lines: why.map((w) => `${TAG} --write-baseline REFUSED — ${w}`) });
  const head = readHeadFloor(root);
  const base = checkBaseGuard({ root, env, headFloor: {} });
  if (base.status === "unreadable") return refuse(...base.lines.map((l) => l.replace(/^\[[^\]]*\] /, "")));
  let allowed = head.floor ?? null;
  if (head.problem) {
    if (base.status === "no-base") {
      return refuse(`${head.problem}. Seeding needs the base: set ${FLOOR_BASE_VAR} (or ${PULL_REQUEST_BASE_VAR} on a pull request) to the base the change lands on.`);
    }
    if (base.status !== "introducing") return refuse(`${head.problem}; the base "${base.ref}" holds the list. Restore it from the base and shrink that.`);
  }
  if (base.status === "held") {
    allowed = Object.fromEntries(Object.entries(allowed).map(([k, n]) => [k, Math.min(n, base.baseFloor[k] ?? 0)]));
  }
  const live = scanCorePins(root);
  const keep = {};
  const refused = [];
  for (const [k, n] of Object.entries(live)) {
    const cap = allowed ? (allowed[k] ?? 0) : n;
    if (cap > 0) keep[k] = Math.min(n, cap);
    if (n > cap) refused.push(`${k} (${cap} -> ${n})`);
  }
  const doc = floorDoc(keep);
  writeFileSync(join(root, BASELINE_REL), JSON.stringify(doc, null, 2) + "\n");
  const lines = [
    ...base.lines,
    allowed ? `${TAG} list written (${Object.keys(keep).length} entries, shrink only).` : `${TAG} list SEEDED (${Object.keys(keep).length} entries): the base "${base.ref}" holds neither the list nor the check.`,
  ];
  if (refused.length) lines.push(`${TAG} --write-baseline REFUSED ${refused.length} count(s) above the list${base.status === "held" ? " or its base copy" : ""} — the list only shrinks:`, ...refused.sort().map((k) => `  ! ${k}`));
  return { ok: refused.length === 0, lines, floor: keep };
}

function main() {
  const args = process.argv.slice(2);
  const result = args.includes("--write-baseline") ? writeBaseline() : runGate();
  if (args.includes("--report") && result.live) for (const [k, n] of Object.entries(result.live).sort()) console.log(`  ${n}  ${k}`);
  for (const line of result.lines) (result.ok ? console.log : console.error)(line);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof ScannerError ? e.message : e);
    process.exit(2);
  }
}
