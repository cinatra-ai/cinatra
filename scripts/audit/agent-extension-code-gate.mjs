#!/usr/bin/env node
/**
 * Agent extension code gate (cinatra#4885): an extension of kind `agent` ships
 * no program code of its own outside its skills.
 *
 * Owner: "functionality that should be done by agents has been built as code,
 * which totally goes against the whole purpose of Cinatra." and "Of course,
 * skills could also include scripts and here code is ok." A connector may hold
 * code (it wraps an outside system); a generic guarantee belongs in core.
 *
 * THE RULE decides from STRUCTURE only: the manifest's `cinatra.kind`, the
 * files that exist in the pack, the string values of its manifests (what they
 * name, never what for), npm's packing rules, and the parsed flow. It never reads what code does. It names no pack, no tool and no file of
 * a pack. Three finding classes, each its own section of the recorded list:
 *
 *  1. `codeFiles` — in a pack of kind `agent`, a file whose extension is in
 *     PROGRAM_CODE_EXTENSIONS, anywhere in the pack, EXCEPT
 *       - a file inside a SKILL FOLDER (a folder of the pack, never the pack
 *         root itself, that holds a file named `SKILL.md`, at any depth below
 *         that folder) that NO MANIFEST NAMES;
 *       - a file for which all three hold: npm does NOT SHIP it (see
 *         `npmShips`: the `files` list plus npm's always-included `main` and
 *         `bin` targets; no readable `files` list ships everything), NO
 *         MANIFEST NAMES it (see `namedPaths`: any string value anywhere in
 *         `package.json` or in a `cinatra/` JSON file that resolves to its
 *         path, whatever the key), and it is a TEST or BUILD file by its place
 *         or name (see `isTestOrBuildFile`).
 *     Key: the file's path in the pack (forward slashes).
 *  2. `toolDeclarations` — any pinned pack whose manifest declares
 *     `cinatra.tools` (the code modules core loads and runs in its own server
 *     process). Every value of the key counts (see `toolDeclarationKeys`).
 *     Key: the declared tool name, the first time a local-identifier name
 *     appears; `cinatra.tools[<i>]` for any other entry (a repeated name
 *     included); `cinatra.tools.<key>` per key of an object map;
 *     `cinatra.tools` for any other non-null value.
 *  3. `extensionToolSteps` — any pinned pack whose flow (`cinatra/oas.json`,
 *     parsed) has a step calling the core tool `extension_tool`, read
 *     LEXICALLY (see `collectToolSteps`): every object of the parsed file, at
 *     any depth, whose own `data` (an object, or a string that parses to one)
 *     holds `tool` equal to `extension_tool`. No URL, node kind or namespace is
 *     read. Each step has its position (JSON path); the list records, per pack
 *     and flow file, the COUNT of such steps (the ratchet) and the sorted
 *     `id -> module` lines (information). One more step anywhere fails,
 *     whatever its id.
 *     An UNREADABLE step fails always and is never recorded: a string `data`
 *     that does not parse to an object and names `extension_tool`, or, in an
 *     ApiNode-shaped object, a `tool` that is not a plain string or holds a
 *     template.
 *
 * ALSO COUNTED, NEVER FAILED: the steps of every agent's flow that name any
 * tool (the same lexical reading, one per position), printed per agent so a
 * later change can ratchet them.
 *
 * THE UNIVERSE is the pinned extensions: every `packageName` of
 * cinatra-dev-extensions.lock.json and cinatra-required-extensions.lock.json,
 * plus every key of `cinatra.devExtensions` in the root package.json, each found
 * in the materialized `extensions/` tree BY ITS MANIFEST NAME. A pinned pack
 * that cannot be found or read, a lock or manifest that does not parse, and a
 * pack whose `cinatra.kind` cannot be read are scanner errors (exit 2), never a
 * pass.
 *
 * THE RECORDED LIST (agent-extension-code-gate.baseline.json) holds today's
 * findings and only shrinks:
 *   - a finding the list does not hold fails;
 *   - a listed entry whose finding is gone is STALE and fails until
 *     `--write-baseline` shrinks the list (it refuses to write a list that
 *     grows, except the first write of an absent file);
 *   - the list is compared with its copy on the base branch through the shared
 *     guard scripts/audit/lib/floor-base-guard.mjs: a new entry or a removed
 *     class fails. The change that introduces this gate has a base holding
 *     neither the list nor this script: that one case passes as the seed.
 *   `notes` carries the road each entry leaves by; it is never diffed.
 *
 * WHAT IT CANNOT DECIDE: whether code in a connector is domain behaviour,
 * whether a function in core is generic, whether a screen renderer is
 * presentation or behaviour. Those stay with a reading by a person.
 *
 * Usage:
 *   node scripts/audit/agent-extension-code-gate.mjs                  # check
 *   node scripts/audit/agent-extension-code-gate.mjs --report         # every finding and count, exit 0 unless a scanner error
 *   node scripts/audit/agent-extension-code-gate.mjs --write-baseline # write the list (shrink only)
 *   AGENT_EXTENSION_CODE_BASE=<ref> ...                                # the base for the floor base guard
 *
 * Exit codes: 0 = clean, 1 = findings / stale or grown list, 2 = scanner error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

import { compareFloorWithBase, readFileAtBase, reportFloorGuard } from "./lib/floor-base-guard.mjs";

const GATE = "agent-extension-code";

/** The recorded list, repo-relative. */
export const FLOOR_FILE = "scripts/audit/agent-extension-code-gate.baseline.json";

/** This script, repo-relative (the seed rule reads it at the base). */
export const GATE_FILE = "scripts/audit/agent-extension-code-gate.mjs";

/** The gate's own base variable for the floor base guard. */
export const FLOOR_BASE_VAR = "AGENT_EXTENSION_CODE_BASE";

export const LOCK_FILES = ["cinatra-dev-extensions.lock.json", "cinatra-required-extensions.lock.json"];

/** The finding classes, in report order. A class is never removed from the list. */
export const FINDING_CLASSES = ["codeFiles", "toolDeclarations", "extensionToolSteps"];

/**
 * Program code, by file extension: the JavaScript and TypeScript forms node and
 * the bundler load (the same set core-extension-border-gate's SOURCE_EXTENSIONS
 * scans in core), plus Python and shell, the two other interpreters a script
 * can be written for. Compared in lower case. `.d.ts` ends in `.ts` and counts.
 */
export const PROGRAM_CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx", ".py", ".sh"]);

/** The file that makes a folder a skill folder. */
export const SKILL_FILE = "SKILL.md";

/** The core tool a fixed flow step calls to run a pack's declared code module. */
export const EXTENSION_TOOL = "extension_tool";

/** The class recorded as a count per pack and flow file (the others as keys). */
const COUNTED_CLASS = "extensionToolSteps";

/** The flow file of a pack, the one the product loads. */
const FLOW_FILE = "cinatra/oas.json";

/** A declared tool name in the product's vocabulary (LOCAL_IDENT_RE of packages/sdk-extensions/src/manifest.ts). */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** The folder of a pack whose JSON files are manifests too (read at any depth). */
const MANIFEST_DIR = "cinatra";

/** Directories never walked: installed dependencies and git data. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

/** Folders that hold a pack's tests, at any depth. */
const TEST_DIRS = new Set(["test", "tests", "__tests__", "__mocks__", "__fixtures__"]);

/** The top-level folder of a pack's build and check scripts. */
const BUILD_DIR = "scripts";

const SAFE_SCOPED_PKG_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const GLOB_CHARS_RE = /[*?[\]{}]/;

export class ScannerError extends Error {}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** True when `relPath` (forward slashes) names program code by its extension. */
export function isProgramCode(relPath) {
  const base = posix.basename(relPath).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 && PROGRAM_CODE_EXTENSIONS.has(base.slice(dot));
}

/**
 * True when `relPath` is a test or build file of the pack, by its place or name:
 *   - test: under a folder named test, tests, __tests__, __mocks__ or
 *     __fixtures__ (any depth), or named `*.test.*` / `*.spec.*`;
 *   - build: a file at the pack root (the pack's own check and build-config
 *     scripts sit there), or under the top-level `scripts/` folder, or under a
 *     top-level folder whose name starts with a dot.
 * Such a file is left out ONLY when the manifest does not ship it.
 */
export function isTestOrBuildFile(relPath) {
  const parts = relPath.split("/");
  const name = parts[parts.length - 1];
  if (/\.(test|spec)\.[^.]+$/.test(name)) return true;
  if (parts.slice(0, -1).some((p) => TEST_DIRS.has(p))) return true;
  if (parts.length === 1) return true;
  return parts[0] === BUILD_DIR || parts[0].startsWith(".");
}

/**
 * Read a manifest's `files` list. Returns `{ readable: true, include, exclude }`
 * with plain normalised paths, or `{ readable: false, reason }` when the list is
 * absent, not an array of strings, or holds a glob (this reader does not
 * evaluate globs, so it treats the whole pack as shipped).
 */
export function readFilesList(packageJson) {
  const files = packageJson?.files;
  if (files === undefined) return { readable: false, reason: "no `files` list (everything ships)" };
  if (!Array.isArray(files)) return { readable: false, reason: "`files` is not an array" };
  const include = [];
  const exclude = [];
  for (const raw of files) {
    if (typeof raw !== "string") return { readable: false, reason: "`files` holds a non-string entry" };
    const negated = raw.startsWith("!");
    const body = negated ? raw.slice(1) : raw;
    if (GLOB_CHARS_RE.test(body)) return { readable: false, reason: `\`files\` holds the glob ${JSON.stringify(raw)}` };
    const norm = posix.normalize(body.replace(/\\/g, "/")).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (norm === "" || norm === "." || norm.startsWith("../") || norm === "..") {
      return { readable: false, reason: `\`files\` holds the entry ${JSON.stringify(raw)}` };
    }
    (negated ? exclude : include).push(norm);
  }
  return { readable: true, include, exclude };
}

const underOrAt = (relPath, entry) => relPath === entry || relPath.startsWith(`${entry}/`);

/** True when the manifest ships `relPath`; an unreadable `files` list ships everything. */
export function shippedBy(filesList, relPath) {
  if (!filesList.readable) return true;
  if (!filesList.include.some((e) => underOrAt(relPath, e))) return false;
  return !filesList.exclude.some((e) => underOrAt(relPath, e));
}

/**
 * True when npm packs `relPath` for this manifest. npm's packing rules: with no
 * readable `files` list everything ships; otherwise the list ships its entries,
 * and npm ALWAYS adds (whatever `files` says) package.json, README, LICENSE /
 * LICENCE, the file in `main` and the file(s) in `bin`. Only `main` and `bin`
 * can name code. `exports`, `module`, `types` and `browser` targets ship only
 * through `files` (each is a manifest name anyway, see `namedPaths`).
 */
export function npmShips(packageJson, filesList, relPath) {
  if (shippedBy(filesList, relPath)) return true;
  const always = [];
  if (typeof packageJson?.main === "string") always.push(packageJson.main);
  const bin = packageJson?.bin;
  if (typeof bin === "string") always.push(bin);
  else if (bin && typeof bin === "object" && !Array.isArray(bin)) {
    for (const v of Object.values(bin)) if (typeof v === "string") always.push(v);
  }
  return always.some((v) => normaliseRef(v) === relPath);
}

/**
 * A manifest string value as a pack path: the part before any `?` or `#`,
 * back slashes as forward slashes, normalised, without a leading `./` or `/`.
 * Returns null for a value that is empty or leaves the pack.
 */
function normaliseRef(value, baseDir = ".") {
  const pathPart = value.split(/[?#]/, 1)[0].trim().replace(/\\/g, "/");
  if (pathPart === "") return null;
  const joined = posix.normalize(posix.join(baseDir, pathPart.replace(/^\/+/, "")));
  const rel = joined.replace(/^(\.\/)+/, "");
  if (rel === "" || rel === "." || rel === ".." || rel.startsWith("../")) return null;
  return rel;
}

/** Every string value in a parsed JSON value, at any depth (object keys are not values). */
function stringValues(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringValues(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringValues(v, out);
  return out;
}

/**
 * The pack paths a manifest names: every string value of `package.json` (any
 * key, `cinatra` and its future keys included) and of each JSON file under the
 * pack's `cinatra/` folder (`manifestJson`: pack path -> parsed value), resolved
 * against the pack root AND against the folder of the file that holds it. A
 * value's query or fragment is dropped; `./`, a leading `/` and `..` steps are
 * normalised. A name without an extension also names the file it loads as
 * (`<name><ext>` and `<name>/index<ext>` for each PROGRAM_CODE_EXTENSIONS ext),
 * so the set errs towards counting.
 */
export function namedPaths(packageJson, manifestJson = {}) {
  const named = new Set();
  const add = (value, holderDir) => {
    for (const base of new Set([".", holderDir])) {
      const rel = normaliseRef(value, base);
      if (rel === null) continue;
      named.add(rel);
      for (const ext of PROGRAM_CODE_EXTENSIONS) {
        named.add(`${rel}${ext}`);
        named.add(`${rel}/index${ext}`);
      }
    }
  };
  for (const v of stringValues(packageJson)) add(v, ".");
  for (const [holder, parsed] of Object.entries(manifestJson)) {
    for (const v of stringValues(parsed)) add(v, posix.dirname(holder));
  }
  return named;
}

/**
 * The skill folders among a pack's files: every folder (never the pack root)
 * that directly holds a file named SKILL.md.
 */
export function skillFolders(relPaths) {
  const folders = new Set();
  for (const p of relPaths) {
    const dir = posix.dirname(p);
    if (posix.basename(p) === SKILL_FILE && dir !== ".") folders.add(dir);
  }
  return folders;
}

/** True when `relPath` lies inside one of `folders`. */
export function insideSkillFolder(relPath, folders) {
  let dir = posix.dirname(relPath);
  while (dir !== ".") {
    if (folders.has(dir)) return true;
    dir = posix.dirname(dir);
  }
  return false;
}

/**
 * The `codeFiles` findings of one agent pack. A code file is left out only
 * when no manifest names it AND either it lies in a skill folder, or npm does
 * not ship it and it is a test or build file by place or name. Sorted.
 * `manifestJson` maps each `cinatra/` JSON file's pack path to its parsed value.
 */
export function agentCodeFiles({ relPaths, packageJson, manifestJson = {} }) {
  const folders = skillFolders(relPaths);
  const filesList = readFilesList(packageJson);
  const named = namedPaths(packageJson, manifestJson);
  const out = [];
  for (const p of relPaths) {
    if (!isProgramCode(p)) continue;
    if (!named.has(p)) {
      if (insideSkillFolder(p, folders)) continue;
      if (!npmShips(packageJson, filesList, p) && isTestOrBuildFile(p)) continue;
    }
    out.push(p);
  }
  return out.sort();
}

/**
 * The `toolDeclarations` keys of one manifest (empty when it declares none).
 * The product (`parseDeclaredTools`, packages/sdk-extensions/src/manifest.ts)
 * accepts only an absent or `null` value (no tools) or an array of objects,
 * each with a `name` in its local-identifier vocabulary, each name once. This
 * reads EVERY value of the key, accepted or not, so nothing is skipped:
 *   - an entry whose `name` is a local identifier seen for the first time:
 *     the name;
 *   - any other entry (not an object, a bare string, a name missing, not an
 *     identifier, or a name declared a second time): `cinatra.tools[<i>]`;
 *   - an object map instead of a list: `cinatra.tools.<key>` per own key
 *     (`cinatra.tools` when it has none);
 *   - any other value: `cinatra.tools`.
 * A name key never holds a `.` or a `[`, so it cannot collide with the others.
 */
export function toolDeclarationKeys(packageJson) {
  const block = packageJson?.cinatra;
  if (!block || typeof block !== "object" || !Object.prototype.hasOwnProperty.call(block, "tools")) return [];
  const tools = block.tools;
  if (tools === null) return [];
  if (!Array.isArray(tools)) {
    if (typeof tools === "object") {
      const own = Object.keys(tools);
      return own.length > 0 ? own.map((k) => `cinatra.tools.${k}`).sort() : ["cinatra.tools"];
    }
    return ["cinatra.tools"];
  }
  const keys = [];
  const names = new Set();
  tools.forEach((t, i) => {
    const name = t && typeof t === "object" && !Array.isArray(t) ? t.name : undefined;
    if (typeof name === "string" && TOOL_NAME_RE.test(name) && !names.has(name)) {
      names.add(name);
      keys.push(name);
    } else {
      keys.push(`cinatra.tools[${i}]`);
    }
  });
  return keys.sort();
}

/** A JSON path step: `.key` for a plain key, `["key"]` otherwise, `[i]` for an index. */
function pathStep(key) {
  if (typeof key === "number") return `[${key}]`;
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * One object of a flow read as a tool step, LEXICALLY: its own `data` member,
 * as an object or as a string that parses as JSON to an object, holding an own
 * `tool`. Nothing about URLs, node kinds, namespaces or run-time resolution is
 * read. Returns null (no step), `{ id, tool, module }`, or `{ id, unreadable }`:
 *   - a string `data` that does not parse to an object and contains the name
 *     `extension_tool`: unreadable step data;
 *   - a `tool` that is not a plain string, or holds a template (`{{`), in an
 *     object of ApiNode shape (`url`, `http_method` or `component_type`
 *     ApiNode): unreadable tool name.
 */
function readStep(obj) {
  const id = typeof obj.id === "string" && obj.id !== "" ? obj.id : typeof obj.name === "string" && obj.name !== "" ? obj.name : "(no id)";
  let data = obj.data;
  if (typeof data === "string") {
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = undefined;
    }
    if (isPlainObject(parsed)) data = parsed;
    else if (data.includes(EXTENSION_TOOL)) return { id, unreadable: `unreadable step data: a string that does not parse to an object names ${EXTENSION_TOOL}` };
    else return null;
  }
  if (!isPlainObject(data) || !hasOwn(data, "tool")) return null;
  const tool = data.tool;
  if (typeof tool === "string" && !tool.includes("{{")) {
    const module = isPlainObject(data.input) && typeof data.input.name === "string" ? data.input.name : "(no module name)";
    return { id, tool, module };
  }
  const apiShape = hasOwn(obj, "url") || hasOwn(obj, "http_method") || obj.component_type === "ApiNode";
  if (!apiShape) return null;
  return { id, unreadable: `unreadable tool name: data.tool is ${typeof tool === "string" ? `the template ${JSON.stringify(tool)}` : "not a plain string"}` };
}

/**
 * Every tool step of a parsed flow: one plain walk over the whole JSON value
 * (every object once, at any depth), each object read by `readStep`. Each step
 * carries its POSITION (its JSON path from the root, `$` first), never only its
 * id, so two steps with the same id anywhere are two steps. Document order.
 */
export function collectToolSteps(flow) {
  const steps = [];
  const visited = new WeakSet();
  const walk = (value, path) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}${pathStep(i)}`));
      return;
    }
    if (hasOwn(value, "data")) {
      const step = readStep(value);
      if (step) steps.push({ path, ...step });
    }
    for (const [k, v] of Object.entries(value)) walk(v, `${path}${pathStep(k)}`);
  };
  walk(flow, "$");
  return steps;
}

/**
 * One parsed flow's tool steps: `{ extensionToolSteps, unreadable, toolSteps }`.
 *   - `extensionToolSteps`: every step whose tool is `extension_tool`, as
 *     `{ path, id, module }` (`module` is `data.input.name`);
 *   - `unreadable`: every unreadable step, as `{ path, id, reason }`;
 *   - `toolSteps`: every readable step (any tool), as `id -> tool` lines,
 *     one per position, sorted.
 */
export function flowToolSteps(flow) {
  const extensionToolSteps = [];
  const unreadable = [];
  const toolSteps = [];
  for (const s of collectToolSteps(flow)) {
    if (s.unreadable) {
      unreadable.push({ path: s.path, id: s.id, reason: s.unreadable });
      continue;
    }
    toolSteps.push(`${s.id} -> ${s.tool}`);
    if (s.tool === EXTENSION_TOOL) extensionToolSteps.push({ path: s.path, id: s.id, module: s.module });
  }
  return { extensionToolSteps, unreadable, toolSteps: toolSteps.sort() };
}

/**
 * The recorded form of one flow's `extension_tool` steps: the COUNT (what the
 * ratchet reads) and the sorted `id -> module` lines (for information only).
 */
export function stepRecord(extensionToolSteps) {
  return { count: extensionToolSteps.length, steps: extensionToolSteps.map((s) => `${s.id} -> ${s.module}`).sort() };
}

/**
 * The entries of a class map as `pkg :: key` strings, sorted. For
 * `extensionToolSteps` the key is the flow file (its entry is a count).
 */
function keysOf(cls, map) {
  const out = [];
  for (const pkg of Object.keys(map ?? {})) {
    const entry = map[pkg] ?? (cls === COUNTED_CLASS ? {} : []);
    for (const key of cls === COUNTED_CLASS ? Object.keys(entry) : entry) out.push(`${pkg} :: ${key}`);
  }
  return out.sort();
}

/** The counts of a counted-class map: `pkg :: file` -> count. */
function countsOf(map) {
  const out = new Map();
  for (const pkg of Object.keys(map ?? {})) for (const [file, rec] of Object.entries(map[pkg] ?? {})) out.set(`${pkg} :: ${file}`, rec.count);
  return out;
}

/** The number of findings of a class (a counted class sums its counts). */
function findingCount(cls, map) {
  if (cls !== COUNTED_CLASS) return keysOf(cls, map).length;
  let n = 0;
  for (const c of countsOf(map).values()) n += c;
  return n;
}

/**
 * Per class: findings the list does not hold (`fresh`) and list entries no
 * finding matches (`stale`). For the counted class a flow whose count is above
 * the listed count (absent = 0) is fresh, below it stale.
 */
export function diffWithList(findings, list) {
  const result = Object.create(null);
  for (const cls of FINDING_CLASSES) {
    if (cls === COUNTED_CLASS) {
      const found = countsOf(findings[cls]);
      const listed = countsOf(list?.[cls]);
      const fresh = [];
      const stale = [];
      for (const k of new Set([...found.keys(), ...listed.keys()])) {
        const f = found.get(k) ?? 0;
        const l = listed.get(k) ?? 0;
        if (f > l) fresh.push(`${k}: ${f} step(s), the list holds ${l}`);
        else if (f < l) stale.push(`${k}: ${f} step(s), the list holds ${l}`);
      }
      result[cls] = { fresh: fresh.sort(), stale: stale.sort() };
      continue;
    }
    const found = new Set(keysOf(cls, findings[cls]));
    const listed = new Set(keysOf(cls, list?.[cls]));
    result[cls] = {
      fresh: [...found].filter((p) => !listed.has(p)).sort(),
      stale: [...listed].filter((p) => !found.has(p)).sort(),
    };
  }
  return result;
}

/**
 * Parse a recorded list. Every class must be present as an object; the
 * entries of `codeFiles` and `toolDeclarations` are arrays of strings, those of
 * `extensionToolSteps` objects mapping a flow file to `{ count, steps }`
 * (`count` a whole number >= 0, `steps` an array of strings). Anything else
 * throws (a list the gate cannot read is a list it cannot compare). Returns a
 * prototype-free copy of the class maps.
 */
export function parseList(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the list is not an object");
  const out = Object.create(null);
  for (const cls of FINDING_CLASSES) {
    const map = raw[cls];
    if (!isPlainObject(map)) throw new Error(`the class ${cls} is missing or not an object`);
    out[cls] = Object.create(null);
    for (const pkg of Object.keys(map)) {
      const entry = map[pkg];
      if (cls === COUNTED_CLASS) {
        if (!isPlainObject(entry)) throw new Error(`the entry ${cls}.${pkg} is not an object of flow files`);
        out[cls][pkg] = Object.create(null);
        for (const [file, rec] of Object.entries(entry)) {
          if (
            !isPlainObject(rec) ||
            !Number.isInteger(rec.count) ||
            rec.count < 0 ||
            !Array.isArray(rec.steps) ||
            rec.steps.some((s) => typeof s !== "string")
          ) {
            throw new Error(`the entry ${cls}.${pkg}.${file} is not { count, steps }`);
          }
          out[cls][pkg][file] = { count: rec.count, steps: [...rec.steps] };
        }
        continue;
      }
      if (!Array.isArray(entry) || entry.some((k) => typeof k !== "string")) {
        throw new Error(`the entry ${cls}.${pkg} is not an array of strings`);
      }
      out[cls][pkg] = [...entry];
    }
  }
  return out;
}

/**
 * Growth of the list against the base: an entry the base does not hold, a
 * flow whose count is above the base's (absent = 0), or a class the base holds
 * and the head does not. One line each, sorted.
 */
export function listGrowth(baseList, headList) {
  const lines = [];
  for (const cls of FINDING_CLASSES) {
    if (baseList?.[cls] && !headList?.[cls]) {
      lines.push(`[${cls}] the class is removed (a class is never removed)`);
      continue;
    }
    if (cls === COUNTED_CLASS) {
      const base = countsOf(baseList?.[cls]);
      for (const [k, n] of countsOf(headList?.[cls])) {
        const b = base.get(k) ?? 0;
        if (n > b) lines.push(`[${cls}] ${k}: ${n} step(s), the base holds ${b}`);
      }
      continue;
    }
    const base = new Set(keysOf(cls, baseList?.[cls]));
    for (const p of keysOf(cls, headList?.[cls])) if (!base.has(p)) lines.push(`[${cls}] ${p}`);
  }
  return lines.sort();
}


// ---------------------------------------------------------------------------
// The universe and the tree
// ---------------------------------------------------------------------------

function readJsonFile(path, label) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ScannerError(`cannot read ${label}: ${err?.code ?? err?.message ?? err}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ScannerError(`${label} is not JSON: ${err?.message ?? err}`);
  }
}

/** The pinned package names: both locks plus `cinatra.devExtensions`. Sorted. */
export function pinnedNames(repoRoot) {
  const names = new Set();
  for (const f of LOCK_FILES) {
    const lock = readJsonFile(join(repoRoot, f), f);
    if (!Array.isArray(lock?.packages)) throw new ScannerError(`${f} carries no packages array`);
    for (const p of lock.packages) {
      if (typeof p?.packageName !== "string" || !SAFE_SCOPED_PKG_RE.test(p.packageName)) {
        throw new ScannerError(`${f} holds an entry without a valid packageName (${JSON.stringify(p?.packageName)})`);
      }
      names.add(p.packageName);
    }
  }
  const root = readJsonFile(join(repoRoot, "package.json"), "package.json");
  const dev = root?.cinatra?.devExtensions;
  if (!dev || typeof dev !== "object" || Array.isArray(dev)) {
    throw new ScannerError("package.json carries no cinatra.devExtensions object");
  }
  for (const name of Object.keys(dev)) {
    if (!SAFE_SCOPED_PKG_RE.test(name)) throw new ScannerError(`cinatra.devExtensions names an invalid package ${JSON.stringify(name)}`);
    names.add(name);
  }
  if (names.size === 0) throw new ScannerError("the pinned universe is empty; refusing to pass vacuously");
  return [...names].sort();
}

function listDir(dir, label) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new ScannerError(`cannot read the directory ${label}: ${err?.code ?? err?.message ?? err}`);
  }
}

/**
 * Index the materialized tree by manifest name: `extensions/<scope>/<dir>`
 * holding a package.json. Returns a Map name -> { dir, rel }. A manifest that
 * does not parse or carries no name, and a name held by two directories, are
 * scanner errors.
 */
export function indexTree(repoRoot) {
  const extRoot = join(repoRoot, "extensions");
  if (!existsSync(extRoot)) {
    throw new ScannerError("no extensions/ tree: run `node scripts/ci/sync-dev-extensions.mjs --pinned` first (CI clones it)");
  }
  const byName = new Map();
  for (const scope of listDir(extRoot, "extensions")) {
    if (!scope.isDirectory() || SKIP_DIRS.has(scope.name) || scope.name.startsWith(".")) continue;
    for (const pack of listDir(join(extRoot, scope.name), `extensions/${scope.name}`)) {
      if (!pack.isDirectory() || SKIP_DIRS.has(pack.name) || pack.name.startsWith(".")) continue;
      const rel = `extensions/${scope.name}/${pack.name}`;
      const manifestPath = join(repoRoot, rel, "package.json");
      if (!existsSync(manifestPath)) continue;
      const pkg = readJsonFile(manifestPath, `${rel}/package.json`);
      if (typeof pkg?.name !== "string" || pkg.name === "") throw new ScannerError(`${rel}/package.json carries no name`);
      const prior = byName.get(pkg.name);
      if (prior) throw new ScannerError(`two directories carry the manifest name ${pkg.name}: ${prior.rel} and ${rel}`);
      byName.set(pkg.name, { dir: join(repoRoot, rel), rel, packageJson: pkg });
    }
  }
  return byName;
}

/** Every file of a pack, as normalised paths relative to the pack, sorted. */
export function packFiles(packDir, label) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of listDir(abs, rel ? `${label}/${rel}` : label)) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(abs, entry.name), childRel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(posix.normalize(childRel));
      }
    }
  };
  walk(packDir, "");
  return out.sort();
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export function scan(repoRoot) {
  const names = pinnedNames(repoRoot);
  const tree = indexTree(repoRoot);
  const findings = Object.create(null);
  for (const cls of FINDING_CLASSES) findings[cls] = Object.create(null);
  const toolStepCounts = new Map();
  const stepPositions = [];
  const unreadableSteps = [];
  const kinds = new Map();
  for (const name of names) {
    const entry = tree.get(name);
    if (!entry) throw new ScannerError(`the pinned pack ${name} is not in the extensions/ tree (no manifest carries that name)`);
    const { packageJson, dir, rel } = entry;
    const kind = packageJson?.cinatra?.kind;
    if (typeof kind !== "string" || kind === "") {
      throw new ScannerError(`the pinned pack ${name} (${rel}) has no readable cinatra.kind`);
    }
    kinds.set(name, kind);

    const tools = toolDeclarationKeys(packageJson);
    if (tools.length > 0) findings.toolDeclarations[name] = tools;

    const flowPath = join(dir, FLOW_FILE);
    if (existsSync(flowPath)) {
      const flow = readJsonFile(flowPath, `${rel}/${FLOW_FILE}`);
      const { extensionToolSteps, unreadable, toolSteps } = flowToolSteps(flow);
      if (extensionToolSteps.length > 0) {
        findings.extensionToolSteps[name] = { [FLOW_FILE]: stepRecord(extensionToolSteps) };
        for (const s of extensionToolSteps) stepPositions.push(`${name} :: ${FLOW_FILE} :: ${s.path} (${s.id} -> ${s.module})`);
      }
      for (const u of unreadable) unreadableSteps.push(`${name} :: ${FLOW_FILE} :: ${u.path} (${u.id}): ${u.reason}`);
      if (kind === "agent" && toolSteps.length > 0) toolStepCounts.set(name, toolSteps);
    }

    if (kind === "agent") {
      const relPaths = packFiles(dir, rel);
      const manifestJson = Object.create(null);
      for (const p of relPaths) {
        if (p.startsWith(`${MANIFEST_DIR}/`) && p.toLowerCase().endsWith(".json")) {
          manifestJson[p] = readJsonFile(join(dir, p), `${rel}/${p}`);
        }
      }
      const code = agentCodeFiles({ relPaths, packageJson, manifestJson });
      if (code.length > 0) findings.codeFiles[name] = code;
    }
  }
  const dirs = new Map([...tree].map(([n, e]) => [n, e.dir]));
  return {
    findings,
    toolStepCounts,
    stepPositions: stepPositions.sort(),
    unreadableSteps: unreadableSteps.sort(),
    kinds,
    packCount: names.length,
    dirs,
  };
}

// ---------------------------------------------------------------------------
// The base guard
// ---------------------------------------------------------------------------

function refResolves(repoRoot, ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The recorded list compared with its copy on the base (the shared guard).
 * One rule of this gate's own: a base that resolves and holds NEITHER the list
 * NOR this script is the introducing change, which seeds the list once.
 */
export function checkListAgainstBase({ repoRoot, headList, env = process.env }) {
  const result = compareFloorWithBase({
    gate: GATE,
    envVar: FLOOR_BASE_VAR,
    floorPath: FLOOR_FILE,
    headFloor: headList,
    parse: parseList,
    grown: listGrowth,
    repoRoot,
    env,
  });
  if (result.status !== "unreadable" || !result.ref || !refResolves(repoRoot, result.ref)) return result;
  if (readFileAtBase(repoRoot, result.ref, FLOOR_FILE).ok || readFileAtBase(repoRoot, result.ref, GATE_FILE).ok) return result;
  return {
    status: "introducing",
    ok: true,
    ref: result.ref,
    lines: [
      `[${GATE}] floor base guard: the base "${result.ref}" holds neither ${FLOOR_FILE} nor ${GATE_FILE} — ` +
        `this change introduces the gate, and its list is the seed.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const LIST_NOTE =
  "Agent extension code gate (cinatra#4885): today's program code in pinned agent extensions, recorded so it " +
  "can only shrink. `codeFiles` = a program-code file in a kind:agent pack outside a skill folder (unshipped test " +
  "and build files left out); `toolDeclarations` = a manifest declaring `cinatra.tools`; `extensionToolSteps` = a " +
  "flow step calling the core tool `extension_tool`, recorded per pack and flow file as a COUNT (the ratchet; one " +
  "more such step anywhere fails, whatever its id) plus its `id -> module` lines (information). An entry leaves " +
  "when its code leaves (then run " +
  "`node scripts/audit/agent-extension-code-gate.mjs --write-baseline`); an entry is never added and a class is " +
  "never removed. `notes` names the road each entry leaves by; it is not diffed.";

/** The line count of a `codeFiles` pair, for the report only ("?" when unreadable). */
function lineCount(dirs, pair) {
  const [pkg, rel] = pair.split(" :: ");
  try {
    const text = readFileSync(join(dirs.get(pkg), rel), "utf8");
    return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return "?";
  }
}

function printCounts(toolStepCounts, log) {
  const agents = [...toolStepCounts.keys()].sort();
  const total = agents.reduce((n, a) => n + toolStepCounts.get(a).length, 0);
  log(`[${GATE}] counted, not failed: ${total} fixed flow step(s) calling a tool, in ${agents.length} agent(s):`);
  for (const a of agents) log(`  ${a}: ${toolStepCounts.get(a).length} (${toolStepCounts.get(a).join(", ")})`);
}

function totalsLine(findings) {
  return FINDING_CLASSES.map((c) => `${findingCount(c, findings[c])} ${c}`).join(", ");
}

export function main(argv = process.argv.slice(2), { repoRoot = process.cwd(), env = process.env, log = console.log, err = console.error } = {}) {
  const write = argv.includes("--write-baseline");
  const report = argv.includes("--report");
  let result;
  try {
    result = scan(repoRoot);
  } catch (e) {
    err(`[${GATE}] scanner error: ${e?.message ?? e}`);
    return 2;
  }
  const { findings, toolStepCounts, stepPositions, unreadableSteps, packCount, dirs } = result;
  const floorPath = join(repoRoot, FLOOR_FILE);

  let list = null;
  if (existsSync(floorPath)) {
    try {
      list = parseList(readFileSync(floorPath, "utf8"));
    } catch (e) {
      err(`[${GATE}] scanner error: ${FLOOR_FILE} is not a readable list (${e?.message ?? e})`);
      return 2;
    }
  }

  if (report) {
    log(`[${GATE}] ${packCount} pinned extension(s) scanned; ${totalsLine(findings)}.`);
    for (const cls of FINDING_CLASSES) {
      log(`\n${cls}:`);
      if (cls === COUNTED_CLASS) {
        for (const [k, n] of [...countsOf(findings[cls])].sort()) log(`  ${k}: ${n} step(s)`);
        for (const p of stepPositions) log(`    at ${p}`);
        continue;
      }
      for (const p of keysOf(cls, findings[cls])) {
        log(`  ${p}${cls === "codeFiles" ? ` (${lineCount(dirs, p)} lines)` : ""}`);
      }
    }
    log(`\nunreadable steps (each fails the check): ${unreadableSteps.length}`);
    for (const u of unreadableSteps) log(`  ${u}`);
    printCounts(toolStepCounts, log);
    return 0;
  }

  if (write) {
    if (list) {
      const grew = listGrowth(list, findings);
      if (grew.length > 0) {
        err(`[${GATE}] REFUSING --write-baseline — the list only shrinks; these findings are not on it:`);
        for (const g of grew) err(`  + ${g}`);
        return 1;
      }
    }
    let notes = Object.create(null);
    if (existsSync(floorPath)) {
      try {
        const prior = JSON.parse(readFileSync(floorPath, "utf8"))?.notes;
        if (prior && typeof prior === "object") notes = prior;
      } catch {
        /* unreadable notes are dropped; the list itself was read above */
      }
    }
    const kept = new Set(FINDING_CLASSES.flatMap((c) => keysOf(c, findings[c])));
    const out = { note: LIST_NOTE };
    for (const cls of FINDING_CLASSES) {
      out[cls] = {};
      for (const pkg of Object.keys(findings[cls]).sort()) {
        const entry = findings[cls][pkg];
        out[cls][pkg] = cls === COUNTED_CLASS ? Object.fromEntries(Object.keys(entry).sort().map((f) => [f, entry[f]])) : [...entry];
      }
    }
    out.notes = Object.create(null);
    for (const k of Object.keys(notes).sort()) {
      const pair = k.replace(/^\[[A-Za-z]+\] /, "");
      if (kept.has(pair)) out.notes[k] = notes[k];
    }
    writeFileSync(floorPath, JSON.stringify(out, null, 2) + "\n");
    log(`[${GATE}] wrote ${FLOOR_FILE}: ${totalsLine(findings)} (${packCount} pinned extensions).`);
    return 0;
  }

  if (!list) {
    err(`[${GATE}] FAIL — ${FLOOR_FILE} is missing. Run with --write-baseline once (the introducing change).`);
    return 1;
  }

  const guard = checkListAgainstBase({ repoRoot, headList: list, env });
  const guardOk = reportFloorGuard(guard, { log, error: err });

  const diff = diffWithList(findings, list);
  let failed = !guardOk;
  if (unreadableSteps.length > 0) {
    failed = true;
    err(`[${GATE}] FAIL — [${COUNTED_CLASS}] a step the check cannot read (never recorded; make its data an object and its tool a plain name):`);
    for (const u of unreadableSteps) err(`  ! ${u}`);
  }
  for (const cls of FINDING_CLASSES) {
    if (diff[cls].fresh.length > 0) {
      failed = true;
      err(`[${GATE}] FAIL — [${cls}] not on the recorded list (an agent extension ships no program code outside its skills):`);
      for (const p of diff[cls].fresh) err(`  + ${p}`);
    }
    if (diff[cls].stale.length > 0) {
      failed = true;
      err(`[${GATE}] FAIL — [${cls}] on the list but gone (shrink the list: --write-baseline):`);
      for (const p of diff[cls].stale) err(`  - ${p}`);
    }
  }
  printCounts(toolStepCounts, log);
  if (failed) {
    err(
      `[${GATE}] Fix: move the work into a flow step with a skill (a script inside a skill folder is allowed), ` +
        `into core's generic machinery, or into a connector. See scripts/audit/extension-coupling-gates.md.`,
    );
    return 1;
  }
  log(`[${GATE}] OK — ${packCount} pinned extensions; recorded: ${totalsLine(findings)}.`);
  return 0;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("agent-extension-code-gate.mjs");
if (invokedDirectly) process.exitCode = main();
