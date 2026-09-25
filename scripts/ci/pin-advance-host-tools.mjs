#!/usr/bin/env node
// THE PIN-ADVANCE HOST-TOOL CHECK (cinatra#3422, item 2).
//
// A pack's flow reaches the host through the deterministic passthrough
// (src/app/api/agents/passthrough/route.ts): each passthrough ApiNode names
// the host tool it calls in `data.tool`, and the route refuses, with a 403,
// every name its `ALLOWED_TOOLS` set does not carry. A lock bump that moved a
// pack to a tip calling a host tool main does not offer went green on every
// existing check (shape, runtime invariants, the WayFlow mount) and broke every
// run of that pack on main before its first gate. This check closes that gap:
// for every package whose pin CHANGES between a base and this tree, it reads the
// pinned flow and refuses a node whose host tool the allowlist of THIS tree does
// not carry.
//
// Scope, on purpose: only the changed pins are checked, so an offender already
// on the base is not re-reported on every unrelated pull request. The
// allowlist is read from this tree (in a pull request run, the merge ref), so a
// change that adds a host tool together with the pin that needs it passes.
//
// `extension_tool` is on the allowlist; its inner `input.name` is the pack's
// own declared tool, dispatched against the calling extension's declaration
// (src/lib/extension-scoped-tools.ts), and is NEVER compared with the host
// list. A pack-declared name used DIRECTLY as `data.tool` is compared, and is
// refused, because the route refuses it.
//
// The allowlist is read STATICALLY from the route's source, and every entry the
// reader cannot resolve (a spread of a call, an unknown import, a non-literal)
// THROWS naming the entry and the file — the reader never guesses.
//
// The per-pack route reading (cinatra#3664): the route-graph ratchet counts core
// modules only, so a pinned pack's own modules no longer count against the
// tracked routes. For every changed or new pin whose checkout is at its tip,
// with a flow or without one, the base form logs one reading line with the
// pack's reachable module count on each tracked route (scripts/route-graph.mjs
// FIXED_ROUTES, analyzed once per run over the tree this script lives in). The
// reading is a record only: it never adds a finding, never changes the exit
// code and never refuses; an error while loading the counter or analyzing is
// logged as its reading.
//
// Usage:
//   node scripts/ci/pin-advance-host-tools.mjs --base <rev>
//   node scripts/ci/pin-advance-host-tools.mjs --flow <file> --package <name> --tip <sha>
// Exit 0: no finding. Exit 1: at least one finding. Exit 2: a reader, lock or
// argument error, with its reason.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The counter is loaded guarded: loading it reads this tree's tsconfig.json, and
// a failure there must reach the reading line, never the check's exit code.
let routeGraph = null;
let routeGraphLoadError = null;
try {
  routeGraph = await import("../route-graph.mjs");
} catch (e) {
  routeGraphLoadError = e;
}

export const ROUTE_FILE = "src/app/api/agents/passthrough/route.ts";
export const ALLOWLIST_NAME = "ALLOWED_TOOLS";
export const LOCK_FILES = ["cinatra-dev-extensions.lock.json", "cinatra-required-extensions.lock.json"];
const PASSTHROUGH_PATH = "/api/agents/passthrough";
const PREFIX = "pin-advance host-tool check:";
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]+$/;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
// The same package-name rule the pinned sync applies (packages/cli/src/cinatra-dev-extensions.mjs).
const SAFE_SCOPED_PKG_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const MODULE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", "/index.ts", "/index.tsx", "/index.mjs", "/index.js"];

// ---------------------------------------------------------------------------
// The static allowlist reader.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Scan from `start` (just past an opening `[`) to its matching `]`, skipping
 * strings and comments. Returns the body with every comment blanked.
 */
function bracketBody(text, start, file, name) {
  let depth = 1;
  let out = "";
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 2;
      out += " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "[" || ch === "(" || ch === "{") depth += 1;
    if (ch === "]" || ch === ")" || ch === "}") {
      depth -= 1;
      if (depth === 0) return out;
    }
    out += ch;
    i += 1;
  }
  throw new Error(`the set ${name} in ${file} has no closing bracket the reader can find`);
}

/** Split a set body at its top-level commas; empty entries (a trailing comma) are dropped. */
function splitEntries(body) {
  const entries = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < body.length && body[j] !== ch) j += body[j] === "\\" ? 2 : 1;
      current += body.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "[" || ch === "(" || ch === "{") depth += 1;
    if (ch === "]" || ch === ")" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      entries.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  entries.push(current.trim());
  return entries.filter((e) => e !== "");
}

/** Find `<NAME> = new Set([` in `text`; returns the index just past the `[`, or null. */
function findSetBlock(text, name, file, { exported }) {
  const re = new RegExp(
    `${exported ? "export\\s+" : "(?:export\\s+)?"}(?:const|let|var)\\s+${escapeRe(name)}\\s*(?::[^=]*?)?=\\s*new\\s+Set\\s*(?:<[^>]*>)?\\s*\\(\\s*\\[`,
    "g",
  );
  const matches = [...text.matchAll(re)];
  if (matches.length > 1) throw new Error(`the set ${name} is declared ${matches.length} times in ${file}`);
  return matches.length === 1 ? matches[0].index + matches[0][0].length : null;
}

/** A same-file string constant `const NAME = "value"`, or null. */
function findStringConstant(text, name) {
  const re = new RegExp(
    `(?:export\\s+)?const\\s+${escapeRe(name)}\\s*(?::[^=]*?)?=\\s*(["'\`])([^"'\`\\\\$]*)\\1\\s*(?:as\\s+const\\s*)?;?`,
    "g",
  );
  const matches = [...text.matchAll(re)];
  return matches.length === 1 ? matches[0][2] : null;
}

/** The module and exported name a local identifier is imported from, or null. */
function findImport(text, localName) {
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const spec of m[1].split(",")) {
      const parts = spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      const imported = parts[0]?.trim();
      const local = (parts[1] ?? parts[0])?.trim();
      if (local === localName) return { specifier: m[2], imported };
    }
  }
  return null;
}

function resolveModuleFile(repoRoot, fromFile, specifier, readText) {
  let base;
  if (specifier.startsWith("@/")) base = path.join("src", specifier.slice(2));
  else if (specifier.startsWith("./") || specifier.startsWith("../")) base = path.join(path.dirname(fromFile), specifier);
  else return null;
  for (const suffix of MODULE_SUFFIXES) {
    const rel = path.normalize(base + suffix);
    try {
      const text = readText(path.join(repoRoot, rel));
      if (typeof text === "string") return { rel, text };
    } catch {
      // try the next suffix
    }
  }
  return null;
}

function resolveSet({ repoRoot, file, text, name, exported, readText, seen }) {
  const key = `${file}#${name}`;
  if (seen.has(key)) throw new Error(`the set ${name} in ${file} spreads itself (a cycle)`);
  seen.add(key);
  const start = findSetBlock(text, name, file, { exported });
  if (start === null) throw new Error(`no ${exported ? "exported " : ""}set ${name} = new Set([...]) in ${file}`);
  const names = new Set();
  for (const entry of splitEntries(bracketBody(text, start, file, name))) {
    const literal = entry.match(/^(["'`])(.*)\1$/s);
    if (literal) {
      if (!TOOL_NAME_RE.test(literal[2])) {
        throw new Error(`the entry ${entry} of ${name} in ${file} is not a plain tool name`);
      }
      names.add(literal[2]);
      continue;
    }
    const spread = entry.match(/^\.\.\.\s*(.+)$/s);
    if (spread && IDENT_RE.test(spread[1].trim())) {
      const target = spread[1].trim();
      if (findSetBlock(text, target, file, { exported: false }) !== null) {
        for (const n of resolveSet({ repoRoot, file, text, name: target, exported: false, readText, seen })) names.add(n);
        continue;
      }
      const imp = findImport(text, target);
      const mod = imp && resolveModuleFile(repoRoot, file, imp.specifier, readText);
      if (!mod) {
        throw new Error(`the entry ...${target} of ${name} in ${file} names no same-file set and no import the reader can resolve`);
      }
      for (const n of resolveSet({ repoRoot, file: mod.rel, text: mod.text, name: imp.imported, exported: true, readText, seen })) {
        names.add(n);
      }
      continue;
    }
    if (IDENT_RE.test(entry)) {
      const value = findStringConstant(text, entry);
      if (value === null || !TOOL_NAME_RE.test(value)) {
        throw new Error(`the entry ${entry} of ${name} in ${file} is not a same-file string constant the reader can resolve`);
      }
      names.add(value);
      continue;
    }
    throw new Error(`the entry ${entry} of ${name} in ${file} is not a string, a same-file constant or a spread the reader can resolve`);
  }
  return names;
}

/**
 * The passthrough allowlist of the tree at `repoRoot`, read statically from
 * `ALLOWED_TOOLS` in the route and every set it spreads. Throws on anything it
 * cannot resolve. `readText` is injectable for tests.
 */
export function readPassthroughAllowlist(repoRoot, { readText = (abs) => readFileSync(abs, "utf8") } = {}) {
  let text;
  try {
    text = readText(path.join(repoRoot, ROUTE_FILE));
  } catch (e) {
    throw new Error(`cannot read ${ROUTE_FILE}: ${e.message}`);
  }
  if (typeof text !== "string") throw new Error(`cannot read ${ROUTE_FILE}`);
  const names = resolveSet({
    repoRoot,
    file: ROUTE_FILE,
    text,
    name: ALLOWLIST_NAME,
    exported: false,
    readText,
    seen: new Set(),
  });
  if (names.size === 0) throw new Error(`${ALLOWLIST_NAME} in ${ROUTE_FILE} resolves to no name`);
  return names;
}

// ---------------------------------------------------------------------------
// The flow reader.

/**
 * Every passthrough ApiNode of a flow: `{ nodeId, tool }`, or, when `data.tool`
 * is missing, not a string or a template, `{ nodeId, tool: null, unreadable }`.
 * The extension tool's inner `input.name` is never read.
 */
export function collectPassthroughHostTools(flow) {
  const calls = [];
  const seen = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (
      value.component_type === "ApiNode" &&
      typeof value.url === "string" &&
      value.url.trim().endsWith(PASSTHROUGH_PATH)
    ) {
      const nodeId = typeof value.id === "string" && value.id ? value.id : String(value.name ?? "(no id)");
      const tool = value.data && typeof value.data === "object" ? value.data.tool : undefined;
      let call;
      if (typeof tool !== "string" || tool === "") call = { nodeId, tool: null, unreadable: "data.tool is missing or not a string" };
      else if (tool.includes("{{")) call = { nodeId, tool: null, unreadable: `data.tool is the template ${JSON.stringify(tool)}` };
      else call = { nodeId, tool };
      const key = `${nodeId}\u0000${call.tool}\u0000${call.unreadable ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        calls.push(call);
      }
    }
    for (const v of Object.values(value)) walk(v);
  };
  walk(flow);
  return calls;
}

// ---------------------------------------------------------------------------
// The lock reader.

function lockEntries(locks, side) {
  const map = new Map();
  for (const lock of Array.isArray(locks) ? locks : [locks]) {
    const packages = lock?.packages;
    if (!Array.isArray(packages)) throw new Error(`a ${side} lock carries no packages array`);
    for (const p of packages) {
      const name = p?.packageName;
      if (typeof name !== "string" || !name) throw new Error(`a ${side} lock entry carries no packageName`);
      if (typeof p.resolvedSha !== "string" || !SHA_RE.test(p.resolvedSha)) {
        throw new Error(`the ${side} lock entry ${name} carries no 40-character resolvedSha`);
      }
      const prior = map.get(name);
      if (prior && prior !== p.resolvedSha) throw new Error(`the ${side} locks pin ${name} at two shas`);
      map.set(name, p.resolvedSha);
    }
  }
  return map;
}

/** The pins a head moves against a base: changed, new (added), removed and unchanged. */
export function changedPins(baseLock, headLock) {
  const base = lockEntries(baseLock, "base");
  const head = lockEntries(headLock, "head");
  const changed = [];
  const added = [];
  const unchanged = [];
  for (const [packageName, to] of head) {
    const from = base.get(packageName);
    if (from === undefined) added.push({ packageName, to });
    else if (from !== to) changed.push({ packageName, from, to });
    else unchanged.push(packageName);
  }
  const removed = [...base].filter(([n]) => !head.has(n)).map(([packageName, from]) => ({ packageName, from }));
  return { changed, added, removed, unchanged };
}

// ---------------------------------------------------------------------------
// The comparison.

export function findingLine({ packageName, tip, nodeId, tool, unreadable }) {
  if (unreadable) {
    return (
      `${PREFIX} ${packageName} at ${tip} — node "${nodeId}" names no readable host tool (${unreadable}), ` +
      `so the check cannot show the passthrough allowlist of this tree (${ROUTE_FILE}) carries it`
    );
  }
  return (
    `${PREFIX} ${packageName} at ${tip} — node "${nodeId}" calls host tool "${tool}", which the passthrough ` +
    `allowlist of this tree (${ROUTE_FILE}) does not carry`
  );
}

/**
 * Compare one pinned flow's passthrough calls with the allowlist. Returns the
 * sorted host-tool names it calls and one finding per offending node.
 */
export function hostToolFindings({ packageName, tip, calls, allowlist }) {
  const tools = [...new Set(calls.filter((c) => c.tool !== null).map((c) => c.tool))].sort();
  const findings = [];
  for (const call of calls) {
    if (call.tool !== null && allowlist.has(call.tool)) continue;
    const finding = { packageName, tip, nodeId: call.nodeId, tool: call.tool, unreadable: call.unreadable };
    findings.push({ ...finding, line: findingLine(finding) });
  }
  return { packageName, tip, tools, findings };
}

/**
 * One changed pack's reachable module count on each tracked route, in
 * FIXED_ROUTES order. `routes` = [{ route, ok, missingCount,
 * extensionModulesByPack }]; a route that did not resolve (or is absent) reads
 * `<route> unresolved`, a route with missing imports `<route> <n> (+<m> missing)`.
 * A reading is a record, never a finding.
 */
export function packRouteReading({ packageName, tip, routes }) {
  const byRoute = new Map((Array.isArray(routes) ? routes : []).map((r) => [r?.route, r]));
  const perRoute = [];
  const parts = [];
  if (routeGraph === null) throw routeGraphLoadError;
  for (const { route } of routeGraph.FIXED_ROUTES) {
    const r = byRoute.get(route);
    if (!r || r.ok !== true) {
      perRoute.push({ route, modules: null });
      parts.push(`${route} unresolved`);
      continue;
    }
    const modules = r.extensionModulesByPack?.[packageName] ?? 0;
    perRoute.push({ route, modules });
    parts.push(r.missingCount > 0 ? `${route} ${modules} (+${r.missingCount} missing)` : `${route} ${modules}`);
  }
  return {
    packageName,
    tip,
    perRoute,
    line: `${PREFIX} ${packageName} at ${tip} — reachable modules on the tracked routes: ${parts.join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// The command line.

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!["--base", "--flow", "--package", "--tip"].includes(flag)) throw new Error(`unknown argument ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    args[flag.slice(2)] = value;
    i += 1;
  }
  const flowForm = args.flow !== undefined || args.package !== undefined || args.tip !== undefined;
  if (args.base !== undefined && flowForm) throw new Error("--base and --flow are two forms; pass one");
  if (flowForm && (args.flow === undefined || args.package === undefined || args.tip === undefined)) {
    throw new Error("the one-flow form needs --flow <file> --package <name> --tip <sha>");
  }
  if (!flowForm && args.base === undefined) {
    throw new Error("usage: --base <rev> | --flow <file> --package <name> --tip <sha>");
  }
  return args;
}

function readJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} is not JSON: ${e.message}`);
  }
}

function report(results, refusals, log) {
  let count = refusals.length;
  for (const r of results) {
    if (r.findings.length === 0) log(`${PREFIX} ${r.packageName} at ${r.tip} — host tools: ${r.tools.join(", ") || "(none)"}`);
    for (const f of r.findings) log(f.line);
    count += r.findings.length;
  }
  for (const line of refusals) log(line);
  return count;
}

function runFlowForm(args, repoRoot, log) {
  if (!SHA_RE.test(args.tip)) throw new Error(`--tip must be a 40-character sha, got ${args.tip}`);
  const allowlist = readPassthroughAllowlist(repoRoot);
  const flow = readJson(readFileSync(args.flow, "utf8"), args.flow);
  const result = hostToolFindings({
    packageName: args.package,
    tip: args.tip,
    calls: collectPassthroughHostTools(flow),
    allowlist,
  });
  const count = report([result], [], log);
  log(`${PREFIX} ${count} finding(s) in one flow`);
  return count === 0 ? 0 : 1;
}

function runBaseForm(args, repoRoot, log) {
  let baseSha;
  try {
    baseSha = git(["rev-parse", "--verify", `${args.base}^{commit}`], repoRoot).trim();
  } catch {
    throw new Error(`the base ${args.base} is not a commit in this checkout`);
  }
  const baseLocks = LOCK_FILES.map((f) => {
    let text;
    try {
      text = git(["show", `${baseSha}:${f}`], repoRoot);
    } catch {
      throw new Error(`cannot read ${f} at the base ${baseSha}`);
    }
    return readJson(text, `${f} at ${baseSha}`);
  });
  const headLocks = LOCK_FILES.map((f) => readJson(readFileSync(path.join(repoRoot, f), "utf8"), `${f} in this tree`));
  const { changed, added, removed } = changedPins(baseLocks, headLocks);
  const allowlist = readPassthroughAllowlist(repoRoot);

  const results = [];
  const refusals = [];
  let withoutFlow = 0;
  // The tracked routes are analyzed at most once per run, and only when a pin at
  // its tip needs a reading.
  let routeAnalyses = null;
  let analysisError = null;
  const readingLine = (packageName, tip) => {
    if (routeAnalyses === null && analysisError === null) {
      try {
        if (routeGraph === null) throw routeGraphLoadError;
        routeAnalyses = routeGraph.FIXED_ROUTES.map(({ route, entry }) => ({ route, ...routeGraph.analyzeRoute(entry) }));
      } catch (e) {
        analysisError = e;
      }
    }
    if (analysisError !== null) {
      return `${PREFIX} ${packageName} at ${tip} — reachable modules on the tracked routes: not read (${analysisError?.message ?? analysisError})`;
    }
    return packRouteReading({ packageName, tip, routes: routeAnalyses }).line;
  };
  for (const { packageName, to } of [...changed, ...added].sort((a, b) => a.packageName.localeCompare(b.packageName))) {
    if (!SAFE_SCOPED_PKG_RE.test(packageName)) throw new Error(`the lock names an invalid package ${packageName}`);
    const [scope, name] = packageName.slice(1).split("/");
    const dir = path.join(repoRoot, "extensions", scope, name);
    let checkoutHead = "";
    try {
      if (existsSync(dir)) checkoutHead = git(["-C", dir, "rev-parse", "HEAD"], repoRoot).trim();
    } catch {
      checkoutHead = "";
    }
    if (checkoutHead !== to) {
      refusals.push(
        `${PREFIX} ${packageName} at ${to} — refused: the flow read is not the tip ` +
          `(extensions/${scope}/${name} reads HEAD ${checkoutHead || "(no checkout)"})`,
      );
      continue;
    }
    log(readingLine(packageName, to));
    const flowFile = path.join(dir, "cinatra", "oas.json");
    if (!existsSync(flowFile)) {
      withoutFlow += 1;
      log(`${PREFIX} ${packageName} at ${to} — no cinatra/oas.json, no flow to check`);
      continue;
    }
    const flow = readJson(readFileSync(flowFile, "utf8"), `extensions/${scope}/${name}/cinatra/oas.json`);
    results.push(hostToolFindings({ packageName, tip: to, calls: collectPassthroughHostTools(flow), allowlist }));
  }
  for (const { packageName, from } of removed) log(`${PREFIX} ${packageName} (was ${from}) — removed from the lock, not checked`);
  const count = report(results, refusals, log);
  log(
    `${PREFIX} ${changed.length + added.length} changed pin(s) since ${baseSha} ` +
      `(${changed.length} moved, ${added.length} new, ${removed.length} removed); ` +
      `${results.length} with a flow, ${withoutFlow} without; ${count} finding(s)`,
  );
  return count === 0 ? 0 : 1;
}

export function main(argv, { repoRoot = fileURLToPath(new URL("../..", import.meta.url)), log = console.log } = {}) {
  try {
    const args = parseArgs(argv);
    return args.base !== undefined ? runBaseForm(args, repoRoot, log) : runFlowForm(args, repoRoot, log);
  } catch (e) {
    console.error(`${PREFIX} error — ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
