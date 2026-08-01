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
 * It is deliberately two-sided, because either half alone is evadable:
 *
 *   1. ACQUISITION. `resolveProviderAdapter` (packages/llm/src/registry.ts) is
 *      the only way to obtain an adapter, and `surface.createAdapter()` is the
 *      only way to build one. Both call-sets are pinned to a committed
 *      allowlist. You cannot call `.generate()` on an adapter you were never
 *      able to obtain, so this closes the rename hole in (2).
 *   2. CALL SITES. Every `.generate(` / `.stream(` invocation on an
 *      adapter-bound identifier is pinned to a committed allowlist keyed by
 *      file + enclosing function, each carrying its reason. A new call site is
 *      a red gate.
 *   3. NOT A BLANK CHEQUE. Each of the four allowlisted orchestration call
 *      sites must sit in an impl that also calls `applyExecutionInjection` —
 *      an entry point that kept its adapter call but dropped its injection is
 *      exactly the regression AC8 exists to prevent, and an allowlist keyed on
 *      the call alone would not see it.
 *   4. THE EXCEPTION CARRIES ITS REASON. The documented media exception is
 *      admissible under the epic's own D4 carve-out ("explicit single-step /
 *      structured-output tasks — no post-tool turn exists"), so the gate
 *      asserts that structural property (`maxSteps: 1`) rather than trusting a
 *      comment. An exception that grows a tool loop stops being the documented
 *      exception and reds here.
 *
 * The scan is AST-based (`typescript`, already a repo devDependency) rather
 * than regex: `packages/llm/src/index.ts` and `src/lib/assistant-runtime/
 * runtime.ts` both DISCUSS `adapter.generate()` / `adapter.stream()` in
 * comments, and a textual gate either flags those (noise that trains reviewers
 * to widen the allowlist) or strips comments by hand (a second parser to get
 * wrong). Comments and string literals are not call expressions, so the AST
 * simply does not see them.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCAN_ROOTS = ["src", "packages"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  ".git",
  "coverage",
]);

/** The sole adapter constructor: `surface.createAdapter()`. */
const CREATE_ADAPTER_HOME = ["packages/llm/src/registry.ts"];

/**
 * Every way to obtain an `LlmProviderAdapter`. All three resolvers live in
 * `packages/llm/src/registry.ts` and all three hand back a live adapter, so
 * pinning only the by-provider one would leave the two default resolvers as an
 * open door.
 */
const ADAPTER_RESOLVERS = [
  "resolveProviderAdapter",
  "resolveDefaultAdapter",
  "resolveBoundDefaultAdapter",
] as const;

/**
 * Every production module allowed to RESOLVE a provider adapter, with the
 * reason it may. Adding a file here is the deliberate act the gate exists to
 * force — it means a new module can reach a provider without the injection
 * site, and that decision belongs in a diff, not in a rename.
 *
 * `invokes: false` is a CHECKED claim, not prose: the gate asserts such a file
 * holds no adapter `.generate(` / `.stream(` call site at all. A probe that
 * grows a turn stops being a probe and reds here.
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
 * Every `.generate(` / `.stream(` call on an adapter, with its enclosing
 * function and the reason it is not an injection bypass.
 *
 * `injects: true` additionally demands that the enclosing impl calls
 * `applyExecutionInjection` — see (3) in the header.
 */
const ADAPTER_CALL_ALLOWLIST: ReadonlyArray<{
  file: string;
  fn: string;
  method: "generate" | "stream";
  injects: boolean;
  reason: string;
}> = [
  {
    file: "packages/llm/src/index.ts",
    fn: "runDeterministicLlmTaskImpl",
    method: "generate",
    injects: true,
    reason: "Orchestration entry point 1 of 4.",
  },
  {
    file: "packages/llm/src/index.ts",
    fn: "runSkillAwareDeterministicLlmTaskImpl",
    method: "generate",
    injects: true,
    reason: "Orchestration entry point 2 of 4.",
  },
  {
    file: "packages/llm/src/index.ts",
    fn: "orchestrateGenerateImpl",
    method: "generate",
    injects: true,
    reason: "Orchestration entry point 3 of 4 (`generate`).",
  },
  {
    file: "packages/llm/src/index.ts",
    fn: "orchestrateStreamImpl",
    method: "stream",
    injects: true,
    reason: "Orchestration entry point 4 of 4 (`stream`).",
  },
  {
    file: "src/app/api/llm-bridge/route.ts",
    fn: "POST",
    method: "generate",
    injects: false,
    reason:
      "DOCUMENTED EXCEPTION — the gemini YouTube media branch. Native URL " +
      "ingestion, one shot, `maxSteps: 1`: no post-tool turn exists, which is " +
      "the epic's own D4 technical carve-out from the ON-by-default " +
      "capability. The gate asserts that `maxSteps: 1` below, so this stops " +
      "being the documented exception the moment it grows a tool loop.",
  },
];

/** The four impls that must each carry an injection call. */
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
    else if (/\.tsx?$/.test(entry)) yield abs;
  }
}

const isTestFile = (rel: string): boolean =>
  /\.test\.tsx?$/.test(rel) ||
  rel.includes("/__tests__/") ||
  rel.includes("/__mocks__/") ||
  rel.includes("/tests/");

type SourceFile = { rel: string; ast: ts.SourceFile };

function productionSources(): SourceFile[] {
  const out: SourceFile[] = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of walk(path.join(REPO_ROOT, root))) {
      const rel = path.relative(REPO_ROOT, abs).replaceAll("\\", "/");
      if (isTestFile(rel)) continue;
      out.push({
        rel,
        ast: ts.createSourceFile(
          rel,
          readFileSync(abs, "utf8"),
          ts.ScriptTarget.Latest,
          /* setParentNodes */ true,
          rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        ),
      });
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

/** `foo(...)` yields "foo"; `a.b.foo(...)` yields "foo". Anything else, null. */
function calleeName(node: ts.CallExpression): string | null {
  const expr = node.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    return expr.name.text;
  }
  return null;
}

function fileCalls(file: SourceFile, name: string): boolean {
  let hit = false;
  eachNode(file.ast, (node) => {
    if (ts.isCallExpression(node) && calleeName(node) === name) hit = true;
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

/** Does this subtree resolve a provider adapter anywhere inside it? */
function containsAcquisition(node: ts.Node): boolean {
  let found = false;
  eachNode(node, (child) => {
    if (!ts.isCallExpression(child)) return;
    const name = calleeName(child);
    if (name === null) return;
    if (name === "createAdapter" || (ADAPTER_RESOLVERS as readonly string[]).includes(name)) {
      found = true;
    }
  });
  return found;
}

type CallSite = {
  file: string;
  line: number;
  fn: string;
  method: "generate" | "stream";
  receiver: string;
  node: ts.CallExpression;
};

/**
 * Adapter `.generate(` / `.stream(` call sites in one file.
 *
 * A receiver counts as an adapter when EITHER it was bound from a resolution in
 * this file (or annotated `LlmProviderAdapter`), OR its name simply reads like
 * an adapter. The second clause is the tree-wide backstop: the binding analysis
 * is per-file and would miss an adapter arriving through a helper's return
 * value, and the whole point of the gate is that a bypass must not be one
 * refactor away.
 */
function adapterCallSites(file: SourceFile): CallSite[] {
  const bound = new Set<string>();
  eachNode(file.ast, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const annotated =
        node.type !== undefined &&
        /\bLlmProviderAdapter\b/.test(node.type.getText(file.ast));
      if (annotated || (node.initializer && containsAcquisition(node.initializer))) {
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

  const sites: CallSite[] = [];
  eachNode(file.ast, (node) => {
    if (!ts.isCallExpression(node)) return;
    const expr = node.expression;
    if (!ts.isPropertyAccessExpression(expr) || !ts.isIdentifier(expr.name)) return;
    const method = expr.name.text;
    if (method !== "generate" && method !== "stream") return;
    // `a.b.generate()` — only a plain identifier receiver is analysable, and
    // every adapter binding in this tree is one.
    if (!ts.isIdentifier(expr.expression)) return;
    const receiver = expr.expression.text;
    if (!bound.has(receiver) && !/adapter/i.test(receiver)) return;
    sites.push({
      file: file.rel,
      line: lineOf(file, node),
      fn: enclosingFunctionName(node),
      method,
      receiver,
      node,
    });
  });
  return sites;
}

const ALL_CALL_SITES = FILES.flatMap(adapterCallSites);

const keyOf = (site: { file: string; fn: string; method: string }): string =>
  `${site.file} :: ${site.fn}() :: .${site.method}()`;

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("direct-adapter architecture gate (epic #1705 AC8)", () => {
  it("finds a source tree to scan (the gate is not vacuously green)", () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(ALL_CALL_SITES.length).toBeGreaterThanOrEqual(5);
  });

  it("`surface.createAdapter()` is called in exactly one production module", () => {
    const callers = FILES.filter((f) => fileCalls(f, "createAdapter")).map((f) => f.rel);
    expect(callers.sort()).toEqual([...CREATE_ADAPTER_HOME].sort());
  });

  it("only allowlisted modules resolve a provider adapter", () => {
    const resolvers = FILES.filter((f) =>
      ADAPTER_RESOLVERS.some((name) => fileCalls(f, name)),
    ).map((f) => f.rel);
    // registry.ts DEFINES the resolvers; it is not a caller of itself.
    const allowed = new Set([
      ...ADAPTER_ACQUISITION_ALLOWLIST.map((entry) => entry.file),
      ...CREATE_ADAPTER_HOME,
    ]);
    const offenders = resolvers.filter((rel) => !allowed.has(rel));
    expect(
      offenders,
      "A new module resolves an LLM provider adapter. It can now reach a " +
        "provider without injectExecutionCapability(). Route it through an " +
        "orchestration entry point, or add it to " +
        "ADAPTER_ACQUISITION_ALLOWLIST with a reason.",
    ).toEqual([]);
    // Non-vacuity: the resolvers really are reachable and really are found.
    expect(resolvers.length).toBeGreaterThanOrEqual(
      ADAPTER_ACQUISITION_ALLOWLIST.length,
    );
  });

  it("a probe-only acquirer holds no adapter turn at all", () => {
    // The allowlist's `invokes: false` entries claim they resolve an adapter
    // and never run a turn on it. That claim is what makes them harmless, so
    // the gate checks it instead of believing the comment.
    const probeFiles = new Set(
      ADAPTER_ACQUISITION_ALLOWLIST.filter((entry) => !entry.invokes).map(
        (entry) => entry.file,
      ),
    );
    const offenders = ALL_CALL_SITES.filter((site) => probeFiles.has(site.file)).map(
      (site) =>
        `${site.file}:${site.line} — ${site.receiver}.${site.method}() in ${site.fn}()`,
    );
    expect(
      offenders,
      "A module documented as a probe / identity read now runs a turn on the " +
        "adapter it resolved. Either route the turn through an orchestration " +
        "entry point, or flip its ADAPTER_ACQUISITION_ALLOWLIST entry to " +
        "`invokes: true` AND add the call site to ADAPTER_CALL_ALLOWLIST.",
    ).toEqual([]);
    expect(probeFiles.size).toBeGreaterThan(0);
  });

  it("every adapter .generate/.stream call site is on the committed allowlist", () => {
    const allowed = new Set(ADAPTER_CALL_ALLOWLIST.map(keyOf));
    const offenders = ALL_CALL_SITES.filter((site) => !allowed.has(keyOf(site))).map(
      (site) =>
        `${site.file}:${site.line} — ${site.receiver}.${site.method}() in ${site.fn}()`,
    );
    expect(
      offenders,
      "A direct provider-adapter call outside the injection sites. This path " +
        "gets no sandbox_execute tool, no policy cue, no tool-aware step " +
        "budget and no execution session (epic #1705 AC8). Call an " +
        "orchestration entry point instead, or add a documented exception to " +
        "ADAPTER_CALL_ALLOWLIST.",
    ).toEqual([]);
  });

  it("the allowlist has no stale entries (every documented site still exists)", () => {
    const live = new Set(ALL_CALL_SITES.map(keyOf));
    const stale = ADAPTER_CALL_ALLOWLIST.map(keyOf).filter((key) => !live.has(key));
    expect(
      stale,
      "An allowlisted call site is gone. Delete the entry — a stale allowlist " +
        "silently pre-approves the next path that lands on that name.",
    ).toEqual([]);
    const staleAcquirers = ADAPTER_ACQUISITION_ALLOWLIST.map((entry) => entry.file).filter(
      (file) => !FILES.some((f) => f.rel === file),
    );
    expect(staleAcquirers).toEqual([]);
  });

  it("every orchestration call site sits in an impl that injects the capability", () => {
    const injectors = new Map<string, Set<string>>();
    for (const file of FILES) {
      const fns = new Set<string>();
      eachNode(file.ast, (node) => {
        if (ts.isCallExpression(node) && calleeName(node) === INJECTION_SITE_FN) {
          fns.add(enclosingFunctionName(node));
        }
      });
      injectors.set(file.rel, fns);
    }
    const missing = ADAPTER_CALL_ALLOWLIST.filter(
      (entry) => entry.injects && !injectors.get(entry.file)?.has(entry.fn),
    ).map((entry) => `${entry.file} :: ${entry.fn}()`);
    expect(
      missing,
      "An entry point still calls its adapter but no longer calls " +
        `${INJECTION_SITE_FN}(). The call is allowlisted, so nothing else in ` +
        "this gate would notice — that is precisely the AC8 regression.",
    ).toEqual([]);
    // All four are accounted for, and they are the four the epic names.
    expect(
      ADAPTER_CALL_ALLOWLIST.filter((entry) => entry.injects)
        .map((entry) => entry.fn)
        .sort(),
    ).toEqual(
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
