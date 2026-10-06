#!/usr/bin/env node
// Connector artifact road gate — class 6 (cinatra#3821).
//
// THE RULE. A connector gives an agent its connection and its tools; it never
// creates an artifact and never makes the application create one on its
// behalf. What an artifact holds is the work of the agent extension whose flow
// creates it.
//
// WHAT THIS GATE REFUSES: a new ROAD from a module that faces connectors to a
// module that creates an artifact.
//   - The connector-facing modules (the ROOTS): packages/extensions/src/
//     connector-handler.ts, and every capability the application PUBLISHES to
//     connectors — a registerCapabilityProvider call (or a call of a local
//     wrapper whose body forwards its first parameter to it) in a module under
//     src/ whose provider identity (`packageName`) is the application's own
//     (the value of HOST_PROVIDER_PACKAGE in src/lib/register-host-connector-
//     services.ts). A capability's roots are the modules that define its impl
//     members (an imported identifier roots at its import's module; a member
//     defined in the registering module roots there) plus the modules its
//     declaration names as `entries` (the modules that bind a globalThis slot
//     the impl reads).
//   - The CREATING modules: a module that calls a builder exported by
//     src/lib/artifacts/artifact-writer-witness.ts (the one witness every host
//     writer that mints an artifact representation emits), or that passes a
//     claimed object type id (lib/claimed-type-vocabulary.mjs) as the value of
//     a `typeHint` property.
//   - The REACH: value-import edges only (static imports and re-exports,
//     side-effect imports, literal dynamic import(), require(); `import type`
//     and `export type` are skipped), resolved through `@/` to src/, relative
//     paths, and workspace packages by their package.json `exports` or
//     `src/<subpath>`. A package ROOT barrel (packages/<name>/src/index.*) is
//     not traversed, and a road is at most MAX_EDGES (six) edges from a root:
//     traversing the barrels, every root reaches the whole run machinery,
//     which is no truthful floor.
//
// THE DECLARATION (the `capabilities` section of the baseline) is the one
// place the gate reads whether a capability can create an artifact: EVERY
// published id with `createsArtifact` and, where the impl reaches its work
// through a globalThis slot, `entries`. A published id missing from it, a
// declared id no longer published, a `createsArtifact` that disagrees with the
// reach, and an impl that reads a `globalThis` property (in its own text or in
// the bodies of the same-module functions it names) with no `entries` each
// FAIL. A capability id the gate cannot resolve is a scanner error (exit 2).
//
// THE FLOOR (`roads`, key `<capability id> :: <creating module>`, or
// `packages/extensions/src/connector-handler.ts :: <creating module>`) only
// shrinks, with the sibling gates' mechanics: a new road fails; a road no
// longer reached is STALE and fails until `--write-baseline` ratchets it down;
// `--write-baseline` refuses a grown floor; CONNECTOR_ARTIFACT_ROAD_BASE fails
// closed on a flag-like or unresolvable reference and refuses a committed floor
// that grew against the base. Every road names `removedBy`, the item that
// removes it; UNASSIGNED or empty fails.
//
// THE SDK ROADS LIST: when packages/sdk-extensions/src/artifact-contract.ts
// exports the string-array constant ARTIFACT_CREATING_ROADS, its members under
// the application's provider identity must equal the ids declared
// `createsArtifact: true`; while it is absent the OK line says "SDK roads list
// absent" and this gate's declaration governs.
//
// Usage:
//   node scripts/audit/connector-artifact-road-gate.mjs                  # check (default)
//   node scripts/audit/connector-artifact-road-gate.mjs --write-baseline # ratchet the floor down
//   CONNECTOR_ARTIFACT_ROAD_BASE=<ref> node ...  # also fail if the committed floor GREW vs <ref>
// Exit 0 = clean, 1 = findings, 2 = scanner error.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import tsDefault from "typescript";
import {
  diffGrown,
  diffShrunk,
  baseRefProblem,
  isExemptFile,
  listScanFiles,
  isVocabularyId,
} from "./application-border-gate.mjs";
import { ClaimedTypeVocabularyError, loadClaimedTypeVocabulary } from "./lib/claimed-type-vocabulary.mjs";

export { diffGrown, diffShrunk, baseRefProblem };

const ts = tsDefault;
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const BASELINE_REL = "scripts/audit/connector-artifact-road-gate.baseline.json";
const BASELINE_PATH = join(REPO_ROOT, BASELINE_REL);
const TAG = "[connector-artifact-road-gate]";

export const MAX_EDGES = 6;
export const CONNECTOR_HANDLER_MODULE = "packages/extensions/src/connector-handler.ts";
export const WITNESS_MODULE = "src/lib/artifacts/artifact-writer-witness.ts";
export const HOST_PROVIDER_MODULE = "src/lib/register-host-connector-services.ts";
export const SDK_ROADS_MODULE = "packages/sdk-extensions/src/artifact-contract.ts";
export const UNASSIGNED = "UNASSIGNED";
const REGISTER_FN = "registerCapabilityProvider";

export class RoadScannerError extends Error {
  constructor(message) {
    super(message);
    this.name = "RoadScannerError";
  }
}

const CODE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const BARREL_RE = /^packages\/[^/]+\/src\/index\.[mc]?[tj]sx?$/;

function scriptKindOf(rel) {
  if (/\.tsx$/.test(rel)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(rel)) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(rel)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function unwrap(expr) {
  let e = expr;
  while (
    e &&
    (ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression?.(e) ||
      ts.isTypeAssertionExpression(e) ||
      ts.isNonNullExpression(e))
  ) {
    e = e.expression;
  }
  return e;
}

/** The module model: parsing, import resolution and value-import edges, cached per scan. */
class Modules {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
    this.cache = new Map();
    this.packages = this.readWorkspacePackages();
  }

  readWorkspacePackages() {
    const map = new Map();
    const dir = join(this.repoRoot, "packages");
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return map;
    }
    for (const name of names) {
      const pj = join(dir, name, "package.json");
      if (!existsSync(pj)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pj, "utf8"));
        if (typeof pkg.name === "string") map.set(pkg.name, { dir: `packages/${name}`, exports: pkg.exports });
      } catch {
        // an unreadable package manifest resolves nothing
      }
    }
    return map;
  }

  isFile(rel) {
    try {
      return statSync(join(this.repoRoot, rel)).isFile();
    } catch {
      return false;
    }
  }

  tryFile(base) {
    const norm = posix.normalize(base);
    if (CODE_EXTS.some((e) => norm.endsWith(e)) && this.isFile(norm)) return norm;
    for (const e of CODE_EXTS) if (this.isFile(norm + e)) return norm + e;
    const swapped = norm.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts").replace(/\.cjs$/, ".cts").replace(/\.jsx$/, ".tsx");
    if (swapped !== norm && this.isFile(swapped)) return swapped;
    if (norm.endsWith(".js") && this.isFile(norm.replace(/\.js$/, ".tsx"))) return norm.replace(/\.js$/, ".tsx");
    for (const e of CODE_EXTS) if (this.isFile(`${norm}/index${e}`)) return `${norm}/index${e}`;
    return null;
  }

  /** Resolve a specifier imported by `from` to a repo-relative module, or null (outside the application). */
  resolve(from, spec) {
    if (spec.startsWith("@/")) return this.tryFile(`src/${spec.slice(2)}`);
    if (spec.startsWith("./") || spec.startsWith("../")) return this.tryFile(posix.join(posix.dirname(from), spec));
    const m = spec.match(/^((?:@[^/]+\/)?[^/@]+)(?:\/(.+))?$/);
    if (!m) return null;
    const pkg = this.packages.get(m[1]);
    if (!pkg) return null;
    const sub = m[2] ? `./${m[2]}` : ".";
    let target = null;
    if (pkg.exports && typeof pkg.exports === "object" && !Array.isArray(pkg.exports)) {
      let e = pkg.exports[sub];
      if (e && typeof e === "object") e = e.import ?? e.default ?? e.node ?? Object.values(e).find((v) => typeof v === "string");
      if (typeof e === "string") target = this.tryFile(posix.join(pkg.dir, e.replace(/^\.\//, "")));
    } else if (sub === "." && typeof pkg.exports === "string") {
      target = this.tryFile(posix.join(pkg.dir, pkg.exports.replace(/^\.\//, "")));
    }
    if (!target) target = this.tryFile(posix.join(pkg.dir, "src", m[2] ?? "index"));
    return target;
  }

  get(rel) {
    if (this.cache.has(rel)) return this.cache.get(rel);
    let mod = null;
    if (this.isFile(rel)) {
      const text = readFileSync(join(this.repoRoot, rel), "utf8");
      const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKindOf(rel));
      mod = { rel, text, sf, edges: null };
    }
    this.cache.set(rel, mod);
    return mod;
  }

  /** Value-import edges of a module (resolved, repo-relative, deduplicated). */
  edges(rel) {
    const mod = this.get(rel);
    if (!mod) return [];
    if (mod.edges) return mod.edges;
    const specs = [];
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const clause = node.importClause;
        const typeOnly =
          clause &&
          (clause.isTypeOnly ||
            (!clause.name &&
              clause.namedBindings &&
              ts.isNamedImports(clause.namedBindings) &&
              clause.namedBindings.elements.length > 0 &&
              clause.namedBindings.elements.every((el) => el.isTypeOnly)));
        if (!typeOnly) specs.push(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const typeOnly =
          node.isTypeOnly ||
          (node.exportClause &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.length > 0 &&
            node.exportClause.elements.every((el) => el.isTypeOnly));
        if (!typeOnly) specs.push(node.moduleSpecifier.text);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteralLike(node.moduleReference.expression)
      ) {
        specs.push(node.moduleReference.expression.text);
      } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
          specs.push(node.arguments[0].text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(mod.sf);
    const out = new Set();
    for (const spec of specs) {
      const target = this.resolve(rel, spec);
      if (target && target !== rel) out.add(target);
    }
    mod.edges = [...out].sort();
    return mod.edges;
  }
}

/** Find the binding of `name` visible from `node`: a variable, a function, or an import. */
function findBinding(name, node) {
  for (let cur = node; cur; cur = cur.parent) {
    const statements = cur.statements ?? (ts.isCaseClause?.(cur) || ts.isDefaultClause?.(cur) ? cur.statements : null);
    if (statements) {
      for (const st of statements) {
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.name.text === name) return { kind: "var", decl: d };
          }
        } else if (ts.isFunctionDeclaration(st) && st.name?.text === name) {
          return { kind: "fn", decl: st };
        } else if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteralLike(st.moduleSpecifier)) {
          const clause = st.importClause;
          const spec = st.moduleSpecifier.text;
          if (clause.name?.text === name) return { kind: "import", spec, imported: "default" };
          const nb = clause.namedBindings;
          if (nb && ts.isNamespaceImport(nb) && nb.name.text === name) return { kind: "import", spec, imported: "*" };
          if (nb && ts.isNamedImports(nb)) {
            for (const el of nb.elements) {
              if (el.name.text === name) return { kind: "import", spec, imported: (el.propertyName ?? el.name).text };
            }
          }
        }
      }
    }
    if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) || ts.isFunctionDeclaration(cur)) && cur.parameters) {
      for (const p of cur.parameters) if (ts.isIdentifier(p.name) && p.name.text === name) return { kind: "param", decl: p };
    }
  }
  return null;
}

/** Find an exported value `name` of module `rel` (following re-exports): { mod, init } or null. */
function findExport(modules, rel, name, depth = 0) {
  if (depth > 8) return null;
  const mod = modules.get(rel);
  if (!mod) return null;
  for (const st of mod.sf.statements) {
    const exported = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) return { mod, init: d.initializer };
      }
    }
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.name.text !== name) continue;
        const local = (el.propertyName ?? el.name).text;
        if (st.moduleSpecifier && ts.isStringLiteralLike(st.moduleSpecifier)) {
          const target = modules.resolve(rel, st.moduleSpecifier.text);
          return target ? findExport(modules, target, local, depth + 1) : null;
        }
        const b = findBinding(local, st);
        if (b?.kind === "var") return { mod, init: b.decl.initializer };
        if (b?.kind === "import") {
          const target = modules.resolve(rel, b.spec);
          return target ? findExport(modules, target, b.imported, depth + 1) : null;
        }
      }
    }
  }
  for (const st of mod.sf.statements) {
    if (ts.isExportDeclaration(st) && !st.exportClause && st.moduleSpecifier && ts.isStringLiteralLike(st.moduleSpecifier)) {
      const target = modules.resolve(rel, st.moduleSpecifier.text);
      const hit = target ? findExport(modules, target, name, depth + 1) : null;
      if (hit) return hit;
    }
  }
  return null;
}

/** Resolve an expression to a value node { mod, node } (identifiers and imports followed), or null. */
function resolveValue(modules, mod, expr, depth = 0) {
  const e = unwrap(expr);
  if (!e || depth > 12) return null;
  if (ts.isIdentifier(e)) {
    const b = findBinding(e.text, e);
    if (b?.kind === "var" && b.decl.initializer) return resolveValue(modules, mod, b.decl.initializer, depth + 1);
    if (b?.kind === "import") {
      const target = modules.resolve(mod.rel, b.spec);
      const hit = target ? findExport(modules, target, b.imported, 0) : null;
      return hit?.init ? resolveValue(modules, hit.mod, hit.init, depth + 1) : null;
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(e)) {
    const obj = resolveValue(modules, mod, e.expression, depth + 1);
    if (!obj || !ts.isObjectLiteralExpression(obj.node)) return null;
    for (const p of obj.node.properties) {
      const pname = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null;
      if (pname !== e.name.text) continue;
      if (ts.isPropertyAssignment(p)) return resolveValue(modules, obj.mod, p.initializer, depth + 1);
      if (ts.isShorthandPropertyAssignment(p)) return resolveValue(modules, obj.mod, p.name, depth + 1);
    }
    return null;
  }
  return { mod, node: e };
}

function resolveString(modules, mod, expr) {
  const v = resolveValue(modules, mod, expr);
  return v && ts.isStringLiteralLike(v.node) ? v.node.text : null;
}

function lineOf(mod, node) {
  return mod.sf.getLineAndCharacterOfPosition(node.getStart(mod.sf)).line + 1;
}

function propertyOf(obj, name) {
  for (const p of obj.properties) {
    const pname = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null;
    if (pname !== name) continue;
    if (ts.isPropertyAssignment(p)) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p)) return p.name;
  }
  return null;
}

/** The application's provider identities: the value of HOST_PROVIDER_PACKAGE in the host registration module. */
export function readHostProviderIdentities(repoRoot = REPO_ROOT) {
  const path = join(repoRoot, HOST_PROVIDER_MODULE);
  if (!existsSync(path)) throw new RoadScannerError(`${HOST_PROVIDER_MODULE} not found — cannot read the application's provider identity.`);
  const sf = ts.createSourceFile(HOST_PROVIDER_MODULE, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === "HOST_PROVIDER_PACKAGE" && d.initializer) {
        const init = unwrap(d.initializer);
        if (ts.isStringLiteralLike(init)) return [init.text];
      }
    }
  }
  throw new RoadScannerError(`${HOST_PROVIDER_MODULE} holds no HOST_PROVIDER_PACKAGE string constant.`);
}

/** The members of ARTIFACT_CREATING_ROADS in the SDK artifact contract, read from its source text; null when absent. */
export function readSdkCreatingRoads(repoRoot = REPO_ROOT) {
  const path = join(repoRoot, SDK_ROADS_MODULE);
  if (!existsSync(path)) return null;
  const sf = ts.createSourceFile(SDK_ROADS_MODULE, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || !st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== "ARTIFACT_CREATING_ROADS" || !d.initializer) continue;
      let init = unwrap(d.initializer);
      if (ts.isCallExpression(init) && init.arguments.length === 1) init = unwrap(init.arguments[0]);
      if (!ts.isArrayLiteralExpression(init)) {
        throw new RoadScannerError(`${SDK_ROADS_MODULE}: ARTIFACT_CREATING_ROADS is not a string-array literal.`);
      }
      return init.elements.map((el) => {
        const v = unwrap(el);
        if (!ts.isStringLiteralLike(v)) throw new RoadScannerError(`${SDK_ROADS_MODULE}: ARTIFACT_CREATING_ROADS holds a non-literal member.`);
        return v.text;
      });
    }
  }
  return null;
}

/** Builder names the writer witness exports (exported functions named build*). */
function witnessBuilders(modules) {
  const mod = modules.get(WITNESS_MODULE);
  if (!mod) throw new RoadScannerError(`${WITNESS_MODULE} not found — cannot read the artifact writer witness builders.`);
  const names = new Set();
  for (const st of mod.sf.statements) {
    const exported = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && ts.isFunctionDeclaration(st) && st.name && /^build/.test(st.name.text)) names.add(st.name.text);
  }
  if (names.size === 0) throw new RoadScannerError(`${WITNESS_MODULE} exports no builder.`);
  return names;
}

const REEXPORT_MEMO = new WeakMap();

/**
 * The witness builder that export `name` of module `rel` re-exports (following
 * named and star re-exports, and a local export of an imported binding), or null.
 */
function reexportedBuilder(modules, rel, name, builders, depth = 0) {
  if (!rel || depth > 8) return null;
  if (rel === WITNESS_MODULE) return builders.has(name) ? name : null;
  let memo = REEXPORT_MEMO.get(modules);
  if (!memo) REEXPORT_MEMO.set(modules, (memo = new Map()));
  const memoKey = `${rel}\u0000${name}`;
  if (memo.has(memoKey)) return memo.get(memoKey);
  memo.set(memoKey, null); // a re-export cycle reads as no builder
  const hit = reexportedBuilderUncached(modules, rel, name, builders, depth);
  memo.set(memoKey, hit);
  return hit;
}

function reexportedBuilderUncached(modules, rel, name, builders, depth) {
  const mod = modules.get(rel);
  if (!mod) return null;
  for (const st of mod.sf.statements) {
    if (!ts.isExportDeclaration(st) || st.isTypeOnly) continue;
    const from = st.moduleSpecifier && ts.isStringLiteralLike(st.moduleSpecifier) ? modules.resolve(rel, st.moduleSpecifier.text) : null;
    if (st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.name.text !== name) continue;
        const local = (el.propertyName ?? el.name).text;
        if (from) return reexportedBuilder(modules, from, local, builders, depth + 1);
        const b = findBinding(local, st);
        return b?.kind === "import" ? reexportedBuilder(modules, modules.resolve(rel, b.spec), b.imported, builders, depth + 1) : null;
      }
    } else if (!st.exportClause && from) {
      const hit = reexportedBuilder(modules, from, name, builders, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Is a module a creating module (calls a witness builder, or writes a claimed type id as `typeHint`)? */
function creatingForm(modules, rel, builders, vocabulary) {
  if (rel === WITNESS_MODULE) return null;
  const mod = modules.get(rel);
  if (!mod) return null;
  const hasTypeHint = mod.text.includes("typeHint");
  const localBuilders = new Set();
  const namespaces = new Set();
  for (const st of mod.sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause || !ts.isStringLiteralLike(st.moduleSpecifier)) continue;
    const target = modules.resolve(rel, st.moduleSpecifier.text);
    const nb = st.importClause.namedBindings;
    if (target === WITNESS_MODULE) {
      if (nb && ts.isNamespaceImport(nb)) namespaces.add(nb.name.text);
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) if (builders.has((el.propertyName ?? el.name).text)) localBuilders.add(el.name.text);
      }
    } else if (target && !st.importClause.isTypeOnly && nb && ts.isNamedImports(nb)) {
      // A builder re-exported through another module is still a builder.
      for (const el of nb.elements) {
        if (reexportedBuilder(modules, target, (el.propertyName ?? el.name).text, builders)) localBuilders.add(el.name.text);
      }
    }
  }
  if (!hasTypeHint && localBuilders.size === 0 && namespaces.size === 0) return null;
  let form = null;
  const visit = (node) => {
    if (form) return;
    if (ts.isCallExpression(node)) {
      const c = node.expression;
      if (ts.isIdentifier(c) && localBuilders.has(c.text)) form = "witness";
      if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && namespaces.has(c.expression.text) && builders.has(c.name.text)) {
        form = "witness";
      }
    }
    if (hasTypeHint && ts.isPropertyAssignment(node)) {
      const pname = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : null;
      const v = unwrap(node.initializer);
      if (pname === "typeHint" && ts.isStringLiteralLike(v) && isVocabularyId(v.text, vocabulary)) form = "typeHint";
    }
    ts.forEachChild(node, visit);
  };
  visit(mod.sf);
  return form;
}

/** Does `node`, or a same-module function it names, read a globalThis property? */
function readsGlobalSlot(mod, node) {
  const seen = new Set();
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    let found = false;
    const visit = (x) => {
      if (found) return;
      if ((ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) && ts.isIdentifier(unwrap(x.expression)) && unwrap(x.expression).text === "globalThis") {
        found = true;
        return;
      }
      if (ts.isIdentifier(x) && !(x.parent && ts.isPropertyAccessExpression(x.parent) && x.parent.name === x)) {
        const b = findBinding(x.text, x);
        if (b?.kind === "fn" && b.decl.body) stack.push(b.decl.body);
        if (b?.kind === "var" && b.decl.initializer) {
          const init = unwrap(b.decl.initializer);
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isObjectLiteralExpression(init)) stack.push(init);
        }
      }
      ts.forEachChild(x, visit);
    };
    visit(n);
    if (found) return true;
  }
  return false;
}

/** The module where an impl member expression is defined. */
function memberRoot(modules, mod, expr) {
  let e = unwrap(expr);
  while (e && (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e) || ts.isElementAccessExpression(e))) {
    e = unwrap(e.expression);
  }
  if (e && ts.isIdentifier(e)) {
    const b = findBinding(e.text, e);
    if (b?.kind === "import") return modules.resolve(mod.rel, b.spec);
  }
  return mod.rel;
}

/** The roots of an impl expression: the modules defining its members. */
function implRoots(modules, mod, implExpr) {
  const roots = new Set();
  let impl = unwrap(implExpr);
  if (impl && ts.isIdentifier(impl)) {
    const b = findBinding(impl.text, impl);
    if (b?.kind === "import") {
      const r = modules.resolve(mod.rel, b.spec);
      if (r) roots.add(r);
      return { roots, text: impl };
    }
    if (b?.kind === "var" && b.decl.initializer) impl = unwrap(b.decl.initializer);
  }
  if (impl && ts.isObjectLiteralExpression(impl)) {
    for (const p of impl.properties) {
      let r = null;
      if (ts.isPropertyAssignment(p)) r = memberRoot(modules, mod, p.initializer);
      else if (ts.isShorthandPropertyAssignment(p)) r = memberRoot(modules, mod, p.name);
      else if (ts.isSpreadAssignment(p)) r = memberRoot(modules, mod, p.expression);
      else r = mod.rel;
      if (r) roots.add(r);
    }
  } else if (impl) {
    const r = memberRoot(modules, mod, impl);
    if (r) roots.add(r);
  }
  return { roots, text: impl };
}

/** Local wrappers of registerCapabilityProvider in a module: name -> { idParam, implIndex, packageNameExpr }. */
function localWrappers(sf) {
  const wrappers = new Map();
  const consider = (name, fn) => {
    if (!fn.parameters?.length) return;
    const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));
    let hit = null;
    const visit = (n) => {
      if (hit) return;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === REGISTER_FN && n.arguments.length >= 2) {
        const first = unwrap(n.arguments[0]);
        const opts = unwrap(n.arguments[1]);
        if (ts.isIdentifier(first) && first.text === params[0] && ts.isObjectLiteralExpression(opts)) {
          const implExpr = propertyOf(opts, "impl");
          const implName = implExpr && ts.isIdentifier(unwrap(implExpr)) ? unwrap(implExpr).text : null;
          hit = { implIndex: implName ? params.indexOf(implName) : -1, packageNameExpr: propertyOf(opts, "packageName") };
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body ?? fn);
    if (hit) wrappers.set(name, hit);
  };
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name) consider(n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = unwrap(n.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) consider(n.name.text, init);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return wrappers;
}

/** Every capability the application publishes: Map<id, { file, line, roots:Set, readsSlot }>. */
function publishedCapabilities(modules, files, hostIdentities) {
  const published = new Map();
  for (const rel of files) {
    if (!rel.startsWith("src/") || isExemptFile(rel)) continue;
    const mod = modules.get(rel);
    if (!mod || !mod.text.includes(REGISTER_FN)) continue;
    const wrappers = localWrappers(mod.sf);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression.text;
        let idExpr = null;
        let implExpr = null;
        let pkgExpr = null;
        let pkgMod = mod;
        if (callee === REGISTER_FN && node.arguments.length >= 2) {
          // The wrapper's own inner call forwards its parameters; it is read at the wrapper's call sites.
          const first = unwrap(node.arguments[0]);
          const insideWrapper = ts.isIdentifier(first) && findBinding(first.text, first)?.kind === "param";
          if (!insideWrapper) {
            // The options: an inline object literal, or a constant bound to one. Anything else
            // cannot be read, and an unread registration is a scanner error, never a pass.
            const optsVal = resolveValue(modules, mod, node.arguments[1]);
            if (!optsVal || !ts.isObjectLiteralExpression(optsVal.node)) {
              throw new RoadScannerError(
                `${rel}:${lineOf(mod, node)}: cannot read the options of a ${REGISTER_FN} call (neither an object ` +
                  `literal nor a constant bound to one), so the gate cannot tell whether the application publishes it.`,
              );
            }
            idExpr = node.arguments[0];
            implExpr = propertyOf(optsVal.node, "impl");
            pkgExpr = propertyOf(optsVal.node, "packageName");
            pkgMod = optsVal.mod;
          }
        } else if (wrappers.has(callee) && node.arguments.length >= 1) {
          const w = wrappers.get(callee);
          idExpr = node.arguments[0];
          implExpr = w.implIndex >= 0 ? node.arguments[w.implIndex] ?? null : null;
          pkgExpr = w.packageNameExpr;
        }
        if (idExpr && pkgExpr) {
          const provider = resolveString(modules, pkgMod, pkgExpr);
          if (provider !== null && hostIdentities.includes(provider)) {
            const id = resolveString(modules, mod, idExpr);
            if (id === null) {
              throw new RoadScannerError(`${rel}:${lineOf(mod, node)}: cannot resolve the capability id the application publishes.`);
            }
            const { roots, text } = implExpr ? implRoots(modules, pkgMod, implExpr) : { roots: new Set([rel]), text: null };
            const entry = published.get(id) ?? { file: rel, line: lineOf(mod, node), roots: new Set(), readsSlot: false };
            for (const r of roots) entry.roots.add(r);
            if (text && readsGlobalSlot(mod, text)) entry.readsSlot = true;
            published.set(id, entry);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(mod.sf);
  }
  return new Map([...published.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Creating modules reached from `roots` within `maxEdges` value-import edges (barrels not traversed). */
function reach(modules, roots, maxEdges, isCreating) {
  const depth = new Map();
  const queue = [];
  for (const r of roots) {
    if (!depth.has(r)) {
      depth.set(r, 0);
      queue.push(r);
    }
  }
  const hits = new Set();
  while (queue.length) {
    const n = queue.shift();
    if (isCreating(n)) hits.add(n);
    if (BARREL_RE.test(n)) continue;
    const d = depth.get(n);
    if (d >= maxEdges) continue;
    for (const t of modules.edges(n)) {
      if (depth.has(t) || BARREL_RE.test(t)) continue;
      if (!(t.startsWith("src/") || /^packages\/[^/]+\/src\//.test(t)) || isExemptFile(t)) continue;
      depth.set(t, d + 1);
      queue.push(t);
    }
  }
  return [...hits].sort();
}

/**
 * Scan the application for class 6 roads. Options (injectable for tests):
 * `hostIdentities` (default: read from HOST_PROVIDER_PACKAGE), `vocabulary`
 * (default: derived from the materialized tree), `capabilities` (the declared
 * section, for its `entries`), `files`, `maxEdges`.
 * Returns { published: Map<id, info>, roads: {key: 1}, creatingModules, sdkRoads, sdkRoadsNote }.
 */
export function scanConnectorArtifactRoads(repoRoot = REPO_ROOT, options = {}) {
  const modules = new Modules(repoRoot);
  const hostIdentities = options.hostIdentities ?? readHostProviderIdentities(repoRoot);
  const vocabulary = options.vocabulary ?? loadClaimedTypeVocabulary(repoRoot);
  const capabilities = options.capabilities ?? {};
  const maxEdges = options.maxEdges ?? MAX_EDGES;
  const files = [...(options.files ?? listScanFiles(repoRoot))].sort();
  const builders = witnessBuilders(modules);
  const creatingCache = new Map();
  const isCreating = (rel) => {
    if (!creatingCache.has(rel)) creatingCache.set(rel, creatingForm(modules, rel, builders, vocabulary));
    return creatingCache.get(rel) !== null;
  };

  const published = publishedCapabilities(modules, files, hostIdentities);
  const roads = {};
  for (const [id, info] of published) {
    const entries = Array.isArray(capabilities[id]?.entries) ? capabilities[id].entries : [];
    for (const entry of entries) {
      if (!modules.isFile(entry)) throw new RoadScannerError(`${BASELINE_REL}: ${id} declares the entry ${entry}, which does not exist.`);
    }
    info.entries = entries;
    info.reached = reach(modules, [...info.roots, ...entries], maxEdges, isCreating);
    for (const m of info.reached) roads[`${id} :: ${m}`] = 1;
  }
  let handlerReached = [];
  if (modules.isFile(CONNECTOR_HANDLER_MODULE)) {
    handlerReached = reach(modules, [CONNECTOR_HANDLER_MODULE], maxEdges, isCreating);
    for (const m of handlerReached) roads[`${CONNECTOR_HANDLER_MODULE} :: ${m}`] = 1;
  }
  const sdkRoads = readSdkCreatingRoads(repoRoot);
  const creatingModules = [...creatingCache.entries()].filter(([, f]) => f !== null).map(([m]) => m).sort();
  return {
    published,
    roads: Object.fromEntries(Object.keys(roads).sort().map((k) => [k, 1])),
    creatingModules,
    handlerReached,
    hostIdentities,
    sdkRoads,
    sdkRoadsNote: sdkRoads === null ? "SDK roads list absent" : `SDK roads list present (${sdkRoads.length} member(s))`,
  };
}

/** The roads of a scan or a floor document as {key: 1}. */
export function roadCounts(scanOrDoc) {
  return Object.fromEntries(Object.keys(scanOrDoc?.roads ?? {}).map((k) => [k, 1]));
}

/** The declaration against the scan: missing, retired, disagreeing and slot-without-entries ids. */
export function declarationProblems(scan, capabilities = {}) {
  const problems = [];
  for (const [id, info] of scan.published) {
    const decl = capabilities[id];
    if (!decl) {
      problems.push(`${id} (${info.file}:${info.line}) is published but not declared in the capabilities section`);
      continue;
    }
    if (typeof decl.createsArtifact !== "boolean") {
      problems.push(`${id}: createsArtifact must be true or false (got ${JSON.stringify(decl.createsArtifact)})`);
    } else if (decl.createsArtifact !== info.reached.length > 0) {
      problems.push(
        `${id}: createsArtifact ${decl.createsArtifact} disagrees with the reach (${info.reached.length ? info.reached.join(", ") : "no creating module"})`,
      );
    }
    if (info.readsSlot && !(Array.isArray(decl.entries) && decl.entries.length > 0)) {
      problems.push(`${id} (${info.file}:${info.line}) reads a globalThis slot but declares no entries (the modules that bind it)`);
    }
  }
  for (const id of Object.keys(capabilities)) {
    if (!scan.published.has(id)) problems.push(`${id} is declared but no longer published`);
  }
  return problems.sort();
}

/** Every road whose removedBy is empty or UNASSIGNED. */
export function removedByProblems(doc) {
  const problems = [];
  for (const [key, entry] of Object.entries(doc?.roads ?? {})) {
    const by = typeof entry?.removedBy === "string" ? entry.removedBy.trim() : "";
    if (!by || by === UNASSIGNED) problems.push(`${key} names no item that removes it (${JSON.stringify(entry?.removedBy ?? null)})`);
  }
  return problems.sort();
}

/** Roads of `committedDoc` that are not on `baseDoc`'s floor. */
export function baseRoadGrowth(baseDoc, committedDoc) {
  return diffGrown(roadCounts(baseDoc), roadCounts(committedDoc));
}

/** The SDK roads list against the declaration: its members under the application's identity must equal the ids declared true. */
export function sdkRoadsProblems(sdkRoads, capabilities, hostIdentities) {
  if (sdkRoads === null || sdkRoads === undefined) return [];
  const prefixes = hostIdentities.map((h) => `${h}:`);
  const sdk = new Set(sdkRoads.filter((id) => prefixes.some((p) => id.startsWith(p))));
  const declared = new Set(Object.entries(capabilities ?? {}).filter(([, d]) => d?.createsArtifact === true).map(([id]) => id));
  const problems = [];
  for (const id of declared) if (!sdk.has(id)) problems.push(`${id} is declared createsArtifact true but ARTIFACT_CREATING_ROADS does not name it`);
  for (const id of sdk) if (!declared.has(id)) problems.push(`ARTIFACT_CREATING_ROADS names ${id}, which is not declared createsArtifact true`);
  return problems.sort();
}

function writeBaseline(committed, live) {
  const committedRoads = committed?.roads ? roadCounts(committed) : null;
  if (committedRoads) {
    const grown = diffGrown(committedRoads, roadCounts(live));
    if (grown.length) {
      console.error(`${TAG} FAIL — refusing to write a GROWN floor (shrink-only; remove the road instead):`);
      grown.forEach((g) => console.error(`  + ${g}`));
      process.exit(1);
    }
  }
  const capabilities = {};
  for (const [id, info] of live.published) {
    const prev = committed?.capabilities?.[id];
    capabilities[id] = {
      createsArtifact: typeof prev?.createsArtifact === "boolean" ? prev.createsArtifact : info.reached.length > 0,
      ...(Array.isArray(prev?.entries) && prev.entries.length ? { entries: prev.entries } : {}),
    };
  }
  const roads = {};
  for (const key of Object.keys(live.roads)) {
    const prev = committed?.roads?.[key]?.removedBy;
    roads[key] = { removedBy: typeof prev === "string" && prev ? prev : UNASSIGNED };
  }
  const doc = {
    note:
      "Connector artifact roads (cinatra#3821): a road from a module that faces connectors (the connector handler, a " +
      "capability the application publishes under its own provider identity) to a module that creates an artifact. " +
      "`capabilities` declares every published capability: createsArtifact, and the entries that bind a globalThis slot " +
      "its impl reads. `roads` is the floor; each road names the item that removes it. SHRINK-ONLY: regenerate with " +
      "`node scripts/audit/connector-artifact-road-gate.mjs --write-baseline` (it refuses growth). See " +
      "scripts/audit/extension-coupling-gates.md.",
    capabilities,
    roads,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(doc, null, 2) + "\n");
  return doc;
}

function summarize(live) {
  const trueIds = [...live.published.values()].filter((i) => i.reached.length > 0).length;
  return (
    `${Object.keys(live.roads).length} road(s) on the floor; ${live.published.size} published capabilit(ies) ` +
    `(${trueIds} reaching a creating module); ${live.creatingModules.length} creating module(s) seen; ` +
    `connector handler reaches ${live.handlerReached.length} creating module(s); bound ${MAX_EDGES} edges; ${live.sdkRoadsNote}`
  );
}

function main() {
  const args = process.argv.slice(2);
  const committed = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : null;
  const baseRef = process.env.CONNECTOR_ARTIFACT_ROAD_BASE;
  if (baseRef) {
    const problem = baseRefProblem(baseRef, REPO_ROOT, "CONNECTOR_ARTIFACT_ROAD_BASE");
    if (problem) {
      console.error(`${TAG} FAIL — ${problem}`);
      process.exit(1);
    }
  }
  let live;
  try {
    live = scanConnectorArtifactRoads(REPO_ROOT, { capabilities: committed?.capabilities ?? {} });
  } catch (err) {
    const known = err instanceof RoadScannerError || err instanceof ClaimedTypeVocabularyError;
    console.error(`${TAG} scanner error: ${known ? err.message : err?.stack ?? String(err)}`);
    process.exit(2);
  }

  if (args.includes("--write-baseline")) {
    const doc = writeBaseline(committed, live);
    console.log(`${TAG} floor written — ${summarize(live)}; ${removedByProblems(doc).length} road(s) without removedBy.`);
    return;
  }

  if (!committed) {
    console.error(`${TAG} FAIL — no floor at ${BASELINE_REL}. Run with --write-baseline first.`);
    process.exit(1);
  }

  if (baseRef) {
    let baseText = null;
    try {
      baseText = execFileSync("git", ["show", `${baseRef}:${BASELINE_REL}`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      baseText = null; // the reference resolves but holds no floor: the introducing change, no constraint
    }
    if (baseText) {
      const grew = baseRoadGrowth(JSON.parse(baseText), committed);
      if (grew.length) {
        console.error(`${TAG} FAIL — the committed floor GREW vs ${baseRef} (shrink-only; no regenerate can raise it):`);
        grew.forEach((g) => console.error(`  + ${g}`));
        process.exit(1);
      }
    }
  }

  let failed = false;
  const report = (title, lines, mark) => {
    if (!lines.length) return;
    failed = true;
    console.error(`${TAG} FAIL — ${title}:`);
    lines.forEach((l) => console.error(`  ${mark} ${l}`));
  };
  report(
    "NEW road(s) from a connector-facing module to a module that creates an artifact (a connector never makes the application create an artifact; the agent extension's flow creates it)",
    diffGrown(roadCounts(committed), roadCounts(live)),
    "+",
  );
  report(
    "STALE road(s) (the floor shrank — ratchet it down: node scripts/audit/connector-artifact-road-gate.mjs --write-baseline)",
    diffShrunk(roadCounts(committed), roadCounts(live)),
    "-",
  );
  report("the capabilities declaration disagrees with the published set or the reach", declarationProblems(live, committed.capabilities ?? {}), "-");
  report("road(s) without the item that removes them", removedByProblems(committed), "-");
  report(
    "ARTIFACT_CREATING_ROADS disagrees with the ids declared createsArtifact true",
    sdkRoadsProblems(live.sdkRoads, committed.capabilities ?? {}, live.hostIdentities),
    "-",
  );
  if (failed) {
    console.error("\nSee scripts/audit/extension-coupling-gates.md (cinatra#3821).");
    process.exit(1);
  }
  console.log(`${TAG} OK — ${summarize(live)}; 0 new, 0 stale (shrink-only floor — cinatra#3821; see scripts/audit/extension-coupling-gates.md).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
