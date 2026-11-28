#!/usr/bin/env node
/**
 * Authz inventory builder.
 *
 * Statically scans every road by which a tool is registered across
 * `packages/`, `extensions/`, and `src/` and emits a machine-readable JSON
 * matrix consumed by the authz inventory guard test at:
 *   src/lib/authz/__tests__/drift-gate.test.ts
 *
 * Each row records its road (cinatra#4895):
 *   - "mcp": a tool on the MCP server — a literal `server.registerTool(name`
 *     or a `*TOOL_META*` block key.
 *   - "passthrough": a name the deterministic passthrough route's allow list
 *     holds. The list is found by its declaration: the one binding named
 *     ALLOWED_TOOLS in src/app/api/agents/passthrough/route.ts, a module-level
 *     `const` initialized with `new Set([...])` or a named import of one. This
 *     name is a convention between the route and this builder: a renamed or
 *     duplicated list FAILS the builder loudly, which is the wanted behaviour.
 *     The list is read with the TypeScript parser: string literals in any
 *     quote form, templates without substitution, module-level consts with a
 *     literal value, and spread sets followed to their module-level
 *     declaration in the same file or an imported module. An entry the parser
 *     cannot resolve to a literal FAILS the builder, and so does any use of
 *     the list or its spread sets that could change them. A name the list
 *     holds that is also an MCP tool has a row on each road.
 *     The inventory records which tool names the allow list holds. That the
 *     route refuses every other name is the subject of the route's own tests
 *     (src/__tests__/passthrough-dashboards-create-3092.test.ts, "keeps %s off
 *     the allowlist").
 * Not covered yet (cinatra#4895): a tool a pack registers only in its
 * `register(ctx)` through `ctx.mcp.registerTool` has no row unless the pack's
 * metadata block lists it.
 * Stated limit: indirection deeper than MAX_SET_DEPTH hops (re-export chains,
 * sets built by code) is refused, not followed; a mutation of an exported set
 * from a module the builder does not read is not followed.
 * A row's `file` is its owner: a path under `extensions/<scope>/<pack>/` is
 * that pack, any other path is core.
 *
 * Hand-augmentation of classification per primitive lives in:
 *   src/lib/authz/inventory-augment.ts
 *
 * The classification is split between this generated JSON and the hand-authored TS augmentation.
 *
 * Usage:
 *   pnpm authz:inventory          (rebuild)
 *   pnpm authz:inventory --check  (fail if file is stale)
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const args = process.argv.slice(2);
const check = args.includes("--check");
// `--root <dir>` runs the builder on another tree (a test fixture).
const rootArg = args.indexOf("--root");
const ROOT =
  rootArg === -1 ? resolve(fileURLToPath(import.meta.url), "../..") : resolve(args[rootArg + 1] ?? "");
const ROOTS = ["packages", "extensions", "src"];
const OUT = join(ROOT, "src/lib/authz/__generated__/inventory.json");

const REGISTER_RE = /server\s*\.\s*registerTool\s*\(\s*["'`]([a-zA-Z0-9_]+)["'`]/g;
// Every package registry collects its tool table in a `TOOL_META` (or
// `*_TOOL_META`) `Record<string, { description, inputSchema }>` and then
// iterates it through a single `server.registerTool(name, …)` call. The
// literal primitive names live as object keys inside that block — they
// never appear in a registerTool string arg. Scan for those too.
const TOOL_META_BLOCK_RE = /(?:[A-Z_]*TOOL_META[A-Z_]*)\s*:\s*Record<[^>]+>\s*=\s*\{([\s\S]*?)\n\}\s*;/g;
const TOOL_META_KEY_RE = /^\s{2,}(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))\s*:\s*\{/gm;
// The passthrough road: the route's allow list and the sets it spreads in.
const PASSTHROUGH_ROUTE = "src/app/api/agents/passthrough/route.ts";
const MAX_SET_DEPTH = 5;

/** @param {string} dir */
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "dist" || entry === "__generated__") continue;
    // Test files register fixture tools; they are not registration roads.
    if (entry === "__tests__" || /\.test\.tsx?$/.test(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) yield* walk(full);
    else if (s.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) yield full;
  }
}

/** @returns {Array<{primitiveName:string,file:string,line:number}>} */
function scan() {
  const records = [];
  for (const root of ROOTS) {
    const abs = join(ROOT, root);
    let exists = true;
    try {
      statSync(abs);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    for (const file of walk(abs)) {
      let body;
      try {
        body = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      REGISTER_RE.lastIndex = 0;
      let m;
      while ((m = REGISTER_RE.exec(body)) !== null) {
        const upto = body.slice(0, m.index);
        const line = upto.split("\n").length;
        records.push({
          primitiveName: m[1],
          file: relative(ROOT, file),
          line,
        });
      }
      // Also collect TOOL_META block keys — these are the canonical primitive
      // names every registry exposes through the per-handler iterator.
      TOOL_META_BLOCK_RE.lastIndex = 0;
      let block;
      while ((block = TOOL_META_BLOCK_RE.exec(body)) !== null) {
        const blockStart = block.index;
        const lineOfBlock = body.slice(0, blockStart).split("\n").length;
        const blockBody = block[1];
        TOOL_META_KEY_RE.lastIndex = 0;
        let kMatch;
        while ((kMatch = TOOL_META_KEY_RE.exec(blockBody)) !== null) {
          const name = kMatch[1] ?? kMatch[2];
          if (!name) continue;
          // Skip pseudo-identifiers used inside zod schemas / handler maps.
          if (name === "description" || name === "inputSchema" || name === "title") continue;
          const innerOffset = blockStart + (block[0].indexOf(blockBody) ?? 0) + kMatch.index;
          const lineNum = body.slice(0, innerOffset).split("\n").length;
          records.push({
            primitiveName: name,
            file: relative(ROOT, file),
            line: lineNum,
          });
        }
      }
    }
  }
  // De-duplicate by (primitiveName, file): a primitive can appear both as a
  // TOOL_META key AND inside a single inline `server.registerTool(name, …)`
  // line — only keep the smallest line number per pair.
  const dedupe = new Map();
  for (const r of records) {
    const key = `${r.primitiveName}::${r.file}`;
    const prev = dedupe.get(key);
    if (!prev || prev.line > r.line) dedupe.set(key, r);
  }
  for (const r of dedupe.values()) r.road = "mcp";
  // A name admitted on both roads has a row on each: the passthrough row is
  // keyed by its road, so an mcp row never hides it.
  for (const r of scanPassthrough()) {
    const key = `${r.primitiveName}::passthrough`;
    if (!dedupe.has(key)) dedupe.set(key, { ...r, road: "passthrough" });
  }
  const deduped = [...dedupe.values()].map(({ primitiveName, file, line, road }) => ({ primitiveName, file, road, line }));
  deduped.sort(
    (a, b) =>
      a.primitiveName.localeCompare(b.primitiveName) || a.file.localeCompare(b.file) || a.road.localeCompare(b.road),
  );
  return deduped;
}

/** @param {string} rel */
function readRel(rel) {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return null;
  }
}

/** @param {string} message */
function fail(message) {
  throw new Error(`authz inventory: ${message}`);
}

/** @param {string} rel */
function parseRel(rel) {
  const body = readRel(rel);
  if (body === null) fail(`cannot read ${rel}`);
  const kind = /\.tsx$/.test(rel)
    ? ts.ScriptKind.TSX
    : /\.[mc]?js$/.test(rel)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  return ts.createSourceFile(rel, body, ts.ScriptTarget.Latest, true, kind);
}

/** @param {ts.SourceFile} sf @param {ts.Node} node */
function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** @param {ts.Expression} e */
function unwrap(e) {
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** The route's allow list: the one binding of this name in the route module. */
const ALLOW_LIST_NAME = "ALLOWED_TOOLS";

/**
 * Finds the allow list by its declaration: exactly one binding named
 * ALLOWED_TOOLS in the route, a module-level `const` or a named import of one.
 * No such binding, or more than one in any scope, FAILS the builder.
 * @param {ts.SourceFile} sf
 */
function assertOneAllowListBinding(sf) {
  const found = [];
  const visit = (n) => {
    if (
      (ts.isVariableDeclaration(n) || ts.isImportSpecifier(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n)) &&
      n.name &&
      ts.isIdentifier(n.name) &&
      n.name.text === ALLOW_LIST_NAME
    ) {
      found.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (found.length !== 1) {
    fail(`${sf.fileName}: expected exactly one declaration or import of ${ALLOW_LIST_NAME}, found ${found.length}`);
  }
  const n = found[0];
  const moduleLevel =
    ts.isImportSpecifier(n) ||
    (ts.isVariableDeclaration(n) && ts.isVariableStatement(n.parent.parent) && n.parent.parent.parent === sf);
  if (!moduleLevel) fail(`${sf.fileName}:${lineOf(sf, n)}: ${ALLOW_LIST_NAME} must be declared at module level`);
}

/**
 * Every reference to a set binding of the allow list must leave the set as it
 * was declared: its declaration, an import or export of it, a spread, a
 * `for…of`, `Array.from(X)`, `X.size`, or a call of `.has`, `.forEach`,
 * `.values`, `.keys`, `.entries`. Any other use (`.add`, `.delete`, `.clear`,
 * passing the set to a function, assigning it to another name) FAILS the
 * builder.
 * @param {Map<string, Set<string>>} tracked module -> local names of the list's sets
 */
function assertSetsConstant(tracked) {
  const READS = new Set(["has", "forEach", "values", "keys", "entries"]);
  for (const [rel, names] of tracked) {
    const sf = parseRel(rel);
    const visit = (n) => {
      if (ts.isIdentifier(n) && names.has(n.text)) {
        const p = n.parent;
        const ok =
          (ts.isVariableDeclaration(p) && p.name === n) ||
          ts.isImportSpecifier(p) ||
          ts.isExportSpecifier(p) ||
          ts.isTypeQueryNode(p) ||
          (ts.isPropertyAccessExpression(p) && p.name === n) ||
          ts.isSpreadElement(p) ||
          (ts.isForOfStatement(p) && p.expression === n) ||
          (ts.isPropertyAccessExpression(p) &&
            p.expression === n &&
            ((p.name.text === "size" && !(ts.isBinaryExpression(p.parent) && p.parent.left === p)) ||
              (READS.has(p.name.text) && ts.isCallExpression(p.parent) && p.parent.expression === p))) ||
          (ts.isCallExpression(p) && p.getChildAt(0).getText(sf) === "Array.from" && p.arguments[0] === n);
        if (!ok) {
          const shown = ts.isPropertyAccessExpression(p) && ts.isCallExpression(p.parent) ? p.parent : p;
          fail(`${rel}:${lineOf(sf, n)}: the allow-list set ${n.text} is not used as a constant (\`${shown.getText(sf).slice(0, 80)}\`)`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}

/** @param {string} fromRel @param {string} spec */
function resolveModule(fromRel, spec) {
  let base;
  if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith(".")) base = posix.join(posix.dirname(fromRel), spec);
  else return null;
  const exts = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
  const candidates = [base, ...exts.map((e) => `${base}${e}`), ...exts.map((e) => `${base}/index${e}`)];
  // A TypeScript ESM specifier names the emitted file (`./x.js` for `./x.ts`).
  const emitted = /\.([mc]?)js$/.exec(base);
  if (emitted) candidates.push(base.replace(/\.[mc]?js$/, `.${emitted[1]}ts`), base.replace(/\.[mc]?js$/, ".tsx"));
  for (const c of candidates) {
    try {
      if (statSync(join(ROOT, c)).isFile()) return c;
    } catch {
      // try the next form
    }
  }
  return null;
}

/**
 * The module-level `const` declaration of `name` in `rel`, followed through a
 * named import to the module it comes from. Module level is exact here: the
 * allow list is a module-level set, and an initializer at module level can
 * only name module-level bindings or imports. A list declared inside a
 * function is not found and FAILS the builder.
 * @param {string} rel @param {string} name @param {number} depth
 * @param {Map<string, Set<string>>} [track] when given, records each module and local name passed
 * @returns {{ rel: string, sf: ts.SourceFile, decl: ts.VariableDeclaration }}
 */
function resolveConst(rel, name, depth, track) {
  if (track) (track.get(rel) ?? track.set(rel, new Set()).get(rel)).add(name);
  if (depth > MAX_SET_DEPTH) fail(`${rel}: ${name} is more than ${MAX_SET_DEPTH} hops from the allow list`);
  const sf = parseRel(rel);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== name) continue;
      if (!(st.declarationList.flags & ts.NodeFlags.Const)) fail(`${rel}: ${name} is not declared with const`);
      return { rel, sf, decl: d };
    }
  }
  for (const st of sf.statements) {
    const bindings = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if (el.name.text !== name) continue;
      const target = resolveModule(rel, /** @type {ts.StringLiteral} */ (st.moduleSpecifier).text);
      if (!target) fail(`${rel}: cannot resolve the import of ${name}`);
      return resolveConst(target, (el.propertyName ?? el.name).text, depth + 1, track);
    }
  }
  return fail(`${rel}: no module-level const declaration or import of ${name}`);
}

/**
 * The names in a `new Set([...])` declaration: literals in any quote form,
 * constants with a literal value, spread sets read the same way.
 * @param {string} rel @param {string} name @param {number} depth
 * @param {Map<string, Set<string>>} track records every module and local name of the sets read
 * @returns {Array<{primitiveName:string,file:string,line:number}>}
 */
function namesOfSet(rel, name, depth, track) {
  const { rel: at, sf, decl } = resolveConst(rel, name, depth, track);
  const init = decl.initializer ? unwrap(decl.initializer) : undefined;
  const list = init && ts.isNewExpression(init) && init.arguments?.length === 1 ? unwrap(init.arguments[0]) : undefined;
  if (!list || !ts.isArrayLiteralExpression(list)) fail(`${at}: ${name} is not a \`new Set([...])\` of literals`);
  const out = [];
  for (const el of list.elements) {
    if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) {
      out.push({ primitiveName: el.text, file: at, line: lineOf(sf, el) });
    } else if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) {
      out.push(...namesOfSet(at, el.expression.text, depth + 1, track));
    } else if (ts.isIdentifier(el)) {
      const c = resolveConst(at, el.text, depth + 1);
      const v = c.decl.initializer ? unwrap(c.decl.initializer) : undefined;
      if (!v || !(ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v))) {
        fail(`${c.rel}: allow-list entry ${el.text} is not a const with a string literal value`);
      }
      out.push({ primitiveName: v.text, file: c.rel, line: lineOf(c.sf, c.decl) });
    } else {
      fail(`${at}: allow-list entry \`${el.getText(sf)}\` in ${name} is not a literal, a literal const or a spread set`);
    }
  }
  return out;
}

function scanPassthrough() {
  const track = new Map();
  assertOneAllowListBinding(parseRel(PASSTHROUGH_ROUTE));
  const names = namesOfSet(PASSTHROUGH_ROUTE, ALLOW_LIST_NAME, 0, track);
  assertSetsConstant(track);
  return names;
}

function emit() {
  const records = scan();
  const out = {
    // NO generatedAt / timestamp here: this file is byte-compared by `--check`,
    // so any volatile field makes the gate fail the day after it was committed
    // (a recurring RBAC CI red — fixed for good by removing the date, not by
    // re-regenerating). Keep the emitted JSON deterministic.
    generatedBy: "scripts/build-authz-inventory.mjs",
    note: "DO NOT EDIT BY HAND. Re-run `pnpm authz:inventory`. Classification lives in src/lib/authz/inventory-augment.ts.",
    primitives: records,
  };
  return JSON.stringify(out, null, 2) + "\n";
}

let next;
try {
  next = emit();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
if (check) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    current = "";
  }
  if (current !== next) {
    console.error("authz inventory drift: " + OUT + " is stale. Run `pnpm authz:inventory` to refresh.");
    process.exit(1);
  }
  console.log("authz inventory check: ok (" + JSON.parse(next).primitives.length + " primitives)");
} else {
  writeFileSync(OUT, next);
  console.log("authz inventory: wrote " + OUT + " (" + JSON.parse(next).primitives.length + " primitives)");
}
