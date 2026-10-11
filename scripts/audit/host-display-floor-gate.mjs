#!/usr/bin/env node
// Host display floor gate (cinatra#3821 — the border between the application
// and its extensions).
//
// THE RULE. An artifact extension declares the type and draws it from its
// content. The application keeps generic roads. Where the application still
// draws an artifact's content itself — for one content form (markdown, plain
// text, the download card) or for one type — that code is a FLOOR: it may
// shrink, it may never grow. The same holds for the host's own renderers
// registered for one agent's step.
//
// WHAT THIS GATE HOLDS (six sections of one committed baseline,
// scripts/audit/host-display-floor-gate.baseline.json):
//   handlerKinds       the CLOSED LIST of the host's own handler kinds: the
//                      string-literal members of `handler` on the dispatch
//                      member whose kind is "mime", and of `form` on the review
//                      mount member whose kind is "form". Both are read with the
//                      TypeScript type checker (see buildDispatchModel).
//   displays           the modules where the application draws an artifact's
//                      content itself (the derivation is in findHostDisplays).
//   stepRenderers      the kind-table entries whose renderer is a component of
//                      the host's own (not the never-blank schema floor).
//   ceilings           per module of `displays` and `stepRenderers`: its count
//                      of top-level value declarations and the sorted set of its
//                      value-import specifiers.
//   mimeConstructions  an object literal `kind: "mime"` outside the module that
//                      declares the dispatch type (a host display chosen outside
//                      the dispatch) — pinned empty.
//   hostMounts         an object literal `kind: "form"` with a first-party
//                      `arm` (the review's host form mount), per module.
//
// MECHANICS (the sibling gates' own, vendor-token-core-gate.mjs):
//   - a new key or a grown count is refused;
//   - a key whose count fell, or whose module is gone, is STALE and fails until
//     `--write-baseline` ratchets it down;
//   - `--write-baseline` refuses to write a grown floor and writes a new key
//     with owner `UNASSIGNED`; the check fails on an entry whose owner is empty
//     or `UNASSIGNED`;
//   - HOST_DISPLAY_FLOOR_BASE=<ref> fails closed on a flag-like or unresolvable
//     reference and refuses a committed floor that grew against the base; when
//     the base holds no baseline (the introducing change) it imposes nothing.
//
// It names no extension package in code and reads no extension tree: the type
// checker's compiler host refuses every file under `extensions/` and every
// third-party file under `node_modules/` (TypeScript's own lib files excepted).
//
// Exit 0 clean, 1 findings, 2 scanner error (a module the derivation needs is
// absent, a type it reads cannot be resolved, or a parse fails — never a pass).
//
// The document: scripts/audit/host-display-floor.md.
//
// Usage:
//   node scripts/audit/host-display-floor-gate.mjs                  # check (default)
//   node scripts/audit/host-display-floor-gate.mjs --write-baseline # ratchet the floor down
//   HOST_DISPLAY_FLOOR_BASE=<ref> node ...   # also fail if the committed floor GREW vs <ref>

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative, sep, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import tsDefault from "typescript";
import { PERMANENT_EXEMPT_FILES } from "./lib/extension-reference-classification.mjs";

const ts = tsDefault;
const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..");
export const BASELINE_REL = "scripts/audit/host-display-floor-gate.baseline.json";
export const DOC_REL = "scripts/audit/host-display-floor.md";
const TAG = "[host-display-floor-gate]";

// The places the derivation reads. Each is a repository path, never a package.
export const DISPATCH_MODULE = "src/app/artifacts/[id]/renderer-dispatch.ts";
export const DISPATCH_TYPE = "ArtifactRenderDispatch";
export const DISPATCH_INPUT_TYPE = "ArtifactRenderDispatchInput";
export const REVIEW_MODULE = "src/lib/artifacts/artifact-review-preparation.ts";
export const REVIEW_MOUNT_TYPE = "ReviewTargetMount";
export const HANDLERS_DIR = "src/app/artifacts/[id]/handlers/";
export const KIND_TABLE_MODULE = "packages/agents/src/register-default-renderers.ts";
export const KIND_TABLE_FUNCTION = "knownFieldRendererKinds";
/** The never-blank schema floor's module (repository path without extension). */
export const SCHEMA_FLOOR_MODULE = "packages/agents/src/schema-field-renderer";
/** The dispatch members that are an extension's display; every other member is the host's. */
export const EXTENSION_MEMBER_KINDS = Object.freeze(["semantic", "representation"]);
/** The discriminant properties a host branch switches on. */
const BRANCH_DISCRIMINANTS = new Set(["kind", "handler", "form"]);
/** The single pattern class 8 drives when no host MIME comparison is left to read. */
export const DEFAULT_REPRESENTATION_PATTERN = "text/markdown";

export const SECTIONS = Object.freeze([
  "handlerKinds",
  "displays",
  "stepRenderers",
  "ceilings",
  "mimeConstructions",
  "hostMounts",
]);
export const UNASSIGNED = "UNASSIGNED";

/** A derivation that cannot complete. The CLI exits 2 on it — never a pass. */
export class ScannerError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScannerError";
  }
}

// ---------------------------------------------------------------------------
// The tree: `src/` and every `packages/*/src`, exemptions applied.
// ---------------------------------------------------------------------------

const CODE_FILE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const EXTENSION_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Tests, specs, `__tests__`, `__fixtures__`, stories, `.d.ts`, the
 * generator-emitted files and the design fixtures are out of scope. */
export function isExemptFile(rel) {
  return (
    PERMANENT_EXEMPT_FILES.has(rel) ||
    /\.(?:test|spec)\.[mc]?[tj]sx?$/.test(rel) ||
    /(^|\/)(?:__tests__|__fixtures__)(\/|$)/.test(rel) ||
    /\.stories\.[mc]?[tj]sx?$/.test(rel) ||
    /\.d\.[mc]?ts$/.test(rel) ||
    rel.startsWith("src/app/design-fixtures/")
  );
}

function toRel(root, abs) {
  return relative(root, abs).split(sep).join("/");
}

/** Every in-scope code file under `src/` and `packages/*\/src`, sorted, repository-relative. */
export function listTreeFiles(root = REPO_ROOT) {
  const roots = [];
  if (existsSync(join(root, "src"))) roots.push("src");
  const pkgs = join(root, "packages");
  if (existsSync(pkgs)) {
    for (const pkg of readdirSync(pkgs).sort()) {
      const rel = `packages/${pkg}/src`;
      const abs = join(root, rel);
      if (existsSync(abs) && statSync(abs).isDirectory()) roots.push(rel);
    }
  }
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && CODE_FILE_RE.test(entry.name) && !isExemptFile(child)) out.push(child);
    }
  };
  for (const r of roots) walk(r);
  return out.sort();
}

function scriptKindOf(rel) {
  if (/\.tsx$/.test(rel)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(rel)) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(rel)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Parse one module; a parse error is a scanner error, never a pass. */
export function parseModule(root, rel) {
  const text = readFileSync(join(root, rel), "utf8");
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKindOf(rel));
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length > 0) {
    const d = diags[0];
    const { line } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
    throw new ScannerError(
      `${rel}:${line + 1} does not parse (${ts.flattenDiagnosticMessageText(d.messageText, " ")})`,
    );
  }
  return sf;
}

// ---------------------------------------------------------------------------
// Compiler options and module resolution (the repository's own tsconfig.json).
// ---------------------------------------------------------------------------

export function readCompilerOptions(root = REPO_ROOT) {
  const path = join(root, "tsconfig.json");
  if (!existsSync(path)) throw new ScannerError("tsconfig.json is absent at the repository root");
  const read = ts.readConfigFile(path, ts.sys.readFile);
  if (read.error) {
    throw new ScannerError(
      `tsconfig.json cannot be read (${ts.flattenDiagnosticMessageText(read.error.messageText, " ")})`,
    );
  }
  // Only the compiler options are wanted: the file list is left empty so the
  // parse does not enumerate the whole repository.
  const config = { ...read.config, files: [], include: [] };
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root, undefined, path);
  return {
    ...parsed.options,
    noEmit: true,
    skipLibCheck: true,
    incremental: false,
    composite: false,
    tsBuildInfoFile: undefined,
    declaration: false,
    plugins: undefined,
  };
}

function libDirOf(options) {
  return dirname(ts.getDefaultLibFilePath(options));
}

/** The files the checker may read: the repository's own code (never `extensions/`,
 * never a third-party `node_modules` file) and TypeScript's lib files. */
function makeReadGuard(root, options) {
  const libDir = libDirOf(options);
  const memo = new Map();
  return (path) => {
    if (memo.has(path)) return memo.get(path);
    let real = path;
    try {
      real = realpathSync(path);
    } catch {
      real = path;
    }
    let ok;
    if (real.startsWith(libDir + sep) || real.startsWith(libDir + "/")) ok = true;
    else {
      const rel = toRel(root, real);
      ok =
        !rel.startsWith("..") &&
        !rel.startsWith("/") &&
        !rel.startsWith("extensions/") &&
        !/(^|\/)node_modules(\/|$)/.test(rel);
    }
    memo.set(path, ok);
    return ok;
  };
}

function makeGuardedHost(root, options) {
  const host = ts.createCompilerHost(options, true);
  const allowed = makeReadGuard(root, options);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (p) => allowed(p) && fileExists(p);
  host.readFile = (p) => (allowed(p) ? readFile(p) : undefined);
  host.getSourceFile = (p, ...rest) => (allowed(p) ? getSourceFile(p, ...rest) : undefined);
  return host;
}

/** Resolve an import specifier of `fromRel` to a repository path of the tree, or null
 * (a third-party package, an extension, or nothing). */
export function makeResolver(root = REPO_ROOT, options = readCompilerOptions(root)) {
  const host = makeGuardedHost(root, options);
  const cache = ts.createModuleResolutionCache(root, (x) => x, options);
  const memo = new Map();
  return (fromRel, spec) => {
    const key = `${dirname(fromRel)}\0${spec}`;
    if (memo.has(key)) return memo.get(key);
    let out = null;
    const r = ts.resolveModuleName(spec, join(root, fromRel), options, host, cache).resolvedModule;
    if (r && r.resolvedFileName) {
      let real = r.resolvedFileName;
      try {
        real = realpathSync(real);
      } catch {
        /* keep */
      }
      const rel = toRel(root, real);
      if (!rel.startsWith("..") && !rel.startsWith("extensions/") && !/(^|\/)node_modules\//.test(rel)) out = rel;
    }
    memo.set(key, out);
    return out;
  };
}

// ---------------------------------------------------------------------------
// Imports of one module (syntactic).
// ---------------------------------------------------------------------------

function stringLiteralText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * Every import edge of a module: { spec, value, bindings: [{ local, imported, value }] }.
 * `value` is false for `import type`, `export type` and an import whose named
 * bindings are all type-only.
 */
export function importEdgesOf(sf) {
  const edges = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const spec = stringLiteralText(st.moduleSpecifier);
      if (spec === null) continue;
      const clause = st.importClause;
      if (!clause) {
        edges.push({ spec, value: true, bindings: [] });
        continue;
      }
      const clauseType = !!clause.isTypeOnly;
      const bindings = [];
      if (clause.name) bindings.push({ local: clause.name.text, imported: "default", value: !clauseType });
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bindings.push({ local: nb.name.text, imported: "*", value: !clauseType });
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          bindings.push({
            local: el.name.text,
            imported: (el.propertyName ?? el.name).text,
            value: !clauseType && !el.isTypeOnly,
          });
        }
      }
      const value = !clauseType && (bindings.length === 0 || bindings.some((b) => b.value));
      edges.push({ spec, value, bindings });
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      const spec = stringLiteralText(st.moduleSpecifier);
      if (spec === null) continue;
      const typeOnly = !!st.isTypeOnly;
      let value = !typeOnly;
      if (value && st.exportClause && ts.isNamedExports(st.exportClause) && st.exportClause.elements.length > 0) {
        value = st.exportClause.elements.some((el) => !el.isTypeOnly);
      }
      edges.push({ spec, value, bindings: [] });
    } else if (
      ts.isImportEqualsDeclaration(st) &&
      ts.isExternalModuleReference(st.moduleReference)
    ) {
      const spec = stringLiteralText(st.moduleReference.expression);
      if (spec !== null) {
        edges.push({ spec, value: !st.isTypeOnly, bindings: [{ local: st.name.text, imported: "=", value: !st.isTypeOnly }] });
      }
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const spec = stringLiteralText(node.arguments[0]);
      if (spec !== null) edges.push({ spec, value: true, bindings: [], dynamic: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return edges;
}

/** A relative or `@/` specifier as its repository path without extension; a package specifier as written. */
export function normalizeSpecifier(fromRel, spec) {
  let out = spec;
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    out = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  } else if (spec.startsWith("@/")) {
    out = `src/${spec.slice(2)}`;
  } else {
    return spec;
  }
  return out.replace(EXTENSION_RE, "");
}

/** Class 7 (b), the two measures of one module. */
export function measureCeiling(sf) {
  let topLevel = 0;
  const isAmbient = (st) => (ts.getModifiers?.(st) ?? st.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
  for (const st of sf.statements) {
    if (isAmbient(st)) continue;
    if (ts.isFunctionDeclaration(st)) {
      if (st.body) topLevel += 1;
    } else if (ts.isClassDeclaration(st)) {
      topLevel += 1;
    } else if (ts.isVariableStatement(st)) {
      topLevel += st.declarationList.declarations.length;
    }
  }
  const imports = new Set();
  for (const e of importEdgesOf(sf)) if (e.value) imports.add(normalizeSpecifier(sf.fileName, e.spec));
  return { topLevel, imports: [...imports].sort() };
}

// ---------------------------------------------------------------------------
// The dispatch model (TypeScript type checker).
// ---------------------------------------------------------------------------

function findTypeAlias(sf, name) {
  for (const st of sf.statements) if (ts.isTypeAliasDeclaration(st) && st.name.text === name) return st;
  return null;
}

function literalStrings(checker, type) {
  const members = type.isUnion() ? type.types : [type];
  const out = [];
  for (const t of members) if (t.isStringLiteral()) out.push(t.value);
  return out;
}

function membersOf(type) {
  return type.isUnion() ? type.types : [type];
}

function propertyStrings(checker, member, name) {
  const prop = checker.getPropertyOfType(member, name);
  if (!prop) return null;
  return literalStrings(checker, checker.getTypeOfSymbol(prop));
}

/** The MIME literals the host's own `pickHandler` compares, read from the module
 * that declares the handler kind union; the single default pattern when none is left. */
function hostMimePatterns(checker, handlerProp) {
  const decl = handlerProp?.valueDeclaration;
  const found = new Set();
  if (decl && decl.type) {
    const files = new Set();
    const visit = (node) => {
      if (ts.isTypeReferenceNode(node)) {
        let sym = checker.getSymbolAtLocation(node.typeName);
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
        for (const d of sym?.declarations ?? []) files.add(d.getSourceFile());
      }
      ts.forEachChild(node, visit);
    };
    visit(decl.type);
    for (const sf of files) {
      for (const st of sf.statements) {
        if (!ts.isFunctionDeclaration(st) || st.name?.text !== "pickHandler" || !st.body) continue;
        const walk = (node) => {
          if (
            ts.isBinaryExpression(node) &&
            (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
              node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
          ) {
            for (const side of [node.left, node.right]) {
              const s = stringLiteralText(side);
              if (s !== null && /^[a-z]+\/[a-z0-9.+-]+$/i.test(s)) found.add(s);
            }
          }
          ts.forEachChild(node, walk);
        };
        walk(st.body);
      }
    }
  }
  return found.size > 0 ? [...found] : [DEFAULT_REPRESENTATION_PATTERN];
}

/**
 * THE DISPATCH MODEL — the one derivation the gate's CLI and both test files
 * call. A program rooted at the dispatch module and the review preparation
 * module (plus `extraRoots`, e.g. the dispatch consumers for class 8), compiler
 * options from the repository's tsconfig.json, noEmit, skipLibCheck.
 */
export function buildDispatchModel(root = REPO_ROOT, { options, extraRoots = [] } = {}) {
  for (const m of [DISPATCH_MODULE, REVIEW_MODULE]) {
    if (!existsSync(join(root, m))) throw new ScannerError(`${m} is absent (the dispatch model reads it)`);
  }
  const opts = options ?? readCompilerOptions(root);
  const rootNames = [DISPATCH_MODULE, REVIEW_MODULE, ...extraRoots].map((r) => join(root, r));
  const program = ts.createProgram({ rootNames, options: opts, host: makeGuardedHost(root, opts) });
  const checker = program.getTypeChecker();
  const sourceOf = (rel) => {
    const sf = program.getSourceFile(join(root, rel));
    if (!sf) throw new ScannerError(`${rel} could not be loaded by the type checker`);
    const diags = program.getSyntacticDiagnostics(sf);
    if (diags.length > 0) {
      const { line } = sf.getLineAndCharacterOfPosition(diags[0].start ?? 0);
      throw new ScannerError(
        `${rel}:${line + 1} does not parse (${ts.flattenDiagnosticMessageText(diags[0].messageText, " ")})`,
      );
    }
    return sf;
  };
  const dispatchSf = sourceOf(DISPATCH_MODULE);
  const reviewSf = sourceOf(REVIEW_MODULE);

  const alias = findTypeAlias(dispatchSf, DISPATCH_TYPE);
  if (!alias) throw new ScannerError(`type ${DISPATCH_TYPE} is not declared in ${DISPATCH_MODULE}`);
  const dispatchSymbol = checker.getSymbolAtLocation(alias.name);
  if (!dispatchSymbol) throw new ScannerError(`type ${DISPATCH_TYPE} cannot be resolved`);
  const dispatchType = checker.getDeclaredTypeOfSymbol(dispatchSymbol);

  const memberKinds = [];
  let mimeMember = null;
  for (const member of membersOf(dispatchType)) {
    const kinds = propertyStrings(checker, member, "kind");
    if (!kinds || kinds.length !== 1) {
      throw new ScannerError(`a member of ${DISPATCH_TYPE} has no single string-literal kind`);
    }
    memberKinds.push(kinds[0]);
    if (kinds[0] === "mime") mimeMember = member;
  }
  const hostMemberKinds = memberKinds.filter((k) => !EXTENSION_MEMBER_KINDS.includes(k)).sort();

  let handlerKinds = [];
  let representationPatterns = [DEFAULT_REPRESENTATION_PATTERN];
  if (mimeMember) {
    const handlerProp = checker.getPropertyOfType(mimeMember, "handler");
    if (!handlerProp) throw new ScannerError(`the "mime" member of ${DISPATCH_TYPE} has no handler property`);
    handlerKinds = literalStrings(checker, checker.getTypeOfSymbol(handlerProp)).sort();
    if (handlerKinds.length === 0) {
      throw new ScannerError(`the handler of the "mime" member of ${DISPATCH_TYPE} is not a string-literal union`);
    }
    representationPatterns = hostMimePatterns(checker, handlerProp);
  }

  const mountAlias = findTypeAlias(reviewSf, REVIEW_MOUNT_TYPE);
  if (!mountAlias) throw new ScannerError(`type ${REVIEW_MOUNT_TYPE} is not declared in ${REVIEW_MODULE}`);
  const mountSymbol = checker.getSymbolAtLocation(mountAlias.name);
  if (!mountSymbol) throw new ScannerError(`type ${REVIEW_MOUNT_TYPE} cannot be resolved`);
  const mountType = checker.getDeclaredTypeOfSymbol(mountSymbol);
  let reviewForms = [];
  for (const member of membersOf(mountType)) {
    const kinds = propertyStrings(checker, member, "kind");
    if (!kinds || kinds.length !== 1) {
      throw new ScannerError(`a member of ${REVIEW_MOUNT_TYPE} has no single string-literal kind`);
    }
    if (kinds[0] !== "form") continue;
    const forms = propertyStrings(checker, member, "form");
    if (!forms || forms.length === 0) {
      throw new ScannerError(`the "form" member of ${REVIEW_MOUNT_TYPE} has no string-literal form`);
    }
    reviewForms = forms.sort();
  }

  return {
    root,
    options: opts,
    program,
    checker,
    dispatchSourceFile: dispatchSf,
    dispatchSymbol,
    dispatchType,
    memberKinds: memberKinds.slice().sort(),
    hostMemberKinds,
    handlerKinds,
    reviewForms,
    representationPatterns: representationPatterns.sort(),
  };
}

function isDispatchType(model, type) {
  if (!type) return false;
  const t = model.checker.getAwaitedType(type) ?? type;
  return t === model.dispatchType || (t.aliasSymbol !== undefined && t.aliasSymbol === model.dispatchSymbol);
}

/** A finite union of literal types (string, number, boolean literals, null, undefined) → its members; else null. */
export function literalDomain(type) {
  const members = type.isUnion() ? type.types : [type];
  const out = [];
  for (const t of members) {
    if (t.isStringLiteral() || t.isNumberLiteral()) out.push(t.value);
    else if (t.flags & ts.TypeFlags.BooleanLiteral) out.push(t.intrinsicName === "true");
    else if (t.flags & ts.TypeFlags.Null) out.push(null);
    else if (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) out.push(undefined);
    else return null;
  }
  return out;
}

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  const p = node.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  const { line } = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
  return `<anonymous at line ${line + 1}>`;
}

/**
 * CLASS 8, THE ENUMERATION: every function exported by the module that declares
 * the dispatch type whose return type (a Promise unwrapped) is the dispatch type,
 * with the domain of every parameter after the first. Problems (strings) name a
 * first parameter not declared as the dispatch input, a parameter that is not a
 * finite union of literal types, and — in every dispatch consumer given — a
 * function with that return type that is not an export of the declaring module
 * and does not only return a call of an enumerated function (a caller that
 * delegates is covered through the function it calls).
 * The model must have been built with the consumers among its roots.
 */
export function enumerateDispatchFunctions(model, consumers = []) {
  const { checker, dispatchSourceFile } = model;
  const functions = [];
  const problems = [];
  const moduleSymbol = checker.getSymbolAtLocation(dispatchSourceFile);
  const exported = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
  for (let sym of exported) {
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!decl) continue;
    const type = checker.getTypeOfSymbolAtLocation(sym, decl);
    const sigs = type.getCallSignatures();
    const sig = sigs.find((s) => isDispatchType(model, checker.getReturnTypeOfSignature(s)));
    if (!sig) continue;
    const name = sym.getName();
    if (sigs.length > 1) {
      // Overloads: one signature's parameters are not the domain of the others.
      problems.push(
        `${DISPATCH_MODULE} :: ${name}: it declares ${sigs.length} call signatures, so the test cannot enumerate it`,
      );
    }
    const params = sig.getParameters();
    const domains = [];
    const paramNames = params.map((p) => p.getName());
    if (params.length === 0) {
      problems.push(`${DISPATCH_MODULE} :: ${name}: it takes no ${DISPATCH_INPUT_TYPE}`);
    }
    params.forEach((p, i) => {
      const pdecl = p.valueDeclaration ?? p.declarations?.[0];
      const ptype = checker.getTypeOfSymbolAtLocation(p, pdecl);
      if (i === 0) {
        const nm = (ptype.aliasSymbol ?? ptype.symbol)?.getName();
        if (nm !== DISPATCH_INPUT_TYPE) {
          problems.push(
            `${DISPATCH_MODULE} :: ${name}: its first parameter "${p.getName()}" is not declared with the type ${DISPATCH_INPUT_TYPE}`,
          );
        }
        return;
      }
      const dom = literalDomain(ptype);
      if (dom === null) {
        problems.push(
          `${DISPATCH_MODULE} :: ${name}: the parameter "${p.getName()}" (${checker.typeToString(ptype)}) is not a finite union of literal types, so the test cannot enumerate it`,
        );
        domains.push([]);
      } else domains.push(dom);
    });
    functions.push({ name, module: DISPATCH_MODULE, paramNames, domains });
  }

  // A consumer function whose every return is a call of an enumerated function
  // DELEGATES to it (the enumerated function chooses, and is driven here); a
  // consumer function that returns anything else chooses a dispatch itself.
  const enumerated = new Set();
  for (let sym of exported) {
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    if (functions.some((f) => f.name === sym.getName())) enumerated.add(sym);
  }
  const delegates = (expr) => {
    let e = expr;
    while (
      e &&
      (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))
    ) {
      e = e.expression;
    }
    if (!e) return false;
    if (ts.isConditionalExpression(e)) return delegates(e.whenTrue) && delegates(e.whenFalse);
    if (!ts.isCallExpression(e)) return false;
    let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return !!sym && enumerated.has(sym);
  };
  const returnsOf = (fn) => {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const out = [];
    const walk = (node) => {
      if (node !== fn.body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) out.push(node.expression);
      ts.forEachChild(node, walk);
    };
    walk(fn.body);
    return out;
  };

  for (const rel of consumers) {
    if (rel === DISPATCH_MODULE) continue;
    const sf = model.program.getSourceFile(join(model.root, rel));
    if (!sf) throw new ScannerError(`${rel} could not be loaded by the type checker`);
    const visit = (node) => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)
      ) {
        const sig = checker.getSignatureFromDeclaration(node);
        if (
          sig &&
          isDispatchType(model, checker.getReturnTypeOfSignature(sig)) &&
          !returnsOf(node).every((r) => delegates(r))
        ) {
          problems.push(
            `${rel} :: ${functionName(node)}: a dispatch function outside the dispatch module: cover it here or move it`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  functions.sort((a, b) => a.name.localeCompare(b.name));
  return { functions, problems: problems.sort() };
}

// ---------------------------------------------------------------------------
// Dispatch consumers and host displays (class 7 (a)).
// ---------------------------------------------------------------------------

function basenameNoExt(rel) {
  return posix.basename(rel).replace(EXTENSION_RE, "");
}

/** Could `text` hold an import of `rel`? A cheap filter before resolution. */
function mayImport(text, rel) {
  const base = basenameNoExt(rel);
  if (base === "index") return text.includes(posix.basename(posix.dirname(rel)));
  return text.includes(base);
}

/**
 * The DISPATCH CONSUMERS: a module that imports a value or a type from the
 * dispatch module, or the type `ReviewTargetMount` from the review preparation module.
 */
export function findDispatchConsumers(root, files, resolve, cache) {
  const out = [];
  for (const rel of files) {
    if (rel === DISPATCH_MODULE) continue;
    const text = cache.text(rel);
    if (!mayImport(text, DISPATCH_MODULE) && !(mayImport(text, REVIEW_MODULE) && text.includes(REVIEW_MOUNT_TYPE))) {
      continue;
    }
    const sf = cache.sf(rel);
    for (const e of importEdgesOf(sf)) {
      const target = resolve(rel, e.spec);
      if (target === DISPATCH_MODULE || (target === REVIEW_MODULE && e.bindings.some((b) => b.imported === REVIEW_MOUNT_TYPE))) {
        out.push(rel);
        break;
      }
    }
  }
  return out.sort();
}

function isObjectTypeGuard(expr) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return;
    if (ts.isCallExpression(node)) {
      for (const a of node.arguments) {
        if (ts.isPropertyAccessExpression(a) && a.name.text === "objectType") found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return found;
}

function discriminantName(expr) {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isPropertyAccessExpression(e) && BRANCH_DISCRIMINANTS.has(e.name.text)) return e.name.text;
  return null;
}

/** The dispatch branches of one module: [{ host, nodes }] — each a list of statements. */
function branchesOf(sf, hostLabels) {
  const branches = [];
  const visit = (node) => {
    if (ts.isSwitchStatement(node) && discriminantName(node.expression)) {
      const clauses = node.caseBlock.clauses;
      clauses.forEach((clause, i) => {
        if (!ts.isCaseClause(clause)) return;
        const label = stringLiteralText(clause.expression);
        const nodes = [];
        for (let j = i; j < clauses.length; j += 1) {
          nodes.push(...clauses[j].statements);
          if (clauses[j].statements.length > 0) break; // an empty clause falls through
        }
        branches.push({ host: label !== null && hostLabels.has(label), nodes });
      });
    } else if (ts.isIfStatement(node) && isObjectTypeGuard(node.expression)) {
      branches.push({ host: true, nodes: [node.thenStatement] });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return branches;
}

function jsxTagIdentifier(tag) {
  let t = tag;
  while (ts.isPropertyAccessExpression(t)) t = t.expression;
  return ts.isIdentifier(t) ? t.text : null;
}

/** JSX tag names (the leftmost identifier) and identifier references inside `nodes`. */
function collectRefs(nodes) {
  const tags = new Set();
  const ids = new Set();
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const n = jsxTagIdentifier(node.tagName);
      if (n) tags.add(n);
    } else if (ts.isIdentifier(node)) {
      ids.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  for (const n of nodes) visit(n);
  return { tags, ids };
}

/** Same-module `const` declarations initialized with JSX and same-module function components. */
function localDefinitions(sf) {
  const jsxConsts = new Map();
  const components = new Map();
  const unwrap = (e) => {
    let x = e;
    while (x && (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression?.(x))) x = x.expression;
    return x;
  };
  const isJsx = (e) => e && (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e));
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (isJsx(init)) jsxConsts.set(node.name.text, init);
      else if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && /^[A-Z]/.test(node.name.text)) {
        components.set(node.name.text, init);
      }
    } else if (ts.isFunctionDeclaration(node) && node.name && node.body && /^[A-Z]/.test(node.name.text)) {
      components.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { jsxConsts, components };
}

/**
 * The components one consumer mounts: inside a HOST branch (`host`), and outside
 * every dispatch branch (`chrome`), each as a set of local names — directly, or
 * through a same-module `const` initialized with that JSX or a same-module
 * function component the site mounts, one level deep.
 */
function consumerMounts(sf, hostLabels) {
  const branches = branchesOf(sf, hostLabels);
  const { jsxConsts, components } = localDefinitions(sf);
  const expand = (refs) => {
    const tags = new Set(refs.tags);
    for (const id of refs.ids) {
      const init = jsxConsts.get(id);
      if (init) for (const t of collectRefs([init]).tags) tags.add(t);
    }
    for (const t of [...refs.tags]) {
      const comp = components.get(t);
      if (comp) for (const inner of collectRefs([comp.body ?? comp]).tags) tags.add(inner);
    }
    return tags;
  };
  const host = new Set();
  const inBranch = new Set();
  for (const b of branches) {
    for (const n of b.nodes) inBranch.add(n);
    if (!b.host) continue;
    for (const t of expand(collectRefs(b.nodes))) host.add(t);
  }
  // Chrome: a JSX site in no branch, not inside a JSX const initializer, and not
  // inside a same-module function component a branch mounts.
  const reachedComponents = new Set();
  for (const b of branches) for (const t of collectRefs(b.nodes).tags) if (components.has(t)) reachedComponents.add(components.get(t));
  const skip = new Set([...inBranch, ...jsxConsts.values(), ...reachedComponents]);
  const chrome = new Set();
  const visit = (node) => {
    if (skip.has(node)) return;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const n = jsxTagIdentifier(node.tagName);
      if (n) chrome.add(n);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { host, chrome };
}

/**
 * CLASS 7 (a), THE FLOOR SET. A module M under `src/` or a `packages/*\/src`
 * (not exempt) is a HOST DISPLAY when
 *   (d1) M lies under the host handlers directory; or
 *   (d2) a dispatch consumer mounts a JSX component imported from M inside a
 *        HOST BRANCH — a `case` of a switch on a property `kind`, `handler` or
 *        `form` labelled with a host member's kind, a handler kind or a review
 *        form, or the then-block of an `if` whose condition calls a function
 *        with an argument that is a property access named `objectType` —
 *        directly, through a same-module `const` initialized with that JSX, or
 *        through a same-module function component the branch mounts (one level
 *        deep); AND no module other than the dispatch consumers and the modules
 *        under the handlers directory imports M; AND no dispatch consumer also
 *        mounts M's component outside every dispatch branch (the page's chrome).
 */
export function findHostDisplays(root, files, model, resolve, cache) {
  const fileSet = new Set(files);
  const consumers = findDispatchConsumers(root, files, resolve, cache);
  const hostLabels = new Set([...model.hostMemberKinds, ...model.handlerKinds, ...model.reviewForms]);
  const d1 = files.filter((f) => f.startsWith(HANDLERS_DIR));
  const candidates = new Set();
  const chromeModules = new Set();
  for (const rel of consumers) {
    const sf = cache.sf(rel);
    const bindings = new Map();
    for (const e of importEdgesOf(sf)) {
      for (const b of e.bindings) if (b.value) bindings.set(b.local, e.spec);
    }
    const { host, chrome } = consumerMounts(sf, hostLabels);
    const toModule = (local) => {
      const spec = bindings.get(local);
      if (spec === undefined) return null;
      const target = resolve(rel, spec);
      if (target === null && (spec.startsWith(".") || spec.startsWith("@/"))) {
        // A mounted component whose module is gone is a scanner error, never a pass.
        throw new ScannerError(`${rel}: the module "${spec}" of the mounted component ${local} cannot be resolved`);
      }
      return target && fileSet.has(target) ? target : null;
    };
    for (const t of host) {
      const m = toModule(t);
      if (m) candidates.add(m);
    }
    for (const t of chrome) {
      const m = toModule(t);
      if (m) chromeModules.add(m);
    }
  }
  const allowedImporters = new Set([...consumers, ...d1]);
  const d2 = [];
  for (const m of [...candidates].sort()) {
    if (m.startsWith(HANDLERS_DIR)) {
      d2.push(m);
      continue;
    }
    if (chromeModules.has(m)) continue;
    let sharedElsewhere = false;
    for (const rel of files) {
      if (rel === m || allowedImporters.has(rel)) continue;
      if (!mayImport(cache.text(rel), m)) continue;
      if (importEdgesOf(cache.sf(rel)).some((e) => resolve(rel, e.spec) === m)) {
        sharedElsewhere = true;
        break;
      }
    }
    if (!sharedElsewhere) d2.push(m);
  }
  return { consumers, displays: [...new Set([...d1, ...d2])].sort() };
}

// ---------------------------------------------------------------------------
// Class 7, the host's renderers for one step.
// ---------------------------------------------------------------------------

function unwrapExpression(e) {
  let x = e;
  while (
    x &&
    (ts.isParenthesizedExpression(x) ||
      ts.isAsExpression(x) ||
      ts.isTypeAssertionExpression?.(x) ||
      ts.isSatisfiesExpression?.(x))
  ) {
    x = x.expression;
  }
  return x;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return null;
}

/** Every kind-table entry whose renderer is a component of the host's own: { key, module }. */
export function findStepRenderers(root, resolve, cache) {
  if (!existsSync(join(root, KIND_TABLE_MODULE))) {
    throw new ScannerError(`${KIND_TABLE_MODULE} is absent (the step renderer derivation reads it)`);
  }
  const sf = cache.sf(KIND_TABLE_MODULE);
  let fnBody = null;
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === KIND_TABLE_FUNCTION) fnBody = st.body;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === KIND_TABLE_FUNCTION && d.initializer) fnBody = d.initializer;
      }
    }
  }
  if (!fnBody) throw new ScannerError(`${KIND_TABLE_MODULE} declares no ${KIND_TABLE_FUNCTION}()`);
  let tableName = null;
  const findKeys = (node) => {
    if (tableName) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.expression.name.text === "keys" &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.arguments[0])
    ) {
      tableName = node.arguments[0].text;
      return;
    }
    ts.forEachChild(node, findKeys);
  };
  findKeys(fnBody);
  if (!tableName) throw new ScannerError(`${KIND_TABLE_FUNCTION}() in ${KIND_TABLE_MODULE} returns no Object.keys(<table>)`);
  let table = null;
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === tableName && d.initializer) {
        const init = unwrapExpression(d.initializer);
        if (ts.isObjectLiteralExpression(init)) table = init;
      }
    }
  }
  if (!table) throw new ScannerError(`${KIND_TABLE_MODULE} declares no object literal ${tableName}`);
  const imports = new Map();
  for (const e of importEdgesOf(sf)) for (const b of e.bindings) if (b.value) imports.set(b.local, e.spec);
  const out = [];
  for (const prop of table.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      throw new ScannerError(`${KIND_TABLE_MODULE}: ${tableName} holds an entry that is not a plain property`);
    }
    const kind = propertyNameText(prop.name);
    if (kind === null) throw new ScannerError(`${KIND_TABLE_MODULE}: ${tableName} holds a computed key`);
    const entry = unwrapExpression(prop.initializer);
    if (!ts.isObjectLiteralExpression(entry)) {
      throw new ScannerError(`${KIND_TABLE_MODULE}: the entry "${kind}" of ${tableName} is not an object literal`);
    }
    const rendererProp = entry.properties.find(
      (p) => ts.isPropertyAssignment(p) && propertyNameText(p.name) === "renderer",
    );
    if (!rendererProp) throw new ScannerError(`${KIND_TABLE_MODULE}: the entry "${kind}" of ${tableName} names no renderer`);
    const r = unwrapExpression(rendererProp.initializer);
    let componentModule = KIND_TABLE_MODULE; // a renderer defined in the table's own module is the host's own
    if (ts.isIdentifier(r) && imports.has(r.text)) {
      const spec = imports.get(r.text);
      const normalized = normalizeSpecifier(KIND_TABLE_MODULE, spec);
      if (normalized === SCHEMA_FLOOR_MODULE) continue;
      const target = resolve(KIND_TABLE_MODULE, spec);
      if (target && target.replace(EXTENSION_RE, "") === SCHEMA_FLOOR_MODULE) continue;
      componentModule = target ?? normalized;
    }
    out.push({ key: `${kind} :: ${componentModule}`, module: componentModule });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Class 8, the static half.
// ---------------------------------------------------------------------------

function objectLiteralProps(node) {
  const props = new Map();
  for (const p of node.properties) {
    if (ts.isPropertyAssignment(p)) {
      const n = propertyNameText(p.name);
      if (n !== null) props.set(n, p.initializer);
    } else if (ts.isShorthandPropertyAssignment(p)) {
      props.set(p.name.text, p.name);
    }
  }
  return props;
}

/** `kind: "mime"` literals (outside the declaring module) and first-party form mounts, per module. */
export function findStaticHalf(files, cache) {
  const mime = {};
  const mounts = {};
  for (const rel of files) {
    const text = cache.text(rel);
    // A cheap filter on the string literal alone: a quoted key or a comment
    // between the key and its value never hides a site from the syntax tree.
    const hasMime = /["'`]mime["'`]/.test(text) && rel !== DISPATCH_MODULE;
    const hasForm = /["'`]form["'`]/.test(text);
    if (!hasMime && !hasForm) continue;
    const sf = cache.sf(rel);
    let nMime = 0;
    let nForm = 0;
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const props = objectLiteralProps(node);
        const kind = stringLiteralText(props.get("kind"));
        if (kind === "mime" && hasMime) nMime += 1;
        if (kind === "form" && props.has("arm")) {
          // The arm's type is the one literal "first-party" today: a literal of
          // another arm is not a host mount, a value passed through is.
          const arm = stringLiteralText(props.get("arm"));
          if (arm === null || arm === "first-party") nForm += 1;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (nMime > 0) mime[`${rel} :: mime`] = { count: nMime };
    if (nForm > 0) mounts[`${rel} :: form-mount`] = { count: nForm };
  }
  return { mimeConstructions: mime, hostMounts: mounts };
}

// ---------------------------------------------------------------------------
// The scan.
// ---------------------------------------------------------------------------

function makeCache(root) {
  const texts = new Map();
  const sfs = new Map();
  return {
    text(rel) {
      if (!texts.has(rel)) texts.set(rel, readFileSync(join(root, rel), "utf8"));
      return texts.get(rel);
    },
    sf(rel) {
      if (!sfs.has(rel)) sfs.set(rel, parseModule(root, rel));
      return sfs.get(rel);
    },
  };
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** The dispatch consumers of a tree (the modules class 8 also reads). */
export function listDispatchConsumers(root = REPO_ROOT, { options } = {}) {
  const opts = options ?? readCompilerOptions(root);
  return findDispatchConsumers(root, listTreeFiles(root), makeResolver(root, opts), makeCache(root));
}

/**
 * Scan the tree and return the LIVE floor, in the baseline's shape without owners:
 * { handlerKinds, displays, stepRenderers, ceilings, mimeConstructions, hostMounts },
 * plus `model` (the dispatch model) and `consumers`. Throws ScannerError.
 */
export function scanHostDisplayFloor(root = REPO_ROOT, { files } = {}) {
  const options = readCompilerOptions(root);
  const model = buildDispatchModel(root, { options });
  const tree = files ?? listTreeFiles(root);
  const resolve = makeResolver(root, options);
  const cache = makeCache(root);

  const handlerKinds = {};
  for (const k of model.handlerKinds) handlerKinds[`dispatch :: ${k}`] = {};
  for (const f of model.reviewForms) handlerKinds[`review-form :: ${f}`] = {};

  const { consumers, displays: displayList } = findHostDisplays(root, tree, model, resolve, cache);
  const displays = {};
  for (const d of displayList) displays[d] = {};

  const steps = findStepRenderers(root, resolve, cache);
  const stepRenderers = {};
  for (const s of steps) stepRenderers[s.key] = {};

  const ceilings = {};
  for (const m of [...new Set([...displayList, ...steps.map((s) => s.module)])].sort()) {
    if (!existsSync(join(root, m))) throw new ScannerError(`${m} is absent (its ceiling cannot be measured)`);
    ceilings[m] = measureCeiling(cache.sf(m));
  }

  const { mimeConstructions, hostMounts } = findStaticHalf(tree, cache);
  return {
    handlerKinds: sortKeys(handlerKinds),
    displays: sortKeys(displays),
    stepRenderers: sortKeys(stepRenderers),
    ceilings: sortKeys(ceilings),
    mimeConstructions: sortKeys(mimeConstructions),
    hostMounts: sortKeys(hostMounts),
    model,
    consumers,
  };
}

// ---------------------------------------------------------------------------
// The ratchet (the sibling gates' arithmetic, per section).
// ---------------------------------------------------------------------------

/** One section as counted keys. A ceiling becomes `<module>` (listed), `<module> :: topLevel`
 * and `<module> :: import :: <specifier>`. */
export function sectionCounts(name, entries) {
  const out = {};
  for (const [k, v] of Object.entries(entries ?? {})) {
    if (name === "ceilings") {
      out[k] = 1;
      out[`${k} :: topLevel`] = v?.topLevel ?? 0;
      for (const s of v?.imports ?? []) out[`${k} :: import :: ${s}`] = 1;
    } else {
      out[k] = typeof v?.count === "number" ? v.count : 1;
    }
  }
  return out;
}

/** Keys whose CURRENT count exceeds the baseline count, or are entirely new. */
export function diffGrown(baseline, current) {
  const grown = [];
  for (const [k, c] of Object.entries(current)) {
    const base = baseline[k] ?? 0;
    if (c > base) grown.push(`${k} (${base} -> ${c})`);
  }
  return grown.sort();
}

/** Baseline keys whose CURRENT count fell below the baseline count (stale floor). */
export function diffShrunk(baseline, current) {
  const shrunk = [];
  for (const [k, c] of Object.entries(baseline)) {
    const cur = current[k] ?? 0;
    if (cur < c) shrunk.push(`${k} (${c} -> ${cur})`);
  }
  return shrunk.sort();
}

/** Per section: { grown: [...], stale: [...] } of a committed floor against a live one. */
export function diffFloor(committed, live) {
  const out = {};
  for (const s of SECTIONS) {
    const c = sectionCounts(s, committed?.[s]);
    const l = sectionCounts(s, live?.[s]);
    out[s] = { grown: diffGrown(c, l), stale: diffShrunk(c, l) };
  }
  return out;
}

/** Entries whose owner is empty or UNASSIGNED, as `<section> :: <key>`. */
export function ownerProblems(committed) {
  const out = [];
  for (const s of SECTIONS) {
    for (const [k, v] of Object.entries(committed?.[s] ?? {})) {
      const owner = typeof v?.owner === "string" ? v.owner.trim() : "";
      if (owner === "" || owner === UNASSIGNED) out.push(`${s} :: ${k}`);
    }
  }
  return out.sort();
}

/** The findings of a committed floor against a live one: { grown, stale, owners } (flat, section-prefixed). */
export function checkFloor(committed, live) {
  const d = diffFloor(committed, live);
  const grown = [];
  const stale = [];
  for (const s of SECTIONS) {
    for (const g of d[s].grown) grown.push(`${s} :: ${g}`);
    for (const x of d[s].stale) stale.push(`${s} :: ${x}`);
  }
  return { grown, stale, owners: ownerProblems(committed) };
}

const NOTE =
  "Host display floor (cinatra#3821): the places where the application draws an artifact's content itself, " +
  "or a step of one agent, instead of the extension that owns it. Each entry names its owner (the extension " +
  "or the item that takes it over). SHRINK-ONLY: a new key or a grown count fails; a fallen count is stale " +
  "until `node scripts/audit/host-display-floor-gate.mjs --write-baseline` ratchets it down (it refuses " +
  "growth). See scripts/audit/host-display-floor.md.";

/**
 * The baseline `--write-baseline` writes: the live floor with the committed
 * owners carried per key; a new key gets owner UNASSIGNED (and a display
 * removedBy UNASSIGNED). Refuses (returns { grown }) when the live floor grew.
 */
export function composeBaseline(committed, live) {
  if (committed) {
    const { grown } = checkFloor(committed, live);
    if (grown.length > 0) return { grown, baseline: null };
  }
  const baseline = { note: NOTE };
  for (const s of SECTIONS) {
    const out = {};
    for (const [k, v] of Object.entries(live[s] ?? {})) {
      const prev = committed?.[s]?.[k] ?? {};
      const entry = {};
      if (s === "ceilings") {
        entry.topLevel = v.topLevel;
        entry.imports = v.imports;
      } else if (s === "mimeConstructions" || s === "hostMounts") {
        entry.count = v.count;
      }
      entry.owner = typeof prev.owner === "string" && prev.owner !== "" ? prev.owner : UNASSIGNED;
      if (s === "displays") {
        entry.removedBy = typeof prev.removedBy === "string" && prev.removedBy !== "" ? prev.removedBy : UNASSIGNED;
      }
      out[k] = entry;
    }
    baseline[s] = sortKeys(out);
  }
  return { grown: [], baseline };
}

export function readBaseline(root = REPO_ROOT) {
  const p = join(root, BASELINE_REL);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

/**
 * The base guard: { ok: true } or { ok: false, reason }. Fails closed on a
 * flag-like or unresolvable reference; refuses a committed floor that grew
 * against the base; imposes nothing when the base holds no baseline.
 */
export function checkBaseGuard(root, baseRef, committed) {
  if (baseRef.startsWith("-")) {
    return { ok: false, reason: `HOST_DISPLAY_FLOOR_BASE="${baseRef}" is flag-like. Failing closed.` };
  }
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    return {
      ok: false,
      reason:
        `HOST_DISPLAY_FLOOR_BASE="${baseRef}" did not resolve (shallow checkout / misconfig?). ` +
        `Failing closed. Ensure the base ref is fetched (fetch-depth: 0).`,
    };
  }
  let baseText = null;
  try {
    baseText = execFileSync("git", ["show", `${baseRef}:${BASELINE_REL}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    baseText = null; // the reference resolves but holds no baseline: the introducing change
  }
  if (!baseText) return { ok: true, introducing: true };
  const grew = checkFloor(JSON.parse(baseText), committed).grown;
  if (grew.length > 0) {
    return {
      ok: false,
      reason: `the committed floor GREW vs ${baseRef} (shrink-only: no regenerate can raise it):\n  + ${grew.join("\n  + ")}`,
    };
  }
  return { ok: true };
}

function okLine(live) {
  const n = (s) => Object.keys(live[s]).length;
  const kinds = n("handlerKinds") === 0 ? "no host handler kind" : `${n("handlerKinds")} host handler kind(s)`;
  return (
    `${TAG} OK — ${kinds}, ${n("displays")} host display(s), ${n("stepRenderers")} step renderer(s), ` +
    `${n("ceilings")} ceiling(s), ${n("hostMounts")} host mount site(s), ${n("mimeConstructions")} mime construction(s); ` +
    `0 new, 0 stale (shrink-only floor — cinatra#3821; see ${DOC_REL}).`
  );
}

function main() {
  const args = process.argv.slice(2);
  let live;
  const started = Date.now();
  try {
    live = scanHostDisplayFloor();
  } catch (e) {
    console.error(`${TAG} SCANNER ERROR — ${e instanceof ScannerError ? e.message : e?.stack ?? e}`);
    process.exit(2);
  }
  const committed = (() => {
    try {
      return readBaseline();
    } catch (e) {
      console.error(`${TAG} SCANNER ERROR — the baseline does not parse (${e.message})`);
      process.exit(2);
    }
  })();

  if (args.includes("--write-baseline")) {
    const { grown, baseline } = composeBaseline(committed, live);
    if (grown.length > 0) {
      console.error(
        `${TAG} FAIL — refusing to write a GROWN floor (the floor is shrink-only; move the display into the ` +
          `extension that owns it instead of re-baselining it — cinatra#3821):`,
      );
      grown.forEach((g) => console.error("  + " + g));
      process.exit(1);
    }
    writeFileSync(join(REPO_ROOT, BASELINE_REL), JSON.stringify(baseline, null, 2) + "\n");
    const unassigned = ownerProblems(baseline);
    console.log(
      `${TAG} baseline written — ${SECTIONS.map((s) => `${Object.keys(baseline[s]).length} ${s}`).join(", ")}` +
        (unassigned.length ? `; ${unassigned.length} entr${unassigned.length === 1 ? "y" : "ies"} need an owner (UNASSIGNED)` : ""),
    );
    return;
  }

  if (!committed) {
    console.error(`${TAG} FAIL — no baseline. Run with --write-baseline first.`);
    process.exit(1);
  }

  const baseRef = process.env.HOST_DISPLAY_FLOOR_BASE;
  if (baseRef) {
    const guard = checkBaseGuard(REPO_ROOT, baseRef, committed);
    if (!guard.ok) {
      console.error(`${TAG} FAIL — ${guard.reason}`);
      process.exit(1);
    }
  }

  const { grown, stale, owners } = checkFloor(committed, live);
  let failed = false;
  if (grown.length > 0) {
    failed = true;
    console.error(`${TAG} FAIL — ${grown.length} NEW entr${grown.length === 1 ? "y" : "ies"} of the host display floor:`);
    grown.forEach((g) => console.error("  + " + g));
    console.error(
      "\nAn artifact extension declares the type and draws it from its content. Do not add a display of the\n" +
        "application's own, grow one, or put the host's display above an extension's: draw the content in the\n" +
        `extension that owns the type (or the agent's step in its extension). See ${DOC_REL}.`,
    );
  }
  if (stale.length > 0) {
    failed = true;
    console.error(
      `${TAG} FAIL — ${stale.length} STALE entr${stale.length === 1 ? "y" : "ies"} (the floor shrank — ratchet it down ` +
        `so the headroom cannot be re-spent):\n  node scripts/audit/host-display-floor-gate.mjs --write-baseline`,
    );
    stale.forEach((x) => console.error("  - " + x));
  }
  if (owners.length > 0) {
    failed = true;
    console.error(
      `${TAG} FAIL — ${owners.length} entr${owners.length === 1 ? "y has" : "ies have"} no owner (empty or ${UNASSIGNED}); ` +
        "name the extension or the item that takes each over:",
    );
    owners.forEach((o) => console.error("  ? " + o));
  }
  if (failed) process.exit(1);
  console.log(okLine(live) + ` [${((Date.now() - started) / 1000).toFixed(1)} s]`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
