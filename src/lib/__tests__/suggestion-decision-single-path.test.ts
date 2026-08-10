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
 *      to this list with a reviewer looking, not a quiet addition.
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
import { join, relative } from "node:path";

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
      // The gate-scoped decision entry: bounds the SHAPE and forwards.
      "src/app/api/lifecycle-views/decide/route.ts",
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
