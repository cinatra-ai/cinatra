// File-size ratchet gate — unit tests for the pure helpers (eng#308).
// Zero-dep (node:test) to match the gate (a .mjs gate can't import .ts deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  countLines,
  diffAgainstBaseline,
  baselineGrowth,
  TRACKED_FILES,
} from "../file-size-ratchet.mjs";

const REPO_ROOT = process.cwd();
const HERE = fileURLToPath(new URL(".", import.meta.url));

test("countLines: empty file is 0 lines", () => {
  assert.equal(countLines(""), 0);
});

test("countLines: trailing newline is a terminator, not an extra line", () => {
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a\nb\nc\n"), 3);
});

test("countLines: a final unterminated line still counts", () => {
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a"), 1);
});

test("countLines: blank lines count", () => {
  assert.equal(countLines("\n\n\n"), 3); // three terminated empty lines
  assert.equal(countLines("a\n\nb\n"), 3);
});

test("diffAgainstBaseline: a file over its ceiling is a violation", () => {
  const sizes = new Map([["a.ts", 101]]);
  const { over, missing } = diffAgainstBaseline(sizes, { files: { "a.ts": 100 } });
  assert.equal(missing.length, 0);
  assert.deepEqual(over, [{ path: "a.ts", size: 101, ceiling: 100, delta: 1 }]);
});

test("diffAgainstBaseline: a file AT its ceiling is OK (ceiling is inclusive)", () => {
  const sizes = new Map([["a.ts", 100]]);
  const { over, missing } = diffAgainstBaseline(sizes, { files: { "a.ts": 100 } });
  assert.deepEqual(over, []);
  assert.deepEqual(missing, []);
});

test("diffAgainstBaseline: a file BELOW its ceiling is OK (a shrink is always allowed)", () => {
  const sizes = new Map([["a.ts", 50]]);
  const { over } = diffAgainstBaseline(sizes, { files: { "a.ts": 100 } });
  assert.deepEqual(over, []);
});

test("diffAgainstBaseline: a missing tracked file is a violation (rename must update baseline)", () => {
  const sizes = new Map([["a.ts", null]]);
  const { over, missing } = diffAgainstBaseline(sizes, { files: { "a.ts": 100 } });
  assert.deepEqual(over, []);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].path, "a.ts");
});

test("diffAgainstBaseline: a tracked file with no baseline ceiling is a violation (set/baseline drift)", () => {
  const sizes = new Map([["a.ts", 10]]);
  const { missing } = diffAgainstBaseline(sizes, { files: {} });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].path, "a.ts");
});

test("diffAgainstBaseline: multiple violations sort by path", () => {
  const sizes = new Map([
    ["z.ts", 200],
    ["a.ts", 200],
  ]);
  const { over } = diffAgainstBaseline(sizes, { files: { "z.ts": 100, "a.ts": 100 } });
  assert.deepEqual(over.map((o) => o.path), ["a.ts", "z.ts"]);
});

test("baselineGrowth: raising an existing file's ceiling is growth (regenerate-to-pass)", () => {
  const base = { files: { "a.ts": 100 } };
  const committed = { files: { "a.ts": 120 } }; // raised
  assert.deepEqual(baselineGrowth(base, committed), [{ path: "a.ts", base: 100, committed: 120 }]);
});

test("baselineGrowth: lowering a ceiling is NOT growth (the intended ratchet direction)", () => {
  const base = { files: { "a.ts": 100 } };
  const committed = { files: { "a.ts": 80 } }; // lowered after an extraction
  assert.deepEqual(baselineGrowth(base, committed), []);
});

test("baselineGrowth: keeping a ceiling equal is NOT growth", () => {
  const base = { files: { "a.ts": 100 } };
  const committed = { files: { "a.ts": 100 } };
  assert.deepEqual(baselineGrowth(base, committed), []);
});

test("baselineGrowth: adding a NET-NEW tracked file is NOT growth (expands coverage)", () => {
  const base = { files: { "a.ts": 100 } };
  const committed = { files: { "a.ts": 100, "b.ts": 500 } };
  assert.deepEqual(baselineGrowth(base, committed), []);
});

test("baselineGrowth: dropping a tracked file is allowed (file split out of existence)", () => {
  const base = { files: { "a.ts": 100, "b.ts": 500 } };
  const committed = { files: { "a.ts": 100 } }; // b removed
  assert.deepEqual(baselineGrowth(base, committed), []);
});

// --- End-to-end fixture: at-baseline passes; a +1 growth FAILS. ---
test("FIXTURE: at-baseline is clean and a one-line growth is caught", () => {
  const baseline = { files: { "x.ts": 10, "y.ts": 20 } };
  // at baseline → clean
  let res = diffAgainstBaseline(new Map([["x.ts", 10], ["y.ts", 20]]), baseline);
  assert.deepEqual(res.over, []);
  assert.deepEqual(res.missing, []);
  // x grows by 1 → caught; y untouched stays clean
  res = diffAgainstBaseline(new Map([["x.ts", 11], ["y.ts", 20]]), baseline);
  assert.deepEqual(res.over.map((o) => o.path), ["x.ts"]);
});

// --- Integration: the committed baseline tracks EXACTLY the TRACKED_FILES set,
// each entry maps to a real file, and the real file is at/below its ceiling.
// This is what makes the gate green on main and proves no set/baseline drift. ---
test("INTEGRATION: the committed baseline covers exactly TRACKED_FILES, each a real at-or-below-ceiling file", () => {
  const baselinePath = join(HERE, "..", "file-size-ratchet.baseline.json");
  assert.ok(existsSync(baselinePath), "baseline file must exist");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const baselineKeys = Object.keys(baseline.files).sort();
  assert.deepEqual(baselineKeys, [...TRACKED_FILES].sort(), "baseline keys must equal TRACKED_FILES exactly");
  for (const rel of TRACKED_FILES) {
    const abs = join(REPO_ROOT, rel);
    assert.ok(existsSync(abs), `tracked file must exist: ${rel}`);
    const actual = countLines(readFileSync(abs, "utf8"));
    const ceiling = baseline.files[rel];
    assert.ok(actual <= ceiling, `tracked file ${rel} is ${actual} lines, over the committed ceiling ${ceiling} — regenerate or shrink`);
  }
});
