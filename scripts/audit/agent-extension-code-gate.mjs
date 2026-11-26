#!/usr/bin/env node
/**
 * Agent extension code gate (cinatra#4885): an extension of kind `agent` ships
 * no program code at all. A skill, with its scripts, is its own extension of
 * kind `skill` that the agent depends on (core refuses a skill inside a
 * non-skill extension: `validateNonSkillExtensionPackage` in
 * scripts/audit/_lib/skill-packaging-verdict.mjs); skills are out of this
 * check's scope, like connectors.
 *
 * LIMITS. The check COUNTS; it does not judge what a file does. A new file of a
 * content kind (a `.json`, a `.md`) is not counted even if something executes
 * it. Code inside a connector and code in core are out of its scope.
 *
 * Over the pinned extensions (both locks plus `cinatra.devExtensions`) it reads
 * each pack from its PINNED COMMIT (the lock's `resolvedSha`) in its git
 * checkout at `extensions/<scope>/<name>`, never from the working tree or the
 * index, and counts, per key, four classes that may only go down:
 * `nonContentFiles` (agent packs: files that are not content by `isContent`),
 * `toolDeclarations` (`cinatra.tools` values), `extensionToolSteps` and
 * `unreadableSteps` (per pack and `cinatra/*.json` file, see `flowSteps`).
 * Rules and the list: scripts/audit/extension-coupling-gates.md.
 *
 * Usage: node scripts/audit/agent-extension-code-gate.mjs [--report | --write-baseline | --seed]
 * Exit codes: 0 = clean, 1 = findings / stale or grown list, 2 = scanner error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
 * THE CONTENT RULE, closed. A file is content when its extension, exact name
 * or top folder is listed here. Nothing else is content: a file under a
 * `skills/` folder of an agent pack counts like any other file.
 */
export const CONTENT = Object.freeze({
  extensions: new Set([".json", ".md", ".txt", ".yaml", ".yml", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".csv"]),
  names: new Set(["LICENSE", "NOTICE", ".gitignore", ".gitattributes", ".npmignore", ".editorconfig"]),
  topDirs: new Set([".github"]),
});

const SAFE_SCOPED_PKG_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BLOB_MODES = new Set(["100644", "100755"]);
const FLOW_RE = /^cinatra\/[^/]+\.json$/;
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

/** True when `rel` (forward slashes) is content. */
export function isContent(rel) {
  const parts = rel.split("/");
  if (parts.length >= 2 && CONTENT.topDirs.has(parts[0])) return true;
  const name = parts[parts.length - 1];
  if (CONTENT.names.has(name)) return true;
  const dot = name.lastIndexOf(".");
  return dot > 0 && CONTENT.extensions.has(name.slice(dot).toLowerCase());
}

/** The non-content files among `files` (`{ rel, link }`), sorted. */
export function nonContentFiles(files) {
  return files.filter((f) => f.link || !isContent(f.rel)).map((f) => f.rel).sort();
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

/**
 * The pinned packs, sorted by name: `{ name, sha }` for every entry of both
 * locks and every key of `cinatra.devExtensions`. The commit is the lock's
 * `resolvedSha`; a name without one, or with two different ones, is a scanner
 * error.
 */
export function pinnedPacks(root) {
  const shas = new Map();
  const checkName = (n, where) => {
    if (typeof n !== "string" || !SAFE_SCOPED_PKG_RE.test(n)) throw new ScannerError(`${where} names an invalid package ${JSON.stringify(n)}`);
  };
  for (const f of LOCK_FILES) {
    const lock = readJson(join(root, f), f);
    if (!Array.isArray(lock?.packages)) throw new ScannerError(`${f} carries no packages array`);
    for (const p of lock.packages) {
      checkName(p?.packageName, f);
      if (typeof p.resolvedSha !== "string" || !SHA_RE.test(p.resolvedSha)) throw new ScannerError(`${f} pins ${p.packageName} to no full commit hash (resolvedSha ${JSON.stringify(p.resolvedSha)})`);
      if (shas.has(p.packageName) && shas.get(p.packageName) !== p.resolvedSha) throw new ScannerError(`${p.packageName} is pinned to two different commits`);
      shas.set(p.packageName, p.resolvedSha);
    }
  }
  const dev = readJson(join(root, "package.json"), "package.json")?.cinatra?.devExtensions;
  if (!isPlainObject(dev)) throw new ScannerError("package.json carries no cinatra.devExtensions object");
  for (const n of Object.keys(dev)) {
    checkName(n, "cinatra.devExtensions");
    if (!shas.has(n)) throw new ScannerError(`cinatra.devExtensions names ${n}, which no lock pins to a commit`);
  }
  if (shas.size === 0) throw new ScannerError("the pinned universe is empty; refusing to pass vacuously");
  return [...shas.keys()].sort().map((name) => ({ name, sha: shas.get(name) }));
}

// Git reads only objects: no GIT_* variable from the caller redirects it, no
// replace ref swaps an object, no lazy fetch completes a partial clone.
const GIT_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_NO_LAZY_FETCH: "1" };
const gitIn = (dir, args, what) =>
  attempt(
    () => execFileSync("git", ["--no-replace-objects", "-C", dir, ...args], { encoding: "utf8", env: GIT_ENV, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] }),
    (e) => {
      throw new ScannerError(`${what}: ${String(e?.stderr ?? "").trim() || e?.code || e?.message || e}`);
    },
  );

/** The git checkout of `name` (`extensions/<scope>/<name>`), holding `sha` as a commit. */
export function packCheckout(root, name, sha) {
  const rel = `extensions/${name.slice(1)}`;
  const dir = join(root, rel);
  if (!existsSync(join(dir, "package.json")) && !existsSync(join(dir, ".git"))) throw new ScannerError(`the pinned pack ${name} is not checked out at ${rel}`);
  const notCheckout = `${rel} is not a git checkout of its own (CI materialises each pack with clone-extensions, i.e. \`node scripts/ci/sync-dev-extensions.mjs --pinned --shallow\`: a depth-1 git checkout at the pinned commit)`;
  if (!existsSync(join(dir, ".git"))) throw new ScannerError(notCheckout);
  const top = gitIn(dir, ["rev-parse", "--show-toplevel"], `${rel}: git rev-parse failed`).trim();
  if (attempt(() => realpathSync(top), () => top) !== realpathSync(dir)) throw new ScannerError(notCheckout);
  gitIn(dir, ["cat-file", "-e", `${sha}^{commit}`], `${rel} does not contain the pinned commit ${sha}`);
  return { dir, rel };
}

/** Every entry of the pinned commit's tree as `{ rel, mode, link }` (mode 120000 a link, 160000 a gitlink: `link`). */
export function packFiles(dir, sha, label) {
  const out = gitIn(dir, ["ls-tree", "-r", "--full-tree", "-z", sha], `git ls-tree of ${sha} failed in ${label}`);
  // `<mode> <type> <object>\t<path>`
  return out.split("\0").filter(Boolean).map((line) => {
    const mode = line.slice(0, line.indexOf(" "));
    return { rel: line.slice(line.indexOf("\t") + 1), mode, link: !BLOB_MODES.has(mode) };
  });
}

/** A regular file of the pinned commit, parsed as JSON. */
function readPinnedJson(dir, sha, entry, label) {
  if (!entry || !BLOB_MODES.has(entry.mode)) throw new ScannerError(`${label} is ${entry ? `not a regular file (mode ${entry.mode})` : "missing"} at the pinned commit ${sha}`);
  const text = gitIn(dir, ["cat-file", "blob", `${sha}:${entry.rel}`], `cannot read ${label} at the pinned commit ${sha}`);
  return attempt(() => JSON.parse(text), fail(`${label} at the pinned commit is not JSON`));
}

export function scan(root) {
  if (!existsSync(join(root, "extensions"))) throw new ScannerError("no extensions/ tree: run `node scripts/ci/sync-dev-extensions.mjs --pinned` first");
  const findings = Object.fromEntries(CLASSES.map((c) => [c, Object.create(null)]));
  const packs = pinnedPacks(root);
  for (const { name, sha } of packs) {
    const { dir, rel } = packCheckout(root, name, sha);
    const entries = packFiles(dir, sha, rel);
    const byPath = new Map(entries.map((e) => [e.rel, e]));
    const pkg = readPinnedJson(dir, sha, byPath.get("package.json"), `${rel}/package.json`);
    if (pkg?.name !== name) throw new ScannerError(`${rel} at the pinned commit ${sha} names the package ${JSON.stringify(pkg?.name)}, not ${name}`);
    const kind = pkg?.cinatra?.kind;
    if (typeof kind !== "string" || !kind) throw new ScannerError(`the pinned pack ${name} (${rel}) has no readable cinatra.kind`);
    const tools = toolDeclarationKeys(pkg);
    if (tools.length) findings.toolDeclarations[name] = { count: tools.length, items: tools };
    for (const e of entries.filter((x) => FLOW_RE.test(x.rel)).sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
      const { steps, unreadable } = flowSteps(readPinnedJson(dir, sha, e, `${rel}/${e.rel}`));
      if (steps.length) findings.extensionToolSteps[`${name} :: ${e.rel}`] = { count: steps.length, items: steps };
      if (unreadable.length) findings.unreadableSteps[`${name} :: ${e.rel}`] = { count: unreadable.length, items: unreadable };
    }
    if (kind === "agent") {
      const files = nonContentFiles(entries);
      if (files.length) findings.nonContentFiles[name] = { count: files.length, items: files };
    }
  }
  return { findings, packCount: packs.length };
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
    if (fresh.length) err(`[${GATE}] FAIL — [${cls}] above the recorded count (an agent extension ships no program code):`);
    for (const p of fresh) err(`  + ${p}`);
    if (stale.length) err(`[${GATE}] FAIL — [${cls}] below the recorded count (lower the list: --write-baseline):`);
    for (const p of stale) err(`  - ${p}`);
    failed ||= fresh.length + stale.length > 0;
  }
  if (failed) return stop(1, `[${GATE}] Fix: move the work into a skill extension (kind skill, declared as a dependency), into core's generic machinery or into a connector. See scripts/audit/extension-coupling-gates.md.`);
  log(`[${GATE}] OK — ${packCount} pinned extensions; recorded: ${totals(findings)}.`);
  return 0;
}

if (process.argv[1]?.endsWith("agent-extension-code-gate.mjs")) process.exitCode = main();
