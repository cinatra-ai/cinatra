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
 *   1. The chip's spec anchors (`suggestion-chip-rest|accepted|dismissed`) are
 *      emitted by exactly ONE production module — the one card.
 *   2. That module is the one the review PAGE, the run CARD and the chat thread
 *      all mount, so "both hosts" is a property of the import graph rather than a
 *      convention.
 *   3. The page's route-bound action FORWARDS the partition into the one decision
 *      helper. A page that quietly dropped it would still render chips and still
 *      pass every rendering test, while recording nothing.
 *   4. There is no per-item decision entry anywhere: nothing but the two review
 *      decision entries accepts `suggestionDecisions` off the wire (#2047 row 8).
 *
 * WHAT THIS CANNOT PROVE: a text scan is defeated by an anchor assembled at
 * runtime. It closes the reachable, nameable ways to draw a second chip.
 *
 * Run: pnpm exec vitest run src/lib/lifecycle/__tests__/suggestion-chips-one-renderer.test.ts
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
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
    expect(filesMatching(/suggestion-chip-(rest|accepted|dismissed)/)).toEqual([CARD]);
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
    expect(page).toMatch(/input\.suggestionDecisions \?\? null/);
  });

  it("nothing but the two review decision entries accepts a partition off the wire", () => {
    // The gate-scoped card entry and the page's own action. A third acceptor
    // would be the per-item approval pathway #2047 row 8 bans.
    expect(filesMatching(/suggestionDecisions:\s*z\s*\n?\s*\./)).toEqual([
      "src/app/api/lifecycle-views/decide/route.ts",
    ]);
  });

  it("no route is named for per-item suggestion decisions", () => {
    const routes = FILES.map(relPath).filter(
      (f) => f.startsWith("src/app/api/") && f.endsWith("/route.ts"),
    );
    expect(routes.filter((f) => /suggestion/i.test(f))).toEqual([]);
  });
});
