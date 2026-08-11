// AC-3 (cinatra#2574, epic #2564 S8a) — THE DEGRADED CONTEXT IS BARRED FROM THE
// LIFECYCLE READ PATHS.
//
// The chat route's widget actor hardcodes `member` and carries no team or
// project grants. That is right for a chat turn and wrong for a lifecycle read,
// and the failure mode if someone reuses it is invisible: rows the reader is
// entitled to simply do not appear, and nothing errors. A comment cannot prevent
// that. This test can, so it is written to fail in both directions:
//
//   • the bar itself — no lifecycle read path may name the degraded context or
//     re-create its shape (a hardcoded role literal, an empty grant axis);
//   • the bar's PREMISE — the marker must still exist at exactly one production
//     site, so deleting or renaming the degraded context cannot quietly turn
//     this suite into a test that asserts nothing.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** The marker carried by the ONE degraded widget runtime actor. */
const DEGRADED_MARKER = "DEGRADED_WIDGET_RUNTIME_ACTOR";
const DEGRADED_IDENTIFIER = "degradedWidgetRuntimeActorContext";

/**
 * The lifecycle READ paths: the lifecycle library and the lifecycle view
 * endpoints. Any module that resolves, authorizes or renders lifecycle state
 * lands in one of these two trees, which is why the bar is drawn around them
 * rather than around a hand-listed file set that a new module would escape.
 */
const LIFECYCLE_READ_ROOTS = ["src/lib/lifecycle", "src/app/api/lifecycle-views"];

function walk(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  const out: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__") continue; // the bar governs production code
        visit(full);
        continue;
      }
      if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  visit(abs);
  return out;
}

/** Strip comments so prose about the ban never satisfies (or trips) the bar. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const LIFECYCLE_FILES = LIFECYCLE_READ_ROOTS.flatMap(walk);

describe("the bar", () => {
  it("covers a non-trivial set of lifecycle modules", () => {
    // If the roots ever stop resolving, an empty file list would make every
    // assertion below vacuously true.
    expect(LIFECYCLE_FILES.length).toBeGreaterThan(10);
  });

  it("no lifecycle read path names the degraded widget runtime actor", () => {
    const offenders = LIFECYCLE_FILES.filter((file) => {
      const source = readFileSync(file, "utf8");
      return (
        source.includes(DEGRADED_MARKER) || code(source).includes(DEGRADED_IDENTIFIER)
      );
    });
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it("no lifecycle read path re-creates the degraded shape by hand", () => {
    // The shape, not the name: a hardcoded platform/org role literal, or an
    // empty team/project axis passed off as a resolved one. The deliberate floor
    // in the widget lifecycle actor goes through a NAMED constant, so it does
    // not match — and could not be introduced elsewhere without matching.
    const banned = [
      /platformRole:\s*["']/,
      /orgRole:\s*["']/,
      /teamIds:\s*\[\s*\]/,
      /projectGrants:\s*\[\s*\]/,
      /projectIds:\s*\[\s*\]/,
    ];
    const offenders: string[] = [];
    for (const file of LIFECYCLE_FILES) {
      const source = code(readFileSync(file, "utf8"));
      for (const re of banned) {
        if (re.test(source)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} :: ${re}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the widget lifecycle actor is the ONLY door — one module consumes the cwu_ token", () => {
    const consumers = LIFECYCLE_FILES.filter((file) =>
      code(readFileSync(file, "utf8")).includes("consumeUserWidgetToken"),
    ).map((f) => path.relative(REPO_ROOT, f));
    expect(consumers).toEqual(["src/lib/lifecycle/widget-lifecycle-actor.ts"]);
  });
});

describe("the bar's premise", () => {
  const CHAT_ROUTE = path.join(REPO_ROOT, "src/app/api/assistants/chat/route.ts");

  it("the degraded context still exists, marked, at exactly one production site", () => {
    const source = readFileSync(CHAT_ROUTE, "utf8");
    expect(source).toContain(DEGRADED_MARKER);
    expect(code(source)).toContain(`const ${DEGRADED_IDENTIFIER}`);
  });

  it("it is still the degraded shape it is barred for", () => {
    // The bar is only worth having while the thing it bars is genuinely lossy.
    const source = code(readFileSync(CHAT_ROUTE, "utf8"));
    const block = source.slice(source.indexOf(`const ${DEGRADED_IDENTIFIER}`));
    expect(block).toMatch(/platformRole:\s*"member"/);
    expect(block).toMatch(/teamIds:\s*\[\s*\]/);
    expect(block).toMatch(/projectGrants:\s*\[\s*\]/);
  });

  it("no OTHER production module carries the marker", () => {
    const roots = ["src/app", "src/lib", "src/components"];
    const carriers: string[] = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        if (readFileSync(file, "utf8").includes(DEGRADED_MARKER)) {
          carriers.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    expect(carriers).toEqual(["src/app/api/assistants/chat/route.ts"]);
  });
});
