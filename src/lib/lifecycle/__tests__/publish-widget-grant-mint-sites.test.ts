// cinatra#4150 part 7a-3b: THE WIDGET PUBLISH GRANT'S MINT SITES. The mint trusts the claims it is handed, so a module that
// reaches it could make a grant from claims it built itself. Its only callers are the two widget publish routes, and each
// consumed a `cwu_` first. This pin walks the WHOLE repository (every tracked root: src, packages, scripts, migrations, tests,
// vitest, .github and the top-level files, plus the synced extensions/ tree when it is present), skipping only node_modules,
// build output and test files, and parses each file that spells a module of the mint (TypeScript's parser, so a comment never
// hides a statement). It refuses:
//   - outside the defining module, the subpath that re-exports it and the two routes: any mention of the mint's name;
//   - in every file: a whole-module handle of either module (a namespace or default import, `import x = require`, `export *`,
//     `export * as`, an unawaited dynamic import, a dynamic import or require used other than as a bound name or a plain
//     destructuring) unless that handle is only read by a dot, or a typeof, of a name the module exports (never `then` or
//     `default`, never the mint);
//   - in the exempt modules: any other spelling of the mint than the one each has today (the definition; one unaliased
//     re-export; an unaliased named import and calls in each route), so no alias of the mint can be published.
// Test files are not product code and are not read. A module specifier that is not a plain string (built at run time) is
// not readable by a source scan.
// Red at the 7a-3a tip: no module names the mint (the first real-tree case). The scanner's own cases pass there too.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
const MINT = "mintWidgetPublishDecideGrant";
const DEFINER = "packages/agents/src/publish-decision-actions.ts";
const RE_EXPORTER = "packages/agents/src/publish-decision-card-core.ts";
const CALLERS = [
  "src/app/api/lifecycle-views/publish-decision/decide/route.ts",
  "src/app/api/lifecycle-views/publish-decision/route.ts",
];
const ALLOWED = new Set([DEFINER, RE_EXPORTER, ...CALLERS]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".turbo", ".pnpm-store", "dist", "build", "coverage", "__tests__"]);
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const NAMES_MINT = new RegExp(String.raw`(?<![\w$])${MINT}(?![\w$])`);
const EXPOSER_SPEC = /publish-decision-(actions|card-core)(?:\.[cm]?[jt]sx?)?$/;
const NEVER_READ = new Set(["then", "default", MINT]);

type SourceFile = { file: string; text: string };
type Exports = { actions: Set<string>; "card-core": Set<string> };

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }
  return out.sort();
}

function parse(file: string, text: string): ts.SourceFile {
  const kind = /x$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

const unwrap = (node: ts.Node): ts.Node => (ts.isParenthesizedExpression(node) ? unwrap(node.parent) : node);
const exposerOf = (spec: ts.Node | undefined): keyof Exports | null => {
  if (!spec || !(ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec))) return null;
  const m = EXPOSER_SPEC.exec(spec.text);
  return m ? (m[1] as keyof Exports) : null;
};
const hasExport = (node: ts.Node) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** The names a module exports, read from its own source. */
function exportNames(text: string, file: string): Set<string> {
  const names = new Set<string>();
  for (const st of parse(file, text).statements) {
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) names.add(el.name.text);
    } else if (hasExport(st)) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
      } else if ("name" in st && st.name && ts.isIdentifier(st.name as ts.Node)) names.add((st.name as ts.Identifier).text);
    }
  }
  return names;
}

function mintSpellings(sf: ts.SourceFile): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  walk(sf, (n) => {
    if (ts.isIdentifier(n) && n.text === MINT) out.push(n);
  });
  return out;
}

/** The exempt modules may spell the mint only as they do today. */
function exemptViolations(file: string, sf: ts.SourceFile): string[] {
  const ids = mintSpellings(sf);
  const bad = (why: string) => [`${file}: ${why}`];
  if (file === DEFINER) {
    const ok = ids.length === 1 && ts.isFunctionDeclaration(ids[0].parent) && hasExport(ids[0].parent);
    return ok ? [] : bad("the defining module spells the mint other than in its one exported definition");
  }
  if (file === RE_EXPORTER) {
    const el = ids[0]?.parent;
    const ok = ids.length === 1 && el !== undefined && ts.isExportSpecifier(el) && el.propertyName === undefined
      && exposerOf(el.parent.parent.moduleSpecifier) === "actions";
    return ok ? [] : bad("the re-exporting subpath spells the mint other than in its one unaliased re-export");
  }
  const calls = ids.filter((id) => ts.isCallExpression(id.parent) && id.parent.expression === id).length;
  const imports = ids.filter((id) => ts.isImportSpecifier(id.parent) && id.parent.propertyName === undefined
    && id.parent.name === id && exposerOf(id.parent.parent.parent.parent.moduleSpecifier) === "card-core").length;
  return imports === 1 && calls >= 1 && imports + calls === ids.length
    ? []
    : bad("a widget publish route spells the mint other than as one unaliased import and its calls");
}

function handleViolations(file: string, sf: ts.SourceFile, exports: Exports): string[] {
  const out: string[] = [];
  const handles = new Map<ts.Identifier, keyof Exports>();
  const refuse = (why: string) => out.push(`${file}: ${why}`);
  walk(sf, (n) => {
    if (ts.isImportDeclaration(n)) {
      const kind = exposerOf(n.moduleSpecifier);
      const clause = n.importClause;
      if (!kind || !clause) return;
      if (clause.name) handles.set(clause.name, kind);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) handles.set(clause.namedBindings.name, kind);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const kind = exposerOf(n.moduleReference.expression);
      if (kind) handles.set(n.name, kind);
    } else if (ts.isExportDeclaration(n) && exposerOf(n.moduleSpecifier)) {
      if (!n.exportClause || ts.isNamespaceExport(n.exportClause)) refuse("re-exports a module of the mint whole");
    } else if (ts.isCallExpression(n)) {
      const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      const kind = isImport || isRequire ? exposerOf(n.arguments[0]) : null;
      if (!kind) return;
      let at = unwrap(n.parent);
      if (ts.isAwaitExpression(at)) at = unwrap(at.parent);
      else if (isImport) return void refuse("uses a dynamic import of the mint's module without awaiting it");
      if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) handles.set(at.name, kind);
      else if (ts.isVariableDeclaration(at) && ts.isObjectBindingPattern(at.name)) {
        const plain = at.name.elements.every((el) => !el.dotDotDotToken && ts.isIdentifier(el.name)
          && (!el.propertyName || ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)));
        if (!plain) refuse("destructures the mint's module with a rest, a computed key or a nested pattern");
      } else if (ts.isPropertyAccessExpression(at)) {
        if (NEVER_READ.has(at.name.text) || !exports[kind].has(at.name.text)) refuse(`reads ${at.name.text} of the mint's module`);
      } else refuse("uses the mint's module other than as a bound name or a plain destructuring");
    }
  });
  for (const [decl, kind] of handles) {
    walk(sf, (n) => {
      if (!ts.isIdentifier(n) || n === decl || n.text !== decl.text) return;
      const p = n.parent;
      const read = ts.isPropertyAccessExpression(p) && p.expression === n ? p.name.text
        : ts.isQualifiedName(p) && p.left === n ? p.right.text : null;
      if (read === null || NEVER_READ.has(read) || !exports[kind].has(read)) {
        refuse(`a handle of the mint's module is read other than by a dot of an export (${decl.text})`);
      }
    });
  }
  return out;
}

function findMintViolations(files: SourceFile[], exports: Exports): string[] {
  const out: string[] = [];
  for (const { file, text } of files) {
    if (!ALLOWED.has(file) && NAMES_MINT.test(text)) out.push(`${file}: names the mint`);
    if (!ALLOWED.has(file) && !/publish-decision-(?:actions|card-core)/.test(text)) continue;
    const sf = parse(file, text);
    if (ALLOWED.has(file)) out.push(...exemptViolations(file, sf));
    out.push(...handleViolations(file, sf, exports));
  }
  return out;
}

const files = listSourceFiles(ROOT).map((file) => ({ file, text: readFileSync(path.join(ROOT, file), "utf8") }));
const textOf = (file: string) => files.find((f) => f.file === file)?.text ?? "";
const EXPORTS: Exports = {
  actions: exportNames(textOf(DEFINER), DEFINER),
  "card-core": exportNames(textOf(RE_EXPORTER), RE_EXPORTER),
};

describe("the widget publish grant's mint sites, across the whole repository", () => {
  it("is defined once, re-exported by its subpath, and named only by the two widget publish routes", () => {
    expect(files.filter(({ text }) => NAMES_MINT.test(text)).map(({ file }) => file)).toEqual([...ALLOWED].sort());
    expect(textOf(DEFINER).match(new RegExp(String.raw`export function ${MINT}\(`, "g"))).toHaveLength(1);
    for (const caller of CALLERS) expect(textOf(caller)).toContain(`${MINT}(`);
  });

  it("no other module reaches the mint in any import form", () => {
    expect(findMintViolations(files, EXPORTS)).toEqual([]);
  });

  it("reads every tracked source root, test files excepted", () => {
    const paths = files.map(({ file }) => file);
    for (const prefix of ["src/app/", "src/lib/", "packages/agents/src/", "packages/chat/src/", "packages/extensions/src/",
      "packages/sdk-extensions/src/", "scripts/", "migrations/", "tests/", "vitest/"]) {
      expect(paths.some((file) => file.startsWith(prefix)), prefix).toBe(true);
    }
    expect(paths).toContain("next.config.ts");
    expect(paths).toContain(".pnpmfile.cjs");
    expect(paths.some((file) => file.includes("/__tests__/") || file.includes("node_modules/") || TEST_FILE.test(file))).toBe(false);
  });
});

describe("the scanner refuses every import form of the mint (fixtures)", () => {
  const caught = (file: string, text: string) => findMintViolations([{ file, text }], EXPORTS);
  const CORE = "@cinatra-ai/agents/publish-decision-card-core";

  it.each([
    ["an aliased import in another package", "packages/notifications/src/notify.ts",
      `import { ${MINT} as grantFor } from "${CORE}";\nexport const g = grantFor(c, id);`],
    ["an aliased re-export in a synced extension", "extensions/acme/tool/src/index.ts", `export { ${MINT} as mint } from "${CORE}";`],
    ["a renamed destructured dynamic import in a script", "scripts/ops/grant.mjs",
      `const { ${MINT}: m } = await import("../../packages/agents/src/publish-decision-actions.ts");`],
    ["a destructured require", "packages/cli/src/run.cjs", `const { ${MINT} } = require("${CORE}");`],
    ["a namespace member", "src/lib/other.ts", `import * as core from "${CORE}";\ncore.${MINT}(c, id);`],
    ["a computed read of a namespace handle", "src/lib/other.ts",
      `import * as core from "${CORE}";\nconst k = ["mint", "Widget"].join("");\n(core as never)[k];`],
    ["a namespace handle passed on", "packages/chat/src/x.ts", `import * as core from "${CORE}";\nregister(core);`],
    ["a whole re-export", "packages/agents/src/barrel.ts", `export * from "./publish-decision-actions";`],
    ["an unbound dynamic import", "packages/agents/src/late.ts", `void import("./publish-decision-actions").then((m) => use(m));`],
    ["a destructuring with a rest", "packages/agents/src/late.ts", `const { holdRunAtPublishGate, ...rest } = await import("./publish-decision-actions");`],
    ["a loaded handle read by a computed key", "packages/agents/src/late.ts", `const h = await import("./publish-decision-actions");\nh[name]();`],
    // each of these passed the scanner's earlier, text-only form
    ["a comment inside the import statement", "src/lib/other.ts",
      `import/*gap*/ * as core from "${CORE}";\nconst k = ["mint", "Widget"].join("");\n(core as never)[k];`],
    ["an unawaited dynamic import read through then", "src/lib/other.ts",
      `const loaded = import("${CORE}");\nloaded.then((core) => Reflect.get(core, name)(claims, runId));`],
    ["an aliased re-export added inside the re-exporting subpath", RE_EXPORTER,
      `export { ${MINT} } from "./publish-decision-actions";\nexport { ${MINT} as grantForWidget } from "./publish-decision-actions";`],
    ["an alias kept inside the defining module", DEFINER, `export function ${MINT}() { return null; }\nexport const grantFor = ${MINT};`],
    ["an aliased import in a widget publish route", CALLERS[0], `import { ${MINT} as g } from "${CORE}";\ng(c, id);`],
    ["a module of the mint under migrations", "migrations/0999_grant.mjs", `const core = require("${CORE}");\nmodule.exports = (k) => core[k];`],
    ["a default import with interop", "scripts/x.mjs", `import core from "${CORE}";\nObject.values(core)[0](c, id);`],
    ["an import equals require", "packages/cli/src/x.ts", `import core = require("${CORE}");\nReflect.get(core, k);`],
    ["a then read of an awaited handle", "packages/agents/src/late.ts", `const h = await import("./publish-decision-actions");\nh.then(use);`],
    ["a namespace re-export", "packages/agents/src/barrel.ts", `export * as hold from "./publish-decision-actions";`],
  ])("%s is caught", (_label, file, text) => {
    expect(caught(file, text).length).toBeGreaterThan(0);
    expect(caught(file, text)[0]).toContain(file);
  });

  it("leaves the forms that cannot reach the mint, and the exempt modules as they are, alone", () => {
    expect(caught("packages/agents/src/late.ts", `const publishHold = await import("./publish-decision-actions");\nawait publishHold.assertNoOpenPublishDecision(id);\ntype T = Awaited<ReturnType<typeof publishHold.claimRunBeforeSend>>;`)).toEqual([]);
    expect(caught("packages/agents/src/late.ts", `const { sweepExpiredPublishDecisions } = await import("./publish-decision-actions");`)).toEqual([]);
    expect(caught("packages/agents/src/x.ts", `import { holdRunAtPublishGate } from "./publish-decision-actions";`)).toEqual([]);
    expect(caught("src/lib/org-write/x.ts", `const owned = ["packages/agents/src/publish-decision-actions.ts"];`)).toEqual([]);
    expect(caught(RE_EXPORTER, `import { approvePublishDecision } from "./publish-decision-actions";\nexport { ${MINT} } from "./publish-decision-actions";`)).toEqual([]);
    expect(caught(CALLERS[1], `import { ${MINT}, publishDecisionCardStateForRun } from "${CORE}";\nconst g = ${MINT}(c, id);`)).toEqual([]);
    for (const file of ALLOWED) expect(caught(file, textOf(file))).toEqual([]);
  });
});
