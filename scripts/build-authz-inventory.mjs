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
 *     holds. The reading is deliberately NARROW and fail-closed: it accepts
 *     exactly the forms the route uses and refuses every other form with its
 *     file, its line and the words "form not read yet". Files are parsed with
 *     the TypeScript parser; an import is resolved with TypeScript's own
 *     `ts.resolveModuleName` and the repository's tsconfig options. Accepted:
 *     - ALLOWED_TOOLS: one top-level `const` of
 *       src/app/api/agents/passthrough/route.ts, initialized directly with
 *       `new Set([...])`.
 *     - an element that is a string literal or a template without
 *       substitution;
 *     - an element that is an identifier bound in the same file by a
 *       top-level `const` with such a literal initializer, or by a named value
 *       import (`import { X }`, `import { X as Y }`) whose resolved file itself
 *       declares `export const X = <such a literal>` at top level;
 *     - an element `...X` where X is bound in the same file by a top-level
 *       `const` initialized directly with `new Set([...])` or an array literal
 *       (optionally `as const`) of accepted elements, or by a named value
 *       import whose resolved file itself declares `export const X` of that
 *       shape at top level; read by the same rules. A set or array reached a
 *       second time (a self-spread included) is refused.
 *     A type annotation on an accepted `const` and type arguments on
 *     `new Set<T>(...)` are accepted (the route's sets use both).
 *     Refused, among others: an imported ALLOWED_TOOLS; a type-only import; a
 *     default or namespace import; a re-export or barrel between the import
 *     and the declaration; an import whose resolved file's real path lies
 *     outside the real repository root or inside a `node_modules` directory
 *     (a workspace package reached through a `node_modules` symlink counts by
 *     its real path); `let` or `var`; a wrapper around an element or an
 *     initializer other than `as const` on an array literal (parentheses,
 *     `as T`, `<T>`, `satisfies`, `!`); a call, a computed value, a
 *     conditional; a second top-level binding of the same name; a top-level
 *     binding of `Set` in a file whose set is read.
 *     The builder reads declarations only and judges no use.
 *     A name the list holds that is also an MCP tool has a row on each road.
 *     That the route refuses every other name is the subject of the route's
 *     own tests (src/__tests__/passthrough-dashboards-create-3092.test.ts,
 *     "keeps %s off the allowlist").
 * Stated limit: a set or array changed after its declaration (`.add`, `.push`,
 * `.length`, an alias) is not read.
 * Not covered yet (cinatra#4895): a tool a pack registers only in its
 * `register(ctx)` through `ctx.mcp.registerTool` has no row unless the pack's
 * metadata block lists it.
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
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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

/** @param {string} fileName */
function relPath(fileName) {
  return relative(ROOT, fileName).split(sep).join("/");
}

/** @param {ts.Node} node */
function at(node) {
  const sf = node.getSourceFile();
  return `${relPath(sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
}

/**
 * The passthrough reading accepts a fixed set of forms (see the header). Any
 * other form fails the builder with its file, its line and these words.
 */
const NOT_READ = "form not read yet";
/** @param {ts.Node} node @param {string} what @returns {never} */
function refuse(node, what) {
  return fail(`${at(node)}: ${what}: ${NOT_READ}`);
}

/** The route's allow list: the one top-level binding of this name in the route. */
const ALLOW_LIST_NAME = "ALLOWED_TOOLS";

/** The repository's compiler options, for TypeScript's own module resolution. */
function compilerOptions() {
  const configPath = join(ROOT, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) fail(`cannot read ${relPath(configPath)}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`);
  return ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT, undefined, configPath).options;
}

/** @type {Map<string, ts.SourceFile>} */
const parsed = new Map();
/** @param {string} file an absolute real path */
function parse(file) {
  let sf = parsed.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    parsed.set(file, sf);
  }
  return sf;
}

/**
 * Every top-level binding of `name` in `sf`, each with the form it has. Only a
 * value binding counts: a type alias or an interface of the same name does not.
 * @param {ts.SourceFile} sf @param {string} name
 * @returns {Array<{ node: ts.Node, kind: "const" | "import" | "other", decl?: ts.VariableDeclaration, stmt?: ts.VariableStatement, imp?: ts.ImportDeclaration }>}
 */
function topLevel(sf, name) {
  const found = [];
  /** @param {ts.BindingName} b @param {ts.VariableDeclaration} d @param {ts.VariableStatement} stmt */
  const fromName = (b, d, stmt) => {
    if (ts.isIdentifier(b)) {
      if (b.text !== name) return;
      const isConst = (stmt.declarationList.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const;
      found.push({ node: b, kind: isConst ? "const" : "other", decl: d, stmt });
    } else {
      for (const e of b.elements) if (!ts.isOmittedExpression(e)) fromName(e.name, d, stmt);
    }
  };
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        const before = found.length;
        fromName(d.name, d, stmt);
        // A name bound by destructuring is never an accepted form.
        if (!ts.isIdentifier(d.name)) for (const f of found.slice(before)) f.kind = "other";
      }
    } else if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const c = stmt.importClause;
      if (c.name?.text === name) found.push({ node: c.name, kind: "other", imp: stmt });
      const b = c.namedBindings;
      if (b && ts.isNamespaceImport(b) && b.name.text === name) found.push({ node: b.name, kind: "other", imp: stmt });
      if (b && ts.isNamedImports(b)) {
        for (const e of b.elements) if (e.name.text === name) found.push({ node: e, kind: "import", imp: stmt });
      }
    } else if (ts.isImportEqualsDeclaration(stmt) && stmt.name.text === name) {
      found.push({ node: stmt.name, kind: "other" });
    } else if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt) || ts.isModuleDeclaration(stmt)) &&
      stmt.name &&
      ts.isIdentifier(stmt.name) &&
      stmt.name.text === name
    ) {
      found.push({ node: stmt.name, kind: "other" });
    }
  }
  return found;
}

/**
 * The one top-level binding of `name` in `sf`, for a use at `use`. None, two,
 * or a binding other than a `const` or a named import fails the builder.
 * @param {ts.SourceFile} sf @param {string} name @param {ts.Node} use
 */
function onlyBinding(sf, name, use) {
  const found = topLevel(sf, name);
  if (found.length === 0) refuse(use, `${name} has no top-level binding in ${relPath(sf.fileName)}`);
  if (found.length > 1) refuse(found[1].node, `a second top-level binding of ${name}`);
  const b = found[0];
  if (b.kind === "other") refuse(b.node, `${name} is not bound by a top-level const or a named value import`);
  return b;
}

/** @param {string} file @returns {string | null} */
function realPathOf(file) {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * Membership is decided on one fact, the REAL path of the resolved file: it is
 * a source module of the repository when it lies inside the real repository
 * root (compared by path segments) and inside no `node_modules` directory
 * there. How TypeScript reached it (a relative path, a path alias, a
 * `node_modules` symlink of a workspace package, `isExternalLibraryImport`)
 * does not count.
 * @param {string} real an absolute real path
 */
function isRepositorySource(real) {
  const rel = relative(ROOT, real);
  if (rel === "" || isAbsolute(rel)) return false;
  const segments = rel.split(sep);
  return segments[0] !== ".." && !segments.includes("node_modules");
}

/** @param {ts.Node} stmt */
const isExported = (stmt) =>
  !!ts.canHaveModifiers(stmt) && !!ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/**
 * The top-level `const` declaration of `name` that a use in `sf` names: a
 * `const` in `sf` itself, or a named value import whose resolved file itself
 * declares `export const <name>` at top level. A type-only import, a re-export
 * or barrel, a default or namespace import, `let` or `var`, a second binding:
 * each fails the builder.
 * @param {ts.SourceFile} sf @param {string} name @param {ts.Node} use @param {ts.CompilerOptions} options
 * @returns {ts.VariableDeclaration & { initializer: ts.Expression }}
 */
function constDeclaration(sf, name, use, options) {
  const b = onlyBinding(sf, name, use);
  let decl = b.decl;
  if (b.kind === "import") {
    const spec = /** @type {ts.ImportSpecifier} */ (b.node);
    const imp = /** @type {ts.ImportDeclaration} */ (b.imp);
    if (imp.importClause?.isTypeOnly || spec.isTypeOnly) refuse(spec, `${name} is a type-only import`);
    const from = /** @type {ts.StringLiteral} */ (imp.moduleSpecifier).text;
    const resolved = ts.resolveModuleName(from, sf.fileName, options, ts.sys).resolvedModule;
    const real = resolved && resolved.extension !== ts.Extension.Dts ? realPathOf(resolved.resolvedFileName) : null;
    if (!real || !isRepositorySource(real)) {
      refuse(imp, `"${from}" does not resolve to a source module of the repository`);
    }
    const target = parse(/** @type {string} */ (real));
    const original = (spec.propertyName ?? spec.name).text;
    const there = topLevel(target, original);
    if (there.length !== 1 || there[0].kind !== "const" || !isExported(/** @type {ts.Node} */ (there[0].stmt))) {
      refuse(spec, `${relPath(target.fileName)} does not itself declare one \`export const ${original}\``);
    }
    decl = there[0].decl;
  }
  const d = /** @type {ts.VariableDeclaration} */ (decl);
  if (!d.initializer) refuse(d, `${name} has no initializer`);
  return /** @type {any} */ (d);
}

/** @param {ts.Expression} e a string literal or a template without substitution */
const isLiteral = (e) => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e);

/**
 * The elements of a set or list initializer: `new Set([...])` (type arguments
 * allowed), or, when `arrays`, an array literal, optionally `as const`. The
 * file must not bind `Set` itself. Anything else fails the builder.
 * @param {ts.VariableDeclaration & { initializer: ts.Expression }} decl @param {boolean} arrays
 */
function elementsOf(decl, arrays) {
  const init = decl.initializer;
  if (arrays && ts.isArrayLiteralExpression(init)) return init.elements;
  if (arrays && ts.isAsExpression(init) && ts.isConstTypeReference(init.type) && ts.isArrayLiteralExpression(init.expression)) {
    return init.expression.elements;
  }
  if (
    ts.isNewExpression(init) &&
    ts.isIdentifier(init.expression) &&
    init.expression.text === "Set" &&
    init.arguments?.length === 1 &&
    ts.isArrayLiteralExpression(init.arguments[0])
  ) {
    const shadow = topLevel(init.getSourceFile(), "Set");
    if (shadow.length) refuse(shadow[0].node, "a top-level binding of Set");
    return init.arguments[0].elements;
  }
  return refuse(init, `${decl.name.getText()} is not initialized with \`new Set([...])\`${arrays ? " or an array literal" : ""}`);
}

/**
 * The names a set or array admits, read by the accepted forms. The row's file
 * is the module of the set or array that holds the element.
 * @param {ts.VariableDeclaration & { initializer: ts.Expression }} decl
 * @param {boolean} arrays @param {Set<ts.VariableDeclaration>} visited @param {ts.CompilerOptions} options
 * @returns {Array<{primitiveName:string,file:string,line:number}>}
 */
function namesOf(decl, arrays, visited, options) {
  if (visited.has(decl)) refuse(decl, `${decl.name.getText()} is spread a second time (or spreads itself)`);
  visited.add(decl);
  const sf = decl.getSourceFile();
  const file = relPath(sf.fileName);
  const out = [];
  for (const el of elementsOf(decl, arrays)) {
    const line = sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1;
    if (isLiteral(el)) {
      out.push({ primitiveName: /** @type {ts.StringLiteral} */ (el).text, file, line });
    } else if (ts.isIdentifier(el)) {
      const c = constDeclaration(sf, el.text, el, options);
      if (!isLiteral(c.initializer)) refuse(c.initializer, `${el.text} is not initialized with a string literal`);
      out.push({ primitiveName: /** @type {ts.StringLiteral} */ (c.initializer).text, file, line });
    } else if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) {
      out.push(...namesOf(constDeclaration(sf, el.expression.text, el.expression, options), true, visited, options));
    } else {
      refuse(el, `the element \`${el.getText(sf).slice(0, 80)}\``);
    }
  }
  return out;
}

/**
 * The passthrough road: the names the route's ALLOWED_TOOLS holds. The list is
 * one top-level `const` of the route initialized with `new Set([...])`.
 */
function scanPassthrough() {
  const options = compilerOptions();
  const file = join(ROOT, PASSTHROUGH_ROUTE);
  let route;
  try {
    route = parse(file);
  } catch {
    fail(`cannot read ${PASSTHROUGH_ROUTE}`);
  }
  const found = topLevel(route, ALLOW_LIST_NAME);
  if (found.length === 0) fail(`${PASSTHROUGH_ROUTE}: no top-level binding of ${ALLOW_LIST_NAME}`);
  const b = onlyBinding(route, ALLOW_LIST_NAME, route);
  if (b.kind !== "const") refuse(b.node, `${ALLOW_LIST_NAME} is imported`);
  const list = constDeclaration(route, ALLOW_LIST_NAME, b.node, options);
  return namesOf(list, false, new Set(), options);
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
