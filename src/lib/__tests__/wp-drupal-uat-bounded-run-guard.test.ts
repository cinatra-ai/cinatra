// WP/Drupal UAT gate — BOUNDED-RUN + RUNNER-HEADROOM regression guard.
//
// THE DEFECT THIS PINS. The gate stalled mid-suite and was killed by the job
// timeout with NO output at all: the last line was an ordinary dev-server log,
// then nothing for the rest of the job. It was not a code regression — two runs
// of the IDENTICAL head SHA, 50 minutes apart, produced one green suite and one
// 45-minute silent kill. The runner simply ran out of headroom.
//
// Three properties keep that fixed, and each is a one-liner a later edit could
// drop while every other test still passes — the symptom of dropping one is a
// 40-minute silent CI stall, not a red test. Hence this guard.
//
//  1. RUNNER HEADROOM. The job co-hosts the docker WordPress + Drupal + nango +
//     wayflow stack, the Postgres/Redis service containers, a Next dev server
//     and a Playwright Chromium on one 4-vCPU / 16-GB runner. Disk was never the
//     constraint (>100 GB free after the existing reclaim step) — memory was.
//     Both jobs that run the full stack add a dedicated swapfile so the cliff
//     becomes a slowdown the suite can still finish through.
//
//  2. THE DEV SERVER NO LONGER PERSISTS ITS BUILD CACHE. The suite boots
//     `pnpm dev`; Next 16 defaults Turbopack's dev filesystem cache ON, so the
//     server writes and periodically COMPACTS a cache database under that same
//     pressure. Inside one stalled run the compaction pass escalated 11.8s →
//     14.0s → 21.3s → 31.7s → 49s → 98s → 2.1min → 8.7min and then the box
//     stopped progressing at all. CI always starts cold and throws the server
//     away at the end, so the cache buys nothing there — the UAT webServer
//     command turns it off via `CINATRA_TURBOPACK_DEV_FS_CACHE=0`, which
//     next.config.ts reads.
//
//  3. THE RUN HAS AN OUTER BOUND. The Playwright config set a per-test `timeout`
//     only, so nothing bounded the RUN and the only thing that ever ended a
//     stalled one was the runner being torn down: no reporter summary, no HTML
//     report, no failing test name. `globalTimeout` makes the run end itself and
//     report. It is an in-process timer, so it recovers a STUCK run (wedged
//     webServer, a test hanging past its own timeout) and NOT a host that has
//     stopped scheduling the runner — properties 1 and 2 are what prevent that
//     state; this one is the reporting backstop.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

const UAT_CONFIG_PATH = path.join(
  REPO_ROOT,
  "tests/e2e/config/wp-drupal-uat.config.ts",
);
const NEXT_CONFIG_PATH = path.join(REPO_ROOT, "next.config.ts");
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github/workflows/wp-drupal-uat.yml",
);

/** The env flag the UAT dev server sets and next.config.ts reads. */
const FS_CACHE_FLAG = "CINATRA_TURBOPACK_DEV_FS_CACHE";

/**
 * Minutes the uat-gate job spends BEFORE the Playwright suite starts (install +
 * `setup dev` + docker bring-up + browser install), measured from the gate's own
 * green runs. The suite bound must leave at least this much, or the job timeout
 * still wins and the run reports nothing.
 */
const PRE_SUITE_RESERVE_MINUTES = 11;

/** Minutes left after the suite bound for reporting + artifact upload + teardown. */
const POST_SUITE_RESERVE_MINUTES = 5;

/** A healthy full suite is ~8.5 minutes; a bound near that would itself flake. */
const MIN_SUITE_BOUND_MINUTES = 15;

const uatConfig = readFileSync(UAT_CONFIG_PATH, "utf8");
const nextConfig = readFileSync(NEXT_CONFIG_PATH, "utf8");
const workflow = readFileSync(WORKFLOW_PATH, "utf8");

/** The `steps:` text of one top-level job, so per-job assertions cannot be
 * satisfied by the OTHER job's copy of the same block. */
function jobBlock(jobName: string): string {
  const start = workflow.indexOf(`\n  ${jobName}:`);
  expect(start, `the workflow must still declare a \`${jobName}\` job`).toBeGreaterThan(-1);
  // The next top-level job key (two-space indent, non-comment) ends this block.
  const rest = workflow.slice(start + 1);
  const next = /\n {2}[a-z][a-z0-9-]*:\n/.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

/** The uat-gate job's own ceiling, read from the workflow rather than repeated
 * here — the suite bound must stay strictly inside whatever the job allows, and
 * that relationship has to survive an edit to either number. */
function uatGateTimeoutMinutes(): number {
  const match = /timeout-minutes:\s*(\d+)/.exec(jobBlock("uat-gate"));
  expect(match, "the uat-gate job must declare timeout-minutes").not.toBeNull();
  return Number(match![1]);
}

/** The suite's declared outer bound, in minutes. */
function suiteBoundMinutes(): number {
  const match = /globalTimeout:\s*(\d+)\s*\*\s*60_000/.exec(uatConfig);
  expect(
    match,
    "express globalTimeout as `<minutes> * 60_000` so this guard can compare it to the job budget",
  ).not.toBeNull();
  return Number(match![1]);
}

describe("WP/Drupal UAT gate — the run is bounded and reports its own failure", () => {
  it("the Playwright config sets a globalTimeout (a per-test timeout bounds a test, not the run)", () => {
    expect(
      /globalTimeout:\s*\d/.test(uatConfig),
      "tests/e2e/config/wp-drupal-uat.config.ts must set `globalTimeout` — without it a stalled run " +
        "produces NO output at all and is ended only by the job timeout, which is how the mid-suite " +
        "stalls went undiagnosed.",
    ).toBe(true);
  });

  it("the globalTimeout leaves explicit pre- and post-suite reserve inside the job budget", () => {
    const suiteMinutes = suiteBoundMinutes();
    const jobMinutes = uatGateTimeoutMinutes();
    const ceiling = jobMinutes - PRE_SUITE_RESERVE_MINUTES - POST_SUITE_RESERVE_MINUTES;
    expect(
      suiteMinutes,
      `globalTimeout (${suiteMinutes}m) must fit inside the uat-gate budget (${jobMinutes}m) after the ` +
        `${PRE_SUITE_RESERVE_MINUTES}m pre-suite setup and ${POST_SUITE_RESERVE_MINUTES}m reporting ` +
        `reserve, i.e. ≤ ${ceiling}m — the whole point is that the SUITE ends the run and reports, ` +
        "not the runner teardown.",
    ).toBeLessThanOrEqual(ceiling);
    expect(
      suiteMinutes,
      `globalTimeout (${suiteMinutes}m) must stay comfortably above a healthy run (~8.5m) or the bound ` +
        "becomes the flake.",
    ).toBeGreaterThanOrEqual(MIN_SUITE_BOUND_MINUTES);
  });

  it("the UAT dev server disables Turbopack's persistent dev filesystem cache", () => {
    const command = /command:\s*`([^`]*)`/.exec(uatConfig);
    expect(command, "the UAT config must still declare a webServer command").not.toBeNull();
    expect(
      command![1],
      `the UAT webServer command must set ${FS_CACHE_FLAG}=0 — the cache write + compaction cycle is ` +
        "the marginal load that tipped constrained CI runners into an unrecoverable stall, and CI " +
        "starts cold so the cache buys nothing there.",
    ).toContain(`${FS_CACHE_FLAG}=0`);
  });

  it("next.config.ts honours that flag by turning the dev filesystem cache off", () => {
    expect(
      nextConfig,
      `next.config.ts must read ${FS_CACHE_FLAG} — the UAT sets it, and if nothing reads it the ` +
        "flag is decorative and the stall mechanism is back.",
    ).toContain(FS_CACHE_FLAG);
    expect(
      /turbopackFileSystemCacheForDev:\s*false/.test(nextConfig),
      "next.config.ts must set `turbopackFileSystemCacheForDev: false` under that flag (Next 16 defaults it to true).",
    ).toBe(true);
  });

  it("the cache opt-out is env-gated, so local dev keeps its warm restarts", () => {
    // Guard the gating shape itself: an unconditional `false` would silently
    // slow every developer's dev server, which is not what this fix is for.
    expect(
      new RegExp(`process\\.env\\.${FS_CACHE_FLAG}\\s*===\\s*"0"`).test(nextConfig),
      `the ${FS_CACHE_FLAG} opt-out must be gated on the env value, never applied unconditionally.`,
    ).toBe(true);
  });

  // Both jobs run the full stack on the same runner class, so both need the
  // headroom. Asserted INSIDE each job's own block — a global substring search
  // would be satisfied by the other job's copy.
  for (const job of ["uat-gate", "nightly"] as const) {
    it(`the \`${job}\` job provisions swap headroom and records the memory baseline`, () => {
      const block = jobBlock(job);
      expect(
        /fallocate -l 16G \/mnt\/cinatra-uat-swap/.test(block),
        `the \`${job}\` job must allocate the 16G UAT swapfile — memory, not disk, is what ends these runs.`,
      ).toBe(true);
      expect(/mkswap \/mnt\/cinatra-uat-swap/.test(block)).toBe(true);
      expect(/swapon \/mnt\/cinatra-uat-swap/.test(block)).toBe(true);
      // Diagnostics: the next investigation must start from a recorded baseline
      // instead of inferring the runner's state from silence.
      expect(
        /swapon --show/.test(block) && /free -m/.test(block),
        `the \`${job}\` job must record \`swapon --show\` + \`free -m\` so a future stall is diagnosable.`,
      ).toBe(true);
      // ADDITIVE only: a blanket `swapoff -a` would strip the image's own swap
      // during the window the new file is being built, and mask a real failure
      // to detach an in-use device.
      // Matched as a COMMAND line (leading whitespace, optional sudo) so the
      // explanatory comment that names the anti-pattern does not trip the guard.
      expect(
        /^\s*(sudo\s+)?swapoff\s+-a\b/m.test(block),
        `the \`${job}\` job must not run \`swapoff -a\` — the UAT swapfile is added alongside existing swap.`,
      ).toBe(false);
    });
  }
});
