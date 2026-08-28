// The product tree hygiene gate (owner ruling 2026-08-28).
//
// Runs in the root Vitest suite (the gate of record) like its siblings in this
// directory: `scripts/ci/__tests__/**` is in the root include, so a suite here
// is executed wholesale by `pnpm test:root` and a failure reds a required
// check. The GATE ITSELF stays dependency-free (node + git only) so the
// pure-node `gates` job can run it without an install; only this suite needs
// vitest.
//
// Two halves:
//   - a CLEAN path list passes (the positive case that would otherwise rot
//     silently into a gate that fails everything or nothing);
//   - each rule CATCHES its example, and the two ANCHORING classes are pinned
//     in both directions — the nested product paths this repo really tracks
//     (`src/lib/data/x.ts`, `packages/extensions/**`) must NOT be caught, and
//     a nested `evidence/` MUST be, because that asymmetry is the whole design
//     and an allowlist is what we are refusing to have.

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ANY_DEPTH_DIRS, ROOT_DIRS, RULES, findHits } from "../product-tree-hygiene.mjs";

const GATE = fileURLToPath(new URL("../product-tree-hygiene.mjs", import.meta.url));
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

/** Run the gate in --stdin mode over `paths`; returns the spawn result. */
function runGate(paths, extraArgs = []) {
  return spawnSync("node", [GATE, "--stdin", ...extraArgs], {
    cwd: REPO_ROOT,
    input: `${paths.join("\n")}\n`,
    encoding: "utf8",
    timeout: 30_000,
  });
}

/** The rule id that catches `path`, or undefined. */
function ruleFor(p) {
  return findHits([p])[0]?.rule;
}

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

describe("a clean tree", () => {
  it("produces no hits", () => {
    expect(findHits(CLEAN)).toEqual([]);
  });

  it("exits 0 through the CLI", () => {
    const r = runGate(CLEAN);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\[product-tree-hygiene\] OK/);
  });
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
  ["proofs/1785/item3.txt", "any-depth:proofs/"],
  ["docs/internals/proofs/1785-a6/item3.proof.txt", "any-depth:proofs/"],
  ["packages/x/proofs/a.png", "any-depth:proofs/"],
  ["proof/57-x/a.png", "any-depth:proof/"],
  ["docs/proof/57-x/a.png", "any-depth:proof/"],
  // root-anchored directories.
  ["data/postgres/pg_wal/000000010000000000000001", "root:data/"],
  ["dev/cinatra-docs/README.md", "root:dev/"],
  ["extensions/cinatra-ai-wordpress/package.json", "root:extensions/"],
  ["test-results/chat-hitl-held-turn/trace.zip", "root:test-results/"],
  ["verification/1630-x/shot.png", "root:verification/"],
  ["verification/1630-slice-b-host-prove/screenshots/01-image-render.png", "root:verification/"],
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

describe("every rule catches its example", () => {
  for (const [p, rule] of EXAMPLES) {
    it(`${rule} catches ${p}`, () => {
      expect(ruleFor(p)).toBe(rule);
    });
  }

  it("every rule has at least one covering example", () => {
    const covered = new Set(EXAMPLES.map(([, rule]) => rule));
    expect(RULES.map((r) => r.rule).filter((r) => !covered.has(r))).toEqual([]);
  });

  it("a dirty tree exits 1 and names the rule beside each hit", () => {
    const r = runGate([...CLEAN, "evidence/a.png", "node_modules/x/i.js"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[product-tree-hygiene\] FAIL:/);
    expect(r.stderr).toMatch(/any-depth:evidence\/\tevidence\/a\.png/);
    expect(r.stderr).toMatch(/any-depth:node_modules\/\tnode_modules\/x\/i\.js/);
    expect(r.stderr).toMatch(/2 forbidden path\(s\)/);
  });
});

// ---------------------------------------------------------------------------
// Anchoring — the asymmetry that replaces an allowlist
// ---------------------------------------------------------------------------

describe("anchoring", () => {
  it("src/lib/data/x.ts is NOT caught — data/ is root-anchored", () => {
    expect(ruleFor("src/lib/data/x.ts")).toBeUndefined();
  });

  it("the real tracked nested data/ route segment is NOT caught", () => {
    // The path that FORCED data/ to be root-anchored rather than any-depth.
    expect(
      ruleFor("src/app/agents/[vendor]/[packageName]/[instanceId]/data/page.tsx"),
    ).toBeUndefined();
  });

  it("the root data/ runtime clone target IS caught", () => {
    expect(ruleFor("data/postgres/PG_VERSION")).toBe("root:data/");
  });

  it("packages/extensions/** is NOT caught — extensions/ is root-anchored", () => {
    expect(ruleFor("packages/extensions/src/index.ts")).toBeUndefined();
    expect(ruleFor("extensions/vendored/x.js")).toBe("root:extensions/");
  });

  it("dev/ is root-anchored: a nested dev/ product path is NOT caught", () => {
    expect(ruleFor("packages/x/src/dev/harness.ts")).toBeUndefined();
    expect(ruleFor("scripts/dev/seed.mjs")).toBeUndefined();
    expect(ruleFor("dev/cinatra-docs/README.md")).toBe("root:dev/");
  });

  it("test-results/ is root-anchored", () => {
    expect(ruleFor("tests/e2e/test-results/keep.ts")).toBeUndefined();
    expect(ruleFor("test-results/trace.zip")).toBe("root:test-results/");
  });

  it("packages/x/evidence/y.png IS caught — evidence/ is any-depth", () => {
    expect(ruleFor("packages/x/evidence/y.png")).toBe("any-depth:evidence/");
  });

  it("pr-evidence/ does not satisfy the evidence/ rule, and vice versa", () => {
    // Segment matching, not substring: each name owns its own rule so the
    // report names the right one.
    expect(ruleFor("pr-evidence/x.png")).toBe("any-depth:pr-evidence/");
    expect(ruleFor("evidence/x.png")).toBe("any-depth:evidence/");
  });

  it("a file merely NAMED like a forbidden directory is not caught", () => {
    // The rules match a directory SEGMENT (trailing slash), so a product file
    // that happens to carry the name is untouched.
    expect(ruleFor("docs/internals/contracts/evidence.md")).toBeUndefined();
    expect(ruleFor("src/lib/node_modules.ts")).toBeUndefined();
    expect(ruleFor("scripts/audit/test-results.mjs")).toBeUndefined();
  });

  it("a root file rule does not fire on a nested namesake", () => {
    expect(ruleFor("packages/x/next-env.d.ts")).toBeUndefined();
    expect(ruleFor("packages/x/.env.local")).toBeUndefined();
    expect(ruleFor(".env.example")).toBeUndefined();
    expect(ruleFor(".env.local.example")).toBeUndefined();
  });

  it("verification/ is root-anchored: a nested verification/ module is NOT caught", () => {
    expect(ruleFor("packages/x/src/verification/index.ts")).toBeUndefined();
    expect(ruleFor("src/lib/verification/check.ts")).toBeUndefined();
    expect(ruleFor("verification/1630-x/shot.png")).toBe("root:verification/");
  });

  it("a SUBSTRING of a forbidden name is not a segment, so it is NOT caught", () => {
    // The words are ordinary English; only a path SEGMENT equal to the name is
    // a finding. These are real tracked product paths in this repo.
    expect(ruleFor("src/lib/lifecycle/host-verification.ts")).toBeUndefined();
    expect(ruleFor("src/lib/lifecycle/lifecycle-verification.ts")).toBeUndefined();
    expect(
      ruleFor("src/lib/lifecycle/__tests__/lifecycle-verification.test.ts"),
    ).toBeUndefined();
    expect(ruleFor("tests/fixtures/echo-proof/a.png")).toBeUndefined();
    expect(
      ruleFor("tests/fixtures/works-after-agent/cinatra-works-after/echo-proof/package.json"),
    ).toBeUndefined();
    expect(ruleFor(".github/workflows/works-after-proof.yml")).toBeUndefined();
    expect(ruleFor("evidence/2043-s5/PROOF.md")).toBe("any-depth:evidence/");
  });

  it("a proof directory is caught at any depth, under any parent", () => {
    expect(ruleFor("proofs/a.png")).toBe("any-depth:proofs/");
    expect(ruleFor("docs/internals/proofs/1785-a6/x.txt")).toBe("any-depth:proofs/");
    expect(ruleFor("packages/x/proofs/a.png")).toBe("any-depth:proofs/");
    expect(ruleFor("docs/proof/57-x/a.png")).toBe("any-depth:proof/");
  });

  it("the CONSOLIDATED home vitest/integration/<NNNN>.config.ts is NOT caught", () => {
    // Where the 12 root tiers move. The rule must not follow them there, or the
    // consolidation lands red — `vitest/integration/...` has no
    // `vitest.integration-` root segment, so the anchor already excludes it.
    expect(ruleFor("vitest/integration/2578.config.ts")).toBeUndefined();
    expect(ruleFor("vitest/integration/2935.config.ts")).toBeUndefined();
    expect(ruleFor("vitest/integration/README.md")).toBeUndefined();
  });

  it("a package-local vitest.integration-*.config.ts is NOT caught", () => {
    expect(ruleFor("packages/x/vitest.integration-1.config.ts")).toBeUndefined();
    expect(ruleFor("tests/vitest.integration-2578.config.ts")).toBeUndefined();
  });

  it("the root tier rule is extension-bound and whole-name anchored", () => {
    expect(ruleFor("vitest.integration-2578.config.json")).toBeUndefined();
    expect(ruleFor("vitest.integration-2578.config.ts.bak")).toBeUndefined();
    expect(ruleFor("vitest.config.ts")).toBeUndefined();
    expect(ruleFor("vitest.integration.config.ts")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// --json
// ---------------------------------------------------------------------------

describe("--json", () => {
  it("prints {hits:[{path,rule}]} and still exits 1", () => {
    const r = runGate([...CLEAN, "evidence/a.png"], ["--json"]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      hits: [{ path: "evidence/a.png", rule: "any-depth:evidence/" }],
    });
  });

  it("on a clean list is an empty hit list and exits 0", () => {
    const r = runGate(CLEAN, ["--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hits: [] });
  });
});

// ---------------------------------------------------------------------------
// The rule set itself
// ---------------------------------------------------------------------------

describe("the rule set", () => {
  it("has no name in both anchoring classes", () => {
    expect(ROOT_DIRS.filter((n) => ANY_DEPTH_DIRS.includes(n))).toEqual([]);
  });

  it("reads the tracked tree by default, not the working tree", () => {
    // `git ls-files` is the source: an UNTRACKED local node_modules/ must never
    // be a finding, or every developer checkout fails the gate.
    const tracked = execFileSync("git", ["ls-files", "-z", "--", "node_modules"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
    expect(tracked).toEqual([]);
  });
});
