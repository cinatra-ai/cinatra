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
 *    baseline may never be raised SILENTLY vs the base branch. An UNANNOTATED
 *    ceiling raise (the regenerate-to-pass bypass) FAILS in every context (PR
 *    arm vs origin/<base>, push arm vs the previous tip). A net-new route
 *    (expands coverage) or a dropped route (a route removed from FIXED_ROUTES)
 *    is allowed. Fail-closed if the ref can't be resolved.
 *  - ANNOTATED absorb (sanctioned raise): the committed baseline may carry a
 *    structured per-route record in a sibling `absorbs` map —
 *    `route -> { from, to, reason, pr }`. A ceiling raise passes ONLY when the
 *    committed record exactly matches the raise delta (`from` === the base
 *    ceiling, `to` === the committed ceiling); the gate then emits a LOUD
 *    NOTICE line for the absorbed raise so it is visible in the run log.
 *    Records are validated strictly and fail closed: a malformed record, a
 *    record whose `to` no longer equals the route's current ceiling (stale), a
 *    record neither matched by a raise nor carried forward identically from
 *    the base (orphan), and deleting/altering a carried-forward record while
 *    keeping its raised ceiling all FAIL. Lowering the ceiling (or dropping
 *    the route) is the only way to retire a record — `--write-baseline` does
 *    that automatically.
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

// Single source for the baseline's self-describing prose (kept in the gate so
// `--write-baseline` regenerations cannot drift the documented contract).
const BASELINE_NOTE =
  "Route-graph ratchet baseline (no-new-rot ratchet). Each entry is the CURRENT reachable-first-party-module-count ceiling for a LOCKED FIXED_ROUTES route (the primary dev-perf 'first-party graph pressure' metric from scripts/route-graph.mjs). The gate fails when a tracked route's count grows BEYOND its ceiling and when the committed baseline raises any ceiling vs the base branch WITHOUT a matching absorb record. Counts are captured WITH the companion extension repos cloned pinned (exactly as CI does via clone-extensions) so they reproduce in CI. Regenerate with `node scripts/audit/route-graph-ratchet.mjs --write-baseline` after cloning the extensions — a ceiling should only ever be LOWERED as barrel imports are narrowed, and is never raised SILENTLY. A sanctioned raise must be ANNOTATED: a sibling `absorbs` record `route -> { from, to, reason, pr }` whose from/to exactly match the raise vs the base branch (from = the base ceiling, to = the new committed ceiling, reason = why the growth is accepted, pr = the PR carrying the absorbed change). The gate validates records strictly (malformed/stale/orphan records fail closed; a carried-forward record may not be deleted while its raised ceiling is kept) and prints a LOUD NOTICE line for every absorbed raise. The tracked route set is route-graph.mjs FIXED_ROUTES; change it there, then regenerate.";

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

// The exact key set of a well-formed absorb record.
const ABSORB_RECORD_KEYS = ["from", "pr", "reason", "to"];

/** Structural check for ONE absorb record (shape only, no baseline context). */
export function isStructurallyValidAbsorbRecord(rec) {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return false;
  const keys = Object.keys(rec).sort();
  if (keys.length !== ABSORB_RECORD_KEYS.length || keys.some((k, i) => k !== ABSORB_RECORD_KEYS[i])) return false;
  if (!Number.isInteger(rec.from) || rec.from <= 0) return false;
  if (!Number.isInteger(rec.to) || rec.to <= 0) return false;
  if (rec.to <= rec.from) return false; // a record documents a RAISE
  if (typeof rec.reason !== "string" || rec.reason.trim() === "") return false;
  if (!Number.isInteger(rec.pr) || rec.pr <= 0) return false;
  return true;
}

/** Deep equality of two structurally-valid absorb records. */
function absorbRecordsEqual(a, b) {
  return a.from === b.from && a.to === b.to && a.reason === b.reason && a.pr === b.pr;
}

/**
 * STRICT structural validation of a baseline's `absorbs` map (runs
 * UNCONDITIONALLY, even without a base ref — a malformed annotation must fail
 * closed everywhere). Returns sorted `{ route, reason }` errors; `absorbs`
 * absent is fine (empty result).
 *
 * A record must: be an object with EXACTLY the keys { from, to, reason, pr };
 * carry positive integers `from` < `to` and `pr`; carry a non-empty `reason`;
 * name a route tracked in `routes`; and have `to` equal to that route's
 * CURRENT ceiling (a record that no longer describes the current ceiling is
 * stale and must be removed by the change that lowered/re-raised the ceiling).
 */
export function validateAbsorbRecords(baseline) {
  const errors = [];
  const absorbs = baseline?.absorbs;
  if (absorbs === undefined) return errors;
  if (absorbs === null || typeof absorbs !== "object" || Array.isArray(absorbs)) {
    return [{ route: "(absorbs)", reason: '"absorbs" must be an object map of route -> { from, to, reason, pr }' }];
  }
  const routes = baseline?.routes ?? {};
  for (const [route, rec] of Object.entries(absorbs)) {
    if (!isStructurallyValidAbsorbRecord(rec)) {
      errors.push({ route, reason: "malformed absorb record — must be an object with EXACTLY { from, to, reason, pr }: positive integers from < to, non-empty reason string, positive integer pr" });
      continue;
    }
    if (!(route in routes)) {
      errors.push({ route, reason: 'absorb record for a route not tracked in "routes" (orphan — remove it)' });
      continue;
    }
    if (routes[route] !== rec.to) {
      errors.push({ route, reason: `stale absorb record — "to" (${rec.to}) must equal the route's current ceiling (${routes[route]}); the change that moved the ceiling must retire/replace the record` });
    }
  }
  return errors.sort((a, b) => a.route.localeCompare(b.route));
}

/**
 * Base-ref classification of ceiling raises + absorb-record lifecycle.
 * Both baselines are the PARSED committed files (base = the base ref's copy).
 * Assumes the COMMITTED baseline already passed validateAbsorbRecords.
 *
 * Returns { violations: [{ route, reason }], absorbed: [{ route, from, to, reason, pr }] }:
 *  - A raise (committed ceiling > base ceiling) with a committed record that
 *    EXACTLY matches the delta (from === base, to === committed) → absorbed
 *    (allowed; caller emits the LOUD notice). Any other raise → violation
 *    (silent raise / mismatched record).
 *  - A committed record NOT consumed by a raise is valid ONLY as a
 *    carried-forward historical record: the base must contain a DEEP-EQUAL
 *    record for that route AND the committed ceiling must equal record.to.
 *    Anything else (pre-planted record with no raise, record for a net-new
 *    route, record surviving a lower) → violation (orphan/stale).
 *  - Base-side preservation: a base record whose route still exists at the
 *    SAME (raised) ceiling must be carried forward deep-equal — deleting or
 *    altering the annotation while keeping the raised ceiling → violation.
 *    (Dropping the route, lowering the ceiling, or a new annotated raise
 *    retires the record.)
 */
export function classifyRaises(baseBaseline, committedBaseline) {
  const committedRoutes = committedBaseline?.routes ?? {};
  const baseAbsorbs = baseBaseline?.absorbs ?? {};
  const committedAbsorbs = committedBaseline?.absorbs ?? {};
  const violations = [];
  const absorbed = [];
  const consumed = new Set();

  // 1. Every raise vs the base must be exactly matched by a committed record.
  for (const g of baselineGrowth(baseBaseline, committedBaseline)) {
    const rec = committedAbsorbs[g.route];
    if (rec && isStructurallyValidAbsorbRecord(rec) && rec.from === g.base && rec.to === g.committed) {
      absorbed.push({ route: g.route, from: rec.from, to: rec.to, reason: rec.reason, pr: rec.pr });
      consumed.add(g.route);
    } else if (rec) {
      violations.push({ route: g.route, reason: `ceiling raised ${g.base} -> ${g.committed} but the absorb record does not exactly match the raise delta (record from=${rec?.from} to=${rec?.to})` });
      consumed.add(g.route);
    } else {
      violations.push({ route: g.route, reason: `ceiling RAISED ${g.base} -> ${g.committed} with NO absorb record (silent raise / regenerate-to-pass bypass)` });
    }
  }

  // 2. A committed record not consumed by a raise must be an identical
  //    carried-forward record still describing the current ceiling.
  for (const [route, rec] of Object.entries(committedAbsorbs)) {
    if (consumed.has(route)) continue;
    const baseRec = baseAbsorbs[route];
    const carried =
      baseRec !== undefined &&
      isStructurallyValidAbsorbRecord(baseRec) &&
      isStructurallyValidAbsorbRecord(rec) &&
      absorbRecordsEqual(baseRec, rec) &&
      committedRoutes[route] === rec.to;
    if (!carried) {
      violations.push({ route, reason: "orphan/stale absorb record — not matched by a ceiling raise vs the base and not an identical carried-forward record at its ceiling" });
    }
  }

  // 3. Base-side preservation: the annotation of a still-raised ceiling may
  //    not be deleted or altered (codex round-0 finding).
  for (const [route, baseRec] of Object.entries(baseAbsorbs)) {
    if (!isStructurallyValidAbsorbRecord(baseRec)) continue; // malformed base record cannot constrain (committed side is validated separately)
    const committedCeiling = committedRoutes[route];
    if (committedCeiling === undefined) continue; // route dropped → record retires
    if (committedCeiling !== baseRec.to) continue; // lowered or re-raised → retired/replaced (a re-raise is checked in (1))
    const rec = committedAbsorbs[route];
    if (!rec || !isStructurallyValidAbsorbRecord(rec) || !absorbRecordsEqual(baseRec, rec)) {
      violations.push({ route, reason: `absorb record deleted/altered while its raised ceiling (${baseRec.to}) is kept — the annotation may only be retired by lowering the ceiling, dropping the route, or a new annotated raise` });
    }
  }

  // De-duplicate (a route can trip (2) and (3) with the same root cause).
  const seen = new Set();
  const uniqueViolations = violations.filter((v) => {
    const key = `${v.route} ${v.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    violations: uniqueViolations.sort((a, b) => a.route.localeCompare(b.route)),
    absorbed: absorbed.sort((a, b) => a.route.localeCompare(b.route)),
  };
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
    // Carry forward ONLY the absorb records that still exactly describe a
    // tracked route's (re)written ceiling; a lowered/re-raised/dropped route
    // retires its record here automatically. A raise this write smuggles in
    // WITHOUT a matching record is still blocked by the base-ref ratchet.
    let absorbs;
    if (existsSync(BASELINE_FILE)) {
      try {
        const prior = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
        const kept = Object.entries(prior?.absorbs ?? {})
          .filter(([route, rec]) => isStructurallyValidAbsorbRecord(rec) && routes[route] === rec.to)
          .sort(([a], [b]) => a.localeCompare(b));
        if (kept.length) absorbs = Object.fromEntries(kept);
      } catch {
        // Unparseable prior baseline → write a records-free baseline (any
        // raise it would need is still caught by the base-ref ratchet).
      }
    }
    const baseline = {
      note: BASELINE_NOTE,
      routes,
      ...(absorbs ? { absorbs } : {}),
    };
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`[route-graph-ratchet] wrote baseline: ${FIXED_ROUTES.length} tracked route(s)${absorbs ? `, ${Object.keys(absorbs).length} absorb record(s) carried forward` : ""}.`);
    return;
  }

  const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : { routes: {} };

  // Structural validation of the committed absorb records runs UNCONDITIONALLY
  // (report mode and no-base-ref local runs included): a malformed, stale, or
  // orphan annotation fails closed everywhere.
  const recordErrors = validateAbsorbRecords(baseline);
  if (recordErrors.length) {
    console.error(`[route-graph-ratchet] FAIL — ${recordErrors.length} invalid absorb record(s) in the committed baseline:`);
    for (const e of recordErrors) console.error(`  ${e.route}: ${e.reason}`);
    process.exit(1);
  }

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

  // Base-ref ratchet: block the SILENT regenerate-to-pass bypass (raise a
  // ceiling + `--write-baseline` in the same PR with no annotation). When
  // ROUTE_GRAPH_RATCHET_BASE is set (wired from the CI base ref: PR arm →
  // origin/<base>, push arm → the previous tip), every ceiling raise vs the
  // base-branch baseline must be exactly matched by a committed absorb record
  // (then it passes with a LOUD notice); orphan/stale records and a deleted
  // still-raised annotation also fail. Mirrors the sibling no-new-rot gates;
  // fail-closed if the ref can't be resolved.
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
      let baseBaseline = null;
      try {
        baseBaseline = JSON.parse(baseText);
      } catch {
        console.error(`[route-graph-ratchet] FAIL — base baseline at ${baseRef} is not valid JSON. Failing closed.`);
        process.exit(1);
      }
      const { violations, absorbed } = classifyRaises(baseBaseline, baseline);
      for (const a of absorbed) {
        console.log(`[route-graph-ratchet] NOTICE — ABSORBED ceiling raise ${a.route}: ${a.from} -> ${a.to} (${a.reason}; PR #${a.pr})`);
      }
      if (violations.length) {
        console.error(`[route-graph-ratchet] FAIL — committed baseline vs ${baseRef}: ${violations.length} unannotated raise(s) / invalid absorb record(s):`);
        violations.forEach((v) => console.error(`  + ${v.route}: ${v.reason}`));
        console.error(`A ceiling is never raised silently: a sanctioned raise needs a committed absorbs record { from, to, reason, pr } exactly matching the raise (see the baseline note).`);
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
