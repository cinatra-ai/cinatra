/**
 * CLIENT-BOUNDARY GATE — nothing in the run page's SERVER graph reads a member
 * of, calls, constructs, or tags an import it took from a `"use client"` module
 * (cinatra#2970, epic #2784).
 *
 * WHAT WENT WRONG, AND WHY NO SUITE HERE SAW IT. `instance-screens.tsx` is a
 * server component. It imported `RUN_SURFACE_RAIL_LABELS` — a plain object —
 * from `run-surface-rail.tsx`, a `"use client"` module, and read `.schedule` off
 * it to label a rail row. Turbopack compiles a `"use client"` module, for the
 * server graph, into one `registerClientReference(stub, id, exportName)` per
 * export, and React's `registerClientReferenceImpl` only hangs `$$typeof` /
 * `$$id` / `$$async` on the stub function it is handed. So the binding the
 * server sees is a TAGGED STUB FUNCTION — not a JavaScript `Proxy`, and with no
 * `.schedule` on it. Reading `.schedule` is therefore an ordinary property
 * lookup that misses: `undefined`, silently, with no error. Every rail row
 * shipped its numeral above an EMPTY title, while the ratified drawing
 * `design-run-surface-rail-and-gate.png` says the rail NAMES the run's ordered
 * steps.
 *
 * (The throwing form — "You cannot dot into a client module from a server
 * component" — is the SEPARATE module-namespace path, `createClientModuleProxy`,
 * whose deep proxy rejects arbitrary member reads. It is not the path this hit,
 * which is exactly why the page rendered instead of failing.)
 *
 * A test environment is not an RSC boundary. `setup-run-surface-rail.test.tsx`
 * imports the same module and gets the real object, so it asserted
 * "1Schedule" / "2Recommendation" and PASSED on the broken tree; only the served
 * HTML showed it. This gate is the part a suite CAN see: not the rendered
 * output, but the boundary itself.
 *
 * THE PROPERTY, STATED AS NARROWLY AS IT IS CHECKED. For every module reachable
 * from `instance-screens.tsx` without crossing a `"use client"` boundary, take
 * each value binding it imports DIRECTLY from a `"use client"` module. That
 * binding is never the receiver of a member read (`x.y` or `x[y]`), never the
 * callee of a call, never constructed, and never a template tag. Those are the
 * operations that evaluate a tagged stub as if it were the value behind it, and
 * the first of them is the defect above.
 *
 * WHAT THIS GATE DELIBERATELY DOES NOT CLAIM. It does NOT certify that every
 * other use is safe. Syntax alone cannot tell `pass it to a Client Component`
 * from `Object.keys(it)` or `String(it)` — both are just the identifier in an
 * argument position — so uses outside the five checked operations are recorded
 * as CARRIED and are not asserted about at all. It is an exact regression guard
 * for the class of defect that shipped, not a general proof of boundary safety.
 *
 * WHY THESE OPERATIONS AND NOT "is the export a component". Sorting exports into
 * components and constants needs a heuristic (`forwardRef`, `memo`, a factory
 * that returns a component) and would still miss the real failure, which is the
 * OPERATION performed on the binding rather than the shape of the value behind
 * it.
 *
 * FOUR ARMS, because the last one alone would pass vacuously:
 *
 *   1. THE GRAPH IS REAL. The walk reaches modules it must reach, through
 *      relative specifiers AND the tsconfig `paths` aliases the screen actually
 *      uses. A resolver that resolved nothing would report a clean tree.
 *   2. THE BOUNDARY IS DETECTED. `run-surface-rail.tsx` is `"use client"`, so
 *      the walk must STOP there and the module must NOT be in the server graph.
 *      A walk that ignored the directive would fold the client tree into the
 *      server one and find nothing to check.
 *   3. THERE IS SOMETHING TO CHECK. The screen's own client imports are counted,
 *      and `RunSurfaceRail` is pinned as an examined binding used as a JSX tag —
 *      the positive control for a rule whose failure mode is silence.
 *   4. NO SERVER MODULE EVALUATES A CLIENT IMPORT. The property itself.
 *
 * WHAT IT CANNOT SEE, stated rather than left to be discovered:
 *   - AN ALIAS. `const x = clientImport; x.schedule` is two statements, and only
 *     the second is a member read — of a local, which this gate does not track.
 *   - A NAME DECLARED TWICE. Identifiers are matched by TEXT, so if a module
 *     declares anything else with the same name as one of its client imports,
 *     that binding is skipped entirely rather than risk reporting a local as an
 *     import. No module in the graph does today.
 *   - A BARREL'S OWN BODY. Only `import … from` edges are walked. Following
 *     `export … from` too was tried and rejected on evidence: the chain
 *     `store.ts → run-transition.ts → @cinatra-ai/a2a → agent-executor.ts →
 *     @cinatra-ai/agents` arrives at this package's own index, whose re-exports
 *     drag in `register-default-renderers.ts` — a module the run page never
 *     dereferences, whose one call on a client import sits inside a registration
 *     function that the CLIENT entry calls and the server does not. Reachability
 *     through a barrel is not execution, so a violation found down that road
 *     would not be a defect on this page. The price of the narrower walk is that
 *     a barrel's own body goes unscanned.
 *   - A DYNAMIC `import()` of a client module, and a specifier this resolver
 *     cannot resolve (a bare package name outside the tsconfig `paths` map);
 *     both are skipped rather than guessed at.
 *
 * The scan is AST-based (`typescript`, already a repo devDependency) so that the
 * prose in these files, which discusses the constant by name, is never mistaken
 * for a use of it.
 *
 * Run:
 *   cd packages/agents && npx vitest run \
 *     src/__tests__/instance-screens-client-boundary.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCREEN = path.join(REPO_ROOT, "packages/agents/src/instance-screens.tsx");
const EXTENSIONS = [".ts", ".tsx"];

/** The tsconfig `paths` map, read with the compiler's own JSONC reader — the
 *  screen reaches `@/lib/...` and `@cinatra-ai/...` modules, and a walk that
 *  dropped them would stop at the package edge. */
const TSCONFIG_PATHS: Record<string, string[]> = (() => {
  const read = ts.readConfigFile(path.join(REPO_ROOT, "tsconfig.json"), (p) =>
    fs.readFileSync(p, "utf-8"),
  );
  return (read.config?.compilerOptions?.paths ?? {}) as Record<string, string[]>;
})();

const sources = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  const cached = sources.get(file);
  if (cached) return cached;
  const parsed = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf-8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  sources.set(file, parsed);
  return parsed;
}

/** The directive prologue — the run of leading bare string statements, which is
 *  where a directive is allowed to sit. Reading only `statements[0]` would miss
 *  a `"use client"` behind another directive; a `"use client"` after real code
 *  is not a directive at all and is correctly ignored here. */
function isClientModule(file: string): boolean {
  for (const statement of parse(file).statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteral(statement.expression)
    ) {
      return false;
    }
    if (statement.expression.text === "use client") return true;
  }
  return false;
}

function fileForBase(base: string): string | null {
  // A specifier that already names the file, extension and all.
  if (
    EXTENSIONS.some((ext) => base.endsWith(ext)) &&
    fs.existsSync(base) &&
    fs.statSync(base).isFile()
  ) {
    return base;
  }
  for (const ext of EXTENSIONS) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  for (const ext of EXTENSIONS) {
    const index = path.join(base, `index${ext}`);
    if (fs.existsSync(index)) return index;
  }
  return null;
}

function resolveSpecifier(from: string, specifier: string): string | null {
  if (specifier.startsWith(".")) {
    return fileForBase(path.resolve(path.dirname(from), specifier));
  }
  for (const [pattern, targets] of Object.entries(TSCONFIG_PATHS)) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      if (!specifier.startsWith(prefix)) continue;
      const rest = specifier.slice(prefix.length);
      for (const target of targets) {
        const hit = fileForBase(
          path.resolve(REPO_ROOT, target.replace(/\*$/, "") + rest),
        );
        if (hit) return hit;
      }
    } else if (specifier === pattern) {
      for (const target of targets) {
        const hit = fileForBase(path.resolve(REPO_ROOT, target));
        if (hit) return hit;
      }
    }
  }
  return null;
}

type ClientBinding = {
  /** The name this module calls it. */
  local: string;
  /** The name the client module exports it as. */
  imported: string;
  /** The `"use client"` module it came from. */
  from: string;
  /** The identifier in the import clause, so its own occurrence is not a use. */
  declaration: ts.Identifier;
};

/** Every VALUE binding a module imports DIRECTLY from a `"use client"` module.
 *  Type-only imports are erased before the boundary exists, so they are not
 *  bindings. */
function clientBindings(file: string): ClientBinding[] {
  const found: ClientBinding[] = [];
  for (const statement of parse(file).statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const target = resolveSpecifier(file, statement.moduleSpecifier.text);
    if (!target || !isClientModule(target)) continue;
    if (clause.name) {
      found.push({
        local: clause.name.text,
        imported: "default",
        from: target,
        declaration: clause.name,
      });
    }
    const named = clause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if (element.isTypeOnly) continue;
        found.push({
          local: element.name.text,
          imported: (element.propertyName ?? element.name).text,
          from: target,
          declaration: element.name,
        });
      }
    }
    if (named && ts.isNamespaceImport(named)) {
      found.push({
        local: named.name.text,
        imported: "* as",
        from: target,
        declaration: named.name,
      });
    }
  }
  return found;
}

/** Does anything ELSE in this module declare the same name? If so the binding is
 *  not analysed at all — reporting a local variable as if it were the import is
 *  the one way this gate could red a tree that is fine. */
function nameIsDeclaredTwice(file: string, binding: ClientBinding): boolean {
  let clash = false;
  const visit = (node: ts.Node): void => {
    if (clash) return;
    const named = node as ts.NamedDeclaration;
    if (
      named.name &&
      ts.isIdentifier(named.name) &&
      named.name.text === binding.local &&
      named.name !== binding.declaration &&
      !ts.isPropertyAssignment(node) &&
      !ts.isPropertySignature(node) &&
      !ts.isPropertyDeclaration(node) &&
      !ts.isMethodDeclaration(node) &&
      !ts.isMethodSignature(node) &&
      !ts.isEnumMember(node)
    ) {
      clash = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return clash;
}

type Use = { kind: string; line: number; evaluates: boolean };

/** What this module DOES with the binding, use by use. `evaluates` marks the
 *  operations that treat the tagged stub as the value behind it. */
function usesOf(file: string, binding: ClientBinding): Use[] {
  const source = parse(file);
  const uses: Use[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === binding.local &&
      node !== binding.declaration
    ) {
      const parent = node.parent;
      const line =
        source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const at = (kind: string, evaluates: boolean) =>
        uses.push({ kind, line, evaluates });
      if (parent && ts.isImportSpecifier(parent)) {
        // The import clause itself, under a rename.
      } else if (
        parent &&
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node
      ) {
        at(`MEMBER-READ .${parent.name.getText()}`, true);
      } else if (
        parent &&
        ts.isElementAccessExpression(parent) &&
        parent.expression === node
      ) {
        at("MEMBER-READ [computed]", true);
      } else if (
        parent &&
        ts.isCallExpression(parent) &&
        parent.expression === node
      ) {
        at("CALL", true);
      } else if (
        parent &&
        ts.isNewExpression(parent) &&
        parent.expression === node
      ) {
        at("NEW", true);
      } else if (
        parent &&
        ts.isTaggedTemplateExpression(parent) &&
        parent.tag === node
      ) {
        at("TAGGED-TEMPLATE", true);
      } else if (
        parent &&
        (ts.isJsxOpeningElement(parent) ||
          ts.isJsxSelfClosingElement(parent) ||
          ts.isJsxClosingElement(parent)) &&
        parent.tagName === node
      ) {
        at("jsx-tag", false);
      } else if (parent && ts.isExportSpecifier(parent)) {
        at("re-export", false);
      } else {
        at("carried", false);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

/** The RSC server graph: everything reachable from the screen WITHOUT crossing a
 *  `"use client"` boundary. A client module is where the server graph ends — the
 *  bundler compiles what lies beyond it for the browser, and a constant imported
 *  inside that tree is just a constant. */
function serverGraphFrom(entry: string): string[] {
  const graph: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    if (isClientModule(file)) return;
    graph.push(file);
    for (const statement of parse(file).statements) {
      // `import … from` only — what this module actually reaches to USE. A
      // barrel's `export … from` is deliberately not followed; see the header.
      if (!ts.isImportDeclaration(statement)) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (statement.importClause?.isTypeOnly) continue;
      const target = resolveSpecifier(file, statement.moduleSpecifier.text);
      if (target) walk(target);
    }
  };
  walk(entry);
  return graph;
}

const SERVER_GRAPH = serverGraphFrom(SCREEN);
const relative = (file: string) => path.relative(REPO_ROOT, file);

/** Every client binding every server module in the graph holds, with what it
 *  does with it. Computed once — the arms below read different parts of it. */
const EXAMINED = SERVER_GRAPH.filter(
  (file) => !/[\\/]__tests__[\\/]/.test(file) && !/\.test\.tsx?$/.test(file),
).flatMap((file) =>
  clientBindings(file)
    .filter((binding) => !nameIsDeclaredTwice(file, binding))
    .map((binding) => ({ file, binding, uses: usesOf(file, binding) })),
);

describe("the run page's server graph never evaluates a client import", () => {
  it("walks a real graph — relative specifiers and the tsconfig aliases both resolve", () => {
    const names = SERVER_GRAPH.map(relative);
    expect(names).toContain("packages/agents/src/instance-screens.tsx");
    // Reached through a relative specifier.
    expect(names).toContain("packages/agents/src/run-status.ts");
    expect(names).toContain("packages/agents/src/trigger-store.ts");
    // Reached only through a tsconfig `paths` alias (`@/...`), so an alias-blind
    // resolver stops at the package edge and this arm reds.
    expect(names.some((name) => name.startsWith("src/lib/"))).toBe(true);
    expect(SERVER_GRAPH.length).toBeGreaterThan(20);
  });

  it("stops at the boundary — a `use client` module is not IN the server graph", () => {
    const rail = path.join(REPO_ROOT, "packages/agents/src/run-surface-rail.tsx");
    expect(isClientModule(rail)).toBe(true);
    expect(SERVER_GRAPH).not.toContain(rail);
    // The labels the screen reads are on the SERVER side of the boundary, which
    // is the whole point of the module they were moved into.
    expect(SERVER_GRAPH).toContain(
      path.join(REPO_ROOT, "packages/agents/src/run-surface-rail-labels.ts"),
    );
    // And the screen that imports the rail IS in the graph, so the exclusion is
    // the directive doing its work rather than the module being unreachable.
    expect(SERVER_GRAPH).toContain(SCREEN);
  });

  it("has client bindings to check, and the rail component is one of them", () => {
    expect(EXAMINED.length).toBeGreaterThan(5);
    const rail = EXAMINED.find(
      (entry) => entry.binding.imported === "RunSurfaceRail",
    );
    // The positive control: the component the setup surface mounts is imported
    // from the client module, is seen by this scan, and is used the one way the
    // boundary carries.
    expect(rail).toBeDefined();
    expect(rail?.uses.map((use) => use.kind)).toContain("jsx-tag");
  });

  it("never reads a member of, calls, constructs or tags a client import", () => {
    const violations = EXAMINED.flatMap(({ file, binding, uses }) =>
      uses
        .filter((use) => use.evaluates)
        .map(
          (use) =>
            `${relative(file)}:${use.line} — ${use.kind} on \`${binding.imported}\`, ` +
            `imported from the "use client" module ${relative(binding.from)}`,
        ),
    );
    expect(violations).toEqual([]);
  });
});
