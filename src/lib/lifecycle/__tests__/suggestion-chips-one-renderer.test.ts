/**
 * cinatra#2572 (epic #2564 S6c) — the STRUCTURAL half of "page + card, ONE
 * component".
 *
 * The behavioural half is `packages/agents/src/__tests__/review-gate-card.test.tsx`:
 * it renders the chips on all three first-party hosts and pins what they do. But
 * a behavioural test can only prove that the component it imports behaves; it
 * cannot prove that no SECOND drawing of a suggestion chip exists somewhere else,
 * which is exactly the failure S2's one-renderer doctrine (#2624) exists to
 * prevent and exactly the failure this epic inherited (a redirect card, a panel
 * chip-row mount and a page composition, all drawing the same interaction).
 *
 * So the assertions here are about the repository:
 *
 *   1. The suggestion's spec anchors (`suggestion-accepted|dismissed`, plus the
 *      history-only `suggestion-unrecorded`) are emitted by exactly ONE
 *      production module — the one card.
 *   2. That module is the one the review PAGE, the run CARD and the chat thread
 *      all mount, so "both hosts" is a property of the import graph rather than a
 *      convention.
 *   3. The page's route-bound action FORWARDS the partition into the one decision
 *      helper. A page that quietly dropped it would still render chips and still
 *      pass every rendering test, while recording nothing.
 *   4. There is no per-item decision entry anywhere: nothing but the two review
 *      decision entries accepts `suggestionDecisions` off the wire (#2047 row 8).
 *      Since cinatra#3080 both take it through ONE submission validator, so no
 *      module but those two entries may reach that validator (its module or any
 *      name it exports), read over the WHOLE tree.
 *
 * WHAT THIS CANNOT PROVE: a text scan is defeated by an anchor assembled at
 * runtime. It closes the reachable, nameable ways to draw a second chip.
 *
 * Run: pnpm exec vitest run src/lib/lifecycle/__tests__/suggestion-chips-one-renderer.test.ts
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";

const REPO_ROOT = process.cwd();

const SEARCH_ROOTS = ["src", "packages"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "__tests__",
  "tests",
  "coverage",
  "__generated__",
]);
const CODE_EXT = /\.(ts|tsx|mjs|mts|js|jsx)$/;

function walkProductionFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walkProductionFiles(full, out);
      continue;
    }
    if (!CODE_EXT.test(entry)) continue;
    if (entry.includes(".test.")) continue;
    out.push(full);
  }
  return out;
}

const FILES = SEARCH_ROOTS.flatMap((root) => walkProductionFiles(join(REPO_ROOT, root)));

function relPath(file: string): string {
  return relative(REPO_ROOT, file).replaceAll("\\", "/");
}

function filesMatching(pattern: RegExp): string[] {
  return FILES.filter((f) => pattern.test(readFileSync(f, "utf8"))).map(relPath).sort();
}

const CARD = "packages/agents/src/review-gate-card.tsx";

describe("ONE component draws the suggestion chip", () => {
  it("only the card emits the spec's chip anchors", () => {
    expect(filesMatching(/"suggestion-(accepted|dismissed|unrecorded)"/)).toEqual([CARD]);
  });

  it("only the card defines a chip-row component", () => {
    expect(filesMatching(/function SuggestionChips\(/)).toEqual([CARD]);
  });

  it("the card is what the review PAGE and the run panel both mount", () => {
    const page = readFileSync(
      join(
        REPO_ROOT,
        "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
      ),
      "utf8",
    );
    const panel = readFileSync(
      join(REPO_ROOT, "packages/agents/src/agentic-run-panel.tsx"),
      "utf8",
    );
    // The page reaches it across the package boundary, the panel reaches it
    // in-package — one module either way, which is the whole property.
    expect(page).toMatch(/from "@cinatra-ai\/agents\/review-gate-card"/);
    expect(panel).toMatch(/from "\.\/review-gate-card"/);
    for (const source of [page, panel]) expect(source).toMatch(/<ReviewGateCard/);
  });
});

/** The ONE input validator both review decision entries parse (cinatra#3080). */
const FLOOR_SUBMISSION_INPUT =
  "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/floor-submission-input.ts";
/** Its module name, as every import, re-export or dynamic import spells it. */
const FLOOR_SUBMISSION_MODULE = "floor-submission-input";
/** The two review decision entries: the ONLY modules that may reach the validator. */
const REVIEW_DECISION_ENTRIES = [
  "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
  "src/app/api/lifecycle-views/decide/route.ts",
].sort();
/** A test file: the only thing the reach scan leaves out (a test is no entry). */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Every code file under the scanned roots, `__tests__`, `tests` and
 * `__generated__` included (FILES skips those folders, so a module placed there
 * would be invisible to it). Only dependencies and the Next.js build output are
 * left out.
 */
function walkAllCodeFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walkAllCodeFiles(full, out);
      continue;
    }
    if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/** The names the validator exports, read from its own source. */
function validatorExports(source: string): string[] {
  const declared =
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
  const names = [...source.matchAll(declared)].map((m) => m[1]);
  for (const m of source.matchAll(/^export\s*(?:type\s*)?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.push(name);
    }
  }
  return [...new Set(names)].sort();
}

/**
 * Every non-test module that reaches the validator: it names the validator's
 * module or ANY name the validator exports. Fail closed: a mention is enough.
 */
function reachOfValidator(files: { path: string; source: string }[], names: string[]): string[] {
  return files
    .filter((f) => f.path !== FLOOR_SUBMISSION_INPUT && !TEST_FILE.test(f.path))
    .filter((f) => f.source.includes(FLOOR_SUBMISSION_MODULE) || names.some((n) => f.source.includes(n)))
    .map((f) => f.path)
    .sort();
}

// ---- WHO MAY IMPORT A REVIEW DECISION ENTRY (pre-review 2 of #4571) ---------

/**
 * The ONLY module that may import a review decision entry: the scoped run
 * routes mount the review PAGE's component under the scoped run addresses
 * (cinatra#3693). Nothing imports the decide route. A module that imports an
 * entry could take the partition through it without naming the validator at
 * all, for example a new route whose `POST` only calls the decide route's `POST`.
 */
const ENTRY_IMPORTERS = ["src/app/scoped-launch-routes.tsx"];
/**
 * A relative or `@/` module path in a string literal: an import, a re-export, a
 * dynamic import, a `require`, or a plain string handed to one. Fail closed: a
 * string is enough. One alternation and one character class, no nested
 * quantifier (the polynomial-backtracking shape this file avoids).
 */
const MODULE_PATH_LITERAL = /["'`]((?:\.{1,2}|@)\/[^"'`\n]*)["'`]/g;
const MODULE_PATH_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** A module path without its extension, and a folder's `index` as the folder. */
function moduleKey(path: string): string {
  const bare = path.replace(MODULE_PATH_EXT, "");
  return bare.endsWith("/index") ? bare.slice(0, -"/index".length) : bare;
}

/**
 * The repository path a relative or `@/` specifier names (`@/` is `src/`),
 * normalized as the resolver reads it: `.` and `..` segments folded and a
 * trailing slash dropped, so `@/app/./x` is `src/app/x` (pre-review 2 of the
 * forward of #4571).
 */
function specifierPath(path: string, specifier: string): string {
  const joined = specifier.startsWith("@/") ? `src/${specifier.slice(2)}` : posix.join(posix.dirname(path), specifier);
  return posix.normalize(joined).replace(/\/+$/, "");
}

/** The repository modules a file names by a relative or `@/` path (`@/` is `src/`). */
function namedModules(path: string, source: string): string[] {
  return [...source.matchAll(MODULE_PATH_LITERAL)].map((m) => moduleKey(specifierPath(path, m[1])));
}

/**
 * Whether a file names a TEST file by a relative or `@/` module path: the one
 * exclusion of the chain scan (a test file is no module of the graph) stays
 * closed only if no non-test file names one. A string is enough, whatever
 * stands between a keyword and the quote (a bundler comment in a dynamic
 * import, for example: review 3 of the forward of #4571).
 */
function namesATestFile(path: string, source: string): boolean {
  return [...source.matchAll(MODULE_PATH_LITERAL)].some((m) =>
    /\.(?:test|spec)(?:\.[cm]?[jt]sx?)?$/.test(specifierPath(path, m[1])),
  );
}

/** Every non-test module that names one of `entries` by its module path. */
function entryImporters(files: { path: string; source: string }[], entries: string[]): string[] {
  const keys = new Set(entries.map(moduleKey));
  return files
    .filter((f) => !TEST_FILE.test(f.path))
    .filter((f) => namedModules(f.path, f.source).some((k) => keys.has(k)))
    .map((f) => f.path)
    .sort();
}

/**
 * Every import edge, written as a relative or `@/` module path in a string
 * literal, that reaches a review decision entry over any number of hops:
 * `A -> B` where A is a non-test file and B is an entry FILE or a file that
 * itself reaches one. The importer pin above reads one hop only, so a new page
 * that imports the allowed scoped run routes would mount the review page
 * through them unseen (pre-review 1 of #4571's forward). Modules are files:
 * `x.tsx` and `x/index.ts` are two (pre-review 2). The allowed chains are
 * pinned exactly: the scoped run pages -> the scoped run routes -> the review
 * page. Nothing reaches the decide route. A bare package specifier and a path
 * assembled at runtime are out of this scan's scope.
 */
const ENTRY_CHAINS = [
  "src/app/organizations/[id]/agents/[...launch]/page.tsx -> src/app/scoped-launch-routes.tsx",
  "src/app/organizations/[id]/assistants/[...launch]/page.tsx -> src/app/scoped-launch-routes.tsx",
  "src/app/personal/agents/[...launch]/page.tsx -> src/app/scoped-launch-routes.tsx",
  "src/app/personal/assistants/[...launch]/page.tsx -> src/app/scoped-launch-routes.tsx",
  "src/app/projects/[projectId]/agents/[...launch]/page.tsx -> src/app/scoped-launch-routes.tsx",
  "src/app/projects/[projectId]/assistants/[...launch]/page.tsx -> src/app/scoped-launch-routes.tsx",
  "src/app/scoped-launch-routes.tsx -> src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
  "src/app/teams/[teamId]/agents/[...launch]/page.tsx -> src/app/scoped-launch-routes.tsx",
  "src/app/teams/[teamId]/assistants/[...launch]/page.tsx -> src/app/scoped-launch-routes.tsx",
  "src/app/workspace/agents/[...launch]/page.tsx -> src/app/scoped-launch-routes.tsx",
  "src/app/workspace/assistants/[...launch]/page.tsx -> src/app/scoped-launch-routes.tsx",
];

/**
 * The FILES a file names by a relative or `@/` path: every known file the
 * specifier can resolve to (`x`, `x.ts`, `x.tsx`, `x.js`, `x/index.ts`, ...).
 * Fail closed: when two files can answer one specifier, both are named.
 */
function namedFiles(path: string, source: string, byKey: Map<string, string[]>): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(MODULE_PATH_LITERAL)) {
    for (const file of byKey.get(moduleKey(specifierPath(path, m[1]))) ?? []) out.add(file);
  }
  return [...out].sort();
}

/** The edges of the import graph, between FILES, that reach one of `entries`, transitively (fixpoint). */
function entryChains(files: { path: string; source: string }[], entries: string[]): string[] {
  const live = files.filter((f) => !TEST_FILE.test(f.path));
  const byKey = new Map<string, string[]>();
  for (const file of new Set([...files.map((f) => f.path), ...entries])) {
    const key = moduleKey(file);
    byKey.set(key, [...(byKey.get(key) ?? []), file]);
  }
  const reach = new Set(entries);
  const edges = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of live) {
      for (const file of namedFiles(f.path, f.source, byKey)) {
        // Only a file naming ITSELF is no edge; two distinct files always are.
        if (file === f.path || !reach.has(file)) continue;
        const edge = `${f.path} -> ${file}`;
        if (!edges.has(edge)) {
          edges.add(edge);
          grew = true;
        }
        if (!reach.has(f.path)) {
          reach.add(f.path);
          grew = true;
        }
      }
    }
  }
  return [...edges].sort();
}

describe("ONE decision path carries the marks", () => {
  it("the review page's route-bound action FORWARDS the partition", () => {
    const page = readFileSync(
      join(
        REPO_ROOT,
        "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
      ),
      "utf8",
    );
    // The action's input carries it…
    expect(page).toMatch(/suggestionDecisions\?: SuggestionDecisionPartition \| null/);
    // …and it reaches the ONE helper. A page that dropped it would render chips
    // and record nothing, and every rendering test would still pass.
    // AMENDED for cinatra#3080: the action parses its input with the ONE
    // submission validator and forwards the parsed partition through the
    // validator's own function, which keeps an absent partition absent.
    expect(page).toMatch(/reviewFloorSubmissionInputSchema\.safeParse\(input\)/);
    expect(page).toMatch(/partitionFromFloorSubmissionInput\(checked\.data\)/);
    const validator = readFileSync(join(REPO_ROOT, FLOOR_SUBMISSION_INPUT), "utf8");
    expect(validator).toMatch(/input\.suggestionDecisions \?\? null/);
  });

  it("nothing but the two review decision entries accepts a partition off the wire", () => {
    // The gate-scoped card entry and the page's own action. A third acceptor
    // would be the per-item approval pathway #2047 row 8 bans.
    // AMENDED for cinatra#3080: both entries now take the partition through the
    // ONE submission validator, so the validator is the one module that spells
    // the partition's wire shape; the decide route spreads its fields.
    expect(filesMatching(/suggestionDecisions:\s*z\s*\n?\s*\./)).toEqual([FLOOR_SUBMISSION_INPUT]);
    const route = readFileSync(join(REPO_ROOT, "src/app/api/lifecycle-views/decide/route.ts"), "utf8");
    expect(route).toMatch(/\.\.\.REVIEW_FLOOR_SUBMISSION_FIELDS,/);
    // A third entry that spreads the validator's fields and forwards its parsed
    // partition spells no `suggestionDecisions: z.` and would pass the pin above.
    // So the validator's REACH is pinned too: any non-test module, anywhere under
    // the scanned roots, that names its module or anything it exports.
    const all = SEARCH_ROOTS.flatMap((root) => walkAllCodeFiles(join(REPO_ROOT, root))).map((f) => ({
      path: relPath(f),
      source: readFileSync(f, "utf8"),
    }));
    expect(all.length).toBeGreaterThan(FILES.length);
    const names = validatorExports(readFileSync(join(REPO_ROOT, FLOOR_SUBMISSION_INPUT), "utf8"));
    for (const carrier of [
      "REVIEW_FLOOR_SUBMISSION_FIELDS",
      "reviewFloorSubmissionInputSchema",
      "partitionFromFloorSubmissionInput",
    ]) {
      expect(names).toContain(carrier);
    }
    expect(reachOfValidator(all, names)).toEqual(REVIEW_DECISION_ENTRIES);
    // The one exclusion stays closed: no non-test module imports a test file.
    const importsATest =
      /(?:\bfrom|\bimport|\brequire)\s*(?:\(\s*)?["'`][^"'`\n]*\.(?:test|spec)(?:\.[cm]?[jt]sx?)?["'`]/;
    expect(all.filter((f) => !TEST_FILE.test(f.path) && importsATest.test(f.source)).map((f) => f.path)).toEqual([]);
    // ... and by every module path in a string, not only right after a keyword.
    expect(all.filter((f) => !TEST_FILE.test(f.path) && namesATestFile(f.path, f.source)).map((f) => f.path)).toEqual([]);
  });

  it("a third entry that reuses the validator is caught by the reach scan (fixture)", () => {
    const names = validatorExports(readFileSync(join(REPO_ROOT, FLOOR_SUBMISSION_INPUT), "utf8"));
    const spec = `@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/${FLOOR_SUBMISSION_MODULE}`;
    const thirdEntry = {
      path: "src/app/api/review-floor/route.ts",
      source: [
        `import { REVIEW_FLOOR_SUBMISSION_FIELDS, partitionFromFloorSubmissionInput } from "${spec}";`,
        "const body = z.object({ ...REVIEW_FLOOR_SUBMISSION_FIELDS });",
        "export const forward = (raw: unknown) => partitionFromFloorSubmissionInput(body.parse(raw));",
      ].join("\n"),
    };
    const shim = {
      path: "src/lib/review/__tests__/floor-shim.ts",
      source: `export { partitionFromFloorSubmissionInput as fromFloor } from "${spec}";`,
    };
    const test = { path: "src/app/api/review-floor/route.test.ts", source: thirdEntry.source };
    expect(reachOfValidator([thirdEntry, shim, test], names)).toEqual([thirdEntry.path, shim.path].sort());
  });

  it("nothing imports a review decision entry but the scoped run routes, which mount the review page", () => {
    // The reach pin above reads who NAMES the validator. A module that imports
    // an entry names nothing of the validator's and can still take the partition
    // through it: a new route whose `POST` only calls the decide route's `POST`
    // (pre-review 2 of #4571). So the entries' importers are pinned too, over the
    // whole tree: only the scoped run routes, which mount the review page's
    // component (cinatra#3693); nothing imports the decide route.
    const all = SEARCH_ROOTS.flatMap((root) => walkAllCodeFiles(join(REPO_ROOT, root))).map((f) => ({
      path: relPath(f),
      source: readFileSync(f, "utf8"),
    }));
    expect(all.length).toBeGreaterThan(FILES.length);
    expect(entryImporters(all, REVIEW_DECISION_ENTRIES)).toEqual(ENTRY_IMPORTERS);
    expect(entryImporters(all, ["src/app/api/lifecycle-views/decide/route.ts"])).toEqual([]);
    // ... and over the whole import graph: a second hop is a reach too.
    expect(entryChains(all, REVIEW_DECISION_ENTRIES)).toEqual(ENTRY_CHAINS);
    expect(entryChains(all, ["src/app/api/lifecycle-views/decide/route.ts"])).toEqual([]);
  });

  it("a module that delegates to a review decision entry is caught by the importer scan (fixture)", () => {
    const decide = "src/app/api/lifecycle-views/decide/route.ts";
    // The pre-review 2 input: an allowed route export that only delegates.
    const delegate = {
      path: "src/app/api/review-floor/route.ts",
      source: [
        'import { POST as decide } from "../lifecycle-views/decide/route";',
        "export async function POST(request: Request): Promise<Response> {",
        "  return decide(request);",
        "}",
      ].join("\n"),
    };
    // The same through the `@/` alias, with an extension, from a folder index.
    const aliased = {
      path: "src/lib/review/floor/index.ts",
      source: 'export { POST as forward } from "@/app/api/lifecycle-views/decide/route.ts";',
    };
    // A helper beside the route, by a sibling path and a dynamic import.
    const sibling = {
      path: "src/app/api/lifecycle-views/decide/again.ts",
      source: 'export const again = async () => (await import("./route")).POST;',
    };
    // A second mount of the review page, under __tests__, spelled as a plain string.
    const mount = {
      path: "src/app/__tests__/extra-mount.tsx",
      source: 'const PAGE = "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page";',
    };
    // A near miss names another module, and a test file is no entry: both left out.
    const nearMiss = {
      path: "src/lib/review/router.ts",
      source: 'import { x } from "@/app/api/lifecycle-views/decide/router";',
    };
    const test = { path: "src/app/api/review-floor/route.test.ts", source: delegate.source };
    expect(entryImporters([delegate, aliased, sibling, mount, nearMiss, test], REVIEW_DECISION_ENTRIES)).toEqual(
      [delegate.path, aliased.path, sibling.path, mount.path].sort(),
    );
    expect(entryImporters([delegate, nearMiss, test], [decide])).toEqual([delegate.path]);
    // A second hop (pre-review 1 of the forward): a new page that imports the
    // allowed scoped run routes mounts the review page through them. One hop
    // misses it; the chain scan names both edges.
    const routes = {
      path: "src/app/scoped-launch-routes.tsx",
      source: 'import ReviewPage from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page";',
    };
    const duplicate = {
      path: "src/app/duplicate/agents/[...launch]/page.tsx",
      source: [
        'import { ScopedAgentsRoute } from "@/app/scoped-launch-routes";',
        "export default async function DuplicateAgents({",
        "  params,",
        "}: {",
        "  params: Promise<{ launch?: string[] }>;",
        "}) {",
        "  const { launch } = await params;",
        "  return ScopedAgentsRoute({",
        '    scope: { kind: "workspace" },',
        "    segments: launch,",
        "  });",
        "}",
      ].join("\n"),
    };
    const viaTest = { path: "src/app/duplicate/page.test.tsx", source: duplicate.source };
    expect(entryImporters([routes, duplicate], REVIEW_DECISION_ENTRIES)).toEqual([routes.path]);
    expect(entryChains([routes, duplicate, viaTest, nearMiss], REVIEW_DECISION_ENTRIES)).toEqual(
      [`${duplicate.path} -> ${routes.path}`, `${routes.path} -> src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx`].sort(),
    );
    expect(entryChains([routes, duplicate, delegate], [decide])).toEqual([`${delegate.path} -> ${decide}`]);
    // The resolver's equivalents (pre-review 2 of the forward). A `.` segment in
    // an `@/` path names the same routes file, so the page is named.
    const dotted = {
      path: "src/app/dotted/agents/[...launch]/page.tsx",
      source: duplicate.source.replace('"@/app/scoped-launch-routes"', '"@/app/./scoped-launch-routes"'),
    };
    expect(dotted.source).toContain('from "@/app/./scoped-launch-routes";');
    expect(entryChains([routes, dotted], REVIEW_DECISION_ENTRIES)).toEqual(
      [`${dotted.path} -> ${routes.path}`, `${routes.path} -> src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx`].sort(),
    );
    // A folder `index` beside the routes file is a second module, not the
    // routes themselves: its re-export of the routes file is an edge.
    const folderIndex = {
      path: "src/app/scoped-launch-routes/index.ts",
      source: 'export { ScopedAgentsRoute } from "../scoped-launch-routes.tsx";',
    };
    expect(entryChains([routes, folderIndex], REVIEW_DECISION_ENTRIES)).toEqual(
      [`${folderIndex.path} -> ${routes.path}`, `${routes.path} -> src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx`].sort(),
    );
    // A test-named shim (review 3 of the forward): the chain scan leaves test
    // files out, so a non-test page that names one mounts what the shim
    // re-exports unseen. Naming a test file by a module path is refused on its
    // own, also behind a bundler comment in a dynamic import.
    const shim = {
      path: "src/app/shadow/agents/[...launch]/review-shim.test.tsx",
      source: 'export { default } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page";',
    };
    const shadow = {
      path: "src/app/shadow/agents/[...launch]/page.tsx",
      source: [
        "export default async function Shadow(props: any) {",
        '  const Review = (await import(/* webpackMode: "eager" */ "./review-shim.test")).default;',
        "  return Review(props);",
        "}",
      ].join("\n"),
    };
    expect(entryChains([routes, shim, shadow], REVIEW_DECISION_ENTRIES)).toEqual([`${routes.path} -> src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx`]);
    expect(namesATestFile(shadow.path, shadow.source)).toBe(true);
    expect(namesATestFile(shadow.path, 'const x = import(/* c */ "@/lib/review/floor.spec.ts");')).toBe(true);
    expect([routes, dotted, folderIndex, nearMiss, delegate].some((f) => namesATestFile(f.path, f.source))).toBe(false);
  });

  it("no route is named for per-item suggestion decisions", () => {
    const routes = FILES.map(relPath).filter(
      (f) => f.startsWith("src/app/api/") && f.endsWith("/route.ts"),
    );
    expect(routes.filter((f) => /suggestion/i.test(f))).toEqual([]);
  });
});
