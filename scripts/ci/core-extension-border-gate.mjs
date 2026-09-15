#!/usr/bin/env node
// CI gate: THE CORE/EXTENSION BORDER.
//
// THE RULE THIS GATE ENFORCES: the border between the core and the extensions
// is strictly upheld. A pack's knowledge — its tables, its type ids, its flow,
// its name — does not live in the host, and the host's knowledge does not live
// in a pack. Exactly four crossings are legitimate:
//
//   (1) the lock re-pin written by the update-{required,dev}-extension-lock
//       scripts;
//   (2) the materializer's generated maps (config/build-config.manifest.json ->
//       the generated tsconfig paths, src/lib/generated/*);
//   (3) the display map resolving a DECLARED type to a DECLARED renderer slot;
//   (4) a passthrough tool admitted by name whose scope is the caller's own
//       declared dependency or declared table.
//
// Everything else is a crossing, and this gate names it with file, line and the
// contract sentence it breaks. See docs/internals/contracts/core-extension-border.md.
//
// SCOPE: PRODUCT code only, under src/ and packages/. Tests, mocks, fixtures,
// generated maps, type declarations and test-runner configs are excluded — a
// pack name in a test fixture is the fixture doing its job, and a pack name in
// a generated map is crossing (2). The materialized extensions/ tree is never
// walked: it is a pack's own source, checked out read-only at a committed pin
// (scripts/ci/sync-dev-extensions.mjs), not host code.
//
// COMMENTS ARE NOT CODE. Every scan runs over comment-MASKED text (line numbers
// preserved). A comment that names a pack to explain a gap states knowledge; it
// does not encode it.
//
// THE BASELINE (config/core-extension-border-baseline.json) is SHRINK-ONLY. It
// records the crossings that stood on main the day this gate landed, each with
// the file, the rule and a one-line reason. It carries no wildcard: an entry
// names one file and one detail. A finding outside it fails immediately, and a
// baselined pack-shaped core module that GROWS — a new file in a baselined
// directory, or a recorded file above its recorded line count — fails too,
// because the key of a growth finding can never match a recorded key. An entry
// whose crossing is gone is reported so the ratchet can be shrunk.
//
// Usage:
//   node scripts/ci/core-extension-border-gate.mjs                  # check (exit 1 on any finding outside the baseline)
//   node scripts/ci/core-extension-border-gate.mjs --report         # print every finding, baselined ones included
//   node scripts/ci/core-extension-border-gate.mjs --write-baseline # regenerate, carrying every existing reason forward

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname, "..", "..");
const DEFAULT_BASELINE = join(DEFAULT_REPO_ROOT, "config", "core-extension-border-baseline.json");

/** The roots that hold host product code. The materialized `extensions/` tree
 *  is deliberately absent. */
export const PRODUCT_ROOTS = ["src", "packages"];

export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"]);

/** Directories that are not product code. The materializer's own generated map
 *  directory is crossing (2) and is skipped by PATH (see GENERATED_PATHS), not
 *  by bare directory name — a directory merely NAMED `generated` anywhere else
 *  is ordinary product code and is scanned. */
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
  "__tests__",
  "__mocks__",
  "__fixtures__",
  "__snapshots__",
]);

/** The host's own reserved namespace. `@cinatra-ai/host:*` is a HOST
 *  capability sentinel, not a pack id — the host naming itself is not a
 *  crossing. */
export const HOST_RESERVED_PACKAGE = "@cinatra-ai/host";

/** The materializer-owned generated maps — crossing (2). Skipped by exact path
 *  so no other directory can shelter under the name. */
export const GENERATED_PATHS = new Set(["src/lib/generated"]);

export function isProductFile(name) {
  if (/\.(test|spec)\./.test(name)) return false;
  if (/\.fixture\./.test(name) || /\.stories\./.test(name)) return false;
  if (name.endsWith(".d.ts")) return false;
  if (/^vitest\./.test(name) || /^vite\.config\./.test(name)) return false;
  const dot = name.lastIndexOf(".");
  return dot >= 0 && SOURCE_EXTENSIONS.has(name.slice(dot));
}

/** Walk one directory for product source files (absolute paths). */
export function walkProductFiles(dir, acc = [], repoRoot = null) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (repoRoot && GENERATED_PATHS.has(relative(repoRoot, full).split(sep).join("/"))) continue;
      walkProductFiles(full, acc, repoRoot);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!isProductFile(entry.name)) continue;
    acc.push(full);
  }
  return acc;
}

/** Replace every comment with spaces, keeping newlines (so line numbers are
 *  unchanged) and never mistaking a `//` inside a string literal for one. */
export function maskComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  // A `/` opens a REGEX literal (not a comment) when the last significant
  // character is one that cannot end an expression. Without this state a regex
  // holding `/` or `*` reads as a comment and the masker would swallow the rest
  // of the file, DROPPING real crossings — the gate must never lose text.
  const opensRegex = () => {
    for (let k = out.length - 1; k >= 0; k -= 1) {
      const ch = out[k];
      if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") continue;
      return "(,=:[!&|?{};+-*%^~<>".includes(ch);
    }
    return true;
  };
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next !== "/" && next !== "*" && opensRegex()) {
      out += c;
      i += 1;
      let inClass = false;
      while (i < n && text[i] !== "\n") {
        if (text[i] === "\\") {
          out += text[i] + (text[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
        out += text[i];
        i += 1;
        if (!inClass && text[i - 1] === "/") break;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < n && text[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += i < n ? "  " : "";
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        if (text[i] === "\\") {
          out += text[i] + (text[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === quote) {
          i += 1;
          break;
        }
        if (text[i] === "\n" && quote !== "`") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

function finding(rule, file, line, detail, message) {
  return { rule, file, line, detail, message };
}

/** `${rule}::${file}::${detail}` — stable across line moves, so a baselined
 *  crossing that merely shifts down the file stays baselined. */
export function keyOf(f) {
  return `${f.rule}::${f.file}::${f.detail}`;
}

const TABLE_LITERAL_RE = /ext_cinatra_ai_[a-z0-9_]+/g;
const TYPE_ID_RE = /["'`](@cinatra-ai\/[a-z0-9][a-z0-9.-]*):([A-Za-z0-9._/-]+)["'`]/g;
const BRANCH_RE = /[!=]==\s*["'`](@cinatra-ai\/[a-z0-9][a-z0-9.-]*)["'`]/g;
const BRANCH_REVERSED_RE = /["'`](@cinatra-ai\/[a-z0-9][a-z0-9.-]*)["'`]\s*[!=]==/g;
const BRANCH_CASE_RE = /\bcase\s+["'`](@cinatra-ai\/[a-z0-9][a-z0-9.-]*)["'`]\s*:/g;
const BARE_PACKAGE_RE = /["'`](@cinatra-ai\/[a-z0-9][a-z0-9.-]*)["'`]/g;

/** A pack whose npm name carries a role suffix declares its types under the
 *  BARE stem: `@cinatra-ai/email-artifacts` owns `@cinatra-ai/email:*`. The
 *  type-id rule reads the stem too, or a restatement of a pack's declared type
 *  in core is invisible merely because the namespace is not spelled the way the
 *  package is. Derived from the locks — never hand-listed. */
const ROLE_SUFFIX_RE = /-(agents?|artifacts?|connectors?|skills?|workflows?|mcp)$/;

export function packTypeNamespaces(packs, workspacePackages = new Set()) {
  const ns = new Map();
  for (const p of packs) {
    ns.set(p, p);
    const stem = p.replace(ROLE_SUFFIX_RE, "");
    if (stem === p) continue;
    if (workspacePackages.has(stem) || packs.has(stem) || stem === HOST_RESERVED_PACKAGE) continue;
    if (!ns.has(stem)) ns.set(stem, p);
  }
  return ns;
}

/** A repeated crossing is a SEPARATE crossing. The second and later occurrence
 *  of the same rule and detail carries its ordinal into the detail, so it gets
 *  its own key and cannot ride the entry that covers the first. */
function occurrenceDetail(counts, rule, detail) {
  const k = `${rule}::${detail}`;
  const n = (counts.get(k) ?? 0) + 1;
  counts.set(k, n);
  return n === 1 ? detail : `${detail} (occurrence ${n})`;
}

/** The three text-level crossing classes: a pack's physical table name, a
 *  pack's type id, and a branch on a pack's package name. */
export function scanTextForCrossings({ file, text, packs, workspacePackages }) {
  const namespaces = packTypeNamespaces(packs, workspacePackages);
  const masked = maskComments(text);
  const out = [];
  const counts = new Map();
  const push = (rule, line, detail, message) => {
    out.push(finding(rule, file, line, occurrenceDetail(counts, rule, detail), message));
  };

  for (const m of masked.matchAll(TABLE_LITERAL_RE)) {
    push(
      "pack-table-literal",
      lineOf(masked, m.index),
      m[0],
      "core spells a pack's physical table name; the prefix is derived from the caller's own manifest, never written in the host",
    );
  }

  for (const m of masked.matchAll(TYPE_ID_RE)) {
    const pkg = m[1];
    if (pkg === HOST_RESERVED_PACKAGE) continue;
    if (workspacePackages.has(pkg)) continue;
    const owner = namespaces.get(pkg);
    if (!owner) continue;
    push(
      "pack-type-id-in-core",
      lineOf(masked, m.index),
      `${pkg}:${m[2]}`,
      `core hard-codes a type id declared by the pack ${owner}; the calling extension names its type, never this tree`,
    );
  }

  // A pack's package name written in core AT ALL is the crossing — an equality
  // test, a `case`, a lookup table, an `.includes([...])` list or a computed key
  // are one behaviour. Naming a locked pack needs no operator beside it.
  for (const m of masked.matchAll(BARE_PACKAGE_RE)) {
    const pkg = m[1];
    if (!packs.has(pkg)) continue;
    push(
      "pack-package-name-branch",
      lineOf(masked, m.index),
      pkg,
      "product code names one pack; behaviour follows a declaration, never an identity",
    );
  }

  for (const re of [BRANCH_RE, BRANCH_REVERSED_RE, BRANCH_CASE_RE]) {
    for (const m of masked.matchAll(re)) {
      const pkg = m[1];
      if (pkg === HOST_RESERVED_PACKAGE) continue;
      if (workspacePackages.has(pkg)) continue;
      if (packs.has(pkg)) continue; // already reported by the bare-name rule
      push(
        "pack-package-name-branch",
        lineOf(masked, m.index),
        pkg,
        "product code branches on a package name; behaviour follows a declaration, never an identity",
      );
    }
  }

  return out.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Underscore-joined leading name segments (two or more) of every pack, e.g.
 *  `@cinatra-ai/blog-pipeline-agent` -> `blog_pipeline`, `blog_pipeline_agent`.
 *  Two segments is the floor so a single generic word (`blog`, `email`) can
 *  never make a generic tool name look pack-named. */
export function packNameTokens(packs) {
  const tokens = new Set();
  for (const p of packs) {
    const leaf = String(p).replace(/^@[^/]+\//, "");
    const segs = leaf.split("-").filter(Boolean);
    for (let k = 2; k <= segs.length; k += 1) tokens.add(segs.slice(0, k).join("_"));
  }
  return tokens;
}

/** The pack token a tool name carries, or null. */
export function admissionCrossesBorder(tool, tokens) {
  for (const t of tokens) {
    if (new RegExp(`(?:^|_)${t}(?:_|$)`).test(tool)) return t;
  }
  return null;
}

/** A tool-admission set: `const <NAME>TOOLS = new Set([...])`. The passthrough
 *  route's ALLOWED_TOOLS and the W7 EXTENSION_SCOPED_TOOLS both take this
 *  shape, so the rule follows the shape rather than one module's name. */
const TOOL_SET_RE =
  /(?:const|let|var)\s+([A-Za-z0-9_]*(?:TOOLS|Tools))\s*(?::[^=]*?)?=\s*new Set\s*(?:<[^>]*>)?\s*\(\s*\[([\s\S]*?)\]\s*\)/g;

/** A passthrough admission named after one pack. Every admission is by name and
 *  by scope; the name may not be a pack's. */
export function scanScopedToolAdmissions({ file, text, packs }) {
  if (!/(?:TOOLS|Tools)\s*(?::[^=]*?)?=\s*new Set/.test(text)) return [];
  const masked = maskComments(text);
  const tokens = packNameTokens(packs);
  const out = [];
  const counts = new Map();
  // An admission spelled through a same-file constant is the same admission.
  // `const BLOG_TOOL = "blog_x"; new Set([...GENERIC, BLOG_TOOL])` admits the
  // tool exactly as the inline literal does, so the identifiers a set lists are
  // resolved against the file's own string constants before the rule reads them.
  const constants = new Map();
  for (const c of masked.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]*?)?=\s*["'`]([A-Za-z0-9_.-]+)["'`]/g)) {
    constants.set(c[1], { value: c[2], index: c.index });
  }
  for (const block of masked.matchAll(TOOL_SET_RE)) {
    const base = block.index + block[0].indexOf(block[2]);
    const admissions = [];
    for (const m of block[2].matchAll(/["'`]([A-Za-z0-9_.-]+)["'`]/g)) {
      admissions.push({ tool: m[1], index: base + m.index });
    }
    for (const m of block[2].matchAll(/(?:^|[[,\s.])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=[,\]]|$)/g)) {
      const known = constants.get(m[1]);
      if (known) admissions.push({ tool: known.value, index: known.index });
    }
    admissions.sort((a, b) => a.index - b.index);
    for (const { tool, index } of admissions) {
      const token = admissionCrossesBorder(tool, tokens);
      if (!token) continue;
      out.push(
        finding(
          "pack-named-passthrough",
          file,
          lineOf(masked, index),
          occurrenceDetail(counts, "pack-named-passthrough", tool),
          `passthrough tool admitted under one pack's name (${token}); admissions are by name and by scope, and the scope is the caller's own declaration`,
        ),
      );
    }
  }
  return out;
}

/** Every entry of the skill packaging legacy list, reported so the committed
 *  baseline has to name each one — which makes the list shrink-only. */
export function legacyExceptionFindings({ file, doc }) {
  const out = [];
  const counts = new Map();
  for (const field of ["exceptions", "embeddedSkills"]) {
    const rows = Array.isArray(doc?.[field]) ? doc[field] : [];
    for (const row of rows) {
      const raw = `${field} :: ${typeof row === "string" ? row : JSON.stringify(row)}`;
      const detail = occurrenceDetail(counts, "skill-legacy-exception", raw);
      out.push(
        finding(
          "skill-legacy-exception",
          file,
          1,
          detail,
          "the packaging legacy list is a shrink-only ratchet for pre-existing debt; a newly authored package may not enter it",
        ),
      );
    }
  }
  return out;
}

/** A materialized extensions/** file committed into this tree. Pack source is
 *  cloned at a pin, never authored here. Fails closed: git must answer. */
export function trackedExtensionFileFindings(repoRoot) {
  const res = spawnSync("git", ["ls-files", "--", "extensions"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(
      "[core-extension-border] cannot list tracked extensions/ files (git did not answer) — the gate fails closed rather than passing an unchecked tree",
    );
  }
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) =>
      finding(
        "materialized-extension-file",
        p,
        1,
        p,
        "pack source is materialized read-only at a committed pin; it is never committed into the host tree",
      ),
    );
}

function countLines(path) {
  const text = readFileSync(path, "utf8");
  return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** Measure one baselined pack-shaped core module (a file or a directory). */
export function measurePackShapedDomain(repoRoot, domainPath) {
  const abs = join(repoRoot, domainPath);
  const files = {};
  if (!existsSync(abs)) return files;
  if (statSync(abs).isDirectory()) {
    for (const f of walkProductFiles(abs, [], repoRoot)) {
      files[relative(repoRoot, f).split(sep).join("/")] = countLines(f);
    }
  } else if (isProductFile(abs.split(sep).pop())) {
    files[domainPath] = countLines(abs);
  }
  return files;
}

/** Growth of a baselined pack-shaped core module: a NEW file inside it, or a
 *  recorded file above its recorded line count. A growth key never matches a
 *  recorded key, so growth is always a violation. */
export function packShapedDomainFindings({ repoRoot, entries }) {
  const out = [];
  for (const entry of entries) {
    if (entry.rule !== "pack-shaped-core-domain") continue;
    const recorded = entry.files ?? {};
    const current = measurePackShapedDomain(repoRoot, entry.key);
    for (const [file, lines] of Object.entries(current)) {
      if (!(file in recorded)) {
        out.push(
          finding(
            "pack-shaped-core-domain",
            entry.key,
            1,
            `new file ${file}`,
            `a new file inside the pack-shaped core module ${entry.key}; the standing debt is shrink-only, a pack's flow belongs in the pack`,
          ),
        );
        continue;
      }
      if (lines > recorded[file]) {
        out.push(
          finding(
            "pack-shaped-core-domain",
            entry.key,
            1,
            `${file} grew to ${lines} lines (recorded ${recorded[file]})`,
            `the pack-shaped core module ${entry.key} grew; the standing debt is shrink-only`,
          ),
        );
      }
    }
  }
  return out;
}

export function loadPackUniverse(repoRoot, baselineEntries = []) {
  const packs = new Set();
  const locks = ["cinatra-required-extensions.lock.json", "cinatra-dev-extensions.lock.json"];
  const empty = [];
  let read = 0;
  for (const lock of locks) {
    const p = join(repoRoot, lock);
    if (!existsSync(p)) continue;
    read += 1;
    const doc = JSON.parse(readFileSync(p, "utf8"));
    let named = 0;
    for (const row of doc.packages ?? []) {
      if (!row?.packageName) continue;
      packs.add(row.packageName);
      named += 1;
    }
    if (named === 0) empty.push(lock);
  }
  // FAIL CLOSED. An absent lock — or one carrying no named package at all —
  // would thin the pack universe and quietly turn the type-id and passthrough
  // rules off, so such a tree is refused rather than reported clean. EACH lock
  // must answer; one lock cannot cover for the other.
  if (read !== locks.length || empty.length || packs.size === 0) {
    throw new Error(
      `[core-extension-border] cannot read the pack universe (${read} of ${locks.length} committed locks, ` +
        `${packs.size} packages${empty.length ? `, no named package in ${empty.join(" and ")}` : ""}) — ` +
        "the gate fails closed rather than scanning with half its rules disabled",
    );
  }
  // A pack the ledger already names stays in the universe even after it leaves
  // a lock. Acquisition membership changes; a recorded crossing may not become
  // invisible because the pack it names was unpinned.
  for (const e of baselineEntries) {
    for (const m of String(e?.key ?? "").matchAll(/(@cinatra-ai\/[a-z0-9][a-z0-9.-]*)/g)) packs.add(m[1]);
  }
  const workspacePackages = new Set();
  const pkgDir = join(repoRoot, "packages");
  if (existsSync(pkgDir)) {
    for (const d of readdirSync(pkgDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const manifest = join(pkgDir, d.name, "package.json");
      if (!existsSync(manifest)) continue;
      try {
        const name = JSON.parse(readFileSync(manifest, "utf8")).name;
        if (name) workspacePackages.add(name);
      } catch {
        /* unreadable manifest — the package simply does not shield a name */
      }
    }
  }
  for (const w of workspacePackages) packs.delete(w);
  return { packs, workspacePackages };
}

export const KNOWN_RULES = new Set([
  "pack-table-literal",
  "pack-type-id-in-core",
  "pack-package-name-branch",
  "pack-named-passthrough",
  "skill-legacy-exception",
  "materialized-extension-file",
  "pack-shaped-core-domain",
]);

/** Everything structurally wrong with a ledger, as messages. An unreadable or
 *  absent ledger is fatal: an empty ledger would silently re-admit every
 *  standing crossing as if it had been reviewed. */
export function baselineDefects(doc) {
  const bad = [];
  const entries = doc?.entries;
  if (!Array.isArray(entries)) return ["the ledger has no `entries` array"];
  const seen = new Set();
  for (const e of entries) {
    const id = `${e?.rule}::${e?.key}`;
    if (!KNOWN_RULES.has(e?.rule)) bad.push(`unknown rule: ${id}`);
    if (typeof e?.key !== "string" || e.key.trim() === "") bad.push(`empty key: ${id}`);
    if (seen.has(id)) bad.push(`duplicate entry: ${id}`);
    seen.add(id);
    if (e?.rule !== "pack-shaped-core-domain") continue;
    const root = String(e?.key ?? "").split("/")[0];
    if (!PRODUCT_ROOTS.includes(root) || String(e.key).split("/").length < 2) {
      bad.push(`a pack-shaped module must name a path under ${PRODUCT_ROOTS.join(" or ")}: ${id}`);
    }
    const files = e?.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) {
      bad.push(`no recorded line map: ${id}`);
      continue;
    }
    for (const [f, n] of Object.entries(files)) {
      if (!Number.isInteger(n) || n < 0) bad.push(`line count is not a whole number (${f}): ${id}`);
      if (!f.startsWith(`${e.key}/`) && f !== e.key) bad.push(`recorded file is outside the module (${f}): ${id}`);
    }
  }
  return bad;
}

export function readBaseline(baselinePath) {
  if (!existsSync(baselinePath)) {
    throw new Error(
      `[core-extension-border] the ledger ${baselinePath} is missing — the gate fails closed rather than treating an absent ledger as an empty one`,
    );
  }
  const entries = JSON.parse(readFileSync(baselinePath, "utf8")).entries ?? [];
  const keys = new Set();
  const reasons = new Map();
  for (const e of entries) {
    const k = `${e.rule}::${e.key}`;
    keys.add(k);
    reasons.set(k, e.reason ?? "");
  }
  return { entries, keys, reasons };
}

/** Baseline entries that carry no stated reason. Every entry is named and
 *  justified or the gate fails. */
export function unjustifiedBaselineEntries(doc) {
  const entries = doc?.entries ?? [];
  return entries
    .filter((e) => typeof e.reason !== "string" || e.reason.trim().length < 20)
    .map((e) => `${e.rule}::${e.key}`)
    .sort();
}

/** Baseline entries whose key holds a wildcard. The baseline names one file
 *  and one detail; it never matches a shape. */
export function wildcardBaselineEntries(doc) {
  const entries = doc?.entries ?? [];
  return entries.filter((e) => String(e.key).includes("*")).map((e) => `${e.rule}::${e.key}`).sort();
}

/** Keys the ledger GAINED against a previously committed copy of itself. The
 *  ledger is shrink-only: a crossing may leave it, none may enter. A domain
 *  entry that recorded a HIGHER line count, or a file it did not record, is
 *  growth too. */
export function baselineGrowth(previousDoc, currentDoc) {
  const previous = new Map();
  for (const e of previousDoc?.entries ?? []) previous.set(`${e.rule}::${e.key}`, e);
  const grown = [];
  for (const e of currentDoc?.entries ?? []) {
    const id = `${e.rule}::${e.key}`;
    const was = previous.get(id);
    if (!was) {
      grown.push(`new entry: ${id}`);
      continue;
    }
    for (const [f, n] of Object.entries(e.files ?? {})) {
      const before = (was.files ?? {})[f];
      if (before === undefined) grown.push(`new file recorded under ${id}: ${f}`);
      else if (n > before) grown.push(`raised allowance under ${id}: ${f} ${before} -> ${n}`);
    }
  }
  return grown.sort();
}

/** The committed ledger on the default branch, or null when this checkout
 *  cannot produce it (a shallow clone, or the ledger is new on this branch). */
export function committedBaseline(repoRoot, baselineRelPath, ref = "origin/main") {
  const res = spawnSync("git", ["show", `${ref}:${baselineRelPath}`], { cwd: repoRoot, encoding: "utf8" });
  if (res.status !== 0 || !res.stdout.trim()) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

export function violationsOf(findings, baselineKeys) {
  return findings.filter((f) => !baselineKeys.has(keyOf(f)));
}

/** Every crossing in the tree, the ones outside the baseline, and the baseline
 *  entries whose crossing is gone. */
export function scanRepository({ repoRoot = DEFAULT_REPO_ROOT, baselinePath = DEFAULT_BASELINE } = {}) {
  const baseline = readBaseline(baselinePath);
  const { packs, workspacePackages } = loadPackUniverse(repoRoot, baseline.entries);
  const findings = [];

  for (const root of PRODUCT_ROOTS) {
    for (const abs of walkProductFiles(join(repoRoot, root), [], repoRoot)) {
      const file = relative(repoRoot, abs).split(sep).join("/");
      const text = readFileSync(abs, "utf8");
      findings.push(...scanTextForCrossings({ file, text, packs, workspacePackages }));
      findings.push(...scanScopedToolAdmissions({ file, text, packs }));
    }
  }

  const legacyPath = join(repoRoot, "config", "skill-packaging-legacy-exceptions.json");
  if (existsSync(legacyPath)) {
    findings.push(
      ...legacyExceptionFindings({
        file: "config/skill-packaging-legacy-exceptions.json",
        doc: JSON.parse(readFileSync(legacyPath, "utf8")),
      }),
    );
  }

  findings.push(...trackedExtensionFileFindings(repoRoot));
  findings.push(...packShapedDomainFindings({ repoRoot, entries: baseline.entries }));

  const present = new Set(findings.map(keyOf));
  const stale = [...baseline.keys]
    .filter((k) => !k.startsWith("pack-shaped-core-domain::") && !present.has(k))
    .sort();
  // A recorded file that is GONE is spent allowance: left in the ledger it
  // would let the same path come back later carrying different pack code up to
  // the old line count. It is reported so the ratchet is shrunk.
  for (const entry of baseline.entries) {
    if (entry.rule !== "pack-shaped-core-domain") continue;
    const current = measurePackShapedDomain(repoRoot, entry.key);
    for (const f of Object.keys(entry.files ?? {})) {
      if (!(f in current)) stale.push(`pack-shaped-core-domain::${entry.key} :: ${f} is gone`);
    }
  }
  stale.sort();

  return { findings, violations: violationsOf(findings, baseline.keys), stale, baseline };
}

function writeBaseline(repoRoot, baselinePath) {
  const previous = readBaseline(baselinePath);
  const { findings } = scanRepository({ repoRoot, baselinePath });
  const entries = [];
  for (const f of findings) {
    if (f.rule === "pack-shaped-core-domain") continue;
    const k = keyOf(f);
    entries.push({
      rule: f.rule,
      key: `${f.file}::${f.detail}`,
      reason: previous.reasons.get(k) ?? "",
    });
  }
  // The writer may only SHRINK a pack-shaped module. A recorded file that grew
  // keeps its recorded allowance (so the growth stays a violation the author
  // must answer for), a file that shrank records the smaller count, a file that
  // is gone leaves the ledger, and a NEW file is never written in — otherwise
  // `--write-baseline` would launder exactly the growth this gate exists to
  // refuse.
  const refused = [];
  for (const e of previous.entries) {
    if (e.rule !== "pack-shaped-core-domain") continue;
    const current = measurePackShapedDomain(repoRoot, e.key);
    const files = {};
    for (const [f, recorded] of Object.entries(e.files ?? {})) {
      if (!(f in current)) continue;
      if (current[f] > recorded) refused.push(`${e.key} :: ${f} grew ${recorded} -> ${current[f]}`);
      files[f] = Math.min(recorded, current[f]);
    }
    for (const f of Object.keys(current)) {
      if (!(f in (e.files ?? {}))) refused.push(`${e.key} :: ${f} is a NEW file`);
    }
    entries.push({ ...e, files });
  }
  entries.sort((a, b) => a.rule.localeCompare(b.rule) || a.key.localeCompare(b.key));
  const doc = JSON.parse(readFileSync(baselinePath, "utf8"));
  doc.entries = entries;
  writeFileSync(baselinePath, JSON.stringify(doc, null, 2) + "\n");
  const added = entries.filter((e) => !previous.keys.has(`${e.rule}::${e.key}`));
  console.log(`[core-extension-border] baseline written (${entries.length} entries).`);
  if (refused.length) {
    console.log(`[core-extension-border] ${refused.length} growth(s) NOT written into the ledger — the ratchet only shrinks:`);
    for (const r of refused) console.log(`  ! ${r}`);
  }
  if (added.length) {
    // A regenerated ledger may only shrink. Every entry it gained is printed
    // here and left without a reason, so the check run refuses the tree until a
    // reviewer either removes the crossing or states in the diff why it stands.
    console.log(`[core-extension-border] ${added.length} NEW entr${added.length === 1 ? "y" : "ies"} — each needs a stated reason before the gate passes:`);
    for (const e of added) console.log(`  + ${e.rule}::${e.key}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const repoRoot = DEFAULT_REPO_ROOT;
  if (args.includes("--write-baseline")) {
    writeBaseline(repoRoot, DEFAULT_BASELINE);
    return;
  }

  if (!existsSync(DEFAULT_BASELINE)) {
    console.error(`[core-extension-border] FAIL — the ledger ${relative(repoRoot, DEFAULT_BASELINE)} is missing; an absent ledger is not an empty one.`);
    process.exit(1);
  }
  const doc = JSON.parse(readFileSync(DEFAULT_BASELINE, "utf8"));
  const unjustified = unjustifiedBaselineEntries(doc);
  const wildcards = wildcardBaselineEntries(doc);
  const defects = baselineDefects(doc);
  if (unjustified.length || wildcards.length || defects.length) {
    console.error("[core-extension-border] FAIL — the baseline is not a named, justified ledger:");
    for (const k of unjustified) console.error(`  + no stated reason: ${k}`);
    for (const k of wildcards) console.error(`  + wildcard key: ${k}`);
    for (const d of defects) console.error(`  + ${d}`);
    process.exit(1);
  }

  // The ledger itself is shrink-only. Where this checkout can produce the
  // committed ledger from the default branch, any key it GAINED — or any raised
  // allowance — fails, so a crossing cannot be admitted by writing itself in.
  const rel = relative(repoRoot, DEFAULT_BASELINE).split(sep).join("/");
  const previousDoc = committedBaseline(repoRoot, rel);
  const grown = previousDoc ? baselineGrowth(previousDoc, doc) : [];
  if (grown.length) {
    console.error(
      `[core-extension-border] FAIL — the ledger grew against the default branch; it is shrink-only, a crossing is removed rather than admitted:`,
    );
    for (const g of grown) console.error(`  + ${g}`);
    process.exit(1);
  }

  const { findings, violations, stale } = scanRepository({ repoRoot, baselinePath: DEFAULT_BASELINE });

  if (args.includes("--report")) {
    console.log(`[core-extension-border] ${findings.length} crossing(s) in the tree, baselined ones included:`);
    for (const f of findings.slice().sort((a, b) => keyOf(a).localeCompare(keyOf(b)))) {
      console.log(`  ${f.rule}  ${f.file}:${f.line}  ${f.detail}`);
    }
  }

  if (violations.length) {
    console.error(
      `[core-extension-border] FAIL — ${violations.length} crossing(s) outside the shrink-only baseline. ` +
        "A pack's table, type id, name or flow does not live in the host; see docs/internals/contracts/core-extension-border.md:",
    );
    for (const f of violations.slice().sort((a, b) => keyOf(a).localeCompare(keyOf(b)))) {
      console.error(`  + ${f.rule}  ${f.file}:${f.line}  ${f.detail}`);
      console.error(`      ${f.message}`);
    }
    process.exit(1);
  }

  if (stale.length) {
    console.log(
      `[core-extension-border] NOTE — ${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} gone; ` +
        "run --write-baseline to shrink the ratchet:",
    );
    for (const k of stale) console.log(`  - ${k}`);
  }

  console.log(
    `[core-extension-border] OK — ${findings.length} crossing(s), all inside the named shrink-only baseline.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
