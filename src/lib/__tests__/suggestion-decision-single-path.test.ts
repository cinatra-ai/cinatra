/**
 * cinatra#2571 (epic #2564 S6b) — "structurally no independent per-item server
 * action exists" (#2047 row 8), the REPOSITORY half.
 *
 * The behavioural half lives in the decision core's own suite (a partition is
 * refused on a non-terminal decision, refused when it names an unsurfaced id, and
 * changes the fingerprint so a competing submit conflicts). None of that helps if
 * a later lane adds `acceptSuggestionAction()` beside it: accepting a suggestion
 * would then be a second thing a reviewer can do to a gate, with no CAS, no
 * fingerprint and no audit — precisely the parallel approval path the epic bans.
 *
 * So the assertions here are about the repository, not about a call:
 *
 *   1. No `"use server"` module names the suggestion-decision tables, their
 *      Drizzle symbols, or the store functions that mutate them. A Server Action
 *      is the ONE thing a browser can invoke directly by name, so this is the
 *      shape a per-item accept endpoint would have to take.
 *   2. The set of production modules that accept a client-supplied partition at
 *      all is a PINNED inventory. Adding an entry point is then a deliberate edit
 *      to this list with a reviewer looking, not a quiet addition. Since
 *      cinatra#3080 the partition's wire shape lives in ONE submission
 *      validator; the modules that reach that validator (its module or any
 *      name it exports) are a second pinned set, read over the WHOLE tree, so
 *      a new entry that reuses the validator cannot hide behind it.
 *   3. The ledger's per-item write happens in exactly ONE module, and it is the
 *      one that owns the gate CAS — so a decision row cannot exist without the
 *      decision that authorized it.
 *
 * WHAT THIS CANNOT PROVE, stated plainly: it is a text scan, so a table name or
 * an import specifier assembled at runtime defeats it, exactly as the sibling
 * S6a retirement scan documents. It is paired with the executable guard
 * (`scripts/audit/review-decision-writer-*-gate.mjs`, whose protected set this
 * slice extends) which fails CI on a DML write from any un-allowlisted module.
 *
 * Run: pnpm exec vitest run src/lib/__tests__/suggestion-decision-single-path.test.ts
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

/** Every name that could reach the suggestion-decision record. */
const DECISION_RECORD_NAMES = [
  "suggestion_decision_ledger",
  "suggestionDecisionLedger",
  "suggestion_application_outbox",
  "suggestionApplicationOutbox",
  "markSuggestionApplied",
  "markApplicationIntentDone",
  "claimPendingApplicationIntents",
  "deadLetterExhaustedApplicationIntents",
];

function walk(dir: string, out: string[] = []): string[] {
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
      walk(full, out);
      continue;
    }
    if (!CODE_EXT.test(entry)) continue;
    if (entry.includes(".test.")) continue;
    out.push(full);
  }
  return out;
}

function productionFiles(): { path: string; source: string }[] {
  const files: { path: string; source: string }[] = [];
  for (const root of SEARCH_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const full of walk(abs)) {
      files.push({
        path: relative(REPO_ROOT, full).replaceAll("\\", "/"),
        source: readFileSync(full, "utf8"),
      });
    }
  }
  return files;
}

/**
 * A module whose FIRST statement is the `use server` directive.
 *
 * Hand-scanned rather than matched with a regex: the natural pattern for "any
 * run of leading whitespace and comments, then the directive" nests a quantifier
 * inside a quantifier, which is a polynomial-backtracking (ReDoS) shape — CodeQL
 * flags it, and correctly, even over trusted repository sources. This loop is
 * linear and has no backtracking at all.
 */
function isServerActionModule(source: string): boolean {
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      const nl = source.indexOf("\n", i);
      if (nl === -1) return false;
      i = nl + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return false;
      i = end + 2;
      continue;
    }
    // The first thing that is neither whitespace nor a comment decides it.
    return source.startsWith('"use server"', i) || source.startsWith("'use server'", i);
  }
  return false;
}

// ---- THE ONE SUBMISSION VALIDATOR and who may reach it (cinatra#3080) ------

/** The ONE input validator both server entries parse. */
const FLOOR_SUBMISSION_INPUT =
  "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/floor-submission-input.ts";
/** Its module name, as every import, re-export or dynamic import spells it. */
const FLOOR_SUBMISSION_MODULE = "floor-submission-input";
/** The ONLY modules that may reach it: the two server entries. */
const FLOOR_SUBMISSION_ENTRIES = [
  "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
  "src/app/api/lifecycle-views/decide/route.ts",
].sort();
/** The carriers the validator must still export (guards against a vacuous scan). */
const FLOOR_SUBMISSION_CARRIERS = [
  "REVIEW_FLOOR_SUBMISSION_FIELDS",
  "reviewFloorSubmissionInputSchema",
  "partitionFromFloorSubmissionInput",
];
const ANY_CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** A test file. The only thing the reach scan leaves out: a test is no server entry. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
/** A non-test module that imports a test file would reopen that one exclusion. */
const IMPORTS_A_TEST_FILE =
  /(?:\bfrom|\bimport|\brequire)\s*(?:\(\s*)?["'`][^"'`\n]*\.(?:test|spec)(?:\.[cm]?[jt]sx?)?["'`]/;

/**
 * EVERY code file under the scanned roots: `__tests__`, `tests`, fixtures and
 * `__generated__` included, only dependencies and the Next.js build output left
 * out. The pinned set above skips those folders, so a module placed there would
 * be invisible to it; the validator's reach is read over the whole tree instead.
 */
function allCodeFiles(): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
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
        visit(full);
        continue;
      }
      if (!ANY_CODE_EXT.test(entry)) continue;
      out.push({ path: relative(REPO_ROOT, full).replaceAll("\\", "/"), source: readFileSync(full, "utf8") });
    }
  };
  for (const root of SEARCH_ROOTS) visit(join(REPO_ROOT, root));
  return out;
}

/** The names a module exports, read from its own source. */
function exportedNames(source: string): string[] {
  const names = new Set<string>();
  const declared =
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of source.matchAll(declared)) names.add(m[1]);
  for (const m of source.matchAll(/^export\s*(?:type\s*)?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Every non-test module that reaches the validator: it names the validator's
 * module (an import, a re-export, a dynamic import) or ANY name the validator
 * exports. Fail closed: a mention is enough, and only test files are left out.
 */
function validatorReach(all: { path: string; source: string }[], names: string[]): string[] {
  return all
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

describe("the suggestion decision has exactly ONE path", () => {
  const files = productionFiles();

  it("scans a real slice of the repository (guards against a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(500);
    // And the scan actually sees the modules this test reasons about.
    const paths = files.map((f) => f.path);
    expect(paths).toContain("packages/agents/src/suggestion-decision-store.ts");
    expect(paths).toContain("src/lib/artifacts/artifact-review-decision.ts");
  });

  it("finds `use server` modules at all (the directive matcher is not blind)", () => {
    const serverActions = files.filter((f) => isServerActionModule(f.source));
    expect(serverActions.length).toBeGreaterThan(5);
  });

  it("NO Server Action module names the suggestion-decision record", () => {
    const offenders = files
      .filter((f) => isServerActionModule(f.source))
      .filter((f) => DECISION_RECORD_NAMES.some((name) => f.source.includes(name)))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("the modules that accept a client-supplied partition are a PINNED set", () => {
    const carriers = files
      .filter((f) => f.source.includes("suggestionDecisions"))
      .map((f) => f.path)
      .sort();
    expect(carriers).toEqual([
      // ---- THE TWO SERVER ENTRIES, and the one core behind both -------------
      // AMENDED for cinatra#3080: the gate-scoped decide route no longer spells
      // the partition's shape itself. It spreads the ONE submission validator
      // below into its body (pinned by the test after this one), so the route
      // leaves this set and the validator joins it. Still exactly one place
      // bounds the SHAPE, and both entries parse it.
      "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/floor-submission-input.ts",
      // The review PAGE's route-bound action (cinatra#2572, epic #2564 S6c).
      // The SECOND entry, and the one S6b already described: it closes over the
      // route's own gate and forwards into the helper below. It is not a second
      // PATH — it re-implements no validation, and the partition it forwards is
      // normalized, membership-checked and fingerprinted by the same core.
      "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx",
      // The ONE decision helper both entries call.
      "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/actions.ts",
      // The pure core that normalizes it, validates it and folds it into the
      // fingerprint. The partition contract is co-located there on purpose.
      "src/lib/artifacts/artifact-review-decision.ts",
      // ---- THE CLIENT PRODUCERS (cinatra#2572) ------------------------------
      // These accept nothing off the wire: they BUILD a partition out of the
      // reader's local marks and hand it to the one submit the floor already
      // owns (§VIII "the chips carry no submit of their own"). They are pinned
      // for the same reason the entries are — a third one would mean a second
      // place that decides what a mark means.
      "packages/agents/src/review-decision-bar.tsx",
      "packages/agents/src/review-gate-card.tsx",
    ].sort());
  });

  it("both server entries take the partition through the ONE submission validator", () => {
    // AMENDED for cinatra#3080: the pin above no longer lists the decide route,
    // because the route names the validator's fields rather than the partition.
    // This keeps the route in view: it spreads the validator's fields into its
    // body and hands the parsed partition on through the validator's own
    // function, and the page's action parses the same validator first.
    const byPath = new Map(files.map((f) => [f.path, f.source]));
    const route = byPath.get("src/app/api/lifecycle-views/decide/route.ts") ?? "";
    const page =
      byPath.get("src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx") ?? "";
    expect(route).toMatch(/\.\.\.REVIEW_FLOOR_SUBMISSION_FIELDS,/);
    expect(route).toMatch(/partitionFromFloorSubmissionInput\(parsed\.data\)/);
    expect(page).toMatch(/reviewFloorSubmissionInputSchema\.safeParse\(input\)/);
    expect(page).toMatch(/partitionFromFloorSubmissionInput\(checked\.data\)/);
  });

  it("nothing but the two server entries reaches the ONE submission validator", () => {
    // The pinned set above names the modules that SPELL `suggestionDecisions`.
    // A third entry that spreads the validator's fields and forwards its parsed
    // partition spells nothing of the kind, so it would pass that pin. This pin
    // is on the validator's reach instead: any module, anywhere under the
    // scanned roots, that names the validator's module or anything it exports.
    const all = allCodeFiles();
    expect(all.length).toBeGreaterThan(files.length);
    const validator = all.find((f) => f.path === FLOOR_SUBMISSION_INPUT);
    expect(validator).toBeDefined();
    const names = exportedNames(validator?.source ?? "");
    for (const carrier of FLOOR_SUBMISSION_CARRIERS) expect(names).toContain(carrier);
    expect(validatorReach(all, names)).toEqual(FLOOR_SUBMISSION_ENTRIES);
  });

  it("no non-test module imports a test file (the reach scan's one exclusion stays closed)", () => {
    const importers = allCodeFiles()
      .filter((f) => !TEST_FILE.test(f.path) && IMPORTS_A_TEST_FILE.test(f.source))
      .map((f) => f.path);
    expect(importers).toEqual([]);
    // ... and by every module path in a string, not only right after a keyword.
    expect(
      allCodeFiles()
        .filter((f) => !TEST_FILE.test(f.path) && namesATestFile(f.path, f.source))
        .map((f) => f.path),
    ).toEqual([]);
  });

  it("the reach scan refuses a third entry that reuses the validator (fixture)", () => {
    const validator = allCodeFiles().find((f) => f.path === FLOOR_SUBMISSION_INPUT);
    const names = exportedNames(validator?.source ?? "");
    const spec = `@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/${FLOOR_SUBMISSION_MODULE}`;
    // A new endpoint: spreads the fields, forwards the partition, never spells
    // `suggestionDecisions` and has no "suggestion" in its path.
    const thirdEntry = {
      path: "src/app/api/review-floor/route.ts",
      source: [
        'import { z } from "zod";',
        `import { REVIEW_FLOOR_SUBMISSION_FIELDS, partitionFromFloorSubmissionInput } from "${spec}";`,
        "const body = z.object({ ...REVIEW_FLOOR_SUBMISSION_FIELDS });",
        "export const forward = (raw: unknown) => partitionFromFloorSubmissionInput(body.parse(raw));",
      ].join("\n"),
    };
    // A re-export under another name, placed where the pinned set does not look.
    const shim = {
      path: "src/lib/review/__tests__/floor-shim.ts",
      source: `export { partitionFromFloorSubmissionInput as fromFloor } from "${spec}";`,
    };
    // A dynamic import that names only the module.
    const lazy = {
      path: "packages/agents/src/lazy-floor.ts",
      source: `export const load = () => import("${spec}");`,
    };
    // A test file is no server entry: left out.
    const test = { path: "src/app/api/review-floor/route.test.ts", source: thirdEntry.source };
    expect(validatorReach([thirdEntry, shim, lazy, test], names)).toEqual(
      [thirdEntry.path, shim.path, lazy.path].sort(),
    );
    // A non-test module importing a test file is caught by the guard above.
    expect(IMPORTS_A_TEST_FILE.test('import { forward } from "./route.test";')).toBe(true);
    expect(IMPORTS_A_TEST_FILE.test('const m = await import("../x.spec.ts");')).toBe(true);
    expect(IMPORTS_A_TEST_FILE.test('import { a } from "./latest";')).toBe(false);
  });

  it("nothing imports a server entry but the scoped run routes, which mount the review page", () => {
    // The reach pin above reads who NAMES the validator. A module that imports
    // a server entry names nothing of the validator's and can still take the
    // partition through it: a new route whose `POST` only calls the decide
    // route's `POST` (pre-review 2 of #4571). So the entries' importers are
    // pinned too, over the whole tree: only the scoped run routes, which mount
    // the review page's component (cinatra#3693); nothing imports the decide route.
    const all = allCodeFiles();
    expect(all.length).toBeGreaterThan(files.length);
    expect(entryImporters(all, FLOOR_SUBMISSION_ENTRIES)).toEqual(ENTRY_IMPORTERS);
    expect(entryImporters(all, ["src/app/api/lifecycle-views/decide/route.ts"])).toEqual([]);
    // ... and over the whole import graph: a second hop is a reach too.
    expect(entryChains(all, FLOOR_SUBMISSION_ENTRIES)).toEqual(ENTRY_CHAINS);
    expect(entryChains(all, ["src/app/api/lifecycle-views/decide/route.ts"])).toEqual([]);
  });

  it("the importer scan refuses a module that delegates to a server entry (fixture)", () => {
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
    expect(entryImporters([delegate, aliased, sibling, mount, nearMiss, test], FLOOR_SUBMISSION_ENTRIES)).toEqual(
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
    expect(entryImporters([routes, duplicate], FLOOR_SUBMISSION_ENTRIES)).toEqual([routes.path]);
    expect(entryChains([routes, duplicate, viaTest, nearMiss], FLOOR_SUBMISSION_ENTRIES)).toEqual(
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
    expect(entryChains([routes, dotted], FLOOR_SUBMISSION_ENTRIES)).toEqual(
      [`${dotted.path} -> ${routes.path}`, `${routes.path} -> src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx`].sort(),
    );
    // A folder `index` beside the routes file is a second module, not the
    // routes themselves: its re-export of the routes file is an edge.
    const folderIndex = {
      path: "src/app/scoped-launch-routes/index.ts",
      source: 'export { ScopedAgentsRoute } from "../scoped-launch-routes.tsx";',
    };
    expect(entryChains([routes, folderIndex], FLOOR_SUBMISSION_ENTRIES)).toEqual(
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
    expect(entryChains([routes, shim, shadow], FLOOR_SUBMISSION_ENTRIES)).toEqual([`${routes.path} -> src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx`]);
    expect(namesATestFile(shadow.path, shadow.source)).toBe(true);
    expect(namesATestFile(shadow.path, 'const x = import(/* c */ "@/lib/review/floor.spec.ts");')).toBe(true);
    expect([routes, dotted, folderIndex, nearMiss, delegate].some((f) => namesATestFile(f.path, f.source))).toBe(false);
  });

  it("the client producers reach exactly ONE endpoint — the gate-scoped entry", () => {
    // The pin above says which modules may carry a partition; this says where
    // they may send it. A per-item request would show up here as a second URL,
    // and that is the #2047 row-8 failure the whole shape exists to prevent.
    const producers = files.filter((f) =>
      ["packages/agents/src/review-decision-bar.tsx", "packages/agents/src/review-gate-card.tsx"].includes(
        f.path,
      ),
    );
    expect(producers).toHaveLength(2);
    const targets = producers
      .flatMap((f) => [...f.source.matchAll(/fetch\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
      .sort();
    expect(targets).toEqual(["LIFECYCLE_VIEW_DECIDE_PATH"]);
    // ...and neither of them names a suggestion store, a ledger or an outbox.
    for (const f of producers) {
      expect(f.source).not.toMatch(/suggestionDecisionLedger|suggestionApplicationOutbox/);
    }
  });

  it("the per-item ledger INSERT lives only in the module that owns the gate CAS", () => {
    const inserters = files
      .filter((f) => /\.insert\(\s*suggestionDecisionLedger/.test(f.source))
      .map((f) => f.path);
    expect(inserters).toEqual(["packages/agents/src/artifact-review-gate-store.ts"]);
  });

  it("the application-intent INSERT lives there too — an intent implies a decision", () => {
    const inserters = files
      .filter((f) => /\.insert\(\s*suggestionApplicationOutbox/.test(f.source))
      .map((f) => f.path);
    expect(inserters).toEqual(["packages/agents/src/artifact-review-gate-store.ts"]);
  });

  it("no module UPDATEs a recorded decision — the only ledger mutation is `applied_at`", () => {
    const updaters = files.filter((f) => /\.update\(\s*suggestionDecisionLedger/.test(f.source));
    expect(updaters.map((f) => f.path)).toEqual([
      "packages/agents/src/suggestion-decision-store.ts",
    ]);
    // ...and that one update sets exactly one column.
    const source = updaters[0].source;
    const sets = [...source.matchAll(/\.update\(\s*suggestionDecisionLedger\s*\)\s*\.set\(([^)]*)\)/g)];
    expect(sets).toHaveLength(1);
    expect(sets[0][1]).toContain("appliedAt");
    for (const forbidden of ["decision:", "decidedBy", "decisionFingerprint", "suggestionId"]) {
      expect(sets[0][1]).not.toContain(forbidden);
    }
  });
});
