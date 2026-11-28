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
 *   - "passthrough": a name the deterministic passthrough route admits that no
 *     MCP road registers. The route's allow list is the set the route checks as
 *     `if (!LIST.has(tool))` (or `LIST.has(tool) === false`) as a statement
 *     directly in the body of the route's one exported request handler (or of
 *     the same-file function it returns the result of), where `tool` is the
 *     const read there from the request's `tool` field, the guarded block ends
 *     with `return` of the 403 answer, and `tool` is only tested before it. No
 *     such guard, two, a guard that does not return, or an earlier use of the
 *     tool name FAILS the builder. Every reference to the list's sets in the
 *     modules read must leave them constant, or the builder FAILS. The list is
 *     read with the TypeScript parser: string literals in any quote form,
 *     templates without substitution, module-level consts with a literal value,
 *     and spread sets followed to their module-level declaration in the same
 *     file or an imported module. An entry the parser cannot resolve to a
 *     literal FAILS the builder. A name the route admits that is also an MCP
 *     tool has a row on each road: the route dispatches it on its own path.
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

/** @param {ts.Node} node @param {(n: ts.Node) => boolean} test */
function contains(node, test) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (test(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * The call a guard negates: `!X`, `!(X)`, `X === false`, `X == false`,
 * `false === X`; null for any other condition.
 * @param {ts.Expression} c
 */
function negatedCall(c) {
  if (ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken) return unwrap(c.operand);
  if (
    ts.isBinaryExpression(c) &&
    (c.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      c.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
  ) {
    if (c.right.kind === ts.SyntaxKind.FalseKeyword) return unwrap(c.left);
    if (c.left.kind === ts.SyntaxKind.FalseKeyword) return unwrap(c.right);
  }
  return null;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** @param {ts.Node} n */
function isExported(n) {
  return !!ts.getModifiers?.(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** @param {ts.SourceFile} sf @param {string} name */
function functionNamed(sf, name) {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name && st.body) return st;
  }
  return null;
}

/**
 * The function whose body holds the route's admission: the one exported HTTP
 * method handler, or the same-file function it delegates to by
 * `return [await] F(...)`, directly or as the only statement of a `try` that
 * has no `catch`.
 * @param {ts.SourceFile} sf
 */
function requestHandler(sf) {
  const exported = sf.statements.filter(
    (st) => ts.isFunctionDeclaration(st) && st.name && HTTP_METHODS.has(st.name.text) && isExported(st),
  );
  const exportedConsts = sf.statements.filter(
    (st) =>
      ts.isVariableStatement(st) &&
      isExported(st) &&
      st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && HTTP_METHODS.has(d.name.text)),
  );
  if (exported.length + exportedConsts.length !== 1 || exported.length !== 1) {
    fail(`${sf.fileName}: expected exactly one exported request handler function, found ${exported.length + exportedConsts.length}`);
  }
  const handler = /** @type {ts.FunctionDeclaration} */ (exported[0]);
  for (const st of handler.body.statements) {
    const ret =
      ts.isReturnStatement(st)
        ? st
        : ts.isTryStatement(st) && !st.catchClause && st.tryBlock.statements.length === 1 && ts.isReturnStatement(st.tryBlock.statements[0])
          ? st.tryBlock.statements[0]
          : null;
    if (!ret || !ret.expression) continue;
    let e = unwrap(ret.expression);
    if (ts.isAwaitExpression(e)) e = unwrap(e.expression);
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      const target = functionNamed(sf, e.expression.text);
      if (target) return target;
    }
  }
  return handler;
}

/**
 * The allow list: the receiver of the negated `.has(tool)` that is a statement
 * directly in the request handler's body (not inside a `try`, loop, callback
 * or condition) and ends with `return` of the 403 answer, where `tool` is the
 * one const declared directly in that body from the request's `tool` field.
 * Every use of `tool` before the guard may only test it (`!tool`, a
 * comparison, `typeof`).
 * @param {ts.SourceFile} sf
 */
function allowListName(sf) {
  const body = requestHandler(sf).body;
  const toolVars = [];
  for (const st of body.statements) {
    if (!ts.isVariableStatement(st) || !(st.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const d of st.declarationList.declarations) {
      if (
        ts.isIdentifier(d.name) &&
        d.initializer &&
        contains(d.initializer, (x) => ts.isPropertyAccessExpression(x) && x.name.text === "tool")
      ) {
        toolVars.push(d.name.text);
      }
    }
  }
  const notFound = (why) =>
    fail(
      `${sf.fileName}: the allow-list guard was not found: expected one \`if (!LIST.has(tool))\` answering 403, ` +
        `directly in the request handler's body, for the requested tool (${why})`,
    );
  if (toolVars.length !== 1) notFound(`tool variables: ${toolVars.join(", ") || "none"}`);
  const tool = toolVars[0];
  const guards = body.statements.filter((st) => {
    if (!ts.isIfStatement(st)) return false;
    const call = negatedCall(unwrap(st.expression));
    return (
      !!call &&
      ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "has" &&
      ts.isIdentifier(call.expression.expression) &&
      call.arguments.length === 1 &&
      ts.isIdentifier(call.arguments[0]) &&
      call.arguments[0].text === tool &&
      contains(st.thenStatement, is403)
    );
  });
  if (guards.length !== 1) notFound(`found ${guards.length}`);
  const guard = /** @type {ts.IfStatement} */ (guards[0]);
  if (!returns403(guard.thenStatement)) {
    fail(`${sf.fileName}: the allow-list guard does not stop the request: its block must end with \`return\` of the 403 answer`);
  }
  // Before the guard, the tool name may only be tested.
  const guardStart = guard.getStart(sf);
  const visit = (n) => {
    if (n.getStart(sf) >= guardStart) return;
    if (ts.isIdentifier(n) && n.text === tool && n.getEnd() <= guardStart && !isTest(n)) {
      fail(
        `${sf.fileName}:${lineOf(sf, n)}: the tool name is used before the allow-list guard ` +
          `(\`${n.parent.getText(sf).slice(0, 80)}\`)`,
      );
    }
    ts.forEachChild(n, visit);
  };
  body.statements.forEach(visit);
  return /** @type {ts.Identifier} */ (/** @type {ts.CallExpression} */ (negatedCall(unwrap(guard.expression))).expression.expression).text;
}

/** A use of the tool name that only tests it, or its own declaration. @param {ts.Identifier} n */
function isTest(n) {
  const p = n.parent;
  // A property name (`body.tool`, `{ tool: x }`) is not a use of the variable.
  if ((ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p)) && p.name === n) return true;
  if (ts.isVariableDeclaration(p) && p.name === n) return true;
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isTypeOfExpression(p)) return true;
  if (ts.isBinaryExpression(p)) {
    const k = p.operatorToken.kind;
    return (
      k === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      k === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      k === ts.SyntaxKind.EqualsEqualsToken ||
      k === ts.SyntaxKind.ExclamationEqualsToken
    );
  }
  return false;
}

/** @param {ts.Node} x */
function is403(x) {
  return (
    ts.isPropertyAssignment(x) &&
    ts.isIdentifier(x.name) &&
    x.name.text === "status" &&
    ts.isNumericLiteral(x.initializer) &&
    x.initializer.text === "403"
  );
}

/**
 * Whether a guard's block ends the handler: its final statement is `return` of
 * an expression carrying status 403. A `throw` is not accepted: a wrapper can
 * catch it.
 * @param {ts.Statement} then
 */
function returns403(then) {
  const last = ts.isBlock(then) ? then.statements[then.statements.length - 1] : then;
  return !!last && ts.isReturnStatement(last) && !!last.expression && contains(last.expression, is403);
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
  const names = namesOfSet(PASSTHROUGH_ROUTE, allowListName(parseRel(PASSTHROUGH_ROUTE)), 0, track);
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
