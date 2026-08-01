#!/usr/bin/env node
/**
 * Execution-plane Docker-battery MATRIX discovery (cinatra#2316).
 *
 * Emits one CI matrix leg per real-Docker battery under
 * `packages/execution-plane/src/__tests__/e2e/`, DISCOVERED from the filesystem
 * rather than listed by hand.
 *
 * WHY DISCOVERY AND NOT A LIST. The defect being fixed is a tier that ran
 * nowhere because nothing enumerated it. A hand-written battery list would
 * reintroduce exactly that failure mode one file later: somebody adds
 * `foo.e2e.test.ts`, forgets the workflow, and the battery is dark again while
 * CI stays green. So the glob is the source of truth, an unknown battery gets a
 * leg automatically, and a zero-leg discovery is a hard failure rather than an
 * empty (green) matrix.
 *
 * WHY ONE LEG PER FILE. `vitest.e2e.config.ts` runs the batteries strictly
 * serially (`fileParallelism: false`) because they share ONE docker daemon, one
 * fixed compose project, one fixed internal network name and one fixed
 * published broker port — they are mutually exclusive on a single host by
 * construction (see the note in `load-battery.e2e.test.ts`). A CI matrix does
 * not violate that: each leg is a SEPARATE GitHub runner with its own docker
 * daemon, so the batteries stay one-per-host while the wall clock collapses
 * from the sum to the slowest leg. It also attributes a failure to a battery
 * instead of to "the e2e job", and it lets each battery carry its OWN measured
 * timeout budget.
 *
 * THE TABLE BELOW IS A BUDGET/ROUTING HINT, NOT A COVERAGE MANIFEST. A battery
 * absent from it still gets a leg — with the conservative DEFAULT budget and
 * the LOUDEST routing (`pr`, i.e. it runs everywhere). Unknown cost must never
 * translate into "quietly not run"; if a new battery turns out to be expensive,
 * the fix is to measure it and add a row, not to let it skip.
 *
 * Usage:
 *   node scripts/ci/execution-plane-e2e-matrix.mjs --event <github.event_name>
 *   [--emit <path to $GITHUB_OUTPUT>]
 */

import { appendFileSync, globSync } from "node:fs";
import * as path from "node:path";

const E2E_DIR = "packages/execution-plane/src/__tests__/e2e";
const PATTERN = "*.e2e.test.ts";

/**
 * Measured on `ubuntu-latest` (2 vCPU / 16 GB) — see the runtime table in the
 * workflow header. `timeout` is the per-leg job budget in minutes: generous
 * enough that a slow runner is not a false red, tight enough that a genuine
 * hang surfaces as a failure instead of eating the six-hour default.
 *
 * `tier`:
 *   "pr"      — runs on pull requests too (path-gated), plus main + nightly.
 *   "nightly" — too expensive to pay on every push of an execution-plane PR;
 *               runs on main pushes, the nightly schedule and manual dispatch.
 *               NEVER "skipped": it has a real runner, on a stated cadence.
 */
const BUDGETS = {
  // filled in from the measurement run — see the workflow header table.
};

const DEFAULT_BUDGET = { timeout: 90, tier: "pr" };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--event") out.event = argv[++i];
    else if (argv[i] === "--emit") out.emit = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();

  const files = globSync(PATTERN, { cwd: path.join(repoRoot, E2E_DIR) })
    .map((entry) => entry.split(path.sep).join("/"))
    .sort();

  if (files.length === 0) {
    console.error(
      `::error::No battery matched ${E2E_DIR}/${PATTERN}. An empty matrix is a GREEN job that ` +
        "runs nothing — the exact silent-coverage failure cinatra#2316 fixed. Refusing to emit it.",
    );
    process.exit(1);
  }

  const legs = files.map((file) => {
    const name = file.replace(/\.e2e\.test\.ts$/, "");
    const budget = BUDGETS[file] ?? DEFAULT_BUDGET;
    if (!BUDGETS[file]) {
      console.log(
        `::notice::Battery ${file} has no measured budget row — running it on the conservative ` +
          `default (${DEFAULT_BUDGET.timeout} min, tier "${DEFAULT_BUDGET.tier}"). Measure it and add a row.`,
      );
    }
    return {
      name,
      // Repo-relative: what the leg is called in logs, and (being a substring
      // of the absolute path) a Vitest file filter that matches exactly one file.
      file: `${E2E_DIR}/${file}`,
      // Package-relative: the tier-coverage guard's `--expect` glob for this leg.
      expect: `src/__tests__/e2e/${file}`,
      timeout: budget.timeout,
      tier: budget.tier,
    };
  });

  // On a pull request only the `pr`-tier batteries run; every other trigger
  // (main push / nightly schedule / manual dispatch) runs the whole tier.
  const selected =
    args.event === "pull_request" ? legs.filter((leg) => leg.tier === "pr") : legs;

  const nightlyOnly = legs.filter((leg) => leg.tier !== "pr").map((leg) => leg.name);
  if (args.event === "pull_request" && nightlyOnly.length > 0) {
    console.log(
      `::notice::Not run on this PR (main-push + nightly schedule + manual dispatch only): ` +
        `${nightlyOnly.join(", ")}. Measured too expensive for per-push cost — see the workflow header.`,
    );
  }

  const matrix = { include: selected };
  const payload = JSON.stringify(matrix);
  console.log(`Discovered ${legs.length} batter(y|ies); running ${selected.length} on "${args.event}".`);
  console.log(payload);

  const target = args.emit ?? process.env.GITHUB_OUTPUT;
  if (target) {
    appendFileSync(target, `matrix=${payload}\n`);
    appendFileSync(target, `count=${selected.length}\n`);
    appendFileSync(target, `discovered=${legs.length}\n`);
  }
}

main();
