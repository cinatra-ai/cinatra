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
 * Metric: route-graph.mjs's own `analyzeRoute(entry).coreModuleCount` — the
 * count of distinct first-party modules outside the extension tree (under src
 * and packages workspace src) that a route's page/route entry reaches through
 * modules outside the extension tree (cinatra#3664, cinatra#3669). The walk
 * still follows every edge through the extension tree, so a missing import
 * inside a pack still fails closed. Two parts never count against a ceiling and
 * are reported per route beside it: the extension-owned modules (the excluded
 * count; a pinned pack's own modules are the intended cost of pinning it, and
 * each changed pack is read by the pin-advance host-tool check), and the core
 * modules the walk reaches only through a pack's modules (the pack-reached
 * reading, `reached through <pack>: <n> core modules`, listed per pack in the
 * analyzer's generated map: a pin advance whose pack imports a further core
 * module is that pack's cost, not the route's own growth). A core module the
 * route also reaches through core modules counts. The measurement fails closed
 * when the three parts do not add up to the whole walk. We reuse the analyzer
 * (importing FIXED_ROUTES + analyzeRoute) rather than re-deriving the metric,
 * so the ratchet and the reporter can never diverge.
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
 *    that automatically. Every failure names the route and the record field.
 *    The gate's tests check the COMMITTED baseline the same way
 *    (`validateCommittedAbsorbs` against the base), so a pull request with
 *    real core growth carries its records and passes both (cinatra#3669).
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
  "Route-graph ratchet baseline (no-new-rot ratchet). Each entry is the CURRENT reachable-first-party-module-count ceiling for a LOCKED FIXED_ROUTES route (the primary dev-perf 'first-party graph pressure' metric from scripts/route-graph.mjs). The gate fails when a tracked route's count grows BEYOND its ceiling and when the committed baseline raises any ceiling vs the base branch WITHOUT a matching absorb record. Counts are captured WITH the companion extension repos cloned pinned (exactly as CI does via clone-extensions) so they reproduce in CI. The counts exclude modules under the extension tree (extensions/**): they are walked and reported per route as the excluded count, and each changed pack is read by the pin-advance host-tool check. A core module a route reaches only through a pack's modules is that pack's cost: it is reported per pack ('reached through <pack>') and excluded as well; a core module the route also reaches through core modules counts. Regenerate with `node scripts/audit/route-graph-ratchet.mjs --write-baseline` after cloning the extensions — a ceiling should only ever be LOWERED as barrel imports are narrowed, and is never raised SILENTLY. A sanctioned raise must be ANNOTATED: a sibling `absorbs` record `route -> { from, to, reason, pr }` whose from/to exactly match the raise vs the base branch (from = the base ceiling, to = the new committed ceiling, reason = why the growth is accepted, pr = the PR carrying the absorbed change). The gate and its tests validate the committed records strictly against the base (malformed/stale/orphan records fail closed, naming the route and the field; a carried-forward record may not be deleted while its raised ceiling is kept) and the gate prints a LOUD NOTICE line for every absorbed raise. The tracked route set is route-graph.mjs FIXED_ROUTES; change it there, then regenerate.";

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
      broken.push({ route, reason: info.error ?? "route entry did not resolve (a moved entry must update route-graph FIXED_ROUTES + the baseline)" });
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

const isPositiveInteger = (v) => Number.isInteger(v) && v > 0;
const hasOwn = (obj, key) => obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);

/**
 * The field-level problems of ONE absorb record (shape only, no baseline
 * context): `[{ field, reason }]`, empty for a well-formed record.
 */
export function absorbRecordFieldErrors(rec) {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) {
    return [{ field: "record", reason: "must be an object { from, to, reason, pr }" }];
  }
  const errors = [];
  for (const key of ABSORB_RECORD_KEYS) {
    if (!hasOwn(rec, key)) errors.push({ field: key, reason: "missing" });
  }
  for (const key of Object.keys(rec).sort()) {
    if (!ABSORB_RECORD_KEYS.includes(key)) errors.push({ field: key, reason: "not a record field (a record carries exactly from, to, reason and pr)" });
  }
  if (hasOwn(rec, "from") && !isPositiveInteger(rec.from)) {
    errors.push({ field: "from", reason: `must be a positive integer, is ${JSON.stringify(rec.from)}` });
  }
  if (hasOwn(rec, "to") && !isPositiveInteger(rec.to)) {
    errors.push({ field: "to", reason: `must be a positive integer, is ${JSON.stringify(rec.to)}` });
  } else if (isPositiveInteger(rec.from) && isPositiveInteger(rec.to) && rec.to <= rec.from) {
    // a record documents a RAISE
    errors.push({ field: "to", reason: `stale: "to" (${rec.to}) must be above "from" (${rec.from}); a record documents a raise` });
  }
  if (hasOwn(rec, "reason") && (typeof rec.reason !== "string" || rec.reason.trim() === "")) {
    errors.push({ field: "reason", reason: "must be a non-empty string" });
  }
  // `pr` — the pull request that carries the raise, and ZERO means "there is no
  // pull request yet" (cinatra#2788).
  //
  // WHY ZERO IS ALLOWED AT ALL. A raise has to be annotated by the change that
  // makes it, and a change is measured on a BRANCH — often before a PR exists,
  // and sometimes on a branch whose PR is opened by somebody else later. The
  // only ways out of that used to be to invent a number or to leave the raise
  // unannotated, and both are worse than saying so: a wrong number sends a
  // reader to somebody else's change, and an unannotated raise is the silent
  // accretion this ratchet exists to stop. Zero is the one value that cannot be
  // mistaken for a real PR, and the `reason` still has to say what grew and why.
  //
  // NOTHING ELSE IS RELAXED. A negative or fractional `pr` is still malformed,
  // the record must still name a tracked route, `from` must still be less than
  // `to`, and `to` must still equal the CURRENT ceiling — so a stale record is
  // still a failure and a raise still cannot pass unrecorded.
  if (hasOwn(rec, "pr") && !(Number.isInteger(rec.pr) && rec.pr >= 0)) {
    errors.push({ field: "pr", reason: `must be a non-negative integer (the pull request carrying the raise, 0 when there is none yet), is ${JSON.stringify(rec.pr)}` });
  }
  return errors;
}

/** Structural check for ONE absorb record (shape only, no baseline context). */
export function isStructurallyValidAbsorbRecord(rec) {
  return absorbRecordFieldErrors(rec).length === 0;
}

/** Deep equality of two structurally-valid absorb records. */
function absorbRecordsEqual(a, b) {
  return a.from === b.from && a.to === b.to && a.reason === b.reason && a.pr === b.pr;
}

/** The fields in which two structurally-valid absorb records differ. */
function differingFields(a, b) {
  return ABSORB_RECORD_KEYS.filter((k) => a[k] !== b[k]);
}

const byRouteThenField = (a, b) => a.route.localeCompare(b.route) || String(a.field).localeCompare(String(b.field));

/**
 * STRICT structural validation of a baseline's `absorbs` map (runs
 * UNCONDITIONALLY, even without a base ref — a malformed annotation must fail
 * closed everywhere). Returns sorted `{ route, field, reason }` errors;
 * `absorbs` absent is fine (empty result).
 *
 * A record must: be an object with EXACTLY the keys { from, to, reason, pr };
 * carry positive integers `from` < `to`, and a non-negative integer `pr` (0 =
 * the change has no pull request yet, which is stated rather than invented);
 * carry a non-empty `reason`;
 * name a route tracked in `routes`; and have `to` equal to that route's
 * CURRENT ceiling (a record that no longer describes the current ceiling is
 * stale and must be removed by the change that lowered/re-raised the ceiling).
 */
export function validateAbsorbRecords(baseline) {
  const errors = [];
  const absorbs = baseline?.absorbs;
  if (absorbs === undefined) return errors;
  if (absorbs === null || typeof absorbs !== "object" || Array.isArray(absorbs)) {
    return [{ route: "(absorbs)", field: "absorbs", reason: '"absorbs" must be an object map of route -> { from, to, reason, pr }' }];
  }
  const routes = baseline?.routes ?? {};
  for (const [route, rec] of Object.entries(absorbs)) {
    const fieldErrors = absorbRecordFieldErrors(rec);
    if (fieldErrors.length) {
      for (const e of fieldErrors) errors.push({ route, field: e.field, reason: `malformed absorb record — "${e.field}" ${e.reason}` });
      continue;
    }
    if (!hasOwn(routes, route)) {
      errors.push({ route, field: "route", reason: 'stale absorb record for a route not tracked in "routes" (the baseline no longer carries its ceiling — remove the record)' });
      continue;
    }
    if (routes[route] !== rec.to) {
      errors.push({ route, field: "to", reason: `stale absorb record — "to" (${rec.to}) must equal the route's current ceiling (${routes[route]}); the change that moved the ceiling must retire/replace the record` });
    }
  }
  return errors.sort(byRouteThenField);
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
      const field = rec?.from !== g.base ? "from" : "to";
      const expected = field === "from" ? `the base ceiling (${g.base})` : `the committed ceiling (${g.committed})`;
      violations.push({ route: g.route, field, reason: `ceiling raised ${g.base} -> ${g.committed} but the absorb record does not exactly match the raise delta (record from=${rec?.from} to=${rec?.to}): "${field}" must equal ${expected}` });
      consumed.add(g.route);
    } else {
      violations.push({ route: g.route, field: "absorbs", reason: `ceiling RAISED ${g.base} -> ${g.committed} with NO absorb record (silent raise / regenerate-to-pass bypass)` });
    }
  }

  // 2. A committed record not consumed by a raise must be an identical
  //    carried-forward record still describing the current ceiling.
  const baseRoutes = baseBaseline?.routes ?? {};
  for (const [route, rec] of Object.entries(committedAbsorbs)) {
    if (consumed.has(route)) continue;
    const baseRec = baseAbsorbs[route];
    const carried =
      baseRec !== undefined &&
      isStructurallyValidAbsorbRecord(baseRec) &&
      isStructurallyValidAbsorbRecord(rec) &&
      absorbRecordsEqual(baseRec, rec) &&
      committedRoutes[route] === rec.to;
    if (carried) continue;
    const orphan = "orphan/stale absorb record — not matched by a ceiling raise vs the base and not an identical carried-forward record at its ceiling";
    if (!hasOwn(baseRoutes, route)) {
      violations.push({ route, field: "route", reason: `${orphan}: the base tracks no ceiling for this route, and a net-new route needs no record` });
    } else if (baseRec !== undefined && isStructurallyValidAbsorbRecord(baseRec) && isStructurallyValidAbsorbRecord(rec) && committedRoutes[route] === baseRec.to) {
      for (const field of differingFields(baseRec, rec)) {
        violations.push({ route, field, reason: `${orphan}: "${field}" differs from the base's record at the same ceiling (${baseRec.to})` });
      }
    } else {
      violations.push({ route, field: "from", reason: `${orphan}: the ceiling did not rise from the base ceiling (${baseRoutes[route]} -> ${committedRoutes[route]}), so "from" (${rec?.from}) matches no raise` });
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
      const deleted = `absorb record deleted/altered while its raised ceiling (${baseRec.to}) is kept — the annotation may only be retired by lowering the ceiling, dropping the route, or a new annotated raise`;
      if (rec && isStructurallyValidAbsorbRecord(rec)) {
        for (const field of differingFields(baseRec, rec)) violations.push({ route, field, reason: deleted });
      } else {
        violations.push({ route, field: "absorbs", reason: deleted });
      }
    }
  }

  return {
    violations: uniqueErrors(violations),
    absorbed: absorbed.sort((a, b) => a.route.localeCompare(b.route)),
  };
}

// De-duplicate (a route can trip two checks with the same root cause) and sort.
function uniqueErrors(errors) {
  const seen = new Set();
  return errors
    .filter((e) => {
      const key = `${e.route}\u0000${e.field}\u0000${e.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(byRouteThenField);
}

/**
 * The strict check of a COMMITTED baseline's absorb records (cinatra#3669):
 * what the gate runs, in one place, for the gate's tests. Without a base
 * (`baseBaseline` null) only the structural check runs. With one, every
 * committed record must be a raise record (`from` = the base ceiling, `to` =
 * the committed ceiling) or the base's own record carried forward unchanged at
 * the same ceiling; a raise without its record, a stale record and an orphan
 * all fail. Returns sorted `{ route, field, reason }`; empty = valid.
 */
export function validateCommittedAbsorbs(baseBaseline, committedBaseline) {
  const structural = validateAbsorbRecords(committedBaseline);
  if (structural.some((e) => e.field === "absorbs") || !baseBaseline) return structural;
  // A record with a structural error is reported once, by its field.
  const flagged = new Set(structural.map((e) => e.route));
  const { violations } = classifyRaises(baseBaseline, committedBaseline);
  return uniqueErrors([...structural, ...violations.filter((v) => !flagged.has(v.route))]);
}

// ---------------------------------------------------------------------------
// Measurement (reuses the route-graph analyzer)
// ---------------------------------------------------------------------------

/**
 * The ratchet's measurement of one route analysis: `moduleCount` is the CORE
 * count (the analysis's `coreModuleCount`, null when not ok),
 * `excludedExtensionModules` the extension-owned modules it leaves out,
 * `excludedPackReachedCoreModules` the core modules the walk reaches only
 * through a pack, and `packReachedCoreModulesByPack` how many of those each
 * pack reaches (a module several packs reach counts for each). An analysis
 * without a core count, or whose parts do not add up to its whole walk, is not
 * ok (fail closed). An analysis that attributes nothing to packs (no
 * `packReachedCoreModuleCount`) reads 0 there: its core count then holds every
 * core module, the stricter reading.
 */
export function ratchetMeasurement(analysis) {
  const notOk = (error) => ({
    ok: false,
    moduleCount: null,
    missingCount: null,
    excludedExtensionModules: null,
    excludedPackReachedCoreModules: null,
    packReachedCoreModulesByPack: null,
    ...(error ? { error } : {}),
  });
  if (analysis?.ok !== true || !Number.isInteger(analysis.coreModuleCount)) return notOk();
  const core = analysis.coreModuleCount;
  const ext = analysis.extensionModuleCount;
  const packReached = analysis.packReachedCoreModuleCount ?? 0;
  const byPack = analysis.packReachedCoreModules ?? {};
  const listsOk =
    byPack !== null &&
    typeof byPack === "object" &&
    !Array.isArray(byPack) &&
    Object.values(byPack).every((mods) => Array.isArray(mods) && mods.length > 0) &&
    new Set(Object.values(byPack).flat()).size === packReached;
  if (
    !Number.isInteger(ext) ||
    !Number.isInteger(packReached) ||
    !Number.isInteger(analysis.moduleCount) ||
    core + ext + packReached !== analysis.moduleCount ||
    !listsOk
  ) {
    return notOk(
      `the walk does not reconcile: ${core} core + ${ext} pack modules + ${packReached} pack-reached core modules must equal the ${analysis.moduleCount} reachable modules, and the per-pack lists must hold exactly the pack-reached core modules`,
    );
  }
  return {
    ok: true,
    moduleCount: core,
    missingCount: analysis.missingCount,
    excludedExtensionModules: ext,
    excludedPackReachedCoreModules: packReached,
    packReachedCoreModulesByPack: Object.fromEntries(
      Object.entries(byPack)
        .map(([pack, mods]) => [pack, mods.length])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  };
}

/**
 * The per-pack reading of one measurement:
 * "reached through <pack>: <n> core modules, …" (empty when no core module is
 * reached only through a pack).
 */
export function packReachReading(measurement) {
  return Object.entries(measurement?.packReachedCoreModulesByPack ?? {})
    .map(([pack, n]) => `reached through ${pack}: ${n} core module${n === 1 ? "" : "s"}`)
    .join(", ");
}

/**
 * Run the route-graph analyzer over the LOCKED FIXED_ROUTES and return
 * `counts` = Map<route, ratchetMeasurement(analysis)> and `analyses` =
 * Map<route, analysis> (the report lists the pack-reached modules from it).
 * Importing route-graph.mjs is side-effect-free (its CLI is guarded behind a
 * direct-execution check).
 */
function measureRoutes() {
  const counts = new Map();
  const analyses = new Map();
  for (const { route, entry } of FIXED_ROUTES) {
    const analysis = analyzeRoute(entry);
    analyses.set(route, analysis);
    counts.set(route, ratchetMeasurement(analysis));
  }
  return { counts, analyses };
}

// "/sign-in 0, /api/mcp 481 + 18 pack-reached core modules, …" — what each
// route leaves out: the extension-owned modules, and the core modules it
// reaches only through a pack.
function excludedSummary(counts) {
  return FIXED_ROUTES.map(({ route }) => {
    const info = counts.get(route);
    if (!info?.ok) return `${route} unresolved`;
    const n = info.excludedPackReachedCoreModules;
    return `${route} ${info.excludedExtensionModules}${n ? ` + ${n} pack-reached core module${n === 1 ? "" : "s"}` : ""}`;
  }).join(", ");
}

/**
 * The per-pack readings printed beside the excluded counts, one line per
 * distinct reading with the routes that share it:
 * "pack-reached core modules on /api/mcp, /chat: reached through <pack>: <n> core modules, …".
 */
export function packReachLines(counts, routes = FIXED_ROUTES.map(({ route }) => route)) {
  const groups = new Map();
  for (const route of routes) {
    const info = counts.get(route);
    const reading = info?.ok ? packReachReading(info) : "";
    if (!reading) continue;
    if (!groups.has(reading)) groups.set(reading, []);
    groups.get(reading).push(route);
  }
  return [...groups].map(([reading, rs]) => `pack-reached core modules on ${rs.join(", ")}: ${reading}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write-baseline");
  const report = args.includes("--report");

  let counts;
  let analyses;
  try {
    ({ counts, analyses } = measureRoutes());
  } catch (err) {
    console.error(`[route-graph-ratchet] scanner error: ${err?.stack ?? err}`);
    process.exit(2);
  }

  if (write) {
    const routes = {};
    for (const { route } of FIXED_ROUTES) {
      const info = counts.get(route);
      if (!info.ok) {
        console.error(`[route-graph-ratchet] cannot write baseline — ${info.error ?? "route entry did not resolve"}: ${route}`);
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
    for (const e of recordErrors) console.error(`  ${e.route} [${e.field}]: ${e.reason}`);
    process.exit(1);
  }

  if (report) {
    console.log(`[route-graph-ratchet] ${FIXED_ROUTES.length} tracked route(s); current core count vs ceiling (extension-owned modules excluded):`);
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
      const excluded = info.ok ? `(excluded ${info.excludedExtensionModules} pack modules + ${info.excludedPackReachedCoreModules} pack-reached core modules)` : "";
      console.log(`  ${countStr.padStart(20)} / ${String(ceiling ?? "-").padStart(6)}  ${headroom !== null ? `(headroom ${headroom})` : ""}  ${excluded}  ${route}`);
      if (!info.ok && info.error) console.log(`${" ".repeat(24)}${info.error}`);
      for (const [pack, mods] of Object.entries(analyses.get(route)?.packReachedCoreModules ?? {})) {
        console.log(`${" ".repeat(24)}reached through ${pack}: ${mods.length} core module${mods.length === 1 ? "" : "s"} — ${mods.join(", ")}`);
      }
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
        violations.forEach((v) => console.error(`  + ${v.route} [${v.field}]: ${v.reason}`));
        console.error(`A ceiling is never raised silently: a sanctioned raise needs a committed absorbs record { from, to, reason, pr } exactly matching the raise (see the baseline note).`);
        process.exit(1);
      }
    }
  }

  const { over, broken } = diffAgainstBaseline(counts, baseline);

  if (over.length === 0 && broken.length === 0) {
    console.log(`[route-graph-ratchet] OK — no tracked route exceeds its baseline (${FIXED_ROUTES.length} routes tracked; core modules only, extension-owned modules excluded: ${excludedSummary(counts)}).`);
    for (const line of packReachLines(counts)) console.log(`[route-graph-ratchet] ${line}`);
    process.exit(0);
  }

  if (over.length) {
    console.error(`[route-graph-ratchet] FAIL — ${over.length} tracked route${over.length === 1 ? "" : "s"} grew beyond baseline:`);
    for (const o of over) {
      const info = counts.get(o.route);
      console.error(`  ${o.route}: ${o.count} core modules (ceiling ${o.ceiling}, +${o.delta}; ${info?.excludedExtensionModules} extension-owned module(s) and ${info?.excludedPackReachedCoreModules} pack-reached core module(s) excluded)`);
    }
    for (const line of packReachLines(counts, over.map((o) => o.route))) console.error(`  ${line}`);
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
