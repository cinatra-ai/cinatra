// Route-graph ratchet gate — unit tests for the pure helpers.
// Zero-dep (node:test) to match the gate (a .mjs gate can't import .ts deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  diffAgainstBaseline,
  baselineGrowth,
  validateAbsorbRecords,
  classifyRaises,
  isStructurallyValidAbsorbRecord,
} from "../route-graph-ratchet.mjs";
import { FIXED_ROUTES, analyzeRoute } from "../../route-graph.mjs";

const REPO_ROOT = process.cwd();
const HERE = fileURLToPath(new URL(".", import.meta.url));

// Shorthand: a fully-resolved (ok, no-missing) route measurement.
const ok = (moduleCount) => ({ ok: true, moduleCount, missingCount: 0 });

test("diffAgainstBaseline: a route over its ceiling is a violation", () => {
  const counts = new Map([["/a", ok(101)]]);
  const { over, broken } = diffAgainstBaseline(counts, { routes: { "/a": 100 } });
  assert.equal(broken.length, 0);
  assert.deepEqual(over, [{ route: "/a", count: 101, ceiling: 100, delta: 1 }]);
});

test("diffAgainstBaseline: a route AT its ceiling is OK (ceiling is inclusive)", () => {
  const counts = new Map([["/a", ok(100)]]);
  const { over, broken } = diffAgainstBaseline(counts, { routes: { "/a": 100 } });
  assert.deepEqual(over, []);
  assert.deepEqual(broken, []);
});

test("diffAgainstBaseline: a route BELOW its ceiling is OK (a shrink is always allowed)", () => {
  const counts = new Map([["/a", ok(50)]]);
  const { over } = diffAgainstBaseline(counts, { routes: { "/a": 100 } });
  assert.deepEqual(over, []);
});

test("diffAgainstBaseline: an unresolved route entry (ok:false) is a violation, not a pass", () => {
  const counts = new Map([["/a", { ok: false, moduleCount: null, missingCount: null }]]);
  const { over, broken } = diffAgainstBaseline(counts, { routes: { "/a": 100 } });
  assert.deepEqual(over, []);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].route, "/a");
});

test("diffAgainstBaseline: missingCount>0 FAILS CLOSED even when count is UNDER the ceiling", () => {
  // The deflated graph (extensions not cloned) reports a count under the ceiling.
  // It MUST NOT pass — an incomplete graph cannot prove the budget is met.
  const counts = new Map([["/a", { ok: true, moduleCount: 50, missingCount: 7 }]]);
  const { over, broken } = diffAgainstBaseline(counts, { routes: { "/a": 100 } });
  assert.deepEqual(over, []);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].route, "/a");
  assert.match(broken[0].reason, /unresolved/i);
});

test("diffAgainstBaseline: a tracked route with no baseline ceiling is a violation (set/baseline drift)", () => {
  const counts = new Map([["/a", ok(10)]]);
  const { broken } = diffAgainstBaseline(counts, { routes: {} });
  assert.equal(broken.length, 1);
  assert.equal(broken[0].route, "/a");
});

test("diffAgainstBaseline: multiple violations sort by route", () => {
  const counts = new Map([
    ["/z", ok(200)],
    ["/a", ok(200)],
  ]);
  const { over } = diffAgainstBaseline(counts, { routes: { "/z": 100, "/a": 100 } });
  assert.deepEqual(over.map((o) => o.route), ["/a", "/z"]);
});

test("baselineGrowth: raising an existing route's ceiling is growth (regenerate-to-pass)", () => {
  const base = { routes: { "/a": 100 } };
  const committed = { routes: { "/a": 120 } }; // raised
  assert.deepEqual(baselineGrowth(base, committed), [{ route: "/a", base: 100, committed: 120 }]);
});

test("baselineGrowth: lowering a ceiling is NOT growth (the intended ratchet direction)", () => {
  const base = { routes: { "/a": 100 } };
  const committed = { routes: { "/a": 80 } }; // lowered after a narrowing
  assert.deepEqual(baselineGrowth(base, committed), []);
});

test("baselineGrowth: keeping a ceiling equal is NOT growth", () => {
  const base = { routes: { "/a": 100 } };
  const committed = { routes: { "/a": 100 } };
  assert.deepEqual(baselineGrowth(base, committed), []);
});

test("baselineGrowth: adding a NET-NEW tracked route is NOT growth (expands coverage)", () => {
  const base = { routes: { "/a": 100 } };
  const committed = { routes: { "/a": 100, "/b": 500 } };
  assert.deepEqual(baselineGrowth(base, committed), []);
});

test("baselineGrowth: dropping a tracked route is allowed (route removed from FIXED_ROUTES)", () => {
  const base = { routes: { "/a": 100, "/b": 500 } };
  const committed = { routes: { "/a": 100 } }; // /b removed
  assert.deepEqual(baselineGrowth(base, committed), []);
});

// ---------------------------------------------------------------------------
// Annotated-absorb mechanism (sanctioned ceiling raises).
// Shorthand: a well-formed absorb record.
// ---------------------------------------------------------------------------
const rec = (from, to, extra = {}) => ({ from, to, reason: "sanctioned growth (#999): test", pr: 999, ...extra });

test("classifyRaises: a raise WITHOUT an absorb record FAILS (silent raise)", () => {
  const base = { routes: { "/a": 100 } };
  const committed = { routes: { "/a": 120 } };
  const { violations, absorbed } = classifyRaises(base, committed);
  assert.deepEqual(absorbed, []);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].route, "/a");
  assert.match(violations[0].reason, /NO absorb record/);
});

test("classifyRaises: a raise with an EXACTLY-matching record is ABSORBED (passes, reported loud)", () => {
  const base = { routes: { "/a": 100 } };
  const committed = { routes: { "/a": 120 }, absorbs: { "/a": rec(100, 120) } };
  const { violations, absorbed } = classifyRaises(base, committed);
  assert.deepEqual(violations, []);
  assert.equal(absorbed.length, 1);
  assert.deepEqual(absorbed[0], { route: "/a", from: 100, to: 120, reason: "sanctioned growth (#999): test", pr: 999 });
});

test("classifyRaises: a record whose from/to does NOT match the raise delta FAILS", () => {
  const base = { routes: { "/a": 100 } };
  // record claims 90 -> 120 but the actual base ceiling is 100
  let out = classifyRaises(base, { routes: { "/a": 120 }, absorbs: { "/a": rec(90, 120) } });
  assert.equal(out.absorbed.length, 0);
  assert.equal(out.violations.length, 1);
  assert.match(out.violations[0].reason, /does not exactly match/);
  // record's to (110) does not reach the committed ceiling (120)
  out = classifyRaises(base, { routes: { "/a": 120 }, absorbs: { "/a": rec(100, 110) } });
  assert.equal(out.absorbed.length, 0);
  assert.ok(out.violations.length >= 1);
});

test("classifyRaises: a record WITHOUT a raise (pre-planted orphan) FAILS", () => {
  const base = { routes: { "/a": 100 } };
  const committed = { routes: { "/a": 100 }, absorbs: { "/a": rec(90, 100) } };
  const { violations, absorbed } = classifyRaises(base, committed);
  assert.deepEqual(absorbed, []);
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /orphan|stale/i);
});

test("classifyRaises: an identical carried-forward record at its ceiling is OK (no notice, no violation)", () => {
  // Post-merge steady state: base (main) already contains the record.
  const base = { routes: { "/a": 120 }, absorbs: { "/a": rec(100, 120) } };
  const committed = { routes: { "/a": 120 }, absorbs: { "/a": rec(100, 120) } };
  const { violations, absorbed } = classifyRaises(base, committed);
  assert.deepEqual(violations, []);
  assert.deepEqual(absorbed, []);
});

test("classifyRaises: DELETING a carried-forward record while keeping the raised ceiling FAILS (annotation preservation)", () => {
  const base = { routes: { "/a": 120 }, absorbs: { "/a": rec(100, 120) } };
  const committed = { routes: { "/a": 120 } }; // record silently dropped, ceiling kept
  const { violations } = classifyRaises(base, committed);
  assert.equal(violations.length, 1);
  assert.match(violations[0].reason, /deleted\/altered/);
});

test("classifyRaises: ALTERING a carried-forward record while keeping the ceiling FAILS", () => {
  const base = { routes: { "/a": 120 }, absorbs: { "/a": rec(100, 120) } };
  const committed = { routes: { "/a": 120 }, absorbs: { "/a": rec(100, 120, { reason: "rewritten history" }) } };
  const { violations } = classifyRaises(base, committed);
  assert.ok(violations.length >= 1);
  assert.ok(violations.every((v) => v.route === "/a"));
});

test("classifyRaises: LOWERING an absorbed ceiling retires the record (record removed → OK)", () => {
  const base = { routes: { "/a": 120 }, absorbs: { "/a": rec(100, 120) } };
  const committed = { routes: { "/a": 105 } }; // narrowed below the absorbed ceiling; record removed
  const { violations, absorbed } = classifyRaises(base, committed);
  assert.deepEqual(violations, []);
  assert.deepEqual(absorbed, []);
});

test("classifyRaises: a NEW annotated raise on an already-absorbed route replaces the old record", () => {
  const base = { routes: { "/a": 120 }, absorbs: { "/a": rec(100, 120) } };
  const committed = { routes: { "/a": 130 }, absorbs: { "/a": rec(120, 130) } };
  const { violations, absorbed } = classifyRaises(base, committed);
  assert.deepEqual(violations, []);
  assert.equal(absorbed.length, 1);
  assert.deepEqual([absorbed[0].from, absorbed[0].to], [120, 130]);
});

test("classifyRaises: dropping a tracked route retires its record (no violation)", () => {
  const base = { routes: { "/a": 120, "/b": 50 }, absorbs: { "/a": rec(100, 120) } };
  const committed = { routes: { "/b": 50 } };
  const { violations } = classifyRaises(base, committed);
  assert.deepEqual(violations, []);
});

test("classifyRaises: a NET-NEW route needs no record; a net-new route WITH a record is an orphan (fails)", () => {
  const base = { routes: { "/a": 100 } };
  // net-new without record → fine (coverage expansion)
  let out = classifyRaises(base, { routes: { "/a": 100, "/b": 500 } });
  assert.deepEqual(out.violations, []);
  // net-new WITH a record → orphan (a coverage expansion is not a raise)
  out = classifyRaises(base, { routes: { "/a": 100, "/b": 500 }, absorbs: { "/b": rec(400, 500) } });
  assert.equal(out.violations.length, 1);
  assert.equal(out.violations[0].route, "/b");
});

test("validateAbsorbRecords: absent absorbs is fine; well-formed matching records pass", () => {
  assert.deepEqual(validateAbsorbRecords({ routes: { "/a": 100 } }), []);
  assert.deepEqual(validateAbsorbRecords({ routes: { "/a": 120 }, absorbs: { "/a": rec(100, 120) } }), []);
});

test("validateAbsorbRecords: MALFORMED records fail closed (missing key, extra key, bad types, to<=from, empty reason)", () => {
  const cases = [
    { "/a": { from: 100, to: 120, reason: "x" } },                        // missing pr
    { "/a": { ...rec(100, 120), extra: true } },                          // extra key
    { "/a": rec("100", 120) },                                            // non-integer from
    { "/a": rec(100, 120, { pr: "959" }) },                               // non-integer pr
    { "/a": rec(120, 120) },                                              // to == from (not a raise)
    { "/a": rec(130, 120) },                                              // to < from
    { "/a": rec(100, 120, { reason: "   " }) },                           // blank reason
    { "/a": null },                                                       // not an object
    { "/a": [100, 120] },                                                 // array
  ];
  for (const absorbs of cases) {
    const errors = validateAbsorbRecords({ routes: { "/a": 120 }, absorbs });
    assert.ok(errors.length >= 1, `expected a structural error for ${JSON.stringify(absorbs)}`);
  }
  // the whole map malformed
  assert.equal(validateAbsorbRecords({ routes: {}, absorbs: [] }).length, 1);
});

test("validateAbsorbRecords: a record for an untracked route and a STALE record (to != current ceiling) fail", () => {
  let errors = validateAbsorbRecords({ routes: { "/a": 120 }, absorbs: { "/gone": rec(100, 120) } });
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /not tracked/);
  errors = validateAbsorbRecords({ routes: { "/a": 110 }, absorbs: { "/a": rec(100, 120) } });
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /stale/);
});

test("isStructurallyValidAbsorbRecord: accepts a well-formed record, rejects shape drift", () => {
  assert.equal(isStructurallyValidAbsorbRecord(rec(100, 120)), true);
  assert.equal(isStructurallyValidAbsorbRecord(undefined), false);
  assert.equal(isStructurallyValidAbsorbRecord({}), false);
});

// --- End-to-end fixture: at-baseline passes; a +1 growth FAILS. ---
test("FIXTURE: at-baseline is clean and a one-route growth is caught", () => {
  const baseline = { routes: { "/x": 10, "/y": 20 } };
  // at baseline → clean
  let res = diffAgainstBaseline(new Map([["/x", ok(10)], ["/y", ok(20)]]), baseline);
  assert.deepEqual(res.over, []);
  assert.deepEqual(res.broken, []);
  // /x grows by 1 → caught; /y untouched stays clean
  res = diffAgainstBaseline(new Map([["/x", ok(11)], ["/y", ok(20)]]), baseline);
  assert.deepEqual(res.over.map((o) => o.route), ["/x"]);
});

// --- Integration: the committed baseline tracks EXACTLY the FIXED_ROUTES set,
// each route's real analyzeRoute() resolves cleanly (ok, no missing imports —
// i.e. the companion extension repos ARE cloned in this environment), and the
// real count is at/below its ceiling. This is what makes the gate green on main
// and proves no set/baseline drift. ---
test("INTEGRATION: the committed baseline covers exactly FIXED_ROUTES, each a resolvable at-or-below-ceiling route", () => {
  const baselinePath = join(HERE, "..", "route-graph-ratchet.baseline.json");
  assert.ok(existsSync(baselinePath), "baseline file must exist");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const baselineKeys = Object.keys(baseline.routes).sort();
  const trackedRoutes = FIXED_ROUTES.map((r) => r.route).sort();
  assert.deepEqual(baselineKeys, trackedRoutes, "baseline keys must equal FIXED_ROUTES routes exactly");
  for (const { route, entry } of FIXED_ROUTES) {
    const r = analyzeRoute(entry);
    assert.ok(r.ok, `route entry must resolve: ${route} (${entry})`);
    assert.equal(r.missingCount, 0, `route ${route} has ${r.missingCount} unresolved first-party import(s) — clone the companion extension repos before measuring`);
    const ceiling = baseline.routes[route];
    assert.ok(r.moduleCount <= ceiling, `route ${route} is ${r.moduleCount} modules, over the committed ceiling ${ceiling} — narrow the graph or regenerate`);
  }
  // The committed absorb records (if any) must be strictly valid against the
  // committed routes map — the same fail-closed structural check the gate runs
  // unconditionally.
  const errors = validateAbsorbRecords(baseline);
  assert.deepEqual(errors, [], `committed absorb records must validate: ${JSON.stringify(errors)}`);
});
