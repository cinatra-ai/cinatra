// Hosted-runner reclaim re-run watcher (cinatra#3316, items 1 and 2): unit
// tests over the PURE decision core.
//
// The watcher itself cannot be exercised end to end before it sits on the
// default branch — a `workflow_run` workflow only ever runs from there — so
// this suite IS the acceptance surface for the guard list: the positive case
// re-runs exactly one job, and every negative case the issue names returns a
// specific reason code and NO re-run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ALLOWLIST,
  LEDGER_NAME_PREFIX,
  RECLAIM_MARKER,
  RERUN_REASON,
  SKIP_REASONS,
  decide,
  ledgerArtifactName,
  ledgerRecord,
  parseLedgerArtifactName,
} from "../hosted-reclaim-rerun.mjs";

const FIXTURES = path.resolve(
  fileURLToPath(import.meta.url),
  "..",
  "__fixtures__",
  "hosted-reclaim",
);

const readJson = (f) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8"));
const readText = (f) => fs.readFileSync(path.join(FIXTURES, f), "utf8");

const RUN = readJson("run-failure.json");
const PULL = readJson("pull-3310.json");
const JOBS_DVV = readJson("jobs-design-visual-verify.json");
const JOBS_DLV = readJson("jobs-dashboard-live-verify.json");
const JOBS_IMG = readJson("jobs-build-image.json");
const LOG_SHUTDOWN = readText("log-shutdown.txt");
const LOG_NO_MARKER = readText("log-no-marker.txt");
const LOG_BUILD_FAILED = readText("log-build-failed.txt");

const clone = (v) => structuredClone(v);

/** The canonical reclaim input: design-visual-verify's pixel-diff job. */
const base = (over = {}) => ({
  run: clone(RUN),
  jobs: clone(JOBS_DVV),
  logByJobId: { 8800000002: LOG_SHUTDOWN },
  pullHead: PULL.head.sha,
  allowlist: ALLOWLIST,
  ...over,
});

const failedJob = (jobs) => jobs.find((j) => j.conclusion === "failure");
const stepOf = (job, name) => job.steps.find((s) => s.name === name);

describe("hosted-reclaim-rerun: the allowlist is grounded in the live workflows", () => {
  it("carries exactly the three build-carrying jobs, each with its own build-step name", () => {
    expect(ALLOWLIST).toEqual([
      {
        workflow: "design-visual-verify",
        job: "/design-fixtures pixel-diff + axe",
        buildStep: "Build (standalone production server)",
      },
      {
        workflow: "dashboard-live-verify",
        job: "/agents Playwright smoke",
        buildStep: "Build app (production)",
      },
      {
        workflow: "Build and publish image",
        job: "image",
        buildStep: "Build image (load for prod-boot e2e)",
      },
    ]);
  });

  it("uses the exact reclaim marker the runner writes", () => {
    expect(RECLAIM_MARKER).toBe("The runner has received a shutdown signal");
  });
});

describe("hosted-reclaim-rerun: the positive case", () => {
  it("re-runs the one reclaimed pixel-diff job and names it", () => {
    const out = decide(base());
    expect(out).toEqual({
      rerun: 8800000002,
      reason: RERUN_REASON,
      workflow: "design-visual-verify",
      job: "/design-fixtures pixel-diff + axe",
      step: "Build (standalone production server)",
    });
    expect(out.skip).toBeUndefined();
  });

  it("re-runs the reclaimed smoke job (skipped conditional steps before the build are not a failure)", () => {
    const run = clone(RUN);
    run.name = "dashboard-live-verify";
    run.id = 9910000002;
    const out = decide(
      base({
        run,
        jobs: clone(JOBS_DLV),
        logByJobId: { 8800000011: LOG_SHUTDOWN },
      }),
    );
    expect(out.rerun).toBe(8800000011);
    expect(out.job).toBe("/agents Playwright smoke");
    expect(out.step).toBe("Build app (production)");
  });

  it("re-runs the reclaimed image job (the job id is its displayed name — that job has no name: key)", () => {
    const run = clone(RUN);
    run.name = "Build and publish image";
    run.id = 9910000003;
    const out = decide(
      base({
        run,
        jobs: clone(JOBS_IMG),
        logByJobId: { 8800000021: LOG_SHUTDOWN },
      }),
    );
    expect(out.rerun).toBe(8800000021);
    expect(out.job).toBe("image");
    expect(out.step).toBe("Build image (load for prod-boot e2e)");
  });
});

describe("hosted-reclaim-rerun: every guard the issue names refuses the re-run", () => {
  const refuses = (input, reason) => {
    const out = decide(input);
    expect(out.rerun).toBeUndefined();
    expect(out.skip).toBe(true);
    expect(out.reason).toBe(reason);
    expect(Object.values(SKIP_REASONS)).toContain(out.reason);
    return out;
  };

  it("a job that failed for another reason (the build step FAILED, not cancelled)", () => {
    const jobs = clone(JOBS_DVV);
    const job = failedJob(jobs);
    stepOf(job, "Build (standalone production server)").conclusion = "failure";
    refuses(
      base({ jobs, logByJobId: { 8800000002: LOG_BUILD_FAILED } }),
      SKIP_REASONS.BUILD_STEP_NOT_CANCELLED,
    );
  });

  it("a cancelled run", () => {
    const run = clone(RUN);
    run.conclusion = "cancelled";
    refuses(base({ run }), SKIP_REASONS.RUN_CANCELLED);
  });

  it("a timed-out run", () => {
    const run = clone(RUN);
    run.conclusion = "timed_out";
    refuses(base({ run }), SKIP_REASONS.RUN_TIMED_OUT);
  });

  it("a successful run (nothing to re-run)", () => {
    const run = clone(RUN);
    run.conclusion = "success";
    refuses(base({ run }), SKIP_REASONS.RUN_NOT_FAILURE);
  });

  it("a head that moved on after the run started", () => {
    refuses(
      base({ pullHead: "2222222222222222222222222222222222222222" }),
      SKIP_REASONS.HEAD_MOVED,
    );
  });

  it("a second attempt (run_attempt 2 on the fresh read)", () => {
    const run = clone(RUN);
    run.run_attempt = 2;
    refuses(base({ run }), SKIP_REASONS.SECOND_ATTEMPT);
  });

  it("a failed job outside the allowlist", () => {
    const jobs = clone(JOBS_DVV);
    failedJob(jobs).name = "conformance coverage ratchet (shrink-only)";
    refuses(base({ jobs }), SKIP_REASONS.JOB_NOT_ALLOWLISTED);
  });

  it("an allowlisted job name under the WRONG workflow", () => {
    const run = clone(RUN);
    run.name = "dashboard-live-verify";
    refuses(base({ run }), SKIP_REASONS.JOB_NOT_ALLOWLISTED);
  });

  it("an earlier step that failed", () => {
    const jobs = clone(JOBS_DVV);
    stepOf(failedJob(jobs), "install deps").conclusion = "failure";
    refuses(base({ jobs }), SKIP_REASONS.EARLIER_STEP_NOT_GREEN);
  });

  it("an earlier step that was cancelled (the reclaim landed before the build)", () => {
    const jobs = clone(JOBS_DVV);
    stepOf(failedJob(jobs), "install deps").conclusion = "cancelled";
    refuses(base({ jobs }), SKIP_REASONS.EARLIER_STEP_NOT_GREEN);
  });

  it("the shutdown marker absent from the job log", () => {
    refuses(
      base({ logByJobId: { 8800000002: LOG_NO_MARKER } }),
      SKIP_REASONS.MARKER_ABSENT,
    );
  });

  it("no log at all for the candidate job", () => {
    refuses(base({ logByJobId: {} }), SKIP_REASONS.MARKER_ABSENT);
  });

  it("a fork pull request (pull_requests[] is empty)", () => {
    const run = clone(RUN);
    run.pull_requests = [];
    refuses(base({ run }), SKIP_REASONS.NO_PULL_REQUEST_ATTACHED);
  });

  it("two failed jobs in the same run", () => {
    const jobs = clone(JOBS_DVV);
    jobs[0].conclusion = "failure";
    jobs[0].steps = clone(failedJob(jobs).steps);
    refuses(
      base({ jobs, logByJobId: { 8800000001: LOG_SHUTDOWN, 8800000002: LOG_SHUTDOWN } }),
      SKIP_REASONS.MULTIPLE_FAILED_JOBS,
    );
  });

  it("no failed job at all", () => {
    const jobs = clone(JOBS_DVV);
    failedJob(jobs).conclusion = "cancelled";
    refuses(base({ jobs }), SKIP_REASONS.NO_FAILED_JOB);
  });

  it("a run that is not a pull_request event (push / merge_group)", () => {
    const run = clone(RUN);
    run.event = "merge_group";
    refuses(base({ run }), SKIP_REASONS.NOT_A_PULL_REQUEST_EVENT);
  });

  it("a run belonging to another repository (a fork's own Actions)", () => {
    const run = clone(RUN);
    run.repository = { full_name: "someone-else/cinatra" };
    refuses(base({ run }), SKIP_REASONS.NOT_THIS_REPOSITORY);
  });

  it("a pull-request head that could not be read", () => {
    refuses(base({ pullHead: null }), SKIP_REASONS.PULL_HEAD_UNREADABLE);
  });

  it("the build step missing from the job altogether", () => {
    const jobs = clone(JOBS_DVV);
    const job = failedJob(jobs);
    job.steps = job.steps.filter(
      (s) => s.name !== "Build (standalone production server)",
    );
    refuses(base({ jobs }), SKIP_REASONS.BUILD_STEP_MISSING);
  });
});

describe("hosted-reclaim-rerun: guard order is fail-closed", () => {
  it("refuses a second attempt even when every other guard would hold", () => {
    const run = clone(RUN);
    run.run_attempt = 2;
    const out = decide(base({ run }));
    expect(out.skip).toBe(true);
  });

  it("checks the repository before anything else", () => {
    const run = clone(RUN);
    run.repository = { full_name: "someone-else/cinatra" };
    run.event = "merge_group";
    run.conclusion = "cancelled";
    expect(decide(base({ run })).reason).toBe(SKIP_REASONS.NOT_THIS_REPOSITORY);
  });

  it("never returns both a re-run and a skip", () => {
    for (const input of [base(), base({ pullHead: null })]) {
      const out = decide(input);
      expect(Boolean(out.rerun) && Boolean(out.skip)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The ledger (item 3): what a re-run leaves behind, so the weekly count can be
// computed from this watcher's OWN records instead of a scrape of run logs.
// ---------------------------------------------------------------------------

describe("hosted-reclaim-rerun: the record a re-run leaves behind", () => {
  const reclaimed = () => {
    const job = clone(failedJob(JOBS_DVV));
    job.labels = ["ubuntu-latest"];
    return job;
  };

  it("records the workflow, the job id, the attempt and the runner label", () => {
    const record = ledgerRecord({
      outcome: {
        workflow: "design-visual-verify",
        job: "/design-fixtures pixel-diff + axe",
      },
      run: clone(RUN),
      job: reclaimed(),
      at: "2026-09-03T11:00:00.000Z",
    });
    expect(record).toEqual({
      workflow: "design-visual-verify",
      jobId: "8800000002",
      attempt: 1,
      runner: "ubuntu-latest",
      at: "2026-09-03T11:00:00.000Z",
      runId: RUN.id,
    });
  });

  it("says so rather than guessing when the job carries no runner label", () => {
    const job = reclaimed();
    delete job.labels;
    const record = ledgerRecord({
      outcome: { workflow: "design-visual-verify", job: "x" },
      run: clone(RUN),
      job,
      at: "2026-09-03T11:00:00.000Z",
    });
    expect(record.runner).toBe("unknown");
  });

  it("names the artifact so the name alone IS the record, and parses back", () => {
    const record = ledgerRecord({
      outcome: { workflow: "Build and publish image", job: "image" },
      run: { ...clone(RUN), run_attempt: 2 },
      job: { id: 8800000031, labels: ["ubuntu-latest-8-cores"] },
      at: "2026-09-06T21:45:00.000Z",
    });
    const name = ledgerArtifactName(record);
    expect(name).toBe(
      "reclaim-record.build-and-publish-image.8800000031.2.ubuntu-latest-8-cores",
    );
    expect(name.startsWith(LEDGER_NAME_PREFIX)).toBe(true);
    expect(parseLedgerArtifactName(name)).toEqual({
      workflow: "Build and publish image",
      jobId: "8800000031",
      attempt: 2,
      runner: "ubuntu-latest-8-cores",
    });
  });

  it("round-trips every allowlisted workflow name", () => {
    for (const entry of ALLOWLIST) {
      const name = ledgerArtifactName({
        workflow: entry.workflow,
        jobId: "1",
        attempt: 1,
        runner: "ubuntu-latest",
      });
      expect(parseLedgerArtifactName(name).workflow).toBe(entry.workflow);
    }
  });

  it("ignores an artifact that is not one of its records", () => {
    expect(parseLedgerArtifactName("pixel-diff-report-3310")).toBeNull();
    expect(parseLedgerArtifactName("reclaim-record.design-visual-verify.1.1")).toBeNull();
    expect(
      parseLedgerArtifactName("reclaim-record.design-visual-verify.abc.1.ubuntu-latest"),
    ).toBeNull();
    expect(parseLedgerArtifactName(undefined)).toBeNull();
  });
});
