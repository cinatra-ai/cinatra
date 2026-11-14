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
// other sweeps skip them.
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
//      import, no `export *` or `export * as`, no dynamic import or require;
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

/** The kind of a path, or null for a path that is gone (a dangling link). */
function kindOf(rel: string): "dir" | "file" | null {
  try {
    const stat = statSync(join(REPO_ROOT, rel));
    return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
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

function allProductionSources(): string[] {
  const out: string[] = [];
  // The root application's own module files (next.config.ts and the like).
  for (const name of readdirSync(REPO_ROOT)) {
    if (kindOf(name) === "file" && isProductionModule(name)) out.push(name);
  }
  for (const dir of WORKSPACE_DIRS) productionSources(dir, out);
  return [...new Set(out)].sort();
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
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const dynamic =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require");
      const [first] = node.arguments;
      if (
        dynamic &&
        first &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) &&
        namesTheDefinitionModule(rel, first.text)
      ) {
        at(node, "dynamic import");
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

const SOURCES = allProductionSources();
const PARSED = new Map(
  SOURCES.map((rel) => [rel, parse(rel, readFileSync(join(REPO_ROOT, rel), "utf8"))] as const),
);

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
    expect(SOURCES.some((f) => f.startsWith("packages/"))).toBe(true);
  });

  it("no production module names it, except the page and its definition", () => {
    const named = SOURCES.filter((rel) => grantNames(PARSED.get(rel)!).length > 0);
    expect(named).toEqual([THE_ARTIFACT_PAGE, THE_DEFINITION].sort());
  });

  it("the definition names it once, as the exported function, with no alias or re-export", () => {
    expect(definitionViolations(PARSED.get(THE_DEFINITION)!)).toEqual([]);
  });

  it("no production module reads the definition module whole", () => {
    expect(SOURCES.flatMap((rel) => wholeModuleReads(rel, PARSED.get(rel)!))).toEqual([]);
  });

  it("the page names it only as an un-aliased import and a call", () => {
    expect(pageViolations(THE_ARTIFACT_PAGE, PARSED.get(THE_ARTIFACT_PAGE)!)).toEqual([]);
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
