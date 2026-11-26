#!/usr/bin/env node
// Core test pack-pin gate (cinatra#4853, part of cinatra#3087: every extension
// draws its own work).
//
// THE RULE. A core test or fixture proves generic rules on synthetic input; it
// does not pin one pinned pack. A core test or fixture PINS a pack when
//   (read)  a core test file reads, imports or resolves a path inside the
//           materialized `extensions/` tree that names ONE pinned pack: the path reaches `extensions/<scope>/
//           <name>` with `<scope>/<name>` spelled in the file, or the file
//           imports `@<scope>/<name>` (or a subpath) — where `@<scope>/<name>`
//           is a package a committed extension lock pins;
//   (flow)  a core fixture file parses as an agent flow (it holds an object
//           with `component_type: "Flow"`) and carries a pinned-pack marker: a
//           package name a lock pins, or the first 7 or more hex digits of a
//           lock's `resolvedSha`.
// Everything is decided from structure: the path of a read, the import
// specifier, the shape of a fixture, and the two committed locks. The gate
// names no pack and no file in its logic.
//
// ITERATION OVER THE LOCK IS NOT A PIN. A fleet test that walks the lock or
// the extensions tree builds its paths from a variable (`join(EXT, row.name)`,
// `extensions/${name}`): the path stops at the tree or its scope with a hole
// where the name would be, so no pack is named and nothing is found. The rule
// fires only on a pack's name SPELLED in the path or the specifier.
//
// WHERE. Core test and fixture files only: under `src/`, `packages/` and
// `docker/`, a file whose path holds a test or fixture directory (`__tests__`,
// `__fixtures__`, `__mocks__`, `tests`, `test`, `fixtures`) or whose name marks
// it (`*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py`, `conftest.py`). The
// materialized `extensions/` tree, `node_modules/` and build output are never
// walked. Comments are not code: they are masked before any read.
//
// THE FLOOR (scripts/audit/core-test-pack-pin-gate.baseline.json) is
// SHRINK-ONLY. It holds the pins that stood on main when the gate landed, one
// entry per rule, file and pack; cinatra#4853 moves them to the packs' own CI.
//   - a pin outside the floor fails;
//   - an entry whose pin is gone is STALE and fails until --write-baseline
//     shrinks the floor;
//   - --write-baseline never writes a new entry;
//   - the floor is compared with its copy on the base branch through the
//     shared guard scripts/audit/lib/floor-base-guard.mjs: a new entry fails.
//     The base is CORE_TEST_PACK_PIN_BASE when set, else the pull request's
//     base branch (GITHUB_BASE_REF). A base that holds neither the floor nor
//     this gate is the introducing change and imposes nothing.
//
// CI: the test of record in scripts/audit/__tests__/core-test-pack-pin-gate.test.mjs
// runs this check in the root suite (`pnpm test:root`), which the job
// "Perpetual core invariants" runs on every pull request.
//
// Exit 0 clean, 1 findings / stale / grown floor, 2 scanner error.
//
// Usage:
//   node scripts/audit/core-test-pack-pin-gate.mjs                  # check
//   node scripts/audit/core-test-pack-pin-gate.mjs --report         # print every pin, floored ones included
//   node scripts/audit/core-test-pack-pin-gate.mjs --write-baseline # shrink the floor
//   CORE_TEST_PACK_PIN_BASE=<ref> node ...                          # also fail if the floor GREW vs <ref>

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import tsDefault from "typescript";
import { compareFloorWithBase, newKeys, readFileAtBase } from "./lib/floor-base-guard.mjs";

const ts = tsDefault;
const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..");
export const GATE_REL = "scripts/audit/core-test-pack-pin-gate.mjs";
export const BASELINE_REL = "scripts/audit/core-test-pack-pin-gate.baseline.json";
export const FLOOR_BASE_VAR = "CORE_TEST_PACK_PIN_BASE";
const TAG = "[core-test-pack-pin-gate]";

/** The committed locks whose rows are the pinned packs. */
export const LOCKS = ["cinatra-required-extensions.lock.json", "cinatra-dev-extensions.lock.json"];

/** The roots that hold core code. The materialized `extensions/` tree is absent. */
export const CORE_ROOTS = ["src", "packages", "docker"];

export const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".turbo", "dist", "build", "coverage", ".venv", "__pycache__"]);

export const TEST_DIRS = new Set(["__tests__", "__fixtures__", "__mocks__", "tests", "test", "fixtures"]);

export const RULES = Object.freeze(["read", "flow"]);

const JS_FILE = /\.(?:[cm]?[jt]sx?)$/;
const PY_FILE = /\.py$/;
const DATA_FILE = /\.json$/;

/** A minimum hex prefix of a lock's `resolvedSha` that counts as its marker. */
export const SHA_PREFIX_MIN = 7;

export class ScannerError extends Error {}

// ---------------------------------------------------------------------------
// The pinned packs, from the locks.
// ---------------------------------------------------------------------------

/**
 * The pinned packs: `{ names: Set<"@scope/name">, shas: string[] }`.
 * Fails closed on an absent lock or one without a named row.
 */
export function loadPinnedPacks(root = REPO_ROOT) {
  const names = new Set();
  const shas = [];
  for (const lock of LOCKS) {
    const p = join(root, lock);
    if (!existsSync(p)) throw new ScannerError(`${TAG} the lock ${lock} is missing; the gate fails closed`);
    let doc;
    try {
      doc = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      throw new ScannerError(`${TAG} the lock ${lock} does not parse (${e.message}); the gate fails closed`);
    }
    let named = 0;
    for (const row of doc.packages ?? []) {
      if (typeof row?.packageName !== "string" || !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(row.packageName)) continue;
      names.add(row.packageName);
      named += 1;
      if (typeof row.resolvedSha === "string" && /^[0-9a-f]{40}$/.test(row.resolvedSha)) shas.push(row.resolvedSha);
    }
    if (named === 0) throw new ScannerError(`${TAG} the lock ${lock} names no package; the gate fails closed`);
  }
  return { names, shas };
}

// ---------------------------------------------------------------------------
// Which files are core tests and fixtures.
// ---------------------------------------------------------------------------

/** True when the repo-relative path is a core test or fixture file. */
export function isCoreTestPath(rel) {
  const parts = rel.split("/");
  if (!CORE_ROOTS.includes(parts[0])) return false;
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  const base = parts[parts.length - 1];
  if (!(JS_FILE.test(base) || PY_FILE.test(base) || DATA_FILE.test(base))) return false;
  if (base.endsWith(".d.ts")) return false;
  if (parts.slice(0, -1).some((p) => TEST_DIRS.has(p))) return true;
  return /\.(?:test|spec)\.[^.]+$/.test(base) || /\.fixture\./.test(base) || /^test_.*\.py$/.test(base) || /_test\.py$/.test(base) || base === "conftest.py";
}

/** Every core test and fixture file under `root`, repo-relative, sorted. */
export function listCoreTestFiles(root = REPO_ROOT) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) {
        const rel = relative(root, abs).split(sep).join("/");
        if (isCoreTestPath(rel)) out.push(rel);
      }
    }
  };
  for (const r of CORE_ROOTS) walk(join(root, r));
  return out.sort();
}

// ---------------------------------------------------------------------------
// Paths a file builds: chains of literal text with HOLES where a value comes
// from a variable. A chain is the literal text between two holes.
// ---------------------------------------------------------------------------

export const HOLE = Symbol("hole");
/** A hole whose value is a temporary directory: a synthetic tree, not the repository's. */
export const TMP_HOLE = Symbol("tmp-hole");

/**
 * A Python name that is a temporary directory: the pytest fixtures `tmp_path`,
 * `tmp_path_factory` and `tmpdir`, exempt only while the file never rebinds them.
 */
export const PY_TMP_FIXTURES = new Set(["tmp_path", "tmp_path_factory", "tmpdir"]);

/** A call that makes or names a temporary directory (Node `mkdtemp`, `os.tmpdir`). */
export const TMP_CALLS = new Set(["mkdtemp", "mkdtempSync", "tmpdir"]);

/** The start of a new expression: the chain after it begins at no root. */
export const START = Symbol("start");

const PATH_JOINERS = new Set(["join", "resolve", "normalize", "posix", "relative"]);
/** A call whose value is its first argument's directory (`realpathSync(mkdtempSync(...))`). */
const SAME_DIR_CALLS = new Set([...PATH_JOINERS, "realpath", "realpathSync"]);

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

const DECLARING = (n) =>
  ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n) || ts.isImportClause(n) ||
  ts.isImportSpecifier(n) || ts.isNamespaceImport(n) || ts.isImportEqualsDeclaration(n) || ts.isEnumDeclaration(n) ||
  ts.isModuleDeclaration(n);

const isAssignmentOp = (k) => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;

/** Every identifier inside a node (a destructuring target, conservatively all of them). */
function identifiersIn(node, out = []) {
  if (ts.isIdentifier(node)) out.push(node);
  ts.forEachChild(node, (c) => identifiersIn(c, out));
  return out;
}

/**
 * The bindings of a file, for a SOUND temporary-root reading: every declaration
 * of each name (any scope, any kind) and every write to it (an assignment of
 * any operator, `++`/`--`, a destructuring or for-in/of target).
 */
function bindingsOf(sf) {
  const decls = new Map();
  const writes = new Map();
  const push = (m, name, v) => (m.has(name) ? m.get(name).push(v) : m.set(name, [v]));
  const walk = (n) => {
    if (DECLARING(n) && n.name && ts.isIdentifier(n.name)) push(decls, n.name.text, n);
    if (ts.isBinaryExpression(n) && isAssignmentOp(n.operatorToken.kind)) {
      const plain = n.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      if (ts.isIdentifier(n.left)) push(writes, n.left.text, { node: n, value: plain ? n.right : null });
      else for (const id of identifiersIn(n.left)) push(writes, id.text, { node: n, value: null });
    }
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
      for (const id of identifiersIn(n.operand)) push(writes, id.text, { node: n, value: null });
    }
    if ((ts.isForInStatement(n) || ts.isForOfStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) {
      for (const id of identifiersIn(n.initializer)) push(writes, id.text, { node: n, value: null });
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return { decls, writes };
}

const isScopeNode = (n, blockScoped) =>
  ts.isSourceFile(n) || ts.isFunctionLike(n) || ts.isClassStaticBlockDeclaration(n) ||
  (blockScoped && (ts.isBlock(n) || ts.isModuleBlock(n) || ts.isCaseBlock(n)));

/** The node a declaration binds its name in: block scope for let/const and the like, function scope for var. */
function scopeOfDeclaration(decl) {
  if (ts.isParameter(decl)) return decl.parent;
  if (ts.isBindingElement(decl)) {
    let root = decl.parent;
    while (root && !ts.isVariableDeclaration(root) && !ts.isParameter(root)) root = root.parent;
    return root ? scopeOfDeclaration(root) : null;
  }
  if (ts.isFunctionExpression(decl) || ts.isClassExpression(decl)) return decl;
  if (ts.isImportClause(decl) || ts.isImportSpecifier(decl) || ts.isNamespaceImport(decl)) return decl.getSourceFile();
  if (ts.isVariableDeclaration(decl)) {
    if (ts.isCatchClause(decl.parent)) return decl.parent;
    const list = decl.parent;
    const blockScoped = (list.flags & ts.NodeFlags.BlockScoped) !== 0;
    if (blockScoped && (ts.isForStatement(list.parent) || ts.isForInStatement(list.parent) || ts.isForOfStatement(list.parent))) return list.parent;
    for (let n = list.parent; n; n = n.parent) if (isScopeNode(n, blockScoped)) return n;
    return null;
  }
  for (let n = decl.parent; n; n = n.parent) if (isScopeNode(n, true)) return n;
  return null;
}

const within = (scope, node) => !!scope && scope.pos <= node.pos && node.end <= scope.end;

/**
 * The one value an identifier holds at its use, or null when the scanner cannot
 * prove it. Exactly one declaration of the name may enclose the use (a name
 * shadowed in an inner scope, or shadowing an outer one, is refused; a sibling
 * scope's declaration of the same name does not reach the use), and it must be
 * a plain variable (no parameter, destructured, imported or catch binding),
 * bound exactly once inside its scope: its initializer or one plain `=`
 * assignment. A name with a single binding can only ever hold that value (or
 * be unset, which a path join refuses), so the binding's place in the source
 * does not matter. Fails towards null.
 */
function soleValueAt(id, bindings) {
  const enclosing = (bindings.decls.get(id.text) ?? []).filter((d) => within(scopeOfDeclaration(d), id));
  if (enclosing.length !== 1) return null;
  const decl = enclosing[0];
  if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || ts.isCatchClause(decl.parent)) return null;
  const scope = scopeOfDeclaration(decl);
  const writes = (bindings.writes.get(id.text) ?? []).filter((w) => within(scope, w.node));
  const all = [...(decl.initializer ? [{ node: decl, value: decl.initializer }] : []), ...writes];
  if (all.length !== 1 || !all[0].value) return null;
  return all[0].value;
}

/**
 * True when an expression's value is a temporary directory: a call that makes
 * one (`mkdtempSync(...)`, `os.tmpdir()`), a path that starts at one, or a
 * variable whose sole sound binding is one (soleValueAt). A name alone is never
 * enough; anything the scanner cannot resolve is not temporary.
 */
function isTmpExpr(node, bindings, seen = new Set()) {
  if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return isTmpExpr(node.expression, bindings, seen);
  if (ts.isCallExpression(node)) {
    const name = calleeName(node.expression) ?? "";
    if (TMP_CALLS.has(name)) return true;
    return SAME_DIR_CALLS.has(name) && node.arguments.length > 0 && isTmpExpr(node.arguments[0], bindings, seen);
  }
  if (ts.isTemplateExpression(node)) return node.head.text === "" && isTmpExpr(node.templateSpans[0].expression, bindings, seen);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return isTmpExpr(node.left, bindings, seen);
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return false;
    const value = soleValueAt(node, bindings);
    return value !== null && isTmpExpr(value, bindings, new Set([...seen, node.text]));
  }
  return false;
}

/** The pieces (strings, HOLEs and TMP_HOLEs) an expression evaluates to, as far as literals tell. */
function piecesOf(node, bindings) {
  const hole = (n) => (isTmpExpr(n, bindings) ? TMP_HOLE : HOLE);
  if (ts.isParenthesizedExpression(node)) return piecesOf(node.expression, bindings);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    const out = [node.head.text];
    for (const span of node.templateSpans) out.push(hole(span.expression), span.literal.text);
    return out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...piecesOf(node.left, bindings), ...piecesOf(node.right, bindings)];
  }
  if (ts.isCallExpression(node) && PATH_JOINERS.has(calleeName(node.expression) ?? "")) {
    const out = [];
    node.arguments.forEach((a, i) => {
      if (i > 0) out.push("/");
      out.push(...piecesOf(a, bindings));
    });
    return out;
  }
  return [hole(node)];
}

/**
 * Split pieces into chains: `{ text, after }`, `after` the hole the chain
 * follows (`null` at the start, `HOLE` or `TMP_HOLE`).
 */
export function chainsOf(pieces) {
  const chains = [];
  let text = "";
  let after = null;
  for (const p of pieces) {
    if (p === HOLE || p === TMP_HOLE || p === START) {
      if (text !== "") chains.push({ text, after });
      text = "";
      after = p === START ? null : p;
    } else text += p;
  }
  if (text !== "") chains.push({ text, after });
  return chains;
}

/**
 * What one chain reaches in the materialized tree. A chain reaches the tree
 * when it holds the segment `extensions` and every segment before it is `.`
 * or `..` (relative to the working directory or the test's own directory), or
 * the chain follows a hole (a root held in a variable). Not the tree:
 * `src/components/extensions/...` (a core directory), an absolute literal
 * `/repo/extensions/...` (a stand-in path), and a chain after a temporary
 * directory (a synthetic tree a test builds). Returns `{ packs, reachesTree }`:
 * `packs` the pinned packs whose directory `extensions/<scope>/<name>` the
 * chain spells; `reachesTree` true when the chain stops at the tree or a scope
 * directory, the name left to a variable (the bare word `extensions` with no
 * root before it is not a path).
 */
export function packsInChain({ text, after = null }, pinned) {
  const packs = new Set();
  let reachesTree = false;
  if (after === TMP_HOLE) return { packs, reachesTree };
  const segs = text.replace(/\\/g, "/").replace(/\/{2,}/g, "/").split("/");
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] !== "extensions") continue;
    const before = segs.slice(0, i);
    if (after === null && before[0] === "") continue; // an absolute literal path
    if (!before.every((s) => s === "" || s === "." || s === "..")) continue;
    const scope = (segs[i + 1] ?? "").replace(/^@/, "");
    const name = segs[i + 2] ?? "";
    if (!scope || !name) {
      // The bare word `extensions` with no root before it is a word (a route
      // segment, a key), not a path; after a root, a `..` or with its scope
      // it is the tree.
      if (after === HOLE || before.some((s) => s === "." || s === "..") || scope) reachesTree = true;
      continue;
    }
    if (pinned.names.has(`@${scope}/${name}`)) packs.add(`@${scope}/${name}`);
  }
  return { packs, reachesTree };
}

/**
 * The pinned pack a whole string literal names: `@scope/name`, `scope/name`
 * or the directory name `name` alone. Only consulted in a file whose paths
 * reach the tree with the name left to a variable.
 */
export function packNamedByLiteral(value, pinned) {
  if (pinned.names.has(value)) return value;
  if (pinned.names.has(`@${value}`)) return `@${value}`;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) return null;
  for (const n of pinned.names) if (n.endsWith(`/${value}`)) return n;
  return null;
}

/**
 * The verdict over one file's chains and whole literals: every pack its paths
 * spell, and, when a path reaches the tree with the name in a variable, every
 * pack a whole literal of the file names (the name the variable takes).
 */
export function packsOfFile(chains, literals, pinned) {
  const found = new Set();
  let reachesTree = false;
  for (const c of chains) {
    const r = packsInChain(c, pinned);
    for (const p of r.packs) found.add(p);
    reachesTree ||= r.reachesTree;
  }
  if (reachesTree) {
    for (const v of literals) {
      const p = packNamedByLiteral(v, pinned);
      if (p) found.add(p);
    }
  }
  return found;
}

/** The package `@scope/name` of an import specifier, or null. */
export function packageOfSpecifier(spec) {
  const m = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)(?:\/.*)?$/.exec(spec);
  return m ? m[1] : null;
}

/**
 * True when the node is a piece of a larger path expression (an argument of a
 * path join, an operand of `+`, a parenthesized part): the larger expression
 * is read whole, so a literal is never read apart from the root before it.
 */
function isPartOfLargerPath(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isParenthesizedExpression(parent)) return true;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) return true;
  if (ts.isCallExpression(parent) && parent.arguments.includes(node) && PATH_JOINERS.has(calleeName(parent.expression) ?? "")) return true;
  return false;
}

/**
 * True when an import or export-from loads no value: `import type ...`,
 * `export type ... from`, or every named specifier carries `type` with no
 * default or namespace binding (`import { type X, type Y } from`). A mixed
 * list, a bare `import "x"`, an empty `{}`, `export *` and `export * as ns`
 * load the module at run time.
 */
export function isTypeOnlyImportOrExport(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    const named = clause.namedBindings;
    return !clause.name && !!named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
  }
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return !!clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
}

/** Every pinned pack a JS/TS test file reads, imports or resolves. */
export function scanScriptText(rel, text, pinned) {
  const kind = /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : /\.jsx$/.test(rel) ? ts.ScriptKind.JSX : /\.[cm]?ts$/.test(rel) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const found = new Set();
  const chains = [];
  const literals = [];
  const bindings = bindingsOf(sf);
  const visit = (node) => {
    // An import, export-from, dynamic import, require, require.resolve or
    // vi.importActual whose specifier is a pinned package.
    let spec = null;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!isTypeOnlyImportOrExport(node)) spec = node.moduleSpecifier.text;
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      if (!node.isTypeOnly) spec = node.moduleReference.expression.text;
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const name = calleeName(node.expression);
      const isResolve = name === "resolve" && ts.isPropertyAccessExpression(node.expression) && /^(require|import\.meta)$/.test(node.expression.expression.getText(sf));
      if (isDynamicImport || name === "require" || name === "importActual" || name === "requireActual" || isResolve) spec = node.arguments[0].text;
    }
    if (spec !== null) {
      const pkg = packageOfSpecifier(spec);
      if (pkg && pinned.names.has(pkg)) found.add(pkg);
    }
    if (
      !isPartOfLargerPath(node) &&
      (ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node) ||
      ts.isBinaryExpression(node) ||
      (ts.isCallExpression(node) && PATH_JOINERS.has(calleeName(node.expression) ?? "")))
    ) {
      chains.push(...chainsOf(piecesOf(node, bindings)));
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const p of packsOfFile(chains, literals, pinned)) found.add(p);
  return found;
}

/**
 * The string literals of a Python file as pieces in order: comments and
 * triple-quoted strings (docstrings) are masked; an f-string's `{...}` is a
 * hole; literals joined by `/`, `,` or `+` (Path `/`, os.path.join) continue a
 * chain, anything else is a hole.
 */
export function pythonPieces(text) {
  const pieces = [];
  let i = 0;
  const n = text.length;
  let lastEnd = -1;
  // A pytest temporary fixture the file rebinds (`tmp_path = ...`, `for tmp_path in`,
  // `as tmp_path`, `tmp_path := ...`) is not a temporary root any more.
  const rebound = new Set(
    [...PY_TMP_FIXTURES].filter((w) =>
      new RegExp(`(?:^|[^\\w.])${w}\\s*(?:[-+*/%&|^@:]|//|\\*\\*|<<|>>)?=(?!=)|\\b(?:for|as)\\s+${w}\\b`, "m").test(text),
    ),
  );
  const gapJoins = (from, to) => /^[\s/,+\\]*$/.test(text.slice(from, to)) && !/\n\s*\n/.test(text.slice(from, to));
  while (i < n) {
    const c = text[i];
    if (c === "#") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    const m = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(text.slice(i, i + 5));
    if (m && (m[1] === "" || !/[A-Za-z0-9_]/.test(text[i - 1] ?? ""))) {
      const prefix = m[1].toLowerCase();
      const q = m[2];
      const start = i;
      i += m[0].length;
      let body = "";
      while (i < n && text.slice(i, i + q.length) !== q) {
        if (text[i] === "\\" && !prefix.includes("r")) {
          // The decoded value: `\x2d`, `\u002d`, `\U0000002d` and octal `\055`
          // all spell `-`; a line continuation spells nothing; an unknown escape
          // keeps its backslash, as Python does.
          const esc = /^\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([0-7]{1,3})|(\r?\n)|(.))/s.exec(text.slice(i, i + 10));
          if (!esc) {
            i += 1;
            continue;
          }
          const hex = esc[1] ?? esc[2] ?? esc[3];
          if (hex) body += String.fromCodePoint(parseInt(hex, 16));
          else if (esc[4]) body += String.fromCodePoint(parseInt(esc[4], 8));
          else if (esc[6]) body += { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' }[esc[6]] ?? `\\${esc[6]}`;
          i += esc[0].length;
          continue;
        }
        if (q.length === 1 && text[i] === "\n") break;
        body += text[i];
        i++;
      }
      i += q.length;
      if (q.length === 3) {
        lastEnd = -1;
        pieces.push(START);
        continue;
      }
      const joined = lastEnd >= 0 && gapJoins(lastEnd, start);
      if (!joined) {
        // A literal after `name /` or `name,` continues a path rooted in that
        // variable (Path `/`, os.path.join); any other literal starts afresh.
        const lead = /([A-Za-z_][A-Za-z0-9_.]*(?:\(\))?)\s*[/,]\s*$/.exec(text.slice(text.lastIndexOf("\n", start - 1) + 1, start));
        if (!lead) pieces.push(START);
        else pieces.push(PY_TMP_FIXTURES.has(lead[1].split(".")[0]) && !rebound.has(lead[1].split(".")[0]) ? TMP_HOLE : HOLE);
      }
      else if (/[/,]/.test(text.slice(lastEnd, start))) pieces.push("/");
      if (prefix.includes("f")) {
        const parts = body.split(/\{[^{}]*\}/);
        parts.forEach((p, k) => {
          if (k > 0) pieces.push(HOLE);
          pieces.push(p);
        });
      } else pieces.push(body);
      lastEnd = i;
      continue;
    }
    i++;
  }
  return pieces;
}

/** Every pinned pack a Python test file reads by path. */
export function scanPythonText(text, pinned) {
  const pieces = pythonPieces(text);
  return packsOfFile(chainsOf(pieces), pieces.filter((p) => typeof p === "string"), pinned);
}

// ---------------------------------------------------------------------------
// Flow-shaped fixtures.
// ---------------------------------------------------------------------------

/** True when the value holds an agent flow: an object with `component_type: "Flow"`. */
export function holdsFlow(value) {
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === "object") {
      if (v.component_type === "Flow") return true;
      stack.push(...Object.values(v));
    }
  }
  return false;
}

/** The pinned-pack markers one piece of text carries: a package name or a sha prefix. */
function markersInText(text, pinned, found) {
  for (const name of pinned.names) {
    const re = new RegExp(`(^|[^A-Za-z0-9._/@-])${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![A-Za-z0-9._-])`);
    if (re.test(text)) found.add(name);
  }
  for (const m of text.matchAll(/(?<![0-9a-fA-F])[0-9a-f]{7,40}(?![0-9a-fA-F])/g)) {
    if (m[0].length < SHA_PREFIX_MIN) continue;
    for (const sha of pinned.shas) if (sha.startsWith(m[0])) found.add(`sha:${m[0]}`);
  }
}

/**
 * The pinned-pack markers a flow-shaped fixture carries, read from its PARSED
 * value: every string and every key, so an escape (`\/`, `\uNNNN`) spells the
 * name it decodes to. The raw text is read as well, and can only add a marker
 * (a sha prefix written as a bare number, say). A name split across two JSON
 * strings that a loader concatenates is out of reach.
 */
export function flowMarkers(text, pinned, value = JSON.parse(text)) {
  const found = new Set();
  const stack = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") markersInText(v, pinned, found);
    else if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        markersInText(k, pinned, found);
        stack.push(x);
      }
    }
  }
  markersInText(text, pinned, found);
  return found;
}

/** The finding's pack for a flow-shaped fixture that does not parse as JSON. */
export const UNPARSED_FLOW = "(unparsed flow fixture)";

/**
 * A cheap flow signal on text that does not parse: `component_type` and `Flow`
 * once the JSON escapes are decoded.
 */
export function looksLikeFlow(text) {
  const decoded = text.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, "/");
  return /component_type/.test(decoded) && /\bFlow\b/.test(decoded);
}

// ---------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------

/** One finding's floor key. */
export function keyOf(f) {
  return `${f.rule} :: ${f.file} :: ${f.pack}`;
}

/** Every pin in the tree, sorted by key. */
export function scanCorePins(root = REPO_ROOT, { pinned = loadPinnedPacks(root), files = listCoreTestFiles(root) } = {}) {
  const findings = [];
  for (const rel of files) {
    const text = readFileSync(join(root, rel), "utf8");
    if (DATA_FILE.test(rel)) {
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        // Not JSON: a fixture with a flow's signal is reported (its markers
        // cannot be read); anything else is not a flow and is skipped.
        if (looksLikeFlow(text)) findings.push({ rule: "flow", file: rel, pack: UNPARSED_FLOW });
        continue;
      }
      if (!holdsFlow(value)) continue;
      for (const pack of flowMarkers(text, pinned, value)) findings.push({ rule: "flow", file: rel, pack });
      continue;
    }
    const packs = PY_FILE.test(rel) ? scanPythonText(text, pinned) : scanScriptText(rel, text, pinned);
    for (const pack of packs) findings.push({ rule: "read", file: rel, pack });
  }
  return findings.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

// ---------------------------------------------------------------------------
// The floor.
// ---------------------------------------------------------------------------

/** The floor's keys; throws on a floor that is not one. */
export function parseFloor(text) {
  const doc = JSON.parse(text);
  if (!Array.isArray(doc?.entries)) throw new Error("the floor has no `entries` array");
  const keys = [];
  for (const e of doc.entries) {
    if (!RULES.includes(e?.rule) || typeof e?.file !== "string" || typeof e?.pack !== "string") {
      throw new Error(`a floor entry is not { rule, file, pack }: ${JSON.stringify(e)}`);
    }
    keys.push(keyOf(e));
  }
  if (new Set(keys).size !== keys.length) throw new Error("the floor holds a duplicate entry");
  return keys;
}

/** The pins outside the floor, and the floor entries whose pin is gone. */
export function checkFloor(floorKeys, findings) {
  const live = findings.map(keyOf);
  const floor = new Set(floorKeys);
  const liveSet = new Set(live);
  return {
    added: [...new Set(live)].filter((k) => !floor.has(k)).sort(),
    stale: floorKeys.filter((k) => !liveSet.has(k)).sort(),
  };
}

/**
 * The floor compared with its copy on the base. A base that holds neither the
 * floor nor this gate is the introducing change: nothing to compare.
 */
export function checkBaseGuard({ root = REPO_ROOT, env = process.env, headKeys }) {
  const result = compareFloorWithBase({
    gate: "core-test-pack-pin-gate",
    envVar: FLOOR_BASE_VAR,
    floorPath: BASELINE_REL,
    headFloor: headKeys,
    parse: parseFloor,
    grown: (base, head) => newKeys(base, head).map((k) => `new entry: ${k}`),
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
        lines: [`${TAG} floor base guard: the base "${result.ref}" holds neither ${BASELINE_REL} nor the gate — the introducing change; nothing to compare.`],
      };
    }
  }
  return result;
}

/** The whole check: `{ ok, lines, findings }`. */
export function runGate({ root = REPO_ROOT, env = process.env } = {}) {
  const lines = [];
  const floorPath = join(root, BASELINE_REL);
  if (!existsSync(floorPath)) {
    return { ok: false, lines: [`${TAG} FAIL — the floor ${BASELINE_REL} is missing; an absent floor is not an empty one.`], findings: [] };
  }
  let floorKeys;
  try {
    floorKeys = parseFloor(readFileSync(floorPath, "utf8"));
  } catch (e) {
    return { ok: false, lines: [`${TAG} FAIL — the floor ${BASELINE_REL} is not readable: ${e.message}`], findings: [] };
  }
  const guard = checkBaseGuard({ root, env, headKeys: floorKeys });
  lines.push(...guard.lines);
  const findings = scanCorePins(root);
  const { added, stale } = checkFloor(floorKeys, findings);
  if (added.length) {
    lines.push(
      `${TAG} FAIL — ${added.length} core test or fixture pin(s) of one pinned pack outside the shrink-only floor. ` +
        "Prove a generic rule on a synthetic flow; a proof of one pack belongs in that pack's own CI (scripts/audit/extension-coupling-gates.md):",
      ...added.map((k) => `  + ${k}`),
    );
  }
  if (stale.length) {
    lines.push(`${TAG} FAIL — ${stale.length} floor entr${stale.length === 1 ? "y is" : "ies are"} gone; run --write-baseline to shrink the floor:`, ...stale.map((k) => `  - ${k}`));
  }
  const ok = guard.ok && added.length === 0 && stale.length === 0;
  if (ok) lines.push(`${TAG} OK — ${findings.length} pin(s), all inside the shrink-only floor.`);
  return { ok, lines, findings, added, stale };
}

function writeBaseline(root) {
  const floorPath = join(root, BASELINE_REL);
  const previous = existsSync(floorPath) ? JSON.parse(readFileSync(floorPath, "utf8")) : null;
  const findings = scanCorePins(root);
  const prevKeys = previous ? new Set(parseFloor(JSON.stringify(previous))) : null;
  const keep = prevKeys ? findings.filter((f) => prevKeys.has(keyOf(f))) : findings;
  const refused = prevKeys ? findings.filter((f) => !prevKeys.has(keyOf(f))) : [];
  const doc = {
    note:
      "Shrink-only floor of core tests and fixtures that pin one pinned pack (cinatra#4853). " +
      "Each entry moves to the pack's own CI or becomes a synthetic proof; none is ever added. " +
      "Regenerate (shrink only) with `node scripts/audit/core-test-pack-pin-gate.mjs --write-baseline`.",
    entries: keep.map(({ rule, file, pack }) => ({ rule, file, pack })),
  };
  writeFileSync(floorPath, JSON.stringify(doc, null, 2) + "\n");
  console.log(`${TAG} floor written (${doc.entries.length} entries).`);
  if (refused.length) {
    console.log(`${TAG} ${refused.length} new pin(s) NOT written — the floor only shrinks:`);
    for (const f of refused) console.log(`  ! ${keyOf(f)}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--write-baseline")) return writeBaseline(REPO_ROOT);
  const result = runGate();
  if (args.includes("--report")) {
    console.log(`${TAG} ${result.findings.length} pin(s) in the tree:`);
    for (const f of result.findings) console.log(`  ${keyOf(f)}`);
  }
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
