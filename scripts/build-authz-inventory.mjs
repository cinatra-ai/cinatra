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
 *     The list is read with the TypeScript type checker, on one program built
 *     with the repository's tsconfig whose only root file is the route: names
 *     resolve as in the product (path aliases, barrels, `export *`, type and
 *     value name spaces). Parentheses, `as`, `<T>`, `satisfies` and `!` are
 *     removed with TypeScript's own helper. Accepted entries: a string
 *     literal, a template without substitution, an identifier the checker
 *     resolves to a module-level const with such a value, and a spread of an
 *     identifier the checker resolves to a module-level const `new Set([...])`
 *     or array literal of accepted entries, read the same way. Any other entry
 *     FAILS the builder with its file and line. A use of a read set that could
 *     change it, in its own module or in the route, FAILS the builder.
 *     A name the list holds that is also an MCP tool has a row on each road.
 *     The inventory records which tool names the allow list holds. That the
 *     route refuses every other name is the subject of the route's own tests
 *     (src/__tests__/passthrough-dashboards-create-3092.test.ts, "keeps %s off
 *     the allowlist").
 * Not covered yet (cinatra#4895): a tool a pack registers only in its
 * `register(ctx)` through `ctx.mcp.registerTool` has no row unless the pack's
 * metadata block lists it.
 * Stated limit: a mutation of a read set from a module other than its own and
 * the route is not read.
 * A row's `file` is its owner: a path under `extensions/<scope>/<pack>/` is
 * that pack, any other path is core. A passthrough row's file is the module
 * of the set that holds the entry (the route or a spread set), never the
 * module of an imported constant the entry names.
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
import { readFileSync, writeFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const args = process.argv.slice(2);
const check = args.includes("--check");
// `--root <dir>` runs the builder on another tree (a test fixture).
const rootArg = args.indexOf("--root");
// The real path: TypeScript reports resolved modules by their real path.
const ROOT = realpathSync(
  rootArg === -1 ? resolve(fileURLToPath(import.meta.url), "../..") : resolve(args[rootArg + 1] ?? ""),
);
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
  // keyed by its road, so an mcp row never hides it. A passthrough row is also
  // keyed by its file: two sets in different files that admit the same name
  // keep a row each, so the owner check of #4874 sees both owners. Only a row
  // identical in name, road and file is merged, keeping its smallest line.
  for (const r of scanPassthrough()) {
    const key = `${r.primitiveName}::passthrough::${r.file}`;
    const prev = dedupe.get(key);
    if (!prev || prev.line > r.line) dedupe.set(key, { ...r, road: "passthrough" });
  }
  const deduped = [...dedupe.values()].map(({ primitiveName, file, line, road }) => ({ primitiveName, file, road, line }));
  deduped.sort(
    (a, b) =>
      a.primitiveName.localeCompare(b.primitiveName) || a.file.localeCompare(b.file) || a.road.localeCompare(b.road),
  );
  return deduped;
}

/** @param {string} message */
function fail(message) {
  throw new Error(`authz inventory: ${message}`);
}

/** @param {ts.Node} node */
function at(node) {
  const sf = node.getSourceFile();
  return `${relPath(sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
}

/** @param {string} fileName */
function relPath(fileName) {
  return relative(ROOT, fileName).split(sep).join("/");
}

/**
 * Parentheses, `as`, `<T>`, `satisfies` and `!` change no value: TypeScript's
 * own helper removes them.
 * @param {ts.Expression} e
 */
function unwrap(e) {
  return ts.skipOuterExpressions(e, ts.OuterExpressionKinds.Parentheses | ts.OuterExpressionKinds.Assertions);
}

/** The route's allow list: the one binding of this name in the route module. */
const ALLOW_LIST_NAME = "ALLOWED_TOOLS";

/**
 * One TypeScript program with the repository's own tsconfig (path aliases,
 * barrels, `export *` precedence and the type and value name spaces resolve
 * as in the product). Its only root file is the route: the checker loads what
 * the route imports.
 */
function createProgram() {
  const configPath = join(ROOT, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) fail(`cannot read ${relPath(configPath)}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT, undefined, configPath);
  const options = { ...parsed.options, noEmit: true, incremental: false, composite: false, tsBuildInfoFile: undefined };
  return ts.createProgram({ rootNames: [join(ROOT, PASSTHROUGH_ROUTE)], options });
}

/**
 * The module-level `const` declaration that `id` names, as the checker
 * resolves it: through imports, re-exports and path aliases to the value
 * declaration. Anything else FAILS the builder.
 * @param {ts.TypeChecker} checker @param {ts.Identifier} id
 * @returns {ts.VariableDeclaration & { initializer: ts.Expression }}
 */
function constOf(checker, id) {
  let sym = checker.getSymbolAtLocation(id);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const decl = sym?.valueDeclaration;
  if (!decl) fail(`${at(id)}: ${id.text} does not resolve to a value declaration`);
  if (!ts.isVariableDeclaration(decl) || !ts.isVariableDeclarationList(decl.parent)) {
    fail(`${at(id)}: ${id.text} resolves to ${at(decl)}, which is not a const declaration`);
  }
  if (!(decl.parent.flags & ts.NodeFlags.Const)) fail(`${at(decl)}: ${id.text} is not declared with const`);
  const stmt = decl.parent.parent;
  if (!ts.isVariableStatement(stmt) || !ts.isSourceFile(stmt.parent)) fail(`${at(decl)}: ${id.text} is not declared at module level`);
  if (!decl.initializer) fail(`${at(decl)}: ${id.text} has no initializer`);
  return /** @type {any} */ (decl);
}

/**
 * The elements of a set or list declaration: `new Set([...])` with the global
 * Set, or (when `arrays`) an array literal, `as const` allowed.
 * @param {ts.TypeChecker} checker @param {ts.Program} program
 * @param {ts.VariableDeclaration & { initializer: ts.Expression }} decl @param {boolean} arrays
 */
function elementsOf(checker, program, decl, arrays) {
  const init = unwrap(decl.initializer);
  if (arrays && ts.isArrayLiteralExpression(init)) return init.elements;
  if (ts.isNewExpression(init) && ts.isIdentifier(init.expression) && init.arguments?.length === 1) {
    const ctor = checker.getSymbolAtLocation(init.expression);
    const globalSet = ctor?.declarations?.every((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()));
    const list = unwrap(init.arguments[0]);
    if (init.expression.text === "Set" && globalSet && ts.isArrayLiteralExpression(list)) return list.elements;
  }
  return fail(`${at(decl)}: ${decl.name.getText()} is not a \`new Set([...])\`${arrays ? " or an array literal" : ""} of literals`);
}

/**
 * The names a set admits. Accepted entries: a string literal, a template
 * without substitution, an identifier the checker resolves to a module-level
 * const with such a value, and a spread of an identifier the checker resolves
 * to a module-level const set or array read the same way. Anything else FAILS
 * the builder. The row's file is the module of the set that admits the name.
 * @param {ts.TypeChecker} checker @param {ts.Program} program
 * @param {ts.VariableDeclaration & { initializer: ts.Expression }} decl
 * @param {boolean} arrays @param {Set<ts.Node>} stack the sets on this chain, to refuse a cycle
 * @param {Set<ts.VariableDeclaration>} seen every set read, for the mutation check
 * @returns {Array<{primitiveName:string,file:string,line:number}>}
 */
function namesOfSet(checker, program, decl, arrays, stack, seen) {
  if (stack.has(decl)) fail(`${at(decl)}: the set ${decl.name.getText()} spreads itself`);
  stack.add(decl);
  seen.add(decl);
  const sf = decl.getSourceFile();
  const file = relPath(sf.fileName);
  const out = [];
  for (const raw of elementsOf(checker, program, decl, arrays)) {
    const line = sf.getLineAndCharacterOfPosition(raw.getStart(sf)).line + 1;
    const el = ts.isSpreadElement(raw) ? raw : unwrap(raw);
    if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) {
      out.push({ primitiveName: el.text, file, line });
    } else if (ts.isIdentifier(el)) {
      const c = constOf(checker, el);
      const v = unwrap(c.initializer);
      if (!(ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v))) {
        fail(`${at(el)}: allow-list entry ${el.text} is not a const with a string literal value`);
      }
      // The row names the set that admits the name, never the constant's module.
      out.push({ primitiveName: v.text, file, line });
    } else if (ts.isSpreadElement(el) && ts.isIdentifier(unwrap(el.expression))) {
      const c = constOf(checker, /** @type {ts.Identifier} */ (unwrap(el.expression)));
      out.push(...namesOfSet(checker, program, c, true, stack, seen));
    } else {
      fail(`${at(raw)}: allow-list entry \`${raw.getText(sf).slice(0, 80)}\` is not a literal, a literal const or a spread set`);
    }
  }
  stack.delete(decl);
  return out;
}

/**
 * In the module that declares a set read for the allow list, and in the
 * route, every value reference to that set must leave it as declared: its
 * declaration, an export, a spread, a `for…of`, `Array.from(X)`, `X.size`,
 * `X.length`, or a call of `.has`, `.includes`, `.forEach`, `.values`,
 * `.keys`, `.entries`. Any other use FAILS the builder. References are found
 * by symbol, so a type of the same name is not a use.
 * @param {ts.TypeChecker} checker @param {ts.SourceFile} route @param {Set<ts.VariableDeclaration>} seen
 */
function assertSetsConstant(checker, route, seen) {
  const READS = new Set(["has", "includes", "forEach", "values", "keys", "entries"]);
  const files = new Set([route, ...[...seen].map((d) => d.getSourceFile())]);
  for (const sf of files) {
    const visit = (n) => {
      if (ts.isIdentifier(n) && !ts.isPartOfTypeNode(n)) {
        // `{ X }` names the property at the location; the value is the set.
        let sym = ts.isShorthandPropertyAssignment(n.parent)
          ? checker.getShorthandAssignmentValueSymbol(n.parent)
          : checker.getSymbolAtLocation(n);
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
        const decl = sym?.valueDeclaration;
        if (decl && seen.has(/** @type {any} */ (decl))) {
          const p = n.parent;
          const ok =
            (ts.isVariableDeclaration(p) && p.name === n) ||
            ts.isImportSpecifier(p) ||
            ts.isImportClause(p) ||
            ts.isExportSpecifier(p) ||
            ts.isTypeAliasDeclaration(p) ||
            ts.isInterfaceDeclaration(p) ||
            (ts.isPropertyAccessExpression(p) && p.name === n) ||
            ts.isSpreadElement(p) ||
            (ts.isForOfStatement(p) && p.expression === n) ||
            (ts.isPropertyAccessExpression(p) &&
              p.expression === n &&
              (((p.name.text === "size" || p.name.text === "length") &&
                !(ts.isBinaryExpression(p.parent) && p.parent.left === p)) ||
                (READS.has(p.name.text) && ts.isCallExpression(p.parent) && p.parent.expression === p))) ||
            (ts.isCallExpression(p) && p.expression.getText(sf) === "Array.from" && p.arguments[0] === n);
          if (!ok) {
            const shown = ts.isPropertyAccessExpression(p) && ts.isCallExpression(p.parent) ? p.parent : p;
            fail(`${at(n)}: the allow-list set ${n.text} is not used as a constant (\`${shown.getText(sf).slice(0, 80)}\`)`);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
}

function scanPassthrough() {
  const program = createProgram();
  const checker = program.getTypeChecker();
  const route = program.getSourceFile(join(ROOT, PASSTHROUGH_ROUTE));
  if (!route) fail(`cannot read ${PASSTHROUGH_ROUTE}`);
  // The allow list is found by its declaration: exactly one binding of this
  // name in the route, at module level (a const or a named import of one).
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
  visit(route);
  if (found.length !== 1) {
    fail(`${PASSTHROUGH_ROUTE}: expected exactly one declaration or import of ${ALLOW_LIST_NAME}, found ${found.length}`);
  }
  const list = constOf(checker, found[0].name);
  const seen = new Set();
  const names = namesOfSet(checker, program, list, false, new Set(), seen);
  assertSetsConstant(checker, route, seen);
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
