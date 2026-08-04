import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
