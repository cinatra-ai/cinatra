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
 *   - "pack": a tool a pack registers through its host port,
 *     `ctx.mcp.registerTool({ name, … })` (HostMcpPort in
 *     packages/sdk-extensions/src/host-context.ts), read with the TypeScript
 *     parser from the pack's files under `extensions/`. The name is the object's
 *     `name` property: a literal in any quote form or a const with a literal
 *     value; anything else FAILS the builder. A pack row needs no static
 *     classification: the MCP boundary classifies a pack's tool at run time.
 *     It is a row so the tool has an owner.
 *   - "passthrough": a name the deterministic passthrough route admits that no
 *     MCP road registers. The route's allow list is the set the route checks as
 *     `if (!LIST.has(tool))`, where `tool` is the const read from the request's
 *     `tool` field and the guarded block answers status 403. It is read
 *     with the TypeScript parser: string literals in any quote form, constants
 *     with a literal value, and spread sets followed to their declaration in the
 *     same file or an imported module. An entry the parser cannot resolve to a
 *     literal FAILS the builder. A name the route admits that IS an MCP tool is
 *     dispatched to that tool's handler and keeps its mcp row.
 * A name with rows on two roads keeps both only when their files differ (a pack
 * that lists a tool in its metadata block and also registers it); the owner is
 * the same pack either way.
 * Stated limit: indirection deeper than MAX_SET_DEPTH hops (re-export chains,
 * sets built by code) is refused, not followed.
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
  const packRecords = [];
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
      if (root === "extensions" && body.includes("registerTool")) packRecords.push(...scanPackRegistrations(relative(ROOT, file)));
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
  const mcpNames = new Set(records.map((r) => r.primitiveName));
  for (const r of dedupe.values()) r.road = "mcp";
  for (const r of packRecords) {
    const key = `${r.primitiveName}::${r.file}`;
    if (!dedupe.has(key)) dedupe.set(key, { ...r, road: "pack" });
  }
  for (const r of scanPassthrough()) {
    if (mcpNames.has(r.primitiveName)) continue;
    const key = `${r.primitiveName}::${r.file}`;
    if (!dedupe.has(key)) dedupe.set(key, { ...r, road: "passthrough" });
  }
  const deduped = [...dedupe.values()].map(({ primitiveName, file, line, road }) => ({ primitiveName, file, road, line }));
  deduped.sort((a, b) =>
    a.primitiveName === b.primitiveName ? a.file.localeCompare(b.file) : a.primitiveName.localeCompare(b.primitiveName),
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
  return ts.createSourceFile(rel, body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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
 * The allow list: the receiver of the negated `.has(tool)` whose block answers
 * status 403, where `tool` is the const the route reads from the request's
 * `tool` field. Other `.has` guards are not the allow list.
 * @param {ts.SourceFile} sf
 */
function allowListName(sf) {
  const toolVars = new Set();
  const guards = [];
  const visit = (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      contains(n.initializer, (x) => ts.isPropertyAccessExpression(x) && x.name.text === "tool")
    ) {
      toolVars.add(n.name.text);
    }
    if (ts.isIfStatement(n)) {
      const c = unwrap(n.expression);
      const call = ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken ? unwrap(c.operand) : null;
      if (
        call &&
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "has" &&
        ts.isIdentifier(call.expression.expression) &&
        call.arguments.length === 1 &&
        ts.isIdentifier(call.arguments[0]) &&
        contains(
          n.thenStatement,
          (x) =>
            ts.isPropertyAssignment(x) &&
            x.name.getText(sf) === "status" &&
            ts.isNumericLiteral(x.initializer) &&
            x.initializer.text === "403",
        )
      ) {
        guards.push({ list: call.expression.expression.text, arg: call.arguments[0].text });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const admission = guards.filter((g) => toolVars.has(g.arg));
  if (admission.length !== 1) {
    fail(
      `${sf.fileName}: expected one allow-list guard \`if (!LIST.has(tool))\` answering 403 for the requested tool ` +
        `(tool variables: ${[...toolVars].join(", ") || "none"}), found ${admission.length}`,
    );
  }
  return admission[0].list;
}

/** @param {string} fromRel @param {string} spec */
function resolveModule(fromRel, spec) {
  let base;
  if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith(".")) base = posix.join(posix.dirname(fromRel), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    try {
      if (statSync(join(ROOT, c)).isFile()) return c;
    } catch {
      // try the next form
    }
  }
  return null;
}

/**
 * The top-level `const` declaration of `name` in `rel`, followed through a
 * named import to the module it comes from.
 * @param {string} rel @param {string} name @param {number} depth
 * @returns {{ rel: string, sf: ts.SourceFile, decl: ts.VariableDeclaration }}
 */
function resolveConst(rel, name, depth) {
  if (depth > MAX_SET_DEPTH) fail(`${rel}: ${name} is more than ${MAX_SET_DEPTH} hops from the allow list`);
  const sf = parseRel(rel);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name) return { rel, sf, decl: d };
    }
  }
  for (const st of sf.statements) {
    const bindings = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if (el.name.text !== name) continue;
      const target = resolveModule(rel, /** @type {ts.StringLiteral} */ (st.moduleSpecifier).text);
      if (!target) fail(`${rel}: cannot resolve the import of ${name}`);
      return resolveConst(target, (el.propertyName ?? el.name).text, depth + 1);
    }
  }
  return fail(`${rel}: no const declaration or import of ${name}`);
}

/**
 * The names in a `new Set([...])` declaration: literals in any quote form,
 * constants with a literal value, spread sets read the same way.
 * @param {string} rel @param {string} name @param {number} depth
 * @returns {Array<{primitiveName:string,file:string,line:number}>}
 */
function namesOfSet(rel, name, depth) {
  const { rel: at, sf, decl } = resolveConst(rel, name, depth);
  const init = decl.initializer ? unwrap(decl.initializer) : undefined;
  const list = init && ts.isNewExpression(init) && init.arguments?.length === 1 ? unwrap(init.arguments[0]) : undefined;
  if (!list || !ts.isArrayLiteralExpression(list)) fail(`${at}: ${name} is not a \`new Set([...])\` of literals`);
  const out = [];
  for (const el of list.elements) {
    if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) {
      out.push({ primitiveName: el.text, file: at, line: lineOf(sf, el) });
    } else if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) {
      out.push(...namesOfSet(at, el.expression.text, depth + 1));
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

/** @param {string} rel @param {ts.SourceFile} sf @param {ts.Expression} expr @param {string} what */
function literalOf(rel, sf, expr, what) {
  const e = unwrap(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isIdentifier(e)) {
    const c = resolveConst(rel, e.text, 1);
    const v = c.decl.initializer ? unwrap(c.decl.initializer) : undefined;
    if (v && (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v))) return v.text;
  }
  return fail(`${rel}:${lineOf(sf, expr)}: ${what} \`${expr.getText(sf)}\` is not a literal or a const with a literal value`);
}

/**
 * A pack's `<ctx>.mcp.registerTool({ name, … })` calls in one file.
 * @param {string} rel
 * @returns {Array<{primitiveName:string,file:string,line:number}>}
 */
function scanPackRegistrations(rel) {
  const sf = parseRel(rel);
  const out = [];
  const visit = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "registerTool" &&
      ts.isPropertyAccessExpression(n.expression.expression) &&
      n.expression.expression.name.text === "mcp"
    ) {
      let arg = n.arguments[0] ? unwrap(n.arguments[0]) : undefined;
      if (arg && ts.isIdentifier(arg)) {
        const c = resolveConst(rel, arg.text, 1);
        arg = c.decl.initializer ? unwrap(c.decl.initializer) : undefined;
      }
      const prop =
        arg && ts.isObjectLiteralExpression(arg)
          ? arg.properties.find((p) => p.name && p.name.getText(sf).replace(/^["'`]|["'`]$/g, "") === "name")
          : undefined;
      let primitiveName;
      if (prop && ts.isPropertyAssignment(prop)) primitiveName = literalOf(rel, sf, prop.initializer, "tool name");
      else if (prop && ts.isShorthandPropertyAssignment(prop)) primitiveName = literalOf(rel, sf, prop.name, "tool name");
      else fail(`${rel}:${lineOf(sf, n)}: pack tool registration \`${n.getText(sf).slice(0, 120)}\` has no readable \`name\``);
      out.push({ primitiveName, file: rel, line: lineOf(sf, n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function scanPassthrough() {
  return namesOfSet(PASSTHROUGH_ROUTE, allowListName(parseRel(PASSTHROUGH_ROUTE)), 0);
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
