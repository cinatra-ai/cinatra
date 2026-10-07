// Self-hosted job timeout budgets (cinatra#3364): the SHAPE of the shipped
// workflows, read from the real files in this repo.
//
// `timeout-minutes` covers the WHOLE job, setup included. On the self-hosted
// host the setup phase (checkout, the Node setup with its cache restore, the
// dependency install) reached 16m44s under load over the 26 most recent runs
// of build-image.yml, and 8m45s on the unit-tier job whose test step a 10-minute
// budget cancelled, so a budget sized for the tests alone cancels them while
// they are running normally. Every job that resolves to the self-hosted runner
// classes therefore budgets the measured worst setup phase plus its own
// longest measured test phase, rounded up to a minute, plus a 5-minute margin,
// and stays under the queue's 120-minute limit. The setup figure was 17 until
// 2026-09-26, when the shared six-runner box measured 20 (the Node setup alone
// took 12 minutes under load); the perpetual core job's root suite (15 measured)
// carries a loaded-pool allowance of twice that, because the pool cancelled it
// at the old budget without a verdict.
//
// The contract reads EVERY workflow file, not only the image workflow: a job
// whose `runs-on` takes its runner from one of the self-hosted classes either
// carries a budget sized here or is named in STILL_UNSIZED below, so a later
// job on those classes fails the contract by name until its budget is sized.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
  "..",
);
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

// The measured worst setup phase on the self-hosted host (job start to the end
// of the dependency install), and the margin every budget adds on top of the
// setup phase and the job's own measured test phase.
const MEASURED_WORST_SETUP_MINUTES = 20;
const MARGIN_MINUTES = 5;
const QUEUE_LIMIT_MINUTES = 120;

// workflow file -> job id -> the budget it must carry, each one measured:
// MEASURED_WORST_SETUP_MINUTES + the job's own measured test phase + MARGIN.
const SELF_HOSTED_BUDGETS = {
  "build-image.yml": {
    test: 33,
    "skills-unit": 27,
    "a2a-unit": 26,
    "execution-plane-unit": 26,
    "rbac-authz-unit": 27,
    "context-resolve-route-shape": 26,
    "auth-schema-drift": 27,
    "v64-invariants": 26,
    "package-unit-suites": 28,
    "hosted-mcp-wire-gate": 26,
    "devperf-invariants": 27,
    "perpetual-core": 55,
    "perpetual-extension-suites": 27,
    "presence-degraded-build": 34,
  },
  // Sized 2026-09-27, after a loaded pool ended runs of these jobs at their
  // old budgets (15, 10 and 10 minutes), many of them still in their setup
  // steps. Their own phase was not measured apart from the setup, so the
  // figure used is an upper bound: the job's longest whole run on the hosted
  // runners, rounded up to a minute.
  "gates.yml": { "gates-pnpm": 28 }, // 20 + 3 + 5
  "knip-report.yml": { "knip-report": 27 }, // 20 + 2 + 5
  "mcp-route-gate.yml": { "mcp-route-gate": 26 }, // 20 + 1 + 5
};

// The jobs on the self-hosted classes whose budgets are NOT sized yet. Each
// keeps the budget it has, or none, until a later change sizes it and moves it
// into SELF_HOSTED_BUDGETS. A job on those classes that is in neither list
// fails the contract by name.
const STILL_UNSIZED = {
  "crm-migration-gate.yml": ["gate"],
  "design-baselines-refresh.yml": ["refresh"],
  "design-visual-verify.yml": ["pixel-diff"],
  "dev-lock-auto-bump.yml": ["auto-bump"],
  "extension-head-canary.yml": ["head-canary"],
  "extension-readme-gate.yml": ["tests"],
  "org-write-boundary-gate.yml": ["org-write-boundary-gate"],
  "release-prep-vendored-bundles.yml": ["pack-bundle"],
  "renovate-lockfile-repair.yml": ["repair"],
  "skill-match-eval.yml": ["live-eval"],
  "skill-packaging-gate.yml": ["tests"],
  "validate-agents.yml": ["validate-runtime-invariants"],
};

const SELF_HOSTED_CLASSES = /vars\.CI_RUNNER_(HEAVY|POOL|PIXEL)\b/;

// The name every failure below reports a job by.
const jobKey = (file, id) => `${file}: ${id}`;

// Every job of one workflow file: its `runs-on` value (with any continuation
// lines) and its static `timeout-minutes` (null when it declares none or names
// an expression).
const parseJobs = (file, text) => {
  const jobsSection = text.slice(text.search(/^jobs:[ \t]*(#.*)?$/m));
  const starts = [...jobsSection.matchAll(/^ {2}([A-Za-z0-9_-]+):[ \t]*(#.*)?$/gm)];
  const out = new Map();
  for (const [i, m] of starts.entries()) {
    const from = m.index;
    const to = i + 1 < starts.length ? starts[i + 1].index : jobsSection.length;
    const block = jobsSection.slice(from, to);
    const runsOn = [...block.matchAll(/^ {4}runs-on:(.*(?:\n(?: {6,}\S.*)?)*)/gm)];
    // Two `runs-on:` lines in one block mean a job start was not recognised.
    if (runsOn.length > 1) {
      throw new Error(`${jobKey(file, m[1])}: more than one runs-on line`);
    }
    const timeout = block.match(/^ {4}timeout-minutes:[ \t]*(\d+)[ \t]*(#.*)?$/m);
    out.set(jobKey(file, m[1]), {
      runsOn: runsOn.length === 1 ? runsOn[0][1] : null,
      timeout: timeout ? Number(timeout[1]) : null,
    });
  }
  return out;
};

const WORKFLOW_FILES = fs
  .readdirSync(WORKFLOWS_DIR)
  .filter((file) => /\.ya?ml$/.test(file))
  .sort();
const JOBS_BY_FILE = new Map(
  WORKFLOW_FILES.map((file) => [
    file,
    parseJobs(file, fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8")),
  ]),
);
const JOBS = new Map([...JOBS_BY_FILE.values()].flatMap((jobs) => [...jobs]));

const SIZED = new Map(
  Object.entries(SELF_HOSTED_BUDGETS).flatMap(([file, budgets]) =>
    Object.entries(budgets).map(([id, budget]) => [jobKey(file, id), budget]),
  ),
);
const UNSIZED = Object.entries(STILL_UNSIZED).flatMap(([file, ids]) =>
  ids.map((id) => jobKey(file, id)),
);

const onSelfHostedClass = (job) => SELF_HOSTED_CLASSES.test(job.runsOn ?? "");

describe("every workflow: which jobs run on the self-hosted classes", () => {
  it("reads at least one job from every workflow file", () => {
    expect(WORKFLOW_FILES).toContain("build-image.yml");
    const empty = WORKFLOW_FILES.filter((file) => JOBS_BY_FILE.get(file).size === 0);
    expect(empty, "workflow files the job reader found no job in").toEqual([]);
  });

  it("sizes every job on the self-hosted classes, or names it as still unsized", () => {
    const selfHosted = [...JOBS]
      .filter(([, job]) => onSelfHostedClass(job))
      .map(([key]) => key);
    const unlisted = selfHosted.filter((key) => !SIZED.has(key) && !UNSIZED.includes(key));
    expect(unlisted, "jobs on a self-hosted class without a sized budget").toEqual([]);
    const gone = [...SIZED.keys(), ...UNSIZED].filter((key) => !selfHosted.includes(key));
    expect(gone, "listed jobs that no longer run on a self-hosted class").toEqual([]);
  });

  it("never lists a job as both sized and still unsized", () => {
    expect(UNSIZED.filter((key) => SIZED.has(key))).toEqual([]);
  });
});

describe("every workflow: the self-hosted budgets cover the measured setup phase", () => {
  it.each([...SIZED])("%s carries its sized budget of %i minutes", (key, budget) => {
    const job = JOBS.get(key);
    expect(job, `job ${key} is missing`).toBeTruthy();
    expect(job.timeout, `job ${key} has no timeout-minutes`).not.toBeNull();
    expect(job.timeout, `job ${key} carries another budget`).toBe(budget);
  });

  it("leaves the measured worst setup phase plus the margin to each job's own phase", () => {
    const floor = MEASURED_WORST_SETUP_MINUTES + MARGIN_MINUTES;
    const short = [...SIZED.keys()]
      .filter((key) => !(JOBS.get(key)?.timeout >= floor))
      .map((key) => `${key} (${JOBS.get(key)?.timeout ?? "no budget"})`);
    expect(short, "jobs that budget less than the measured setup phase plus the margin").toEqual([]);
  });

  it("stays under the queue's limit on every sized job", () => {
    const over = [...SIZED.keys()]
      .filter((key) => !(JOBS.get(key)?.timeout < QUEUE_LIMIT_MINUTES))
      .map((key) => `${key} (${JOBS.get(key)?.timeout ?? "no budget"})`);
    expect(over, "jobs that exceed the queue limit").toEqual([]);
  });
});
