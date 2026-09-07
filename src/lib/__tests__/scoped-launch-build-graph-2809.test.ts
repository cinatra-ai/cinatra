/**
 * cinatra#2809 — the BUILD-TIME cost of the ten scoped launch mounts.
 *
 * ## What broke
 *
 * The per-scope surfaces mount the agents and the assistants trees under five
 * scope bases, so the production build collects ten more route entries than it
 * did before. On the constrained hosted runner the smoke's `next build` died
 * three times in a row inside "Collecting page data", with the runner reclaimed
 * for unresponsiveness — while the same build passed on the base branch.
 *
 * The build measurement behind this file (base vs candidate, same host, same
 * env, `CINATRA_BUILD_CPUS=3` so the worker count matches the constrained
 * runner's) put the growth where the extra entries are, not in a per-worker
 * blow-up: during page-data collection the tree's peak went 5,473,744 KB ->
 * 5,790,096 KB (+5.8%) and the largest single worker 434,016 KB -> 468,544 KB
 * (+8.0%) for 228 -> 238 routes (+4.4%). So the honest lever is the SIZE OF WHAT
 * EACH NEW ENTRY MAKES THE COLLECTOR LOAD, and this file pins it.
 *
 * WHAT THOSE NUMBERS DO NOT CARRY. Sampling a phase that lasts seconds gives a
 * peak with a wide spread: two runs of the SAME base tree, same env, differed by
 * 19% on the build's overall peak and the phase peak moved by as much as 31%
 * between runs of one tree. The build-memory readings therefore establish the
 * DIRECTION (the growth sits with the added entries, not with a per-worker
 * blow-up) and nothing finer, and no claim of a memory saving rests on them.
 * The metric this file asserts is the deterministic one — a module count that
 * reads the same on every run.
 *
 * ## The metric
 *
 * `next build`'s page-data collection loads a route entry and evaluates its
 * EAGER module graph. A dynamic `import("x")` is a separate chunk fetched at
 * request time, so it is NOT evaluated then. `analyzeRoute(entry, { staticOnly:
 * true })` is exactly that graph — the reporter's own analyzer, following only
 * the edges a bundler resolves eagerly.
 *
 * The ceiling is `requireAuthSession`'s own graph plus a small margin: every
 * authenticated route in the repository already pays that, and a scoped launch
 * mount must add essentially nothing to it. Two request-time-only modules were
 * being paid for eagerly by all ten entries before this — the settings shell
 * (a client-component tree that only the `settings` route shape ever renders)
 * and the gated per-scope NAME READ (a `server-only` module that pulls the
 * Drizzle stores and the org/team/project read gates). Both now travel behind
 * the same `await import(...)` boundary the file already used for the plugins
 * registry and the chat mount.
 *
 * ## HONEST SCOPE
 *
 * This is a per-entry ceiling for the ten scoped mounts, nothing wider. It does
 * NOT measure the whole build, it does not pin the build's peak memory, and it
 * cannot see a growth that arrives through a shared chunk rather than through
 * these entries. It is the guard for the one thing this change is responsible
 * for: a scoped mount must not carry a request-time-only surface into the
 * build's page-data graph.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { analyzeRoute } from "../../../scripts/route-graph.mjs";
import { stripComments } from "../../../scripts/audit/lib/strip-comments.mjs";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");

/** The ten catch-all page entries the issue mounts, in route order. */
const SCOPED_ENTRIES = [
  "src/app/personal/agents/[...launch]/page.tsx",
  "src/app/personal/assistants/[...launch]/page.tsx",
  "src/app/workspace/agents/[...launch]/page.tsx",
  "src/app/workspace/assistants/[...launch]/page.tsx",
  "src/app/organizations/[id]/agents/[...launch]/page.tsx",
  "src/app/organizations/[id]/assistants/[...launch]/page.tsx",
  "src/app/teams/[teamId]/agents/[...launch]/page.tsx",
  "src/app/teams/[teamId]/assistants/[...launch]/page.tsx",
  "src/app/projects/[projectId]/agents/[...launch]/page.tsx",
  "src/app/projects/[projectId]/assistants/[...launch]/page.tsx",
];

/** The one shared shell all ten delegate through. */
const SHELL = "src/app/scoped-launch-routes.tsx";

/**
 * `requireAuthSession`'s own eager graph measures 151 modules today (it is what
 * /sign-in measures, the smallest authenticated route in the repository). A
 * scoped mount is a delegation, so it may add a handful of pure grammar modules
 * on top of that and no more. 150 sits between the pre-fix reading of 158 and the post-fix 142,
 * so a re-attached request-time surface trips this immediately.
 */
const BUILD_GRAPH_CEILING = 150;

/**
 * Request-time-only modules that must NOT be reachable eagerly from a scoped
 * entry. Both are rendered/called only after a request has been resolved.
 */
const DEFERRED_MODULES = [
  "@/components/scope-surface-settings-shell",
  "@/lib/scope-surface-entity-name",
];

function source(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/** Specifiers pulled EAGERLY: `import ... from "x"` and bare `import "x"`. */
function staticSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  const fromRe = /(?:\bimport|\bexport)\s+(?!type\s)[^;]*?\bfrom\s*["']([^"']+)["']/g;
  const bareRe = /\bimport\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(code)) !== null) specifiers.push(m[1]);
  while ((m = bareRe.exec(code)) !== null) specifiers.push(m[1]);
  return specifiers;
}

/** Specifiers behind a dynamic `import("x")` — a request-time chunk. */
function dynamicSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  const re = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) specifiers.push(m[1]);
  return specifiers;
}

describe("scoped launch mounts — the build's page-data graph (#2809)", () => {
  it("mounts all ten scoped launch entries the issue names", () => {
    // The positive anchor. Every ceiling below is vacuously satisfiable by
    // deleting a route, and the acceptance requires all ten to stay mounted.
    for (const entry of SCOPED_ENTRIES) {
      expect(() => source(entry), `${entry} must exist`).not.toThrow();
    }
    expect(new Set(SCOPED_ENTRIES).size).toBe(10);
  });

  it.each(SCOPED_ENTRIES)(
    "%s is collected with a build graph at or under the ceiling",
    (entry) => {
      const graph = analyzeRoute(entry, { staticOnly: true });
      expect(graph.ok, `analyzeRoute could not resolve ${entry}`).toBe(true);
      // A missing edge would DEFLATE the count and make an over-ceiling entry
      // read as a pass, so fail closed on one.
      expect(graph.missingCount, `unresolved imports: ${graph.missing}`).toBe(0);
      expect(graph.moduleCount).toBeLessThanOrEqual(BUILD_GRAPH_CEILING);
    },
  );

  it.each(DEFERRED_MODULES)(
    "%s is reached from the shared shell at request time, not eagerly",
    (specifier) => {
      const code = stripComments(source(SHELL));
      expect(staticSpecifiers(code)).not.toContain(specifier);
      expect(dynamicSpecifiers(code)).toContain(specifier);
    },
  );

  it.each(SCOPED_ENTRIES)("%s declares itself request-time", (entry) => {
    // The root layout already forces dynamic rendering for everything beneath
    // it, and next.config.ts records that a page MAY override that locally with
    // `force-static`. These ten never may: a scoped launch surface reads the
    // caller's session on every request, and a static override would put its
    // metadata read into the build. Declaring it at the entry keeps that local.
    expect(stripComments(source(entry))).toContain(
      'export const dynamic = "force-dynamic";',
    );
  });
});
