#!/usr/bin/env node
/**
 * Route-graph ratchet gate (no-new-rot ratchet).
 *
 * scripts/route-graph.mjs is a pure REPORTER: it BFS-counts the reachable
 * FIRST-PARTY module graph per route for the LOCKED FIXED_ROUTES set (the
 * primary deterministic dev-perf acceptance metric — "first-party graph
 * pressure"). Until now it had no exit code / threshold, so a PR could grow a
 * route's reachable graph (a wider barrel import, a new cross-package edge)
 * with NOTHING in CI flagging it. This gate is the GUARDRAIL: it pins the
 * CURRENT per-route reachable-module count of each LOCKED route as a baseline
 * and fails CI when a tracked route's count grows BEYOND its baseline. It forces
 * NO narrowing (baselines are set at the current state); it only prevents the
 * locked routes from accreting more graph pressure, and the baseline ratchets
 * DOWN as barrel imports are narrowed. This is the route-level sibling of the
 * file-size-ratchet / workspace-dep-cycles no-new-rot ratchets — same
 * fail-closed, base-ref, regenerate-to-pass-blocked shape.
 *
 * Metric: route-graph.mjs's own `analyzeRoute(entry).moduleCount` — the count
 * of distinct reachable first-party modules (under src, packages workspace src,
 * and extensions) from a route's page/route entry. We reuse the analyzer
 * (importing FIXED_ROUTES + analyzeRoute) rather than re-deriving the metric, so
 * the ratchet and the reporter can never diverge.
 *
 * Ratchet semantics:
 *  - A tracked route ABOVE its baseline ceiling → FAIL (the locked route's graph
 *    grew).
 *  - A tracked route AT/BELOW its ceiling → OK (a shrink is always allowed; the
 *    baseline is the CEILING, not an exact target, so a narrowing PR is never
 *    forced to re-run `--write-baseline` to stay green — but SHOULD, to lock the
 *    win in).
 *  - A tracked route whose entry no longer resolves (`analyzeRoute().ok === false`)
 *    → FAIL (a baseline entry must track a real route; a moved entry must be
 *    reflected in route-graph.mjs FIXED_ROUTES + this baseline).
 *  - A tracked route with `missingCount > 0` → FAIL. A non-zero missing count
 *    means first-party imports (e.g. companion @cinatra-ai/* extension `register`
 *    entrypoints) did NOT resolve — almost always because the companion
 *    extension repos were not cloned (`clone-extensions`) before the gate ran.
 *    Those unresolved edges DEFLATE moduleCount, so a count that is "under
 *    ceiling" would be a FALSE pass. The gate therefore fails closed on any
 *    missing import rather than measure an incomplete graph. (The committed
 *    baseline is captured WITH the extensions cloned pinned, exactly as CI does,
 *    so missingCount is 0 there.)
 *  - A tracked route with no baseline ceiling → FAIL (FIXED_ROUTES / baseline
 *    drift: a route added to FIXED_ROUTES without regenerating the baseline).
 *  - Base-ref ratchet (ROUTE_GRAPH_RATCHET_BASE / CI base ref): the committed
 *    baseline may only ever SHRINK or stay equal vs the base branch. A ceiling
 *    RAISED for any route (the regenerate-to-pass bypass) FAILS. A net-new route
 *    (expands coverage) or a dropped route (a route removed from FIXED_ROUTES) is
 *    allowed. Fail-closed if the ref can't be resolved.
 *
 * Node-builtins-only + offline (imports route-graph.mjs, which is also
 * node-builtins-only; the base-ref ratchet shells out to `git`). No third-party
 * dependency — a .mjs gate cannot import the project's .ts toolchain.
 *
 * Exit codes: 0 = clean (no route over baseline), 1 = findings, 2 = scanner error.
 *
 * Usage:
 *   node scripts/audit/route-graph-ratchet.mjs                  # gate (CI)
 *   node scripts/audit/route-graph-ratchet.mjs --report         # current counts vs baseline
 *   node scripts/audit/route-graph-ratchet.mjs --write-baseline # (re)write baseline to current counts (should only ever shrink)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FIXED_ROUTES, analyzeRoute } from "../route-graph.mjs";

const REPO_ROOT = process.cwd();
const BASELINE_FILE = join(REPO_ROOT, "scripts/audit/route-graph-ratchet.baseline.json");

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in __tests__/route-graph-ratchet.test.mjs)
// ---------------------------------------------------------------------------

/**
 * Compare current per-route module counts against the baseline ceilings.
 * Returns structured findings.
 *
 * `counts` = Map<route, { moduleCount:number, ok:boolean, missingCount:number }>.
 * `baseline` = { routes: { [route]: number } }.
 *
 * A route OVER its ceiling, a tracked route whose entry did not resolve
 * (`ok === false`), a tracked route with unresolved first-party imports
 * (`missingCount > 0`), or a tracked route with no baseline ceiling is a
 * violation; a route at/below ceiling with a fully-resolved graph is OK.
 */
export function diffAgainstBaseline(counts, baseline) {
  const ceilings = baseline?.routes ?? {};
  const over = [];
  const broken = [];
  for (const [route, info] of counts) {
    const ceiling = ceilings[route];
    if (ceiling === undefined) {
      // A tracked route with no baseline ceiling = drift (route added to
      // FIXED_ROUTES but baseline not regenerated). Treat as a violation so the
      // locked set and the baseline can never silently diverge.
      broken.push({ route, reason: "no baseline ceiling (regenerate the baseline)" });
      continue;
    }
    if (!info.ok) {
      broken.push({ route, reason: "route entry did not resolve (a moved entry must update route-graph FIXED_ROUTES + the baseline)" });
      continue;
    }
    if (info.missingCount > 0) {
      // Unresolved first-party imports DEFLATE moduleCount — measuring an
      // incomplete graph would let a real growth hide under the ceiling. Fail
      // closed: almost always the companion extension repos were not cloned
      // (clone-extensions) before the gate ran.
      broken.push({ route, reason: `${info.missingCount} unresolved first-party import(s) — graph incomplete (were the companion extension repos cloned?)` });
      continue;
    }
    if (info.moduleCount > ceiling) {
      over.push({ route, count: info.moduleCount, ceiling, delta: info.moduleCount - ceiling });
    }
  }
  return {
    over: over.sort((a, b) => a.route.localeCompare(b.route)),
    broken: broken.sort((a, b) => a.route.localeCompare(b.route)),
  };
}

/**
 * Base-ref ratchet: per-route ceilings in the COMMITTED baseline that are
 * HIGHER than the BASE-branch baseline — i.e. a regenerate-to-pass bypass that
 * raised a ceiling in the same PR. Mirrors the sibling no-new-rot gates so each
 * ceiling can only ever SHRINK (or a route be dropped from tracking). A net-new
 * route (no base entry) EXPANDS coverage and is NOT growth. Returns sorted
 * `{ route, base, committed }`.
 */
export function baselineGrowth(baseBaseline, committedBaseline) {
  const baseRoutes = baseBaseline?.routes ?? {};
  const committedRoutes = committedBaseline?.routes ?? {};
  const grew = [];
  for (const [route, committed] of Object.entries(committedRoutes)) {
    const base = baseRoutes[route];
    if (base === undefined) continue; // net-new tracked route → expands coverage, not growth
    if (committed > base) grew.push({ route, base, committed });
  }
  return grew.sort((a, b) => a.route.localeCompare(b.route));
}

// ---------------------------------------------------------------------------
// Measurement (reuses the route-graph analyzer)
// ---------------------------------------------------------------------------

/**
 * Run the route-graph analyzer over the LOCKED FIXED_ROUTES and return
 * Map<route, { moduleCount, ok, missingCount }>. Importing route-graph.mjs is
 * side-effect-free (its CLI is guarded behind a direct-execution check).
 */
function measureRoutes() {
  const counts = new Map();
  for (const { route, entry } of FIXED_ROUTES) {
    const r = analyzeRoute(entry);
    counts.set(route, {
      ok: r.ok === true,
      moduleCount: r.ok ? r.moduleCount : null,
      missingCount: r.ok ? r.missingCount : null,
    });
  }
  return counts;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write-baseline");
  const report = args.includes("--report");

  let counts;
  try {
    counts = measureRoutes();
  } catch (err) {
    console.error(`[route-graph-ratchet] scanner error: ${err?.stack ?? err}`);
    process.exit(2);
  }

  if (write) {
    const routes = {};
    for (const { route } of FIXED_ROUTES) {
      const info = counts.get(route);
      if (!info.ok) {
        console.error(`[route-graph-ratchet] cannot write baseline — route entry did not resolve: ${route}`);
        process.exit(2);
      }
      if (info.missingCount > 0) {
        console.error(`[route-graph-ratchet] cannot write baseline — ${route} has ${info.missingCount} unresolved first-party import(s); the graph is incomplete (clone the companion extension repos first so the baseline reproduces in CI).`);
        process.exit(2);
      }
      routes[route] = info.moduleCount;
    }
    const baseline = {
      note: "Route-graph ratchet baseline (no-new-rot ratchet). Each entry is the CURRENT reachable-first-party-module-count ceiling for a LOCKED FIXED_ROUTES route (the primary dev-perf 'first-party graph pressure' metric from scripts/route-graph.mjs). The gate fails when a tracked route's count grows BEYOND its ceiling and when the committed baseline raises any ceiling vs the base branch. Counts are captured WITH the companion extension repos cloned pinned (exactly as CI does via clone-extensions) so they reproduce in CI. Regenerate with `node scripts/audit/route-graph-ratchet.mjs --write-baseline` after cloning the extensions — a ceiling should only ever be LOWERED as barrel imports are narrowed, never raised. The tracked route set is route-graph.mjs FIXED_ROUTES; change it there, then regenerate.",
      routes,
    };
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`[route-graph-ratchet] wrote baseline: ${FIXED_ROUTES.length} tracked route(s).`);
    return;
  }

  const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : { routes: {} };

  if (report) {
    console.log(`[route-graph-ratchet] ${FIXED_ROUTES.length} tracked route(s); current count vs ceiling:`);
    const ceilings = baseline.routes ?? {};
    for (const { route } of FIXED_ROUTES) {
      const info = counts.get(route);
      const ceiling = ceilings[route];
      const countStr = !info.ok
        ? "UNRESOLVED"
        : info.missingCount > 0
          ? `${info.moduleCount}(+${info.missingCount} missing)`
          : String(info.moduleCount);
      const headroom = info.ok && info.missingCount === 0 && ceiling !== undefined ? ceiling - info.moduleCount : null;
      console.log(`  ${countStr.padStart(20)} / ${String(ceiling ?? "-").padStart(6)}  ${headroom !== null ? `(headroom ${headroom})` : ""}  ${route}`);
    }
    return;
  }

  // Base-ref ratchet: block the regenerate-to-pass bypass (raise a ceiling +
  // `--write-baseline` in the same PR). When ROUTE_GRAPH_RATCHET_BASE is set
  // (wired from the CI base ref), fail if the committed baseline raised any
  // existing route's ceiling vs the base-branch baseline. Mirrors the sibling
  // no-new-rot gates; fail-closed if the ref can't be resolved.
  const baseRef = process.env.ROUTE_GRAPH_RATCHET_BASE;
  if (baseRef) {
    if (baseRef.startsWith("-")) {
      console.error(`[route-graph-ratchet] FAIL — ROUTE_GRAPH_RATCHET_BASE="${baseRef}" is flag-like.`);
      process.exit(1);
    }
    let refResolves = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "ignore"] });
      refResolves = true;
    } catch { refResolves = false; }
    if (!refResolves) {
      console.error(`[route-graph-ratchet] FAIL — ROUTE_GRAPH_RATCHET_BASE="${baseRef}" did not resolve (shallow checkout / misconfig?). Failing closed — ensure the base ref is fetched (fetch-depth: 0).`);
      process.exit(1);
    }
    let baseText = null;
    try {
      baseText = execFileSync("git", ["show", `${baseRef}:scripts/audit/route-graph-ratchet.baseline.json`], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      baseText = null; // ref resolves but file absent → introducing PR, no constraint
    }
    if (baseText) {
      const grew = baselineGrowth(JSON.parse(baseText), baseline);
      if (grew.length) {
        console.error(`[route-graph-ratchet] FAIL — committed baseline RAISED a ceiling vs ${baseRef} (regenerate-to-pass bypass):`);
        grew.forEach((g) => console.error(`  + ${g.route}: ${g.base} -> ${g.committed}`));
        process.exit(1);
      }
    }
  }

  const { over, broken } = diffAgainstBaseline(counts, baseline);

  if (over.length === 0 && broken.length === 0) {
    console.log(`[route-graph-ratchet] OK — no tracked route exceeds its baseline (${FIXED_ROUTES.length} routes tracked).`);
    process.exit(0);
  }

  if (over.length) {
    console.error(`[route-graph-ratchet] FAIL — ${over.length} tracked route${over.length === 1 ? "" : "s"} grew beyond baseline:`);
    for (const o of over) console.error(`  ${o.route}: ${o.count} modules (ceiling ${o.ceiling}, +${o.delta})`);
  }
  if (broken.length) {
    console.error(`[route-graph-ratchet] FAIL — ${broken.length} tracked route${broken.length === 1 ? "" : "s"} cannot be checked:`);
    for (const b of broken) console.error(`  ${b.route}: ${b.reason}`);
  }
  console.error(`\nThese are baselined dev-perf budgets; the ratchet only prevents a locked route's reachable first-party graph from growing. Narrow the offending barrel import / cross-package edge, then LOWER the baseline with --write-baseline (a ceiling may only ever shrink). A non-zero missing count means the companion extension repos were not cloned before measuring.`);
  process.exit(1);
}

// Only run the gate when executed directly — importing for unit tests must not
// trigger the scan or process.exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
