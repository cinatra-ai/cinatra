// Route-graph ratchet gate — unit tests for the pure helpers.
// Zero-dep (node:test) to match the gate (a .mjs gate can't import .ts deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  diffAgainstBaseline,
  baselineGrowth,
  validateAbsorbRecords,
  classifyRaises,
  isStructurallyValidAbsorbRecord,
} from "../route-graph-ratchet.mjs";
// Imported as a namespace so a missing export fails only the case that reads it.
import * as gate from "../route-graph-ratchet.mjs";
import { FIXED_ROUTES, analyzeRoute } from "../../route-graph.mjs";
// Imported as a namespace for the same reason.
import * as routeGraph from "../../route-graph.mjs";

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

// `pr: 0` — "there is no pull request yet" (cinatra#2788). A raise measured on a
// branch before a PR exists still has to be annotated, and the two alternatives
// are worse than saying so: an invented number sends a reader to somebody else's
// change, and an unannotated raise is the silent accretion this ratchet exists to
// stop. Zero is the one value that cannot be mistaken for a real PR.
test("isStructurallyValidAbsorbRecord: pr 0 is VALID — the raise has no pull request yet", () => {
  assert.equal(
    isStructurallyValidAbsorbRecord({ from: 10, to: 12, pr: 0, reason: "measured on a branch with no PR" }),
    true,
  );
});

test("isStructurallyValidAbsorbRecord: a NEGATIVE or fractional pr is still malformed", () => {
  const base = { from: 10, to: 12, reason: "r" };
  assert.equal(isStructurallyValidAbsorbRecord({ ...base, pr: -1 }), false);
  assert.equal(isStructurallyValidAbsorbRecord({ ...base, pr: 1.5 }), false);
  assert.equal(isStructurallyValidAbsorbRecord({ ...base, pr: "0" }), false);
});

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
// real core count is at/below its ceiling. This is what makes the gate green on main
// and proves no set/baseline drift. ---
test("INTEGRATION: the committed baseline covers exactly FIXED_ROUTES, each a resolvable at-or-below-ceiling route", () => {
  const baselinePath = join(HERE, "..", "route-graph-ratchet.baseline.json");
  assert.ok(existsSync(baselinePath), "baseline file must exist");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const baselineKeys = Object.keys(baseline.routes).sort();
  const trackedRoutes = FIXED_ROUTES.map((r) => r.route).sort();
  assert.deepEqual(baselineKeys, trackedRoutes, "baseline keys must equal FIXED_ROUTES routes exactly");
  for (const { route, entry } of FIXED_ROUTES) {
    // The ratchet's own measurement: the core count (extension-owned modules excluded).
    const r = gate.ratchetMeasurement(analyzeRoute(entry));
    assert.ok(r.ok, `route entry must resolve: ${route} (${entry})`);
    assert.equal(r.missingCount, 0, `route ${route} has ${r.missingCount} unresolved first-party import(s) — clone the companion extension repos before measuring`);
    const ceiling = baseline.routes[route];
    assert.ok(r.moduleCount <= ceiling, `route ${route} is ${r.moduleCount} core modules, over the committed ceiling ${ceiling} — narrow the graph or regenerate`);
  }
  // The committed absorb records (if any) must be strictly valid against the
  // committed routes map — the same fail-closed structural check the gate runs
  // unconditionally.
  const errors = validateAbsorbRecords(baseline);
  assert.deepEqual(errors, [], `committed absorb records must validate: ${JSON.stringify(errors)}`);
});

// --- Core-only measurement (cinatra#3664): the ceilings catch core rot; a pinned
// pack's own modules are walked and reported, never counted against a route. ---
const analysis = (core, ext, extra = {}) => ({
  ok: true,
  moduleCount: core + ext,
  coreModuleCount: core,
  extensionModuleCount: ext,
  missingCount: 0,
  ...extra,
});

test("the ratchet measures the core count and reports what it leaves out", () => {
  assert.deepEqual(gate.ratchetMeasurement(analysis(100, 20)), {
    ok: true,
    moduleCount: 100,
    missingCount: 0,
    excludedExtensionModules: 20,
    excludedPackReachedCoreModules: 0,
    packReachedCoreModulesByPack: {},
  });
});

// The base the committed baseline is checked against: the gate's own base when
// it is set, else the pull request's base branch, else main. Fails closed when
// the base does not resolve.
function readBaseBaseline() {
  const ref = process.env.ROUTE_GRAPH_RATCHET_BASE || `origin/${process.env.GITHUB_BASE_REF || "main"}`;
  assert.ok(!ref.startsWith("-"), `the base ${ref} is flag-like`);
  const resolved = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(resolved.status, 0, `the base ${ref} did not resolve: fetch it, the committed absorb records are checked against it`);
  const shown = spawnSync("git", ["show", `${ref}:scripts/audit/route-graph-ratchet.baseline.json`], { cwd: REPO_ROOT, encoding: "utf8" });
  return { ref, baseline: shown.status === 0 ? JSON.parse(shown.stdout) : null };
}

const errorLines = (errors) => errors.map((e) => `${e.route} [${e.field}]: ${e.reason}`).join("; ");

test("the committed baseline's absorb records validate strictly against the base, and the core-only metric holds", () => {
  const committed = JSON.parse(readFileSync(join(HERE, "..", "route-graph-ratchet.baseline.json"), "utf8"));
  const { ref, baseline: base } = readBaseBaseline();
  const errors = gate.validateCommittedAbsorbs(base, committed);
  assert.deepEqual(errors, [], `committed absorb records vs ${ref}: ${errorLines(errors)}`);
  for (const { route, entry } of FIXED_ROUTES) {
    const m = gate.ratchetMeasurement(analyzeRoute(entry));
    assert.ok(m.ok, `route entry must resolve and its walk must reconcile: ${route} (${entry})`);
    assert.equal(m.missingCount, 0, `route ${route} has ${m.missingCount} unresolved first-party import(s)`);
    assert.ok(m.moduleCount <= committed.routes[route], `route ${route} core count ${m.moduleCount} is over its ceiling ${committed.routes[route]}`);
    assert.ok(Number.isInteger(m.excludedExtensionModules) && m.excludedExtensionModules >= 0, `route ${route} reports its excluded pack modules`);
    assert.ok(Number.isInteger(m.excludedPackReachedCoreModules) && m.excludedPackReachedCoreModules >= 0, `route ${route} reports its pack-reached core modules`);
  }
});

// --- The committed baseline may carry absorb records (cinatra#3669): each is
// validated strictly against the base, and a failing record names the route
// and the field. ---
const fields = (errors) => errors.map((e) => [e.route, e.field]);

test("a committed baseline with a valid absorb record passes the strict check, raised and carried forward", () => {
  const base = { routes: { "/a": 100, "/b": 50 } };
  const committed = { routes: { "/a": 110, "/b": 50 }, absorbs: { "/a": rec(100, 110) } };
  assert.deepEqual(gate.validateCommittedAbsorbs(base, committed), []);
  // After the merge the base carries the same record: carried forward, still valid.
  assert.deepEqual(gate.validateCommittedAbsorbs(committed, committed), []);
  // Own growth on several routes at once: one record per raised route.
  const wide = { routes: { "/a": 110, "/b": 60 }, absorbs: { "/a": rec(100, 110), "/b": rec(50, 60) } };
  assert.deepEqual(gate.validateCommittedAbsorbs(base, wide), []);
});

test("the existing baseline without records still passes the strict check", () => {
  const base = { routes: { "/a": 100, "/b": 50 } };
  assert.deepEqual(gate.validateCommittedAbsorbs(base, { routes: { "/a": 100, "/b": 50 } }), []);
  assert.deepEqual(gate.validateCommittedAbsorbs(base, { routes: { "/a": 90, "/b": 50 } }), []);
  assert.deepEqual(gate.validateCommittedAbsorbs(null, { routes: { "/a": 100 } }), []);
});

test("a record with a wrong from fails naming the route and the field", () => {
  const base = { routes: { "/a": 100 } };
  const errors = gate.validateCommittedAbsorbs(base, { routes: { "/a": 110 }, absorbs: { "/a": rec(95, 110) } });
  assert.deepEqual(fields(errors), [["/a", "from"]], errorLines(errors));
  assert.match(errors[0].reason, /does not exactly match/);
  assert.match(errors[0].reason, /base ceiling \(100\)/);
});

test("a record with a missing or malformed pr fails naming the route and the field", () => {
  const base = { routes: { "/a": 100 } };
  const { pr, ...withoutPr } = rec(100, 110);
  assert.equal(pr, 999);
  let errors = gate.validateCommittedAbsorbs(base, { routes: { "/a": 110 }, absorbs: { "/a": withoutPr } });
  assert.deepEqual(fields(errors), [["/a", "pr"]], errorLines(errors));
  assert.match(errors[0].reason, /missing/);
  for (const bad of [-1, 1.5, "12", null]) {
    errors = gate.validateCommittedAbsorbs(base, { routes: { "/a": 110 }, absorbs: { "/a": rec(100, 110, { pr: bad }) } });
    assert.deepEqual(fields(errors), [["/a", "pr"]], `pr ${JSON.stringify(bad)}: ${errorLines(errors)}`);
  }
  // A blank reason and an unknown key name their fields as well.
  errors = gate.validateCommittedAbsorbs(base, { routes: { "/a": 110 }, absorbs: { "/a": rec(100, 110, { reason: " " }) } });
  assert.deepEqual(fields(errors), [["/a", "reason"]], errorLines(errors));
  errors = gate.validateCommittedAbsorbs(base, { routes: { "/a": 110 }, absorbs: { "/a": rec(100, 110, { note: "x" }) } });
  assert.deepEqual(fields(errors), [["/a", "note"]], errorLines(errors));
});

test("a stale record fails naming the route and the field", () => {
  const base = { routes: { "/a": 100, "/b": 50 } };
  // from == to documents no raise.
  let errors = gate.validateCommittedAbsorbs(base, { routes: { "/a": 100, "/b": 50 }, absorbs: { "/a": rec(100, 100) } });
  assert.deepEqual(fields(errors), [["/a", "to"]], errorLines(errors));
  assert.match(errors[0].reason, /stale/);
  // A ceiling the baseline no longer carries.
  errors = gate.validateCommittedAbsorbs(base, { routes: { "/b": 50 }, absorbs: { "/a": rec(100, 110) } });
  assert.deepEqual(fields(errors), [["/a", "route"]], errorLines(errors));
  assert.match(errors[0].reason, /not tracked/);
  // A "to" that is not the committed ceiling.
  errors = gate.validateCommittedAbsorbs(base, { routes: { "/a": 105, "/b": 50 }, absorbs: { "/a": rec(100, 110) } });
  assert.deepEqual(fields(errors), [["/a", "to"]], errorLines(errors));
  assert.match(errors[0].reason, /stale/);
});

test("an orphaned record fails naming the route and the field", () => {
  const base = { routes: { "/a": 100, "/b": 50 } };
  // The ceiling did not move.
  let errors = gate.validateCommittedAbsorbs(base, { routes: { "/a": 100, "/b": 50 }, absorbs: { "/a": rec(90, 100) } });
  assert.deepEqual(fields(errors), [["/a", "from"]], errorLines(errors));
  assert.match(errors[0].reason, /orphan/);
  // A net-new route needs no record.
  errors = gate.validateCommittedAbsorbs(base, { routes: { "/a": 100, "/b": 50, "/c": 10 }, absorbs: { "/c": rec(5, 10) } });
  assert.deepEqual(fields(errors), [["/c", "route"]], errorLines(errors));
  assert.match(errors[0].reason, /orphan/);
  // A raised ceiling without its record names the missing record.
  errors = gate.validateCommittedAbsorbs(base, { routes: { "/a": 110, "/b": 50 } });
  assert.deepEqual(fields(errors), [["/a", "absorbs"]], errorLines(errors));
  assert.match(errors[0].reason, /NO absorb record/);
});

test("the gate names the route and the field of a failing committed record", () => {
  const tree = mkdtempSync(join(tmpdir(), "route-graph-ratchet-3669-"));
  try {
    mkdirSync(join(tree, "scripts", "audit"), { recursive: true });
    const { pr, ...withoutPr } = rec(164, 170);
    assert.equal(pr, 999);
    writeFileSync(
      join(tree, "scripts", "audit", "route-graph-ratchet.baseline.json"),
      JSON.stringify({ routes: { "/sign-in": 170 }, absorbs: { "/sign-in": withoutPr } }),
    );
    const run = spawnSync(process.execPath, [join(HERE, "..", "route-graph-ratchet.mjs")], {
      cwd: tree,
      encoding: "utf8",
      env: { ...process.env, ROUTE_GRAPH_RATCHET_BASE: "" },
    });
    assert.equal(run.status, 1, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
    assert.match(run.stderr, /\/sign-in \[pr\]: .*missing/);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("an extension module reachable from a tracked route is not counted; a core module still is; a raise of a core count without a record still fails", () => {
  const baseline = { routes: { "/r": 100 } };
  // Growth inside the extension tree only: the route stays within its ceiling.
  for (const ext of [20, 45]) {
    const res = diffAgainstBaseline(new Map([["/r", gate.ratchetMeasurement(analysis(100, ext))]]), baseline);
    assert.deepEqual(res.over, []);
    assert.deepEqual(res.broken, []);
  }
  // One more CORE module is over by one.
  const res = diffAgainstBaseline(new Map([["/r", gate.ratchetMeasurement(analysis(101, 45))]]), baseline);
  assert.deepEqual(res.broken, []);
  assert.deepEqual(res.over, [{ route: "/r", count: 101, ceiling: 100, delta: 1 }]);
  // Raising that core ceiling without a record is still a silent raise.
  const { violations, absorbed } = classifyRaises(baseline, { routes: { "/r": 101 } });
  assert.deepEqual(absorbed, []);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].route, "/r");
  assert.match(violations[0].reason, /NO absorb record/);
});

test("no tracked route is dropped; missing imports and an unresolved base ref still fail closed", () => {
  assert.deepEqual(FIXED_ROUTES, [
    { route: "/sign-in", entry: "src/app/sign-in/page.tsx" },
    { route: "/api/mcp", entry: "src/app/api/mcp/route.ts" },
    { route: "/chat", entry: "src/app/chat/[[...slug]]/page.tsx" },
    { route: "/api/a2a", entry: "src/app/api/a2a/route.ts" },
    { route: "/api/llm-bridge", entry: "src/app/api/llm-bridge/route.ts" },
  ]);
  const gateRun = spawnSync(process.execPath, [join(HERE, "..", "route-graph-ratchet.mjs")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ROUTE_GRAPH_RATCHET_BASE: "refs/heads/no-such-base-3664" },
  });
  assert.equal(gateRun.status, 1, `stdout: ${gateRun.stdout}\nstderr: ${gateRun.stderr}`);
  assert.match(gateRun.stderr, /did not resolve/);

  const ceiling = { routes: { "/r": 100 } };
  let res = diffAgainstBaseline(new Map([["/r", gate.ratchetMeasurement(analysis(50, 10, { missingCount: 7 }))]]), ceiling);
  assert.deepEqual(res.over, []);
  assert.equal(res.broken.length, 1);
  assert.match(res.broken[0].reason, /unresolved/i);
  res = diffAgainstBaseline(new Map([["/r", gate.ratchetMeasurement({ ok: false })]]), ceiling);
  assert.deepEqual(res.over, []);
  assert.equal(res.broken.length, 1);
  assert.equal(res.broken[0].route, "/r");
});

// --- Pack reach (cinatra#3669): a core module the walk reaches only through a
// pinned pack's modules is that pack's cost. It is counted for the pack and
// stays out of the ceiling; a core module the route reaches through core
// modules counts exactly as before. Fixture graphs: a route entry and its
// first-party edges (module -> the modules it imports). ---
const ENTRY = "src/app/r/page.tsx";
const walk = (edges) => ({ ok: true, missingCount: 0, ...routeGraph.attributeRouteWalk(ENTRY, edges) });
const measure = (edges) => gate.ratchetMeasurement(walk(edges));

// Main before the pin advance: the route reaches the generated map, which
// reaches pack A; pack A imports no core module.
const G0 = {
  [ENTRY]: ["src/lib/own.ts", "src/lib/generated/extensions.server.ts"],
  "src/lib/generated/extensions.server.ts": ["extensions/acme/pack-a/src/index.ts"],
  "extensions/acme/pack-a/src/index.ts": ["extensions/acme/pack-a/src/view.ts"],
};
// The pin advance: pack A's new version imports a core channel module, which
// imports a further core module.
const G1 = {
  ...G0,
  "extensions/acme/pack-a/src/view.ts": ["packages/kit/src/channel.ts"],
  "packages/kit/src/channel.ts": ["packages/kit/src/wire.ts"],
};

test("pack reach (1): a core module reached only through a pack edge does not raise the ceiling and appears in that pack's reading", () => {
  const before = walk(G0);
  const after = walk(G1);
  assert.equal(before.coreModuleCount, 3);
  assert.equal(after.coreModuleCount, 3);
  assert.equal(after.moduleCount, 7);
  assert.equal(after.packReachedCoreModuleCount, 2);
  assert.deepEqual(after.packReachedCoreModules, { "@acme/pack-a": ["packages/kit/src/channel.ts", "packages/kit/src/wire.ts"] });
  const m = gate.ratchetMeasurement(after);
  assert.equal(m.ok, true);
  assert.equal(m.moduleCount, 3);
  assert.equal(m.excludedPackReachedCoreModules, 2);
  assert.deepEqual(m.packReachedCoreModulesByPack, { "@acme/pack-a": 2 });
  assert.equal(gate.packReachReading(m), "reached through @acme/pack-a: 2 core modules");
  assert.deepEqual(diffAgainstBaseline(new Map([["/r", m]]), { routes: { "/r": 3 } }), { over: [], broken: [] });
});

test("pack reach (2): the same module reached through a core edge as well raises the ceiling", () => {
  const G2 = { ...G1, [ENTRY]: [...G1[ENTRY], "packages/kit/src/channel.ts"] };
  const a = walk(G2);
  assert.equal(a.coreModuleCount, 5);
  assert.equal(a.packReachedCoreModuleCount, 0);
  assert.deepEqual(a.packReachedCoreModules, {});
  const m = gate.ratchetMeasurement(a);
  assert.equal(gate.packReachReading(m), "");
  const res = diffAgainstBaseline(new Map([["/r", m]]), { routes: { "/r": 3 } });
  assert.deepEqual(res.broken, []);
  assert.deepEqual(res.over, [{ route: "/r", count: 5, ceiling: 3, delta: 2 }]);
});

test("pack reach (3): a pin advance that adds a pack-only-reached core module passes with no absorb record", () => {
  const base = { routes: { "/r": measure(G0).moduleCount } };
  // The regenerated ceiling after the pin advance is the base's: nothing to absorb.
  const after = measure(G1);
  const committed = { routes: { "/r": after.moduleCount } };
  assert.deepEqual(committed, base);
  assert.deepEqual(classifyRaises(base, committed), { violations: [], absorbed: [] });
  assert.deepEqual(gate.validateCommittedAbsorbs(base, committed), []);
  assert.deepEqual(diffAgainstBaseline(new Map([["/r", after]]), committed), { over: [], broken: [] });
});

test("pack reach (4): a route that imports a new core module directly still needs its record", () => {
  const G3 = { ...G1, [ENTRY]: [...G1[ENTRY], "src/lib/new-own.ts"] };
  const m = measure(G3);
  assert.equal(m.moduleCount, 4);
  const base = { routes: { "/r": 3 } };
  assert.deepEqual(diffAgainstBaseline(new Map([["/r", m]]), base).over, [{ route: "/r", count: 4, ceiling: 3, delta: 1 }]);
  // Raising the ceiling without a record is a silent raise.
  const silent = classifyRaises(base, { routes: { "/r": 4 } });
  assert.deepEqual(silent.absorbed, []);
  assert.equal(silent.violations.length, 1);
  assert.match(silent.violations[0].reason, /NO absorb record/);
  assert.deepEqual(fields(gate.validateCommittedAbsorbs(base, { routes: { "/r": 4 } })), [["/r", "absorbs"]]);
  // With its record the raise is absorbed and the committed baseline validates.
  const committed = { routes: { "/r": 4 }, absorbs: { "/r": rec(3, 4) } };
  const annotated = classifyRaises(base, committed);
  assert.deepEqual(annotated.violations, []);
  assert.equal(annotated.absorbed.length, 1);
  assert.deepEqual(gate.validateCommittedAbsorbs(base, committed), []);
  assert.deepEqual(diffAgainstBaseline(new Map([["/r", m]]), committed), { over: [], broken: [] });
});

test("pack reach (5): the excluded count and the per-pack readings reconcile with the total walk", () => {
  const G5 = {
    [ENTRY]: ["src/lib/own.ts", "src/lib/generated/extensions.server.ts", "packages/kit/src/both.ts"],
    "src/lib/generated/extensions.server.ts": ["extensions/acme/pack-a/src/index.ts", "extensions/acme/pack-b/src/index.ts"],
    // pack A reaches a module pack B reaches too, one of its own, and a core module the route imports itself
    "extensions/acme/pack-a/src/index.ts": ["packages/kit/src/shared.ts", "packages/kit/src/only-a.ts", "packages/kit/src/both.ts"],
    "extensions/acme/pack-b/src/index.ts": ["packages/kit/src/shared.ts"],
    // a pack-reached core module that imports pack C: what pack C imports is pack C's
    "packages/kit/src/only-a.ts": ["extensions/acme/pack-c/src/index.ts"],
    "extensions/acme/pack-c/src/index.ts": ["packages/kit/src/after-c.ts"],
    "packages/kit/src/both.ts": ["packages/kit/src/both-dep.ts"],
  };
  const a = walk(G5);
  assert.equal(a.moduleCount, 11);
  assert.equal(a.coreModuleCount, 5);
  assert.equal(a.extensionModuleCount, 3);
  assert.deepEqual(a.extensionModulesByPack, { "@acme/pack-a": 1, "@acme/pack-b": 1, "@acme/pack-c": 1 });
  assert.equal(a.packReachedCoreModuleCount, 3);
  assert.deepEqual(a.packReachedCoreModules, {
    "@acme/pack-a": ["packages/kit/src/only-a.ts", "packages/kit/src/shared.ts"],
    "@acme/pack-b": ["packages/kit/src/shared.ts"],
    "@acme/pack-c": ["packages/kit/src/after-c.ts"],
  });
  // The three parts add up to the walk, and the per-pack readings cover exactly the pack-reached part.
  assert.equal(a.coreModuleCount + a.extensionModuleCount + a.packReachedCoreModuleCount, a.moduleCount);
  assert.equal(Object.values(a.extensionModulesByPack).reduce((x, y) => x + y, 0), a.extensionModuleCount);
  assert.equal(new Set(Object.values(a.packReachedCoreModules).flat()).size, a.packReachedCoreModuleCount);
  const m = gate.ratchetMeasurement(a);
  assert.equal(m.ok, true);
  assert.equal(m.moduleCount, 5);
  assert.equal(m.excludedExtensionModules, 3);
  assert.equal(m.excludedPackReachedCoreModules, 3);
  assert.deepEqual(m.packReachedCoreModulesByPack, { "@acme/pack-a": 2, "@acme/pack-b": 1, "@acme/pack-c": 1 });
  assert.equal(
    gate.packReachReading(m),
    "reached through @acme/pack-a: 2 core modules, reached through @acme/pack-b: 1 core module, reached through @acme/pack-c: 1 core module",
  );
  // A walk whose parts do not add up is not measured: the route is broken, never under its ceiling.
  const tampered = gate.ratchetMeasurement({ ...a, coreModuleCount: a.coreModuleCount - 1 });
  assert.equal(tampered.ok, false);
  const res = diffAgainstBaseline(new Map([["/r", tampered]]), { routes: { "/r": 100 } });
  assert.deepEqual(res.over, []);
  assert.equal(res.broken.length, 1);
  assert.match(res.broken[0].reason, /does not reconcile/);
});

test("pack reach: the gate prints each distinct per-pack reading once, beside the routes that share it", () => {
  const shared = measure(G1);
  const counts = new Map([
    ["/a", shared],
    ["/b", measure(G0)],
    ["/c", shared],
    ["/d", gate.ratchetMeasurement({ ok: false })],
  ]);
  assert.deepEqual(gate.packReachLines(counts, ["/a", "/b", "/c", "/d"]), [
    "pack-reached core modules on /a, /c: reached through @acme/pack-a: 2 core modules",
  ]);
  assert.deepEqual(gate.packReachLines(new Map([["/b", measure(G0)]]), ["/b"]), []);
});
