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
 * from the sum (~19 min) to the slowest leg (~7 min). It also attributes a
 * failure to a battery instead of to "the e2e job", and it lets each battery
 * carry its OWN measured timeout budget.
 *
 * EVERY DISCOVERED BATTERY RUNS ON EVERY TRIGGER. There is deliberately no
 * per-battery trigger routing: the batteries were MEASURED (see the table
 * below) and the most expensive is ~7 minutes, so none of them is too heavy to
 * pay on a pull request. A routing lever nothing needs is a lever that can only
 * ever be used to make coverage quietly smaller — if a future battery really is
 * too expensive for per-PR cost, add the lever then, with its measurement.
 */

import { appendFileSync, globSync } from "node:fs";
import * as path from "node:path";

const E2E_DIR = "packages/execution-plane/src/__tests__/e2e";
const PATTERN = "*.e2e.test.ts";

/**
 * Per-battery job timeout in MINUTES.
 *
 * These are budgets, not predictions. Each is set well above the measured job
 * wall clock on a stock `ubuntu-latest` (2 vCPU / 16 GB), because a contended
 * runner is slower than a quiet one and a false red costs more than a late
 * failure — but each is far below the six-hour default, so a genuine HANG
 * surfaces as a job failure within the hour instead of silently eating the
 * workflow budget. Measured 2026-08-01 on cinatra-ai/cinatra CI (run
 * 30718789009), job wall clock = checkout + install + image builds + battery:
 *
 *   placement-drain                 1m59s   (busybox only, no L0 build)
 *   docker-battery                  2m16s   (builds the L0 sandbox image)
 *   environment-promotion-rebuild   2m41s   (L0 image + real pip installs)
 *   load-battery                    5m21s   (worker image + compose + burst)
 *   service-boundary                7m05s   (worker image + compose + mTLS)
 *
 * A battery with no row here still RUNS — on the conservative default below,
 * with a notice asking for a measurement. Unknown cost must never resolve to
 * "quietly not run".
 */
const BUDGETS = {
  "placement-drain.e2e.test.ts": 20,
  "docker-battery.e2e.test.ts": 30,
  "environment-promotion-rebuild.e2e.test.ts": 30,
  "load-battery.e2e.test.ts": 45,
  "service-boundary.e2e.test.ts": 45,
};

const DEFAULT_TIMEOUT = 60;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--emit") out.emit = argv[++i];
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
    const timeout = BUDGETS[file];
    if (timeout === undefined) {
      console.log(
        `::notice::Battery ${file} has no measured budget row — running it on the conservative ` +
          `default of ${DEFAULT_TIMEOUT} min. Measure it and add a row to BUDGETS.`,
      );
    }
    return {
      name,
      // Repo-relative — for humans (log lines, the workflow's step names).
      file: `${E2E_DIR}/${file}`,
      // PACKAGE-relative, and that distinction is load-bearing. Vitest resolves
      // a positional filter against the PROJECT root (here the package dir,
      // because the runner is invoked through the package's own script), NOT
      // against the repo root: a repo-relative positional matches nothing and
      // Vitest exits "No test files found". Measured, not assumed — the first
      // CI run of this workflow failed exactly that way on all five legs, and
      // the tier-coverage guard is what named it. This one string is therefore
      // both the Vitest filter AND the guard's `--expect` glob, so the thing
      // that selects a battery and the thing that proves it ran can never drift.
      filter: `src/__tests__/e2e/${file}`,
      timeout: timeout ?? DEFAULT_TIMEOUT,
    };
  });

  const matrix = { include: legs };
  const payload = JSON.stringify(matrix);

  // Self-check the two outputs the verdict job reasons about. They are derived
  // from one array in one process so they cannot disagree today; asserting it
  // keeps that true through the next refactor, because a `count` that overstated
  // the matrix would let legs go unrun under a green verdict.
  // (Codex round 1, MUST-FIX.)
  if (matrix.include.length !== legs.length || legs.length === 0) {
    console.error("::error::internal: matrix/count disagreement — refusing to emit.");
    process.exit(1);
  }

  console.log(`Discovered ${legs.length} batter(y|ies); every one of them runs on this trigger.`);
  console.log(payload);

  const target = args.emit ?? process.env.GITHUB_OUTPUT;
  if (target) {
    appendFileSync(target, `matrix=${payload}\n`);
    appendFileSync(target, `count=${legs.length}\n`);
  }
}

main();
