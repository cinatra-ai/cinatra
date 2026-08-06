import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractRunBlocks,
  pinnedTestsInBlock,
  findMissingPinnedTests,
  resolveWorkflowPins,
  parseRootVitestTestGlobs,
  parseArrayElements,
  parseConditionalSpread,
  splitTopLevelElements,
  extractArrayLiteral,
  stripLineComments,
  stripShellComment,
  reachesRunner,
  runnerArgv,
  argvUntilRedirect,
  splitShellSegments,
  invokesRootSuite,
  rootSuiteScriptRunsVitest,
  jobIsLiterallyDisabled,
  isLiterallyFalse,
  findRootSuiteInvocations,
  globToRegExp,
  ridesRootVitestRun,
  auditTestFiles,
  findUngatedAuditTests,
  findStaleRootExclusions,
  trackedTestPaths,
  shellTokens,
  wholesaleVitestArgv,
  packageScriptIsWholesaleVitest,
  packageScriptInvocation,
  segmentTargetDir,
  findWholesalePackageRuns,
  parseVitestTestGlobs,
  packageDiscoverySet,
  readPackageSuiteExceptions,
  auditPackageSuiteRunners,
  isNonUnitTierFile,
  hasUnquotedExpansion,
  hasTopLevelRedirect,
  workflowRunsOnChanges,
  splitShellCommands,
  stepContinuesOnError,
  jobContinuesOnError,
  isLiterallyTrue,
  groupShellLists,
  errexitSetting,
  isErrexitBashShell,
  findRivalVitestConfig,
  resolveEnforcedPins,
  rootSuiteIsEnforced,
  packageTestFiles,
  enforcingSegmentsInBlock,
  runKeyIsStep,
  stripEnvPrefix,
  hasTerminalFlag,
  isShellControlCommand,
  invocationCannotProveExecution,
  jobRunsOnLinux,
  testBlockHasShorthand,
  PACKAGE_EXCEPTIONS_FILE,
  AUDIT_TEST_DIR,
  REPO_ROOT,
} from "../ci-pinned-tests-exist.mjs";

describe("ci-pinned-tests-exist — run-block extraction", () => {
  it("extracts inline, block-literal (|) and folded (>-) run scripts", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: pnpm exec vitest run src/x.test.ts --no-coverage",
      "      - name: folded",
      "        run: >-",
      "          pnpm exec vitest run",
      "          src/y.test.ts",
      "          src/z.test.ts",
      "      - run: |",
      "          cd packages/p && pnpm exec vitest run src/w.test.ts && cd ../..",
      "      - uses: actions/checkout@v4",
    ].join("\n");
    const blocks = extractRunBlocks(yaml);
    expect(blocks.length).toBe(3);
    expect(blocks[0].body).toContain("src/x.test.ts");
    expect(blocks[1].body).toContain("src/y.test.ts");
    expect(blocks[1].body).toContain("src/z.test.ts");
    expect(blocks[2].body).toContain("packages/p");
  });
});

describe("ci-pinned-tests-exist — token + cwd resolution", () => {
  it("collects root-relative tokens from a folded block (cwd empty)", () => {
    const body = "pnpm exec vitest run\nsrc/a.test.ts\nsrc/b.test.tsx\n--no-coverage";
    const pins = pinnedTestsInBlock(body, "folded");
    expect(pins.map((p) => p.token).sort()).toEqual(["src/a.test.ts", "src/b.test.tsx"]);
    expect(pins.every((p) => p.cwd === "")).toBe(true);
  });

  it("scopes a token to its `cd <pkg>` and resets on `cd ../..`", () => {
    const body = "cd packages/objects && pnpm exec vitest run src/__tests__/x.test.ts --no-coverage && cd ../..";
    const pins = pinnedTestsInBlock(body);
    expect(pins).toEqual([{ token: "src/__tests__/x.test.ts", cwd: "packages/objects", runner: "vitest", narrowed: false }]);
  });

  it("ignores glob filters and non-runner segments", () => {
    const body = "pnpm exec vitest run src/lib/authz --exclude '**/build-actor-context-from-run.test.ts'";
    expect(pinnedTestsInBlock(body)).toEqual([]); // glob token skipped; dir filter has no .test. token
    expect(pinnedTestsInBlock("echo src/not-a-runner.test.ts")).toEqual([]);
  });

  it("recognizes `node --test` as a runner", () => {
    const pins = pinnedTestsInBlock("node --test scripts/audit/__tests__/foo.test.mjs");
    expect(pins).toEqual([{ token: "scripts/audit/__tests__/foo.test.mjs", cwd: "", runner: "node", narrowed: false }]);
  });

  it("requires the runner in COMMAND position — quoted text, comments and other commands do not count", () => {
    expect(reachesRunner("node --test x.test.mjs")).toBe("node");
    expect(reachesRunner("pnpm exec vitest run x.test.ts")).toBe("vitest");
    expect(reachesRunner("CI=1 pnpm --filter @scope/a exec vitest run x.test.ts")).toBe("vitest");
    expect(reachesRunner("timeout --kill-after=60 780 pnpm exec vitest run x.test.ts")).toBe("vitest");
    // …and the shapes that execute nothing
    expect(reachesRunner('echo "node --test x.test.mjs"')).toBe(null);
    expect(reachesRunner("# node --test x.test.mjs")).toBe(null);
    expect(reachesRunner("./run-things.sh vitest run x.test.ts")).toBe(null);
    expect(reachesRunner("git grep 'vitest run' -- x.test.ts")).toBe(null);
    // `cd` does not launch what follows it — `cd . node --test x` is a cd with
    // two arguments, and behind `|| true` it would advertise coverage it lacks.
    expect(reachesRunner("cd . node --test x.test.mjs")).toBe(null);
  });

  it("does not collect pins from an echoed or commented runner phrase", () => {
    expect(pinnedTestsInBlock('echo "node --test a.test.mjs"')).toEqual([]);
    expect(pinnedTestsInBlock("# node --test a.test.mjs")).toEqual([]);
    expect(pinnedTestsInBlock("cd . node --test a.test.mjs")).toEqual([]);
  });

  it("collects only the runner's OWN argv — not a trailing comment or a pre-runner env value", () => {
    expect(stripShellComment("node --test real.test.mjs # dark.test.mjs")).toBe("node --test real.test.mjs ");
    // trailing `#` comment naming another file
    expect(pinnedTestsInBlock("node --test real.test.mjs # dark.test.mjs")).toEqual([
      { token: "real.test.mjs", cwd: "", runner: "node", narrowed: false },
    ]);
    // env assignment BEFORE the runner carries a path that is not an argument
    expect(pinnedTestsInBlock("TARGET=deep/dark.test.mjs node --test real.test.mjs")).toEqual([
      { token: "real.test.mjs", cwd: "", runner: "node", narrowed: false },
    ]);
    // argv itself is still read in full
    expect(runnerArgv("pnpm exec vitest run a.test.ts b.test.ts --no-coverage").argv).toEqual([
      "a.test.ts",
      "b.test.ts",
      "--no-coverage",
    ]);
  });

  it("strips comments BEFORE splitting on separators — a commented-out `&&` must not resurrect its tail", () => {
    // Split-then-strip would leave `node --test dark.test.mjs` as a live segment.
    expect(splitShellSegments("echo ok # && node --test dark.test.mjs").filter((x) => x.trim())).toEqual([
      "echo ok ",
    ]);
    expect(pinnedTestsInBlock("echo ok # && node --test dark.test.mjs")).toEqual([]);
  });

  it("does not credit a redirection TARGET or a post-pipe command", () => {
    // `> dark.test.mjs` is a file the shell TRUNCATES, not a test that runs.
    expect(pinnedTestsInBlock("node --test real.test.mjs > dark.test.mjs").map((p) => p.token)).toEqual([
      "real.test.mjs",
    ]);
    expect(pinnedTestsInBlock("node --test real.test.mjs | echo dark.test.mjs").map((p) => p.token)).toEqual([
      "real.test.mjs",
    ]);
    expect(argvUntilRedirect(["a.test.ts", ">", "b.test.ts"])).toEqual(["a.test.ts"]);
    expect(argvUntilRedirect(["a.test.ts", "2>/dev/null"])).toEqual(["a.test.ts"]);
  });

  it("is quote-aware and control-flow aware — statically dead commands are not credited", () => {
    // a separator INSIDE a quoted string is not a separator
    expect(pinnedTestsInBlock('echo "safe && node --test dark.test.mjs"')).toEqual([]);
    // `#` also starts a comment straight after a separator
    expect(pinnedTestsInBlock("echo safe;# && node --test dark.test.mjs")).toEqual([]);
    // statically dead branches
    expect(pinnedTestsInBlock("true || node --test dark.test.mjs")).toEqual([]);
    expect(pinnedTestsInBlock("false && node --test dark.test.mjs || true")).toEqual([]);
    // …while live chains are untouched
    expect(pinnedTestsInBlock("node --test a.test.mjs && node --test b.test.mjs").map((p) => p.token)).toEqual([
      "a.test.mjs",
      "b.test.mjs",
    ]);
    // a newline ends the dead branch
    expect(
      pinnedTestsInBlock("true || node --test dark.test.mjs\nnode --test real.test.mjs").map((p) => p.token),
    ).toEqual(["real.test.mjs"]);
  });

  it("ignores escaped separators and heredoc BODIES (both are data, not commands)", () => {
    // `\;` is an echoed literal semicolon, so nothing runs after it.
    expect(pinnedTestsInBlock("echo safe \\; node --test dark.test.mjs")).toEqual([]);
    // a heredoc body is `cat` input, not a command list
    expect(
      pinnedTestsInBlock("cat <<EOF\nnode --test dark.test.mjs\nEOF\nnode --test real.test.mjs").map((p) => p.token),
    ).toEqual(["real.test.mjs"]);
    // `<<-` strips leading TABS only, so a tab-indented terminator is real…
    expect(pinnedTestsInBlock("cat <<-EOF\n\tnode --test dark.test.mjs\n\tEOF\n")).toEqual([]);
    // …while a SPACE-indented line is not a terminator for either form, so the
    // body must not end there and expose the commands after it.
    expect(pinnedTestsInBlock("cat <<EOF\n  EOF\nnode --test dark.test.mjs\nEOF")).toEqual([]);
    // several heredocs on one command: their bodies are consumed in order
    expect(
      pinnedTestsInBlock("cat <<A <<B\nx\nA\nnode --test dark.test.mjs\nB\nnode --test real.test.mjs").map(
        (p) => p.token,
      ),
    ).toEqual(["real.test.mjs"]);
  });

  it("skips a step disabled by a literal-false `if:` but keeps an expression-shaped one", () => {
    const disabled = "jobs:\n  a:\n    steps:\n      - name: off\n        if: ${{ false }}\n        run: node --test dark.test.mjs\n";
    expect(extractRunBlocks(disabled)).toEqual([]);
    const live = "jobs:\n  a:\n    steps:\n      - name: on\n        if: ${{ needs.detect.outputs.skip != 'true' }}\n        run: node --test real.test.mjs\n";
    expect(extractRunBlocks(live).length).toBe(1);
    // a trailing YAML comment on the `if:` value must not hide the literal
    const commented = "jobs:\n  a:\n    steps:\n      - name: off\n        if: false # disabled\n        run: node --test dark.test.mjs\n";
    expect(extractRunBlocks(commented)).toEqual([]);
    expect(isLiterallyFalse("false # disabled")).toBe(true);
    expect(isLiterallyFalse("${{ github.event_name == 'push' }}")).toBe(false);
  });

  it("skips every step of a JOB disabled by a literal-false `if:`", () => {
    const off = "jobs:\n  a:\n    if: false\n    steps:\n      - run: node --test dark.test.mjs\n";
    expect(extractRunBlocks(off)).toEqual([]);
    const lines = off.split("\n");
    expect(jobIsLiterallyDisabled(lines, lines.findIndex((l) => l.includes("run:")))).toBe(true);
    const on = "jobs:\n  a:\n    if: ${{ always() }}\n    steps:\n      - run: node --test real.test.mjs\n";
    expect(extractRunBlocks(on).length).toBe(1);
  });

  it("does not credit a `node --test` pin that carries a narrowing flag", () => {
    // `node --test --test-shard=2/2 <file>` exits 0 having run zero tests.
    expect(pinnedTestsInBlock("node --test --test-shard=2/2 a.test.mjs")[0].narrowed).toBe(true);
    expect(pinnedTestsInBlock("node --test --test-name-pattern=x a.test.mjs")[0].narrowed).toBe(true);
    expect(pinnedTestsInBlock("node --test a.test.mjs")[0].narrowed).toBe(false);
    const shard = fixtureRepo(
      `jobs:\n  a:\n    steps:\n      - run: node --test --test-shard=2/2 ${AUDIT_TEST_DIR}/carved.test.mjs\n`,
      [`${AUDIT_TEST_DIR}/carved.test.mjs`],
    );
    const pins = resolveWorkflowPins(shard, join(shard, ".github", "workflows"), [
      `${AUDIT_TEST_DIR}/carved.test.mjs`,
    ]);
    expect(pins.resolved.has(`${AUDIT_TEST_DIR}/carved.test.mjs`)).toBe(true); // the file exists
    expect(pins.nodeExact.has(`${AUDIT_TEST_DIR}/carved.test.mjs`)).toBe(false); // but is not proven to run
  });

  it("resolves a `node --test` pin by EXACT path — never by vitest's suffix semantics", () => {
    // node runs the file it is handed; a same-named file elsewhere is not it.
    const root = fixtureRepo(
      "jobs:\n  a:\n    steps:\n      - run: node --test dup.test.mjs\n",
      ["deep/nested/dup.test.mjs"],
    );
    const { resolved, missing } = resolveWorkflowPins(root, join(root, ".github", "workflows"), [
      "deep/nested/dup.test.mjs",
    ]);
    expect(resolved.has("deep/nested/dup.test.mjs")).toBe(false);
    expect(missing.map((m) => m.token)).toEqual(["dup.test.mjs"]);
    // …while a vitest pin keeps the documented path-suffix behaviour
    const vroot = fixtureRepo("jobs:\n  a:\n    steps:\n      - run: pnpm exec vitest run dup.test.ts\n", []);
    expect(
      resolveWorkflowPins(vroot, join(vroot, ".github", "workflows"), ["deep/nested/dup.test.ts"]).resolved.has(
        "deep/nested/dup.test.ts",
      ),
    ).toBe(true);
  });

  it("follows shell `\\` line-continuations in a literal block", () => {
    const body = "node --test \\\n  scripts/a.test.mjs \\\n  scripts/b.test.mjs --no-coverage";
    const pins = pinnedTestsInBlock(body, "literal");
    expect(pins.map((p) => p.token).sort()).toEqual(["scripts/a.test.mjs", "scripts/b.test.mjs"]);
  });

  it("skips `--exclude=` equals-form values (not a pin)", () => {
    expect(pinnedTestsInBlock("pnpm exec vitest run src/a.test.ts --exclude=src/b.test.ts")).toEqual([
      { token: "src/a.test.ts", cwd: "", runner: "vitest", narrowed: false },
    ]);
  });

  it("scopes `--filter` cwd to its own command, not a later unfiltered runner", () => {
    const pins = pinnedTestsInBlock(
      "pnpm -F @scope/a exec vitest run x.test.ts\npnpm exec vitest run y.test.ts",
      "literal",
      "",
      new Map([["@scope/a", "packages/a"]]),
    );
    expect(pins).toEqual([
      { token: "x.test.ts", cwd: "packages/a", runner: "vitest", narrowed: false },
      { token: "y.test.ts", cwd: "", runner: "vitest", narrowed: false },
    ]);
  });
});

// A throwaway repo root holding one workflow (and optionally some real files),
// so the parser can be driven against hand-built shapes.
function fixtureRepo(workflowBody, files) {
  const root = mkdtempSync(join(tmpdir(), "ci-pin-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, ".github", "workflows", "build-image.yml"), workflowBody);
  for (const f of files) {
    const abs = join(root, f);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "// test");
  }
  return root;
}

describe("ci-pinned-tests-exist — missing detection", () => {
  it("FLAGS a pin whose file exists nowhere (the extension-install-e2e.test.ts class of bug)", () => {
    const root = fixtureRepo(
      "jobs:\n  a:\n    steps:\n      - run: >-\n          pnpm exec vitest run\n          src/lib/__tests__/present.test.ts\n          src/lib/__tests__/ghost.test.ts\n",
      ["src/lib/__tests__/present.test.ts"],
    );
    const missing = findMissingPinnedTests(root, join(root, ".github", "workflows"), ["src/lib/__tests__/present.test.ts"]);
    expect(missing.map((m) => m.token)).toEqual(["src/lib/__tests__/ghost.test.ts"]);
  });

  it("does NOT flag a pin resolvable only via working-directory/--filter (path suffix matches)", () => {
    const root = fixtureRepo("jobs:\n  a:\n    steps:\n      - run: pnpm exec vitest run __tests__/oas.test.ts\n", []);
    // the real file lives under a package dir (the --filter/working-directory case);
    // the pin token is a path-SUFFIX of it → resolved, not flagged.
    const missing = findMissingPinnedTests(root, join(root, ".github", "workflows"), ["packages/agents/src/__tests__/oas.test.ts"]);
    expect(missing).toEqual([]);
  });

  it("STILL flags a missing pin when only a same-basename file exists elsewhere (suffix soundness)", () => {
    const root = fixtureRepo("jobs:\n  a:\n    steps:\n      - run: pnpm exec vitest run src/app/missing/route.test.ts\n", []);
    // a different route.test.ts exists, but NOT at the pinned path → must flag
    const missing = findMissingPinnedTests(root, join(root, ".github", "workflows"), ["src/other/route.test.ts"]);
    expect(missing.map((m) => m.token)).toEqual(["src/app/missing/route.test.ts"]);
  });

  it("STILL flags a cd-scoped pin satisfied only by a sibling-package same-suffix file (cwd-constrained)", () => {
    const root = fixtureRepo(
      "jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/a && pnpm exec vitest run src/__tests__/same.test.ts && cd ../..\n",
      [],
    );
    const missing = findMissingPinnedTests(root, join(root, ".github", "workflows"), ["packages/b/src/__tests__/same.test.ts"]);
    expect(missing.map((m) => m.token)).toEqual(["src/__tests__/same.test.ts"]);
  });

  it("does NOT flag a cd-scoped pin when the EXACT resolved path is tracked", () => {
    const root = fixtureRepo(
      "jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/a && pnpm exec vitest run src/__tests__/same.test.ts && cd ../..\n",
      [],
    );
    const missing = findMissingPinnedTests(root, join(root, ".github", "workflows"), ["packages/a/src/__tests__/same.test.ts"]);
    expect(missing).toEqual([]);
  });

  it("honors step-level working-directory: — flags a sibling-package miss, not the exact-package hit", () => {
    const wf = "jobs:\n  a:\n    steps:\n      - name: x\n        working-directory: packages/a\n        run: pnpm exec vitest run src/__tests__/wd.test.ts\n";
    const rootMiss = fixtureRepo(wf, []);
    expect(
      findMissingPinnedTests(rootMiss, join(rootMiss, ".github", "workflows"), ["packages/b/src/__tests__/wd.test.ts"]).map((m) => m.token),
    ).toEqual(["src/__tests__/wd.test.ts"]); // wrong package → flagged
    const rootHit = fixtureRepo(wf, []);
    expect(
      findMissingPinnedTests(rootHit, join(rootHit, ".github", "workflows"), ["packages/a/src/__tests__/wd.test.ts"]),
    ).toEqual([]); // exact package → resolved
  });

  it("honors working-directory: AFTER run, and as the first `- ` step key", () => {
    // working-directory AFTER run
    const wfAfter = "jobs:\n  a:\n    steps:\n      - run: pnpm exec vitest run src/__tests__/wd.test.ts\n        working-directory: packages/a\n";
    const r1 = fixtureRepo(wfAfter, []);
    expect(
      findMissingPinnedTests(r1, join(r1, ".github", "workflows"), ["packages/b/src/__tests__/wd.test.ts"]).map((m) => m.token),
    ).toEqual(["src/__tests__/wd.test.ts"]);
    // working-directory as the FIRST step key (on the `- ` marker line)
    const wfFirst = "jobs:\n  a:\n    steps:\n      - working-directory: packages/a\n        run: pnpm exec vitest run src/__tests__/wd.test.ts\n";
    const r2 = fixtureRepo(wfFirst, []);
    expect(
      findMissingPinnedTests(r2, join(r2, ".github", "workflows"), ["packages/b/src/__tests__/wd.test.ts"]).map((m) => m.token),
    ).toEqual(["src/__tests__/wd.test.ts"]);
    // ...and the exact-package hit resolves under both shapes
    const r3 = fixtureRepo(wfFirst, []);
    expect(findMissingPinnedTests(r3, join(r3, ".github", "workflows"), ["packages/a/src/__tests__/wd.test.ts"])).toEqual([]);
  });

  it("resolves `pnpm --filter <pkg>` to the package dir — flags a sibling-package miss", () => {
    const wf = "jobs:\n  a:\n    steps:\n      - run: pnpm --filter @scope/a exec vitest run src/__tests__/f.test.ts\n";
    const pkgDirs = new Map([["@scope/a", "packages/a"]]);
    const rootMiss = fixtureRepo(wf, []);
    expect(
      findMissingPinnedTests(rootMiss, join(rootMiss, ".github", "workflows"), ["packages/b/src/__tests__/f.test.ts"], pkgDirs).map((m) => m.token),
    ).toEqual(["src/__tests__/f.test.ts"]); // resolved to packages/a, not satisfied by packages/b
    const rootHit = fixtureRepo(wf, []);
    expect(
      findMissingPinnedTests(rootHit, join(rootHit, ".github", "workflows"), ["packages/a/src/__tests__/f.test.ts"], pkgDirs),
    ).toEqual([]);
  });

  it("the LIVE repo workflows have zero missing pinned tests", () => {
    expect(findMissingPinnedTests(REPO_ROOT)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Direction 2 — every audit-gate suite is executed by SOMETHING.
//
// The negative half is the point: this guard exists because an audit suite can
// be carved out of the root vitest include (the node:test convention) without
// anyone adding the `node --test` step on the other side, and nothing said so.
// ---------------------------------------------------------------------------

describe("root vitest config parsing", () => {
  it("strips // comments but leaves a // inside a string literal alone", () => {
    expect(stripLineComments('const a = "x"; // drop me\nconst b = "http://keep";')).toBe(
      'const a = "x"; \nconst b = "http://keep";',
    );
  });

  it("extracts a bracket-balanced array literal, nested arrays included", () => {
    const src = 'test: { include: ["a/*", ...(f ? [] : ["b/*"])], exclude: ["c/*"] }';
    expect(extractArrayLiteral(src, "include")).toContain('"b/*"');
    expect(extractArrayLiteral(src, "exclude")).toContain('"c/*"');
  });

  it("REFUSES an absent or duplicated key rather than returning an empty set", () => {
    expect(() => extractArrayLiteral("test: { exclude: [] }", "include")).toThrow(/found 0/);
    expect(() => extractArrayLiteral('{ include: ["a/*"], x: { include: ["b/*"] } }', "include")).toThrow(/found 2/);
  });

  it("splits top-level elements without breaking on commas inside a spread or a string", () => {
    expect(splitTopLevelElements('"a/*", ...(f ? [] : ["b/*", "c/*"]), "d,e/*"')).toEqual([
      '"a/*"',
      '...(f ? [] : ["b/*", "c/*"])',
      '"d,e/*"',
    ]);
  });

  it("folds a conditional tier's literals into exclude and drops the ternary CONDITION operand", () => {
    const src = 'test: {\n include: ["src/**/*.test.ts"],\n exclude: [\n "**/node_modules/**",\n ...(process.env.FLAG === "1" ? [] : ["**/*.integration.test.ts"]),\n ],\n}';
    const { include, exclude } = parseRootVitestTestGlobs(undefined, src);
    expect(include).toEqual(["src/**/*.test.ts"]);
    // the guarded tier literal is kept; the `"1"` condition operand is not
    expect(exclude).toEqual(["**/node_modules/**", "**/*.integration.test.ts"]);
  });

  it("REFUSES an element that is neither a path nor a glob (unmodelled shape)", () => {
    const src = 'test: { include: ["src/**/*.test.ts"], exclude: ["node"] }';
    expect(() => parseRootVitestTestGlobs(undefined, src)).toThrow(/neither a path nor a glob/);
  });

  it("REFUSES a spread of an identifier instead of silently dropping those exclusions", () => {
    // The fail-OPEN shape: `...auditExclusions` parses fine for a naive scanner
    // and quietly removes every exclusion it holds, re-classifying carved-out
    // suites as covered by the root run.
    expect(() => parseArrayElements('"a/*", ...auditExclusions', "exclude", { conditionalSpreads: true })).toThrow(
      /not a plain string literal/,
    );
    expect(() => parseArrayElements('"a/*", someGlobs.map(f)', "exclude", { conditionalSpreads: true })).toThrow(
      /not a plain string literal/,
    );
  });

  it("validates a conditional spread STRUCTURALLY — a non-array branch throws, it is not scraped", () => {
    // Both branches literal → folded in.
    expect(parseConditionalSpread('...(process.env.F === "1" ? [] : ["a/*", "b/*"])', "exclude")).toEqual([
      "a/*",
      "b/*",
    ]);
    // An identifier branch would be silently dropped by a string-scrape; refuse.
    expect(() => parseConditionalSpread('...(f ? auditExclusions : ["known/*"])', "exclude")).toThrow(
      /non-array branch/,
    );
    expect(() => parseConditionalSpread('...(f ? [...more] : ["known/*"])', "exclude")).toThrow(
      /not a plain string literal/,
    );
    expect(() => parseConditionalSpread("...(someCall())", "exclude")).toThrow(/no top-level `\?`/);
  });

  it("REFUSES a conditional spread in include (a spread there would fail OPEN)", () => {
    expect(() => parseArrayElements('...(f ? [] : ["a/*"])', "include", { conditionalSpreads: false })).toThrow(
      /not a plain string literal\. Refusing/,
    );
  });

  it("accepts a conditional spread whose branches are both empty arrays (it contributes nothing)", () => {
    expect(parseArrayElements("...(f ? [] : [])", "exclude", { conditionalSpreads: true })).toEqual([]);
  });

  it("REFUSES an empty include or exclude", () => {
    expect(() => parseRootVitestTestGlobs(undefined, 'test: { include: [], exclude: ["a/*"] }')).toThrow(/EMPTY test.include/);
    expect(() => parseRootVitestTestGlobs(undefined, 'test: { include: ["a/*"], exclude: [] }')).toThrow(/EMPTY test.exclude/);
  });
});

describe("glob matching", () => {
  it("models **/, trailing **, single * and {a,b} alternation", () => {
    expect(globToRegExp("scripts/audit/__tests__/**/*.test.{ts,mjs}").test("scripts/audit/__tests__/x.test.mjs")).toBe(true);
    expect(globToRegExp("scripts/audit/__tests__/**/*.test.{ts,mjs}").test("scripts/audit/__tests__/deep/x.test.ts")).toBe(true);
    expect(globToRegExp("scripts/audit/__tests__/**/*.test.{ts,mjs}").test("scripts/other/__tests__/x.test.ts")).toBe(false);
    // `*` must not cross a path separator
    expect(globToRegExp("src/*/x.test.ts").test("src/a/b/x.test.ts")).toBe(false);
    expect(globToRegExp("src/lib/__tests__/integration/**").test("src/lib/__tests__/integration/a.test.ts")).toBe(true);
    expect(globToRegExp("**/node_modules/**").test("packages/a/node_modules/x.test.ts")).toBe(true);
  });

  it("throws on an unbalanced brace instead of mis-matching", () => {
    expect(() => globToRegExp("a/*.test.{ts")).toThrow(/unbalanced/);
  });

  it("REFUSES glob syntax it does not implement rather than escaping it to a literal", () => {
    // vitest honours a character class; escaping it here would make the
    // exclusion match nothing and the carved-out suites look root-run.
    expect(() => globToRegExp("scripts/audit/__tests__/*.test.[mj]s")).toThrow(/unmodelled glob syntax/);
    expect(() => globToRegExp("src/**/!(vendor)/*.test.ts")).toThrow(/unmodelled glob syntax/);
    // picomatch expands wildcards inside a brace branch; this converter does not
    expect(() => globToRegExp("scripts/audit/__tests__/{foo,*.test.mjs}")).toThrow(/wildcard inside a brace branch/);
  });
});

describe("audit-suite → runner coverage", () => {
  const globs = { include: [`${AUDIT_TEST_DIR}/**/*.test.{ts,mjs}`], exclude: [`${AUDIT_TEST_DIR}/carved.test.mjs`] };

  it("a suite the include selects and no exclusion removes rides `pnpm test:root`", () => {
    expect(ridesRootVitestRun(`${AUDIT_TEST_DIR}/normal.test.mjs`, globs)).toBe(true);
    expect(ridesRootVitestRun(`${AUDIT_TEST_DIR}/carved.test.mjs`, globs)).toBe(false);
  });

  it("FLAGS a suite that is excluded from the root run AND pinned by no workflow", () => {
    const ungated = findUngatedAuditTests(REPO_ROOT, undefined, {
      globs,
      auditFiles: [`${AUDIT_TEST_DIR}/normal.test.mjs`, `${AUDIT_TEST_DIR}/carved.test.mjs`],
      nodeExact: new Set(),
    });
    expect(ungated).toEqual([`${AUDIT_TEST_DIR}/carved.test.mjs`]);
  });

  it("accepts ONLY an exact `node --test` pin for a root-excluded suite", () => {
    // vitest resolves include/exclude BEFORE applying CLI positionals, so
    // `vitest run <excluded-file>` selects nothing and the step still passes.
    // Crediting it would advertise coverage that provably does not run.
    expect(
      findUngatedAuditTests(REPO_ROOT, undefined, {
        globs,
        auditFiles: [`${AUDIT_TEST_DIR}/carved.test.mjs`],
        nodeExact: new Set([`${AUDIT_TEST_DIR}/carved.test.mjs`]),
      }),
    ).toEqual([]);
    const vitestOnly = fixtureRepo(
      `jobs:\n  a:\n    steps:\n      - run: pnpm exec vitest run ${AUDIT_TEST_DIR}/carved.test.mjs\n`,
      [`${AUDIT_TEST_DIR}/carved.test.mjs`],
    );
    const pins = resolveWorkflowPins(vitestOnly, join(vitestOnly, ".github", "workflows"), [
      `${AUDIT_TEST_DIR}/carved.test.mjs`,
    ]);
    expect(pins.resolved.has(`${AUDIT_TEST_DIR}/carved.test.mjs`)).toBe(true); // direction 1: the pin exists
    expect(pins.nodeExact.has(`${AUDIT_TEST_DIR}/carved.test.mjs`)).toBe(false); // direction 2: it runs nothing
    expect(
      findUngatedAuditTests(vitestOnly, join(vitestOnly, ".github", "workflows"), {
        globs,
        auditFiles: [`${AUDIT_TEST_DIR}/carved.test.mjs`],
        nodeExact: pins.nodeExact,
      }),
    ).toEqual([`${AUDIT_TEST_DIR}/carved.test.mjs`]);
  });

  it("FLAGS every audit suite if the include glob is narrowed away (the carve-the-whole-dir shape)", () => {
    const narrowed = { include: ["src/**/*.test.ts"], exclude: ["**/node_modules/**"] };
    const files = [`${AUDIT_TEST_DIR}/a.test.mjs`, `${AUDIT_TEST_DIR}/b.test.mjs`];
    expect(findUngatedAuditTests(REPO_ROOT, undefined, { globs: narrowed, auditFiles: files, nodeExact: new Set() })).toEqual(files);
  });

  it("a workflow reference that is NOT a runner invocation does not count as coverage", () => {
    // `paths:` filters, prose, an `echo` of the runner phrase and a commented-out
    // step body all NAME the file without executing it. Counting any of them as
    // coverage is the fail-OPEN outcome this guard exists to prevent.
    const root = fixtureRepo(
      [
        "on:",
        "  pull_request:",
        "    paths:",
        "      - 'scripts/audit/__tests__/carved.test.mjs'",
        "jobs:",
        "  a:",
        "    steps:",
        "      - run: echo scripts/audit/__tests__/carved.test.mjs",
        "      - run: |",
        '          echo "node --test scripts/audit/__tests__/carved.test.mjs"',
        "          # node --test scripts/audit/__tests__/carved.test.mjs",
        "          ./some-script.sh vitest run scripts/audit/__tests__/carved.test.mjs",
      ].join("\n"),
      [],
    );
    const { resolved } = resolveWorkflowPins(root, join(root, ".github", "workflows"), [
      `${AUDIT_TEST_DIR}/carved.test.mjs`,
    ]);
    expect(resolved.has(`${AUDIT_TEST_DIR}/carved.test.mjs`)).toBe(false);
    expect(
      findUngatedAuditTests(root, join(root, ".github", "workflows"), {
        globs,
        auditFiles: [`${AUDIT_TEST_DIR}/carved.test.mjs`],
        nodeExact: new Set(),
      }),
    ).toEqual([`${AUDIT_TEST_DIR}/carved.test.mjs`]);
  });

  it("a real `node --test` invocation DOES count as coverage", () => {
    const root = fixtureRepo(
      "jobs:\n  a:\n    steps:\n      - run: node --test scripts/audit/__tests__/carved.test.mjs\n",
      [`${AUDIT_TEST_DIR}/carved.test.mjs`],
    );
    const { resolved } = resolveWorkflowPins(root, join(root, ".github", "workflows"), [
      `${AUDIT_TEST_DIR}/carved.test.mjs`,
    ]);
    expect(resolved.has(`${AUDIT_TEST_DIR}/carved.test.mjs`)).toBe(true);
  });

  it("FLAGS a literal-path exclusion whose file no longer exists, and ignores glob tiers", () => {
    const stale = findStaleRootExclusions(REPO_ROOT, {
      include: [],
      exclude: ["**/node_modules/**", `${AUDIT_TEST_DIR}/gone-in-a-rebase.test.mjs`, "vitest.config.ts"],
    });
    expect(stale).toEqual([`${AUDIT_TEST_DIR}/gone-in-a-rebase.test.mjs`]);
  });

  it("verifies the wholesale root suite is actually INVOKED, not just configured", () => {
    // "rides the root include" is a coverage claim only while something runs
    // `pnpm test:root`. Deleting that one step darkens every root-only suite.
    expect(invokesRootSuite("pnpm test:root")).toBe(true);
    expect(invokesRootSuite("pnpm run test:root")).toBe(true);
    expect(invokesRootSuite("CI=1 pnpm test:root")).toBe(true);
    expect(invokesRootSuite("echo pnpm test:root")).toBe(false);
    expect(invokesRootSuite("# pnpm test:root")).toBe(false);
    // the script name alone is not an invocation — a package manager must run it
    expect(invokesRootSuite("command -v test:root")).toBe(false);
    expect(invokesRootSuite("pnpm exec test:root")).toBe(false);
    // …and a package-scoped invocation is a DIFFERENT package's script
    expect(invokesRootSuite("pnpm --filter @x/y test:root")).toBe(false);
    // the script must still BE the wholesale run — parsed in command position,
    // with any narrowing operand or foreign config rejected
    expect(rootSuiteScriptRunsVitest(REPO_ROOT)).toBe(true);
    const withScript = (cmd) => {
      const root = mkdtempSync(join(tmpdir(), "ci-pin-pkg-"));
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "test:root": cmd } }));
      return rootSuiteScriptRunsVitest(root);
    };
    expect(withScript("vitest run --config vitest.config.ts --no-coverage")).toBe(true);
    expect(withScript("vitest run")).toBe(true);
    expect(withScript("true")).toBe(false);
    expect(withScript("echo vitest run")).toBe(false);
    expect(withScript("vitest run --config not-vitest.config.ts")).toBe(false);
    expect(withScript("vitest run --config vitest.config.ts scripts/audit")).toBe(false);
    expect(withScript("vitest run --config vitest.config.ts one.test.mjs")).toBe(false);
    // the short `-c=` form and every other NARROWING flag are rejected too
    expect(withScript("vitest run -c=not-vitest.config.ts")).toBe(false);
    expect(withScript("vitest run -c=vitest.config.ts")).toBe(true);
    expect(withScript("vitest run --config vitest.config.ts --dir packages/objects")).toBe(false);
    expect(withScript("vitest run --config vitest.config.ts --exclude 'scripts/audit/**'")).toBe(false);
    expect(withScript("vitest run --config vitest.config.ts --project unit")).toBe(false);
    // ALLOWLIST, not a denylist: flags that run zero/fewer tests are rejected
    // because they are unknown to the safe set, so a NEW such vitest flag fails
    // closed instead of quietly passing.
    expect(withScript("vitest run --clearCache")).toBe(false);
    expect(withScript("vitest run --mergeReports")).toBe(false);
    expect(withScript("vitest run --changed")).toBe(false);
    expect(withScript("vitest run --typecheck.only")).toBe(false);
    // a non-narrowing value flag is fine
    expect(withScript("vitest run --config vitest.config.ts --reporter dot")).toBe(true);
    // forwarded args narrow the workflow-side invocation
    expect(invokesRootSuite("pnpm test:root -- scripts/audit")).toBe(false);
    expect(invokesRootSuite("pnpm test:root -- --dir packages/objects")).toBe(false);
    const withStep = fixtureRepo("jobs:\n  a:\n    steps:\n      - run: pnpm test:root\n", []);
    expect(findRootSuiteInvocations(join(withStep, ".github", "workflows"))).toEqual(["build-image.yml"]);
    const withoutStep = fixtureRepo("jobs:\n  a:\n    steps:\n      - run: pnpm typecheck\n", []);
    expect(findRootSuiteInvocations(join(withoutStep, ".github", "workflows"))).toEqual([]);
    // …and it must run from the REPO ROOT, not inside a package
    const inPackage = fixtureRepo(
      "jobs:\n  a:\n    steps:\n      - name: x\n        working-directory: packages/objects\n        run: pnpm test:root\n",
      [],
    );
    expect(findRootSuiteInvocations(join(inPackage, ".github", "workflows"))).toEqual([]);
    const afterCd = fixtureRepo(
      "jobs:\n  a:\n    steps:\n      - run: cd packages/objects && pnpm test:root\n",
      [],
    );
    expect(findRootSuiteInvocations(join(afterCd, ".github", "workflows"))).toEqual([]);
  });

  it("the LIVE repo: every audit suite has a runner, the root suite is invoked, and no exclusion is stale", () => {
    expect(auditTestFiles(REPO_ROOT).length).toBeGreaterThan(20);
    expect(findUngatedAuditTests(REPO_ROOT)).toEqual([]);
    expect(findStaleRootExclusions(REPO_ROOT)).toEqual([]);
    expect(findRootSuiteInvocations()).toContain("build-image.yml");
  });
});

// ---------------------------------------------------------------------------
// Direction 3 — packages/** suite → runner (cinatra#2439)
//
// The adversarial bar is the one #2434 set for direction 2: every way a
// workflow line can LOOK like a wholesale package run without being one, and
// every way the ledger can drift from CI's real shape, has a case here. A
// false POSITIVE (crediting a run that does not happen) is the failure this
// direction exists to prevent, so most of these assert a REFUSAL.
// ---------------------------------------------------------------------------

/** A fixture workspace: workflows + package dirs with configs and test files. */
function pkgFixture({ workflow = "", packages = {}, exceptions, trigger = "on: [pull_request, push]\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ci-pkg-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  // Every fixture workflow gets a change trigger unless a case is testing the
  // trigger check itself — findWholesalePackageRuns credits nothing from a
  // workflow that never fires on a PR or a main push.
  // Every real job declares `runs-on`, and the guard reads it: the runner
  // decides the default shell, so a job without a recognisable Linux runner is
  // refused. Injected here so each fixture states only what its case is about.
  const withRunner = workflow.includes("runs-on:")
    ? workflow
    : workflow.replace(/\n(\s*)steps:/g, "\n$1runs-on: ubuntu-latest\n$1steps:");
  writeFileSync(join(root, ".github", "workflows", "build-image.yml"), trigger + withRunner);
  const tracked = [];
  const pkgDirs = new Map();
  for (const [name, spec] of Object.entries(packages)) {
    const dir = `packages/${name}`;
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(
      join(root, dir, "package.json"),
      JSON.stringify({ name: spec.pkgName ?? `@cinatra-ai/${name}`, scripts: spec.scripts ?? {} }),
    );
    pkgDirs.set(spec.pkgName ?? `@cinatra-ai/${name}`, dir);
    if (spec.config !== undefined) writeFileSync(join(root, dir, "vitest.config.ts"), spec.config);
    for (const f of spec.files ?? []) {
      const abs = join(root, dir, f);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, "// test");
      tracked.push(`${dir}/${f}`);
    }
  }
  if (exceptions !== undefined) {
    writeFileSync(join(root, PACKAGE_EXCEPTIONS_FILE), JSON.stringify({ exceptions }));
  }
  return { root, tracked, pkgDirs, workflowDir: join(root, ".github", "workflows") };
}

/** Root globs that select nothing, so a fixture's coverage comes only from workflows. */
const NO_ROOT_GLOBS = { include: ["src/**/*.test.ts"], exclude: ["**/node_modules/**"] };
const NO_PINS = { resolved: new Set(), nodeExact: new Set(), missing: [] };

function auditFixture(fx, extra = {}) {
  return auditPackageSuiteRunners(fx.root, fx.workflowDir, {
    tracked: fx.tracked,
    // The fixture is not a git repo, so the git-backed inventory would come
    // back empty; the fixture's own file list stands in for it.
    packageFiles: fx.tracked,
    pkgDirs: fx.pkgDirs,
    globs: NO_ROOT_GLOBS,
    pins: NO_PINS,
    rootEnforced: true,
    exceptions: [],
    ...extra,
  });
}

describe("direction 3 — quote-aware tokenization", () => {
  it("keeps a quoted value with spaces as ONE token", () => {
    expect(shellTokens(`a --outputFile.json="one two/x.json" b`)).toEqual([
      "a",
      `--outputFile.json="one two/x.json"`,
      "b",
    ]);
  });

  it("keeps an UNQUOTED ${{ … }} expression atomic", () => {
    expect(shellTokens("pnpm test --out ${{ github.workspace }}/r.json")).toEqual([
      "pnpm",
      "test",
      "--out",
      "${{ github.workspace }}/r.json",
    ]);
  });

  it("handles single quotes, escaped spaces and an unterminated quote without losing text", () => {
    expect(shellTokens("a 'b c' d")).toEqual(["a", "'b c'", "d"]);
    expect(shellTokens("a b\\ c d")).toEqual(["a", "b\\ c", "d"]);
    expect(shellTokens(`a "b c`)).toEqual(["a", `"b c`]);
  });

  it("is what makes the real execution-plane step read as WHOLESALE", () => {
    // The regression this tokenizer exists for: a naive /\s+/ split turns the
    // GitHub expression into three words, two of which look like positional
    // filters, so 36 genuinely-covered suites report as unrun.
    const seg =
      'pnpm --filter @cinatra-ai/execution-plane run test --reporter=default --reporter=json --outputFile.json="${{ github.workspace }}/execution-plane-unit-report.json"';
    const call = packageScriptInvocation(seg);
    expect(call.script).toBe("test");
    expect(wholesaleVitestArgv(call.forwarded, "vitest.config.ts")).toBe(true);
  });
});

describe("direction 3 — wholesale vitest argv", () => {
  it("accepts an unnarrowed run and the dotted --outputFile.<reporter> form", () => {
    expect(wholesaleVitestArgv([], null)).toBe(true);
    expect(wholesaleVitestArgv(["--no-coverage"], null)).toBe(true);
    expect(wholesaleVitestArgv(["--reporter", "dot", "--outputFile.json=/tmp/x.json"], null)).toBe(true);
    expect(wholesaleVitestArgv(["--outputFile.junit", "/tmp/x.xml"], null)).toBe(true);
  });

  it("REFUSES a positional operand — every positional is a filter", () => {
    expect(wholesaleVitestArgv(["src/a.test.ts"], null)).toBe(false);
    expect(wholesaleVitestArgv(["--no-coverage", "src/a.test.ts"], null)).toBe(false);
  });

  it("REFUSES an unknown flag rather than assuming it is harmless", () => {
    // vitest keeps adding options that run FEWER tests; an allowlist is the
    // only shape that does not silently accept each new one.
    expect(wholesaleVitestArgv(["--exclude", "src/a.test.ts"], null)).toBe(false);
    expect(wholesaleVitestArgv(["--changed"], null)).toBe(false);
    expect(wholesaleVitestArgv(["--shard=1/2"], null)).toBe(false);
    expect(wholesaleVitestArgv(["--testNamePattern=foo"], null)).toBe(false);
  });

  it("does not mistake a value-flag's VALUE for a positional", () => {
    expect(wholesaleVitestArgv(["--reporter", "dot"], null)).toBe(true);
    expect(wholesaleVitestArgv(["--maxWorkers", "2", "--no-coverage"], null)).toBe(true);
  });

  it("REFUSES --config when no config is expected, and enforces the value when one is", () => {
    expect(wholesaleVitestArgv(["--config", "vitest.integration.config.ts"], null)).toBe(false);
    expect(wholesaleVitestArgv(["--config", "vitest.config.ts"], "vitest.config.ts")).toBe(true);
    expect(wholesaleVitestArgv(["--config", "vitest.integration.config.ts"], "vitest.config.ts")).toBe(false);
    expect(wholesaleVitestArgv(["-c=vitest.config.ts"], "vitest.config.ts")).toBe(true);
  });
});

describe("direction 3 — package script resolution", () => {
  const scriptFixture = (scripts) => {
    const root = mkdtempSync(join(tmpdir(), "ci-pkgscript-"));
    mkdirSync(join(root, "packages", "p"), { recursive: true });
    writeFileSync(join(root, "packages", "p", "package.json"), JSON.stringify({ name: "@x/p", scripts }));
    return root;
  };

  it("accepts a script that is a wholesale `vitest run`", () => {
    const root = scriptFixture({ test: "vitest run" });
    expect(packageScriptIsWholesaleVitest(root, "packages/p", "test", "vitest.config.ts")).toBe(true);
  });

  it("REFUSES a script that narrows the run with a positional", () => {
    const root = scriptFixture({ test: "vitest run src/a.test.ts src/b.test.ts" });
    expect(packageScriptIsWholesaleVitest(root, "packages/p", "test", "vitest.config.ts")).toBe(false);
  });

  it("REFUSES a script that does not run vitest at all (the `\"test\": \"true\"` rewrite)", () => {
    expect(packageScriptIsWholesaleVitest(scriptFixture({ test: "true" }), "packages/p", "test", null)).toBe(false);
    expect(packageScriptIsWholesaleVitest(scriptFixture({ test: "echo vitest run" }), "packages/p", "test", null)).toBe(
      false,
    );
  });

  it("REFUSES a missing script, a missing package.json and a non-string script", () => {
    expect(packageScriptIsWholesaleVitest(scriptFixture({}), "packages/p", "test", null)).toBe(false);
    expect(packageScriptIsWholesaleVitest(scriptFixture({ test: "vitest run" }), "packages/gone", "test", null)).toBe(
      false,
    );
    expect(packageScriptIsWholesaleVitest(scriptFixture({ test: ["vitest", "run"] }), "packages/p", "test", null)).toBe(
      false,
    );
  });

  it("reads a &&-chained script body as the commands it is", () => {
    const root = scriptFixture({ test: "rimraf dist && vitest run --no-coverage" });
    expect(packageScriptIsWholesaleVitest(root, "packages/p", "test", "vitest.config.ts")).toBe(true);
    // …but a chain whose vitest half is narrowed still refuses.
    const narrowed = scriptFixture({ test: "rimraf dist && vitest run src/a.test.ts" });
    expect(packageScriptIsWholesaleVitest(narrowed, "packages/p", "test", "vitest.config.ts")).toBe(false);
  });

  it("bare `vitest` (no `run`) is NOT a wholesale run — it is watch mode outside CI", () => {
    expect(packageScriptIsWholesaleVitest(scriptFixture({ test: "vitest" }), "packages/p", "test", null)).toBe(false);
  });
});

describe("direction 3 — script invocation + target directory", () => {
  it("recognises `pnpm test`, `pnpm run test` and `pnpm --filter <pkg> run test`", () => {
    expect(packageScriptInvocation("pnpm test").script).toBe("test");
    expect(packageScriptInvocation("pnpm run test").script).toBe("test");
    expect(packageScriptInvocation("pnpm --filter @x/p run test").script).toBe("test");
    expect(packageScriptInvocation("pnpm test:invariants").script).toBe("test:invariants");
  });

  it("collects forwarded arguments, cut at a redirection", () => {
    expect(packageScriptInvocation("pnpm test --no-coverage").forwarded).toEqual(["--no-coverage"]);
    expect(packageScriptInvocation("pnpm test > out.log").forwarded).toEqual([]);
  });

  it("REFUSES a binary word — `pnpm exec vitest` is a runner, not a script", () => {
    expect(packageScriptInvocation("pnpm exec vitest run")).toBe(null);
    expect(packageScriptInvocation("pnpm dlx something")).toBe(null);
    expect(packageScriptInvocation("npx vitest run")).toBe(null);
  });

  it("REFUSES a bare command word with no package manager in front", () => {
    expect(packageScriptInvocation("test")).toBe(null);
    expect(packageScriptInvocation("./run-tests.sh")).toBe(null);
    expect(packageScriptInvocation("run test")).toBe(null);
  });

  it("ignores env assignments, flags and a trailing comment", () => {
    expect(packageScriptInvocation("CI=1 pnpm --silent test").script).toBe("test");
    expect(packageScriptInvocation("pnpm test # pnpm other")).toEqual({ script: "test", forwarded: [] });
    expect(packageScriptInvocation("# pnpm test")).toBe(null);
  });

  it("resolves the target dir from --filter, -C and the carried cwd", () => {
    const pkgDirs = new Map([["@x/p", "packages/p"]]);
    expect(segmentTargetDir("pnpm --filter @x/p test", "", pkgDirs)).toBe("packages/p");
    expect(segmentTargetDir("pnpm --filter=@x/p test", "", pkgDirs)).toBe("packages/p");
    expect(segmentTargetDir("pnpm -C packages/q exec vitest run", "", pkgDirs)).toBe("packages/q");
    expect(segmentTargetDir("pnpm -C ./packages/q/ exec vitest run", "", pkgDirs)).toBe("packages/q");
    expect(segmentTargetDir("pnpm test", "packages/carried", pkgDirs)).toBe("packages/carried");
  });

  it("returns null for an UNRESOLVABLE --filter rather than falling back to the cwd", () => {
    // A glob/path filter credited to whatever dir the block happened to be
    // sitting in would be a coverage claim about a package nobody ran.
    const pkgDirs = new Map([["@x/p", "packages/p"]]);
    expect(segmentTargetDir("pnpm --filter './packages/*' test", "packages/p", pkgDirs)).toBe(null);
    expect(segmentTargetDir("pnpm --filter @x/unknown test", "packages/p", pkgDirs)).toBe(null);
  });
});

describe("direction 3 — wholesale run discovery in workflows", () => {
  const wf = (body) => {
    const fx = pkgFixture({
      workflow: body,
      packages: { p: { scripts: { test: "vitest run" }, config: "export default { test: { include: ['src/**/*.test.ts'] } };", files: ["src/a.test.ts"] } },
    });
    return { fx, runs: findWholesalePackageRuns(fx.root, fx.workflowDir, fx.pkgDirs) };
  };

  it("credits `cd packages/p && pnpm test`", () => {
    const { runs } = wf("jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm test\n");
    expect([...runs.keys()]).toEqual(["packages/p"]);
  });

  it("credits `pnpm -C packages/p exec vitest run --no-coverage`", () => {
    const { runs } = wf("jobs:\n  a:\n    steps:\n      - run: pnpm -C packages/p exec vitest run --no-coverage\n");
    expect([...runs.keys()]).toEqual(["packages/p"]);
  });

  it("credits a step-level working-directory: with `pnpm exec vitest run`", () => {
    const { runs } = wf(
      "jobs:\n  a:\n    steps:\n      - name: x\n        working-directory: packages/p\n        run: pnpm exec vitest run --no-coverage\n",
    );
    expect([...runs.keys()]).toEqual(["packages/p"]);
  });

  it("does NOT credit a run narrowed by a positional or an --exclude", () => {
    expect([...wf("jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm exec vitest run src/a.test.ts\n").runs.keys()]).toEqual([]);
    expect(
      [...wf("jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm exec vitest run --exclude '**/b.test.ts'\n").runs.keys()],
    ).toEqual([]);
  });

  it("does NOT credit a run redirected to another config", () => {
    // packages/agents' integration tier runs under vitest.integration.config.ts;
    // crediting that as the UNIT suite would be a different suite wearing this
    // package's name.
    expect(
      [...wf("jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm exec vitest run --config vitest.integration.config.ts\n").runs.keys()],
    ).toEqual([]);
  });

  it("does NOT credit an echoed, commented-out, short-circuited or heredoc'd runner", () => {
    expect([...wf('jobs:\n  a:\n    steps:\n      - run: echo "cd packages/p && pnpm test"\n').runs.keys()]).toEqual([]);
    expect([...wf("jobs:\n  a:\n    steps:\n      - run: |\n          # cd packages/p && pnpm test\n").runs.keys()]).toEqual([]);
    expect([...wf("jobs:\n  a:\n    steps:\n      - run: true || pnpm -C packages/p test\n").runs.keys()]).toEqual([]);
    expect(
      [...wf("jobs:\n  a:\n    steps:\n      - run: |\n          cat <<EOF\n          cd packages/p && pnpm test\n          EOF\n").runs.keys()],
    ).toEqual([]);
  });

  it("does NOT credit a step or job switched OFF with a literal-false if:", () => {
    expect(
      [...wf("jobs:\n  a:\n    steps:\n      - name: x\n        if: false\n        run: cd packages/p && pnpm test\n").runs.keys()],
    ).toEqual([]);
    expect(
      [...wf("jobs:\n  a:\n    if: ${{ false }}\n    steps:\n      - run: cd packages/p && pnpm test\n").runs.keys()],
    ).toEqual([]);
  });

  it("does NOT credit a package whose `test` script is not a wholesale vitest run", () => {
    const fx = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm test\n",
      packages: { p: { scripts: { test: "vitest run src/a.test.ts" }, files: ["src/a.test.ts"] } },
    });
    expect([...findWholesalePackageRuns(fx.root, fx.workflowDir, fx.pkgDirs).keys()]).toEqual([]);
  });

  it("does NOT credit `cd <pkg> && pnpm test && cd ../..` mid-block — that shape CANNOT fail its step", () => {
    // Measured against `bash -e`, GitHub's default run shell:
    //   bash -e -c 'cd /tmp && false && cd /'           → 1
    //   bash -e -c $'cd /tmp && false && cd /\ncd /tmp' → 0
    // errexit does not fire for a command inside an `&&`-list, and the next
    // line overwrites the list's status. This is the exact shape build-image.yml
    // carried on four pinned package runs, none of which could turn red.
    const { runs } = wf(
      "jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p && pnpm test && cd ../..\n          echo next\n",
    );
    expect([...runs.keys()]).toEqual([]);
    // The same list AS THE LAST list does gate: `&&` short-circuits, so the
    // list ends on the runner's failure and that becomes the step's status.
    expect([...wf("jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm test\n").runs.keys()]).toEqual([
      "packages/p",
    ]);
    // …and the repaired shape — one SIMPLE command per line — gates on every
    // line, because errexit fires on a simple command wherever it sits.
    expect(
      [...wf("jobs:\n  a:\n    steps:\n      - run: |\n          pnpm -C packages/p exec vitest run --no-coverage\n          echo next\n").runs.keys()],
    ).toEqual(["packages/p"]);
  });

  it("tracks `cd ../..` back out, so a later bare run is not credited to the package", () => {
    const { runs } = wf(
      "jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p\n          pnpm test\n          cd ../..\n          pnpm exec vitest run\n",
    );
    expect([...runs.keys()]).toEqual(["packages/p"]);
  });

  it("credits nothing outside packages/** (a repo-root wholesale run is direction 2's business)", () => {
    const { runs } = wf("jobs:\n  a:\n    steps:\n      - run: pnpm exec vitest run\n");
    expect([...runs.keys()]).toEqual([]);
  });
});

describe("direction 3 — per-package vitest config parsing", () => {
  const cfg = (text) => {
    const root = mkdtempSync(join(tmpdir(), "ci-cfg-"));
    writeFileSync(join(root, "vitest.config.ts"), text);
    return join(root, "vitest.config.ts");
  };

  it("an ABSENT config means vitest's defaults (include null = every test file)", () => {
    const g = parseVitestTestGlobs(join(mkdtempSync(join(tmpdir(), "ci-cfg-")), "vitest.config.ts"));
    expect(g.include).toBe(null);
    expect(g.exclude).toEqual(["**/node_modules/**", "**/.git/**"]);
  });

  it("an absent `exclude` falls back to vitest's default exclude, not to nothing", () => {
    const g = parseVitestTestGlobs(cfg("export default { test: { include: ['src/**/*.test.ts'] } };"));
    expect(g.include).toEqual(["src/**/*.test.ts"]);
    expect(g.exclude).toEqual(["**/node_modules/**", "**/.git/**"]);
  });

  it("REFUSES a `root:` key rather than resolving every glob against the wrong base", () => {
    expect(() => parseVitestTestGlobs(cfg("export default { root: '../..', test: { include: ['a/*.test.ts'] } };"))).toThrow(
      /root:/,
    );
  });

  it("REFUSES a DUPLICATED include (it cannot tell which one governs)", () => {
    expect(() =>
      parseVitestTestGlobs(cfg("export default { test: { include: ['a/*.test.ts'] }, x: { include: ['b/*.test.ts'] } };")),
    ).toThrow(/at most one/);
  });

  it("REFUSES an empty include and an unmodelled element shape", () => {
    expect(() => parseVitestTestGlobs(cfg("export default { test: { include: [] } };"))).toThrow(/EMPTY/);
    expect(() => parseVitestTestGlobs(cfg("export default { test: { include: [...others] } };"))).toThrow(/Refusing/);
  });

  it("folds a conditional exclude tier's literals in (the fail-CLOSED reading)", () => {
    const g = parseVitestTestGlobs(
      cfg(
        "export default { test: { include: ['src/**/*.test.ts'], exclude: [...(process.env.F === '1' ? [] : ['**/*.integration.test.ts'])] } };",
      ),
    );
    expect(g.exclude).toEqual(["**/*.integration.test.ts"]);
  });
});

describe("direction 3 — package discovery sets", () => {
  it("applies include and exclude, relative to the package dir", () => {
    const fx = pkgFixture({
      packages: {
        p: {
          config: "export default { test: { include: ['src/**/*.test.ts'], exclude: ['**/*.manual.test.ts'] } };",
          files: ["src/a.test.ts", "src/b.manual.test.ts", "tests/c.test.ts"],
        },
      },
    });
    expect([...packageDiscoverySet("packages/p", fx.tracked, fx.root)]).toEqual(["packages/p/src/a.test.ts"]);
  });

  it("a config-less package discovers EVERY tracked test file under it (vitest's default include)", () => {
    const fx = pkgFixture({
      packages: { p: { files: ["src/a.test.ts", "src/__tests__/b.test.tsx", "tests/c.test.mjs"] } },
    });
    expect(packageDiscoverySet("packages/p", fx.tracked, fx.root).size).toBe(3);
  });

  it("never reaches into a sibling package", () => {
    const fx = pkgFixture({
      packages: { p: { files: ["src/a.test.ts"] }, q: { files: ["src/a.test.ts"] } },
    });
    expect([...packageDiscoverySet("packages/p", fx.tracked, fx.root)]).toEqual(["packages/p/src/a.test.ts"]);
  });
});

describe("direction 3 — the quarantine ledger", () => {
  const ok = {
    file: "packages/p/src/a.test.ts",
    kind: "quarantine",
    issue: "https://github.com/cinatra-ai/cinatra/issues/2440",
    reason: "A written reason long enough to be a real sentence.",
  };

  it("accepts a well-formed entry", () => {
    expect(readPackageSuiteExceptions(".", JSON.stringify({ exceptions: [ok] }))).toEqual([ok]);
    expect(readPackageSuiteExceptions(".", JSON.stringify({ exceptions: [] }))).toEqual([]);
  });

  it("THROWS on malformed JSON or a missing exceptions array rather than reading as 'no exceptions'", () => {
    expect(() => readPackageSuiteExceptions(".", "{oops")).toThrow(/not valid JSON/);
    expect(() => readPackageSuiteExceptions(".", "{}")).toThrow(/exceptions/);
    expect(() => readPackageSuiteExceptions(".", JSON.stringify({ exceptions: {} }))).toThrow(/exceptions/);
    expect(() => readPackageSuiteExceptions(".", JSON.stringify({ exceptions: ["x"] }))).toThrow(/expected an object/);
  });

  it("REFUSES a file outside packages/**, a non-test path, and a duplicate", () => {
    const bad = (f) => JSON.stringify({ exceptions: [{ ...ok, file: f }] });
    expect(() => readPackageSuiteExceptions(".", bad("src/a.test.ts"))).toThrow(/packages/);
    expect(() => readPackageSuiteExceptions(".", bad("packages/p/src/a.ts"))).toThrow(/packages/);
    expect(() => readPackageSuiteExceptions(".", JSON.stringify({ exceptions: [ok, ok] }))).toThrow(/duplicate/);
  });

  it("REFUSES any kind but `quarantine` — main-only is a RUNNER, never an exception", () => {
    for (const kind of ["main-only", "skip", "", undefined]) {
      expect(() => readPackageSuiteExceptions(".", JSON.stringify({ exceptions: [{ ...ok, kind }] }))).toThrow(/quarantine/);
    }
  });

  it("REFUSES a missing/!GitHub issue link and a throwaway reason", () => {
    // A quarantine without a filed follow-up is an unrun test with paperwork.
    for (const issue of ["", "see the tracker", "https://example.com/issues/1", "https://github.com/o/r/pull/1"]) {
      expect(() => readPackageSuiteExceptions(".", JSON.stringify({ exceptions: [{ ...ok, issue }] }))).toThrow(/issue/);
    }
    expect(() => readPackageSuiteExceptions(".", JSON.stringify({ exceptions: [{ ...ok, reason: "broken" }] }))).toThrow(
      /reason/,
    );
  });
});

describe("direction 3 — the verdict", () => {
  const wholesalePkg = {
    scripts: { test: "vitest run" },
    config: "export default { test: { include: ['src/**/*.test.ts'] } };",
  };

  it("FLAGS a package suite that no workflow runs — the cinatra#2439 shape", () => {
    const fx = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: pnpm typecheck\n",
      packages: { llm: { ...wholesalePkg, files: ["src/a.test.ts"] } },
    });
    const v = auditFixture(fx);
    expect(v.ungated.map((u) => u.file)).toEqual(["packages/llm/src/a.test.ts"]);
    expect(v.ungated[0].wholesale).toBe(false);
  });

  it("CLEARS it once a wholesale runner exists — including a file added later", () => {
    const fx = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: cd packages/llm && pnpm test\n",
      packages: { llm: { ...wholesalePkg, files: ["src/a.test.ts", "src/added-later.test.ts"] } },
    });
    expect(auditFixture(fx).ungated).toEqual([]);
  });

  it("FLAGS a file the package config EXCLUDES even though the package has a wholesale runner", () => {
    // The carve-out-with-no-other-runner shape: excluded from the package run
    // and reachable by nothing else.
    const fx = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: cd packages/llm && pnpm test\n",
      packages: {
        llm: {
          scripts: { test: "vitest run" },
          config: "export default { test: { include: ['src/**/*.test.ts'], exclude: ['src/dark.test.ts'] } };",
          files: ["src/a.test.ts", "src/dark.test.ts"],
        },
      },
    });
    const v = auditFixture(fx);
    expect(v.ungated.map((u) => u.file)).toEqual(["packages/llm/src/dark.test.ts"]);
    expect(v.ungated[0].discovered).toBe(false);
  });

  it("does NOT credit a vitest PIN for a file the package config excludes", () => {
    // vitest applies include/exclude BEFORE the CLI positional, so the pin
    // selects nothing and the step passes green — the same trap direction 2
    // already refuses for the root config.
    const fx = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: cd packages/llm && pnpm exec vitest run src/dark.test.ts\n",
      packages: {
        llm: {
          scripts: { test: "vitest run" },
          config: "export default { test: { include: ['src/**/*.test.ts'], exclude: ['src/dark.test.ts'] } };",
          files: ["src/dark.test.ts"],
        },
      },
    });
    const v = auditFixture(fx, { pins: { resolved: new Set(["packages/llm/src/dark.test.ts"]), nodeExact: new Set(), missing: [] } });
    expect(v.ungated.map((u) => u.file)).toEqual(["packages/llm/src/dark.test.ts"]);
  });

  it("DOES credit an exact `node --test` pin for a config-excluded file (node takes a path, not a filter)", () => {
    const fx = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: node --test packages/llm/src/dark.test.ts\n",
      packages: {
        llm: {
          config: "export default { test: { include: ['src/**/*.test.ts'], exclude: ['src/dark.test.ts'] } };",
          files: ["src/dark.test.ts"],
        },
      },
    });
    const v = auditFixture(fx, { pins: { resolved: new Set(), nodeExact: new Set(["packages/llm/src/dark.test.ts"]), missing: [] } });
    expect(v.ungated).toEqual([]);
  });

  it("credits the ROOT include independently of the package's own config", () => {
    const fx = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: pnpm typecheck\n",
      packages: { llm: { files: ["src/a.test.ts"] } },
    });
    const v = auditFixture(fx, { globs: { include: ["packages/llm/src/**/*.test.ts"], exclude: ["**/node_modules/**"] } });
    expect(v.ungated).toEqual([]);
  });

  it("a ledger entry EXEMPTS an unrun file — and only that file", () => {
    const fx = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: pnpm typecheck\n",
      packages: { llm: { ...wholesalePkg, files: ["src/quarantined.test.ts", "src/other.test.ts"] } },
    });
    const v = auditFixture(fx, {
      exceptions: [
        {
          file: "packages/llm/src/quarantined.test.ts",
          kind: "quarantine",
          issue: "https://github.com/cinatra-ai/cinatra/issues/1",
          reason: "A written reason long enough to be a real sentence.",
        },
      ],
    });
    expect(v.exempt.map((e) => e.file)).toEqual(["packages/llm/src/quarantined.test.ts"]);
    expect(v.ungated.map((u) => u.file)).toEqual(["packages/llm/src/other.test.ts"]);
  });

  it("FLAGS a ledger entry whose file is gone, and one whose file DOES run", () => {
    const fx = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: cd packages/llm && pnpm test\n",
      packages: { llm: { ...wholesalePkg, files: ["src/a.test.ts"] } },
    });
    const v = auditFixture(fx, {
      exceptions: [
        { file: "packages/llm/src/gone.test.ts", kind: "quarantine", issue: "https://github.com/o/r/issues/1", reason: "A written reason long enough to be a real sentence." },
        { file: "packages/llm/src/a.test.ts", kind: "quarantine", issue: "https://github.com/o/r/issues/2", reason: "A written reason long enough to be a real sentence." },
      ],
    });
    expect(v.staleExceptions.map((e) => e.file)).toEqual(["packages/llm/src/gone.test.ts"]);
    expect(v.redundantExceptions.map((e) => e.file)).toEqual(["packages/llm/src/a.test.ts"]);
  });

  it("leaves the non-unit tiers out of the governed set — but only when nothing runs them", () => {
    expect(isNonUnitTierFile("packages/p/src/a.integration.test.ts")).toBe(true);
    expect(isNonUnitTierFile("packages/p/src/a.integration.test.tsx")).toBe(true);
    expect(isNonUnitTierFile("packages/p/src/__tests__/e2e/a.e2e.test.ts")).toBe(true);
    expect(isNonUnitTierFile("packages/p/src/a.manual.test.ts")).toBe(true);
    expect(isNonUnitTierFile("packages/p/src/a.test.ts")).toBe(false);
    // Unrun tier file → out of scope, not a failure and NOT reported as a
    // quarantine (that would put a filed-issue claim on a file nobody filed).
    const unrun = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: pnpm typecheck\n",
      packages: { agents: { ...wholesalePkg, files: ["src/a.integration.test.ts"] } },
    });
    const uv = auditFixture(unrun);
    expect(uv.ungated).toEqual([]);
    expect(uv.exempt).toEqual([]);
    expect(uv.tierExcluded).toEqual(["packages/agents/src/a.integration.test.ts"]);
    // A tier file a runner DOES execute stays credited as covered, so the tier
    // list can never HIDE a suite that runs.
    const run = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: cd packages/agents && pnpm test\n",
      packages: { agents: { ...wholesalePkg, files: ["src/a.integration.test.ts"] } },
    });
    expect(auditFixture(run).tierExcluded).toEqual([]);
  });
});

describe("direction 3 — the LIVE repo", () => {
  it("every packages/** unit suite has a statically detected runner", () => {
    const v = auditPackageSuiteRunners();
    expect(v.ungated).toEqual([]);
    expect(v.staleExceptions).toEqual([]);
    expect(v.redundantExceptions).toEqual([]);
    expect(v.packageFiles.length).toBeGreaterThan(900);
  });

  it("the eighteen packages cinatra#2439 wired have a WHOLESALE runner, not a file pin", () => {
    const wholesale = findWholesalePackageRuns();
    for (const p of [
      "llm", "objects", "chat", "agent-ui-protocol", "registries", "metric-cost-api", "memory",
      "marketplace-mcp-client", "webhooks", "streams", "extension-types", "artifacts",
      "connectors-catalog", "marketplace-application-reconcile", "marketplace-sync",
      "metric-contracts", "pm-schedule-reconcile", "projects",
      // …plus the packages that already had one, which must not regress.
      "extensions", "agents", "skills", "a2a", "execution-plane", "dashboards", "org-write-kernel",
    ]) {
      expect(wholesale.has(`packages/${p}`), `packages/${p} has no wholesale CI runner`).toBe(true);
    }
  });

  it("the LIVE ledger parses, and every entry names a file that exists and is excluded in its package config", () => {
    // An EMPTY ledger is the HEALTHY end state, not a failure: the ledger's own
    // contract says an entry is retired by repairing the suite and deleting the
    // exclusion + the entry together, so "there is at least one quarantined
    // suite" was never an invariant (cinatra#2455 retired the last three).
    // What must hold is the PAIRING contract, for however many entries exist —
    // and readPackageSuiteExceptions() throws on a malformed one, which the
    // fixture-driven cases above prove.
    // The ledger FILE stays, empty or not: the reader maps a missing file to
    // [], so without this the whole ledger could be deleted and every check
    // below would pass vacuously.
    expect(
      existsSync(join(REPO_ROOT, "scripts/audit/package-suite-runner-exceptions.json")),
      "the quarantine ledger must remain a durable policy artifact even when empty",
    ).toBe(true);
    const entries = readPackageSuiteExceptions();
    const tracked = new Set(trackedTestPaths());
    for (const e of entries) {
      expect(tracked.has(e.file), `${e.file} is not tracked`).toBe(true);
      const pkgDir = e.file.split("/").slice(0, 2).join("/");
      const configText = readFileSync(join(REPO_ROOT, pkgDir, "vitest.config.ts"), "utf8");
      // The exclusion and the ledger entry are a PAIR; neither may outlive the
      // other, so the config must name the same file.
      expect(configText.includes(e.file.slice(pkgDir.length + 1)), `${pkgDir}/vitest.config.ts does not exclude ${e.file}`).toBe(true);
    }
  });
});

describe("direction 3 — a credited runner must be able to turn the check RED", () => {
  const wf = (body) => {
    const fx = pkgFixture({
      workflow: body,
      packages: { p: { scripts: { test: "vitest run" }, config: "export default { test: { include: ['src/**/*.test.ts'] } };", files: ["src/a.test.ts"] } },
    });
    return [...findWholesalePackageRuns(fx.root, fx.workflowDir, fx.pkgDirs).keys()];
  };

  it("does NOT credit a step marked continue-on-error: true", () => {
    expect(wf("jobs:\n  a:\n    steps:\n      - name: x\n        continue-on-error: true\n        run: cd packages/p && pnpm test\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - name: x\n        continue-on-error: ${{ true }}\n        run: cd packages/p && pnpm test\n")).toEqual([]);
    // An EXPRESSION cannot be evaluated here, and `continue-on-error: ${{ 1 == 1 }}`
    // is an ordinary way to write `true` — so an unevaluable value reads as
    // NON-blocking. (Unlike the `if:` residual this costs nothing: no workflow
    // in this repo writes an expression for continue-on-error.)
    expect(wf("jobs:\n  a:\n    steps:\n      - name: x\n        continue-on-error: ${{ github.event_name == 'push' }}\n        run: cd packages/p && pnpm test\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - name: x\n        continue-on-error: ${{ 1 == 1 }}\n        run: cd packages/p && pnpm test\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - name: x\n        continue-on-error: false\n        run: cd packages/p && pnpm test\n")).toEqual(["packages/p"]);
  });

  it("does NOT credit a JOB marked continue-on-error: true", () => {
    expect(wf("jobs:\n  a:\n    continue-on-error: true\n    steps:\n      - run: cd packages/p && pnpm test\n")).toEqual([]);
  });

  it("does NOT credit a runner reached after `set +e` (the informational-tier shape)", () => {
    // build-image.yml's whole-tier integration step is exactly this: the run
    // reports its failure as a ::warning:: and the step exits 0.
    expect(
      wf("jobs:\n  a:\n    steps:\n      - run: |\n          set +e\n          cd packages/p && pnpm test\n          exit 0\n"),
    ).toEqual([]);
    // …and errexit coming back ON restores the credit.
    expect(
      wf("jobs:\n  a:\n    steps:\n      - run: |\n          set +e\n          echo probing\n          set -e\n          cd packages/p && pnpm test\n"),
    ).toEqual(["packages/p"]);
    // `set -euo pipefail` / `set -uxo pipefail` are read for their `e` correctly.
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          set -euo pipefail\n          cd packages/p && pnpm test\n")).toEqual(["packages/p"]);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          set +uxe\n          cd packages/p && pnpm test\n")).toEqual([]);
  });

  it("does NOT credit a runner whose failure is swallowed by `|| true`", () => {
    expect(wf("jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm test || true\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm test || echo failed\n")).toEqual([]);
  });

  it("the LIVE repo: the informational whole-tier agents step credits nothing", () => {
    // It runs a wholesale vitest under vitest.integration.config.ts inside
    // `set +e … exit 0`. Two independent reasons it must not be credited (the
    // config redirect AND the swallowed exit); packages/agents is credited only
    // by the blocking `cd packages/agents && pnpm test` step in the `test` job.
    const runs = findWholesalePackageRuns();
    expect(runs.get("packages/agents")).toEqual(new Set(["build-image.yml"]));
  });
});

// ---------------------------------------------------------------------------
// Direction 3 — the fail-open holes a Codex adversarial pass found, each closed
// and each pinned here so it cannot reopen. Every case asserts a REFUSAL.
// ---------------------------------------------------------------------------
describe("direction 3 — adversarial fail-open closures", () => {
  const wf = (body, opts = {}) => {
    const fx = pkgFixture({
      workflow: body,
      packages: {
        p: { scripts: { test: "vitest run" }, config: "export default { test: { include: ['src/**/*.test.ts'] } };", files: ["src/a.test.ts"] },
        q: { scripts: { test: "vitest run" }, config: "export default { test: { include: ['src/**/*.test.ts'] } };", files: ["src/a.test.ts"] },
      },
      ...opts,
    });
    return [...findWholesalePackageRuns(fx.root, fx.workflowDir, fx.pkgDirs).keys()];
  };

  it("credits NOTHING from a workflow that never fires on a change", () => {
    const body = "jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm test\n";
    expect(wf(body, { trigger: "on: [workflow_dispatch]\n" })).toEqual([]);
    expect(wf(body, { trigger: "on:\n  schedule:\n    - cron: '0 6 * * *'\n" })).toEqual([]);
    expect(wf(body, { trigger: "on:\n  workflow_call:\n" })).toEqual([]);
    expect(wf(body, { trigger: "" })).toEqual([]);
    // …and DOES credit each real change trigger, in both YAML shapes.
    expect(wf(body, { trigger: "on:\n  pull_request:\n  workflow_dispatch:\n" })).toEqual(["packages/p"]);
    expect(wf(body, { trigger: "on: push\n" })).toEqual(["packages/p"]);
    expect(wf(body, { trigger: "# a leading comment block\n# second line\non:\n  merge_group:\n" })).toEqual(["packages/p"]);
  });

  it("REFUSES two selectors — `-C p --filter q` runs q, so crediting p would be WRONG, not merely absent", () => {
    expect(wf("jobs:\n  a:\n    steps:\n      - run: pnpm -C packages/p --filter @cinatra-ai/q test\n")).toEqual([]);
    expect(segmentTargetDir("pnpm -C packages/p --filter @x/q test", "", new Map([["@x/q", "packages/q"]]))).toBe(null);
  });

  it("REFUSES a selector or a `cd` whose value is an unquoted expansion", () => {
    expect(segmentTargetDir("pnpm -C $PKG_DIR test", "", new Map())).toBe(null);
    expect(segmentTargetDir("pnpm --filter $PKG test", "", new Map())).toBe(null);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: cd $DIR && pnpm test\n")).toEqual([]);
  });

  it("does NOT propagate a `cd` that ran in a pipeline or behind `||`", () => {
    // `cd x | y` runs the cd in a SUBSHELL; the parent's cwd is untouched.
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p | cat\n          pnpm test\n")).toEqual([]);
    // The second `cd` may never have run, so the cwd from there on is unknown.
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p || cd packages/q\n          pnpm test\n")).toEqual([]);
  });

  it("stops at a top-level `exit` — nothing after it runs", () => {
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p\n          exit 0\n          pnpm test\n")).toEqual([]);
  });

  it("does NOT credit a runner in a pipeline (the last command's status wins)", () => {
    expect(wf("jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm test | tee out.log\n")).toEqual([]);
  });

  it("does NOT credit a runner carrying a redirection, which hides operands after it", () => {
    // `vitest run >out src/a.test.ts` passes a positional filter the argv walk
    // never sees, because argv recovery stops at the redirect.
    expect(wf("jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm exec vitest run > out.log src/a.test.ts\n")).toEqual([]);
    expect(hasTopLevelRedirect("vitest run > out.log")).toBe(true);
    expect(hasTopLevelRedirect("vitest run --reporter='a>b'")).toBe(false);
  });

  it("REFUSES an unquoted expansion in a vitest argument — it WORD-SPLITS into positionals", () => {
    // ARGS='default src/a.test.ts' turns `--reporter=$ARGS` into a reporter
    // plus a filter.
    expect(wholesaleVitestArgv(["--reporter=$ARGS"], null)).toBe(false);
    expect(wholesaleVitestArgv(["--reporter", "$ARGS"], null)).toBe(false);
    expect(wholesaleVitestArgv(["--reporter=$(cat r)"], null)).toBe(false);
    // …but a QUOTED expansion cannot word-split, so it stays acceptable — this
    // is the real `--outputFile.json="${{ github.workspace }}/…"` shape.
    expect(wholesaleVitestArgv(['--outputFile.json="${{ github.workspace }}/r.json"'], null)).toBe(true);
    expect(hasUnquotedExpansion('--outputFile.json="${{ x }}/r.json"')).toBe(false);
    expect(hasUnquotedExpansion("--outputFile.json=${{ x }}/r.json")).toBe(true);
  });

  it("REFUSES --mode: it can change test.include through a mode-dependent config", () => {
    expect(wholesaleVitestArgv(["--mode", "ci"], null)).toBe(false);
    expect(wholesaleVitestArgv(["--mode=ci"], null)).toBe(false);
  });

  it("REFUSES a package script whose vitest failure does not become the script's status", () => {
    const scriptFixture = (test) => {
      const root = mkdtempSync(join(tmpdir(), "ci-pkgscript2-"));
      mkdirSync(join(root, "packages", "p"), { recursive: true });
      writeFileSync(join(root, "packages", "p", "package.json"), JSON.stringify({ name: "@x/p", scripts: { test } }));
      return root;
    };
    const wholesale = (test) => packageScriptIsWholesaleVitest(scriptFixture(test), "packages/p", "test", "vitest.config.ts");
    // A pnpm script runs with errexit OFF, so the LAST command's status wins.
    expect(wholesale("vitest run")).toBe(true);
    expect(wholesale("rimraf dist && vitest run")).toBe(true);
    expect(wholesale("vitest run && echo done")).toBe(true);
    expect(wholesale("vitest run || true")).toBe(false);
    expect(wholesale("vitest run; true")).toBe(false);
    expect(wholesale("vitest run; echo done")).toBe(false);
    expect(wholesale("vitest run | tee out.log")).toBe(false);
    expect(wholesale("vitest run & wait")).toBe(false);
    expect(wholesale("(true) || vitest run")).toBe(false);
    expect(wholesale('test -z "$SKIP" || vitest run')).toBe(false);
    expect(wholesale("vitest run > out.log")).toBe(false);
    expect(wholesale("vitest run $EXTRA_ARGS")).toBe(false);
  });

  it("the LIVE repo still credits every wired package after all of the above", () => {
    const runs = findWholesalePackageRuns();
    expect(runs.size).toBeGreaterThanOrEqual(23);
    expect(auditPackageSuiteRunners().ungated).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Direction 3 — round-2 adversarial closures. Every case here is a shape a
// second Codex pass credited before the fix, each verified against real `bash
// -e` semantics rather than assumed.
// ---------------------------------------------------------------------------
describe("direction 3 — round-2 fail-open closures", () => {
  const wf = (body, opts = {}) => {
    const fx = pkgFixture({
      workflow: body,
      packages: { p: { scripts: { test: "vitest run" }, config: "export default { test: { include: ['src/**/*.test.ts'] } };", files: ["src/a.test.ts"] } },
      ...opts,
    });
    return [...findWholesalePackageRuns(fx.root, fx.workflowDir, fx.pkgDirs).keys()];
  };

  it("groups commands into &&/|| LISTS with their terminator", () => {
    expect(groupShellLists(splitShellCommands("a && b\nc"))).toEqual([
      { commands: [{ text: "a ", op: "&&" }, { text: " b", op: null }], terminator: "\n" },
      { commands: [{ text: "c", op: null }], terminator: "" },
    ]);
  });

  it("reads every `set` spelling that moves errexit", () => {
    expect(errexitSetting("set +e")).toBe(false);
    expect(errexitSetting("set -e")).toBe(true);
    expect(errexitSetting("set +o errexit")).toBe(false);
    expect(errexitSetting("set -o errexit")).toBe(true);
    expect(errexitSetting("set -euo pipefail")).toBe(true);
    expect(errexitSetting("set +uxe")).toBe(false);
    expect(errexitSetting("set -o pipefail")).toBe(null); // does not touch errexit
    expect(errexitSetting("setup")).toBe(null);
    // …and the long form is honoured end to end.
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          set +o errexit\n          cd packages/p && pnpm test\n          true\n")).toEqual([]);
  });

  it("does NOT credit a runner after `exec`, which REPLACES the shell", () => {
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          exec true\n          cd packages/p && pnpm test\n")).toEqual([]);
  });

  it("does NOT credit a BACKGROUNDED runner in a workflow block", () => {
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p\n          pnpm test & wait\n")).toEqual([]);
  });

  it("does NOT credit a runner in a list that also holds `||`, however it is reached", () => {
    // `test -d /missing && pnpm test; true` exits 0 under bash -e (measured).
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p\n          [ -d node_modules ] || pnpm test\n          echo next\n")).toEqual([]);
  });

  it("only credits a shell whose failure semantics are modelled", () => {
    expect(isErrexitBashShell(undefined)).toBe(true);
    expect(isErrexitBashShell("bash")).toBe(true);
    expect(isErrexitBashShell("sh")).toBe(true);
    expect(isErrexitBashShell("bash {0}")).toBe(false); // custom template, no -e
    expect(isErrexitBashShell("pwsh")).toBe(false);
    expect(isErrexitBashShell("python")).toBe(false);
    expect(wf("jobs:\n  a:\n    steps:\n      - name: x\n        shell: bash {0}\n        run: cd packages/p && pnpm test\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - name: x\n        shell: pwsh\n        run: cd packages/p && pnpm test\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - name: x\n        shell: bash\n        run: cd packages/p && pnpm test\n")).toEqual(["packages/p"]);
  });

  it("does NOT count a change trigger narrowed by a path filter", () => {
    const body = "jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm test\n";
    expect(wf(body, { trigger: "on:\n  pull_request:\n    paths:\n      - 'src/**'\n" })).toEqual([]);
    expect(wf(body, { trigger: "on:\n  push:\n    paths-ignore:\n      - '**'\n" })).toEqual([]);
    // A trigger carrying only `branches`/`types` still fires on every change
    // to the package, so it counts — this is build-image.yml's real shape.
    expect(wf(body, { trigger: "on:\n  pull_request:\n    types: [opened, synchronize]\n" })).toEqual(["packages/p"]);
    // …and one FILTERED trigger does not poison an unfiltered sibling.
    expect(wf(body, { trigger: "on:\n  push:\n    paths-ignore: ['docs/**']\n  pull_request:\n" })).toEqual(["packages/p"]);
  });

  it("REFUSES a computed or conditional `include` instead of reading it as 'discovers everything'", () => {
    const cfg = (text) => {
      const root = mkdtempSync(join(tmpdir(), "ci-cfg2-"));
      writeFileSync(join(root, "vitest.config.ts"), text);
      return join(root, "vitest.config.ts");
    };
    expect(() => parseVitestTestGlobs(cfg("export default { test: { include: buildInclude() } };"))).toThrow(/array literal/);
    expect(() => parseVitestTestGlobs(cfg("export default { test: { include: MINIMAL ? ['a/*.test.ts'] : ['b/*.test.ts'] } };"))).toThrow(/array literal/);
    // A conditional SPREAD inside the array is refused too — folding both
    // branches would UNION them and credit files only one branch discovers.
    expect(() =>
      parseVitestTestGlobs(cfg("export default { test: { include: [...(process.env.M === '1' ? ['a/*.test.ts'] : ['b/*.test.ts'])] } };")),
    ).toThrow(/Refusing/);
  });

  it("REFUSES a package whose discovery is governed by a config filename this parser does not read", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-cfg3-"));
    writeFileSync(join(root, "vitest.config.mts"), "export default { test: { include: ['a/*.test.ts'] } };");
    expect(() => parseVitestTestGlobs(join(root, "vitest.config.ts"))).toThrow(/does not read/);
    expect(findRivalVitestConfig(join(root, "vitest.config.ts"))).toContain("vitest.config.mts");
    // No rival ⇒ vitest's defaults, as before.
    const bare = mkdtempSync(join(tmpdir(), "ci-cfg4-"));
    expect(parseVitestTestGlobs(join(bare, "vitest.config.ts")).include).toBe(null);
  });

  it("credits a PIN only where it can turn the check red", () => {
    // A `node --test` pin in a manual-only workflow, or in a
    // continue-on-error step, proves the file exists and nothing more.
    const mk = (workflow, trigger) => {
      const fx = pkgFixture({ workflow, trigger, packages: { p: { files: ["src/a.test.mjs"] } } });
      return resolveEnforcedPins(fx.root, fx.workflowDir, fx.tracked, fx.pkgDirs);
    };
    const enforcing = mk("jobs:\n  a:\n    steps:\n      - run: node --test packages/p/src/a.test.mjs\n", undefined);
    expect([...enforcing.nodeExact]).toEqual(["packages/p/src/a.test.mjs"]);
    const dispatchOnly = mk("jobs:\n  a:\n    steps:\n      - run: node --test packages/p/src/a.test.mjs\n", "on: [workflow_dispatch]\n");
    expect([...dispatchOnly.nodeExact]).toEqual([]);
    const soft = mk("jobs:\n  a:\n    steps:\n      - name: x\n        continue-on-error: true\n        run: node --test packages/p/src/a.test.mjs\n", undefined);
    expect([...soft.nodeExact]).toEqual([]);
  });

  it("drops root-include coverage when the root suite is not ENFORCED anywhere", () => {
    const fx = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: pnpm typecheck\n",
      packages: { llm: { files: ["src/a.test.ts"] } },
    });
    const globs = { include: ["packages/llm/src/**/*.test.ts"], exclude: ["**/node_modules/**"] };
    expect(auditFixture(fx, { globs, rootEnforced: true }).ungated).toEqual([]);
    expect(auditFixture(fx, { globs, rootEnforced: false }).ungated.map((u) => u.file)).toEqual([
      "packages/llm/src/a.test.ts",
    ]);
  });

  it("governs `*.spec.*` too — vitest's default include is {test,spec}", () => {
    const fx = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: pnpm typecheck\n",
      packages: { llm: { files: ["src/a.spec.ts"] } },
    });
    expect(auditFixture(fx).ungated.map((u) => u.file)).toEqual(["packages/llm/src/a.spec.ts"]);
  });

  it("the LIVE repo: the enforced view still covers everything, and the root suite IS enforced", () => {
    expect(rootSuiteIsEnforced()).toBe(true);
    expect(packageTestFiles().length).toBeGreaterThan(900);
    const v = auditPackageSuiteRunners();
    expect(v.ungated).toEqual([]);
    expect(v.staleExceptions).toEqual([]);
    expect(v.redundantExceptions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Direction 3 — round-3 adversarial closures.
// ---------------------------------------------------------------------------
describe("direction 3 — round-3 fail-open closures", () => {
  const wf = (body, opts = {}) => {
    const fx = pkgFixture({
      workflow: body,
      packages: { p: { scripts: { test: "vitest run" }, config: "export default { test: { include: ['src/**/*.test.ts'] } };", files: ["src/a.test.ts"] } },
      ...opts,
    });
    return [...findWholesalePackageRuns(fx.root, fx.workflowDir, fx.pkgDirs).keys()];
  };

  it("credits only a `run:` that belongs to a STEP, never one that is just data", () => {
    // `env: { run: … }` is a variable named `run`; nothing executes it.
    expect(wf("env:\n  run: cd packages/p && pnpm test\njobs:\n  a:\n    steps:\n      - run: echo hi\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    env:\n      run: cd packages/p && pnpm test\n    steps:\n      - run: echo hi\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - uses: ./x\n        with:\n          run: cd packages/p && pnpm test\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm test\n")).toEqual(["packages/p"]);
  });

  it("stops at `exit`/`exec` ANYWHERE in a list, not just at its head", () => {
    // `true && exit 0 && pnpm test` reaches the exit and never the runner.
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p\n          true && exit 0 && pnpm test\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p\n          true && exec true\n          pnpm test\n")).toEqual([]);
  });

  it("honours a `set +e` that appears mid-list", () => {
    expect(
      wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p\n          true && set +e\n          pnpm test\n          echo survived\n"),
    ).toEqual([]);
  });

  it("refuses a block installing an ERR trap — it can turn every later failure green", () => {
    // `trap "exit 0" ERR` + a failing runner exits 0 under `bash -eo pipefail`.
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          trap \"exit 0\" ERR\n          cd packages/p && pnpm test\n")).toEqual([]);
  });

  it("refuses a package script whose vitest command is unreachable or whose errexit moves", () => {
    const scriptFixture = (test) => {
      const root = mkdtempSync(join(tmpdir(), "ci-pkgscript3-"));
      mkdirSync(join(root, "packages", "p"), { recursive: true });
      writeFileSync(join(root, "packages", "p", "package.json"), JSON.stringify({ name: "@x/p", scripts: { test } }));
      return root;
    };
    const wholesale = (t) => packageScriptIsWholesaleVitest(scriptFixture(t), "packages/p", "test", "vitest.config.ts");
    expect(wholesale("true && exit 0 && vitest run --config vitest.config.ts")).toBe(false);
    expect(wholesale("trap 'exit 0' ERR && vitest run")).toBe(false);
    expect(wholesale("set +e && vitest run")).toBe(false);
    expect(wholesale("vitest run")).toBe(true);
  });

  it("treats a backslash-quoted heredoc body as DATA", () => {
    // `cat <<\EOF … EOF` quotes the body exactly like `<<'EOF'`.
    expect(
      wf("jobs:\n  a:\n    steps:\n      - run: |\n          cat <<\\EOF\n          cd packages/p && pnpm test\n          EOF\n"),
    ).toEqual([]);
  });

  it("detects a FLOW-style path filter, not only the block-style one", () => {
    const body = "jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm test\n";
    expect(wf(body, { trigger: "on:\n  pull_request: { paths: ['docs/**'] }\n" })).toEqual([]);
    expect(wf(body, { trigger: "on: { pull_request: { paths-ignore: ['**'] } }\n" })).toEqual([]);
    expect(wf(body, { trigger: "on: { pull_request: null }\n" })).toEqual(["packages/p"]);
  });

  it("the LIVE gate uses the ENFORCED pin view (the CLI no longer passes the raw one)", () => {
    // A pin in a manual-only workflow must not count as coverage anywhere.
    const fx = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: node --test packages/llm/src/a.test.mjs\n",
      trigger: "on: [workflow_dispatch]\n",
      packages: { llm: { files: ["src/a.test.mjs"] } },
    });
    const enforced = resolveEnforcedPins(fx.root, fx.workflowDir, fx.tracked, fx.pkgDirs);
    expect([...enforced.nodeExact]).toEqual([]);
    const v = auditPackageSuiteRunners(fx.root, fx.workflowDir, {
      tracked: fx.tracked,
      packageFiles: fx.tracked,
      pkgDirs: fx.pkgDirs,
      globs: NO_ROOT_GLOBS,
      rootEnforced: true,
      exceptions: [],
    });
    expect(v.ungated.map((u) => u.file)).toEqual(["packages/llm/src/a.test.mjs"]);
  });

  it("the LIVE repo is still fully covered after every round-3 closure", () => {
    expect(auditPackageSuiteRunners().ungated).toEqual([]);
    expect(findWholesalePackageRuns().size).toBeGreaterThanOrEqual(23);
    expect(rootSuiteIsEnforced()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Direction 3 — round-4 adversarial closures.
// ---------------------------------------------------------------------------
describe("direction 3 — round-4 fail-open closures", () => {
  const wf = (body, opts = {}) => {
    const fx = pkgFixture({
      workflow: body,
      packages: { p: { scripts: { test: "vitest run" }, config: "export default { test: { include: ['src/**/*.test.ts'] } };", files: ["src/a.test.ts"] } },
      ...opts,
    });
    return [...findWholesalePackageRuns(fx.root, fx.workflowDir, fx.pkgDirs).keys()];
  };

  it("abandons a block containing a shell CONTROL construct — a dead branch runs nothing", () => {
    // `if false; then pnpm test; fi` exits 0 having executed no suite.
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p\n          if false; then pnpm test; fi\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p\n          for i in 1; do pnpm test; done\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p\n          while false; do pnpm test; done\n")).toEqual([]);
  });

  it("keeps a trailing `&&`/`||` joined to the next LINE", () => {
    // `true ||\n  pnpm test` is one list; the runner is short-circuited away.
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p\n          true ||\n            pnpm test\n")).toEqual([]);
    // …and a genuine `&&` continuation still gates as the block's last list.
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p &&\n            pnpm test\n")).toEqual(["packages/p"]);
  });

  it("sees `exit` behind an env prefix, and `set -x +e` mid-flags", () => {
    expect(stripEnvPrefix("X=1 Y=2 exit 0")).toBe("exit 0");
    expect(errexitSetting("set -x +e")).toBe(false);
    expect(errexitSetting("set +x -e")).toBe(true);
    expect(errexitSetting("set -x")).toBe(null);
    expect(errexitSetting("set +o errexit")).toBe(false);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p\n          X=1 exit 0\n          pnpm test\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          set -x +e\n          cd packages/p && pnpm test\n          true\n")).toEqual([]);
  });

  it("treats a NUMERIC heredoc delimiter as a delimiter", () => {
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cat <<123\n          cd packages/p && pnpm test\n          123\n")).toEqual([]);
  });

  it("does NOT count a trigger narrowed by branches-ignore", () => {
    const body = "jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm test\n";
    expect(wf(body, { trigger: "on:\n  push:\n    branches-ignore: ['**']\n" })).toEqual([]);
    // A plain `branches:` allowlist is build-image.yml's real shape and stays credited.
    expect(wf(body, { trigger: "on:\n  push:\n    branches: [main]\n" })).toEqual(["packages/p"]);
  });

  it("requires `steps:` to belong to a JOB", () => {
    expect(runKeyIsStep(["jobs:", "  a:", "    steps:", "      - run: x"], 3, 8)).toBe(true);
    expect(runKeyIsStep(["steps:", "  - run: x"], 1, 4)).toBe(false);
    expect(wf("steps:\n  - run: cd packages/p && pnpm test\n")).toEqual([]);
  });

  it("does NOT credit a package script that `cd`s into another package", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-pkgscript4-"));
    mkdirSync(join(root, "packages", "p"), { recursive: true });
    writeFileSync(
      join(root, "packages", "p", "package.json"),
      JSON.stringify({ name: "@x/p", scripts: { test: "cd ../agents && vitest run --config vitest.config.ts" } }),
    );
    expect(packageScriptIsWholesaleVitest(root, "packages/p", "test", "vitest.config.ts")).toBe(false);
  });

  it("does NOT read a workspace-recursive invocation as the repo-root suite", () => {
    expect(invokesRootSuite("npm --workspaces --if-present run test:root")).toBe(false);
    expect(invokesRootSuite("pnpm -r run test:root")).toBe(false);
    expect(invokesRootSuite("pnpm test:root")).toBe(true);
  });

  it("does NOT read an unparseable working-directory as the repo root", () => {
    // A trailing comment used to break the value match and fall back to "",
    // which would credit a package-local script as the wholesale root suite.
    const commented = extractRunBlocks(
      "jobs:\n  a:\n    steps:\n      - name: x\n        working-directory: packages/p # note\n        run: pnpm exec vitest run\n",
    );
    expect(commented[0].baseCwd).toBe("packages/p");
    expect(commented[0].baseCwdUnknown).toBe(false);
    const expanded = extractRunBlocks(
      "jobs:\n  a:\n    steps:\n      - name: x\n        working-directory: ${{ env.WD }}\n        run: pnpm exec vitest run\n",
    );
    expect(expanded[0].baseCwdUnknown).toBe(true);
    expect(wf("jobs:\n  a:\n    steps:\n      - name: x\n        working-directory: ${{ env.WD }}\n        run: pnpm exec vitest run\n")).toEqual([]);
  });

  it("REFUSES a computed, shorthand or imported discovery config instead of defaulting open", () => {
    const cfg = (text) => {
      const root = mkdtempSync(join(tmpdir(), "ci-cfg5-"));
      writeFileSync(join(root, "vitest.config.ts"), text);
      return join(root, "vitest.config.ts");
    };
    expect(() => parseVitestTestGlobs(cfg("export default { test: { include: ['a/*.test.ts'], exclude: exclusions } };"))).toThrow(/exclude/);
    expect(() => parseVitestTestGlobs(cfg("const include = ['a/*.test.ts']; export default { test: { include } };"))).toThrow(/include/);
    expect(() => parseVitestTestGlobs(cfg("import { test } from './shared'; export default { test };"))).toThrow(/object literal/);
    // The ordinary shape still parses.
    expect(parseVitestTestGlobs(cfg("export default { test: { include: ['a/*.test.ts'] } };")).include).toEqual(["a/*.test.ts"]);
  });

  it("the LIVE repo survives every round-4 closure", () => {
    expect(auditPackageSuiteRunners().ungated).toEqual([]);
    expect(findWholesalePackageRuns().size).toBe(26);
    expect(rootSuiteIsEnforced()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Direction 3 — round-5 adversarial closures.
// ---------------------------------------------------------------------------
describe("direction 3 — round-5 fail-open closures", () => {
  const wf = (body, opts = {}) => {
    const fx = pkgFixture({
      workflow: body,
      packages: { p: { scripts: { test: "vitest run" }, config: "export default { test: { include: ['src/**/*.test.ts'] } };", files: ["src/a.test.ts"] } },
      ...opts,
    });
    return [...findWholesalePackageRuns(fx.root, fx.workflowDir, fx.pkgDirs).keys()];
  };

  it("refuses a TERMINAL flag — `--help`/`--version` print and exit 0, running nothing", () => {
    expect(hasTerminalFlag(["pnpm", "--help", "run", "test:root"])).toBe(true);
    expect(invokesRootSuite("pnpm --help run test:root")).toBe(false);
    expect(invokesRootSuite("pnpm --version")).toBe(false);
    expect(runnerArgv("pnpm exec vitest run --help a.test.ts")).toBe(null);
    expect(runnerArgv("node --test --help a.test.mjs")).toBe(null);
    expect(packageScriptInvocation("pnpm --help test")).toBe(null);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm --help test\n")).toEqual([]);
    // The ordinary invocations are untouched.
    expect(invokesRootSuite("pnpm test:root")).toBe(true);
    expect(runnerArgv("pnpm exec vitest run a.test.ts")?.runner).toBe("vitest");
  });

  it("sees a terminator or a `set` behind `command`/`builtin`, and behind a quoted env value", () => {
    expect(stripEnvPrefix("command exit 0")).toBe("exit 0");
    expect(stripEnvPrefix("builtin set +e")).toBe("set +e");
    expect(stripEnvPrefix('FOO="a b" exit 0')).toBe("exit 0");
    expect(stripEnvPrefix('"exit" 0')).toBe("exit 0");
    expect(errexitSetting("command set +e")).toBe(false);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          command exit 0\n          cd packages/p && pnpm test\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          command set +e\n          cd packages/p && pnpm test\n          true\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          FOO=\"a b\" exit 0\n          cd packages/p && pnpm test\n")).toEqual([]);
  });

  it("abandons a block defining a shell FUNCTION — its body is never called", () => {
    expect(isShellControlCommand("demo() {")).toBe(true);
    expect(isShellControlCommand("function demo {")).toBe(true);
    expect(isShellControlCommand("pnpm test")).toBe(false);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          demo() {\n          cd packages/p && pnpm test\n          }\n")).toEqual([]);
  });

  it("treats a dotted heredoc delimiter as a delimiter", () => {
    expect(
      wf("jobs:\n  a:\n    steps:\n      - run: |\n          cat <<\"END.DOC\"\n          cd packages/p && pnpm test\n          END.DOC\n"),
    ).toEqual([]);
  });

  it("does NOT let a subshell `cd` (either side of a pipe, or backgrounded) move the cwd", () => {
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          true | cd packages/p\n          pnpm test\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p & wait\n          pnpm test\n")).toEqual([]);
  });

  it("does NOT credit a package for a run pnpm redirects to the WORKSPACE ROOT", () => {
    const pkgDirs = new Map([["@x/p", "packages/p"]]);
    expect(segmentTargetDir("pnpm -w test", "packages/p", pkgDirs)).toBe("");
    expect(segmentTargetDir("pnpm --workspace-root run test", "packages/p", pkgDirs)).toBe("");
    expect(
      wf("jobs:\n  a:\n    steps:\n      - name: x\n        working-directory: packages/p\n        run: pnpm -w test\n"),
    ).toEqual([]);
  });

  it("the LIVE repo survives every round-5 closure", () => {
    expect(auditPackageSuiteRunners().ungated).toEqual([]);
    expect(findWholesalePackageRuns().size).toBe(26);
    expect(rootSuiteIsEnforced()).toBe(true);
    expect(findRootSuiteInvocations()).toContain("build-image.yml");
  });
});

// ---------------------------------------------------------------------------
// Direction 3 — round-6 adversarial closures.
// ---------------------------------------------------------------------------
describe("direction 3 — round-6 fail-open closures", () => {
  const wf = (body, opts = {}) => {
    const fx = pkgFixture({
      workflow: body,
      packages: {
        p: { scripts: { test: "vitest run" }, config: "export default { test: { include: ['src/**/*.test.ts'] } };", files: ["src/a.test.ts"] },
        q: { scripts: { test: "vitest run" }, config: "export default { test: { include: ['src/**/*.test.ts'] } };", files: ["src/a.test.ts"] },
      },
      ...opts,
    });
    return [...findWholesalePackageRuns(fx.root, fx.workflowDir, fx.pkgDirs).keys()];
  };

  it("does NOT apply a CONDITIONAL `cd` — only the first command of a list is unconditional", () => {
    // `test -d missing && cd ../q` leaves the shell where it was.
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p\n          test -d missing && cd ../q\n          pnpm test\n")).toEqual([]);
    // The ordinary `cd <pkg> && pnpm test` (cd first) still credits.
    expect(wf("jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm test\n")).toEqual(["packages/p"]);
  });

  it("sees a `cd` behind an env prefix rather than silently keeping the old cwd", () => {
    // `X=1 cd ../q` DOES move the shell; keeping packages/p would credit the
    // wrong package's suite.
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cd packages/p\n          X=1 cd ../q\n          pnpm test\n")).toEqual(["packages/q"]);
  });

  it("recognises `demo () { … }` with a space before the parens", () => {
    expect(isShellControlCommand("demo () {")).toBe(true);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          demo () {\n          cd packages/p && pnpm test\n          }\n")).toEqual([]);
  });

  it("accepts any non-metacharacter heredoc delimiter (`END+DOC`)", () => {
    expect(wf("jobs:\n  a:\n    steps:\n      - run: |\n          cat <<END+DOC\n          cd packages/p && pnpm test\n          END+DOC\n")).toEqual([]);
  });

  it("honours a QUOTED disabling key (`\"if\": false`)", () => {
    expect(wf("jobs:\n  a:\n    steps:\n      - name: x\n        \"if\": false\n        run: cd packages/p && pnpm test\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - name: x\n        'continue-on-error': true\n        run: cd packages/p && pnpm test\n")).toEqual([]);
  });

  it("REFUSES a `test.dir` that re-bases discovery, exactly like `root:`", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-cfg6-"));
    writeFileSync(join(root, "vitest.config.ts"), 'export default { test: { dir: "src/unit-only" } };');
    expect(() => parseVitestTestGlobs(join(root, "vitest.config.ts"))).toThrow(/re-bases/);
  });

  it("the LIVE repo survives every round-6 closure", () => {
    expect(auditPackageSuiteRunners().ungated).toEqual([]);
    expect(findWholesalePackageRuns().size).toBe(26);
    expect(rootSuiteIsEnforced()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Direction 3 — round-7 adversarial closures (the last mechanical class:
// quoted YAML keys, case-insensitive booleans, non-Linux runners, and pins
// that select nothing).
// ---------------------------------------------------------------------------
describe("direction 3 — round-7 fail-open closures", () => {
  const wf = (body, opts = {}) => {
    const fx = pkgFixture({
      workflow: body,
      packages: { p: { scripts: { test: "vitest run" }, config: "export default { test: { include: ['src/**/*.test.ts'] } };", files: ["src/a.test.ts"] } },
      ...opts,
    });
    return [...findWholesalePackageRuns(fx.root, fx.workflowDir, fx.pkgDirs).keys()];
  };

  it("does NOT credit a pin that can select nothing (`--exclude`, `--passWithNoTests`)", () => {
    expect(invocationCannotProveExecution("pnpm exec vitest run src/dark.test.ts --exclude=**/dark.test.ts")).toBe(true);
    expect(invocationCannotProveExecution("pnpm exec vitest run src/dark.test.ts --passWithNoTests")).toBe(true);
    expect(invocationCannotProveExecution("pnpm exec vitest run src/dark.test.ts --no-coverage")).toBe(false);
    // …and `--passWithNoTests` no longer makes a WHOLESALE run acceptable
    // either: a run that exits 0 having collected nothing is the vacuous green
    // this gate exists to catch.
    expect(wholesaleVitestArgv(["--passWithNoTests"], null)).toBe(false);
    const fx = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm exec vitest run src/a.test.ts --exclude=**/a.test.ts --passWithNoTests\n",
      packages: { p: { config: "export default { test: { include: ['src/**/*.test.ts'] } };", files: ["src/a.test.ts"] } },
    });
    expect([...resolveEnforcedPins(fx.root, fx.workflowDir, fx.tracked, fx.pkgDirs).resolved]).toEqual([]);
  });

  it("does NOT let a REPO-ROOT vitest pin stand in for a package config's discovery", () => {
    // `vitest run packages/p/a.test.ts` from the root is filtered by the ROOT
    // config, so it says nothing about what packages/p's own config discovers.
    const fx = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: pnpm exec vitest run packages/p/src/a.test.ts\n",
      packages: { p: { config: "export default { test: { include: ['src/**/*.test.ts'] } };", files: ["src/a.test.ts"] } },
    });
    expect([...resolveEnforcedPins(fx.root, fx.workflowDir, fx.tracked, fx.pkgDirs).resolved]).toEqual([]);
    // A pin scoped INSIDE the package still counts.
    const scoped = pkgFixture({
      workflow: "jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm exec vitest run src/a.test.ts\n",
      packages: { p: { config: "export default { test: { include: ['src/**/*.test.ts'] } };", files: ["src/a.test.ts"] } },
    });
    expect([...resolveEnforcedPins(scoped.root, scoped.workflowDir, scoped.tracked, scoped.pkgDirs).resolved]).toEqual([
      "packages/p/src/a.test.ts",
    ]);
  });

  it("reads QUOTED vitest config keys", () => {
    const cfg = (text) => {
      const root = mkdtempSync(join(tmpdir(), "ci-cfg7-"));
      writeFileSync(join(root, "vitest.config.ts"), text);
      return join(root, "vitest.config.ts");
    };
    expect(() => parseVitestTestGlobs(cfg('export default { test: { "dir": "src" } };'))).toThrow(/re-bases/);
    expect(parseVitestTestGlobs(cfg('export default { test: { "include": ["src/only.test.ts"] } };')).include).toEqual([
      "src/only.test.ts",
    ]);
  });

  it("treats npm's --prefix as the directory selector it is", () => {
    const pkgDirs = new Map();
    expect(segmentTargetDir("npm --prefix=../q test", "packages/p", pkgDirs)).toBe("../q");
    expect(segmentTargetDir("npm --prefix ../q test", "packages/p", pkgDirs)).toBe("../q");
  });

  it("honours a QUOTED job id and a case-insensitive YAML boolean", () => {
    expect(isLiterallyFalse("FALSE")).toBe(true);
    expect(isLiterallyFalse("False")).toBe(true);
    expect(isLiterallyTrue("TRUE")).toBe(true);
    expect(wf("jobs:\n  \"gate\":\n    if: false\n    steps:\n      - run: cd packages/p && pnpm test\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - name: x\n        if: FALSE\n        run: cd packages/p && pnpm test\n")).toEqual([]);
  });

  it("honours a QUOTED block-style path filter key", () => {
    const body = "jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm test\n";
    expect(wf(body, { trigger: "on:\n  pull_request:\n    \"paths\":\n      - 'docs/**'\n" })).toEqual([]);
  });

  it("refuses a job whose runner is not demonstrably Linux (the default shell differs)", () => {
    expect(wf("jobs:\n  a:\n    runs-on: windows-latest\n    steps:\n      - run: cd packages/p && pnpm test\n")).toEqual([]);
    expect(wf("jobs:\n  a:\n    steps:\n      - run: cd packages/p && pnpm test\n")).toEqual(["packages/p"]); // fixture injects ubuntu-latest
    expect(wf("jobs:\n  a:\n    runs-on: [self-hosted, linux]\n    steps:\n      - run: cd packages/p && pnpm test\n")).toEqual(["packages/p"]);
    // …but an explicit modelled `shell:` overrides the runner default.
    expect(
      wf("jobs:\n  a:\n    runs-on: windows-latest\n    steps:\n      - name: x\n        shell: bash\n        run: cd packages/p && pnpm test\n"),
    ).toEqual(["packages/p"]);
  });

  it("the LIVE repo survives every round-7 closure", () => {
    expect(auditPackageSuiteRunners().ungated).toEqual([]);
    expect(findWholesalePackageRuns().size).toBe(26);
    expect(rootSuiteIsEnforced()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Direction 3 — round-8 adversarial closures. This is where the review loop was
// closed: every finding from here on was a narrower spelling of a class already
// modelled, and the residual is documented in the module header rather than
// chased further.
// ---------------------------------------------------------------------------
describe("direction 3 — round-8 fail-open closures", () => {
  const wf = (body, opts = {}) => {
    const fx = pkgFixture({
      workflow: body,
      packages: { p: { scripts: { test: "vitest run" }, config: "export default { test: { include: ['src/**/*.test.ts'] } };", files: ["src/a.test.ts"] } },
      ...opts,
    });
    return [...findWholesalePackageRuns(fx.root, fx.workflowDir, fx.pkgDirs).keys()];
  };

  it("sees a narrowing pin flag however it is quoted, and covers -t / --config", () => {
    expect(invocationCannotProveExecution('vitest run a.test.ts "--exclude=a.test.ts"')).toBe(true);
    expect(invocationCannotProveExecution("vitest run a.test.ts '--passWithNoTests'")).toBe(true);
    expect(invocationCannotProveExecution("vitest run a.test.ts -t nope")).toBe(true);
    expect(invocationCannotProveExecution("vitest run a.test.ts --config other.ts")).toBe(true);
    expect(invocationCannotProveExecution("vitest run a.test.ts --no-coverage")).toBe(false);
  });

  it("treats yarn's --cwd as a directory selector", () => {
    expect(segmentTargetDir("yarn --cwd=../q test", "packages/p", new Map())).toBe("../q");
  });

  it("does NOT accept an EXPANSION in runs-on as a demonstrable Linux runner", () => {
    expect(jobRunsOnLinux(["jobs:", "  a:", "    runs-on: ${{ vars.R || 'ubuntu-latest' }}", "    steps:", "      - run: x"], 4)).toBe(false);
    expect(jobRunsOnLinux(["jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", "      - run: x"], 4)).toBe(true);
    expect(
      wf("jobs:\n  a:\n    runs-on: ${{ vars.R || 'ubuntu-latest' }}\n    steps:\n      - run: cd packages/p && pnpm test\n"),
    ).toEqual([]);
  });

  it("reads a QUOTED `run:` key", () => {
    const blocks = extractRunBlocks("jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - \"run\": pnpm exec vitest run\n");
    expect(blocks.length).toBe(1);
    expect(wf("jobs:\n  a:\n    steps:\n      - \"run\": cd packages/p && pnpm test\n")).toEqual(["packages/p"]);
  });

  it("REFUSES a re-basing key in the ROOT config too, and a `dir` SHORTHAND in the test block", () => {
    expect(() => parseRootVitestTestGlobs(".", "export default { root: 'src', test: { include: ['a/*.test.ts'], exclude: ['x'] } };")).toThrow(/re-bases/);
    expect(testBlockHasShorthand("export default { test: { dir, include: ['a'] } };", "dir")).toBe(true);
    // …but a local `root` used as a FUNCTION ARGUMENT is not a config key —
    // every package config that aliases paths writes `path.join(root, "…")`.
    expect(testBlockHasShorthand("const x = path.join(root, 'a'); export default { test: { include: ['a'] } };", "dir")).toBe(false);
    expect(parseVitestTestGlobs("/nonexistent/vitest.config.ts", "const p = path.join(\n  root,\n  'x',\n);\nexport default { test: { include: ['a/*.test.ts'] } };").include).toEqual(["a/*.test.ts"]);
  });

  it("the LIVE repo survives every round-8 closure — the final state", () => {
    const v = auditPackageSuiteRunners();
    expect(v.ungated).toEqual([]);
    expect(v.staleExceptions).toEqual([]);
    expect(v.redundantExceptions).toEqual([]);
    expect(findWholesalePackageRuns().size).toBe(26);
    expect(rootSuiteIsEnforced()).toBe(true);
    expect(findUngatedAuditTests(REPO_ROOT)).toEqual([]);
    expect(findMissingPinnedTests()).toEqual([]);
  });
});
