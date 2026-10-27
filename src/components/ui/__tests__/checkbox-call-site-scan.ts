// The source scan behind `checkbox-call-site-readings-4297.test.ts`
// (cinatra#4297, Done-when 2 and 3).
//
// It finds every place in the application (`src/`) and the shared packages
// (`packages/`) whose code refers to a checkbox, and every checkbox element it
// can name, so the test can hold the recorded readings to the live tree in both
// directions: a site without a reading fails, and a reading whose site is gone
// fails.
//
// The scan reads the TypeScript syntax tree of each file (`ts.createSourceFile`
// of the repository's own `typescript`), never its text: a comment or the text
// of a string or template is no element and no evidence, and every element is
// one node with its own position, so each call site gets its own reading.
//
// Seven rules keep the scan fail-closed:
//
//   1. THE WHOLE TREE. Files come from `git ls-files --cached --others
//      --exclude-standard` over `src/` and `packages/` (the toast-import-guard
//      road): every tracked or new, not-ignored .ts, .tsx, .mts, .cts, .js,
//      .jsx, .mjs or .cjs file, and never a node_modules tree. A git failure, an
//      empty listing or a listed file that cannot be read throws; it is never an
//      empty result. A file that does not parse is a problem no reading clears,
//      and a root `tsconfig.json` that does not parse, or whose `paths` are no
//      map of string lists, throws, as does one with `extends` or
//      `compilerOptions.baseUrl` (which the scan does not read) or whose
//      `compilerOptions` or `paths` is null or no object; so does a workspace
//      `package.json` that is no JSON object or has a malformed `exports` or a
//      malformed `main`, with or without `exports`. Only an absent root
//      `tsconfig.json` or `package.json` (ENOENT) is none; every other read
//      error throws.
//   2. ANY REFERENCE COUNTS. A file is in scope when its text holds any
//      checkbox token (`CHECKBOX_TOKEN`): an identifier that contains
//      `Checkbox` from a capital C in any letter case after it (`CheckBox`,
//      `CHECKBOX`), or the word checkbox in any letter case as a quoted value
//      (`type="CHECKBOX"`, `role='checkbox'`), `menuitemcheckbox`, `=checkbox`,
//      `checkbox]`, a `ui/checkbox` import or `react-checkbox`. It is also in
//      scope when it holds a site of rules 4 or 5 without any token, a load
//      of rule 5 that binds no name, or an export of a checkbox name (rule 3,
//      `export const checkbox`). The number of tokens is recorded per file,
//      so any new reference in a read file changes the count and fails until
//      the file is read again.
//   3. NAMES ARE RESOLVED, NOT MATCHED. A name is a checkbox when it is spelled
//      with checkbox in any letter case, from any letter (`Checkbox`,
//      `CheckBox`, `MenuCHECKBOXItem`, `checkbox` in `{ checkbox as Box }`,
//      `Kit.checkbox` or `{ checkbox: Box }`), is bound by an
//      import whose module names a checkbox, or is bound to such a name in its
//      file: a renamed import (`{ Checkbox as Tick }`), `const Tick = R.Checkbox`
//      (through parentheses, `as`, `!`, `? :`, `||`, `??` and `&&`), a
//      destructured key (`const { Checkbox: Box } = R`, a parameter's
//      `({ Checkbox: Box })`). A name another file exports a checkbox under
//      (`export { Tick }`, `export { Checkbox as Tick }`, `export const Tick =
//      Checkbox`) is a checkbox in every file, followed until no new name
//      appears. A checkbox exported as a default export (`export default
//      Checkbox`, `export default function Checkbox`, `export { X as default }`,
//      and a default re-export from a module that names a checkbox: `export {
//      Root as default } from "@radix-ui/react-checkbox"`, `export { default }
//      from`, `export * as default from`) cannot be followed by name, so it is a
//      problem no reading clears. So is a whole re-export of a module that
//      names a checkbox (`export * from "@radix-ui/react-checkbox"`, `export *
//      from "./checkbox"`): which names it hands on no name follows. A
//      type-only re-export (`export type * from`) renders nothing and is not
//      refused. A module NAMES A CHECKBOX by one resolution that feeds every rule:
//      its specifier, every target of the root `tsconfig.json` path aliases it
//      matches and every file of a workspace package's entries it matches,
//      where a match is the UNION of the exact entry and every `*` entry, never
//      the first one alone. A
//      member key the syntax settles is a name like `R.Checkbox`, on any value:
//      `R["Check" + "box"]`, a template of strings, a choice of strings, a
//      number, and the same as a destructured key (`{ ["Check" + "box"]: B }`).
//   4. EVERY ELEMENT. A site is a JSX element whose tag has a segment that is a
//      checkbox name or holds checkbox in any letter case (`<UI.Tick />`,
//      `<M.CheckboxItem />`, `<CheckBox />`, `<md-checkbox>`, `<sl-checkbox>`);
//      any element whose `type` or `role` is the word checkbox or
//      menuitemcheckbox in any letter case (a literal, or a literal inside its
//      expression); an element whose `role` is an expression, or whose role a
//      later spread may set; and an `input` or `Input`-named wrapper whose
//      `type` is an expression or that has a spread after its last literal type
//      (a spread before a literal is overridden by it). Attributes are read in
//      source order, an object-literal spread by its own keys (a computed key
//      by the strings it settles to), and a `+` or a template of strings by its
//      strings. A package.json whose root, `exports` or `main` is malformed
//      leaves its entries unknown. An element the
//      scan cannot settle is UNRESOLVED and must be read.
//   5. EVERY OTHER USE IS A SITE. A checkbox name used as a value anywhere but
//      a JSX tag, an import or export, a declaration, a type or an alias of rule
//      3 (passed on, put in an object, given to createElement or memo, assigned
//      to `module.exports`) is an UNRESOLVED site that must be read. So is
//      every use of a MODULE OBJECT the scan cannot follow by name: a name
//      bound to a whole module (`import * as P`, `import P = require()`, a
//      `require()` or `import()` bound to a name, an alias or a rest of one) of
//      a module that may export a checkbox (`moduleObjectsOf`: a file of the
//      tree that exports a checkbox name or re-exports such a module whole,
//      the root `tsconfig.json` path aliases and the workspace packages'
//      `package.json` entries resolved to their files; and
//      any module outside the tree but a Node built-in, which the scan does not
//      read). A computed member of it anywhere in a chain (`P[k]`, `P.a[k]`)
//      or a computed destructuring key on it (`const { [k]: B } = P`) whose key
//      the syntax does not settle, and any use of it as a value but a member
//      read by name (passed on, put in an object, spread, exported, `export *
//      as`), is a site; a file that re-exports a module outside the tree whole
//      is such a module too. A VALUE FROM OUTSIDE THE TREE is a name bound by
//      any import or load of a module outside the tree (a default or named
//      import, `.default` of a load, a destructured `default`), a name another
//      file exports such a value under (followed only under that exported name)
//      or imports from such a re-exporting file, and a name bound to a member read or a call of one (`const UI =
//      makeUi()`); React's hooks hand back their arguments (`useState({})` is
//      the tree's value, `useContext(OutsideCtx)` is from outside). A computed
//      member or a computed destructuring key of such a value is a site. A load
//      of a module outside the tree that binds no name (`() => import("@x/y")`,
//      `[import("x")]`, `import("x").then(...)`, an element access on a load,
//      `import("x")["then"]` and `require("x")["a"]` too, as no element access
//      names an export; `module.require` and `module["require"]` load like
//      `require`), and every load whose
//      specifier is no string (`import(url)`, bound or not), hands a module on
//      that no name follows: the file's reading names those loads (their
//      number, a pattern each matches, a sentence), so a new one fails until
//      it is read. A value of the tree (a local, a prop, an import of a file of
//      the tree) holds a checkbox only through a use this rule makes a site
//      where it enters (a checkbox name, a module object, a load). LIMITS: the
//      scan follows names in one file, not scopes (a parameter that shares a
//      name with an outside value counts as one); a value from outside handed
//      on whole as a value (an argument, a prop, an object value, a return)
//      and a value an outside module passes to a callback of the tree are not
//      followed into the code that receives them; a value from outside that a
//      tree file exports is followed only under its own exported name, so a
//      rename on import (`import { ui as kit }`) or on re-export
//      (`export { ui as kit } from "./ui"`), a namespace import of the
//      exporting file or of a barrel of it (`import * as U from "./ui";
//      U.ui[k]`, `const { ui } = U`), a default export of it and a re-import
//      under another name are not followed (the tree had no site of these
//      forms when this was written); rule 4 reads JSX elements,
//      so `createElement("input", { type: t })` is a site only where it names
//      a checkbox or holds the word.
//   6. IDENTITY, NOT COUNTS. Each recorded site names an anchor that must stand
//      in exactly one found site of its file, with the same tag; so removing one
//      checkbox and adding another in the same file fails even though the count
//      of sites is unchanged. Every change handler (`on…`) and every spread of
//      an element must be named by the reading, of a call site of a shared
//      component too: by its whole text or by a prefix of it that reaches past
//      its `=` or `{...`, so what a handler does after a pinned prefix is not
//      held (a stated limit).
//   7. NO EMPTY READING. Every text a reading holds must hold more than white
//      space; a reading and a reason are sentences of 20 characters at least. A
//      pinned text must stand in the CODE of its file: not only in a comment and
//      not only inside a string or template. A switch counts as drawn only as a
//      JSX element inside the site's element, by name (a tag segment `Switch`,
//      a name bound to it, or one imported from a module that names a switch),
//      that is drawn whenever the element is: one under a choice (`? :`, `&&`,
//      `||`, `??`) or in a function (`rows.map`, a render prop) may be drawn, so
//      neither a switch nor a checkbox is claimed. A module is resolved as in
//      rule 3: it surely names a switch only when every file its path aliases or
//      workspace entries resolve it to (its spelling when none) names one; it
//      may name one when any does. A name is surely a switch only by what its
//      file binds itself: a name another file exports a switch under may be a
//      switch, never surely. A tag with a segment that is a checkbox name (a
//      name from a module that names a checkbox is one) draws no sure switch. A name that may
//      be a switch is enough to refuse a checkbox claim, and not enough for a
//      switch claim. A name spelled `Switch` counts wherever it comes from,
//      unless rule 3 resolves it as a checkbox name too, so a local `Switch`
//      component or `const Switch = memo(Checkbox)` counts (a stated limit, K13).
//
// LIMIT of the whole scan: the files are listed and read once, with no snapshot
// or lock, so a file added or changed while a run reads the tree may be missed
// or read in two states by that run; the next run reads it.
//
// Callers (`COMPONENT_CALLERS` in the readings): a shared component whose box
// is read at its callers is resolved by the same rules under its own name, and
// each of its call sites (one JSX element) needs its own reading, which names
// the call site's handlers and spreads (`tagIncludes`). When only some elements
// are callers (`callerWhen`), an element without the attribute is no caller only
// by the component's default, which the reading pins (`callerWhen.absent`).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";

export const SCAN_ROOTS = ["src", "packages"] as const;

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

/** A test, mock or stub file is not a call site of the application. */
export function isTestPath(rel: string): boolean {
  const segments = rel.split("/");
  if (segments.some((s) => s === "__tests__" || s === "__mocks__" || s === "__stubs__")) return true;
  const base = segments[segments.length - 1] ?? "";
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(base);
}

/** The letters of `word` in either case, as a regular expression source. */
function anyCase(word: string): string {
  return [...word].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c)).join("");
}

const CB = anyCase("checkbox");

export const CHECKBOX_TOKEN = new RegExp(
  `C${anyCase("heckbox")}|["'\`]${CB}["'\`]|${anyCase("menuitem")}${CB}|=${CB}|${CB}\\]|ui\\/${CB}|react-${CB}`,
  "g",
);

export function countCheckboxTokens(text: string): number {
  return (text.match(CHECKBOX_TOKEN) ?? []).length;
}

/** Every tracked or new, not-ignored source file under the scan roots, repo-relative. */
export function listSourceFiles(repoRoot: string): string[] {
  // `:(glob)` makes `**/` match zero or more folders, so a file right under a root (`src/proxy.ts`) is listed
  // too; a plain pathspec `src/**/*.ts` needs a folder between `src/` and the file.
  const globs = SCAN_ROOTS.flatMap((root) => SOURCE_EXTENSIONS.map((ext) => `:(glob)${root}/**/*${ext}`));
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...globs],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  const files = out.split("\0").filter((p) => p.length > 0);
  if (files.length === 0) throw new Error(`git ls-files listed no source file under ${SCAN_ROOTS.join(", ")}`);
  return files.sort();
}

// ---------------------------------------------------------------------------
// The syntax tree
// ---------------------------------------------------------------------------

/** The script kind the compiler gives the file's extension; an unknown extension throws. */
export function scriptKindOf(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  if (/\.[cm]?ts$/.test(file)) return ts.ScriptKind.TS;
  throw new Error(`${file}: not a source file the scan reads`);
}

export function parseSource(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindOf(file));
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** The parse errors of a file, each as `file:line: message`; [] when it parses. */
export function parseErrors(sf: ts.SourceFile): string[] {
  const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return diagnostics.map((d) => `${sf.fileName}:${lineOf(sf, d.start ?? 0)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}

/** Parentheses, `as`, `satisfies`, `!`, `<T>x` and `X<T>` taken off an expression. */
function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) {
      e = e.expression;
    } else if (ts.isExpressionWithTypeArguments(e)) {
      e = e.expression;
    } else {
      return e;
    }
  }
}

function isStringLike(e: ts.Node): e is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e);
}

/** At most this many strings are followed for one key; a key that can take more is unsettled. */
const KEY_LIMIT = 64;

/**
 * The strings a member key or a computed key settles to (G1): a string, a
 * number, a template of settled parts, `+` of settled parts, or a choice of
 * them (`? :`, `||`, `??`). Null when the syntax does not settle the key
 * (`P[k]`, `P[name.trim()]`): such a key is a computed key no name follows.
 */
export function keyStrings(expr: ts.Expression): string[] | null {
  const e = unwrap(expr);
  if (isStringLike(e)) return [e.text];
  if (ts.isNumericLiteral(e)) return [String(Number(e.text))];
  const product = (a: string[] | null, b: string[] | null): string[] | null => {
    if (a === null || b === null || a.length * b.length > KEY_LIMIT) return null;
    return a.flatMap((x) => b.map((y) => x + y));
  };
  if (ts.isTemplateExpression(e)) {
    let out: string[] | null = [e.head.text];
    for (const span of e.templateSpans) out = product(product(out, keyStrings(span.expression)), [span.literal.text]);
    return out;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return product(keyStrings(e.left), keyStrings(e.right));
  if (ts.isConditionalExpression(e)) {
    const a = keyStrings(e.whenTrue);
    const b = keyStrings(e.whenFalse);
    return a && b && [...a, ...b];
  }
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) {
    const a = keyStrings(e.left);
    const b = keyStrings(e.right);
    return a && b && [...a, ...b];
  }
  return null;
}

/**
 * The names an alias takes its value from, when `expr` is an alias form: a
 * name, a member chain (`R.Checkbox`, `R["Checkbox"]`), or a choice of such
 * forms (`? :`, `||`, `??`, `&&`) whose conditions are `rest`. Any other
 * expression (a call, a function, an object) is no alias: null.
 */
export function aliasSources(expr: ts.Expression): { names: string[]; rest: ts.Expression[] } | null {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return { names: [e.text], rest: [] };
  if (e.kind === ts.SyntaxKind.ThisKeyword || e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) {
    return { names: [], rest: [] };
  }
  if (isStringLike(e) || ts.isNumericLiteral(e)) return { names: [], rest: [] };
  if (ts.isPropertyAccessExpression(e)) {
    const inner = aliasSources(e.expression);
    return inner && { names: [...inner.names, e.name.text], rest: inner.rest };
  }
  if (ts.isElementAccessExpression(e)) {
    const keys = keyStrings(e.argumentExpression);
    if (keys === null) return null;
    const inner = aliasSources(e.expression);
    return inner && { names: [...inner.names, ...keys], rest: inner.rest };
  }
  if (ts.isConditionalExpression(e)) {
    const a = aliasSources(e.whenTrue);
    const b = aliasSources(e.whenFalse);
    return a && b && { names: [...a.names, ...b.names], rest: [e.condition, ...a.rest, ...b.rest] };
  }
  if (
    ts.isBinaryExpression(e) &&
    [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)
  ) {
    const a = aliasSources(e.left);
    const b = aliasSources(e.right);
    return a && b && { names: [...a.names, ...b.names], rest: [...a.rest, ...b.rest] };
  }
  return null;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

/** Whether a callee loads a module: `import`, `require` or `module.require` (pre-3 MF4). */
function isLoadCallee(callee: ts.Expression): boolean {
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  const c = unwrap(callee);
  if (ts.isIdentifier(c)) return c.text === "require";
  if (ts.isPropertyAccessExpression(c)) return c.name.text === "require" && ts.isIdentifier(c.expression) && c.expression.text === "module";
  // `module["require"]` and any key that settles to require (pre-4 NOTE).
  if (ts.isElementAccessExpression(c)) return ts.isIdentifier(c.expression) && c.expression.text === "module" && (keyStrings(c.argumentExpression) ?? []).includes("require");
  return false;
}

/** The module a call imports, when it is `require("x")`, `module.require("x")` or `import("x")` (awaited or not). */
function importedModule(expr: ts.Expression): string | undefined {
  let e = unwrap(expr);
  if (ts.isAwaitExpression(e)) e = unwrap(e.expression);
  if (!ts.isCallExpression(e) || e.arguments.length === 0 || !isStringLike(e.arguments[0])) return undefined;
  if (isLoadCallee(e.expression)) return e.arguments[0].text;
  return undefined;
}

/** A load whose specifier is no string (`import(spec)`, `require(spec)`): which module it is, the syntax does not say (GAP 1). */
function dynamicLoad(expr: ts.Expression): string | undefined {
  let e = unwrap(expr);
  if (ts.isAwaitExpression(e)) e = unwrap(e.expression);
  if (!ts.isCallExpression(e) || e.arguments.length === 0 || isStringLike(e.arguments[0])) return undefined;
  const callee = e.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return `import(${e.arguments[0].getText().replace(/\s+/g, " ")})`;
  if (isLoadCallee(callee)) return `require(${e.arguments[0].getText().replace(/\s+/g, " ")})`;
  return undefined;
}

/**
 * Where a value comes from (GAP 1): the names and the loaded modules at the head of its member reads and calls,
 * through `await`, `new`, parentheses, `as`, `!` and choices (`UI.registry`, `makeUi().parts`, `(await
 * import("m")).default`, `a ? P : Q`). A dynamic load (`import(spec)`) is the module `DYNAMIC`.
 */
export const DYNAMIC = "\0a module the syntax does not name";

/**
 * React's hooks that hand back what the code gives them (state, a reducer's state, a memo, a ref, a context's value,
 * a deferred or optimistic value): such a value comes from the hook's arguments, not from React.
 */
const HOOKS_OF_ARGUMENTS = new Set([
  "useState", "useReducer", "useMemo", "useCallback", "useRef", "useContext", "use", "useDeferredValue",
  "useOptimistic", "useActionState", "useTransition", "useSyncExternalStore", "useImperativeHandle", "useId",
]);

export function valueHeads(expr: ts.Expression): { names: string[]; specs: string[] } {
  const names: string[] = [];
  const specs: string[] = [];
  /** What a function hands back: its expression body or each `return` of its block (not of nested functions). */
  const returns = (f: ts.ArrowFunction | ts.FunctionExpression): void => {
    if (!ts.isBlock(f.body)) return walk(f.body);
    const inner = (n: ts.Node): void => {
      if (ts.isReturnStatement(n) && n.expression) walk(n.expression);
      else if (!ts.isFunctionLike(n)) ts.forEachChild(n, inner);
    };
    inner(f.body);
  };
  const walk = (x: ts.Expression): void => {
    let e = unwrap(x);
    if (ts.isAwaitExpression(e)) e = unwrap(e.expression);
    if (ts.isIdentifier(e)) names.push(e.text);
    else if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isNewExpression(e)) walk(e.expression);
    else if (ts.isCallExpression(e)) {
      const spec = importedModule(e);
      const callee = unwrap(e.expression);
      const hook = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (spec !== undefined) specs.push(spec);
      else if (dynamicLoad(e) !== undefined) specs.push(DYNAMIC);
      else if (hook !== undefined && HOOKS_OF_ARGUMENTS.has(hook)) {
        for (const a of e.arguments) {
          const u = unwrap(a);
          if (ts.isArrowFunction(u) || ts.isFunctionExpression(u)) returns(u);
          else walk(a);
        }
      } else if (e.expression.kind !== ts.SyntaxKind.ImportKeyword) walk(e.expression);
    } else if (ts.isConditionalExpression(e)) {
      walk(e.whenTrue);
      walk(e.whenFalse);
    } else if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) {
      walk(e.left);
      walk(e.right);
    }
  };
  walk(expr);
  return { names, specs };
}

function boundNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) boundNames(el.name, out);
  return out;
}

/** What a file binds and exports, as edges over names (rule 3). */
export type FileBindings = {
  /** A local name and the names its value is taken from. */
  edges: [string, string[]][];
  /** The modules each local name is imported from. */
  imports: [string, string][];
  /** An exported name and the local names it is taken from. */
  exports: [string, string[]][];
  /** Each default export, the names it is taken from and, for a re-export, its module (pre-3 MF3). */
  defaults: { line: number; from: string[]; spec?: string }[];
  /** A name exported straight from another module (`export { X as Y } from "m"`, `export * as Y from "m"`) and that module. */
  reexports: [string, string][];
  /**
   * A name bound to a whole module object and that module (G1): `import * as P from "m"`, `import P = require("m")`,
   * `const P = require("m")`, `const P = await import("m")`.
   */
  holders: [string, string][];
  /** A name bound to the whole value of other names (`const Q = P`, `const Q = a ? P : R`, `const { ...Q } = P`). */
  wholes: [string, string[]][];
  /** The modules a file re-exports whole (`export * from "m"`). */
  stars: string[];
  /** A name bound by a declaration and where its value comes from (`valueHeads` of the initializer; GAP 1). */
  derived: [string, { names: string[]; specs: string[] }][];
};

/** The names an expression is the whole value of: a name, or a choice of names (`? :`, `||`, `??`, `&&`). */
function wholeNames(expr: ts.Expression): string[] {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return [e.text];
  if (ts.isConditionalExpression(e)) return [...wholeNames(e.whenTrue), ...wholeNames(e.whenFalse)];
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) {
    return [...wholeNames(e.left), ...wholeNames(e.right)];
  }
  return [];
}

export function collectBindings(sf: ts.SourceFile): FileBindings {
  const b: FileBindings = { edges: [], imports: [], exports: [], defaults: [], reexports: [], holders: [], wholes: [], stars: [], derived: [] };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isStringLike(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.name) b.imports.push([clause.name.text, spec]);
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) {
        b.imports.push([nb.name.text, spec]);
        b.holders.push([nb.name.text, spec]);
      }
      if (nb && ts.isNamedImports(nb)) {
        for (const s of nb.elements) {
          b.imports.push([s.name.text, spec]);
          b.edges.push([s.name.text, [(s.propertyName ?? s.name).text]]);
        }
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref) && isStringLike(ref.expression)) {
        b.imports.push([node.name.text, ref.expression.text]);
        b.holders.push([node.name.text, ref.expression.text]);
      } else b.edges.push([node.name.text, ref.getText(sf).split(".")]);
    } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      const spec = node.moduleSpecifier && isStringLike(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
      for (const s of node.exportClause.elements) {
        const local = (s.propertyName ?? s.name).text;
        // A type-only export renders nothing, so it is no default export of a checkbox (pre-4 NOTE).
        if (s.name.text === "default" && !node.isTypeOnly && !s.isTypeOnly) b.defaults.push({ line: lineOf(sf, s.getStart(sf)), from: [local], spec });
        else if (s.name.text === "default") continue;
        else b.exports.push([s.name.text, [local]]);
        if (spec !== undefined) b.reexports.push([s.name.text, spec]);
      }
    } else if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier && isStringLike(node.moduleSpecifier)) {
      if (!node.isTypeOnly) b.stars.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamespaceExport(node.exportClause) && node.moduleSpecifier && isStringLike(node.moduleSpecifier)) {
      b.reexports.push([node.exportClause.name.text, node.moduleSpecifier.text]);
      // `export * as default from "m"` is a default export of the whole module (pre-3 MF3).
      if (node.exportClause.name.text === "default" && !node.isTypeOnly) b.defaults.push({ line: lineOf(sf, node.getStart(sf)), from: [], spec: node.moduleSpecifier.text });
    } else if (ts.isExportAssignment(node)) {
      const src = aliasSources(node.expression);
      if (src) b.defaults.push({ line: lineOf(sf, node.getStart(sf)), from: src.names });
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && hasModifier(node, ts.SyntaxKind.ExportKeyword) && node.name) {
      if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) b.defaults.push({ line: lineOf(sf, node.getStart(sf)), from: [node.name.text] });
      else b.exports.push([node.name.text, [node.name.text]]);
    } else if (ts.isVariableStatement(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      for (const d of node.declarationList.declarations) for (const n of boundNames(d.name)) b.exports.push([n, [n]]);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const src = aliasSources(node.initializer);
      const mod = importedModule(node.initializer);
      const heads = valueHeads(node.initializer);
      for (const n of boundNames(node.name)) {
        if (src) b.edges.push([n, src.names]);
        if (mod !== undefined) b.imports.push([n, mod]);
        if (heads.names.length > 0 || heads.specs.length > 0) b.derived.push([n, heads]);
      }
      if (ts.isIdentifier(node.name)) {
        if (mod !== undefined) b.holders.push([node.name.text, mod]);
        const whole = wholeNames(node.initializer);
        if (whole.length > 0) b.wholes.push([node.name.text, whole]);
      }
    }
    // `const { a, ...Q } = P`: the rest is the whole of P but its named keys, so a module object's rest is one too.
    if (ts.isBindingElement(node) && node.dotDotDotToken && ts.isIdentifier(node.name) && ts.isObjectBindingPattern(node.parent)) {
      const decl = node.parent.parent;
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        const mod = importedModule(decl.initializer);
        if (mod !== undefined) b.holders.push([node.name.text, mod]);
        const whole = wholeNames(decl.initializer);
        if (whole.length > 0) b.wholes.push([node.name.text, whole]);
      }
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName;
      const computed = key !== undefined && ts.isComputedPropertyName(key) ? unwrap(key.expression) : undefined;
      const keyNames =
        key === undefined ? [node.name.text] : ts.isIdentifier(key) || isStringLike(key) || ts.isNumericLiteral(key) ? [key.text] : computed ? keyStrings(computed) : null;
      // A computed key the syntax settles (`{ ["Check" + "box"]: Box }`) names its keys. One it does not settle
      // (`{ [k]: Box }`) names no key: the bound name keeps the edge of its declaration's initializer (a destructured
      // checkbox namespace stays a checkbox), and on a module object it is a site of its own (G1, `findSites`).
      if (keyNames !== null) b.edges.push([node.name.text, keyNames]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return b;
}

/** The names of one target resolved over a tree (rule 3). */
export type NameScope = {
  /** Names a file exports the target under, beyond the target's own spelling. */
  exported: Set<string>;
  /** Default exports of the target: `file:line`. */
  defaults: string[];
  /**
   * Whole re-exports of a module that names the target (`export * from "@radix-ui/react-checkbox"`): `file:line`.
   * Which names such a file hands on no name follows, so each is a problem no reading clears (pre-3 MF2).
   */
  stars: string[];
  /** Whether `name` is the target in `file`. */
  isName: (file: string, name: string) => boolean;
};

/**
 * Resolves the target's names over every file: `target` says which spellings
 * are the target, `targetModule` which imported modules bind it. Without
 * `followExports`, a file's names are only what it binds itself (its spelling,
 * its imports from a target module and its own aliases of them), never a name
 * another file exports the target under (fold 6).
 */
export function resolveNames(
  sources: ReadonlyMap<string, ts.SourceFile>,
  target: (name: string) => boolean,
  targetModule: (spec: string) => boolean = () => false,
  followExports = true,
): NameScope {
  const bindings = new Map([...sources].map(([file, sf]) => [file, collectBindings(sf)] as const));
  const exported = new Set<string>();
  const local = new Map<string, Set<string>>();
  const localOf = (file: string, b: FileBindings): Set<string> => {
    const set = new Set(b.imports.filter(([, spec]) => targetModule(spec)).map(([n]) => n));
    const is = (n: string) => target(n) || exported.has(n) || set.has(n);
    let size = -1;
    while (set.size !== size) {
      size = set.size;
      for (const [name, from] of b.edges) if (!set.has(name) && from.some(is)) set.add(name);
    }
    local.set(file, set);
    return set;
  };
  let size = -1;
  while (exported.size !== size) {
    size = exported.size;
    for (const [file, b] of bindings) {
      const set = localOf(file, b);
      if (!followExports) continue;
      for (const [name, from] of b.exports) {
        if (!target(name) && from.some((n) => target(n) || exported.has(n) || set.has(n))) exported.add(name);
      }
      for (const [name, spec] of b.reexports) if (!target(name) && targetModule(spec)) exported.add(name);
    }
  }
  const isName = (file: string, name: string) => target(name) || exported.has(name) || (local.get(file)?.has(name) ?? false);
  const defaults: string[] = [];
  for (const [file, b] of bindings) {
    for (const d of b.defaults) if (d.from.some((n) => isName(file, n)) || (d.spec !== undefined && targetModule(d.spec))) defaults.push(`${file}:${d.line}`);
  }
  const stars: string[] = [];
  for (const [file, sf] of sources) {
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st) && !st.isTypeOnly && !st.exportClause && st.moduleSpecifier && isStringLike(st.moduleSpecifier) && targetModule(st.moduleSpecifier.text)) {
        stars.push(`${file}:${lineOf(sf, st.getStart(sf))}`);
      }
    }
  }
  return { exported, defaults: defaults.sort(), stars: stars.sort(), isName };
}

// ---------------------------------------------------------------------------
// Elements and uses
// ---------------------------------------------------------------------------

/**
 * The value an attribute has after every attribute and spread of the element,
 * in source order. An expression carries `values`, the strings it can take,
 * when it is built only of strings, `undefined`, `null` and choices between
 * them (`? :`, `||`, `??`, `&&`); otherwise `values` is null (unknown).
 */
export type AttributeValue =
  | { kind: "absent" }
  | { kind: "literal"; value: string }
  | { kind: "expression"; text: string; values: string[] | null; literals: string[] }
  | { kind: "spread"; text: string; over: "absent" | "literal" | "expression" };

function literalsIn(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (isStringLike(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** The strings an expression can take, or null when it can take a value the syntax does not settle. */
export function stringValues(expr: ts.Expression): string[] | null {
  const e = unwrap(expr);
  if (isStringLike(e)) return [e.text];
  if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined") || ts.isVoidExpression(e)) return [];
  if (ts.isConditionalExpression(e)) {
    const a = stringValues(e.whenTrue);
    const b = stringValues(e.whenFalse);
    return a && b && [...a, ...b];
  }
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(e.operatorToken.kind)) {
    const a = stringValues(e.left);
    const b = stringValues(e.right);
    return a && b && [...a, ...b];
  }
  // A `+` or a template of settled parts (`"check" + "box"`) takes the strings it settles to (pre-4 NOTE).
  if (ts.isTemplateExpression(e) || (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken)) return keyStrings(e);
  // `a && "x"` is `"x"` or the falsy `a` (no string but ""), so only its right side can name a role or type.
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return stringValues(e.right);
  return null;
}

function valueOf(e: ts.Expression | undefined, sf: ts.SourceFile): AttributeValue {
  if (e === undefined) return { kind: "expression", text: "true", values: ["true"], literals: [] };
  const u = unwrap(e);
  if (isStringLike(u)) return { kind: "literal", value: u.text };
  return { kind: "expression", text: e.getText(sf), values: stringValues(e), literals: literalsIn(e) };
}

/** The keys a property name settles to: its text, or the strings a computed key settles to (pre-4 NOTE); null when unsettled. */
function keyTexts(name: ts.PropertyName): string[] | null {
  if (ts.isIdentifier(name) || isStringLike(name) || ts.isNumericLiteral(name)) return [name.text];
  if (ts.isComputedPropertyName(name)) return keyStrings(name.expression);
  return null;
}

export function resolveAttribute(el: ts.JsxOpeningLikeElement, name: string): AttributeValue {
  const sf = el.getSourceFile();
  let v: AttributeValue = { kind: "absent" };
  const spread = (text: string): AttributeValue => ({ kind: "spread", text, over: v.kind === "spread" ? v.over : v.kind });
  for (const p of el.attributes.properties) {
    if (ts.isJsxAttribute(p)) {
      if (p.name.getText(sf).toLowerCase() !== name) continue;
      const init = p.initializer;
      if (init === undefined) v = valueOf(undefined, sf);
      else if (ts.isStringLiteral(init)) v = { kind: "literal", value: init.text };
      else if (ts.isJsxExpression(init)) v = init.expression ? valueOf(init.expression, sf) : { kind: "expression", text: "", values: null, literals: [] };
      else v = { kind: "expression", text: init.getText(sf), values: null, literals: [] };
      continue;
    }
    const e = unwrap(p.expression);
    if (!ts.isObjectLiteralExpression(e)) {
      v = spread(p.getText(sf));
      continue;
    }
    for (const prop of e.properties) {
      if (ts.isSpreadAssignment(prop)) v = spread(prop.getText(sf));
      else if (prop.name === undefined || keyTexts(prop.name) === null) v = spread(prop.getText(sf));
      else if (!keyTexts(prop.name)!.some((k) => k.toLowerCase() === name)) continue;
      else if (ts.isPropertyAssignment(prop)) v = valueOf(prop.initializer, sf);
      else v = { kind: "expression", text: prop.getText(sf), values: null, literals: [] };
    }
  }
  return v;
}

const CHECKBOX_WORD = /^(checkbox|menuitemcheckbox)$/i;

function isInputTag(tag: string): boolean {
  return tag === "input" || /(?:^|\.)[A-Za-z_$]*Input$/.test(tag);
}

/** Whether an element draws a checkbox, may draw one (why it is unresolved), or does not (null). */
function checkboxByAttributes(tag: string, el: ts.JsxOpeningLikeElement): "checkbox" | string | null {
  const type = resolveAttribute(el, "type");
  const role = resolveAttribute(el, "role");
  for (const v of [type, role]) {
    if (v.kind === "literal" && CHECKBOX_WORD.test(v.value.trim())) return "checkbox";
    if (v.kind === "expression" && [...v.literals, ...(v.values ?? [])].some((l) => CHECKBOX_WORD.test(l.trim()))) return "checkbox";
  }
  if (role.kind === "expression" && role.values === null) return `its role is the expression {${role.text}}`;
  if (role.kind === "spread" && role.over !== "absent") return `the spread ${role.text} after its role may set it`;
  if (isInputTag(tag)) {
    if (type.kind === "expression" && type.values === null) return `its type is the expression {${type.text}}`;
    if (type.kind === "spread" && type.over === "absent") return "it has a spread and no literal type after it";
    if (type.kind === "spread") return `the spread ${type.text} after its type may set it`;
  }
  return null;
}

export type FoundSite = {
  /** The tag name as written (`Checkbox`, `CheckboxPrimitive.Root`), or the name of a use (rule 5). */
  tag: string;
  /** 1-based line of the element's `<`, or of the use. */
  line: number;
  /** The opening tag's text from `<` to its `>`, or for a use the text of the expression around it. */
  openingTag: string;
  /** The tags of the JSX elements among its children, drawn or not (empty when self-closing, or for a use). */
  childTags: string[];
  /**
   * The tags of those elements that are drawn whenever the element is: none inside a choice (`? :`, `&&`, `||`,
   * `??`) or a function (`rows.map((r) => <X />)`, a render prop), which may draw nothing (pre-3 NOTE).
   */
  drawnTags: string[];
  /**
   * Whether a child is a switch by name (rule 7, pre-4 NOTE, fold 5): `drawn`, surely one drawn whenever the element is;
   * `any`, one that may be a switch, drawn or not; `byName`, one that may be a switch, drawn whenever the element is.
   */
  switches: { drawn: boolean; any: boolean; byName: boolean };
  /** The texts of its change handlers (`on…` attributes) and spreads, each of which a reading must name. */
  mustName: string[];
  /** Why the scan cannot tell whether it draws a checkbox (rules 4 and 5), when it cannot. */
  unresolved?: string;
};

/** Whether a node draws its JSX only under a condition: a choice or a function. */
function mayDrawNothing(n: ts.Node): boolean {
  if (ts.isConditionalExpression(n) || ts.isFunctionLike(n)) return true;
  return (
    ts.isBinaryExpression(n) &&
    [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)
  );
}

function childTagsOf(el: ts.JsxOpeningLikeElement, sf: ts.SourceFile): { all: string[]; drawn: string[] } {
  const all: string[] = [];
  const drawn: string[] = [];
  if (!ts.isJsxOpeningElement(el) || !ts.isJsxElement(el.parent)) return { all, drawn };
  const visit = (n: ts.Node, sure: boolean) => {
    const here = sure && !mayDrawNothing(n);
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      all.push(n.tagName.getText(sf));
      if (here) drawn.push(n.tagName.getText(sf));
    }
    ts.forEachChild(n, (c) => visit(c, here));
  };
  for (const child of el.parent.children) visit(child, true);
  return { all, drawn };
}

function mustNameOf(el: ts.JsxOpeningLikeElement, sf: ts.SourceFile): string[] {
  return el.attributes.properties
    .filter((p) => ts.isJsxSpreadAttribute(p) || /^on[A-Z]/.test(p.name.getText(sf)))
    .map((p) => p.getText(sf));
}

function isTypeOnly(node: ts.Node): boolean {
  return ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node);
}

/** Whether an identifier names a declaration, a key or a label, not a value. */
function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isShorthandPropertyAssignment(p) || ts.isPropertyAccessExpression(p)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakStatement(p) || ts.isContinueStatement(p)) return p.label === id;
  if (ts.isMetaProperty(p)) return true;
  const named = p as unknown as { name?: ts.Node; propertyName?: ts.Node };
  return named.name === id || named.propertyName === id;
}

/**
 * The module objects of one file (G1): names bound to a whole module object of a module that may export a
 * checkbox (`isObject`), and which modules those are (`isObjectModule`).
 */
export type ModuleObjects = {
  isObject: (name: string) => boolean;
  isObjectModule: (spec: string) => boolean;
  /**
   * Whether a value comes from outside the tree (GAP 1): a name bound by any import or load of a module outside
   * the tree (a default, named or namespace import, a `require()` or `import()`, a destructured `default`), or bound
   * to a member read or a call of such a value; and a loaded module outside the tree or `DYNAMIC`.
   */
  isOutside: (heads: { names: string[]; specs: string[] }) => boolean;
};

const NO_MODULE_OBJECTS: ModuleObjects = { isObject: () => false, isObjectModule: () => false, isOutside: () => false };

const BUILTINS = new Set(builtinModules);

/** The file a module specifier ends in names: its base name, or its folder's name for an `index` file. */
function moduleKey(file: string): string {
  const base = path.posix.basename(file).replace(/\.[^.]+$/, "");
  return base === "index" ? path.posix.basename(path.posix.dirname(file)) : base;
}

/** A workspace package's entry points: each subpath (`.`, `./store`, `./*`) and the repo-relative files it names. */
export type PackageEntries = Map<string, string[]>;

/**
 * The entry points of `packages/<dir>/package.json` (`exports`, else `main`): every string an entry's
 * conditions hold, as a repo-relative file. Null when the text is no JSON object, or its `exports` or `main` is malformed.
 */
export function packageEntriesOf(dir: string, packageJson: string): PackageEntries | null {
  let json: unknown;
  try {
    json = JSON.parse(packageJson);
  } catch {
    return null;
  }
  // A root that is no object, or `exports` or `main` of the wrong kind (with or without the other, fold 6), gives null,
  // which workspaceEntries refuses (pre-4 NOTE, fold 5).
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const { exports, main } = json as { exports?: unknown; main?: unknown };
  if (exports !== undefined && typeof exports !== "string" && (typeof exports !== "object" || exports === null)) return null;
  if (main !== undefined && typeof main !== "string") return null;
  const leaves = (v: unknown): string[] =>
    typeof v === "string" ? [v] : typeof v === "object" && v !== null ? Object.values(v).flatMap(leaves) : [];
  const file = (t: string) => path.posix.normalize(`packages/${dir}/${t}`);
  const out: PackageEntries = new Map();
  const subpaths = typeof exports === "object" && exports !== null && !Array.isArray(exports) && Object.keys(exports).every((k) => k.startsWith("."));
  if (subpaths) for (const [k, v] of Object.entries(exports as object)) out.set(k, leaves(v).map(file));
  else if (exports !== undefined) out.set(".", leaves(exports).map(file));
  else if (typeof main === "string") out.set(".", [file(main)]);
  return out;
}

/**
 * The path aliases of a `tsconfig.json` (`compilerOptions.paths`, comments allowed), each target repo-relative; empty
 * only when `compilerOptions` or `paths` is absent.
 */
export function pathAliasesOf(tsconfig: string): PackageEntries {
  const { config, error } = ts.parseConfigFileTextToJson("tsconfig.json", tsconfig);
  // A root config that does not parse, or whose paths are no map of string lists, throws: never no aliases (pre-3 NOTE).
  // The compiler gives an error for every root that is no object (`[]`, a string, `null`), so `config` is one here.
  if (error !== undefined) throw new Error("tsconfig.json does not parse");
  const root = config as { extends?: unknown; compilerOptions?: unknown };
  // `extends` and `baseUrl` change what an alias resolves to and the scan reads neither, so either refuses (fold 6).
  if (root.extends !== undefined) throw new Error("tsconfig.json: extends is not read by the scan");
  const options: unknown = root.compilerOptions === undefined ? {} : root.compilerOptions;
  if (typeof options !== "object" || options === null || Array.isArray(options)) throw new Error("tsconfig.json: compilerOptions is no object");
  const { baseUrl, paths = {} } = options as { baseUrl?: unknown; paths?: unknown };
  if (baseUrl !== undefined) throw new Error("tsconfig.json: compilerOptions.baseUrl is not read by the scan");
  if (typeof paths !== "object" || paths === null || Array.isArray(paths)) throw new Error("tsconfig.json: compilerOptions.paths is no object");
  const out: PackageEntries = new Map();
  for (const [k, v] of Object.entries(paths)) {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`tsconfig.json: the path alias ${k} is no list of strings`);
    out.set(k, v.map((x) => path.posix.normalize(x)));
  }
  return out;
}

/**
 * The files a specifier or a workspace subpath names in a map of entries or path aliases: the UNION of every entry it
 * matches, the exact one and each `*` one by substitution, never the first match alone (pre-4 MF2); null when none
 * matches.
 */
function entryFiles(entries: PackageEntries, subpath: string): string[] | null {
  const out: string[] = [];
  let matched = false;
  const exact = entries.get(subpath);
  if (exact !== undefined) {
    matched = true;
    out.push(...exact);
  }
  for (const [k, files] of entries) {
    const star = k.indexOf("*");
    if (star < 0) continue;
    const [pre, post] = [k.slice(0, star), k.slice(star + 1)];
    if (subpath.startsWith(pre) && subpath.endsWith(post) && subpath.length >= pre.length + post.length) {
      const hit = subpath.slice(pre.length, subpath.length - post.length);
      matched = true;
      out.push(...files.map((f) => f.split("*").join(hit)));
    }
  }
  return matched ? [...new Set(out)] : null;
}

/**
 * The one resolution of a specifier that every rule uses (pre-4 MF1, fold 5): `files` are every target of the root
 * `tsconfig.json` path aliases it matches and, for a workspace specifier (`@cinatra-ai/<folder>[/<subpath>]`), every
 * file of the package's entries it matches; null when nothing matches, so only its own spelling names it.
 */
function moduleTargets(entries: ReadonlyMap<string, PackageEntries>, aliases: PackageEntries): (spec: string) => string[] | null {
  return (spec) => {
    const out = [...(entryFiles(aliases, spec) ?? [])];
    const m = /^@cinatra-ai\/([^/]+)(.*)$/.exec(spec);
    const known = m === null ? undefined : entries.get(m[1]);
    if (known !== undefined) out.push(...(entryFiles(known, `.${m![2]}`) ?? []));
    return out.length > 0 ? out : null;
  };
}

/**
 * Which modules may export a checkbox, over the scanned tree (G1). A scanned file exports one when it exports a
 * checkbox name (rule 3) or re-exports such a module whole (`export * from`), followed until no new file appears.
 * A specifier of the tree (`./x`, `../x`, `@/x`, `~/x`, `#x`) may name such a file when its last segment is that
 * file's `moduleKey` (or is `.` or `..`). A specifier a path alias of the root `tsconfig.json` matches (`aliases`,
 * exact or with `*`) is resolved to its targets first: it may name such a file when a target does, and a target
 * outside `src/` and `packages/` is a module outside the tree. A workspace specifier (`@cinatra-ai/<folder>[/<subpath>]`, a folder
 * under `packages/`) is resolved through the package's entries (`entries`): it may name such a file when an entry
 * it matches names one (a file without its extension, or an `index` under a folder it names, counts too); a
 * subpath no entry matches falls back to the `moduleKey` test; and any specifier of a package whose entries are
 * unknown (no `package.json` read) may name any such file of its package. Any other
 * specifier but a Node built-in names a module outside the tree, which the scan does not read, so it may export a
 * checkbox: its module object is followed as one.
 */
export function moduleObjectsOf(
  bindings: ReadonlyMap<string, FileBindings>,
  isName: (file: string, name: string) => boolean,
  isTargetModule: (spec: string) => boolean,
  entries: ReadonlyMap<string, PackageEntries> = new Map(),
  aliases: PackageEntries = new Map(),
): {
  mayExport: (spec: string) => boolean;
  isObjectModule: (spec: string) => boolean;
  objectsIn: (file: string, accept?: (spec: string) => boolean) => ModuleObjects;
} {
  const packages = new Set([...bindings.keys()].map((f) => /^packages\/([^/]+)\//.exec(f)?.[1]).filter((d): d is string => d !== undefined));
  /** A set of files of the tree, with their `moduleKey`s and their packages, that a specifier may name. */
  type FileSet = { files: Set<string>; keys: Set<string>; packages: Set<string> };
  const fileSet = (): FileSet => ({ files: new Set(), keys: new Set(), packages: new Set() });
  const addTo = (set: FileSet, file: string) => {
    set.files.add(file);
    set.keys.add(moduleKey(file));
    const dir = /^packages\/([^/]+)\//.exec(file)?.[1];
    if (dir !== undefined) set.packages.add(dir);
  };
  const exporting = fileSet();
  const exporters = exporting.files;
  const add = (file: string) => addTo(exporting, file);
  const workspace = (spec: string) => {
    const m = /^@cinatra-ai\/([^/]+)/.exec(spec);
    return m !== null && packages.has(m[1]) ? m[1] : undefined;
  };
  const inTree = (spec: string) => /^(\.|@\/|~\/|#)/.test(spec);
  const byKey = (set: FileSet, spec: string) => {
    const segments = spec.split("/").map((x) => x.replace(/\.[cm]?[jt]sx?$/, ""));
    // `./ui/index` names the index file of ./ui, whose key is its folder's name.
    if (segments.length > 1 && segments[segments.length - 1] === "index") segments.pop();
    const last = segments[segments.length - 1] ?? "";
    return last === "." || last === ".." || set.keys.has(last);
  };
  const stem = (f: string) => f.replace(/\.[cm]?[jt]sx?$/, "");
  const names = (set: FileSet, target: string) => {
    const t = stem(target);
    return [...set.files].some((f) => stem(f) === t || path.posix.dirname(f) === t && moduleKey(f) === path.posix.basename(t));
  };
  const ofTree = (f: string) => /^(src|packages)\//.test(f);
  /** Whether a specifier may name a file of the set (the resolution of the doc comment above). */
  const mayName = (set: FileSet, spec: string): boolean => {
    const aliased = entryFiles(aliases, spec);
    if (aliased !== null) return aliased.filter(ofTree).some((t) => names(set, t));
    if (inTree(spec)) return byKey(set, spec);
    const dir = workspace(spec);
    if (dir === undefined || !set.packages.has(dir)) return false;
    const subpath = `.${spec.slice(`@cinatra-ai/${dir}`.length)}`;
    const known = entries.get(dir);
    const files = known === undefined ? null : entryFiles(known, subpath);
    if (files !== null) return files.some((t) => names(set, t));
    return known === undefined || byKey(set, spec);
  };
  const mayExport = (spec: string): boolean => isTargetModule(spec) || mayName(exporting, spec);
  for (const [file, b] of bindings) {
    if (b.exports.some(([n, from]) => isName(file, n) || from.some((x) => isName(file, x))) || b.reexports.some(([n, spec]) => isName(file, n) || isTargetModule(spec))) {
      add(file);
    }
  }
  /** A module outside the tree but a Node built-in, which the scan does not read. */
  const outsideOf = (spec: string) => {
    const aliased = entryFiles(aliases, spec);
    if (aliased !== null) return aliased.some((f) => !ofTree(f));
    return !inTree(spec) && workspace(spec) === undefined && !spec.startsWith("node:") && !BUILTINS.has(spec);
  };
  const isObjectModule = (spec: string) => mayExport(spec) || outsideOf(spec);
  // The files that re-export a module outside the tree whole (`export * from "@x/ui"`), and the files that
  // re-export one of them whole, followed until no new file appears (GAP 1, R1).
  const starring = fileSet();
  let size = -1;
  while (starring.files.size !== size) {
    size = starring.files.size;
    for (const [file, b] of bindings) if (!starring.files.has(file) && b.stars.some((x) => outsideOf(x) || (starring.files.size > 0 && mayName(starring, x)))) addTo(starring, file);
  }
  size = -1;
  while (exporters.size !== size) {
    size = exporters.size;
    // A file that re-exports a module outside the tree whole (GAP 1, R1) may export a checkbox like that module.
    for (const [file, b] of bindings) if (!exporters.has(file) && b.stars.some(isObjectModule)) add(file);
  }
  /**
   * The values from outside the tree in one file (GAP 1): every name an import or a load of a module outside the
   * tree binds, every name imported under a name another file exports such a value under (`exportedOutside`), and
   * every name bound to a member read or a call of one (`derived`), followed until no new name appears.
   */
  // `DYNAMIC` is outside the tree by `outsideOf` too: it is no specifier of the tree, of a workspace package or of a built-in.
  const outsideSpec = outsideOf;
  const exportedOutside = new Set<string>();
  const outsideNames = (b: FileBindings | undefined): Set<string> => {
    // A name imported from such a file is from outside the tree too: the file hands on what the outside module exports.
    const out = new Set((b?.imports ?? []).filter(([x, spec]) => outsideOf(spec) || exportedOutside.has(x) || (starring.files.size > 0 && mayName(starring, spec))).map(([x]) => x));
    let m = -1;
    while (out.size !== m) {
      m = out.size;
      for (const [name, heads] of b?.derived ?? []) {
        if (!out.has(name) && (heads.names.some((x) => out.has(x)) || heads.specs.some(outsideSpec))) out.add(name);
      }
    }
    return out;
  };
  // A name a file exports a value from outside the tree under (`export const ui = makeUi()`, `export { registry }
  // from "@x/ui"`) is such a value in every file that imports it, followed until no new name appears.
  let outsideSize = -1;
  while (exportedOutside.size !== outsideSize) {
    outsideSize = exportedOutside.size;
    for (const b of bindings.values()) {
      const out = outsideNames(b);
      for (const [name, from] of b.exports) if (from.some((x) => out.has(x))) exportedOutside.add(name);
      for (const [name, spec] of b.reexports) if (outsideOf(spec)) exportedOutside.add(name);
    }
  }
  const objectsIn = (file: string, accept?: (spec: string) => boolean): ModuleObjects => {
    const b = bindings.get(file);
    const set = new Set((b?.holders ?? []).filter(([, spec]) => (accept ?? isObjectModule)(spec)).map(([n]) => n));
    let n = -1;
    while (set.size !== n) {
      n = set.size;
      for (const [name, from] of b?.wholes ?? []) if (from.some((x) => set.has(x))) set.add(name);
    }
    // The values from outside the tree (GAP 1), for the module objects of the scan only (`accept` left out).
    const outside = accept === undefined ? outsideNames(b) : new Set<string>();
    return {
      isObject: (name) => set.has(name),
      isObjectModule: accept ?? isObjectModule,
      isOutside: (heads) => accept === undefined && (heads.names.some((x) => outside.has(x)) || heads.specs.some(outsideSpec)),
    };
  };
  return { mayExport, isObjectModule, objectsIn };
}

/**
 * Every checkbox element of one parsed file (rule 4) and every use of a
 * checkbox name the scan cannot follow (rule 5), in source order.
 * `isName(name)` says whether a name is a checkbox in this file.
 */
export function findSites(
  sf: ts.SourceFile,
  isName: (name: string) => boolean,
  tagSegment: (segment: string) => boolean = isName,
  isModule: (spec: string) => boolean = () => false,
  readsWords = false,
  objects: ModuleObjects = NO_MODULE_OBJECTS,
  isSwitch: (name: string) => boolean = (n) => n === "Switch",
  mayBeSwitch: (name: string) => boolean = isSwitch,
): FoundSite[] {
  const sites: FoundSite[] = [];
  const siteElements = new Set<ts.Node>();
  const pushUse = (node: ts.Node, why?: string, wider = false) => {
    let around: ts.Node = node;
    while (ts.isParenthesizedExpression(around.parent) || ts.isAsExpression(around.parent) || ts.isNonNullExpression(around.parent)) around = around.parent;
    let context: ts.Node = ts.isSourceFile(around.parent) ? around : around.parent;
    // A module object put in an object is read with the object, and with the call it is passed to.
    if (wider && ts.isShorthandPropertyAssignment(context) && ts.isObjectLiteralExpression(context.parent)) {
      context = ts.isCallExpression(context.parent.parent) ? context.parent.parent : context.parent;
    }
    // A template span or a heritage type is read with what holds it: `${X}` with its template, `extends X` with its clause.
    if (ts.isTemplateSpan(context) || ts.isExpressionWithTypeArguments(context)) context = context.parent;
    // An element of a list is read alone, so its anchor is its own text.
    if (ts.isArrayLiteralExpression(context)) context = around;
    // A branch of a choice is read from its `?` or `:` on, so a site in the condition and one in a branch differ.
    let opening = context.getText(sf);
    if (ts.isConditionalExpression(context) && around !== context.condition) {
      const token = around === context.whenTrue ? context.questionToken : context.colonToken;
      opening = sf.text.slice(token.getStart(sf), around.end);
    }
    sites.push({
      tag: node.getText(sf),
      line: lineOf(sf, node.getStart(sf)),
      openingTag: opening,
      childTags: [],
      drawnTags: [],
      switches: { drawn: false, any: false, byName: false },
      mustName: [],
      unresolved: why ?? `a use of ${node.getText(sf)} that is no JSX tag, import, export, declaration, type or alias`,
    });
  };
  const element = (el: ts.JsxOpeningLikeElement) => {
    const tag = el.tagName.getText(sf);
    const byName = tag.split(".").some(tagSegment);
    const byAttributes = checkboxByAttributes(tag, el);
    if (!byName && byAttributes === null) return;
    const children = childTagsOf(el, sf);
    const site: FoundSite = {
      tag,
      line: lineOf(sf, el.getStart(sf)),
      openingTag: el.getText(sf),
      childTags: children.all,
      drawnTags: children.drawn,
      switches: {
        // A tag draws a switch surely only when a segment is surely a switch and no segment is a checkbox name (fold 5).
        drawn: children.drawn.some((t) => t.split(".").some(isSwitch) && !t.split(".").some(tagSegment)),
        any: children.all.some((t) => t.split(".").some((s) => isSwitch(s) || mayBeSwitch(s))),
        byName: children.drawn.some((t) => t.split(".").some((s) => isSwitch(s) || mayBeSwitch(s))),
      },
      mustName: mustNameOf(el, sf),
    };
    if (!byName && byAttributes !== "checkbox" && byAttributes !== null) site.unresolved = byAttributes;
    sites.push(site);
    siteElements.add(el);
  };
  /**
   * The word checkbox as a whole string anywhere but inside the opening tag of
   * an element that is a site (which is read with that site): a use (rule 5).
   */
  const word = (node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral) => {
    if (!readsWords || !CHECKBOX_WORD.test(node.text.trim())) return;
    let up: ts.Node = node.parent;
    while (!ts.isSourceFile(up) && !ts.isJsxAttributes(up)) up = up.parent;
    if (ts.isJsxAttributes(up) && siteElements.has(up.parent)) return;
    pushUse(node, `the word ${node.text.trim()} in a string outside a site's opening tag`);
  };
  /**
   * A member chain whose names hold a checkbox name is a use; so is a computed member (a key the syntax does
   * not settle) anywhere in a chain whose head is a module object (G1); otherwise its head is read on. A key
   * the syntax settles (`P["Check" + "box"]`, `` P[`Check${"box"}`] ``) is a name like `P.Checkbox`.
   */
  const chain = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression) => {
    const names: string[] = [];
    let computed = false;
    let head: ts.Expression = node;
    for (;;) {
      if (ts.isPropertyAccessExpression(head)) {
        names.push(head.name.text);
        head = head.expression;
      } else if (ts.isElementAccessExpression(head)) {
        const key = unwrap(head.argumentExpression);
        const keys = keyStrings(key);
        if (keys === null) computed = true;
        else names.push(...keys);
        if (!isStringLike(key)) visit(head.argumentExpression);
        head = head.expression;
      } else break;
    }
    if (ts.isIdentifier(head)) names.push(head.text);
    if (names.some(isName)) pushUse(node);
    else if (computed && ts.isIdentifier(head) && objects.isObject(head.text)) {
      pushUse(node, `a use of a computed member of the module object ${head.text}, which no name follows`);
    } else if (computed && objects.isOutside(valueHeads(head))) {
      // GAP 1: a value from outside the tree (an import, a load, a member or a call of one) may hold a checkbox.
      pushUse(node, `a use of a computed member of ${head.getText(sf)}, a value from outside the tree, which no name follows`);
      if (!ts.isIdentifier(head)) visit(head);
    } else if (!ts.isIdentifier(head)) visit(head);
  };
  const objectUse = (node: ts.Node, name: string, how: string) =>
    pushUse(node, `a use of the module object ${name} ${how}, whose exports no name follows`, true);
  /** Whether a destructured value is (a member of) a module object: its declaration's initializer. */
  const fromObject = (pattern: ts.ObjectBindingPattern): boolean => {
    let up: ts.Node = pattern.parent;
    while (ts.isBindingElement(up) || ts.isObjectBindingPattern(up) || ts.isArrayBindingPattern(up)) up = up.parent;
    if (!ts.isVariableDeclaration(up) || !up.initializer) return false;
    const mod = importedModule(up.initializer);
    if (mod !== undefined) return objects.isObjectModule(mod);
    const src = aliasSources(up.initializer);
    return (
      (src?.names.slice(0, 1).some(objects.isObject) ?? false) || wholeNames(up.initializer).some(objects.isObject) || objects.isOutside(valueHeads(up.initializer))
    );
  };
  const skipAlias = (init: ts.Expression) => {
    const src = aliasSources(init);
    if (src === null) visit(init);
    else for (const r of src.rest) visit(r);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.exportClause) {
      // `export { P }` hands a module object on under a name no rule follows; `export * as ns from "m"` makes one.
      if (ts.isNamedExports(node.exportClause) && node.moduleSpecifier === undefined) {
        for (const s of node.exportClause.elements) {
          const local = (s.propertyName ?? s.name).text;
          if (objects.isObject(local)) objectUse(s, local, "exported on");
        }
      }
      const spec = node.moduleSpecifier && isStringLike(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
      // GAP 1 (R2): `export * as ns from` a module outside the tree hands its module object on like one that may export a checkbox.
      if (ts.isNamespaceExport(node.exportClause) && spec !== undefined && (isModule(spec) || objects.isObjectModule(spec))) {
        pushUse(node, `a use of the module ${node.moduleSpecifier.text} exported whole as ${node.exportClause.name.text}, which no name follows`);
      }
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return;
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isHeritageClause(node)) {
      if (node.token === ts.SyntaxKind.ExtendsKeyword && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent))) {
        for (const t of node.types) visit(t.expression);
      }
      return;
    }
    if (ts.isExpressionWithTypeArguments(node)) return visit(node.expression);
    if (isTypeOnly(node)) return;
    if (ts.isExportAssignment(node)) {
      for (const n of wholeNames(node.expression)) if (objects.isObject(n)) objectUse(node, n, "exported as the default export");
      return skipAlias(node.expression);
    }
    if (ts.isVariableDeclaration(node)) {
      if (!ts.isIdentifier(node.name)) visit(node.name);
      else if (objects.isObject(node.name.text) && ts.isVariableDeclarationList(node.parent) && hasModifier(node.parent.parent, ts.SyntaxKind.ExportKeyword)) {
        objectUse(node.name, node.name.text, "exported on");
      }
      if (node.initializer && importedModule(node.initializer) !== undefined) return;
      if (node.initializer) skipAlias(node.initializer);
      return;
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      element(node);
      return visit(node.attributes);
    }
    if (ts.isJsxClosingElement(node)) return;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return chain(node);
    if (ts.isBindingElement(node) && node.propertyName && ts.isComputedPropertyName(node.propertyName) && ts.isObjectBindingPattern(node.parent)) {
      if (keyStrings(node.propertyName.expression) === null && fromObject(node.parent)) {
        pushUse(node, `a use of a computed key destructured from a module object or a value from outside the tree, which no name follows`);
      }
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      if (isName(node.name.text)) pushUse(node.name);
      else if (objects.isObject(node.name.text)) objectUse(node.name, node.name.text, "put in an object");
      if (node.objectAssignmentInitializer) visit(node.objectAssignmentInitializer);
      return;
    }
    if (ts.isIdentifier(node)) {
      if (!isDeclarationName(node) && isName(node.text)) pushUse(node);
      else if (!isDeclarationName(node) && objects.isObject(node.text)) objectUse(node, node.text, "used as a value");
      return;
    }
    if (isStringLike(node)) return word(node);
    if (ts.isCallExpression(node)) {
      // `import("m")` or `require("m")` of a module that names the target, not bound by a declaration of rule 3
      // (`lazy(() => import("./checkbox"))`): what it loads cannot be followed by name.
      const spec = importedModule(node);
      if (spec !== undefined && isModule(spec)) pushUse(node, `a load of the module ${spec}, which no name follows`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// Code, comments and literals
// ---------------------------------------------------------------------------

const LITERAL_TOKENS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
]);

/**
 * The ranges of a file's comments and of its string, template and
 * regular-expression tokens. The comments are read from the trivia before each
 * token (the text between the token's full start and its start, which holds
 * only white space and comments), scanned by the compiler's own scanner; JSX
 * text is no trivia, so a `//` in it is no comment.
 */
export function nonCodeRanges(sf: ts.SourceFile): { comments: [number, number][]; literals: [number, number][] } {
  const text = sf.getFullText();
  const comments: [number, number][] = [];
  const literals: [number, number][] = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, sf.languageVariant);
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sf);
    if (children.length > 0) {
      for (const c of children) visit(c);
      return;
    }
    if (node.kind === ts.SyntaxKind.JsxText) return;
    const start = node.getStart(sf);
    if (start > node.pos) {
      scanner.setText(text, node.pos, start - node.pos);
      for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
        if (k === ts.SyntaxKind.SingleLineCommentTrivia || k === ts.SyntaxKind.MultiLineCommentTrivia) {
          comments.push([scanner.getTokenStart(), scanner.getTokenEnd()]);
        }
      }
    }
    if (LITERAL_TOKENS.has(node.kind)) literals.push([start, node.end]);
  };
  visit(sf);
  return { comments, literals };
}

const RANGES = new WeakMap<ts.SourceFile, ReturnType<typeof nonCodeRanges>>();

/** Whether `pin` stands in the code of the file: one occurrence that touches no comment and is not inside one string or template. */
export function standsInCode(sf: ts.SourceFile, pin: string): boolean {
  const text = sf.getFullText();
  const ranges = RANGES.get(sf) ?? nonCodeRanges(sf);
  RANGES.set(sf, ranges);
  const { comments, literals } = ranges;
  for (let i = text.indexOf(pin); i >= 0; i = text.indexOf(pin, i + 1)) {
    const end = i + pin.length;
    if (comments.some(([a, b]) => i < b && end > a)) continue;
    if (literals.some(([a, b]) => i >= a && end <= b)) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

export type ScannedFile = {
  file: string;
  tokens: number;
  sites: FoundSite[];
  /** The modules outside the tree it loads without a binding (G1, `externalLoadsOf`), in source order. */
  loads: string[];
};

/**
 * The modules outside the tree (`isExternal`) a file loads without binding the loaded module object to a name
 * (G1): `() => import("@x/y")`, `[import("x")]`, `import("x").then(...)`, `require("x")[k]`. Such a module
 * object is handed on whole, so which export is drawn no name follows; the scan does not read the module (rule
 * 1), so the file's reading must say what these loads are. A load bound by a declaration (`const P = await
 * import("x")`, `const { a } = await import("x")`) or read by a name (`(await import("x")).a`) is not one: a
 * bound module object is followed by `findSites`.
 */
export function externalLoadsOf(sf: ts.SourceFile, isExternal: (spec: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      // GAP 1: a load whose specifier is no string names no module, so each is recorded, bound or not.
      const dynamic = dynamicLoad(node);
      if (dynamic !== undefined) out.push(dynamic);
      const spec = importedModule(node);
      if (spec !== undefined && isExternal(spec)) {
        let up: ts.Node = node;
        while (ts.isParenthesizedExpression(up.parent) || ts.isAwaitExpression(up.parent) || ts.isAsExpression(up.parent) || ts.isNonNullExpression(up.parent)) {
          up = up.parent;
        }
        const p = up.parent;
        const bound = ts.isVariableDeclaration(p) && p.initializer === up;
        // An element access on a load (`import("x")["then"]`, `require("x")["a"]`) is read like `.then`: it names no
        // export, so the load is recorded (pre-3 MF4); only a member read by name but then, catch and finally is one.
        const named = ts.isPropertyAccessExpression(p) && p.expression === up && !["then", "catch", "finally"].includes(p.name.text);
        if (!bound && !named) out.push(spec);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export type ScannedTree = {
  files: ScannedFile[];
  /** Names other files export a checkbox under, beyond the spelling `Checkbox` (rule 3). */
  exported: Set<string>;
  /** Default exports of a checkbox (`file:line`): a problem no reading clears. */
  defaultExports: string[];
  /** Whole re-exports of a module that names a checkbox (`file:line`): a problem no reading clears (pre-3 MF2). */
  starExports: string[];
  /** Parse errors of any scanned file: a problem no reading clears. */
  parseErrors: string[];
};

/** The word checkbox in a name or a tag, in any letter case (G2: `CheckBox`, `<md-checkbox>`, `<sl-checkbox>`). */
const CHECKBOX_NAME = /checkbox/i;

/**
 * A checkbox by spelling: a name that holds checkbox in any letter case, from any letter (GAP 2: an import, export,
 * member or key name `checkbox` is one too, so `{ checkbox as Box }`, `Kit.checkbox` and `{ checkbox: Box }` bind one).
 */
export function isCheckboxSpelling(name: string): boolean {
  return CHECKBOX_NAME.test(name);
}

/** A module that names a checkbox: every name imported from it is a checkbox. */
export function isCheckboxModule(spec: string): boolean {
  return /checkbox/i.test(spec);
}

/** A module that names a switch: its last segment is switch or ends in -switch, with or without `/index` and an extension. */
export function isSwitchModule(spec: string): boolean {
  return /(?:^|[/-])switch(?:\/index)?(?:\.[cm]?[jt]sx?)?$/i.test(spec);
}

/** The in-scope files of the given texts (rule 2) with their tokens and sites; test files are left out. */
export function scanSources(
  texts: ReadonlyMap<string, string>,
  entries: ReadonlyMap<string, PackageEntries> = new Map(),
  aliases: PackageEntries = new Map(),
): ScannedTree {
  const sources = new Map<string, ts.SourceFile>();
  const errors: string[] = [];
  for (const [file, text] of texts) {
    if (isTestPath(file)) continue;
    const sf = parseSource(file, text);
    errors.push(...parseErrors(sf));
    sources.set(file, sf);
  }
  // One resolution of a specifier (its spelling, the path aliases, the workspace entries) feeds every rule (pre-4 MF1).
  const targets = moduleTargets(entries, aliases);
  const boxModule = (spec: string) => isCheckboxModule(spec) || (targets(spec) ?? []).some(isCheckboxModule);
  const scope = resolveNames(sources, isCheckboxSpelling, boxModule);
  const bindings = new Map([...sources].map(([file, sf]) => [file, collectBindings(sf)] as const));
  const modules = moduleObjectsOf(bindings, scope.isName, boxModule, entries, aliases);
  // A switch by name, through the same resolution (pre-4 NOTE, fold 5): Switch, a name bound to it, or a name imported
  // from a module that names a switch. It MAY be one when the specifier or any file it resolves to names a switch; it
  // is SURELY one only when every file it resolves to (its spelling when it resolves to none) names a switch, and only
  // by what the file binds itself: a name another file exports a switch under is a possible switch, never a sure one
  // (fold 6). A name from a module that names a checkbox is a checkbox name, which findSites never takes as a sure switch.
  const mayBeSwitch = resolveNames(sources, (n) => n === "Switch", (spec) => isSwitchModule(spec) || (targets(spec) ?? []).some(isSwitchModule));
  const sureSwitch = resolveNames(sources, (n) => n === "Switch", (spec) => (targets(spec) ?? [spec]).every(isSwitchModule), false);
  const out: ScannedFile[] = [];
  for (const [file, sf] of sources) {
    const isName = (n: string) => scope.isName(file, n);
    const tokens = countCheckboxTokens(sf.getFullText());
    // A tag segment is a checkbox by the name test, which takes checkbox in any letter case (G2, GAP 2).
    const sites = findSites(sf, isName, isName, modules.mayExport, true, modules.objectsIn(file), (n) => sureSwitch.isName(file, n), (n) => mayBeSwitch.isName(file, n));
    const loads = externalLoadsOf(sf, (spec) => modules.isObjectModule(spec) && !modules.mayExport(spec));
    // GAP 2 (Q7): a file that exports a checkbox name is in scope even when no token spells it (`export const checkbox`).
    const b = bindings.get(file)!;
    const exportsName = b.exports.some(([n, from]) => isName(n) || from.some(isName));
    if (tokens === 0 && sites.length === 0 && loads.length === 0 && !exportsName) continue;
    out.push({ file, tokens, sites, loads });
  }
  return { files: out, exported: scope.exported, defaultExports: scope.defaults, starExports: scope.stars, parseErrors: errors };
}

/** The in-scope files of the tree (rule 2) with their tokens and sites. */
export function scanTree(repoRoot: string, files: string[] = listSourceFiles(repoRoot)): ScannedTree {
  const texts = new Map<string, string>();
  for (const file of files) {
    if (isTestPath(file)) continue;
    texts.set(file, readFileSync(path.join(repoRoot, file), "utf8"));
  }
  const read = (f: string) => readFileSync(path.join(repoRoot, f), "utf8");
  return scanSources(texts, workspaceEntries([...texts.keys()], read), rootAliases(read));
}

/** Whether a read failed only because the file does not exist (ENOENT). */
function isAbsent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * The path aliases of the root `tsconfig.json`; empty only when there is none (ENOENT). Any other read error
 * (EACCES, EIO, EISDIR) throws, as does a config that does not parse (pre-4 MF3).
 */
export function rootAliases(fileText: (file: string) => string): PackageEntries {
  let text: string;
  try {
    text = fileText("tsconfig.json");
  } catch (error) {
    if (isAbsent(error)) return new Map();
    throw error;
  }
  return pathAliasesOf(text);
}

/**
 * The entries of each workspace package (`packages/<dir>/package.json`) of the files; a package without one (ENOENT)
 * is left out, and any other read error or a malformed package.json throws (pre-4 MF3, fold 5).
 */
export function workspaceEntries(files: string[], fileText: (file: string) => string): Map<string, PackageEntries> {
  const out = new Map<string, PackageEntries>();
  for (const dir of new Set(files.map((f) => /^packages\/([^/]+)\//.exec(f)?.[1]).filter((d): d is string => d !== undefined))) {
    let text: string;
    try {
      text = fileText(`packages/${dir}/package.json`);
    } catch (error) {
      // Only an absent package.json leaves the package's entries unknown; any other read error throws (pre-4 MF3).
      if (isAbsent(error)) continue;
      throw error;
    }
    const e = packageEntriesOf(dir, text);
    // A package.json that is no JSON object or has malformed exports or main refuses, never no entries (fold 5).
    if (e === null) throw new Error(`packages/${dir}/package.json is no JSON object or has malformed exports or main`);
    out.set(dir, e);
  }
  return out;
}

/** The sites of one file's text, scanned as a tree of that one file. */
export function findCheckboxSites(text: string, file = "f.tsx"): FoundSite[] {
  return scanSources(new Map([[file, text]])).files.find((f) => f.file === file)?.sites ?? [];
}

// ---------------------------------------------------------------------------
// The recorded readings and their check
// ---------------------------------------------------------------------------

/**
 * `immediate`: the change takes effect at once (it is written, sent or applied
 * when the box changes). `confirmed`: the change is held and only a separate
 * confirm (a form submit, a Continue, a dialog action) applies it. `none`: the
 * element changes nothing itself (a primitive's own definition, a part of it, a
 * static drawing fixture, a decorative box inside a row that is the control, or
 * an element that is not a checkbox).
 */
export type Effect = "immediate" | "confirmed" | "none";

const EFFECTS: readonly string[] = ["immediate", "confirmed", "none"];

export type SiteReading = {
  /** A text that stands in exactly one found site's opening tag of the file. */
  anchor: string;
  tag: string;
  /**
   * What the person sees: a checkbox, a switch drawn inside a checkbox-role
   * row, or, for an unresolved site, no checkbox (the reading says why).
   */
  drawn: "checkbox" | "switch" | "no checkbox";
  effect: Effect;
  /** Why: the reading in a sentence, naming what applies the change. */
  reading: string;
  /** Texts that must stand in the opening tag: each change handler and each spread, at least. */
  tagIncludes: string[];
  /** Texts that must stand in the code of the file: the confirm control, the write, the form. */
  fileIncludes: string[];
  /** Texts that must stand in the code of other files the reading leans on (the surface that applies the change). */
  evidence?: { file: string; text: string }[];
  /** Required when an immediate-effect site is drawn as a checkbox: why it stays a checkbox. */
  staysBecause?: string;
};

export type FileReading = {
  file: string;
  /** `countCheckboxTokens` of the file as read. */
  tokens: number;
  /** For a file with no site: what its checkbox tokens are. */
  mentions?: string;
  sites: SiteReading[];
  /**
   * For a file that loads modules outside the tree without a binding (G1): how many, a pattern (a regular
   * expression source) each of them matches, and what they are in a sentence.
   */
  loads?: { count: number; modules: string; reading: string };
};

const SENTENCE = 20;

function blankText(s: unknown): boolean {
  return typeof s !== "string" || s.trim().length === 0;
}

function shortSentence(s: unknown): boolean {
  return typeof s !== "string" || s.trim().length < SENTENCE;
}

const PARSED = new Map<string, { raw: string; sf: ts.SourceFile }>();

/** The parsed text of a pinned file, parsed once per text. */
function parsedPin(file: string, raw: string): ts.SourceFile {
  const hit = PARSED.get(file);
  if (hit && hit.raw === raw) return hit.sf;
  const sf = parseSource(file, raw);
  PARSED.set(file, { raw, sf });
  return sf;
}

/** Problems of pinned texts: each must hold more than white space and stand in the code (rule 7). */
function pinProblems(at: string, pins: { file: string; text: string }[], fileText: (file: string) => string): string[] {
  const problems: string[] = [];
  for (const pin of pins) {
    if (blankText(pin.file) || blankText(pin.text)) {
      problems.push(`${at}: a pinned text or its file is empty`);
      continue;
    }
    let raw: string;
    try {
      raw = fileText(pin.file);
    } catch {
      problems.push(`${at}: the file ${pin.file} cannot be read`);
      continue;
    }
    if (!raw.includes(pin.text)) problems.push(`${at}: ${pin.file} no longer holds ${JSON.stringify(pin.text)}`);
    else if (!standsInCode(parsedPin(pin.file, raw), pin.text)) {
      problems.push(`${at}: ${pin.file} holds ${JSON.stringify(pin.text)} only in a comment, a string or a template; pin the code`);
    }
  }
  return problems;
}

/**
 * Whether a tagIncludes text names an attribute: the attribute itself, or a
 * prefix of it that reaches past a handler's `=` or past a spread's `{...`.
 */
function namesAttribute(t: string, attribute: string): boolean {
  if (t === attribute) return true;
  const reach = attribute.startsWith("{...") ? 4 : attribute.indexOf("=") + 1;
  return reach > 0 && attribute.startsWith(t) && t.length > reach;
}


/**
 * The problems between the recorded readings and the scanned tree; [] means
 * every in-scope file and every site has exactly one true reading.
 */
export function readingProblems(readings: FileReading[], tree: ScannedTree, fileText: (file: string) => string): string[] {
  const problems: string[] = [...tree.parseErrors.map((e) => `${e}: the file does not parse, so it cannot be read`)];
  for (const at of tree.defaultExports) {
    problems.push(`${at}: exports a checkbox as its default export, which no name follows: export it by name`);
  }
  for (const at of tree.starExports) {
    problems.push(`${at}: re-exports a module that names a checkbox whole (export *), whose names no name follows: re-export them by name`);
  }
  const byFile = new Map(tree.files.map((s) => [s.file, s]));
  const recorded = new Map<string, FileReading>();
  for (const r of readings) {
    if (recorded.has(r.file)) problems.push(`${r.file}: recorded twice`);
    recorded.set(r.file, r);
  }
  for (const s of tree.files) {
    if (!recorded.has(s.file)) {
      problems.push(`${s.file}: refers to a checkbox (${s.tokens} token(s), ${s.sites.length} site(s)) but has no recorded reading`);
    }
  }
  for (const r of readings) {
    const s = byFile.get(r.file);
    if (!s) {
      problems.push(`${r.file}: has a recorded reading but no longer refers to a checkbox (or is gone)`);
      continue;
    }
    if (s.tokens !== r.tokens) {
      problems.push(`${r.file}: holds ${s.tokens} checkbox token(s), the reading was recorded at ${r.tokens}: read the file again`);
    }
    if (s.loads.length > 0 && r.loads === undefined) {
      problems.push(`${r.file}: loads ${s.loads.length} module(s) outside the tree without a binding, which the reading must name in loads`);
    }
    if (r.loads !== undefined) {
      if (s.loads.length === 0) problems.push(`${r.file}: the reading records loads, the file loads no module outside the tree without a binding`);
      else if (r.loads.count !== s.loads.length) {
        problems.push(`${r.file}: loads ${s.loads.length} module(s) outside the tree without a binding, the reading was recorded at ${r.loads.count}: read the file again`);
      }
      let pattern: RegExp | undefined;
      try {
        pattern = blankText(r.loads.modules) ? undefined : new RegExp(`^(?:${r.loads.modules})$`);
      } catch {
        pattern = undefined;
      }
      if (pattern === undefined) problems.push(`${r.file}: the loads pattern is no regular expression`);
      else for (const spec of s.loads) if (!pattern.test(spec)) problems.push(`${r.file}: loads ${spec}, which the recorded loads pattern does not cover`);
      if (shortSentence(r.loads.reading)) problems.push(`${r.file}: the loads reading is not a sentence`);
    }
    const onlyLoads = s.tokens === 0 && s.sites.length === 0 && s.loads.length > 0;
    if (r.sites.length === 0 && !onlyLoads && shortSentence(r.mentions)) {
      problems.push(`${r.file}: a file with no site must say in a sentence what its tokens are`);
    }
    if (r.mentions !== undefined && r.sites.length > 0) problems.push(`${r.file}: mentions is only for a file with no site`);
    if (s.sites.length !== r.sites.length) {
      problems.push(`${r.file}: ${s.sites.length} checkbox site(s) found, ${r.sites.length} recorded`);
    }
    const used = new Set<number>();
    for (const site of r.sites) {
      if (blankText(site.anchor)) {
        problems.push(`${r.file}: a reading has an empty anchor`);
        continue;
      }
      const hits = s.sites.map((f, i) => [f, i] as const).filter(([f]) => f.openingTag.includes(site.anchor));
      if (hits.length !== 1) {
        problems.push(`${r.file}: anchor ${JSON.stringify(site.anchor)} stands in ${hits.length} site(s), not one`);
        continue;
      }
      const [found, index] = hits[0];
      if (used.has(index)) problems.push(`${r.file}: two readings name the site at line ${found.line}`);
      used.add(index);
      const at = `${r.file}:${found.line}`;
      if (found.tag !== site.tag) problems.push(`${at}: the tag is ${found.tag}, the reading says ${site.tag}`);
      if (!EFFECTS.includes(site.effect)) problems.push(`${at}: the effect ${JSON.stringify(site.effect)} is not one of ${EFFECTS.join(", ")}`);
      for (const t of site.tagIncludes) {
        if (blankText(t)) problems.push(`${at}: a tagIncludes text is empty`);
        else if (!found.openingTag.includes(t)) problems.push(`${at}: the opening tag no longer holds ${JSON.stringify(t)}`);
      }
      for (const attribute of found.mustName) {
        if (!site.tagIncludes.some((t) => typeof t === "string" && namesAttribute(t, attribute))) {
          const label = attribute.startsWith("{") ? attribute.replace(/\s+/g, " ").slice(0, 80) : attribute.split(/\s*=/)[0];
          problems.push(`${at}: the opening tag has ${label}, which the reading must name in tagIncludes`);
        }
      }
      problems.push(
        ...pinProblems(at, [...site.fileIncludes.map((text) => ({ file: r.file, text })), ...(site.evidence ?? [])], fileText),
      );
      // A switch is drawn only when it is drawn whenever the element is; one under a choice or a function may be
      // drawn, so a checkbox cannot be claimed either (pre-3 NOTE).
      const drawsSwitch = found.switches.drawn;
      const mayDrawSwitch = found.switches.any;
      if (site.drawn === "switch" && !drawsSwitch) {
        problems.push(
          found.switches.byName
            ? `${at}: the reading says a switch is drawn, the element draws one only by a name that may not be a switch (its module resolves to a file that names no switch, or the name is a checkbox name too)`
            : mayDrawSwitch
              ? `${at}: the reading says a switch is drawn, the element draws one only under a condition or in a function`
              : `${at}: the reading says a switch is drawn, the element draws none`,
        );
      }
      if (site.drawn === "checkbox" && mayDrawSwitch) problems.push(`${at}: the element draws a switch, the reading says a checkbox`);
      if (site.drawn === "no checkbox" && found.unresolved === undefined) {
        problems.push(`${at}: the element is a checkbox by name or attribute; "no checkbox" is only for an unresolved site`);
      }
      if (site.drawn === "no checkbox" && site.effect !== "none") problems.push(`${at}: an element that draws no checkbox has the effect none`);
      if (site.effect === "confirmed" && site.fileIncludes.length + (site.evidence ?? []).length === 0) {
        problems.push(`${at}: a confirmed reading must pin the confirm control (fileIncludes or evidence)`);
      }
      if (site.effect === "immediate" && site.drawn === "checkbox" && shortSentence(site.staysBecause)) {
        problems.push(`${at}: takes effect at once and is drawn as a checkbox, with no recorded reason it stays (the drawing gives a switch)`);
      }
      if (site.staysBecause !== undefined && shortSentence(site.staysBecause)) problems.push(`${at}: the reason it stays is not a sentence`);
      if (shortSentence(site.reading)) problems.push(`${at}: the reading is not a sentence`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Callers of a shared component
// ---------------------------------------------------------------------------

/** One call site (one JSX element) of a shared component whose rows or children draw the box. */
export type CallerReading = {
  file: string;
  /** A text that stands in exactly one call site's opening tag of the file. */
  anchor: string;
  effect: Effect;
  reading: string;
  /** Texts that must stand in the call site's opening tag: each change handler and each spread, at least (pre-3 MF1). */
  tagIncludes: string[];
  fileIncludes: string[];
  evidence?: { file: string; text: string }[];
  staysBecause?: string;
};

/** A shared component whose box is read at its callers. */
export type ComponentCallers = {
  component: string;
  /**
   * When set, an element is a caller only when this attribute, read in source
   * order, is one of `values`; an expression, or a spread that may set it,
   * makes it a caller too. Without it, every element is one. An element without the attribute is no caller only
   * by the component's own default, so `absent` pins the code of the component that makes it so (pre-3 NOTE).
   */
  callerWhen?: { attribute: string; values: string[]; absent?: { file: string; text: string } };
  /** Why these are the callers, in a sentence. */
  why: string;
  callers: CallerReading[];
};

export type CallerSite = {
  file: string;
  line: number;
  tag: string;
  openingTag: string;
  /** The texts of its change handlers (`on…` attributes) and spreads, each of which its reading must name (pre-3 MF1). */
  mustName: string[];
};

export type CallerScan = {
  /** Names the component is exported under beyond its own. */
  exported: string[];
  /** Every call site, in file and line order. */
  sites: CallerSite[];
  /** Uses of a name of the component the scan cannot follow, and default exports of it. */
  unresolved: string[];
};

function isCallerElement(el: ts.JsxOpeningLikeElement, when: ComponentCallers["callerWhen"]): boolean {
  if (when === undefined) return true;
  const v = resolveAttribute(el, when.attribute.toLowerCase());
  if (v.kind === "absent") return false;
  if (v.kind === "literal") return when.values.includes(v.value);
  if (v.kind === "expression" && v.values !== null) return v.values.some((x) => when.values.includes(x));
  return true;
}

/**
 * The call sites outside tests that open the component under any of its names
 * with an element `callerWhen` accepts, and every use of a name the scan
 * cannot follow.
 */
export function findCallers(
  scannedFiles: string[],
  fileText: (file: string) => string,
  component: string,
  callerWhen?: ComponentCallers["callerWhen"],
): CallerScan {
  const sources = new Map<string, ts.SourceFile>();
  const unresolved: string[] = [];
  for (const file of scannedFiles) {
    if (isTestPath(file)) continue;
    const sf = parseSource(file, fileText(file));
    unresolved.push(...parseErrors(sf).map((e) => `${e}: the file does not parse`));
    sources.set(file, sf);
  }
  const scope = resolveNames(sources, (n) => n === component);
  unresolved.push(...scope.defaults.map((at) => `${at}: exports ${component} as its default export, which no name follows`));
  const modules = moduleObjectsOf(
    new Map([...sources].map(([file, sf]) => [file, collectBindings(sf)] as const)),
    scope.isName,
    () => false,
    workspaceEntries([...sources.keys()], fileText),
    rootAliases(fileText),
  );
  const sites: CallerSite[] = [];
  for (const [file, sf] of sources) {
    const isName = (n: string) => scope.isName(file, n);
    // Only the modules of the tree that export the component are followed here: a module outside the tree cannot
    // export this tree's component.
    for (const site of findSites(sf, isName, isName, modules.mayExport, false, modules.objectsIn(file, modules.mayExport))) {
      if (site.unresolved !== undefined && (site.unresolved.startsWith("a use of") || site.unresolved.startsWith("a load of"))) {
        unresolved.push(`${file}:${site.line}: ${site.unresolved}`);
      }
    }
    const visit = (n: ts.Node) => {
      if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf).split(".").some(isName)) {
        if (isCallerElement(n, callerWhen)) {
          sites.push({ file, line: lineOf(sf, n.getStart(sf)), tag: n.tagName.getText(sf), openingTag: n.getText(sf), mustName: mustNameOf(n, sf) });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  sites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return { exported: [...scope.exported].sort(), sites, unresolved };
}

export function callerProblems(set: ComponentCallers, found: CallerScan, fileText: (file: string) => string): string[] {
  const problems: string[] = [...found.unresolved];
  const { component, callers } = set;
  if (shortSentence(set.why)) problems.push(`${component}: say in a sentence why these are its callers`);
  if (set.callerWhen !== undefined) {
    const absent = set.callerWhen.absent;
    if (absent === undefined) problems.push(`${component}: an element without ${set.callerWhen.attribute} is no caller only by a pinned default (callerWhen.absent)`);
    else problems.push(...pinProblems(`${component} (the default of ${set.callerWhen.attribute})`, [absent], fileText));
  }
  const used = new Set<number>();
  for (const c of callers) {
    const at = `${c.file} (caller of ${component})`;
    if (blankText(c.anchor)) {
      problems.push(`${at}: a caller reading has an empty anchor`);
      continue;
    }
    const hits = found.sites.map((s, i) => [s, i] as const).filter(([s]) => s.file === c.file && s.openingTag.includes(c.anchor));
    if (hits.length === 0 && !found.sites.some((s) => s.file === c.file)) {
      problems.push(`${at}: recorded as a caller, but it is not one`);
      continue;
    }
    if (hits.length !== 1) {
      problems.push(`${at}: anchor ${JSON.stringify(c.anchor)} stands in ${hits.length} call site(s), not one`);
      continue;
    }
    const [site, index] = hits[0];
    if (used.has(index)) problems.push(`${c.file}:${site.line}: two readings name this call site of ${component}`);
    used.add(index);
    if (!EFFECTS.includes(c.effect)) problems.push(`${at}: the effect ${JSON.stringify(c.effect)} is not one of ${EFFECTS.join(", ")}`);
    const tagIncludes: unknown[] = Array.isArray(c.tagIncludes) ? c.tagIncludes : [];
    if (!Array.isArray(c.tagIncludes)) problems.push(`${c.file}:${site.line}: a caller reading has no tagIncludes`);
    for (const t of tagIncludes) {
      if (blankText(t)) problems.push(`${c.file}:${site.line}: a tagIncludes text is empty`);
      else if (!site.openingTag.includes(t as string)) problems.push(`${c.file}:${site.line}: the call site's opening tag no longer holds ${JSON.stringify(t)}`);
    }
    for (const attribute of site.mustName) {
      if (!tagIncludes.some((t) => typeof t === "string" && namesAttribute(t, attribute))) {
        const label = attribute.startsWith("{") ? attribute.replace(/\s+/g, " ").slice(0, 80) : attribute.split(/\s*=/)[0];
        problems.push(`${c.file}:${site.line}: the call site has ${label}, which the reading must name in tagIncludes`);
      }
    }
    problems.push(...pinProblems(at, [...c.fileIncludes.map((text) => ({ file: c.file, text })), ...(c.evidence ?? [])], fileText));
    if (c.effect === "confirmed" && c.fileIncludes.length + (c.evidence ?? []).length === 0) {
      problems.push(`${at}: a confirmed reading must pin its confirm`);
    }
    if (c.effect === "immediate" && shortSentence(c.staysBecause)) problems.push(`${at}: takes effect at once with no recorded reason the box stays`);
    if (c.staysBecause !== undefined && shortSentence(c.staysBecause)) problems.push(`${at}: the reason the box stays is not a sentence`);
    if (shortSentence(c.reading)) problems.push(`${at}: the reading is not a sentence`);
  }
  found.sites.forEach((s, i) => {
    if (!used.has(i)) problems.push(`${s.file}:${s.line}: a call site of ${component} with no recorded reading`);
  });
  return problems;
}
