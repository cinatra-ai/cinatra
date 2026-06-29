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
});
