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
// THE BASELINE (scripts/ci/core-extension-border-baseline.json) is SHRINK-ONLY. It
// records the crossings that stood on main the day this gate landed, each with
// the file, the rule and a one-line reason. It carries no wildcard: an entry
// names one file and one detail. A finding outside it fails immediately, and a
// baselined pack-shaped core module that GROWS — a new file in a baselined
// directory, or a recorded file above its recorded line count — fails too,
// because the key of a growth finding can never match a recorded key. An entry
// whose crossing is gone is STALE and fails, as in the sibling gates, until
// --write-baseline shrinks the ratchet.
//
// THE BASE GUARD (cinatra#3831): the ledger of the checkout is compared with
// the copy on the base branch, entry by entry and count by count, through the
// shared guard scripts/audit/lib/floor-base-guard.mjs. A new entry, a new
// recorded file or a raised count fails. The base is CORE_EXTENSION_BORDER_BASE
// when set, else the pull request's base branch; a base that cannot be read
// fails closed with a line that names the reason. The ledger's `rules` list
// names the rules it ratchets: a rule the base's list lacks is seeded once in
// the pull request that adds it (cinatra#4852); a listed rule never gains an
// entry, and every rule the base ratchets must still be known at the head (the
// rule set is append-only, so a rename cannot reset a floor). A base ledger without the list ratchets every rule its base copy of
// this script knows (zero-entry rules too); that copy unread fails closed.
//
// Usage:
//   node scripts/ci/core-extension-border-gate.mjs                  # check (exit 1 on any finding outside the baseline, a stale entry or a grown ledger)
//   node scripts/ci/core-extension-border-gate.mjs --report         # print every finding, baselined ones included
//   node scripts/ci/core-extension-border-gate.mjs --write-baseline # regenerate, carrying every existing reason forward
//   CORE_EXTENSION_BORDER_BASE=<ref> node scripts/ci/core-extension-border-gate.mjs  # also fail if the ledger GREW vs <ref>

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { compareFloorWithBase, readFileAtBase, reportFloorGuard } from "../audit/lib/floor-base-guard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname, "..", "..");
const DEFAULT_BASELINE = join(DEFAULT_REPO_ROOT, "scripts", "ci", "core-extension-border-baseline.json");

/** The variable a workflow names the base reference in (cinatra#3831). */
export const FLOOR_BASE_VAR = "CORE_EXTENSION_BORDER_BASE";

/** The ledger, repo-relative, as the base guard reads it at the base. */
export const FLOOR_FILE = "scripts/ci/core-extension-border-baseline.json";

/** Where the ledger stood before it moved beside its script. A base commit that
 *  predates the move holds it here; the base guard reads this path when the
 *  base has none at FLOOR_FILE, so the move itself is still compared. */
export const LEGACY_FLOOR_FILE = "config/core-extension-border-baseline.json";
/** This script, repo-relative: its base copy names the rules a pre-`rules` base ledger ratchets. */
export const GATE_FILE = "scripts/ci/core-extension-border-gate.mjs";

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

/** The word runs that name one pack (cinatra#4852), derived from the locks:
 *  every run of two or more consecutive words of a pack's stem (its package
 *  name without the scope and the role suffix), and the single word of a
 *  one-word stem or the first word of a connector (its vendor word) for the
 *  packs whose name carries the agent or connector role. A one-word artifact
 *  or skill stem (`text`, `image`) is a type or shape word and is left out.
 *  `@cinatra-ai/email-follow-up-agent` gives `email-follow`, `follow-up`,
 *  `email-follow-up`; `@cinatra-ai/gmail-connector` gives `gmail`. */
const STEP_ROLE_RE = /-(agents?|connectors?|workflows?)$/;
const CONNECTOR_ROLE_RE = /-connectors?$/;

export function packStepWordRuns(packs) {
  const runs = new Set();
  for (const p of packs) {
    const leaf = String(p).replace(/^@[^/]+\//, "");
    const words = leaf.replace(ROLE_SUFFIX_RE, "").split("-").filter(Boolean);
    if (words.length === 0) continue;
    for (let k = 2; k <= words.length; k += 1) {
      for (let i = 0; i + k <= words.length; i += 1) runs.add(words.slice(i, i + k).join("-"));
    }
    if (STEP_ROLE_RE.test(leaf) && words.length === 1) runs.add(words[0]);
    if (CONNECTOR_ROLE_RE.test(leaf)) runs.add(words[0]);
  }
  return runs;
}

/** The longest pack word run a step-screen kind's name carries, or null. */
export function kindCrossesBorder(kind, runs) {
  const words = String(kind).split(/[-_]/).filter(Boolean);
  for (let k = words.length; k >= 1; k -= 1) {
    for (let i = 0; i + k <= words.length; i += 1) {
      const run = words.slice(i, i + k).join("-");
      if (runs.has(run)) return run;
    }
  }
  return null;
}

/** The pinned packages whose word runs a kind's name carries (cinatra#4852),
 *  sorted: the lock-derived words that make it a finding. Each one is named in
 *  the finding's detail, so the ledger key carries the package identity the
 *  way every other rule's key does, and `loadPackUniverse` keeps a pack the
 *  ledger names in the universe after it leaves the locks. */
export function kindMatchedPacks(kind, packs) {
  const words = String(kind).split(/[-_]/).filter(Boolean);
  const kindRuns = new Set();
  for (let k = 1; k <= words.length; k += 1) {
    for (let i = 0; i + k <= words.length; i += 1) kindRuns.add(words.slice(i, i + k).join("-"));
  }
  const out = [];
  for (const p of packs) {
    for (const run of packStepWordRuns([p])) {
      if (kindRuns.has(run)) {
        out.push(String(p));
        break;
      }
    }
  }
  return out.sort();
}

/** A step-screen kind table is recognised by its NAME, as the passthrough rule
 *  follows `*TOOLS`, never by one module's file name: a `const`, `let` or `var`
 *  binding (at any depth, in any product file) whose identifier ends in
 *  `KIND_TABLE` or `KindTable`. Only the declaration is read; what code does
 *  with the table afterwards is left to tsc through the table's shape. */
const KIND_TABLE_NAME_RE = /^[A-Za-z0-9_$]*(?:KIND_TABLE|KindTable)$/;

function scriptKindOf(file) {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const compact = (s) => s.replace(/\s+/g, " ").trim().slice(0, 80);

/** The expression a type wrapper or parentheses hold: `x as const`,
 *  `x satisfies T`, `(x)`, `<T>x`, `x!`. */
function unwrap(node) {
  let n = node;
  while (
    n &&
    (ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isSatisfiesExpression(n) ||
      ts.isTypeAssertionExpression(n) ||
      ts.isNonNullExpression(n))
  ) {
    n = n.expression;
  }
  return n;
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

/** Every binding of `name` in the file and what it holds: the value when the
 *  binding is `const NAME = "<string>"` (a string or a plain template, through
 *  `as const` / `satisfies`), else null (a `let`, `var`, parameter, import,
 *  function, class, destructured name or a const of any other value). */
function bindingsOf(sf, name) {
  const out = [];
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      const isConst = (ts.getCombinedNodeFlags(n) & ts.NodeFlags.Const) !== 0;
      const init = n.initializer ? unwrap(n.initializer) : undefined;
      const literal = init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init));
      out.push(isConst && literal ? init.text : null);
      return;
    }
    if (
      (ts.isParameter(n) ||
        ts.isBindingElement(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isClassDeclaration(n) ||
        ts.isEnumDeclaration(n) ||
        ts.isImportSpecifier(n) ||
        ts.isImportClause(n) ||
        ts.isNamespaceImport(n) ||
        ts.isImportEqualsDeclaration(n)) &&
      n.name &&
      ts.isIdentifier(n.name) &&
      n.name.text === name
    ) {
      out.push(null);
    }
  });
  return out;
}

/** The literal name a computed key `[expr]` stands for: a string literal, a
 *  template literal with no substitution, or an identifier whose EVERY binding
 *  in the file is a `const` holding one and the same string. Anything else is
 *  null. */
function resolveComputedKey(sf, expr) {
  const e = unwrap(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (!ts.isIdentifier(e)) return null;
  const values = bindingsOf(sf, e.text);
  if (values.length === 0 || values.includes(null) || new Set(values).size !== 1) return null;
  return values[0];
}

/** The entries of one kind table declaration, each with its node: `{ kind,
 *  node }` for a key read to a literal name, `{ unreadable, node }` for one the
 *  gate cannot read (an unresolvable computed key, a spread, a method or an
 *  accessor, a table that is not an object literal, or one declared without an
 *  initializer). FAIL CLOSED: an entry is read or reported, never skipped. */
export function kindTableEntries(sf, decl) {
  if (!decl.initializer) return [{ unreadable: "(no initializer)", node: decl }];
  const init = unwrap(decl.initializer);
  if (!ts.isObjectLiteralExpression(init)) {
    return [{ unreadable: compact(decl.initializer.getText(sf)), node: decl.initializer }];
  }
  const entries = [];
  for (const p of init.properties) {
    if (ts.isSpreadAssignment(p)) {
      entries.push({ unreadable: `...${compact(p.expression.getText(sf))}`, node: p });
      continue;
    }
    if (ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
      const how = ts.isGetAccessorDeclaration(p) ? "get " : ts.isSetAccessorDeclaration(p) ? "set " : "method ";
      entries.push({ unreadable: `${how}${compact(p.name.getText(sf))}`, node: p });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(p)) {
      entries.push({ kind: p.name.text, node: p });
      continue;
    }
    if (ts.isPropertyAssignment(p)) {
      const name = p.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
        entries.push({ kind: name.text, node: p });
      } else if (ts.isNumericLiteral(name)) {
        entries.push({ kind: String(Number(name.text)), node: p });
      } else if (ts.isComputedPropertyName(name)) {
        const kind = resolveComputedKey(sf, name.expression);
        entries.push(
          kind === null ? { unreadable: `[${compact(name.expression.getText(sf))}]`, node: p } : { kind, node: p },
        );
      } else {
        entries.push({ unreadable: compact(name.getText(sf)), node: p });
      }
      continue;
    }
    entries.push({ unreadable: compact(p.getText(sf)), node: p });
  }
  return entries;
}

/** The kind tables a file declares (cinatra#4852): every variable declaration
 *  whose identifier has the kind table name shape (a loop variable aside). */
export function kindTableDeclarations(sf) {
  const declarations = [];
  walk(sf, (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      KIND_TABLE_NAME_RE.test(n.name.text) &&
      !(n.parent?.parent && (ts.isForOfStatement(n.parent.parent) || ts.isForInStatement(n.parent.parent)))
    ) {
      declarations.push(n);
    }
  });
  return declarations;
}

/** The shape that makes a later entry a compile error (cinatra#4852): the
 *  table is declared `const` and typed `Readonly<...>` at its declaration, so
 *  `TABLE[k] = v`, `TABLE.k = v` and `delete TABLE[k]` fail the repository's
 *  `tsc`. The gate judges the declaration only; it does not follow the table
 *  after it. Returns why a declaration is not in that shape, or null. */
export function kindTableShapeDefect(decl) {
  const isConst = (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;
  const type = decl.type;
  const readonlyType =
    type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === "Readonly";
  if (isConst && readonlyType) return null;
  return [!isConst && "not `const`", !readonlyType && "not typed `Readonly<...>`"].filter(Boolean).join(", ");
}

/** A step-screen kind registered in core under a name that carries one pack's
 *  word run (cinatra#4852). Core keeps generic machinery under kinds named for
 *  a screen's shape; the step itself belongs to the agent that declares it.
 *  The file is read with the TypeScript parser, never by text patterns, and
 *  only the table's DECLARATION is judged: its entries, and its shape (`const`
 *  and `Readonly<...>`, so tsc refuses a later entry). Each finding names in
 *  its detail the pinned package(s) whose words it carries
 *  (`gmail-sender (@cinatra-ai/gmail-connector)`). Returns the findings and
 *  the number of kind tables the file declares. */
export function scanStepScreenKindTables({ file, text, packs }) {
  if (!/(?:KIND_TABLE|KindTable)/.test(text)) return { findings: [], tables: 0 };
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKindOf(file));
  const runs = packStepWordRuns(packs);
  const findings = [];
  const counts = new Map();
  const lineAt = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const refuse = (detail, node, message) =>
    findings.push(finding("pack-step-kind-in-core", file, lineAt(node), occurrenceDetail(counts, "pack-step-kind-in-core", detail), message));
  const unreadable = (what, node) =>
    refuse(
      `unreadable entry: ${what}`,
      node,
      "unreadable kind table entry: the gate cannot read this entry to a literal kind name, so it cannot judge it; " +
        "write the kind table as an object literal of string keys (a computed key only from a string or a same-file const)",
    );
  // A file that does not parse cannot be read whole: fail closed.
  for (const d of sf.parseDiagnostics ?? []) {
    unreadable(`(the file does not parse: ${compact(ts.flattenDiagnosticMessageText(d.messageText, " "))})`, sf);
    break;
  }
  const declarations = kindTableDeclarations(sf);
  for (const decl of declarations) {
    const shape = kindTableShapeDefect(decl);
    if (shape) {
      refuse(
        `kind table shape: ${decl.name.text} (${shape})`,
        decl,
        "a kind table is declared `const` and typed `Readonly<...>` so that tsc refuses an entry added after the declaration; " +
          "the gate judges only the declaration's entries",
      );
    }
    for (const entry of kindTableEntries(sf, decl)) {
      if (entry.unreadable !== undefined) {
        unreadable(entry.unreadable, entry.node);
        continue;
      }
      const run = kindCrossesBorder(entry.kind, runs);
      if (!run) continue;
      const matched = kindMatchedPacks(entry.kind, packs);
      const f = finding(
        "pack-step-kind-in-core",
        file,
        lineAt(entry.node),
        occurrenceDetail(counts, "pack-step-kind-in-core", `${entry.kind} (${matched.join(", ")})`),
        `core registers a step-screen kind named after one pack (${run}); the agent declares its step with a generic kind named for the screen's shape`,
      );
      f.kind = entry.kind;
      f.packages = matched;
      findings.push(f);
    }
  }
  return { findings, tables: declarations.length };
}

const KIND_KEY_RE = /^(.*?)::(.+?) \((@[^()]+)\)(?: \(occurrence (\d+)\))?$/;

/** A kind finding keeps the detail its ledger entry recorded while every
 *  package that entry names still matches the kind (they stay in the pack
 *  universe through the ledger): a pack ADDED to the locks that also matches
 *  the kind does not re-key a standing entry. The kind, the file and the
 *  occurrence must be the same. */
export function keepRecordedKindDetails(findings, baselineEntries) {
  const recorded = new Map();
  for (const e of baselineEntries ?? []) {
    if (e?.rule !== "pack-step-kind-in-core") continue;
    const m = KIND_KEY_RE.exec(String(e.key ?? ""));
    if (!m) continue;
    recorded.set(`${m[1]}::${m[2]}::${m[4] ?? "1"}`, { detail: String(e.key).slice(m[1].length + 2), packages: m[3].split(", ") });
  }
  for (const f of findings) {
    if (f.rule !== "pack-step-kind-in-core" || !f.kind) continue;
    const occ = /\(occurrence (\d+)\)$/.exec(f.detail)?.[1] ?? "1";
    const r = recorded.get(`${f.file}::${f.kind}::${occ}`);
    if (r && r.detail !== f.detail && r.packages.every((p) => f.packages.includes(p))) f.detail = r.detail;
  }
  return findings;
}

/** The registration contract (cinatra#4872): the SDK's registration module exports the entry
 *  type `ExtensionServerEntry`, whose `register` takes the context the product hands every
 *  extension. These three names and the module's path are the only names this rule knows. */
export const PORT_CONTRACT = { file: "packages/sdk-extensions/src/register.ts", type: "ExtensionServerEntry", member: "register" };

/** The compiler options of the product's own tsconfig.json at the repository root. */
function productCompilerOptions(repoRoot) {
  const config = join(repoRoot, "tsconfig.json");
  const fail = (d) => {
    throw new Error(`[core-extension-border] the compiler options in tsconfig.json cannot be read (${compact(ts.flattenDiagnosticMessageText(d.messageText, " "))}) — the port rule fails closed`);
  };
  if (!existsSync(config)) fail({ messageText: "no such file" });
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, readDirectory: () => [], onUnRecoverableConfigFileDiagnostic: fail });
  for (const d of parsed?.errors ?? []) if (d.code !== 18003) fail(d); // 18003: no inputs found, the include list is not expanded
  return { ...parsed.options, noEmit: true, incremental: false, composite: false, tsBuildInfoFile: undefined };
}

/** `unbounded-port-member` (cinatra#4872): a host port member with a call signature that takes a
 *  FREE NAME (a parameter of the plain `string` type) together with an UNTYPED PAYLOAD (another
 *  parameter of type `any` or `unknown`), the shape `run(name: string, input: unknown)`. Decided on
 *  the checker's resolved types, never on how a type is written: a union counts as free when one
 *  constituent is plain `string` (a union of string literals is bounded), a type parameter counts
 *  by its constraint (none, or `unknown`, is untyped; `string` is a free name). The anchor is the
 *  registration contract: the module's exports, aliases followed, the entry type's `register`
 *  property, the first parameter of each call signature (the context); its members are the ports,
 *  and each own, non-private member of a port is read, every union or intersection constituent and
 *  every overload. A finding is keyed `<Port>.<member>`: the port as the extension reaches it (see
 *  `portOf`); the same port reached twice is one finding, a port that inherits the member is its own,
 *  and two different port declarations with one key fail closed. A type the checker cannot resolve,
 *  or a missing anchor, fails closed. */
export function unboundedPortMemberFindings({ repoRoot = DEFAULT_REPO_ROOT, contractFile = PORT_CONTRACT.file } = {}) {
  const realRoot = realpathSync(repoRoot);
  const contractPath = join(realRoot, contractFile);
  if (!existsSync(contractPath) && !existsSync(dirname(dirname(contractPath)))) return []; // a tree without the SDK package has no ports
  const program = ts.createProgram({ rootNames: existsSync(contractPath) ? [contractPath] : [], options: productCompilerOptions(realRoot) });
  const checker = program.getTypeChecker();
  const F = ts.TypeFlags;
  const rel = (f) => relative(realRoot, f).split(sep).join("/");
  const flat = (t) => (t.isUnion() ? t.types.flatMap(flat) : [t]);
  const fail = (what) => new Error(`[core-extension-border] the registration contract ${PORT_CONTRACT.type}.${PORT_CONTRACT.member}(…) ${what} in ${contractFile} — the rule fails closed rather than reading no port`);
  const typeOf = (sym) => {
    const t = checker.getTypeOfSymbol(sym);
    if (t.flags & F.Any && (t.intrinsicName === "error" || t.intrinsicName === "unresolved")) {
      throw new Error(`[core-extension-border] the border check could not resolve a type of ${checker.symbolToString(sym)} in ${contractFile}`);
    }
    return t;
  };

  // The two questions asked of a RESOLVED parameter type.
  const freeString = (t, seen = new Set()) => {
    if (t.flags & F.String) return true;
    if (t.flags & F.TypeParameter && !seen.has(t)) {
      const c = checker.getBaseConstraintOfType(t);
      return !!c && freeString(c, seen.add(t));
    }
    // `string & {}` (the open half of a "literal union with an open end") is still a free string.
    if (t.isIntersection()) return t.types.some((c) => c.flags & F.String) && t.types.every((c) => c.flags & F.String || (c.flags & F.Object && checker.getPropertiesOfType(c).length === 0));
    return t.isUnion() && t.types.some((c) => freeString(c, seen));
  };
  const untyped = (t, seen = new Set()) => {
    if (t.flags & (F.Any | F.Unknown)) return true;
    if (t.flags & F.TypeParameter && !seen.has(t)) {
      const c = checker.getBaseConstraintOfType(t);
      return !c || untyped(c, seen.add(t));
    }
    return t.isUnion() && t.types.some((c) => untyped(c, seen));
  };
  // THE parameter lists of a call signature: a list of ALTERNATIVE parameter-type lists, decided on
  // resolved types. Fixed parameters stay as they are (`this` is not a parameter); the one rest
  // parameter (read from its `...` marker, the only declaration read) expands once per alternative of
  // its type: a union per constituent, a type parameter through its base constraint, a tuple to its
  // elements (named or not, optional or not), an array `T[]` to zero or more T (T counts as both the
  // name and the payload position only when T alone can be a free name and untyped, `string | U`).
  const restLists = (t, seen = new Set()) => {
    if (t.isUnion()) return t.types.flatMap((c) => restLists(c, seen));
    if (t.flags & F.TypeParameter) {
      const c = seen.has(t) ? undefined : checker.getBaseConstraintOfType(t);
      return c ? restLists(c, new Set(seen).add(t)) : [[t]];
    }
    if (checker.isTupleType(t)) return [checker.getTypeArguments(t)];
    const e = checker.getIndexTypeOfType(t, ts.IndexKind.Number) ?? t;
    return [freeString(e) && untyped(e) ? [e, e] : [e]];
  };
  const parameterLists = (sig) =>
    sig.getParameters().reduce((lists, p) => {
      const next = p.valueDeclaration?.dotDotDotToken ? restLists(typeOf(p)) : [[typeOf(p)]];
      return lists.flatMap((l) => next.map((n) => [...l, ...n]));
    }, [[]]);
  // The anchor: the entry type through the module's exports, then its `register`, then the context.
  const sourceFile = program.getSourceFile(contractPath);
  const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
  let entry = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((s) => s.name === PORT_CONTRACT.type);
  while (entry && entry.flags & ts.SymbolFlags.Alias) entry = checker.getAliasedSymbol(entry);
  if (!entry || !entry.declarations?.length) throw fail("is not an export of its module");
  const register = checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(entry), PORT_CONTRACT.member);
  if (!register) throw fail(`has no ${PORT_CONTRACT.member} property`);
  const signatures = flat(checker.getNonNullableType(typeOf(register))).flatMap((t) => t.getCallSignatures());
  if (signatures.length === 0) throw fail(`${PORT_CONTRACT.member} has no call signature`);
  const contexts = signatures.flatMap((sig) =>
    parameterLists(sig).flatMap((list) => {
      if (list.length === 0) throw fail(`has a ${PORT_CONTRACT.member} signature without a first parameter`);
      // `null` and `undefined` are no context; a type parameter is its default, else its constraint.
      return flat(list[0]).filter((c) => !(c.flags & (F.Null | F.Undefined))).map((c) => (c.flags & F.TypeParameter ? checker.getDefaultFromTypeParameter(c) ?? checker.getBaseConstraintOfType(c) : c));
    }),
  );
  if (contexts.some((c) => !c || c.flags & (F.Any | F.Unknown))) throw fail(`has an untyped ${PORT_CONTRACT.member} context`);

  const hasShape = (sig) => parameterLists(sig).some((types) => types.some((t, i) => freeString(t) && types.some((u, j) => i !== j && untyped(u))));

  // Members: own (not from the TypeScript lib or node_modules) and callable by an extension (not private or protected).
  const isOwn = (prop) =>
    (prop.declarations ?? []).length === 0 ||
    prop.declarations.some((d) => !program.isSourceFileDefaultLibrary(d.getSourceFile()) && !d.getSourceFile().fileName.split("/").includes("node_modules"));
  const isHidden = (prop) =>
    (prop.declarations ?? []).length > 0 &&
    prop.declarations.every((d) => (ts.getCombinedModifierFlags(d) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0 || (d.name && ts.isPrivateIdentifier(d.name)));
  const membersOf = (t) => flat(t).flatMap((c) => flat(checker.getApparentType(c)).flatMap((a) => checker.getPropertiesOfType(a))).filter((p) => isOwn(p) && !isHidden(p));
  // A port as the extension reaches it, split to its parts: a union or intersection per constituent, a
  // type parameter through its base constraint (none: no port).
  const parts = (t, seen = new Set()) => {
    if (t.isUnion() || t.isIntersection()) return t.types.flatMap((c) => parts(c, seen));
    if (t.flags & F.TypeParameter && !seen.has(t)) {
      const c = checker.getBaseConstraintOfType(t);
      return c ? parts(c, new Set(seen).add(t)) : [];
    }
    return [t];
  };
  // THE IDENTITY of a port: its name and the declaration that name stands for. The name is the
  // resolved declaration's own (an alias of an interface or class is that interface or class;
  // instantiations `Port<A>` and `Port<B>` are the one declared port `Port`); a literal type takes the
  // name of the alias that declares it, and an anonymous one (inline, or a generic alias) the name of
  // the context property that exposes it.
  const portOf = (t, fallback) => {
    const sym = t.getSymbol();
    if (sym && !sym.name.startsWith("__")) return { name: sym.name, decl: sym.declarations?.[0] ?? t };
    if (t.aliasSymbol && !t.aliasTypeArguments?.length) return { name: t.aliasSymbol.name, decl: t.aliasSymbol.declarations?.[0] ?? t };
    return { name: fallback, decl: sym?.declarations?.[0] ?? t };
  };

  // THE IDENTITY of a finding: the port as the extension reaches it, and the member: `<Port>.<member>`.
  // It is the ledger's detail and the only thing findings are told apart by: the same port reached twice
  // is one finding; a different port that inherits the member is its own; two DIFFERENT port
  // declarations that produce one such string cannot be told apart by the ledger, so the rule fails
  // closed. Nothing else is remembered: no visited member, no visited type.
  const out = [];
  const emitted = new Map();
  const shapes = new Map();
  const shaped = (prop) => {
    if (!shapes.has(prop)) shapes.set(prop, flat(checker.getNonNullableType(typeOf(prop))).flatMap((c) => c.getCallSignatures()).some(hasShape));
    return shapes.get(prop);
  };
  const judge = ({ name, decl }, prop) => {
    if (!shaped(prop)) return;
    const detail = `${name}.${checker.symbolToString(prop)}`;
    const first = emitted.get(detail);
    if (first) {
      if (first !== decl) {
        throw new Error(`[core-extension-border] two different port declarations are both reported as "${detail}" — one ledger key cannot name both; rename one of them (the rule fails closed)`);
      }
      return;
    }
    emitted.set(detail, decl);
    const d = prop.valueDeclaration ?? prop.declarations?.[0] ?? register.declarations?.[0] ?? entry.declarations[0];
    out.push(
      finding(
        "unbounded-port-member",
        rel(d.getSourceFile().fileName),
        d.getSourceFile().getLineAndCharacterOfPosition(d.getStart()).line + 1,
        detail,
        "a host port member takes a free name (a plain string) together with an untyped payload (any or unknown): a generic tunnel to any core behaviour; declare the names as a literal union the manifest bounds (cinatra#4872)",
      ),
    );
  };
  for (const ctx of contexts.flatMap((c) => parts(c))) {
    for (const prop of membersOf(ctx)) {
      judge(portOf(ctx, "ctx"), prop);
      for (const port of parts(checker.getNonNullableType(typeOf(prop)))) {
        for (const member of membersOf(port)) judge(portOf(port, checker.symbolToString(prop)), member);
      }
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
  "pack-step-kind-in-core",
  "unbounded-port-member",
]);

/** The ledger's `rules` list (cinatra#4852): the rules it ratchets. When it
 *  is present it names every rule of the gate and no other; the committed
 *  ledger must carry it (`requireList`), because the base guard reads it. */
export function rulesListDefects(doc, { requireList = false } = {}) {
  const rules = doc?.rules;
  if (rules === undefined) return requireList ? ["the ledger has no `rules` array (the rules it ratchets)"] : [];
  if (!Array.isArray(rules)) return ["the ledger's `rules` is not an array"];
  const bad = [];
  for (const r of rules) if (!KNOWN_RULES.has(r)) bad.push(`unknown rule in \`rules\`: ${r}`);
  for (const r of KNOWN_RULES) if (!rules.includes(r)) bad.push(`a rule of the gate is not in \`rules\`: ${r}`);
  return bad;
}

/** Everything structurally wrong with a ledger, as messages. An unreadable or
 *  absent ledger is fatal: an empty ledger would silently re-admit every
 *  standing crossing as if it had been reviewed. */
export function baselineDefects(doc) {
  const bad = [];
  const entries = doc?.entries;
  if (!Array.isArray(entries)) return ["the ledger has no `entries` array"];
  bad.push(...rulesListDefects(doc));
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
    if (Object.keys(files).length === 0) {
      bad.push(`stale entry, every recorded file is gone (an empty line map), run --write-baseline to drop it: ${id}`);
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
/** The rules a ledger has ratcheted: its `rules` list, or, in a base ledger
 *  written before the list existed, EVERY rule the base copy of this script
 *  knows (attached by `checkFloorAgainstBase` as BASE_SCRIPT_RULES), so a
 *  zero-entry rule is ratcheted too. Neither present: fail closed. */
export const BASE_SCRIPT_RULES = Symbol("base-script-rules");

export function ledgerRules(doc) {
  if (Array.isArray(doc?.rules)) return new Set(doc.rules);
  if (doc?.[BASE_SCRIPT_RULES] instanceof Set) return doc[BASE_SCRIPT_RULES];
  throw new Error("[core-extension-border] the base ledger has no `rules` list and the base gate script's rules were not read — failing closed");
}

/** The rule ids of a copy of this script: its `KNOWN_RULES = new Set([...])`. */
export function scriptRuleIds(text) {
  const m = /\bKNOWN_RULES\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(text);
  const ids = m ? [...m[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map((x) => x[1] ?? x[2]) : [];
  if (ids.length === 0) throw new Error(`the base copy of ${GATE_FILE} names no rule list (KNOWN_RULES)`);
  return new Set(ids);
}

/** The base ledger, and for one written before the `rules` list the rules of
 *  the base copy of this script, read from the same base. */
function parseBaseLedger(text, { ref, repoRoot }) {
  const doc = JSON.parse(text);
  if (doc?.rules !== undefined) return doc;
  const script = readFileAtBase(repoRoot, ref, GATE_FILE);
  if (!script.ok) throw new Error(script.reason);
  doc[BASE_SCRIPT_RULES] = scriptRuleIds(script.text);
  return doc;
}

export function baselineGrowth(previousDoc, currentDoc) {
  const previous = new Map();
  for (const e of previousDoc?.entries ?? []) previous.set(`${e.rule}::${e.key}`, e);
  // A rule the base ledger does not list yet is SEEDED in the pull request
  // that adds it (cinatra#4852): its standing crossings enter the ledger once,
  // the rule enters `rules`, and from the next base on it only shrinks. A rule
  // the base lists can never gain an entry, also after its last entry left.
  // The rule set is APPEND-ONLY against the base: every rule the base ratchets
  // must still be known at the head, in this script's KNOWN_RULES and in the
  // head ledger's `rules` list, or a rename (old rows dropped, new ones seeded)
  // would reset the floor. A rule is retired only by a change to this guard.
  const ratcheted = ledgerRules(previousDoc);
  const headList = Array.isArray(currentDoc?.rules) ? currentDoc.rules : null;
  const grown = [];
  for (const r of ratcheted) {
    if (!KNOWN_RULES.has(r) || (headList && !headList.includes(r))) {
      grown.push(`a rule of the base is gone at the head (the rule set is append-only): ${r}`);
    }
  }
  for (const e of currentDoc?.entries ?? []) {
    const id = `${e.rule}::${e.key}`;
    const was = previous.get(id);
    if (!was) {
      if (!ratcheted.has(e.rule)) continue;
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

/** The ledger compared with its copy on the base branch (cinatra#3831). Growth
 *  is baselineGrowth's: a new entry, a new recorded file or a raised count. A
 *  base that cannot be read fails closed. */
export function checkFloorAgainstBase({ repoRoot = DEFAULT_REPO_ROOT, env = process.env, headFloor } = {}) {
  return compareFloorWithBase({
    gate: "core-extension-border",
    envVar: FLOOR_BASE_VAR,
    floorPath: FLOOR_FILE,
    baseFallbackPath: LEGACY_FLOOR_FILE,
    headFloor: headFloor ?? JSON.parse(readFileSync(join(repoRoot, FLOOR_FILE), "utf8")),
    parse: parseBaseLedger,
    grown: (base, head) => baselineGrowth(base, head),
    repoRoot,
    env,
  });
}

/** The verdict on the ledger entries whose crossing is gone: a stale entry
 *  fails, as in the sibling gates, until --write-baseline shrinks the ratchet. */
export function staleVerdict(stale) {
  if (stale.length === 0) return { ok: true, lines: [] };
  return {
    ok: false,
    lines: [
      `[core-extension-border] FAIL — ${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} gone; ` +
        "run --write-baseline to shrink the ratchet:",
      ...stale.map((k) => `  - ${k}`),
    ],
  };
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
  let kindTables = 0;

  for (const root of PRODUCT_ROOTS) {
    for (const abs of walkProductFiles(join(repoRoot, root), [], repoRoot)) {
      const file = relative(repoRoot, abs).split(sep).join("/");
      const text = readFileSync(abs, "utf8");
      findings.push(...scanTextForCrossings({ file, text, packs, workspacePackages }));
      findings.push(...scanScopedToolAdmissions({ file, text, packs }));
      const kinds = scanStepScreenKindTables({ file, text, packs });
      findings.push(...kinds.findings);
      kindTables += kinds.tables;
    }
  }
  keepRecordedKindDetails(findings, baseline.entries);
  // FAIL CLOSED (cinatra#4852): a tree whose product code holds no step-screen
  // kind table would turn the rule off in silence, so it is refused.
  if (kindTables === 0) {
    throw new Error(
      "[core-extension-border] no step-screen kind table (`const <NAME>KIND_TABLE = { ... }`) in the product code — " +
        "the gate fails closed rather than passing the pack-step-kind-in-core rule unchecked",
    );
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

  findings.push(...unboundedPortMemberFindings({ repoRoot }));
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

// The writer may only SHRINK a pack-shaped module. A recorded file that grew
// keeps its recorded allowance (so the growth stays a violation the author
// must answer for), a file that shrank records the smaller count, a file that
// is gone leaves the ledger, and a NEW file is never written in — otherwise
// `--write-baseline` would launder exactly the growth this gate exists to
// refuse. An entry whose module is gone leaves the ledger whole.
export function shrinkPackShapedEntries(repoRoot, previousEntries) {
  const entries = [];
  const refused = [];
  for (const e of previousEntries) {
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
    if (Object.keys(current).length === 0) continue;
    entries.push({ ...e, files });
  }
  return { entries, refused };
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
  const { entries: domainEntries, refused } = shrinkPackShapedEntries(repoRoot, previous.entries);
  entries.push(...domainEntries);
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
  const defects = [...baselineDefects(doc), ...(doc.rules === undefined ? rulesListDefects(doc, { requireList: true }) : [])];
  if (unjustified.length || wildcards.length || defects.length) {
    console.error("[core-extension-border] FAIL — the baseline is not a named, justified ledger:");
    for (const k of unjustified) console.error(`  + no stated reason: ${k}`);
    for (const k of wildcards) console.error(`  + wildcard key: ${k}`);
    for (const d of defects) console.error(`  + ${d}`);
    process.exit(1);
  }

  // The ledger itself is shrink-only. It is compared with its copy on the base
  // branch: any key it GAINED — or any raised allowance — fails, so a crossing
  // cannot be admitted by writing itself in; a base that cannot be read fails
  // closed.
  if (!reportFloorGuard(checkFloorAgainstBase({ headFloor: doc }))) process.exit(1);

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

  const verdict = staleVerdict(stale);
  if (!verdict.ok) {
    for (const line of verdict.lines) console.error(line);
    process.exit(1);
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
