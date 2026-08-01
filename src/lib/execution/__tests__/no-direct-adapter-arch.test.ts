/**
 * ARCHITECTURE GATE — no production path reaches an LLM provider adapter
 * outside the four orchestration entry points (epic cinatra#1705, AC8).
 *
 * The epic's step/coverage boundary says: "specialized direct-adapter media
 * paths are formally excluded; CI regression guard forbids new direct
 * `adapter.generate/stream` calls outside the adapters + documented
 * exceptions." `entry-point-injection.test.ts` proves the four entry points DO
 * inject. Nothing proved that a fifth path cannot exist — a new
 * `adapter.generate(...)` anywhere in the tree silently skips
 * `injectExecutionCapability` (no sandbox tool, no cue, no step budget, no
 * session binding) and no test turns red. This file is that guard, and it runs
 * in the ROOT vitest suite (the `src/` gate of record), so a new bypass reds
 * the merge.
 *
 * SIX ARMS, because any one of them alone is evadable:
 *
 *   1. ACQUISITION. Every resolver that hands back an `LlmProviderAdapter` is
 *      pinned to a committed allowlist of CALLERS, and so is
 *      `surface.createAdapter()`. You cannot call `.generate()` on an adapter
 *      you were never able to obtain, which closes the rename hole in (2).
 *      The resolver SET is DERIVED from `registry.ts` rather than transcribed
 *      — a hand-listed set had already missed `resolveFirstAvailableAdapter`
 *      and `resolveDefaultImageAdapter`, which is exactly how this class of
 *      gate rots.
 *   2. CALL SITES, WITH MULTIPLICITY. Every `.generate(` / `.stream(` on an
 *      adapter is pinned by file + enclosing function + method AND BY COUNT.
 *      Without the count, a SECOND bypassing call added inside an already
 *      allowlisted entry point would share its key and pass.
 *   3. ORDER. An allowlisted orchestration call must sit AFTER an
 *      `applyExecutionInjection` call in the same function. "The function
 *      mentions the injection somewhere" is not the property — a bypass added
 *      ahead of the injection would satisfy it.
 *   4. PROBE-ONLY ACQUIRERS HOLD NO TURN. `invokes: false` is a checked claim,
 *      not prose.
 *   5. THE EXCEPTION CARRIES ITS REASON. The documented media exception is
 *      admissible under the epic's own D4 carve-out ("explicit single-step /
 *      structured-output tasks — no post-tool turn exists"), so the gate
 *      asserts that structural property (`maxSteps: 1`) rather than trusting a
 *      comment. An exception that grows a tool loop stops being the documented
 *      exception and reds here.
 *   6. EXTRACTION IS INVOCATION. `adapter.generate.bind(adapter)`, a
 *      `const { stream } = adapter` destructure, or the method handed off as a
 *      callback each produce a turn the call-site arm cannot see — its one
 *      CallExpression has `.bind` (or nothing at all) as its callee. Taking
 *      the method as a VALUE is therefore treated exactly like calling it.
 *
 * The scan is AST-based (`typescript`, already a repo devDependency) rather
 * than regex: `packages/llm/src/index.ts` and `src/lib/assistant-runtime/
 * runtime.ts` both DISCUSS `adapter.generate()` / `adapter.stream()` in
 * comments, and a textual gate either flags those (noise that trains reviewers
 * to widen the allowlist) or strips comments by hand (a second parser to get
 * wrong). It resolves import ALIASES, reads `obj["generate"]()` element access
 * as well as property access, accepts nested receivers, and covers every
 * module extension in the tree — each of those was a live evasion of the
 * first draft.
 *
 * WHAT IT STILL CANNOT SEE, stated rather than discovered later: a call
 * dispatched through a fully dynamic member name, and an adapter handed
 * through a helper in another module whose receiver is not named like an
 * adapter. Arm (1) is the backstop for both — such a path still has to obtain
 * the adapter from a resolver, and every resolver call site is pinned.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCAN_ROOTS = ["src", "packages"];
const MODULE_EXTENSIONS = /\.(tsx?|mts|cts|mjs|cjs|js)$/;
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  ".git",
  "coverage",
]);

/** The module that owns every adapter resolver and the single constructor. */
const REGISTRY_MODULE = "packages/llm/src/registry.ts";

/**
 * The resolvers `registry.ts` exports, as of this commit.
 *
 * DERIVED at run time from the module itself (every exported function whose
 * declared return type names `LlmProviderAdapter`) and then compared with this
 * list. The derived set is what the acquisition scan actually uses, so a NEW
 * resolver is covered the moment it exists — and the comparison below makes it
 * visible instead of silent.
 */
const EXPECTED_ADAPTER_RESOLVERS = [
  "resolveBoundDefaultAdapter",
  "resolveDefaultAdapter",
  "resolveDefaultImageAdapter",
  "resolveFirstAvailableAdapter",
  "resolveProviderAdapter",
];

/**
 * Every production module allowed to RESOLVE a provider adapter, with the
 * reason it may. Adding a file here is the deliberate act the gate exists to
 * force — it means a new module can reach a provider without the injection
 * site, and that decision belongs in a diff, not in a rename.
 *
 * `invokes: false` is a CHECKED claim: the gate asserts such a file holds no
 * adapter `.generate(` / `.stream(` call site at all.
 */
const ADAPTER_ACQUISITION_ALLOWLIST: ReadonlyArray<{
  file: string;
  invokes: boolean;
  reason: string;
}> = [
  {
    file: "packages/llm/src/index.ts",
    invokes: true,
    reason:
      "The orchestration layer itself. `getAdapter()` feeds the four entry " +
      "points, each of which calls applyExecutionInjection() first. Its " +
      "non-orchestration adapter methods (uploadFile / deleteFile / " +
      "generateWithFileInput / the batch wrappers) carry no tool loop.",
  },
  {
    file: "src/app/api/llm-bridge/route.ts",
    invokes: true,
    reason:
      "The bridge route's gemini-only media branch (see the call allowlist " +
      "below) plus `isAdapterAvailable`, a capability PROBE that resolves an " +
      "adapter only to test it for null and never invokes it.",
  },
  {
    file: "src/lib/agent-llm-preflight.ts",
    invokes: false,
    reason:
      "AVAILABILITY PROBE. `defaultAdapterAvailabilityProbe` resolves an " +
      "adapter only to compare it against null — a provider is available iff " +
      "its adapter resolves. The adapter itself is discarded.",
  },
  {
    file: "src/lib/mcp-server.ts",
    invokes: false,
    reason:
      "AVAILABILITY PROBE. `readConfiguredLlmProviders` resolves each of the " +
      "three providers to report WHICH are configured; it returns provider " +
      "ids and discards every adapter.",
  },
  {
    file: "src/lib/blog/gemini.ts",
    invokes: false,
    reason:
      "IMAGE ADAPTER. `resolveDefaultImageAdapter()` then `generateImage()` — " +
      "a single-shot image call with no tool loop and no post-tool turn, so " +
      "there is no step for a sandbox capability to occupy (the same " +
      "structural reason as the D4 single-step carve-out). It runs NO " +
      "`generate`/`stream` turn, and the probe-only arm below checks that.",
  },
  {
    file: "src/lib/assistant-runtime/runtime.ts",
    invokes: false,
    reason:
      "IDENTITY READ, then hand-off. The assistant runtime resolves the " +
      "assistant's pinned (or bound-default) adapter to read `provider` / " +
      "`defaultModel` — which decide the skill-delivery vehicle and the " +
      "native-MCP posture — and then runs the turn through the orchestration " +
      "`stream()` entry point, which is where injection happens. It never " +
      "invokes the adapter it resolved.",
  },
];

/**
 * Every `.generate(` / `.stream(` call on an adapter: enclosing function,
 * method, HOW MANY, and why it is not an injection bypass.
 */
const ADAPTER_CALL_ALLOWLIST: ReadonlyArray<{
  file: string;
  fn: string;
  method: "generate" | "stream";
  count: number;
  injects: boolean;
  reason: string;
}> = [
  {
    file: "packages/llm/src/index.ts",
    fn: "runDeterministicLlmTaskImpl",
    method: "generate",
    count: 1,
    injects: true,
    reason: "Orchestration entry point 1 of 4.",
  },
  {
    file: "packages/llm/src/index.ts",
    fn: "runSkillAwareDeterministicLlmTaskImpl",
    method: "generate",
    count: 1,
    injects: true,
    reason: "Orchestration entry point 2 of 4.",
  },
  {
    file: "packages/llm/src/index.ts",
    fn: "orchestrateGenerateImpl",
    method: "generate",
    count: 1,
    injects: true,
    reason: "Orchestration entry point 3 of 4 (`generate`).",
  },
  {
    file: "packages/llm/src/index.ts",
    fn: "orchestrateStreamImpl",
    method: "stream",
    count: 1,
    injects: true,
    reason: "Orchestration entry point 4 of 4 (`stream`).",
  },
  {
    file: "src/app/api/llm-bridge/route.ts",
    fn: "POST",
    method: "generate",
    count: 1,
    injects: false,
    reason:
      "DOCUMENTED EXCEPTION — the gemini YouTube media branch. Native URL " +
      "ingestion, one shot, `maxSteps: 1`: no post-tool turn exists, which is " +
      "the epic's own D4 technical carve-out from the ON-by-default " +
      "capability. The gate asserts that `maxSteps: 1` below, so this stops " +
      "being the documented exception the moment it grows a tool loop.",
  },
];

/**
 * Receivers that merely READ like an LLM adapter.
 *
 * The tree-wide receiver backstop matches on the name, and the name is all a
 * syntactic scan has. There are unrelated adapters in this codebase — the
 * AG-UI sink in `src/lib/assistant-runtime/ag-ui-stream-route.ts` is literally
 * a `const adapter` — and one of them growing a `.stream()` method would land
 * here with no relation to an LLM provider. That is a one-line, reviewed
 * exemption rather than a reason to drop the backstop, which is the only arm
 * that sees an adapter arriving through another module's helper.
 *
 * Empty today: nothing in the tree currently trips it.
 */
const NON_LLM_ADAPTER_CALLS: ReadonlyArray<{
  file: string;
  fn: string;
  method: "generate" | "stream";
  reason: string;
}> = [];

const INJECTION_SITE_FN = "applyExecutionInjection";

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) yield* walk(abs);
    else if (MODULE_EXTENSIONS.test(entry)) yield abs;
  }
}

const isTestFile = (rel: string): boolean =>
  /\.test\.[a-z]+$/.test(rel) ||
  rel.includes("/__tests__/") ||
  rel.includes("/__mocks__/") ||
  rel.includes("/tests/");

type SourceFile = { rel: string; ast: ts.SourceFile; aliases: Map<string, string> };

/**
 * Local name -> imported name, so `import { resolveDefaultAdapter as pick }`
 * cannot hide a resolver call behind a rename.
 */
function importAliases(ast: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.propertyName) {
        aliases.set(element.name.text, element.propertyName.text);
      }
    }
  }
  return aliases;
}

function productionSources(): SourceFile[] {
  const out: SourceFile[] = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of walk(path.join(REPO_ROOT, root))) {
      const rel = path.relative(REPO_ROOT, abs).replaceAll("\\", "/");
      if (isTestFile(rel)) continue;
      const ast = ts.createSourceFile(
        rel,
        readFileSync(abs, "utf8"),
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      out.push({ rel, ast, aliases: importAliases(ast) });
    }
  }
  return out;
}

const FILES = productionSources();

function eachNode(root: ts.Node, visit: (node: ts.Node) => void): void {
  const step = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, step);
  };
  step(root);
}

/** The literal member name of a property/element access, when there is one. */
function memberName(node: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

/** The receiver expression of a property/element access, when there is one. */
function receiverOf(node: ts.Expression): ts.Expression | null {
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return node.expression;
  }
  return null;
}

/** `foo(...)` -> "foo" (through import aliases); `a.b.foo(...)` -> "foo". */
function calleeName(file: SourceFile, node: ts.CallExpression): string | null {
  const expr = node.expression;
  if (ts.isIdentifier(expr)) return file.aliases.get(expr.text) ?? expr.text;
  return memberName(expr);
}

function fileCalls(file: SourceFile, names: ReadonlySet<string>): boolean {
  let hit = false;
  eachNode(file.ast, (node) => {
    if (!ts.isCallExpression(node)) return;
    const name = calleeName(file, node);
    if (name !== null && names.has(name)) hit = true;
  });
  return hit;
}

/** The nearest named function/method/arrow-in-a-const around a node. */
function enclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text;
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    current = current.parent;
  }
  return "<module scope>";
}

const lineOf = (file: SourceFile, node: ts.Node): number =>
  file.ast.getLineAndCharacterOfPosition(node.getStart(file.ast)).line + 1;

// ---------------------------------------------------------------------------
// The resolver set, derived from registry.ts
// ---------------------------------------------------------------------------

function derivedResolverNames(): string[] {
  const registry = FILES.find((f) => f.rel === REGISTRY_MODULE);
  if (!registry) return [];
  const names: string[] = [];
  eachNode(registry.ast, (node) => {
    if (!ts.isFunctionDeclaration(node) || !node.name || !node.type) return;
    const exported = ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) return;
    if (!/\bLlmProviderAdapter\b/.test(node.type.getText(registry.ast))) return;
    names.push(node.name.text);
  });
  return names.sort();
}

const ADAPTER_RESOLVERS = new Set(derivedResolverNames());
const ACQUISITION_NAMES = new Set([...ADAPTER_RESOLVERS, "createAdapter"]);

/** Does this subtree obtain a provider adapter anywhere inside it? */
function containsAcquisition(file: SourceFile, node: ts.Node): boolean {
  let found = false;
  eachNode(node, (child) => {
    if (!ts.isCallExpression(child)) return;
    const name = calleeName(file, child);
    if (name !== null && ACQUISITION_NAMES.has(name)) found = true;
  });
  return found;
}

type CallSite = {
  file: string;
  line: number;
  pos: number;
  fn: string;
  method: "generate" | "stream";
  receiver: string;
  node: ts.CallExpression;
};

/**
 * Adapter `.generate(` / `.stream(` call sites in one file.
 *
 * A receiver counts as an adapter when EITHER it was bound from a resolution
 * in this file (or annotated `LlmProviderAdapter`), OR it simply reads like an
 * adapter. The second clause is the tree-wide backstop: the binding analysis
 * is per-file and would miss an adapter arriving through a helper's return
 * value, and the whole point of the gate is that a bypass must not be one
 * refactor away.
 */
function boundAdapterNames(file: SourceFile): Set<string> {
  const bound = new Set<string>();
  eachNode(file.ast, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const annotated =
        node.type !== undefined &&
        /\bLlmProviderAdapter\b/.test(node.type.getText(file.ast));
      if (annotated || (node.initializer && containsAcquisition(file, node.initializer))) {
        bound.add(node.name.text);
      }
      return;
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type) {
      if (/\bLlmProviderAdapter\b/.test(node.type.getText(file.ast))) {
        bound.add(node.name.text);
      }
    }
  });
  return bound;
}

/** The leftmost identifier of a receiver chain (`this.svc.adapter` -> "this"). */
function leftmostIdentifier(expr: ts.Expression): string {
  let leftmost: ts.Node = expr;
  while (
    ts.isPropertyAccessExpression(leftmost) ||
    ts.isElementAccessExpression(leftmost) ||
    ts.isCallExpression(leftmost) ||
    ts.isNonNullExpression(leftmost) ||
    ts.isParenthesizedExpression(leftmost)
  ) {
    leftmost = (leftmost as { expression: ts.Node }).expression;
  }
  return ts.isIdentifier(leftmost) ? leftmost.text : "";
}

function isAdapterReceiver(
  file: SourceFile,
  bound: ReadonlySet<string>,
  receiverNode: ts.Expression,
): boolean {
  const receiver = receiverNode.getText(file.ast).replace(/\s+/g, "");
  return bound.has(leftmostIdentifier(receiverNode)) || /adapter/i.test(receiver);
}

function adapterCallSites(file: SourceFile): CallSite[] {
  const bound = boundAdapterNames(file);

  const sites: CallSite[] = [];
  eachNode(file.ast, (node) => {
    if (!ts.isCallExpression(node)) return;
    const method = memberName(node.expression);
    if (method !== "generate" && method !== "stream") return;
    const receiverNode = receiverOf(node.expression);
    if (!receiverNode) return;
    const receiver = receiverNode.getText(file.ast).replace(/\s+/g, "");
    if (!isAdapterReceiver(file, bound, receiverNode)) return;
    sites.push({
      file: file.rel,
      line: lineOf(file, node),
      pos: node.getStart(file.ast),
      fn: enclosingFunctionName(node),
      method,
      receiver,
      node,
    });
  });
  return sites;
}

type MethodReference = {
  file: string;
  line: number;
  fn: string;
  method: "generate" | "stream";
  text: string;
};

/**
 * Adapter `.generate` / `.stream` taken as a VALUE rather than called.
 *
 * The call-site scan only recognizes a call whose direct callee is the method,
 * so `const invoke = adapter.generate.bind(adapter); await invoke(opts)` walked
 * straight past it: the one CallExpression it sees has `.bind` as its callee,
 * and the invocation is a bare identifier. `const { stream } = adapter` and
 * `queue.push(adapter.generate)` are the same move. Every one of them is a
 * direct-adapter turn with the receiver laundered through one extra binding —
 * which is precisely the class this gate exists to make impossible, so
 * EXTRACTING the method is treated exactly like calling it.
 *
 * (Codex round 2 found this; it was not among the documented blind spots.)
 */
function adapterMethodReferences(file: SourceFile): MethodReference[] {
  const bound = boundAdapterNames(file);
  const refs: MethodReference[] = [];
  const record = (node: ts.Node, method: "generate" | "stream"): void => {
    refs.push({
      file: file.rel,
      line: lineOf(file, node),
      fn: enclosingFunctionName(node),
      method,
      text: node.getText(file.ast).replace(/\s+/g, " ").slice(0, 120),
    });
  };
  eachNode(file.ast, (node) => {
    // `adapter.generate` / `adapter["stream"]` NOT in callee position.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const method = memberName(node);
      if (method !== "generate" && method !== "stream") return;
      if (!isAdapterReceiver(file, bound, node.expression)) return;
      const parent = node.parent;
      const isCallee =
        parent !== undefined &&
        ts.isCallExpression(parent) &&
        parent.expression === node;
      if (isCallee) return; // a plain call — the call-site scan owns it
      record(node, method);
      return;
    }
    // `const { generate } = adapter` / `const { stream: run } = adapter`.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isAdapterReceiver(file, bound, node.initializer)
    ) {
      for (const element of node.name.elements) {
        const source = element.propertyName ?? element.name;
        if (!ts.isIdentifier(source)) continue;
        if (source.text !== "generate" && source.text !== "stream") continue;
        record(element, source.text);
      }
    }
  });
  return refs;
}

const ALL_CALL_SITES = FILES.flatMap(adapterCallSites);
const ALL_METHOD_REFERENCES = FILES.flatMap(adapterMethodReferences);

const keyOf = (site: { file: string; fn: string; method: string }): string =>
  `${site.file} :: ${site.fn}() :: .${site.method}()`;

/** Earliest `applyExecutionInjection(` position per file+function. */
const INJECTION_POSITIONS = ((): Map<string, number> => {
  const out = new Map<string, number>();
  for (const file of FILES) {
    eachNode(file.ast, (node) => {
      if (!ts.isCallExpression(node) || calleeName(file, node) !== INJECTION_SITE_FN) return;
      const key = `${file.rel} :: ${enclosingFunctionName(node)}()`;
      const pos = node.getStart(file.ast);
      const seen = out.get(key);
      if (seen === undefined || pos < seen) out.set(key, pos);
    });
  }
  return out;
})();

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("direct-adapter architecture gate (epic #1705 AC8)", () => {
  it("finds a source tree to scan (the gate is not vacuously green)", () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(ALL_CALL_SITES.length).toBeGreaterThanOrEqual(5);
    expect(ADAPTER_RESOLVERS.size).toBeGreaterThan(0);
    expect(INJECTION_POSITIONS.size).toBeGreaterThanOrEqual(4);
  });

  it("the adapter-resolver set is exactly what registry.ts exports", () => {
    expect(
      derivedResolverNames(),
      "registry.ts gained or lost a function that hands back an " +
        "LlmProviderAdapter. The acquisition scan already covers it (the set " +
        "is derived, not transcribed) — update this list so the change is " +
        "recorded rather than silent.",
    ).toEqual([...EXPECTED_ADAPTER_RESOLVERS].sort());
  });

  it("`surface.createAdapter()` is called in exactly one production module", () => {
    const callers = FILES.filter((f) => fileCalls(f, new Set(["createAdapter"]))).map(
      (f) => f.rel,
    );
    expect(callers.sort()).toEqual([REGISTRY_MODULE]);
  });

  it("only allowlisted modules resolve a provider adapter", () => {
    const resolvers = FILES.filter((f) => fileCalls(f, ADAPTER_RESOLVERS)).map((f) => f.rel);
    // registry.ts DEFINES the resolvers and composes them from each other; it
    // is not an external caller.
    const allowed = new Set([
      ...ADAPTER_ACQUISITION_ALLOWLIST.map((entry) => entry.file),
      REGISTRY_MODULE,
    ]);
    const offenders = resolvers.filter((rel) => !allowed.has(rel));
    expect(
      offenders,
      "A new module resolves an LLM provider adapter. It can now reach a " +
        "provider without injectExecutionCapability(). Route it through an " +
        "orchestration entry point, or add it to " +
        "ADAPTER_ACQUISITION_ALLOWLIST with a reason.",
    ).toEqual([]);
    expect(resolvers.length).toBeGreaterThanOrEqual(
      ADAPTER_ACQUISITION_ALLOWLIST.length,
    );
  });

  it("every adapter .generate/.stream call site is allowlisted, WITH its count", () => {
    const allowed = new Map(ADAPTER_CALL_ALLOWLIST.map((e) => [keyOf(e), e.count]));
    const exempt = new Set(NON_LLM_ADAPTER_CALLS.map(keyOf));
    const observed = new Map<string, CallSite[]>();
    for (const site of ALL_CALL_SITES) {
      const key = keyOf(site);
      if (exempt.has(key)) continue;
      observed.set(key, [...(observed.get(key) ?? []), site]);
    }
    const offenders = [...observed.entries()]
      .filter(([key]) => !allowed.has(key))
      .flatMap(([, sites]) =>
        sites.map(
          (site) =>
            `${site.file}:${site.line} — ${site.receiver}.${site.method}() in ${site.fn}()`,
        ),
      );
    expect(
      offenders,
      "A direct provider-adapter call outside the injection sites. This path " +
        "gets no sandbox_execute tool, no policy cue, no tool-aware step " +
        "budget and no execution session (epic #1705 AC8). Call an " +
        "orchestration entry point instead; add a documented exception to " +
        "ADAPTER_CALL_ALLOWLIST; or, if the receiver is an unrelated " +
        "non-LLM adapter, record it in NON_LLM_ADAPTER_CALLS.",
    ).toEqual([]);

    // MULTIPLICITY. A second call added inside an already-allowlisted entry
    // point would otherwise share its key and pass unseen.
    const miscounted = [...allowed.entries()]
      .map(([key, count]) => ({ key, count, actual: observed.get(key)?.length ?? 0 }))
      .filter((row) => row.actual !== row.count)
      .map((row) => `${row.key}: allowlisted ${row.count}, found ${row.actual}`);
    expect(
      miscounted,
      "The number of adapter calls in an allowlisted function changed. A NEW " +
        "call in an existing entry point is still a new direct-adapter path.",
    ).toEqual([]);
  });

  it("nothing EXTRACTS an adapter turn as a value (bind / destructure / callback)", () => {
    expect(
      ALL_METHOD_REFERENCES.map(
        (ref) => `${ref.file}:${ref.line} — ${ref.text} in ${ref.fn}()`,
      ),
      "An adapter's `generate`/`stream` is taken as a VALUE rather than called " +
        "(`.bind(...)`, a destructure, a callback). The call-site arm cannot " +
        "see the invocation that follows, so this is a direct-adapter turn " +
        "with the receiver laundered through one extra binding — the exact " +
        "AC8 bypass. Call the orchestration entry point instead.",
    ).toEqual([]);
  });

  it("the allowlist has no stale entries (every documented site still exists)", () => {
    const live = new Set(ALL_CALL_SITES.map(keyOf));
    expect(
      ADAPTER_CALL_ALLOWLIST.map(keyOf).filter((key) => !live.has(key)),
      "An allowlisted call site is gone. Delete the entry — a stale allowlist " +
        "silently pre-approves the next path that lands on that name.",
    ).toEqual([]);
    expect(
      NON_LLM_ADAPTER_CALLS.map(keyOf).filter((key) => !live.has(key)),
      "A non-LLM exemption no longer matches anything. Delete it.",
    ).toEqual([]);
    expect(
      ADAPTER_ACQUISITION_ALLOWLIST.map((entry) => entry.file).filter(
        (file) => !FILES.some((f) => f.rel === file),
      ),
    ).toEqual([]);
  });

  it("a probe-only acquirer holds no adapter turn at all", () => {
    const probeFiles = new Set(
      ADAPTER_ACQUISITION_ALLOWLIST.filter((entry) => !entry.invokes).map(
        (entry) => entry.file,
      ),
    );
    expect(probeFiles.size).toBeGreaterThan(0);
    expect(
      ALL_CALL_SITES.filter((site) => probeFiles.has(site.file)).map(
        (site) =>
          `${site.file}:${site.line} — ${site.receiver}.${site.method}() in ${site.fn}()`,
      ),
      "A module documented as a probe / identity read now runs a turn on the " +
        "adapter it resolved. Either route the turn through an orchestration " +
        "entry point, or flip its ADAPTER_ACQUISITION_ALLOWLIST entry to " +
        "`invokes: true` AND add the call site to ADAPTER_CALL_ALLOWLIST.",
    ).toEqual([]);
  });

  it("every orchestration call site injects the capability BEFORE it calls", () => {
    const injecting = ADAPTER_CALL_ALLOWLIST.filter((entry) => entry.injects);
    const missing = injecting
      .filter((entry) => !INJECTION_POSITIONS.has(`${entry.file} :: ${entry.fn}()`))
      .map((entry) => `${entry.file} :: ${entry.fn}()`);
    expect(
      missing,
      "An entry point still calls its adapter but no longer calls " +
        `${INJECTION_SITE_FN}(). The call is allowlisted, so nothing else in ` +
        "this gate would notice — that is precisely the AC8 regression.",
    ).toEqual([]);

    // ORDER, not mere presence: an adapter call placed AHEAD of the injection
    // would satisfy "the function injects somewhere" while bypassing it.
    const outOfOrder = injecting.flatMap((entry) => {
      const injectionPos = INJECTION_POSITIONS.get(`${entry.file} :: ${entry.fn}()`);
      if (injectionPos === undefined) return [];
      return ALL_CALL_SITES.filter(
        (site) => keyOf(site) === keyOf(entry) && site.pos < injectionPos,
      ).map((site) => `${site.file}:${site.line} in ${site.fn}()`);
    });
    expect(
      outOfOrder,
      "An adapter call runs BEFORE this function's applyExecutionInjection() " +
        "call — it therefore carries no injected capability.",
    ).toEqual([]);

    expect(injecting.map((entry) => entry.fn).sort()).toEqual(
      [
        "orchestrateGenerateImpl",
        "orchestrateStreamImpl",
        "runDeterministicLlmTaskImpl",
        "runSkillAwareDeterministicLlmTaskImpl",
      ].sort(),
    );
  });

  it("the documented media exception is still a single-step call (D4 carve-out)", () => {
    const exceptions = ADAPTER_CALL_ALLOWLIST.filter((entry) => !entry.injects);
    expect(exceptions.length).toBeGreaterThan(0);
    for (const entry of exceptions) {
      const sites = ALL_CALL_SITES.filter((site) => keyOf(site) === keyOf(entry));
      expect(sites.length, `${keyOf(entry)} not found`).toBe(1);
      const site = sites[0];
      const [arg] = site.node.arguments;
      expect(
        arg !== undefined && ts.isObjectLiteralExpression(arg),
        `${keyOf(entry)} does not take an options object — re-verify the exception`,
      ).toBe(true);
      if (arg === undefined || !ts.isObjectLiteralExpression(arg)) continue;
      const maxSteps = arg.properties.find(
        (prop): prop is ts.PropertyAssignment =>
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === "maxSteps",
      );
      expect(
        maxSteps?.initializer.getText(site.node.getSourceFile()),
        "The documented exception is admissible ONLY because it is an explicit " +
          "single-step task with no post-tool turn (epic D4). A multi-step " +
          "direct-adapter call is a bypass, not an exception.",
      ).toBe("1");
    }
  });
});
