import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractRunBlocks,
  pinnedTestsInBlock,
  findMissingPinnedTests,
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
    expect(pins).toEqual([{ token: "src/__tests__/x.test.ts", cwd: "packages/objects" }]);
  });

  it("ignores glob filters and non-runner segments", () => {
    const body = "pnpm exec vitest run src/lib/authz --exclude '**/build-actor-context-from-run.test.ts'";
    expect(pinnedTestsInBlock(body)).toEqual([]); // glob token skipped; dir filter has no .test. token
    expect(pinnedTestsInBlock("echo src/not-a-runner.test.ts")).toEqual([]);
  });

  it("recognizes `node --test` as a runner", () => {
    const pins = pinnedTestsInBlock("node --test scripts/audit/__tests__/foo.test.mjs");
    expect(pins).toEqual([{ token: "scripts/audit/__tests__/foo.test.mjs", cwd: "" }]);
  });

  it("follows shell `\\` line-continuations in a literal block", () => {
    const body = "node --test \\\n  scripts/a.test.mjs \\\n  scripts/b.test.mjs --no-coverage";
    const pins = pinnedTestsInBlock(body, "literal");
    expect(pins.map((p) => p.token).sort()).toEqual(["scripts/a.test.mjs", "scripts/b.test.mjs"]);
  });

  it("skips `--exclude=` equals-form values (not a pin)", () => {
    expect(pinnedTestsInBlock("pnpm exec vitest run src/a.test.ts --exclude=src/b.test.ts")).toEqual([
      { token: "src/a.test.ts", cwd: "" },
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
      { token: "x.test.ts", cwd: "packages/a" },
      { token: "y.test.ts", cwd: "" },
    ]);
  });
});

describe("ci-pinned-tests-exist — missing detection", () => {
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
