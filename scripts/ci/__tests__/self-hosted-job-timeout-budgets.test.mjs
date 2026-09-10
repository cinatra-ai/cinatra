// Self-hosted job timeout budgets (cinatra#3364): the SHAPE of the shipped
// image workflow, read from the real file in this repo.
//
// `timeout-minutes` covers the WHOLE job, setup included. On the self-hosted
// host the setup phase (checkout, the Node setup with its cache restore, the
// dependency install) reached 16m44s under load over the 26 most recent runs
// of the workflow, and 8m45s on the unit-tier job whose test step a 10-minute
// budget cancelled, so a budget sized for the tests alone cancels them while
// they are running normally. Every job that resolves to the self-hosted runner
// classes therefore budgets the measured worst setup phase (17) plus its own
// longest measured test phase, rounded up to a minute, plus a 5-minute margin,
// and stays under the queue's 120-minute limit.
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
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github",
  "workflows",
  "build-image.yml",
);

const workflow = fs.readFileSync(WORKFLOW_PATH, "utf8");

// The measured worst setup phase on the self-hosted host (job start to the end
// of the dependency install), and the margin every budget adds on top of the
// setup phase and the job's own measured test phase.
const MEASURED_WORST_SETUP_MINUTES = 17;
const MARGIN_MINUTES = 5;
const QUEUE_LIMIT_MINUTES = 120;

// job id -> the budget it must carry, each one measured:
// MEASURED_WORST_SETUP_MINUTES + the job's own measured test phase + MARGIN.
const SELF_HOSTED_BUDGETS = {
  test: 30,
  "skills-unit": 24,
  "a2a-unit": 23,
  "execution-plane-unit": 23,
  "rbac-authz-unit": 24,
  "context-resolve-route-shape": 23,
  "auth-schema-drift": 24,
  "v64-invariants": 23,
  "package-unit-suites": 25,
  "hosted-mcp-wire-gate": 23,
  "devperf-invariants": 24,
  "perpetual-core": 37,
  "perpetual-extension-suites": 24,
  "presence-degraded-build": 31,
};

const jobsSection = workflow.slice(workflow.search(/^jobs:$/m));

const parseJobs = () => {
  const starts = [...jobsSection.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
  const out = new Map();
  for (const [i, m] of starts.entries()) {
    const from = m.index;
    const to = i + 1 < starts.length ? starts[i + 1].index : jobsSection.length;
    const block = jobsSection.slice(from, to);
    const runsOn = block.match(/^ {4}runs-on: (.+)$/m);
    if (!runsOn) continue;
    const timeout = block.match(/^ {4}timeout-minutes: (\d+)$/m);
    out.set(m[1], {
      runsOn: runsOn[1],
      timeout: timeout ? Number(timeout[1]) : null,
    });
  }
  return out;
};

const SELF_HOSTED_CLASSES = /vars\.CI_RUNNER_(HEAVY|POOL|PIXEL)\b/;

describe("build-image.yml: which jobs run on the self-hosted host", () => {
  it("resolves the self-hosted classes for exactly the budgeted jobs", () => {
    const jobs = parseJobs();
    expect(jobs.size).toBeGreaterThan(0);
    const selfHosted = [...jobs.entries()]
      .filter(([, j]) => SELF_HOSTED_CLASSES.test(j.runsOn))
      .map(([id]) => id);
    expect(selfHosted.sort()).toEqual(Object.keys(SELF_HOSTED_BUDGETS).sort());
  });

  it("gives every self-hosted job an explicit budget", () => {
    const jobs = parseJobs();
    for (const id of Object.keys(SELF_HOSTED_BUDGETS)) {
      expect(jobs.get(id), `job ${id} is missing`).toBeTruthy();
      expect(jobs.get(id).timeout, `job ${id} has no timeout-minutes`).not.toBeNull();
    }
  });
});

describe("build-image.yml: the self-hosted budgets cover the measured setup phase", () => {
  it("carries the measured budget on every self-hosted job", () => {
    const jobs = parseJobs();
    const actual = Object.fromEntries(
      Object.keys(SELF_HOSTED_BUDGETS).map((id) => [id, jobs.get(id)?.timeout]),
    );
    expect(actual).toEqual(SELF_HOSTED_BUDGETS);
  });

  it("leaves the measured worst setup phase plus the margin to the test phase", () => {
    const jobs = parseJobs();
    for (const [id, job] of jobs) {
      if (!SELF_HOSTED_CLASSES.test(job.runsOn)) continue;
      expect(
        job.timeout,
        `job ${id} budgets less than the measured setup phase plus the margin`,
      ).toBeGreaterThanOrEqual(MEASURED_WORST_SETUP_MINUTES + MARGIN_MINUTES);
    }
  });

  it("stays under the queue's limit on every self-hosted job", () => {
    const jobs = parseJobs();
    for (const [id, job] of jobs) {
      if (!SELF_HOSTED_CLASSES.test(job.runsOn)) continue;
      expect(job.timeout, `job ${id} exceeds the queue limit`).toBeLessThan(
        QUEUE_LIMIT_MINUTES,
      );
    }
  });
});
