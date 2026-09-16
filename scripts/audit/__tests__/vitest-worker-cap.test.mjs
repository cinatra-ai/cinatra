/**
 * Tests for the vitest worker-cap gate (cinatra#3355).
 *
 * The gate is a VALUE contract, so the red cases are what matter: a
 * presence-only check would pass a stale file, and a governed-set derived from
 * filenames rather than from the RESOLVED runner would both sweep in playwright
 * files the variable cannot reach and drop real vitest runs that arrive through
 * a package script. Every case below is a synthetic workflow tree in a temp
 * directory — nothing here reads or writes the repository's own workflows.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EXPECTED_VALUE,
  auditVitestWorkerCap,
  deriveInventory,
  inventoryRow,
  literalRunner,
  reachesPlaywright,
  runnerClass,
  workflowLevelAssignments,
} from "../vitest-worker-cap.mjs";

const HEAVY = `\${{ fromJSON(vars.CI_RUNNER_HEAVY || '"ubuntu-latest"') }}`;
const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

/** A throwaway repo root: a git index (so `git ls-files` can resolve workspace packages) and a workflow dir. */
function makeRoot({ workflows = {}, packages = {}, rootScripts = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vitest-worker-cap-"));
  roots.push(root);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const [name, text] of Object.entries(workflows)) writeFileSync(join(root, ".github/workflows", name), text);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-root", scripts: rootScripts }, null, 2));
  for (const [dir, pkg] of Object.entries(packages)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(pkg, null, 2));
  }
  for (const args of [["init", "-q"], ["add", "-A"]]) {
    spawnSync("git", args, { cwd: root, encoding: "utf8" });
  }
  return root;
}

function workflow({ job = "unit", runsOn = HEAVY, env = null, run = "pnpm exec vitest run src" }) {
  return [
    "name: fixture",
    "on:",
    "  push:",
    "concurrency:",
    "  group: fixture",
    ...(env === null ? [] : ["env:", ...env]),
    "jobs:",
    `  ${job}:`,
    `    runs-on: ${runsOn}`,
    "    steps:",
    "      - name: Run the suite",
    `        run: ${run}`,
    "",
  ].join("\n");
}

const capped = [`  VITEST_MAX_WORKERS: "${EXPECTED_VALUE}"`];
const audit = (root) => auditVitestWorkerCap({ repoRoot: root, docPath: null, suiteGatePath: null });

describe("the governed set is derived by the RESOLVED runner", () => {
  it("governs a literal `vitest run` and passes when the file carries the cap", () => {
    const root = makeRoot({ workflows: { "a.yml": workflow({ env: capped }) } });
    const { failures, governed } = audit(root);
    expect(governed).toEqual(["a.yml"]);
    expect(failures).toEqual([]);
  });

  it("governs vitest reached through a package script — the case a literal-only rule drops", () => {
    const root = makeRoot({
      workflows: {
        "a.yml": workflow({ env: capped, run: "pnpm --filter @fix/plane run test:e2e" }),
      },
      packages: { "packages/plane": { name: "@fix/plane", scripts: { "test:e2e": "vitest run --config vitest.e2e.config.ts" } } },
    });
    const { failures, governed, entries } = audit(root);
    expect(governed).toEqual(["a.yml"]);
    expect(entries.map((e) => e.runner)).toEqual(["vitest"]);
    expect(failures).toEqual([]);
  });

  it("does NOT govern a script resolving to `playwright test` — green with no env block", () => {
    const root = makeRoot({
      workflows: { "a.yml": workflow({ run: "timeout --kill-after=60 780 pnpm test:e2e:render-smoke" }) },
      rootScripts: { "test:e2e:render-smoke": "playwright test -c tests/e2e/config/render-smoke.config.ts" },
    });
    const { failures, governed, entries } = audit(root);
    expect(governed).toEqual([]);
    expect(entries.map((e) => e.disposition)).toEqual(["playwright"]);
    expect(failures).toEqual([]);
  });

  it("does NOT govern a `node --test` file — green with no env block", () => {
    const root = makeRoot({ workflows: { "a.yml": workflow({ run: "node --test scripts/x.test.mjs" }) } });
    const { failures, governed, entries } = audit(root);
    expect(governed).toEqual([]);
    expect(entries.map((e) => e.disposition)).toEqual(["node:test"]);
    expect(failures).toEqual([]);
  });

  it("does NOT govern vitest in a hard-pinned hosted job — green with no env block", () => {
    const root = makeRoot({ workflows: { "a.yml": workflow({ runsOn: "ubuntu-latest" }) } });
    const { failures, governed, entries } = audit(root);
    expect(governed).toEqual([]);
    expect(entries.map((e) => e.disposition)).toEqual(["hosted-pinned"]);
    expect(failures).toEqual([]);
  });

  it("FAILS CLOSED on a test-shaped script it cannot resolve in one level", () => {
    const root = makeRoot({
      workflows: { "a.yml": workflow({ env: capped, run: "pnpm test:everything" }) },
      rootScripts: { "test:everything": "pnpm run test:inner" },
    });
    const { failures } = audit(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("reaches no test runner in ONE level");
    expect(failures[0]).toContain("test:everything");
  });
});

describe("the value contract", () => {
  it("RED — a governed file with NO workflow-level assignment", () => {
    const root = makeRoot({ workflows: { "a.yml": workflow({}) } });
    const { failures } = audit(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("carries NO workflow-level `VITEST_MAX_WORKERS`");
    expect(failures[0]).toContain("a.yml");
  });

  it("RED — a governed file with a DUPLICATE workflow-level assignment", () => {
    const root = makeRoot({
      workflows: { "a.yml": workflow({ env: [...capped, `  VITEST_MAX_WORKERS: "${EXPECTED_VALUE}"`] }) },
    });
    const { failures } = audit(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("2 workflow-level `VITEST_MAX_WORKERS` assignments");
    expect(failures[0]).toContain("there must be EXACTLY one");
  });

  it("RED — a governed file at the WRONG value, which a presence check would pass", () => {
    const root = makeRoot({ workflows: { "a.yml": workflow({ env: ['  VITEST_MAX_WORKERS: "4"'] }) } });
    const { failures } = audit(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`is "4"`);
    expect(failures[0]).toContain(`expected "${EXPECTED_VALUE}"`);
  });

  it("RED — governed files carrying MIXED values", () => {
    const root = makeRoot({
      workflows: {
        "a.yml": workflow({ env: capped }),
        "b.yml": workflow({ env: ['  VITEST_MAX_WORKERS: "6"'] }),
      },
    });
    const { failures } = audit(root);
    expect(failures.some((f) => f.includes("do not all carry the SAME"))).toBe(true);
    expect(failures.some((f) => f.includes(`b.yml="6"`))).toBe(true);
  });

  it("GREEN — several governed files all carrying the same value", () => {
    const root = makeRoot({
      workflows: { "a.yml": workflow({ env: capped }), "b.yml": workflow({ env: capped, job: "gate" }) },
    });
    const { failures, governed } = audit(root);
    expect(governed).toEqual(["a.yml", "b.yml"]);
    expect(failures).toEqual([]);
  });
});

describe("the inventory document and the extension-suite-gate exception", () => {
  it("RED — the document does not carry the full derived entry set", () => {
    const root = makeRoot({ workflows: { "a.yml": workflow({ env: capped }) } });
    const docPath = join(root, "doc.md");
    writeFileSync(docPath, "| a.yml | unit | 999 | CI_RUNNER_HEAVY | vitest | governed |\n");
    const { failures } = auditVitestWorkerCap({ repoRoot: root, docPath, suiteGatePath: null });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("1 missing, 1 stale");
  });

  it("GREEN — the document carrying exactly the derived rows", () => {
    const root = makeRoot({ workflows: { "a.yml": workflow({ env: capped }) } });
    const docPath = join(root, "doc.md");
    const { entries } = deriveInventory(root);
    writeFileSync(docPath, `${entries.map(inventoryRow).join("\n")}\n`);
    const { failures } = auditVitestWorkerCap({ repoRoot: root, docPath, suiteGatePath: null });
    expect(failures).toEqual([]);
  });

  it("RED — the suite gate no longer caps its own children at 1", () => {
    const root = makeRoot({ workflows: { "a.yml": workflow({ env: capped }) } });
    const suiteGatePath = join(root, "suite-gate.mjs");
    writeFileSync(suiteGatePath, "const env = { CI: \"1\" };\n");
    const { failures } = auditVitestWorkerCap({ repoRoot: root, docPath: null, suiteGatePath });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("no longer sets");
  });
});

describe("the helpers the classification rests on", () => {
  it("reads only TOP-LEVEL env assignments", () => {
    const text = [
      "env:",
      '  VITEST_MAX_WORKERS: "3"',
      "jobs:",
      "  unit:",
      "    env:",
      '      VITEST_MAX_WORKERS: "9"',
      "",
    ].join("\n");
    expect(workflowLevelAssignments(text)).toEqual([{ line: 2, value: "3" }]);
  });

  it("recognizes `playwright test` only in command position", () => {
    expect(reachesPlaywright("pnpm exec playwright test -c cfg.ts")).toBe(true);
    expect(reachesPlaywright("echo playwright test")).toBe(false);
    expect(reachesPlaywright("# playwright test")).toBe(false);
    expect(reachesPlaywright("pnpm exec vitest run src")).toBe(false);
  });

  it("treats a routed runs-on as reachable and a literal hosted label as pinned", () => {
    expect(runnerClass(HEAVY)).toEqual({ cls: "CI_RUNNER_HEAVY", hostedPinned: false });
    expect(runnerClass("ubuntu-latest")).toEqual({ cls: "ubuntu-latest", hostedPinned: true });
  });
});

describe("the bypasses a resolved-runner contract must not have", () => {
  it("governs `vitest` WITHOUT the `run` subcommand", () => {
    const root = makeRoot({ workflows: { "a.yml": workflow({ run: "pnpm exec vitest --project unit" }) } });
    const { failures, governed, entries } = audit(root);
    expect(governed).toEqual(["a.yml"]);
    expect(entries.map((e) => e.runner)).toEqual(["vitest"]);
    expect(failures[0]).toContain("carries NO workflow-level `VITEST_MAX_WORKERS`");
  });

  it("governs a script resolving to vitest whose NAME is not test-shaped", () => {
    const root = makeRoot({
      workflows: { "a.yml": workflow({ run: "pnpm verify" }) },
      rootScripts: { verify: "vitest run src" },
    });
    const { governed, failures } = audit(root);
    expect(governed).toEqual(["a.yml"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("carries NO workflow-level `VITEST_MAX_WORKERS`");
  });

  it("governs a script whose FIRST segment is another runner and whose second is vitest", () => {
    const root = makeRoot({
      workflows: { "a.yml": workflow({ run: "pnpm test:mixed" }) },
      rootScripts: { "test:mixed": "playwright test -c cfg.ts && vitest run src" },
    });
    const { governed, entries } = audit(root);
    expect(entries.map((e) => e.runner)).toEqual(["vitest"]);
    expect(governed).toEqual(["a.yml"]);
  });

  it("does NOT accept a block scalar that merely CONTAINS the assignment text", () => {
    const text = ["env:", "  NOTE: |", '    VITEST_MAX_WORKERS: "3"', "jobs:", ""].join("\n");
    expect(workflowLevelAssignments(text)).toEqual([]);
    const root = makeRoot({
      workflows: { "a.yml": workflow({ env: ["  NOTE: |", '    VITEST_MAX_WORKERS: "3"'] }) },
    });
    const { failures } = audit(root);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("carries NO workflow-level `VITEST_MAX_WORKERS`");
  });

  it("FAILS CLOSED when the step moves the working directory and the cwd walk lost the segment", () => {
    const run = ["cd packages/plane && pnpm test", "echo done"].join("\n          ");
    const root = makeRoot({
      workflows: { "a.yml": workflow({ env: capped, run: `|\n          ${run}` }) },
      rootScripts: { test: "playwright test -c cfg.ts" },
      packages: { "packages/plane": { name: "@fix/plane", scripts: { test: "vitest run" } } },
    });
    const { failures } = audit(root);
    expect(failures.some((f) => f.includes("cannot be resolved"))).toBe(true);
  });

  it("does NOT exempt a label SET that also names self-hosted", () => {
    expect(runnerClass("[self-hosted, ubuntu-latest]")).toEqual({
      cls: "self-hosted, ubuntu-latest",
      hostedPinned: false,
    });
    const root = makeRoot({ workflows: { "a.yml": workflow({ runsOn: "[self-hosted, ubuntu-latest]" }) } });
    const { governed, failures } = audit(root);
    expect(governed).toEqual(["a.yml"]);
    expect(failures[0]).toContain("carries NO workflow-level `VITEST_MAX_WORKERS`");
  });

  it("REPORTS a FIFTH exception class rather than passing an unknown runner in silence", () => {
    expect(literalRunner("pnpm exec jest --ci")).toBe("jest");
    const root = makeRoot({ workflows: { "a.yml": workflow({ run: "pnpm exec jest --ci" }) } });
    const { failures, governed } = audit(root);
    expect(governed).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("FIFTH exception class");
    expect(failures[0]).toContain("jest");
  });
});
