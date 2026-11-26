#!/usr/bin/env node
/**
 * Agent extension code gate (cinatra#4885): an extension of kind `agent` ships
 * no program code of its own outside its skills ("skills could also include
 * scripts and here code is ok", the owner).
 *
 * LIMITS. The check COUNTS; it does not judge what a file does. A new file of a
 * content kind (a `.json`, a `.md`) is not counted even if something executes
 * it. Code inside a connector and code in core are out of its scope.
 *
 * Over the pinned extensions (both locks plus `cinatra.devExtensions`, found by
 * manifest name) it counts, per key, four classes that may only go down:
 * `nonContentFiles` (agent packs: files that are not content by `isContent`),
 * `toolDeclarations` (`cinatra.tools` values), `extensionToolSteps` and
 * `unreadableSteps` (per pack and `cinatra/*.json` file, see `flowSteps`).
 * Rules and the list: scripts/audit/extension-coupling-gates.md.
 *
 * Usage: node scripts/audit/agent-extension-code-gate.mjs [--report | --write-baseline | --seed]
 * Exit codes: 0 = clean, 1 = findings / stale or grown list, 2 = scanner error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compareFloorWithBase, readFileAtBase, reportFloorGuard } from "./lib/floor-base-guard.mjs";

const GATE = "agent-extension-code";
export const FLOOR_FILE = "scripts/audit/agent-extension-code-gate.baseline.json";
export const GATE_FILE = "scripts/audit/agent-extension-code-gate.mjs";
export const FLOOR_BASE_VAR = "AGENT_EXTENSION_CODE_BASE";
export const LOCK_FILES = ["cinatra-dev-extensions.lock.json", "cinatra-required-extensions.lock.json"];
export const CLASSES = ["nonContentFiles", "toolDeclarations", "extensionToolSteps", "unreadableSteps"];
export const EXTENSION_TOOL = "extension_tool";

/**
 * THE CONTENT RULE, closed. A file is content when (a) it lies under
 * `skills/<entry>/` and `skills/<entry>/SKILL.md` exists (the product's own
 * rule: `upsertSkillsFromDir` in packages/agents/src/extension-handler.ts
 * registers exactly `<pack>/skills/<entry>/SKILL.md`; the whole folder is the
 * skill, scripts included), or (b) its extension, exact name or top folder is
 * listed here. Nothing else is content.
 */
export const CONTENT = Object.freeze({
  extensions: new Set([".json", ".md", ".txt", ".yaml", ".yml", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".csv"]),
  names: new Set(["LICENSE", "NOTICE", ".gitignore", ".gitattributes", ".npmignore", ".editorconfig"]),
  topDirs: new Set([".github"]),
});

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SAFE_SCOPED_PKG_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export class ScannerError extends Error {}
const attempt = (fn, onError) => {
  try {
    return fn();
  } catch (e) {
    return onError(e);
  }
};
const fail = (what) => (e) => {
  throw new ScannerError(`${what}: ${e?.code ?? e?.message ?? e}`);
};

/** True when `rel` (forward slashes) is content; `skillDirs` holds `skills/<entry>` folders with a SKILL.md. */
export function isContent(rel, skillDirs) {
  const parts = rel.split("/");
  if (parts.length >= 3 && parts[0] === "skills" && skillDirs.has(`skills/${parts[1]}`)) return true;
  if (parts.length >= 2 && CONTENT.topDirs.has(parts[0])) return true;
  const name = parts[parts.length - 1];
  if (CONTENT.names.has(name)) return true;
  const dot = name.lastIndexOf(".");
  return dot > 0 && CONTENT.extensions.has(name.slice(dot).toLowerCase());
}

/** The non-content files among `files` (`{ rel, link }`), sorted. */
export function nonContentFiles(files) {
  const skillDirs = new Set();
  for (const { rel, link } of files) {
    const p = rel.split("/");
    if (!link && p.length === 3 && p[0] === "skills" && p[2] === "SKILL.md") skillDirs.add(`skills/${p[1]}`);
  }
  return files.filter((f) => f.link || !isContent(f.rel, skillDirs)).map((f) => f.rel).sort();
}

/**
 * The keys of `cinatra.tools` (empty when absent or `null`, as for the product's
 * `parseDeclaredTools` in packages/sdk-extensions/src/manifest.ts). Every value
 * counts: a valid name seen first is the name; any other array entry is
 * `cinatra.tools[<i>]`; an object map gives `cinatra.tools.<key>` per own key;
 * any other value is `cinatra.tools`.
 */
export function toolDeclarationKeys(packageJson) {
  const block = packageJson?.cinatra;
  const tools = isPlainObject(block) && hasOwn(block, "tools") ? block.tools : null;
  if (tools === null) return [];
  if (!Array.isArray(tools)) {
    const own = isPlainObject(tools) ? Object.keys(tools) : [];
    return own.length > 0 ? own.map((k) => `cinatra.tools.${k}`).sort() : ["cinatra.tools"];
  }
  const seen = new Set();
  const key = (name, i) => (typeof name === "string" && TOOL_NAME_RE.test(name) && !seen.has(name) ? seen.add(name) && name : `cinatra.tools[${i}]`);
  return tools.map((t, i) => key(isPlainObject(t) ? t.name : undefined, i)).sort();
}

/**
 * One walk over a parsed flow file, every object once. `steps`: objects whose
 * `data` (object, or string parsing to one) has `tool` === extension_tool.
 * `unreadable`: ApiNode-shaped objects (`url`, `http_method` or component_type
 * ApiNode) whose string `data` does not parse, or whose `tool` is not a plain
 * string or holds `{{`. Both as sorted `id ...` lines.
 */
export function flowSteps(flow) {
  const steps = [];
  const unreadable = [];
  const seen = new WeakSet();
  const walk = (v) => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) return v.forEach(walk);
    if (hasOwn(v, "data")) {
      const id = typeof v.id === "string" && v.id ? v.id : typeof v.name === "string" && v.name ? v.name : "(no id)";
      const apiShape = hasOwn(v, "url") || hasOwn(v, "http_method") || v.component_type === "ApiNode";
      let data = v.data;
      if (typeof data === "string") {
        data = attempt(() => JSON.parse(data), () => undefined);
        if (data === undefined && apiShape) unreadable.push(`${id}: data is a string that does not parse as JSON`);
      }
      if (isPlainObject(data) && hasOwn(data, "tool")) {
        if (typeof data.tool !== "string" || data.tool.includes("{{")) {
          if (apiShape) unreadable.push(`${id}: data.tool is not a plain name`);
        } else if (data.tool === EXTENSION_TOOL) {
          steps.push(`${id} -> ${isPlainObject(data.input) && typeof data.input.name === "string" ? data.input.name : "(no module name)"}`);
        }
      }
    }
    for (const c of Object.values(v)) walk(c);
  };
  walk(flow);
  return { steps: steps.sort(), unreadable: unreadable.sort() };
}

const countsOf = (map) => new Map(Object.keys(map ?? {}).map((k) => [k, map[k].count]));

/** Per class: keys whose found count is above the list (`fresh`) or below it (`stale`). */
export function diffWithList(findings, list) {
  const out = Object.create(null);
  for (const cls of CLASSES) {
    const [found, listed] = [countsOf(findings[cls]), countsOf(list[cls])];
    out[cls] = { fresh: [], stale: [] };
    for (const k of [...new Set([...found.keys(), ...listed.keys()])].sort()) {
      const [f, l] = [found.get(k) ?? 0, listed.get(k) ?? 0];
      if (f !== l) out[cls][f > l ? "fresh" : "stale"].push(`${k}: ${f}, the list holds ${l}`);
    }
  }
  return out;
}

/** Growth of `head` against `base`: a raised count (absent = 0) or a removed class. */
export function listGrowth(base, head) {
  const lines = [];
  for (const cls of CLASSES) {
    if (base?.[cls] && !head?.[cls]) lines.push(`[${cls}] the class is removed (a class is never removed)`);
    const b = countsOf(base?.[cls]);
    for (const [k, n] of countsOf(head?.[cls])) if (n > (b.get(k) ?? 0)) lines.push(`[${cls}] ${k}: ${n}, the base holds ${b.get(k) ?? 0}`);
  }
  return lines.sort();
}

/** Parse a list: every class an object of `{ count, items }`. Throws otherwise. Prototype-free copy. */
export function parseList(text) {
  const raw = JSON.parse(text);
  if (!isPlainObject(raw)) throw new Error("the list is not an object");
  const out = Object.create(null);
  for (const cls of CLASSES) {
    if (!isPlainObject(raw[cls])) throw new Error(`the class ${cls} is missing or not an object`);
    out[cls] = Object.create(null);
    for (const [k, e] of Object.entries(raw[cls])) {
      if (!isPlainObject(e) || !Number.isInteger(e.count) || e.count < 0 || !Array.isArray(e.items) || e.items.some((s) => typeof s !== "string")) {
        throw new Error(`the entry ${cls}.${k} is not { count, items }`);
      }
      out[cls][k] = { count: e.count, items: [...e.items] };
    }
  }
  return out;
}

const readJson = (path, label) => {
  const text = attempt(() => readFileSync(path, "utf8"), fail(`cannot read ${label}`));
  return attempt(() => JSON.parse(text), fail(`${label} is not JSON`));
};
const listDir = (dir, label) => attempt(() => readdirSync(dir, { withFileTypes: true }), fail(`cannot read the directory ${label}`));

/** The pinned package names: both locks plus `cinatra.devExtensions`. */
export function pinnedNames(root) {
  const names = new Set();
  const add = (n, where) => {
    if (typeof n !== "string" || !SAFE_SCOPED_PKG_RE.test(n)) throw new ScannerError(`${where} names an invalid package ${JSON.stringify(n)}`);
    names.add(n);
  };
  for (const f of LOCK_FILES) {
    const lock = readJson(join(root, f), f);
    if (!Array.isArray(lock?.packages)) throw new ScannerError(`${f} carries no packages array`);
    for (const p of lock.packages) add(p?.packageName, f);
  }
  const dev = readJson(join(root, "package.json"), "package.json")?.cinatra?.devExtensions;
  if (!isPlainObject(dev)) throw new ScannerError("package.json carries no cinatra.devExtensions object");
  for (const n of Object.keys(dev)) add(n, "cinatra.devExtensions");
  if (names.size === 0) throw new ScannerError("the pinned universe is empty; refusing to pass vacuously");
  return [...names].sort();
}

/** `extensions/<scope>/<dir>` with a package.json, by manifest name. */
function indexTree(root) {
  const ext = join(root, "extensions");
  if (!existsSync(ext)) throw new ScannerError("no extensions/ tree: run `node scripts/ci/sync-dev-extensions.mjs --pinned` first");
  const byName = new Map();
  for (const scope of listDir(ext, "extensions")) {
    if (!scope.isDirectory() || scope.name.startsWith(".") || SKIP_DIRS.has(scope.name)) continue;
    for (const pack of listDir(join(ext, scope.name), `extensions/${scope.name}`)) {
      const rel = `extensions/${scope.name}/${pack.name}`;
      if (!pack.isDirectory() || pack.name.startsWith(".") || !existsSync(join(root, rel, "package.json"))) continue;
      const pkg = readJson(join(root, rel, "package.json"), `${rel}/package.json`);
      if (typeof pkg?.name !== "string" || !pkg.name) throw new ScannerError(`${rel}/package.json carries no name`);
      if (byName.has(pkg.name)) throw new ScannerError(`two directories carry the manifest name ${pkg.name}`);
      byName.set(pkg.name, { dir: join(root, rel), rel, pkg });
    }
  }
  return byName;
}

/** Every file of a pack as `{ rel, link }`: `git ls-files` in its own checkout, else a walk following no link. */
export function packFiles(dir, label) {
  if (existsSync(join(dir, ".git"))) {
    const out = attempt(
      () => execFileSync("git", ["-C", dir, "ls-files", "-s", "-z"], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }),
      fail(`git ls-files failed in ${label}`),
    );
    // `<mode> <object> <stage>\t<path>`; mode 100xxx is a regular file, 120000 a link, 160000 a gitlink.
    return out.split("\0").filter(Boolean).map((line) => ({ rel: line.slice(line.indexOf("\t") + 1), link: !line.startsWith("100") }));
  }
  const files = [];
  const walk = (abs, rel) => {
    for (const e of listDir(abs, rel ? `${label}/${rel}` : label)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) files.push({ rel: r, link: true });
      else if (!e.isDirectory()) files.push({ rel: r, link: false });
      else if (!SKIP_DIRS.has(e.name)) walk(join(abs, e.name), r);
    }
  };
  walk(dir, "");
  return files;
}

export function scan(root) {
  const tree = indexTree(root);
  const findings = Object.fromEntries(CLASSES.map((c) => [c, Object.create(null)]));
  const names = pinnedNames(root);
  for (const name of names) {
    const { dir, rel, pkg } = tree.get(name) ?? {};
    if (!dir) throw new ScannerError(`the pinned pack ${name} is not in the extensions/ tree (no manifest carries that name)`);
    const kind = pkg?.cinatra?.kind;
    if (typeof kind !== "string" || !kind) throw new ScannerError(`the pinned pack ${name} (${rel}) has no readable cinatra.kind`);
    const tools = toolDeclarationKeys(pkg);
    if (tools.length) findings.toolDeclarations[name] = { count: tools.length, items: tools };
    if (existsSync(join(dir, "cinatra"))) {
      for (const f of listDir(join(dir, "cinatra"), `${rel}/cinatra`).filter((e) => !e.isDirectory() && e.name.endsWith(".json")).map((e) => e.name).sort()) {
        const { steps, unreadable } = flowSteps(readJson(join(dir, "cinatra", f), `${rel}/cinatra/${f}`));
        if (steps.length) findings.extensionToolSteps[`${name} :: cinatra/${f}`] = { count: steps.length, items: steps };
        if (unreadable.length) findings.unreadableSteps[`${name} :: cinatra/${f}`] = { count: unreadable.length, items: unreadable };
      }
    }
    if (kind === "agent") {
      const files = nonContentFiles(packFiles(dir, rel));
      if (files.length) findings.nonContentFiles[name] = { count: files.length, items: files };
    }
  }
  return { findings, packCount: names.length };
}

/** The base guard; a resolving base holding neither the list nor this script is the introducing change. */
export function checkListAgainstBase({ repoRoot, headList, env = process.env }) {
  const result = compareFloorWithBase({ gate: GATE, envVar: FLOOR_BASE_VAR, floorPath: FLOOR_FILE, headFloor: headList, parse: parseList, grown: listGrowth, repoRoot, env });
  if (result.status !== "unreadable" || !result.ref) return result;
  const resolves = attempt(() => (execFileSync("git", ["rev-parse", "--verify", "--quiet", `${result.ref}^{commit}`], { cwd: repoRoot, stdio: "ignore" }), true), () => false);
  if (!resolves) return result;
  if (readFileAtBase(repoRoot, result.ref, FLOOR_FILE).ok || readFileAtBase(repoRoot, result.ref, GATE_FILE).ok) return result;
  return { status: "introducing", ok: true, ref: result.ref, lines: [`[${GATE}] floor base guard: the base "${result.ref}" holds neither ${FLOOR_FILE} nor ${GATE_FILE} — this change introduces the gate, and its list is the seed.`] };
}

const total = (map) => Object.values(map).reduce((n, e) => n + e.count, 0);
const totals = (f) => CLASSES.map((c) => `${total(f[c])} ${c} in ${Object.keys(f[c]).length} key(s)`).join(", ");
const NOTE = "Agent extension code gate (cinatra#4885): counts per key that may only go down (lower them with --write-baseline); " +
  "`items` is information, never compared. See scripts/audit/extension-coupling-gates.md.";

export function main(argv = process.argv.slice(2), { repoRoot = process.cwd(), env = process.env, log = console.log, err = console.error } = {}) {
  const stop = (code, ...lines) => (lines.forEach((l) => err(l)), code);
  const floorPath = join(repoRoot, FLOOR_FILE);
  const present = existsSync(floorPath);
  let findings, packCount, list;
  try {
    ({ findings, packCount } = scan(repoRoot));
    list = present ? attempt(() => parseList(readFileSync(floorPath, "utf8")), fail(`${FLOOR_FILE} is not a readable list`)) : null;
  } catch (e) {
    return stop(2, `[${GATE}] scanner error: ${e?.message ?? e}`);
  }
  if (argv.includes("--report")) {
    log(`[${GATE}] ${packCount} pinned extension(s) scanned; ${totals(findings)}.`);
    for (const cls of CLASSES) {
      log(`\n${cls}: ${total(findings[cls])}`);
      for (const k of Object.keys(findings[cls]).sort((a, b) => findings[cls][b].count - findings[cls][a].count || a.localeCompare(b))) {
        log(`  ${k}: ${findings[cls][k].count}`);
        for (const i of findings[cls][k].items) log(`    ${i}`);
      }
    }
    return 0;
  }
  const seed = argv.includes("--seed");
  if (seed || argv.includes("--write-baseline")) {
    if (seed && present) return stop(1, `[${GATE}] REFUSING --seed — ${FLOOR_FILE} exists; lower it with --write-baseline.`);
    if (!seed && !list) return stop(1, `[${GATE}] REFUSING --write-baseline — ${FLOOR_FILE} is missing (only --seed writes a first list).`);
    const grew = list ? listGrowth(list, findings) : [];
    if (grew.length) return stop(1, `[${GATE}] REFUSING --write-baseline — the list only shrinks:`, ...grew.map((g) => `  + ${g}`));
    const out = { note: NOTE };
    for (const cls of CLASSES) out[cls] = Object.fromEntries(Object.keys(findings[cls]).sort().map((k) => [k, findings[cls][k]]));
    writeFileSync(floorPath, JSON.stringify(out, null, 2) + "\n");
    log(`[${GATE}] wrote ${FLOOR_FILE}: ${totals(findings)}.`);
    return 0;
  }
  if (!list) return stop(1, `[${GATE}] FAIL — ${FLOOR_FILE} is missing. Run with --seed once (the introducing change).`);
  let failed = !reportFloorGuard(checkListAgainstBase({ repoRoot, headList: list, env }), { log, error: err });
  const diff = diffWithList(findings, list);
  for (const cls of CLASSES) {
    const { fresh, stale } = diff[cls];
    if (fresh.length) err(`[${GATE}] FAIL — [${cls}] above the recorded count (an agent extension ships no program code outside its skills):`);
    for (const p of fresh) err(`  + ${p}`);
    if (stale.length) err(`[${GATE}] FAIL — [${cls}] below the recorded count (lower the list: --write-baseline):`);
    for (const p of stale) err(`  - ${p}`);
    failed ||= fresh.length + stale.length > 0;
  }
  if (failed) return stop(1, `[${GATE}] Fix: move the work into a skill (skills/<entry>/ with a SKILL.md), into core's generic machinery or into a connector. See scripts/audit/extension-coupling-gates.md.`);
  log(`[${GATE}] OK — ${packCount} pinned extensions; recorded: ${totals(findings)}.`);
  return 0;
}

if (process.argv[1]?.endsWith("agent-extension-code-gate.mjs")) process.exitCode = main();
