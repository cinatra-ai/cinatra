// Parser + gate tests for merge-group-gate-coverage (engineering#484).
//
// Uses node's built-in test runner (`node --test`) + `node:assert`, matching
// the actions-pinned-gate.mjs convention — zero `pnpm install` needed.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REQUIRED_GATE_CALLERS,
  extractOnBlock,
  declaresMergeGroup,
  checkFile,
  runGate,
} from "../merge-group-gate-coverage.mjs";

// --------------------------------------------------------------------------
// extractOnBlock

test("extractOnBlock: multi-line block form", () => {
  const text = [
    "name: foo",
    "",
    "on:",
    "  pull_request:",
    "  push:",
    "    branches: [main]",
    "  merge_group:",
    "",
    "permissions:",
    "  contents: read",
    "",
  ].join("\n");
  const block = extractOnBlock(text);
  assert.match(block, /merge_group:/);
  assert.match(block, /pull_request:/);
  // Must not bleed into the next top-level key's body.
  assert.doesNotMatch(block, /contents: read/);
});

test("extractOnBlock: inline single-line form", () => {
  const text = "name: foo\n\non: [push, pull_request, merge_group]\n\njobs:\n  x:\n    runs-on: ubuntu-latest\n";
  const block = extractOnBlock(text);
  assert.equal(block, "[push, pull_request, merge_group]");
});

test("extractOnBlock: returns null when there is no top-level `on:` key", () => {
  const text = "name: foo\n\njobs:\n  x:\n    runs-on: ubuntu-latest\n";
  assert.equal(extractOnBlock(text), null);
});

test("extractOnBlock: does not match a nested `on:`-looking key inside a job (only the top-level on:)", () => {
  // A pathological workflow with a `run:` block mentioning "on:" should never
  // be picked up as the top-level trigger block — extractOnBlock only scans
  // from the FIRST top-level `on:` line, so this is really just confirming
  // the block correctly stops at the next top-level key (jobs:) even when
  // step bodies mention arbitrary text.
  const text = [
    "name: foo",
    "",
    "on:",
    "  pull_request:",
    "",
    "jobs:",
    "  x:",
    "    steps:",
    "      - run: |",
    "          echo 'on: merge_group is not a real trigger here'",
    "",
  ].join("\n");
  const block = extractOnBlock(text);
  assert.doesNotMatch(block, /jobs:/);
  assert.doesNotMatch(block, /echo/);
});

// --------------------------------------------------------------------------
// declaresMergeGroup

test("declaresMergeGroup: bare key on its own line", () => {
  assert.ok(declaresMergeGroup("  pull_request:\n  merge_group:\n  push:\n"));
});

test("declaresMergeGroup: present in an inline event list", () => {
  assert.ok(declaresMergeGroup("[push, pull_request, merge_group]"));
});

test("declaresMergeGroup: absent", () => {
  assert.ok(!declaresMergeGroup("  pull_request:\n  push:\n    branches: [main]\n"));
});

test("declaresMergeGroup: null block (no `on:` key) is not a match", () => {
  assert.ok(!declaresMergeGroup(null));
});

test("declaresMergeGroup: does not false-positive on a substring like `merge_group_id`", () => {
  assert.ok(!declaresMergeGroup("  merge_group_id_lookup:\n"));
});

// codex-converge MEDIUM: a commented-out trigger line, or a real trigger's
// trailing comment merely MENTIONING merge_group, must not satisfy the
// guard — only a real, uncommented `merge_group:` key (or list item) should.
test("declaresMergeGroup: a commented-out `# merge_group:` line does NOT count", () => {
  assert.ok(!declaresMergeGroup("  pull_request:\n  # merge_group:\n  push:\n    branches: [main]\n"));
});

test("declaresMergeGroup: a trailing comment merely mentioning merge_group does NOT count", () => {
  assert.ok(!declaresMergeGroup("  pull_request: # merge_group added later\n  push:\n"));
});

test("declaresMergeGroup: a real trigger with an innocuous trailing comment still counts", () => {
  assert.ok(declaresMergeGroup("  pull_request:\n  merge_group: # required for merge queue\n"));
});

// --------------------------------------------------------------------------
// checkFile / runGate — fail-closed behavior over an injected file reader

function fakeReader(files) {
  return (path) => {
    if (!(path in files)) {
      const err = new Error(`ENOENT: no such file, open '${path}'`);
      err.code = "ENOENT";
      throw err;
    }
    return files[path];
  };
}

test("checkFile: passes when merge_group is declared", () => {
  const files = {
    "x.yml": "name: x\n\non:\n  pull_request:\n  merge_group:\n\njobs:\n  x:\n    runs-on: ubuntu-latest\n",
  };
  const r = checkFile("x.yml", fakeReader(files));
  assert.deepEqual(r, { path: "x.yml", ok: true });
});

test("checkFile: fails closed when merge_group is missing", () => {
  const files = {
    "x.yml": "name: x\n\non:\n  pull_request:\n  push:\n    branches: [main]\n\njobs:\n  x:\n    runs-on: ubuntu-latest\n",
  };
  const r = checkFile("x.yml", fakeReader(files));
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not declare a `merge_group` trigger/);
});

test("checkFile: fails closed when the file cannot be read (missing/renamed caller)", () => {
  const r = checkFile("does-not-exist.yml", fakeReader({}));
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not read file/);
});

test("checkFile: fails closed when the workflow has no top-level `on:` key at all", () => {
  const files = { "x.yml": "name: x\n\njobs:\n  x:\n    runs-on: ubuntu-latest\n" };
  const r = checkFile("x.yml", fakeReader(files));
  assert.equal(r.ok, false);
  assert.match(r.reason, /no top-level `on:` key/);
});

test("runGate: reports one result per required caller, in order", () => {
  const files = {
    "a.yml": "on:\n  merge_group:\n",
    "b.yml": "on:\n  pull_request:\n",
  };
  const results = runGate(["a.yml", "b.yml"], fakeReader(files));
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
});

// --------------------------------------------------------------------------
// Live check — the actual 5 required-gate caller files in THIS repo (the
// real regression this gate exists to prevent). Reads real files via the
// default node:fs reader (no injected reader), from the repo root.

test("LIVE: every REQUIRED_GATE_CALLERS entry in this repo declares merge_group", () => {
  const results = runGate();
  const failures = results.filter((r) => !r.ok);
  assert.deepEqual(
    failures,
    [],
    `expected all required gate callers to declare merge_group, but: ${JSON.stringify(failures)}`,
  );
  assert.equal(results.length, REQUIRED_GATE_CALLERS.length);
});
