// NO EDIT CAPABILITY OUTSIDE THE ARTIFACT PAGE, ANYWHERE (cinatra#3319, acceptance 7).
//
// "... a test asserts no `grantArtifactEdit` call is reachable from outside the
//  artifact page."
//
// `w4-edit-capability-page-only.test.ts` pins the split over the Artifacts area
// (src/app/artifacts, src/components/artifacts, src/lib/artifacts). The review
// itself is drawn from outside that area too - the lifecycle review island lives
// under src/app/lifecycle, and the review preparation is reached from workspace
// packages - so a grant named there would not be seen by that sweep.
//
// WHAT THIS ONE READS: every production module (.ts .tsx .mts .cts .js .jsx
// .mjs .cjs) of the host application (src and the root's own module files) and
// of EVERY workspace glob that pnpm-workspace.yaml defines (the packages and
// the extension workspaces), read from that file rather than transcribed.
// Test, fixture, build and dependency folders are skipped, as the repository's
// other sweeps skip them. A skipped folder is NOT a blind spot, though: every
// module that a swept module loads at run time through a relative or `@/`
// specifier is swept too, followed to the end of the chain. So a fixture that
// production code imports (src/lib/deployment-registry-config.ts loads
// src/lib/__fixtures__/deployment-registry-config.fixture.ts) is read; a
// fixture that only tests import is not.
//
// WHY NAMING ALONE IS NOT ENOUGH, and what closes it. A file that never names
// the grant can still reach it through a second name: an alias or a re-export
// in the definition module, a wildcard or namespace import of that module, a
// barrel that re-exports it with `export *`, or a dynamic import. The sweep is
// therefore read through the TypeScript syntax tree (comments are not nodes, so
// a comment that mentions the grant is not a name), and it asserts four things:
//   1. only the artifact page and the definition module name the grant;
//   2. the definition names it exactly once, as the exported function's own
//      declaration - no alias, no re-export, no default export of it;
//   3. no production module reads the definition module whole: no namespace
//      import, no `export *` or `export * as`, no dynamic import, no `require`
//      and no `module.require` (the call forms the repository's own import
//      parser counts, src/lib/extension-package-store-core.ts);
//   4. the page names it only as an un-aliased import and as a call.
// The four rules are themselves driven against small in-memory sources below,
// so a rule that stopped seeing its bypass would fail here too.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import ts from "typescript";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..", "..");
const THE_ARTIFACT_PAGE = "src/app/artifacts/[id]/page.tsx";
/** Where the capability is DEFINED - a definition is not a call site. */
const THE_DEFINITION = "src/lib/artifacts/artifact-renderer-props.ts";
const THE_DEFINITION_MODULE = THE_DEFINITION.replace(/\.ts$/, "");
const THE_GRANT = "grantArtifactEdit";

const MODULE_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"] as const;
const MODULE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION_FILE = /\.d\.(ts|mts|cts)$/;
const TEST_FILE = /\.(test|spec)\.[a-z]+$/;

/** Directories that hold no production source. A folder named `test` is NOT
 *  one of them: src/app/configuration/mcp/llm-access/test is a production route. */
const SKIPPED_DIRS = new Set([
  "node_modules",
  "__tests__",
  "__stubs__",
  "__mocks__",
  "__fixtures__",
  "fixtures",
  "tests",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".git",
]);

/** The `packages:` glob list of pnpm-workspace.yaml (the same no-dependency
 *  reading scripts/audit/workspace-deps-resolve.mjs takes). */
function workspaceGlobs(): string[] {
  const text = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const globs: string[] = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    if (!inPackages) continue;
    const m = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
    if (m) globs.push(m[1].trim());
  }
  return globs;
}

/** One `*` per segment at most, no `**` - the shape every glob in the file has. */
function expandGlob(pattern: string): string[] {
  let dirs = [""];
  for (const seg of pattern.split("/")) {
    const re = new RegExp(
      "^" + seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
    );
    const next: string[] = [];
    for (const dir of dirs) {
      if (kindOf(dir || ".") !== "dir") continue;
      for (const name of readdirSync(join(REPO_ROOT, dir))) {
        const rel = dir ? `${dir}/${name}` : name;
        if (re.test(name) && kindOf(rel) === "dir") next.push(rel);
      }
    }
    dirs = next;
  }
  return dirs;
}

/** The kind of a path, or null for a path that is not there (a dangling link,
 *  or a path through a file, as `styles.css/index.ts` is when resolving). */
function kindOf(rel: string): "dir" | "file" | null {
  try {
    const stat = statSync(join(REPO_ROOT, rel));
    return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

function isProductionModule(name: string): boolean {
  return MODULE_FILE.test(name) && !DECLARATION_FILE.test(name) && !TEST_FILE.test(name);
}

function productionSources(dir: string, out: string[]): void {
  const abs = join(REPO_ROOT, dir);
  if (!existsSync(abs)) return;
  for (const name of readdirSync(abs)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const rel = `${dir}/${name}`;
    const kind = kindOf(rel);
    if (kind === "dir") {
      productionSources(rel, out);
      continue;
    }
    if (kind === "file" && isProductionModule(name)) out.push(rel);
  }
}

const GLOBS = workspaceGlobs();
const WORKSPACE_DIRS = [...new Set(["src", ...GLOBS.flatMap(expandGlob)])].sort();

/** The directory sweep: src, the root's own module files, every workspace. */
function sweptSources(): string[] {
  const out: string[] = [];
  // The root application's own module files (next.config.ts and the like).
  for (const name of readdirSync(REPO_ROOT)) {
    if (kindOf(name) === "file" && isProductionModule(name)) out.push(name);
  }
  for (const dir of WORKSPACE_DIRS) productionSources(dir, out);
  return [...new Set(out)].sort();
}

/** `require(...)`, `module.require(...)` or `import(...)`: the call forms that
 *  load a module at run time, as src/lib/extension-package-store-core.ts
 *  (parseModuleImports) counts them. */
function isLoaderCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return (
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(callee) && callee.text === "require") ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "require" &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "module")
  );
}

/** Every specifier a module loads at run time - the value edges the same
 *  parser counts: import and re-export declarations (declaration-level
 *  `import type` / `export type` are erased, so not edges), import-equals, and
 *  a loader call with a literal argument. */
function runtimeEdges(ast: ts.SourceFile): string[] {
  const out: string[] = [];
  eachNode(ast, (node) => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteralLike(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
        out.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && !node.isTypeOnly) {
        out.push(node.moduleSpecifier.text);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteralLike(node.moduleReference.expression)
      ) {
        out.push(node.moduleReference.expression.text);
      }
    } else if (ts.isCallExpression(node) && isLoaderCall(node)) {
      const [first] = node.arguments;
      if (first && ts.isStringLiteralLike(first)) out.push(first.text);
    }
  });
  return out;
}

/** The repository file a relative or `@/` specifier written in `fromRel`
 *  loads, or null (a package, a non-module file, or nothing on disk). Tries
 *  the path itself, the path with each module extension (a `.js` specifier
 *  may name a `.ts` file), then the folder's index module. */
function resolveLocalModule(fromRel: string, specifier: string, known: Set<string>): string | null {
  let target: string;
  if (specifier.startsWith("@/")) target = "src/" + specifier.slice(2);
  else if (specifier.startsWith(".")) target = posix.join(posix.dirname(fromRel), specifier);
  else return null;
  target = posix.normalize(target);
  if (target.startsWith("..") || target.split("/").includes("node_modules")) return null;
  const base = target.replace(MODULE_FILE, "");
  const candidates = [
    target,
    ...MODULE_EXTENSIONS.map((ext) => `${base}.${ext}`),
    ...MODULE_EXTENSIONS.map((ext) => `${target}/index.${ext}`),
  ].filter((c) => MODULE_FILE.test(c) && !DECLARATION_FILE.test(c));
  const hit = candidates.find((c) => known.has(c));
  if (hit) return hit;
  return candidates.find((c) => kindOf(c) === "file") ?? null;
}

function parse(rel: string, text: string): ts.SourceFile {
  const kind = /\.tsx$/.test(rel)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(rel)
      ? ts.ScriptKind.JSX
      : /\.[mc]?js$/.test(rel)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
}

function eachNode(root: ts.Node, visit: (node: ts.Node) => void): void {
  const walk = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
}

/** Every node that names the grant: an identifier or a string spelling it. */
function grantNames(ast: ts.SourceFile): ts.Node[] {
  const out: ts.Node[] = [];
  eachNode(ast, (node) => {
    if (
      (ts.isIdentifier(node) ||
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === THE_GRANT
    ) {
      out.push(node);
    }
  });
  return out;
}

/** Does `specifier`, written in `fromRel`, name the definition module? */
function namesTheDefinitionModule(fromRel: string, specifier: string): boolean {
  let target: string;
  if (specifier.startsWith("@/")) target = "src/" + specifier.slice(2);
  else if (specifier.startsWith(".")) target = posix.join(posix.dirname(fromRel), specifier);
  else return false;
  return posix.normalize(target).replace(MODULE_FILE, "") === THE_DEFINITION_MODULE;
}

/** Rule 3: every way a module reads the definition module whole. */
function wholeModuleReads(rel: string, ast: ts.SourceFile): string[] {
  const found: string[] = [];
  const at = (node: ts.Node, what: string) =>
    found.push(`${rel}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1} ${what}`);
  eachNode(ast, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      namesTheDefinitionModule(rel, node.moduleSpecifier.text) &&
      node.importClause?.namedBindings &&
      ts.isNamespaceImport(node.importClause.namedBindings)
    ) {
      at(node, "namespace import");
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      namesTheDefinitionModule(rel, node.moduleSpecifier.text) &&
      (!node.exportClause || ts.isNamespaceExport(node.exportClause))
    ) {
      at(node, "wildcard re-export");
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      namesTheDefinitionModule(rel, node.moduleReference.expression.text)
    ) {
      at(node, "import-equals");
    }
    if (ts.isCallExpression(node) && isLoaderCall(node)) {
      const [first] = node.arguments;
      if (
        first &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) &&
        namesTheDefinitionModule(rel, first.text)
      ) {
        at(node, "dynamic import or require");
      }
    }
  });
  return found;
}

/** Rule 2: the definition names the grant once, as its exported declaration. */
function definitionViolations(ast: ts.SourceFile): string[] {
  const names = grantNames(ast);
  const declaration = names.filter((node) => {
    const parent = node.parent;
    if (!parent || !ts.isFunctionDeclaration(parent) || parent.name !== node) return false;
    const modifiers = ts.getModifiers(parent) ?? [];
    return (
      modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      !modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    );
  });
  const out: string[] = [];
  if (declaration.length !== 1) out.push(`declarations: ${declaration.length}`);
  if (names.length !== 1) out.push(`names: ${names.length}`);
  return out;
}

/** Rule 4: the page names the grant only as an un-aliased import and a call. */
function pageViolations(rel: string, ast: ts.SourceFile): string[] {
  const out: string[] = [];
  let calls = 0;
  for (const node of grantNames(ast)) {
    const parent = node.parent;
    const specifier =
      parent && ts.isImportSpecifier(parent) && parent.name === node && !parent.propertyName
        ? parent
        : null;
    const importDecl = specifier ? specifier.parent.parent.parent : null;
    if (
      specifier &&
      !specifier.isTypeOnly &&
      importDecl &&
      ts.isImportDeclaration(importDecl) &&
      ts.isStringLiteral(importDecl.moduleSpecifier) &&
      namesTheDefinitionModule(rel, importDecl.moduleSpecifier.text)
    ) {
      continue;
    }
    if (parent && ts.isCallExpression(parent) && parent.expression === node) {
      calls += 1;
      continue;
    }
    out.push(`line ${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
  }
  if (calls === 0) out.push("no call");
  return out;
}

const SWEPT = sweptSources();
const PARSED = new Map<string, ts.SourceFile>();
const parsed = (rel: string): ts.SourceFile => {
  let ast = PARSED.get(rel);
  if (!ast) {
    ast = parse(rel, readFileSync(join(REPO_ROOT, rel), "utf8"));
    PARSED.set(rel, ast);
  }
  return ast;
};

/** The swept modules plus every module they load at run time, to the end of
 *  the chain: a module in a skipped folder that production code imports is
 *  production code. */
function withRuntimeReach(swept: string[]): string[] {
  const seen = new Set(swept);
  const queue = [...swept];
  while (queue.length > 0) {
    const rel = queue.pop()!;
    for (const specifier of runtimeEdges(parsed(rel))) {
      const target = resolveLocalModule(rel, specifier, seen);
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...seen].sort();
}

const SOURCES = withRuntimeReach(SWEPT);
/** A fixture that production imports at run time (deployment-registry-config.ts:40). */
const REACHED_FIXTURE = "src/lib/__fixtures__/deployment-registry-config.fixture.ts";

describe("acceptance 7 - grantArtifactEdit is reachable from the artifact page alone, repository-wide", () => {
  it("the sweep reads every workspace pnpm-workspace.yaml defines, and every module kind", () => {
    // A sweep that silently read nothing would pass below; it must see the
    // workspaces it is meant to cover and the surfaces of the review.
    expect(GLOBS).toContain("packages/*");
    expect(GLOBS.some((g) => g.startsWith("extensions/"))).toBe(true);
    // The pack the sibling resolver suites register from (w4-dispatch-matrix,
    // w4-shared-display-revision-legs) is an extension workspace of this file.
    expect(WORKSPACE_DIRS).toContain("extensions/cinatra-ai/text-artifact");
    expect(WORKSPACE_DIRS.some((d) => d.startsWith("packages/"))).toBe(true);

    const seen = new Set(SOURCES);
    expect(seen.has(THE_ARTIFACT_PAGE)).toBe(true);
    expect(seen.has(THE_DEFINITION)).toBe(true);
    expect(seen.has("src/app/lifecycle/review-island/page.tsx")).toBe(true);
    expect(seen.has("src/lib/artifacts/artifact-review-preparation.ts")).toBe(true);
    expect(seen.has("packages/cli/bin/cinatra.mjs")).toBe(true);
    expect(seen.has("packages/execution-plane/runtime/egress-gateway.cjs")).toBe(true);
    expect(SOURCES.some((f) => f.startsWith("packages/"))).toBe(true);
  });

  it("the sweep follows production's run-time imports into skipped folders", () => {
    // The fixture sits in a skipped __fixtures__ folder, so the directory
    // sweep alone does not read it; the run-time reach must.
    expect(SWEPT).not.toContain(REACHED_FIXTURE);
    expect(SOURCES).toContain(REACHED_FIXTURE);
    // A fixture that only tests name stays out: the reach is not "every fixture".
    expect(SOURCES).not.toContain(
      "packages/dashboards/src/components/__fixtures__/dc-client-allowed.fixture.tsx",
    );
  });

  it("no production module names it, except the page and its definition", () => {
    const named = SOURCES.filter((rel) => grantNames(parsed(rel)).length > 0);
    expect(named).toEqual([THE_ARTIFACT_PAGE, THE_DEFINITION].sort());
  });

  it("the definition names it once, as the exported function, with no alias or re-export", () => {
    expect(definitionViolations(parsed(THE_DEFINITION))).toEqual([]);
  });

  it("no production module reads the definition module whole", () => {
    expect(SOURCES.flatMap((rel) => wholeModuleReads(rel, parsed(rel)))).toEqual([]);
  });

  it("the page names it only as an un-aliased import and a call", () => {
    expect(pageViolations(THE_ARTIFACT_PAGE, parsed(THE_ARTIFACT_PAGE))).toEqual([]);
  });
});

describe("acceptance 7 - each rule sees the bypass it closes", () => {
  const DEF = THE_DEFINITION;
  const OTHER = "src/lib/elsewhere/leak.ts";
  const decl = "export function grantArtifactEdit(input: unknown) { return input; }\n";

  it("an alias or a re-export in the definition is refused", () => {
    expect(definitionViolations(parse(DEF, decl))).toEqual([]);
    for (const extra of [
      "export const editGrant = grantArtifactEdit;",
      "export { grantArtifactEdit as editGrant };",
      "export default grantArtifactEdit;",
      "export const all = { grantArtifactEdit };",
    ]) {
      expect(definitionViolations(parse(DEF, decl + extra)), extra).not.toEqual([]);
    }
    expect(
      definitionViolations(parse(DEF, decl.replace("export function", "export default function"))),
    ).not.toEqual([]);
  });

  it("a wildcard, namespace or dynamic read of the definition module is refused", () => {
    for (const source of [
      'import * as props from "@/lib/artifacts/artifact-renderer-props";',
      'import * as props from "../artifacts/artifact-renderer-props";',
      'export * from "@/lib/artifacts/artifact-renderer-props";',
      'export * as props from "@/lib/artifacts/artifact-renderer-props.ts";',
      'const props = await import("@/lib/artifacts/artifact-renderer-props");',
      'const props = require("@/lib/artifacts/artifact-renderer-props");',
      'const props = module.require("@/lib/artifacts/artifact-renderer-props");',
      'const props = module.require("../artifacts/artifact-renderer-props");\nprops["grant" + "ArtifactEdit"]({});',
      'import props = require("@/lib/artifacts/artifact-renderer-props");',
    ]) {
      expect(wholeModuleReads(OTHER, parse(OTHER, source)), source).not.toEqual([]);
    }
    expect(
      wholeModuleReads(
        OTHER,
        parse(OTHER, 'import { absentArtifactContent } from "@/lib/artifacts/artifact-renderer-props";'),
      ),
    ).toEqual([]);
  });

  it("every run-time load form is an edge the reach follows, and a type-only one is not", () => {
    const from = "src/lib/elsewhere/loader.ts";
    const source = [
      'import "./a";',
      'import { b } from "./b";',
      'export * from "./c";',
      'import d = require("./d");',
      'const e = require("./e");',
      'const f = module.require("./f");',
      'const g = await import("./g");',
      'import type { H } from "./h";',
      'export type { I } from "./i";',
    ].join("\n");
    expect(runtimeEdges(parse(from, source))).toEqual(["./a", "./b", "./c", "./d", "./e", "./f", "./g"]);
    expect(
      resolveLocalModule(
        "src/lib/deployment-registry-config.ts",
        "./__fixtures__/deployment-registry-config.fixture",
        new Set(),
      ),
    ).toBe(REACHED_FIXTURE);
    expect(resolveLocalModule(from, "server-only", new Set())).toBeNull();
  });

  it("every module kind the sweep selects is read as a module that can name the grant", () => {
    for (const ext of MODULE_EXTENSIONS) {
      const rel = `src/lib/elsewhere/leak.${ext}`;
      expect(isProductionModule(rel), rel).toBe(true);
      expect(grantNames(parse(rel, "grantArtifactEdit({});\n")), rel).not.toEqual([]);
    }
  });

  it("an alias in the page is refused, and a comment is not a name", () => {
    const imp = 'import { grantArtifactEdit } from "@/lib/artifacts/artifact-renderer-props";\n';
    expect(pageViolations(THE_ARTIFACT_PAGE, parse(THE_ARTIFACT_PAGE, imp + "grantArtifactEdit({});"))).toEqual([]);
    for (const source of [
      'import { grantArtifactEdit as g } from "@/lib/artifacts/artifact-renderer-props";\ng({});',
      imp + "export const g = grantArtifactEdit;\ngrantArtifactEdit({});",
      imp + "export { grantArtifactEdit };\ngrantArtifactEdit({});",
    ]) {
      expect(pageViolations(THE_ARTIFACT_PAGE, parse(THE_ARTIFACT_PAGE, source)), source).not.toEqual([]);
    }
    expect(grantNames(parse(OTHER, "// grantArtifactEdit\n/* grantArtifactEdit */\n"))).toEqual([]);
    expect(grantNames(parse(OTHER, 'const p = props["grantArtifactEdit"];'))).not.toEqual([]);
  });
});
