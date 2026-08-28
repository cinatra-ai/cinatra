// The product tree hygiene gate (owner ruling 2026-08-28).
//
// Dependency-free (`node --test` + `node:assert`), like the exec-compose
// scoping gate: the gate itself must run without a `pnpm install`, and so must
// its tests — it guards the tracked tree in a pure-node CI job.
//
// Two halves:
//   - a CLEAN path list passes (the positive case that would otherwise rot
//     silently into a gate that fails everything or nothing);
//   - each rule CATCHES its example, and the two ANCHORING classes are pinned
//     in both directions — the nested product paths this repo really tracks
//     (`src/lib/data/x.ts`, `packages/extensions/**`) must NOT be caught, and
//     a nested `evidence/` MUST be, because that asymmetry is the whole design
//     and an allowlist is what we are refusing to have.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { ANY_DEPTH_DIRS, ROOT_DIRS, RULES, findHits } from "../product-tree-hygiene.mjs";

const GATE = fileURLToPath(new URL("../product-tree-hygiene.mjs", import.meta.url));
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Run the gate in --stdin mode over `paths`; returns { status, stdout, stderr }. */
function runGate(paths, extraArgs = []) {
  try {
    const stdout = execFileSync("node", [GATE, "--stdin", ...extraArgs], {
      cwd: REPO_ROOT,
      input: `${paths.join("\n")}\n`,
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

/** The rule id that catches `path`, or undefined. */
function ruleFor(path) {
  return findHits([path])[0]?.rule;
}

// ---------------------------------------------------------------------------
// A clean tree passes
// ---------------------------------------------------------------------------

const CLEAN = [
  "package.json",
  "README.md",
  "src/app/page.tsx",
  "src/lib/database.ts",
  "scripts/ci/product-tree-hygiene.mjs",
  "tests/e2e/config/design.config.ts",
  "tests/fixtures/agents/sample-manifest.json",
  "docs/internals/README.md",
  "config/upgrade/upgrade-matrix.json",
];

test("a clean tree passes", () => {
  assert.deepEqual(findHits(CLEAN), []);
});

test("a clean tree exits 0 through the CLI", () => {
  const { status, stdout } = runGate(CLEAN);
  assert.equal(status, 0);
  assert.match(stdout, /\[product-tree-hygiene\] OK/);
});

// ---------------------------------------------------------------------------
// Every rule catches its example
// ---------------------------------------------------------------------------

const EXAMPLES = [
  // any-depth directories — at the root AND nested.
  ["node_modules/lodash/index.js", "any-depth:node_modules/"],
  ["packages/x/node_modules/lodash/index.js", "any-depth:node_modules/"],
  [".next/build-manifest.json", "any-depth:.next/"],
  ["packages/x/.next/build-manifest.json", "any-depth:.next/"],
  [".pytest_cache/v/cache/lastfailed", "any-depth:.pytest_cache/"],
  ["docker/wayflow/.pytest_cache/CACHEDIR.TAG", "any-depth:.pytest_cache/"],
  ["__pycache__/mod.cpython-312.pyc", "any-depth:__pycache__/"],
  ["docker/wayflow/app/__pycache__/mod.pyc", "any-depth:__pycache__/"],
  [".claude/settings.json", "any-depth:.claude/"],
  ["packages/x/.claude/agents/lane.md", "any-depth:.claude/"],
  [".planning/ROADMAP.md", "any-depth:.planning/"],
  ["packages/x/.planning/PLAN.md", "any-depth:.planning/"],
  ["evidence/2824-s9k/capture.png", "any-depth:evidence/"],
  ["pr-evidence/1446/before.png", "any-depth:pr-evidence/"],
  // root-anchored directories.
  ["data/postgres/pg_wal/000000010000000000000001", "root:data/"],
  ["dev/cinatra-docs/README.md", "root:dev/"],
  ["extensions/cinatra-ai-wordpress/package.json", "root:extensions/"],
  ["test-results/chat-hitl-held-turn/trace.zip", "root:test-results/"],
  // root-anchored files.
  ["next-env.d.ts", "root:next-env.d.ts"],
  [".env.local", "root:.env.local"],
  [".env.production.local", "root:.env.*.local"],
  [".env.development.local", "root:.env.*.local"],
  ["vitest.integration-2578.config.ts", "root:vitest.integration-*.config.*"],
  ["vitest.integration-2823.config.mts", "root:vitest.integration-*.config.*"],
  ["vitest.integration-1983.config.js", "root:vitest.integration-*.config.*"],
  ["vitest.integration-2935.config.mjs", "root:vitest.integration-*.config.*"],
];

for (const [path, rule] of EXAMPLES) {
  test(`${rule} catches ${path}`, () => {
    assert.equal(ruleFor(path), rule);
  });
}

test("every rule has at least one covering example", () => {
  const covered = new Set(EXAMPLES.map(([, rule]) => rule));
  const uncovered = RULES.map((r) => r.rule).filter((r) => !covered.has(r));
  assert.deepEqual(uncovered, [], "each rule must be exercised by an example");
});

test("a dirty tree exits 1 and names the rule beside each hit", () => {
  const { status, stderr } = runGate([...CLEAN, "evidence/a.png", "node_modules/x/i.js"]);
  assert.equal(status, 1);
  assert.match(stderr, /\[product-tree-hygiene\] FAIL:/);
  assert.match(stderr, /any-depth:evidence\/\tevidence\/a\.png/);
  assert.match(stderr, /any-depth:node_modules\/\tnode_modules\/x\/i\.js/);
  assert.match(stderr, /2 forbidden path\(s\)/);
});

// ---------------------------------------------------------------------------
// Anchoring — the asymmetry that replaces an allowlist
// ---------------------------------------------------------------------------

test("src/lib/data/x.ts is NOT caught — data/ is root-anchored", () => {
  assert.equal(ruleFor("src/lib/data/x.ts"), undefined);
});

test("the real tracked nested data/ route segment is NOT caught", () => {
  // The path that FORCED data/ to be root-anchored rather than any-depth.
  assert.equal(
    ruleFor("src/app/agents/[vendor]/[packageName]/[instanceId]/data/page.tsx"),
    undefined,
  );
});

test("the root data/ runtime clone target IS caught", () => {
  assert.equal(ruleFor("data/postgres/PG_VERSION"), "root:data/");
});

test("packages/extensions/** is NOT caught — extensions/ is root-anchored", () => {
  assert.equal(ruleFor("packages/extensions/src/index.ts"), undefined);
  assert.equal(ruleFor("extensions/vendored/x.js"), "root:extensions/");
});

test("dev/ is root-anchored: a nested dev/ product path is NOT caught", () => {
  assert.equal(ruleFor("packages/x/src/dev/harness.ts"), undefined);
  assert.equal(ruleFor("scripts/dev/seed.mjs"), undefined);
  assert.equal(ruleFor("dev/cinatra-docs/README.md"), "root:dev/");
});

test("test-results/ is root-anchored", () => {
  assert.equal(ruleFor("tests/e2e/test-results/keep.ts"), undefined);
  assert.equal(ruleFor("test-results/trace.zip"), "root:test-results/");
});

test("packages/x/evidence/y.png IS caught — evidence/ is any-depth", () => {
  assert.equal(ruleFor("packages/x/evidence/y.png"), "any-depth:evidence/");
});

test("pr-evidence/ does not satisfy the evidence/ rule, and vice versa", () => {
  // Segment matching, not substring: each name owns its own rule so the report
  // names the right one.
  assert.equal(ruleFor("pr-evidence/x.png"), "any-depth:pr-evidence/");
  assert.equal(ruleFor("evidence/x.png"), "any-depth:evidence/");
});

test("a file merely NAMED like a forbidden directory is not caught", () => {
  // The rules match a directory SEGMENT (trailing slash), so a product file
  // that happens to carry the name is untouched.
  assert.equal(ruleFor("docs/internals/contracts/evidence.md"), undefined);
  assert.equal(ruleFor("src/lib/node_modules.ts"), undefined);
  assert.equal(ruleFor("scripts/audit/test-results.mjs"), undefined);
});

test("a root file rule does not fire on a nested namesake", () => {
  assert.equal(ruleFor("packages/x/next-env.d.ts"), undefined);
  assert.equal(ruleFor("packages/x/.env.local"), undefined);
  assert.equal(ruleFor(".env.example"), undefined);
  assert.equal(ruleFor(".env.local.example"), undefined);
});

test("the CONSOLIDATED home vitest/integration/<NNNN>.config.ts is NOT caught", () => {
  // Where the 12 root tiers move. The rule must not follow them there, or the
  // consolidation lands red — `vitest/integration/...` has no
  // `vitest.integration-` root segment, so the anchor already excludes it.
  assert.equal(ruleFor("vitest/integration/2578.config.ts"), undefined);
  assert.equal(ruleFor("vitest/integration/2935.config.ts"), undefined);
  assert.equal(ruleFor("vitest/integration/README.md"), undefined);
});

test("a package-local vitest.integration-*.config.ts is NOT caught", () => {
  assert.equal(ruleFor("packages/x/vitest.integration-1.config.ts"), undefined);
  assert.equal(ruleFor("tests/vitest.integration-2578.config.ts"), undefined);
});

test("the root tier rule is extension-bound and whole-name anchored", () => {
  assert.equal(ruleFor("vitest.integration-2578.config.json"), undefined);
  assert.equal(ruleFor("vitest.integration-2578.config.ts.bak"), undefined);
  assert.equal(ruleFor("vitest.config.ts"), undefined);
  assert.equal(ruleFor("vitest.integration.config.ts"), undefined);
});

// ---------------------------------------------------------------------------
// --json
// ---------------------------------------------------------------------------

test("--json prints {hits:[{path,rule}]} and still exits 1", () => {
  const { status, stdout } = runGate([...CLEAN, "evidence/a.png"], ["--json"]);
  assert.equal(status, 1);
  assert.deepEqual(JSON.parse(stdout), {
    hits: [{ path: "evidence/a.png", rule: "any-depth:evidence/" }],
  });
});

test("--json on a clean list is an empty hit list and exits 0", () => {
  const { status, stdout } = runGate(CLEAN, ["--json"]);
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout), { hits: [] });
});

// ---------------------------------------------------------------------------
// The rule set itself
// ---------------------------------------------------------------------------

test("no rule name appears in both anchoring classes", () => {
  const overlap = ROOT_DIRS.filter((n) => ANY_DEPTH_DIRS.includes(n));
  assert.deepEqual(overlap, [], "a name is either any-depth or root-anchored, never both");
});

test("the gate reads the tracked tree by default, not the working tree", () => {
  // `git ls-files` is the source: an UNTRACKED local node_modules/ must never
  // be a finding, or every developer checkout fails the gate.
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "node_modules"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  assert.deepEqual(tracked, [], "node_modules is not tracked, so it is not a finding");
});
