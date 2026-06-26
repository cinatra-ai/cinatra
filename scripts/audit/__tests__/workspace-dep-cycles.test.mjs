// Workspace dependency-cycle gate — unit tests for the pure helpers.
// Zero-dep (node:test) to match the gate (a .mjs gate can't import .ts deps).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseWorkspaceGlobs,
  cycleKey,
  buildGraph,
  tarjanSCC,
  detectCycles,
  diffAgainstBaseline,
  baselineGrowth,
} from "../workspace-dep-cycles.mjs";

test("parseWorkspaceGlobs extracts the packages list and stops at the next key", () => {
  const yaml = [
    "packages:",
    '  - "packages/*"',
    "  - extensions/cinatra-ai/*-connector",
    "  # a comment line is ignored",
    '  - "extensions/*/*-workflow" # trailing comment',
    "overrides:",
    '  - "should-not-appear"',
  ].join("\n");
  assert.deepEqual(parseWorkspaceGlobs(yaml), [
    "packages/*",
    "extensions/cinatra-ai/*-connector",
    "extensions/*/*-workflow",
  ]);
});

test("cycleKey is rotation/order invariant", () => {
  assert.equal(cycleKey(["@x/b", "@x/a"]), cycleKey(["@x/a", "@x/b"]));
  assert.equal(cycleKey(["@x/c", "@x/a", "@x/b"]), "@x/a <-> @x/b <-> @x/c");
});

test("buildGraph keeps member edges (incl. a self-edge) and drops external deps", () => {
  const graph = buildGraph([
    { name: "@x/a", deps: new Set(["@x/b", "react", "@x/a"]) },
    { name: "@x/b", deps: new Set(["@x/a"]) },
    { name: "@x/c", deps: new Set(["lodash"]) },
  ]);
  assert.deepEqual(graph.get("@x/a"), ["@x/a", "@x/b"]); // react (external) dropped; self-edge RETAINED (degenerate cycle)
  assert.deepEqual(graph.get("@x/b"), ["@x/a"]);
  assert.deepEqual(graph.get("@x/c"), []); // external-only
});

test("detectCycles flags a self-dependency declared in package.json (via buildGraph)", () => {
  const graph = buildGraph([{ name: "@x/a", deps: new Set(["@x/a"]) }]);
  const cycles = detectCycles(graph);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].members, ["@x/a"]);
});

test("tarjanSCC groups a mutually-dependent set; singletons stay singletons", () => {
  const graph = new Map([
    ["@x/a", ["@x/b"]],
    ["@x/b", ["@x/a"]],
    ["@x/c", ["@x/a"]], // depends in but not part of the cycle
    ["@x/d", []],
  ]);
  const sccs = tarjanSCC(graph).map((c) => [...c].sort());
  // find the 2-member SCC
  const big = sccs.find((c) => c.length === 2);
  assert.deepEqual(big, ["@x/a", "@x/b"]);
  // c and d are their own singletons
  assert.ok(sccs.some((c) => c.length === 1 && c[0] === "@x/c"));
  assert.ok(sccs.some((c) => c.length === 1 && c[0] === "@x/d"));
});

test("detectCycles finds a 2-cycle", () => {
  const graph = buildGraph([
    { name: "@x/a", deps: new Set(["@x/b"]) },
    { name: "@x/b", deps: new Set(["@x/a"]) },
    { name: "@x/solo", deps: new Set([]) },
  ]);
  const cycles = detectCycles(graph);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].members, ["@x/a", "@x/b"]);
  assert.equal(cycles[0].key, "@x/a <-> @x/b");
});

test("detectCycles finds a DEEP cycle A->B->C->A (not just adjacent pairs)", () => {
  const graph = buildGraph([
    { name: "@x/a", deps: new Set(["@x/b"]) },
    { name: "@x/b", deps: new Set(["@x/c"]) },
    { name: "@x/c", deps: new Set(["@x/a"]) },
  ]);
  const cycles = detectCycles(graph);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].members, ["@x/a", "@x/b", "@x/c"]);
});

test("detectCycles is clean for a one-directional (acyclic) graph", () => {
  // The post-extraction metric shape: usage -> cost -> contracts ; usage -> contracts
  const graph = buildGraph([
    { name: "@x/usage", deps: new Set(["@x/cost", "@x/contracts"]) },
    { name: "@x/cost", deps: new Set(["@x/contracts"]) },
    { name: "@x/contracts", deps: new Set([]) },
  ]);
  assert.deepEqual(detectCycles(graph), []);
});

test("detectCycles flags a degenerate self-loop", () => {
  // self-dep is normally dropped by buildGraph, but detect on a raw graph
  const cycles = detectCycles(new Map([["@x/a", ["@x/a"]]]));
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].members, ["@x/a"]);
});

test("diffAgainstBaseline reports only NEW cycles by key", () => {
  const cycles = [
    { key: "@x/a <-> @x/b", members: ["@x/a", "@x/b"] }, // baselined
    { key: "@x/c <-> @x/d", members: ["@x/c", "@x/d"] }, // new
  ];
  const baseline = { cycles: [{ key: "@x/a <-> @x/b" }] };
  const out = diffAgainstBaseline(cycles, baseline);
  assert.deepEqual(out.map((c) => c.key), ["@x/c <-> @x/d"]);
});

test("diffAgainstBaseline is clean when every cycle is baselined", () => {
  const cycles = [{ key: "@x/a <-> @x/b", members: ["@x/a", "@x/b"] }];
  const baseline = { cycles: [{ key: "@x/a <-> @x/b" }, { key: "@x/e <-> @x/f" }] };
  assert.deepEqual(diffAgainstBaseline(cycles, baseline), []);
});

test("diffAgainstBaseline treats a missing baseline as all-new", () => {
  const cycles = [{ key: "@x/a <-> @x/b", members: ["@x/a", "@x/b"] }];
  assert.deepEqual(diffAgainstBaseline(cycles, { cycles: [] }).map((c) => c.key), ["@x/a <-> @x/b"]);
});

test("baselineGrowth flags cycles added to the committed baseline vs the base branch", () => {
  const base = { cycles: [{ key: "@x/a <-> @x/b" }] };
  const committed = { cycles: [{ key: "@x/a <-> @x/b" }, { key: "@x/c <-> @x/d" }] }; // grew
  assert.deepEqual(baselineGrowth(base, committed), ["@x/c <-> @x/d"]);
});

test("baselineGrowth is empty when the committed baseline only shrinks", () => {
  const base = { cycles: [{ key: "@x/a <-> @x/b" }, { key: "@x/c <-> @x/d" }] };
  const committed = { cycles: [{ key: "@x/a <-> @x/b" }] }; // c<->d broken
  assert.deepEqual(baselineGrowth(base, committed), []);
});

// --- End-to-end fixture: the 3 baselined cycles PASS; a NEW cycle FAILS. ---
// Mirrors the real workspace shape (three independent 2-cycles) plus a fourth
// synthetic pair to prove the gate is fail-closed on a genuinely new cycle while
// the baselined three are clean.
test("FIXTURE: baselined cycles pass and a new cycle is caught", () => {
  const members = [
    // baselined cycle 1
    { name: "@cinatra-ai/metric-usage-api", deps: new Set(["@cinatra-ai/metric-cost-api"]) },
    { name: "@cinatra-ai/metric-cost-api", deps: new Set(["@cinatra-ai/metric-usage-api"]) },
    // baselined cycle 2
    { name: "@cinatra-ai/llm", deps: new Set(["@cinatra-ai/skills"]) },
    { name: "@cinatra-ai/skills", deps: new Set(["@cinatra-ai/llm"]) },
    // baselined cycle 3
    { name: "@cinatra-ai/agents", deps: new Set(["@cinatra-ai/a2a"]) },
    { name: "@cinatra-ai/a2a", deps: new Set(["@cinatra-ai/agents"]) },
    // a NEW cycle not in the baseline
    { name: "@cinatra-ai/errors", deps: new Set(["@cinatra-ai/registries"]) },
    { name: "@cinatra-ai/registries", deps: new Set(["@cinatra-ai/errors"]) },
  ];
  const baseline = {
    cycles: [
      { key: "@cinatra-ai/a2a <-> @cinatra-ai/agents" },
      { key: "@cinatra-ai/llm <-> @cinatra-ai/skills" },
      { key: "@cinatra-ai/metric-cost-api <-> @cinatra-ai/metric-usage-api" },
    ],
  };
  const cycles = detectCycles(buildGraph(members));
  assert.equal(cycles.length, 4);
  const fresh = diffAgainstBaseline(cycles, baseline);
  assert.deepEqual(fresh.map((c) => c.key), ["@cinatra-ai/errors <-> @cinatra-ai/registries"]);
});

// --- End-to-end fixture: after the metric-contracts extraction the metric pair
// is acyclic, so dropping it from the baseline leaves the baseline non-growing
// and the gate clean for that set. ---
test("FIXTURE: post-extraction metric set is acyclic and clean against a lowered baseline", () => {
  const members = [
    { name: "@cinatra-ai/metric-usage-api", deps: new Set(["@cinatra-ai/metric-cost-api", "@cinatra-ai/metric-contracts"]) },
    { name: "@cinatra-ai/metric-cost-api", deps: new Set(["@cinatra-ai/metric-contracts"]) },
    { name: "@cinatra-ai/metric-contracts", deps: new Set([]) },
  ];
  assert.deepEqual(detectCycles(buildGraph(members)), []);
});
