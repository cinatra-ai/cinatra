// The pure core of scripts/ci/extension-suite-gate.mjs (cinatra#2288 slice 2):
// classification, report parsing, run planning, shape matching and the finding
// rules. Every input is data, so the whole rule set is exercised without
// spawning a single vitest process. The node:test runner cases start node on
// small files written to a temporary folder, with short bounds.
//
// The cases below are not hypotheticals — each one is a shape observed on the
// materialized tree at the pins this gate landed against, named in the test
// title so a future reader can tell a real regression from a fixture edit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import nodeTopLevelReporter, {
  classifyPackage,
  fenceWorkflowCommands,
  foldNodeRuns,
  isFirstPartyMirror,
  isHostRunNodeTest,
  judge,
  NODE_FILE_TIMEOUT_MS,
  NODE_TEST_TIMEOUT_MS,
  nodeTestArgs,
  observedShape,
  parseNodeTap,
  parseReport,
  planRun,
  readTopLevel,
  renderManifest,
  resolveMaterializedSha,
  runNodeSuites,
  runNodeTest,
  runNodeTestFile,
  shapeMatches,
  skipsStandaloneTests,
  TEST_FILE_RE,
} from "../extension-suite-gate.mjs";

const SKIP_CI = `
      - name: Test
        run: |
          if [ "$first_party" = "1" ]; then
            echo "Skipping standalone tests (host-internal @cinatra-ai/* peers — the cinatra monorepo runs these)."
            exit 0
          fi
          corepack pnpm test --if-present
`;

const PIN = "d".repeat(40);
const MOVED = "e".repeat(40);

const mirrorPkg = (over = {}) => ({
  peerDependencies: { "@cinatra-ai/sdk-extensions": "*" },
  peerDependenciesMeta: { "@cinatra-ai/sdk-extensions": { optional: true } },
  ...over,
});

const pkg = (over = {}) => {
  const slug = over.slug ?? "x-connector";
  const runner = over.runner ?? "vitest";
  return {
    slug,
    id: `cinatra-ai/${slug}`,
    sha: PIN,
    dir: `extensions/cinatra-ai/${slug}`,
    runner,
    // Mirrors what classifyPackage derives, so a fixture cannot claim a
    // combination the classifier never produces. Overridable, which is how the
    // "unknown" cases below are written.
    runnerEvidence: runner === "vitest" ? "vitest" : runner === "none" ? "none" : "node-test",
    testScript: "vitest run",
    hasOwnConfig: true,
    testFiles: ["src/__tests__/a.test.ts"],
    firstPartyMirror: true,
    standaloneTestsSkipped: true,
    ...over,
  };
};

const carve = (slug, expect_ = { exitCode: 1, totalTests: 0, failedTests: 1, uncollected: [] }, sha = PIN) => ({
  id: `cinatra-ai/${slug}`,
  sha,
  expect: expect_,
  reason: "documented defect",
  upstream: "repo#1",
  retiresWhen: "the pin moves",
});

const green = (files, over = {}) => ({
  ok: true,
  exitCode: 0,
  reportOk: true,
  executedFiles: files,
  numTotalTests: files.length * 3,
  numFailedTests: 0,
  numPendingTests: 0,
  failedTestNames: [],
  durationMs: 1200,
  detail: "",
  ...over,
});

const resultsFor = (entries) => new Map(entries.map(([slug, res]) => [`cinatra-ai/${slug}`, res]));

describe("TEST_FILE_RE — vitest's default include, not a package's own", () => {
  it("matches every extension the default include covers", () => {
    for (const f of ["a.test.ts", "a.test.tsx", "a.spec.ts", "a.test.mjs", "a.test.cjs", "a.spec.jsx", "a.test.js"]) {
      expect(TEST_FILE_RE.test(f), f).toBe(true);
    }
  });

  it("does not match non-test sources or fixtures named like them", () => {
    for (const f of ["index.ts", "test.ts", "a.testing.ts", "a.test.json", "a.test.snap"]) {
      expect(TEST_FILE_RE.test(f), f).toBe(false);
    }
  });
});

describe("isFirstPartyMirror — mirrors the companion ci.yml classifier verbatim", () => {
  it("is true for either host-internal scope", () => {
    expect(isFirstPartyMirror(mirrorPkg())).toBe(true);
    expect(isFirstPartyMirror({ peerDependencies: { "@cinatra/legacy": "*" } })).toBe(true);
  });

  it("is false for a genuinely standalone repo (react peers only)", () => {
    expect(isFirstPartyMirror({ peerDependencies: { react: "^19" } })).toBe(false);
    expect(isFirstPartyMirror({})).toBe(false);
  });

  it("does not count a host-internal package declared as a normal dependency", () => {
    // The companion CI hard-fails that shape separately; it must not silently
    // arm the skip here.
    expect(isFirstPartyMirror({ dependencies: { "@cinatra-ai/sdk-ui": "*" } })).toBe(false);
  });
});

describe("skipsStandaloneTests — both halves must hold", () => {
  it("is true only when the workflow carries the skip AND the package arms it", () => {
    expect(skipsStandaloneTests({ pkgJson: mirrorPkg(), ciWorkflow: SKIP_CI })).toBe(true);
    expect(skipsStandaloneTests({ pkgJson: { peerDependencies: { react: "^19" } }, ciWorkflow: SKIP_CI })).toBe(false);
    expect(skipsStandaloneTests({ pkgJson: mirrorPkg(), ciWorkflow: "- name: Test\n  run: pnpm test\n" })).toBe(false);
    expect(skipsStandaloneTests({ pkgJson: mirrorPkg(), ciWorkflow: undefined })).toBe(false);
  });
});

describe("classifyPackage — the real shapes on the tree", () => {
  const base = { slug: "s", dir: "d", ciWorkflow: SKIP_CI, readTestSource: () => "" };

  it("pdf-artifact shape: a vitest config and NO test script", () => {
    const c = classifyPackage({
      ...base,
      pkgJson: mirrorPkg({ scripts: {} }),
      entries: ["package.json", "vitest.config.ts"],
      testFiles: ["src/__tests__/a.test.ts"],
    });
    expect(c.runner).toBe("vitest");
    expect(c.hasOwnConfig).toBe(true);
  });

  it('anthropic-connector shape: a "vitest" test script and NO config', () => {
    const c = classifyPackage({
      ...base,
      pkgJson: mirrorPkg({ scripts: { test: "vitest" } }),
      entries: ["package.json"],
      testFiles: ["src/__tests__/a.test.ts"],
    });
    expect(c.runner).toBe("vitest");
    expect(c.hasOwnConfig).toBe(false);
  });

  it("email-artifacts shape: NEITHER a config NOR a test script — the sources decide", () => {
    const c = classifyPackage({
      ...base,
      pkgJson: mirrorPkg({ scripts: {} }),
      entries: ["package.json"],
      testFiles: ["src/__tests__/a.test.tsx"],
      readTestSource: () => 'import { describe, expect, it } from "vitest";',
    });
    expect(c.runner).toBe("vitest");
  });

  it("email-drafting-agent shape: node:test files are NOT claimed as a vitest suite", () => {
    const c = classifyPackage({
      ...base,
      pkgJson: { scripts: { test: "node --test tests/*.test.mjs" } },
      entries: ["package.json"],
      testFiles: ["tests/a.test.mjs"],
      readTestSource: () => 'import { test } from "node:test";',
    });
    expect(c.runner).toBe("other");
    expect(c.runnerEvidence).toBe("node-test");
    expect(c.standaloneTestsSkipped).toBe(false);
  });

  it("records WHY a package is not vitest — evidence, never an assumption", () => {
    const cases = [
      [{ scripts: { test: "vitest run" } }, ["package.json"], ["a.test.ts"], "", "vitest"],
      [{ scripts: {} }, ["package.json"], [], "", "none"],
      [{ scripts: { test: "node --test" } }, ["package.json"], ["a.test.mjs"], 'import { test } from "node:test";', "node-test"],
      // Vitest GLOBALS, in a package that names vitest nowhere: no config, no
      // vitest in `test`, no dependency, no import. Every signal misses.
      [{ scripts: { test: "echo ok" } }, ["package.json"], ["a.test.ts"], "describe('x', () => it('y', () => expect(1).toBe(1)));", "unknown"],
    ];
    for (const [pkgJson, entries, testFiles, source, expected] of cases) {
      const c = classifyPackage({ ...base, pkgJson, entries, testFiles, readTestSource: () => source });
      expect(c.runnerEvidence, JSON.stringify(pkgJson)).toBe(expected);
    }
  });

  it("a package with neither test files NOR a declared vitest suite is runner=none", () => {
    const c = classifyPackage({ ...base, pkgJson: mirrorPkg({ scripts: { test: "echo no tests" } }), entries: [], testFiles: [] });
    expect(c.runner).toBe("none");
  });

  it("DECLARED INTENT with no default-named file still runs — the name-only discovery escape", () => {
    // A package whose config `include` is written for custom names ships zero
    // files matching vitest's DEFAULT include. A name-only classifier would
    // call that "none" and never run it — cinatra#2288's silent non-coverage,
    // reintroduced one level in. Either signal of intent is enough.
    for (const over of [{ scripts: { test: "vitest run" } }, { scripts: {} }]) {
      const entries = over.scripts.test ? ["package.json"] : ["package.json", "vitest.config.ts"];
      const c = classifyPackage({ ...base, pkgJson: mirrorPkg(over), entries, testFiles: [] });
      expect(c.runner, JSON.stringify(over)).toBe("vitest");
    }
  });

  it("a bare vitest DEVDEPENDENCY is NOT intent — it rides along in packages with no suite", () => {
    const c = classifyPackage({
      ...base,
      pkgJson: mirrorPkg({ scripts: {}, devDependencies: { vitest: "^4" } }),
      entries: ["package.json"],
      testFiles: [],
    });
    expect(c.runner).toBe("none");
  });

  it("carries a scope-qualified id, the materialized sha and the dirty flag through", () => {
    const c = classifyPackage({ ...base, id: "cinatra-ai/s", sha: PIN, dirty: true, pkgJson: mirrorPkg(), entries: [], testFiles: [] });
    expect(c.id).toBe("cinatra-ai/s");
    expect(c.sha).toBe(PIN);
    expect(c.dirty).toBe(true);
  });

  it("an unavailable identity is carried as sha=null, not as a guess", () => {
    const c = classifyPackage({ ...base, id: "cinatra-ai/s", sha: null, pkgJson: mirrorPkg(), entries: [], testFiles: [] });
    expect(c.sha).toBeNull();
    expect(c.dirty).toBe(false);
  });
});

describe("resolveMaterializedSha — a package's OWN identity, or none at all", () => {
  it("accepts a HEAD whose toplevel IS the package directory", () => {
    expect(resolveMaterializedSha({ pkgDir: "/w/extensions/cinatra-ai/a", toplevel: "/w/extensions/cinatra-ai/a", head: PIN, status: "" })).toEqual({
      sha: PIN,
      dirty: false,
    });
  });

  it("REFUSES the host repo's HEAD when the nested git repo is missing", () => {
    // `git -C <dir> rev-parse HEAD` walks UPWARD, so a package with no nested
    // .git answers with the HOST's HEAD — a real sha, for the wrong repository,
    // and exactly the value a carve-out would be bound to.
    expect(resolveMaterializedSha({ pkgDir: "/w/extensions/cinatra-ai/a", toplevel: "/w", head: PIN, status: "" }).sha).toBeNull();
  });

  it("refuses when git answered nothing at all", () => {
    expect(resolveMaterializedSha({ pkgDir: "/w/a", toplevel: null, head: null, status: null }).sha).toBeNull();
  });

  it("reports a modified tracked file as dirty", () => {
    expect(resolveMaterializedSha({ pkgDir: "/w/a", toplevel: "/w/a", head: PIN, status: " M src/x.ts\n" }).dirty).toBe(true);
  });
});

describe("parseReport — the missing/corrupt-report path is fail-closed", () => {
  const rel = (from, to) => to.slice(from.length + 1);

  it("relativizes executed files against the package dir", () => {
    const report = {
      testResults: [
        {
          name: "/w/ext/a/src/x.test.ts",
          assertionResults: [
            { status: "failed", fullName: "Widget > explodes" },
            { status: "passed", fullName: "Widget > works" },
          ],
        },
      ],
      numTotalTests: 4,
      numFailedTests: 1,
      numPendingTests: 2,
    };
    expect(parseReport({ report, pkgDir: "/w/ext/a", relativize: rel })).toEqual({
      executedFiles: ["src/x.test.ts"],
      numTotalTests: 4,
      numFailedTests: 1,
      numPendingTests: 2,
      failedTestNames: ["src/x.test.ts › Widget > explodes"],
    });
  });

  it("a null report yields ZERO executed files, so every on-disk file reads as uncollected", () => {
    // Deliberate: a vanished or unparseable report must not look like a
    // complete run. Paired with the judge rule below, this fails the package.
    expect(parseReport({ report: null, pkgDir: "/w/ext/a", relativize: rel }).executedFiles).toEqual([]);
  });
});

describe("shapeMatches / observedShape", () => {
  it("reads the observed shape in the ledger's own vocabulary", () => {
    const p = pkg({ testFiles: ["a.test.ts", "b.test.ts"] });
    expect(
      observedShape(p, {
        exitCode: 1,
        numTotalTests: 9,
        numFailedTests: 3,
        numPendingTests: 1,
        failedTestNames: ["a.test.ts › z", "a.test.ts › a"],
        executedFiles: ["a.test.ts"],
      }),
    ).toEqual({
      exitCode: 1,
      totalTests: 9,
      failedTests: 3,
      pendingTests: 1,
      failedTestNames: ["a.test.ts › a", "a.test.ts › z"],
      uncollected: ["b.test.ts"],
    });
  });

  it("is exact on every field and order-insensitive on the file list", () => {
    const base = { exitCode: 1, totalTests: 63, failedTests: 6, pendingTests: 0, uncollected: ["a", "b"] };
    const at = (over) => ({ exitCode: 1, totalTests: 63, failedTests: 6, pendingTests: 0, uncollected: ["a", "b"], ...over });
    expect(shapeMatches(at({ uncollected: ["b", "a"] }), base)).toBe(true);
    expect(shapeMatches(at({ failedTests: 7 }), base)).toBe(false);
    expect(shapeMatches(at({ exitCode: 0 }), base)).toBe(false);
    expect(shapeMatches(at({ uncollected: ["a"] }), base)).toBe(false);
    expect(shapeMatches(undefined, base)).toBe(false);
  });

  it("a SHRUNKEN run does not satisfy an entry whose failure count it still matches", () => {
    // The host-drift shape those two count fields exist for: every file still
    // EXECUTES (so `uncollected` stays empty) and the 6 documented failures are
    // still exactly 6, but half the package's tests stopped being collected.
    // Counting failures alone would certify that as the documented defect.
    const base = { exitCode: 1, totalTests: 30, failedTests: 6, pendingTests: 0, uncollected: [] };
    expect(shapeMatches({ exitCode: 1, totalTests: 63, failedTests: 6, pendingTests: 0, uncollected: [] }, base)).toBe(false);
    expect(shapeMatches({ exitCode: 1, totalTests: 30, failedTests: 6, pendingTests: 12, uncollected: [] }, base)).toBe(false);
  });

  it("an omitted numeric field reads as 0, so an entry never tolerates more than it wrote down", () => {
    const observed = { exitCode: 1, totalTests: 63, failedTests: 6, pendingTests: 0, failedTestNames: [], uncollected: [] };
    expect(shapeMatches({ exitCode: 1, failedTests: 6, uncollected: [] }, observed)).toBe(false);
  });

  it("a SWAP — the documented failures recover while as many DIFFERENT tests break — does not match", () => {
    // Codex round-1 finding on this change, adopted. The counts are identical
    // in both shapes; only the identities move. Under host-side drift (a
    // monorepo dependency bump, a node major) that is a reachable state at an
    // unchanged pin, and an entry written for one defect must not certify
    // another.
    const documented = {
      exitCode: 1,
      totalTests: 63,
      failedTests: 2,
      pendingTests: 0,
      failedTestNames: ["a.test.ts › router invariant", "a.test.ts › toast render"],
      uncollected: [],
    };
    const swapped = { ...documented, failedTestNames: ["a.test.ts › router invariant", "b.test.ts › brand new regression"] };
    expect(shapeMatches(documented, swapped)).toBe(false);
    expect(shapeMatches(documented, { ...documented })).toBe(true);
  });
});

describe("planRun — a carve-out applies at ONE pin and nowhere else", () => {
  it("splits vitest suites into enforced vs carved and ignores the rest", () => {
    const packages = [pkg({ slug: "a" }), pkg({ slug: "b" }), pkg({ slug: "c", runner: "other" }), pkg({ slug: "d", runner: "none" })];
    const { run, carved } = planRun({ packages, carveOuts: [carve("b")] });
    expect(run.map((p) => p.slug)).toEqual(["a"]);
    expect(carved.map((p) => p.slug)).toEqual(["b"]);
  });

  it("ENFORCES the package once the pin moves, and reports the entry as stale", () => {
    const packages = [pkg({ slug: "b", sha: MOVED })];
    const { run, carved, stale } = planRun({ packages, carveOuts: [carve("b")] });
    expect(run.map((p) => p.slug)).toEqual(["b"]);
    expect(carved).toEqual([]);
    expect(stale[0].why).toContain("pin moved");
  });

  it("ENFORCES a package whose own identity could not be established", () => {
    // sha=null matches no entry, so the exemption cannot be claimed by a
    // checkout that cannot prove which revision it is.
    const packages = [pkg({ slug: "b", sha: null })];
    const { run, carved, stale } = planRun({ packages, carveOuts: [carve("b")] });
    expect(run.map((p) => p.slug)).toEqual(["b"]);
    expect(carved).toEqual([]);
    expect(stale[0].why).toContain("repository identity could not be established");
  });

  it("ENFORCES a package whose checkout at the pinned sha has LOCAL MODIFICATIONS", () => {
    // A sha names a commit, not a working tree. Without this an entry written
    // for one revision's known defect would also excuse whatever an edited tree
    // does — including a planted failure.
    const packages = [pkg({ slug: "b", dirty: true })];
    const { run, carved, stale } = planRun({ packages, carveOuts: [carve("b")] });
    expect(run.map((p) => p.slug)).toEqual(["b"]);
    expect(carved).toEqual([]);
    expect(stale[0].why).toContain("LOCAL MODIFICATIONS");
  });

  it("reports an entry naming a package that is no longer materialized", () => {
    const { stale } = planRun({ packages: [pkg({ slug: "a" })], carveOuts: [carve("gone")] });
    expect(stale[0].why).toContain("not materialized");
  });

  it("matches on the SCOPE-QUALIFIED id, so one entry cannot exempt a same-named dir in another scope", () => {
    const mine = pkg({ slug: "dup" });
    const other = { ...pkg({ slug: "dup" }), id: "other-scope/dup" };
    const { run, carved } = planRun({ packages: [mine, other], carveOuts: [carve("dup")] });
    expect(carved.map((p) => p.id)).toEqual(["cinatra-ai/dup"]);
    expect(run.map((p) => p.id)).toEqual(["other-scope/dup"]);
  });
});

describe("judge — fail-closed", () => {
  it("an empty tree is a hard failure, never a vacuous pass", () => {
    const { findings } = judge({ packages: [], results: new Map(), carveOuts: [] });
    expect(findings.map((f) => f.kind)).toEqual(["no-packages"]);
  });

  it("packages present but zero vitest suites is a hard failure too", () => {
    const { findings } = judge({ packages: [pkg({ runner: "none", testFiles: [] })], results: new Map(), carveOuts: [] });
    expect(findings.map((f) => f.kind)).toEqual(["no-suites"]);
  });
});

describe("judge — the enforced set", () => {
  it("passes clean when every suite is green and complete", () => {
    const packages = [pkg({ slug: "a", testFiles: ["t/a.test.ts"] })];
    const results = resultsFor([["a", green(["t/a.test.ts"])]]);
    expect(judge({ packages, results, carveOuts: [] }).findings).toEqual([]);
  });

  it("reports a red suite", () => {
    const packages = [pkg({ slug: "a" })];
    const results = resultsFor([["a", { ...green([]), ok: false, exitCode: 1, numFailedTests: 6 }]]);
    const [f] = judge({ packages, results, carveOuts: [] }).findings;
    expect(f.kind).toBe("suite-red");
    expect(f.message).toContain("6 failing test(s)");
  });

  it("NAMES an on-disk test file that vitest never executed, even on a green exit", () => {
    // The wordpress-assistant-connector defect: exit 0, "2 passed", and one
    // whole conformance suite silently uncollected. A count-blind gate calls
    // this healthy.
    const packages = [pkg({ slug: "wpac", testFiles: ["src/__tests__/a.test.ts", "tests/contracts/c.test.ts"] })];
    const results = resultsFor([["wpac", green(["src/__tests__/a.test.ts"])]]);
    const [f] = judge({ packages, results, carveOuts: [] }).findings;
    expect(f.kind).toBe("uncollected-files");
    expect(f.message).toContain("tests/contracts/c.test.ts");
  });

  it("a lost report reads as a fully uncollected package rather than a clean run", () => {
    const packages = [pkg({ slug: "a", testFiles: ["x.test.ts"] })];
    const results = resultsFor([["a", green([])]]); // exit 0, no executed files
    const [f] = judge({ packages, results, carveOuts: [] }).findings;
    expect(f.kind).toBe("uncollected-files");
  });

  it("reports a discovered suite that never ran at all", () => {
    const packages = [pkg({ slug: "a" })];
    const [f] = judge({ packages, results: new Map(), carveOuts: [] }).findings;
    expect(f.kind).toBe("not-run");
  });

  it("keys results by scope-qualified id, so same-named dirs cannot overwrite each other", () => {
    const a = { ...pkg({ slug: "dup", testFiles: ["x.test.ts"] }), id: "cinatra-ai/dup" };
    const b = { ...pkg({ slug: "dup", testFiles: ["x.test.ts"] }), id: "other-scope/dup" };
    const results = new Map([
      ["cinatra-ai/dup", green(["x.test.ts"])],
      ["other-scope/dup", { ...green([]), ok: false, exitCode: 1, numFailedTests: 2 }],
    ]);
    const kinds = judge({ packages: [a, b], results, carveOuts: [] }).findings.map((f) => f.kind);
    expect(kinds).toEqual(["suite-red"]);
  });
});

describe("judge — carve-outs tolerate ONE documented defect, at ONE pin", () => {
  it("tolerates exactly the recorded red shape", () => {
    const packages = [pkg({ slug: "a" })];
    const results = resultsFor([["a", { ...green([]), ok: false, exitCode: 1, numFailedTests: 6, executedFiles: ["src/__tests__/a.test.ts"] }]]);
    expect(judge({ packages, results, carveOuts: [carve("a", { exitCode: 1, totalTests: 0, failedTests: 6, uncollected: [] })] }).findings).toEqual([]);
  });

  it("tolerates a recorded GREEN-but-incomplete shape (the wordpress-assistant-connector entry)", () => {
    const packages = [pkg({ slug: "a", testFiles: ["x.test.ts", "y.test.ts"] })];
    const results = resultsFor([["a", green(["x.test.ts"])]]);
    const carveOuts = [carve("a", { exitCode: 0, totalTests: 3, failedTests: 0, uncollected: ["y.test.ts"] })];
    expect(judge({ packages, results, carveOuts }).findings).toEqual([]);
  });

  it("FAILS when the SAME pin regresses further than the entry documents", () => {
    const packages = [pkg({ slug: "a" })];
    const results = resultsFor([["a", { ...green([]), ok: false, exitCode: 1, numFailedTests: 40, executedFiles: ["src/__tests__/a.test.ts"] }]]);
    const [f] = judge({ packages, results, carveOuts: [carve("a", { exitCode: 1, totalTests: 0, failedTests: 6, uncollected: [] })] }).findings;
    expect(f.kind).toBe("carve-out-shape-drift");
    expect(f.message).toContain("40 failing");
  });

  it("FAILS when a carved suite goes green at the same pin — the entry stopped describing reality", () => {
    const packages = [pkg({ slug: "a", testFiles: ["x.test.ts"] })];
    const results = resultsFor([["a", green(["x.test.ts"])]]);
    const [f] = judge({ packages, results, carveOuts: [carve("a", { exitCode: 1, totalTests: 0, failedTests: 6, uncollected: [] })] }).findings;
    expect(f.kind).toBe("carve-out-shape-drift");
  });

  it("ENFORCES normally once the pin moves — a green bump passes with only a stale NOTICE", () => {
    const packages = [pkg({ slug: "a", sha: MOVED, testFiles: ["x.test.ts"] })];
    const results = resultsFor([["a", green(["x.test.ts"])]]);
    const { findings, notices } = judge({ packages, results, carveOuts: [carve("a", { exitCode: 1, totalTests: 0, failedTests: 6, uncollected: [] })] });
    expect(findings).toEqual([]);
    expect(notices.map((n) => n.kind)).toEqual(["stale-carve-out"]);
  });

  it("ENFORCES normally once the pin moves — a red bump BLOCKS despite the ledger entry", () => {
    const packages = [pkg({ slug: "a", sha: MOVED })];
    const results = resultsFor([["a", { ...green([]), ok: false, exitCode: 1, numFailedTests: 6 }]]);
    const { findings } = judge({ packages, results, carveOuts: [carve("a", { exitCode: 1, totalTests: 0, failedTests: 6, uncollected: [] })] });
    expect(findings.map((f) => f.kind)).toEqual(["suite-red"]);
  });

  it("a carved suite that was never executed FAILS — a carve-out is run, not skipped", () => {
    const packages = [pkg({ slug: "a" }), pkg({ slug: "b", testFiles: ["y.test.ts"] })];
    const results = resultsFor([["b", green(["y.test.ts"])]]);
    const [f] = judge({ packages, results, carveOuts: [carve("a")] }).findings;
    expect(f.kind).toBe("not-run");
  });
});

describe("judge — a lost JSON report is fatal for enforced AND carved packages alike", () => {
  it("blocks an enforced package whose report never materialized", () => {
    const packages = [pkg({ slug: "a", testFiles: ["x.test.ts"] })];
    const results = resultsFor([["a", { ...green([]), reportOk: false, ok: false, exitCode: 1 }]]);
    const kinds = judge({ packages, results, carveOuts: [] }).findings.map((f) => f.kind);
    expect(kinds).toEqual(["no-report"]);
  });

  it("blocks a CARVED package whose lost report would otherwise MATCH its documented shape", () => {
    // The blog-artifact shape: exit 1, zero failures, sole file uncollected —
    // which is exactly what a vanished report parses to. Without the explicit
    // validity flag a broken reporter would read as the recorded defect.
    const packages = [pkg({ slug: "blog", testFiles: ["tests/o.test.tsx"] })];
    const results = resultsFor([["blog", { ...green([]), reportOk: false, ok: false, exitCode: 1 }]]);
    const carveOuts = [carve("blog", { exitCode: 1, totalTests: 0, failedTests: 0, uncollected: ["tests/o.test.tsx"] })];
    const kinds = judge({ packages, results, carveOuts }).findings.map((f) => f.kind);
    expect(kinds).toEqual(["no-report"]);
  });

  it("does not fire when the report parsed fine", () => {
    const packages = [pkg({ slug: "a", testFiles: ["x.test.ts"] })];
    const results = resultsFor([["a", green(["x.test.ts"])]]);
    expect(judge({ packages, results, carveOuts: [] }).findings).toEqual([]);
  });
});

describe("judge — AC6: the companion skip may never outrun what the host does", () => {
  it("FAILS when a repo skips its tests standalone and this gate cannot run them (no runner named)", () => {
    // A node:test package that skips is RUN here (the node:test road below);
    // only a skipping package whose runner cannot be identified stays unrunnable.
    const packages = [
      pkg({ slug: "gated", testFiles: ["x.test.ts"] }),
      pkg({ slug: "orphan", runner: "other", runnerEvidence: "unknown", testFiles: ["tests/a.test.mjs"], standaloneTestsSkipped: true }),
    ];
    const results = resultsFor([["gated", green(["x.test.ts"])]]);
    const f = judge({ packages, results, carveOuts: [] }).findings.find((x) => x.kind === "dishonest-skip");
    expect(f.slug).toBe("orphan");
    expect(f.message).toContain("stop claiming the host runs it");
  });

  it("does NOT fire for a standalone repo whose own CI runs its node:test suite", () => {
    const packages = [
      pkg({ slug: "gated", testFiles: ["x.test.ts"] }),
      pkg({ slug: "own-ci", runner: "other", testFiles: ["tests/a.test.mjs"], standaloneTestsSkipped: false }),
    ];
    const results = resultsFor([["gated", green(["x.test.ts"])]]);
    expect(judge({ packages, results, carveOuts: [] }).findings).toEqual([]);
  });

  it("does NOT fire for a carved package — the ledger is the written record for it", () => {
    const packages = [pkg({ slug: "a" }), pkg({ slug: "b", testFiles: ["y.test.ts"] })];
    const results = resultsFor([
      ["a", { ...green([]), ok: false, exitCode: 1, numFailedTests: 1, executedFiles: ["src/__tests__/a.test.ts"] }],
      ["b", green(["y.test.ts"])],
    ]);
    expect(judge({ packages, results, carveOuts: [carve("a")] }).findings).toEqual([]);
  });
});

// The node:test road (cinatra#4314's dev-lock bump): brand-voice-artifact at
// dec0bb58 added test/own-type.test.mjs, a node:test file, while its own ci.yml
// keeps skipping tests as run by the host. Check 3 could only name it; nothing
// ran it. This gate now runs such a package with `node --test`, file by file,
// and enforces it like a vitest suite.
const TAP_GREEN = [
  "TAP version 13",
  "# Subtest: the pack declares one type, the brand-voice guide, under its own package name",
  "ok 1 - the pack declares one type, the brand-voice guide, under its own package name",
  "  ---",
  "  duration_ms: 0.6",
  "  type: 'test'",
  "  ...",
  "# Subtest: every declared type's namespace is this package, so the host registers it",
  "ok 2 - every declared type's namespace is this package, so the host registers it",
  "# Subtest: the typed export declares the same types as package.json",
  "ok 3 - the typed export declares the same types as package.json",
  "1..3",
  "# tests 3",
  "# suites 0",
  "# pass 3",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 41.2",
].join("\n");

const TAP_RED = [
  "TAP version 13",
  "# Subtest: outer",
  "    # Subtest: inner",
  "    not ok 1 - inner",
  "    # tests 9",
  "not ok 1 - outer",
  "ok 2 - fine",
  "not ok 3 - pending one # TODO later",
  "1..3",
  "# tests 3",
  "# pass 1",
  "# fail 1",
  "# cancelled 0",
  "# skipped 0",
  "# todo 1",
].join("\n");

const TAP_EMPTY = ["TAP version 13", "1..0", "# tests 0", "# pass 0", "# fail 0", "# cancelled 0", "# skipped 0", "# todo 0"].join("\n");

// What node 24 prints for `node --test --test-reporter=tap <file>` when the
// file registers no test (read on a lane host with node v24.20.0): the runner
// reports the FILE ITSELF as one passing test, named by the path it was given,
// so the summary says `# tests 1` although no test ran.
const tapFileOnly = (file) =>
  [
    "TAP version 13",
    `# Subtest: ${file}`,
    `ok 1 - ${file}`,
    "  ---",
    "  duration_ms: 38.1",
    "  type: 'test'",
    "  ...",
    "1..1",
    "# tests 1",
    "# suites 0",
    "# pass 1",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 44.0",
  ].join("\n");

const BRAND_VOICE_SOURCE = `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("x", () => assert.ok(true));\n`;

const brandVoice = (over = {}) =>
  classifyPackage({
    slug: "brand-voice-artifact",
    id: "cinatra-ai/brand-voice-artifact",
    sha: PIN,
    dirty: false,
    dir: "extensions/cinatra-ai/brand-voice-artifact",
    pkgJson: mirrorPkg({ name: "@cinatra-ai/brand-voice-artifact", type: "module" }),
    entries: ["package.json", "src", "test", ".github"],
    testFiles: ["test/own-type.test.mjs"],
    readTestSource: () => BRAND_VOICE_SOURCE,
    ciWorkflow: SKIP_CI,
    ...over,
  });

const nodeGreen = (files) => foldNodeRuns(files.map((file) => ({ file, exitCode: 0, tap: TAP_GREEN })));

describe("parseNodeTap — the top-level summary, or none", () => {
  it("reads the counts of a green run", () => {
    expect(parseNodeTap(TAP_GREEN)).toEqual({ summary: true, tests: 3, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0, failedNames: [], fileOnly: false });
  });

  it("reads node's report of the file itself as the one test as a file that ran no test", () => {
    expect(parseNodeTap(tapFileOnly("test/empty.test.mjs"), "test/empty.test.mjs").fileOnly).toBe(true);
    // the same report for another path, or a real test of that name next to others, is a test
    expect(parseNodeTap(tapFileOnly("test/empty.test.mjs"), "test/own-type.test.mjs").fileOnly).toBe(false);
    expect(parseNodeTap(TAP_GREEN, "test/own-type.test.mjs").fileOnly).toBe(false);
    const twoTop = tapFileOnly("test/x.test.mjs").replace("1..1", "ok 2 - another\n1..2");
    expect(parseNodeTap(twoTop, "test/x.test.mjs").fileOnly).toBe(false);
    // a describe block counts as a suite, so a file of that name with a suite is not file-only
    expect(parseNodeTap(tapFileOnly("test/x.test.mjs").replace("# suites 0", "# suites 1"), "test/x.test.mjs").fileOnly).toBe(false);
  });

  it("tells node's report of the file from a real test of the same name by the top-level record's location", () => {
    const f = "test/own-type.test.mjs";
    const tap = tapFileOnly(f);
    expect(parseNodeTap(tap, f, [{ name: f, line: 1, column: 1 }]).fileOnly).toBe(true);
    expect(parseNodeTap(tap, f, [{ name: f, line: 2, column: 1 }]).fileOnly).toBe(false);
    expect(parseNodeTap(tap, f, [{ name: f, line: 1, column: 22 }]).fileOnly).toBe(false);
    // no record, or a record of another name, reads in the safe direction: file-only
    expect(parseNodeTap(tap, f, []).fileOnly).toBe(true);
    expect(parseNodeTap(tap, f, [{ name: "other", line: 2, column: 1 }]).fileOnly).toBe(true);
  });

  it("reads only TOP-LEVEL summary lines and names failing tests, not TODO ones", () => {
    const t = parseNodeTap(TAP_RED);
    expect(t.tests).toBe(3);
    expect(t.fail).toBe(1);
    expect(t.todo).toBe(1);
    expect(t.failedNames).toEqual(["inner", "outer"]);
  });

  it("does not name a skipped `not ok` line as a failure", () => {
    const tap = ["TAP version 13", "not ok 1 - flaky # SKIP not today", "not ok 2 - real", "1..2", "# tests 2", "# fail 1", "# skipped 1"].join("\n");
    expect(parseNodeTap(tap).failedNames).toEqual(["real"]);
  });

  it("returns summary:false when no top-level `# tests` line was printed (fail-closed)", () => {
    expect(parseNodeTap("TAP version 13\n    # tests 4\n").summary).toBe(false);
    expect(parseNodeTap("").summary).toBe(false);
    expect(parseNodeTap(undefined).summary).toBe(false);
  });
});

describe("foldNodeRuns — per-file node:test runs as one suite result", () => {
  it("a green run of every file is ok, complete and reported", () => {
    const r = nodeGreen(["test/a.test.mjs", "test/b.test.mjs"]);
    expect(r).toMatchObject({ ok: true, exitCode: 0, reportOk: true, numTotalTests: 6, numFailedTests: 0 });
    expect(r.executedFiles).toEqual(["test/a.test.mjs", "test/b.test.mjs"]);
  });

  it("a failing file makes the suite red and names its failures by file", () => {
    const r = foldNodeRuns([
      { file: "test/a.test.mjs", exitCode: 0, tap: TAP_GREEN },
      { file: "test/b.test.mjs", exitCode: 1, tap: TAP_RED },
    ]);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.numFailedTests).toBe(1);
    expect(r.failedTestNames).toEqual(["test/b.test.mjs › inner", "test/b.test.mjs › outer"]);
  });

  it("a file that registers no test is NOT executed", () => {
    const r = foldNodeRuns([
      { file: "test/a.test.mjs", exitCode: 0, tap: TAP_GREEN },
      { file: "test/empty.test.mjs", exitCode: 0, tap: TAP_EMPTY },
    ]);
    expect(r.ok).toBe(true);
    expect(r.executedFiles).toEqual(["test/a.test.mjs"]);
  });

  it("a file node reports as its own one test is NOT executed, and that pseudo-test is not counted", () => {
    const r = foldNodeRuns([
      { file: "test/a.test.mjs", exitCode: 0, tap: TAP_GREEN },
      { file: "test/empty.test.mjs", exitCode: 0, tap: tapFileOnly("test/empty.test.mjs") },
    ]);
    expect(r.ok).toBe(true);
    expect(r.executedFiles).toEqual(["test/a.test.mjs"]);
    expect(r.numTotalTests).toBe(3);
  });

  it("a run without a summary loses the report and is not ok, even at exit 0", () => {
    const r = foldNodeRuns([{ file: "test/a.test.mjs", exitCode: 0, tap: "garbage" }]);
    expect(r).toMatchObject({ ok: false, reportOk: false, executedFiles: [] });
  });

  it("no files at all is never ok", () => {
    expect(foldNodeRuns([])).toMatchObject({ ok: false, reportOk: false });
  });

  it("a non-zero exit is not ok even when the TAP summary reads green", () => {
    const r = foldNodeRuns([{ file: "test/a.test.mjs", exitCode: 1, tap: TAP_GREEN }]);
    expect(r).toMatchObject({ ok: false, exitCode: 1, reportOk: true, numFailedTests: 0 });
    expect(r.executedFiles).toEqual(["test/a.test.mjs"]);
  });

  it("a cancelled test is not ok and counts as failed, even at exit 0", () => {
    const tap = TAP_GREEN.replace("# pass 3", "# pass 2").replace("# cancelled 0", "# cancelled 1");
    const r = foldNodeRuns([{ file: "test/a.test.mjs", exitCode: 0, tap }]);
    expect(r).toMatchObject({ ok: false, exitCode: 0, reportOk: true, numFailedTests: 1 });
  });

  it("counts skipped and todo tests as pending, across files", () => {
    const tap = TAP_GREEN.replace("# skipped 0", "# skipped 1").replace("# todo 0", "# todo 2");
    const r = foldNodeRuns([
      { file: "test/a.test.mjs", exitCode: 0, tap },
      { file: "test/b.test.mjs", exitCode: 0, tap: TAP_GREEN.replace("# todo 0", "# todo 1") },
    ]);
    expect(r).toMatchObject({ ok: true, numPendingTests: 4 });
  });

  it("a run killed at the file bound loses the report and runs no file, even after a green summary", () => {
    const r = foldNodeRuns([
      { file: "test/a.test.mjs", exitCode: 0, tap: TAP_GREEN },
      { file: "test/b.test.mjs", exitCode: -1, tap: TAP_GREEN, timedOut: true },
    ]);
    expect(r).toMatchObject({ ok: false, reportOk: false, exitCode: -1, timedOutFiles: ["test/b.test.mjs"] });
    expect(r.executedFiles).toEqual(["test/a.test.mjs"]);
  });

  it("a run killed by a signal (exit code null) is not ok and reads as exit -1", () => {
    const r = foldNodeRuns([{ file: "test/a.test.mjs", exitCode: null, tap: TAP_GREEN }]);
    expect(r).toMatchObject({ ok: false, exitCode: -1 });
  });
});

describe("runNodeTestFile — a child that cannot start", () => {
  it("resolves as exit -1 with no TAP, which folds into a lost report", async () => {
    const run = await runNodeTestFile({ cwd: "/nonexistent-extension-suite-gate-dir", file: "test/a.test.mjs" });
    expect(run).toMatchObject({ file: "test/a.test.mjs", exitCode: -1, tap: "" });
    expect(foldNodeRuns([run])).toMatchObject({ ok: false, reportOk: false, exitCode: -1 });
  });
});

// Small node:test files for the runner cases, written to one temporary folder.
const NODE_FIXTURES = {
  "t/two.test.mjs": `import { test } from "node:test";\ntest("one", () => {});\ntest("two", () => {});\n`,
  "t/empty.test.mjs": `import "node:test";\n`,
  "t/same.test.mjs": `import { test } from "node:test";\ntest("t/same.test.mjs", () => {});\n`,
  "t/loaderr.test.mjs": `import { test } from "node:test";\ntest("never", () => {});\nthrow new Error("boom at load");\n`,
  "t/hang.test.mjs": `import { test } from "node:test";\ntest("hang", async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });\n`,
  "t/spin.test.mjs": `import { test } from "node:test";\ntest("spin", () => { for (;;) {} });\n`,
  "t/loud.test.mjs": `import { test } from "node:test";\nprocess.stdout.write("x".repeat(450000) + "\\n");\ntest("after the noise", () => {});\n`,
};
const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "esg-node-"));
for (const [file, src] of Object.entries(NODE_FIXTURES)) {
  fs.mkdirSync(path.dirname(path.join(nodeDir, file)), { recursive: true });
  fs.writeFileSync(path.join(nodeDir, file), src);
}
afterAll(() => fs.rmSync(nodeDir, { recursive: true, force: true }));
const runFixture = (file, bounds = {}) => runNodeTestFile({ cwd: nodeDir, file, testTimeoutMs: 2000, fileTimeoutMs: 20_000, ...bounds });

describe("nodeTopLevelReporter and readTopLevel — one record per top-level test", () => {
  it("writes the name and location of each top-level pass or fail, and nothing else", async () => {
    async function* events() {
      yield { type: "test:start", data: { nesting: 0, name: "a", line: 2, column: 1 } };
      yield { type: "test:pass", data: { nesting: 1, name: "inner", line: 3, column: 3 } };
      yield { type: "test:pass", data: { nesting: 0, name: "a", line: 2, column: 1 } };
      yield { type: "test:fail", data: { nesting: 0, name: "b", line: 5, column: 1 } };
      yield { type: "test:stdout", data: { nesting: 0, message: '{"name":"spoof","line":9,"column":9}' } };
    }
    const lines = [];
    for await (const l of nodeTopLevelReporter(events())) lines.push(l);
    expect(lines).toEqual(['{"name":"a","line":2,"column":1}\n', '{"name":"b","line":5,"column":1}\n']);
    expect(readTopLevel(lines.join(""))).toEqual([
      { name: "a", line: 2, column: 1 },
      { name: "b", line: 5, column: 1 },
    ]);
  });

  it("reads nothing from a missing file or a line that is not a record", () => {
    expect(readTopLevel(undefined)).toEqual([]);
    expect(readTopLevel('not json\n{"line":1}\n')).toEqual([]);
  });
});

describe("runNodeTestFile — the real node runner, with short bounds", () => {
  it("bounds each test, ends the file with its tests, and writes the top-level records to their own file", () => {
    const args = nodeTestArgs("t/a.test.mjs", "/tmp/rec.jsonl", 1234);
    expect(args).toEqual([
      "--test",
      "--test-reporter=tap",
      "--test-reporter-destination=stdout",
      expect.stringMatching(/^--test-reporter=file:\/\/.*\/scripts\/ci\/extension-suite-gate\.mjs$/),
      "--test-reporter-destination=/tmp/rec.jsonl",
      "--test-timeout=1234",
      "--test-force-exit",
      "t/a.test.mjs",
    ]);
    expect(nodeTestArgs("t/a.test.mjs", "/tmp/rec.jsonl")).toContain(`--test-timeout=${NODE_TEST_TIMEOUT_MS}`);
    expect(NODE_TEST_TIMEOUT_MS).toBe(30_000);
    expect(NODE_FILE_TIMEOUT_MS).toBe(300_000);
  });

  it("a green file exits 0 with its summary and folds as executed", async () => {
    const run = await runFixture("t/two.test.mjs");
    expect(run).toMatchObject({ file: "t/two.test.mjs", exitCode: 0 });
    expect(run.timedOut).toBeUndefined();
    expect(parseNodeTap(run.tap)).toMatchObject({ summary: true, tests: 2, pass: 2, fail: 0 });
    expect(foldNodeRuns([run])).toMatchObject({ ok: true, reportOk: true, executedFiles: ["t/two.test.mjs"], numTotalTests: 2 });
  });

  it("a file that registers no test runs none, and a real test named by the file's path is a test", async () => {
    const empty = await runFixture("t/empty.test.mjs");
    const same = await runFixture("t/same.test.mjs");
    expect(empty.topLevel).toEqual([{ name: "t/empty.test.mjs", line: 1, column: 1 }]);
    expect(same.topLevel).toEqual([{ name: "t/same.test.mjs", line: 2, column: 1 }]);
    expect(parseNodeTap(empty.tap, empty.file, empty.topLevel)).toMatchObject({ summary: true, tests: 1, fileOnly: true });
    expect(parseNodeTap(same.tap, same.file, same.topLevel)).toMatchObject({ summary: true, tests: 1, pass: 1, fileOnly: false });
    const r = foldNodeRuns([empty, same]);
    expect(r).toMatchObject({ ok: true, executedFiles: ["t/same.test.mjs"], numTotalTests: 1 });
  });

  it("a file that throws at load is not ok", async () => {
    const run = await runFixture("t/loaderr.test.mjs");
    expect(run.exitCode).not.toBe(0);
    expect(foldNodeRuns([run]).ok).toBe(false);
  });

  it("a test that hangs is ended at the per-test timeout, named as failed, and its file still exits", async () => {
    const run = await runFixture("t/hang.test.mjs", { testTimeoutMs: 300 });
    expect(run.timedOut).toBeUndefined();
    expect(run.exitCode).not.toBe(0);
    const r = foldNodeRuns([run]);
    expect(r).toMatchObject({ ok: false, reportOk: true });
    expect(r.failedTestNames).toEqual(["t/hang.test.mjs › hang"]);
  });

  it("a file still running at the file bound is killed, and its run reads as a lost report", async () => {
    const started = Date.now();
    const run = await runFixture("t/spin.test.mjs", { fileTimeoutMs: 1500 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(run).toMatchObject({ file: "t/spin.test.mjs", exitCode: -1, timedOut: true });
    expect(run.detail).toContain("was still running after 1500 ms and was killed");
    // the process group is gone, not only the wait for it
    await new Promise((r) => setTimeout(r, 500));
    expect(() => process.kill(run.pid, 0)).toThrow();
    const res = foldNodeRuns([run]);
    expect(res).toMatchObject({ ok: false, reportOk: false, exitCode: -1, timedOutFiles: ["t/spin.test.mjs"], executedFiles: [] });
    const packages = [pkg({ slug: "gated", testFiles: ["x.test.ts"] }), brandVoice({ testFiles: ["t/spin.test.mjs"] })];
    const results = resultsFor([
      ["gated", green(["x.test.ts"])],
      ["brand-voice-artifact", res],
    ]);
    const f = judge({ packages, results, carveOuts: [] }).findings;
    expect(f.map((x) => x.kind)).toEqual(["no-report"]);
    expect(f[0].message).toContain("killed for t/spin.test.mjs");
    expect(renderManifest({ packages, results, carveOuts: [] })).toMatch(/brand-voice-artifact .* node:test here — TIMED OUT \(1 file\(s\) killed\)$/m);
  }, 15_000);

  it("keeps the tail of a long output, where the summary is", async () => {
    const run = await runFixture("t/loud.test.mjs");
    expect(run.tap.length).toBeLessThanOrEqual(400_000);
    expect(parseNodeTap(run.tap)).toMatchObject({ summary: true, tests: 1, pass: 1 });
  });
});

describe("runNodeTest and runNodeSuites — every file of a package, into the shared results map", () => {
  // Any string is a results-map key; these ids are not of the owner/name form of a repository name.
  const nodePkg = { id: "fixture:node-pack", dir: ".", testFiles: ["t/two.test.mjs", "t/empty.test.mjs"] };

  it("runs every file of the package and names each run in the detail", async () => {
    const res = await runNodeTest({ repoRoot: nodeDir, pkg: nodePkg, testTimeoutMs: 2000, fileTimeoutMs: 20_000 });
    expect(res).toMatchObject({ ok: true, executedFiles: ["t/two.test.mjs"], numTotalTests: 2 });
    expect(res.detail).toMatch(/^--- node --test t\/two\.test\.mjs \(exit 0\)$/m);
    expect(res.detail).toMatch(/^--- node --test t\/empty\.test\.mjs \(exit 0\)$/m);
  });

  it("adds each node:test result to the vitest results map by its id, keeping the vitest entries", async () => {
    const vitestRes = green(["x.test.ts"]);
    const results = new Map([["fixture:gated", vitestRes]]);
    const lines = [];
    const out = await runNodeSuites({ repoRoot: nodeDir, nodeRun: [nodePkg], jobs: 2, results, log: (l) => lines.push(l), testTimeoutMs: 2000, fileTimeoutMs: 20_000 });
    expect(out).toBe(results);
    expect([...results.keys()].sort()).toEqual(["fixture:gated", "fixture:node-pack"]);
    expect(results.get("fixture:gated")).toBe(vitestRes);
    expect(results.get("fixture:node-pack")).toMatchObject({ ok: true, executedFiles: ["t/two.test.mjs"] });
    expect(lines.some((l) => l.startsWith("::group::PASS fixture:node-pack [node:test]"))).toBe(true);
  });

  it("does nothing and prints nothing when no package is on the node:test road", async () => {
    const results = new Map();
    const lines = [];
    await runNodeSuites({ repoRoot: nodeDir, nodeRun: [], jobs: 2, results, log: (l) => lines.push(l) });
    expect(results.size).toBe(0);
    expect(lines).toEqual([]);
  });
});

describe("the node:test road — a skipping node:test package is RUN here", () => {
  it("brand-voice-artifact's shape (dec0bb58) classifies as a node:test package only this gate can run", () => {
    const bv = brandVoice();
    expect(bv).toMatchObject({ runner: "other", runnerEvidence: "node-test", standaloneTestsSkipped: true });
    expect(isHostRunNodeTest(bv)).toBe(true);
    expect(planRun({ packages: [bv], carveOuts: [] }).nodeRun.map((p) => p.id)).toEqual(["cinatra-ai/brand-voice-artifact"]);
  });

  it("is NOT on the road when its own CI runs it, when no runner is named, or when it has no test file", () => {
    expect(isHostRunNodeTest(brandVoice({ ciWorkflow: "run: corepack pnpm test" }))).toBe(false);
    expect(isHostRunNodeTest(brandVoice({ readTestSource: () => "it('x', () => {});" }))).toBe(false);
    expect(isHostRunNodeTest({ ...brandVoice(), testFiles: [] })).toBe(false);
    expect(isHostRunNodeTest(pkg({ slug: "v" }))).toBe(false);
  });

  it("a green, complete run passes and the dishonest-skip finding no longer fires", () => {
    const packages = [pkg({ slug: "gated", testFiles: ["x.test.ts"] }), brandVoice()];
    const results = resultsFor([
      ["gated", green(["x.test.ts"])],
      ["brand-voice-artifact", nodeGreen(["test/own-type.test.mjs"])],
    ]);
    expect(judge({ packages, results, carveOuts: [] }).findings).toEqual([]);
  });

  it("never executed FAILS as not-run (the claim is still unmet)", () => {
    const packages = [pkg({ slug: "gated", testFiles: ["x.test.ts"] }), brandVoice()];
    const results = resultsFor([["gated", green(["x.test.ts"])]]);
    const kinds = judge({ packages, results, carveOuts: [] }).findings.map((f) => [f.kind, f.slug]);
    expect(kinds).toEqual([["not-run", "brand-voice-artifact"]]);
  });

  it("a red run FAILS as suite-red", () => {
    const packages = [pkg({ slug: "gated", testFiles: ["x.test.ts"] }), brandVoice()];
    const results = resultsFor([
      ["gated", green(["x.test.ts"])],
      ["brand-voice-artifact", foldNodeRuns([{ file: "test/own-type.test.mjs", exitCode: 1, tap: TAP_RED }])],
    ]);
    const kinds = judge({ packages, results, carveOuts: [] }).findings.map((f) => f.kind);
    expect(kinds).toEqual(["suite-red"]);
  });

  it("a file that ran no test FAILS as uncollected, even when the run is green", () => {
    const packages = [pkg({ slug: "gated", testFiles: ["x.test.ts"] }), brandVoice({ testFiles: ["test/a.test.mjs", "test/own-type.test.mjs"] })];
    const results = resultsFor([
      ["gated", green(["x.test.ts"])],
      [
        "brand-voice-artifact",
        foldNodeRuns([
          { file: "test/a.test.mjs", exitCode: 0, tap: TAP_EMPTY },
          { file: "test/own-type.test.mjs", exitCode: 0, tap: TAP_GREEN },
        ]),
      ],
    ]);
    const f = judge({ packages, results, carveOuts: [] }).findings;
    expect(f.map((x) => x.kind)).toEqual(["uncollected-files"]);
    expect(f[0].message).toContain("test/a.test.mjs");
  });

  it("a file that node reports as its own one passing test FAILS as uncollected (what node 24 prints for an empty file)", () => {
    const packages = [pkg({ slug: "gated", testFiles: ["x.test.ts"] }), brandVoice({ testFiles: ["test/empty.test.mjs", "test/own-type.test.mjs"] })];
    const results = resultsFor([
      ["gated", green(["x.test.ts"])],
      [
        "brand-voice-artifact",
        foldNodeRuns([
          { file: "test/empty.test.mjs", exitCode: 0, tap: tapFileOnly("test/empty.test.mjs") },
          { file: "test/own-type.test.mjs", exitCode: 0, tap: TAP_GREEN },
        ]),
      ],
    ]);
    const f = judge({ packages, results, carveOuts: [] }).findings;
    expect(f.map((x) => x.kind)).toEqual(["uncollected-files"]);
    expect(f[0].message).toContain("test/empty.test.mjs");
  });

  it("a lost TAP summary FAILS as no-report and is not also judged as red", () => {
    const packages = [pkg({ slug: "gated", testFiles: ["x.test.ts"] }), brandVoice()];
    const results = resultsFor([
      ["gated", green(["x.test.ts"])],
      ["brand-voice-artifact", foldNodeRuns([{ file: "test/own-type.test.mjs", exitCode: 0, tap: "" }])],
    ]);
    expect(judge({ packages, results, carveOuts: [] }).findings.map((f) => f.kind)).toEqual(["no-report"]);
  });

  it("a ledger entry never exempts a node:test package, and is reported as stale", () => {
    const packages = [pkg({ slug: "gated", testFiles: ["x.test.ts"] }), brandVoice()];
    const results = resultsFor([["gated", green(["x.test.ts"])]]);
    const out = judge({ packages, results, carveOuts: [carve("brand-voice-artifact")] });
    expect(out.carved).toEqual([]);
    expect(out.findings.map((f) => f.kind)).toContain("not-run");
    expect(out.notices.map((n) => [n.kind, n.slug])).toEqual([["stale-carve-out", "cinatra-ai/brand-voice-artifact"]]);
    expect(out.notices[0].message).toContain("no longer a vitest suite (runner=other)");
  });

  it("a checkout with local modifications stays on the road and is judged", () => {
    const bv = brandVoice({ dirty: true });
    expect(planRun({ packages: [bv], carveOuts: [] }).nodeRun.map((p) => p.id)).toEqual(["cinatra-ai/brand-voice-artifact"]);
    const packages = [pkg({ slug: "gated", testFiles: ["x.test.ts"] }), bv];
    const results = resultsFor([
      ["gated", green(["x.test.ts"])],
      ["brand-voice-artifact", foldNodeRuns([{ file: "test/own-type.test.mjs", exitCode: 1, tap: TAP_RED }])],
    ]);
    expect(judge({ packages, results, carveOuts: [] }).findings.map((f) => f.kind)).toEqual(["suite-red"]);
  });

  it("shows on the manifest as run here, with its own status", () => {
    const packages = [brandVoice()];
    const ok = renderManifest({ packages, results: resultsFor([["brand-voice-artifact", nodeGreen(["test/own-type.test.mjs"])]]), carveOuts: [] });
    expect(ok).toMatch(/brand-voice-artifact .* node:test here — ok$/m);
    const notRun = renderManifest({ packages, results: new Map(), carveOuts: [] });
    expect(notRun).toMatch(/brand-voice-artifact .* node:test here — NOT RUN$/m);
  });

  it("shows a red run as RED with its exit code, and a file that ran no test as INCOMPLETE", () => {
    const red = renderManifest({
      packages: [brandVoice()],
      results: resultsFor([["brand-voice-artifact", foldNodeRuns([{ file: "test/own-type.test.mjs", exitCode: 1, tap: TAP_RED }])]]),
      carveOuts: [],
    });
    expect(red).toMatch(/brand-voice-artifact .* node:test here — RED \(exit 1\)$/m);
    const lost = renderManifest({
      packages: [brandVoice()],
      results: resultsFor([["brand-voice-artifact", foldNodeRuns([{ file: "test/own-type.test.mjs", exitCode: 0, tap: "" }])]]),
      carveOuts: [],
    });
    expect(lost).toMatch(/brand-voice-artifact .* node:test here — NO REPORT \(exit 0\)$/m);
    const files = ["test/empty.test.mjs", "test/own-type.test.mjs"];
    const incomplete = renderManifest({
      packages: [brandVoice({ testFiles: files })],
      results: resultsFor([
        [
          "brand-voice-artifact",
          foldNodeRuns([
            { file: files[0], exitCode: 0, tap: tapFileOnly(files[0]) },
            { file: files[1], exitCode: 0, tap: TAP_GREEN },
          ]),
        ],
      ]),
      carveOuts: [],
    });
    expect(incomplete).toMatch(/brand-voice-artifact .* node:test here — INCOMPLETE \(1 file\(s\) ran no test\)$/m);
  });
});

describe('judge — check 5: "not vitest" must rest on evidence', () => {
  // The last discovery escape a signal-based classifier has: a suite written
  // against vitest's GLOBALS in a package that ships no config, names vitest in
  // no script or dependency, and imports it nowhere. Every vitest signal misses,
  // so it lands in "other" — and "other" is only safe when something ELSE
  // demonstrably runs it.
  const mystery = (over = {}) =>
    pkg({
      slug: "globals-only",
      runner: "other",
      runnerEvidence: "unknown",
      testScript: "echo ok",
      standaloneTestsSkipped: false,
      testFiles: ["src/a.test.ts"],
      ...over,
    });

  it("FAILS when a package ships test files and no runner can be identified at all", () => {
    const packages = [pkg({ slug: "gated", testFiles: ["x.test.ts"] }), mystery()];
    const results = resultsFor([["gated", green(["x.test.ts"])]]);
    const f = judge({ packages, results, carveOuts: [] }).findings.find((x) => x.kind === "unidentified-runner");
    expect(f.slug).toBe("globals-only");
    expect(f.message).toContain("src/a.test.ts");
    expect(f.message).toContain("which is a claim, not a proof");
  });

  it("does NOT fire when a test source names node:test — another runner provably exists", () => {
    const packages = [pkg({ slug: "gated", testFiles: ["x.test.ts"] }), mystery({ runnerEvidence: "node-test" })];
    const results = resultsFor([["gated", green(["x.test.ts"])]]);
    expect(judge({ packages, results, carveOuts: [] }).findings).toEqual([]);
  });

  it("defers to dishonest-skip so one package is named once, by the sharper rule", () => {
    const packages = [pkg({ slug: "gated", testFiles: ["x.test.ts"] }), mystery({ standaloneTestsSkipped: true })];
    const results = resultsFor([["gated", green(["x.test.ts"])]]);
    const kinds = judge({ packages, results, carveOuts: [] }).findings.map((x) => x.kind);
    expect(kinds).toEqual(["dishonest-skip"]);
  });

  it("never fires for a package this gate actually runs", () => {
    const packages = [pkg({ slug: "gated", testFiles: ["x.test.ts"] })];
    const results = resultsFor([["gated", green(["x.test.ts"])]]);
    expect(judge({ packages, results, carveOuts: [] }).findings).toEqual([]);
  });
});

describe("fenceWorkflowCommands — companion test output cannot forge a workflow command", () => {
  it("neuters a leading :: marker while leaving ordinary text alone", () => {
    const out = fenceWorkflowCommands("ok\n::error::forged\n  ::endgroup::\nnot::a::command");
    expect(out).not.toMatch(/^\s*::(error|endgroup)/m);
    expect(out).toContain("not::a::command");
    expect(out).toContain("ok");
  });
});

describe("renderManifest — every package is visible, so truncation cannot be silent", () => {
  it("lists enforced, carved, non-vitest and empty packages with distinguishable statuses", () => {
    const packages = [
      pkg({ slug: "green-one", testFiles: ["x.test.ts"] }),
      pkg({ slug: "carved-one", testFiles: ["y.test.ts"] }),
      pkg({ slug: "incomplete-one", testFiles: ["a.test.ts", "b.test.ts"] }),
      pkg({ slug: "node-test-one", runner: "other", testScript: "node --test", standaloneTestsSkipped: false, testFiles: ["c.test.mjs"] }),
      pkg({ slug: "empty-one", runner: "none", testFiles: [] }),
    ];
    const results = resultsFor([
      ["green-one", green(["x.test.ts"])],
      ["carved-one", { ...green([]), ok: false, exitCode: 1, numFailedTests: 1, executedFiles: ["y.test.ts"] }],
      ["incomplete-one", green(["a.test.ts"])],
    ]);
    const out = renderManifest({ packages, results, carveOuts: [carve("carved-one")] });
    expect(out).toMatch(/green-one .* ok$/m);
    expect(out).toMatch(/carved-one .* CARVED \(documented defect, at pin; see ledger\)$/m);
    expect(out).toMatch(/incomplete-one .* INCOMPLETE \(1 file\(s\) not executed\)$/m);
    expect(out).toMatch(/node-test-one .* node:test; its own CI runs `node --test`$/m);
    expect(out).toMatch(/empty-one .* no test files$/m);
  });

  it("shows an unidentified runner as a GUESS, never as `its own CI runs …`", () => {
    const packages = [
      pkg({ slug: "mystery", runner: "other", runnerEvidence: "unknown", testScript: "echo ok", standaloneTestsSkipped: false, testFiles: ["a.test.ts"] }),
    ];
    const out = renderManifest({ packages, results: new Map(), carveOuts: [] });
    expect(out).toMatch(/mystery .* UNIDENTIFIED RUNNER/m);
    expect(out).not.toContain("its own CI runs `echo ok`");
  });

  it("flags a carved package whose shape drifted rather than quietly showing it as carved-and-fine", () => {
    const packages = [pkg({ slug: "drifted", testFiles: ["a.test.ts"] })];
    const results = resultsFor([["drifted", green(["a.test.ts"])]]);
    const out = renderManifest({ packages, results, carveOuts: [carve("drifted", { exitCode: 1, totalTests: 3, failedTests: 6, uncollected: [] })] });
    expect(out).toMatch(/drifted .* CARVED — SHAPE DRIFT/m);
  });

  it("shows a package whose ledger entry no longer applies as an ordinary enforced row", () => {
    const packages = [pkg({ slug: "bumped", sha: MOVED, testFiles: ["a.test.ts"] })];
    const results = resultsFor([["bumped", green(["a.test.ts"])]]);
    const out = renderManifest({ packages, results, carveOuts: [carve("bumped")] });
    expect(out).toMatch(/bumped .* ok$/m);
  });
});
