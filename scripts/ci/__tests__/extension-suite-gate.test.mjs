// The pure core of scripts/ci/extension-suite-gate.mjs (cinatra#2288 slice 2):
// classification, report parsing, run planning, shape matching and the finding
// rules. Every input is data, so the whole rule set is exercised without
// spawning a single vitest process.
//
// The cases below are not hypotheticals — each one is a shape observed on the
// materialized tree at the pins this gate landed against, named in the test
// title so a future reader can tell a real regression from a fixture edit.
import { describe, expect, it } from "vitest";

import {
  classifyPackage,
  fenceWorkflowCommands,
  isFirstPartyMirror,
  judge,
  observedShape,
  parseReport,
  planRun,
  renderManifest,
  resolveMaterializedSha,
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
  it("FAILS when a repo skips its tests standalone and this gate does not run them", () => {
    const packages = [
      pkg({ slug: "gated", testFiles: ["x.test.ts"] }),
      pkg({ slug: "orphan", runner: "other", testFiles: ["tests/a.test.mjs"], standaloneTestsSkipped: true }),
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
